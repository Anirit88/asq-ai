// Lobby kiosk: find today's appointment, check in, register walk-ins, call staff.
// Kiosk devices sign in with a "kiosk" account. They only see the minimum needed to check someone in.
const { app } = require('../lib/v3');
const C = require('../lib/core');
const S = require('../lib/store');
const CLINIC_DOC = 'clinic/state.json';

const KIOSK = ['kiosk', 'admin', 'doctor'];
const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const clock = (d) => (d.getHours() % 12 || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + (d.getHours() < 12 ? ' AM' : ' PM');
// Kiosk sends its local date/time so "today" matches the clinic's time zone.
const todayOf = (b) => (/^\d{4}-\d{2}-\d{2}$/.test(String(b.today || '')) ? b.today : iso(new Date()));

function nextQueue(d, today) {
  if (!d.queue || d.queue.day !== today) d.queue = { day: today, n: 0 };
  d.queue.n += 1;
  return 'A-' + String(d.queue.n).padStart(3, '0');
}
function waiting(d, today) {
  return (d.docAppts || []).filter((a) => { const q = (d.qstate || {})[a.id] || {}; return a.status === 'scheduled' && q.arrival === 'checked_in' && (q.arrivedOn || a.date) === today; }).length;
}
function pushNotif(d, title, body, at) {
  d.notifs = [{ id: 'n' + Date.now() + Math.random().toString(36).slice(2, 5), to: 'd', ch: 'In-app', title, body, at: at || '', read: false }].concat(d.notifs || []).slice(0, 80);
}
function pushAudit(d, actor, action, at, day) {
  d.auditLog = [{ at: at || '', d: day || '', actor, action }].concat(d.auditLog || []).slice(0, 300);
}

app.http('kioskConfig', {
  route: 'kiosk/config', methods: ['GET'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    const me = await C.requireUser(request, KIOSK);
    const s = await C.getSite();
    return C.ok({ clinicName: s.clinicName, supportPhone: s.supportPhone, kiosk: s.kiosk, device: ((me.first || '') + ' ' + (me.last || '')).trim() || me.email, role: me.role });
  })
});

app.http('kioskLookup', {
  route: 'kiosk/lookup', methods: ['POST'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    await C.requireUser(request, KIOSK);
    const b = await C.readJson(request);
    const last = String(b.last || '').trim().toLowerCase();
    const dob = String(b.dob || '').trim();
    if (last.length < 2) return C.bad('Enter your last name.');
    const today = todayOf(b);
    const d = (await S.getDoc(CLINIC_DOC)).data || {};
    const matches = (d.docAppts || []).filter((a) => a.status === 'scheduled' && a.date >= today &&
      String(a.patient || '').toLowerCase().split(/\s+/).pop() === last && (!a.dob || !dob || a.dob === dob))
      .sort((x, y) => (x.date + x.time < y.date + y.time ? -1 : 1)).slice(0, 3);
    return C.ok({
      matches: matches.map((a) => {
        const q = (d.qstate || {})[a.id] || {};
        const parts = String(a.patient).split(/\s+/);
        return { id: a.id, display: parts[0] + ' ' + (parts.length > 1 ? parts[parts.length - 1][0] + '.' : ''), date: a.date, time: a.time, type: a.type,
          provider: a.provider || '', today: a.date === today, consentNeeded: q.consent !== 'signed', insurance: q.ins || 'pending', arrived: q.arrival === 'checked_in' };
      })
    });
  })
});

app.http('kioskCheckin', {
  route: 'kiosk/checkin', methods: ['POST'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    const me = await C.requireUser(request, KIOSK);
    const b = await C.readJson(request, 64 * 1024);
    const today = todayOf(b);
    let out = null; let err = null;
    await S.updateDoc(CLINIC_DOC, (d) => {
      const a = (d.docAppts || []).find((x) => x.id === b.id);
      if (!a) { err = 'Appointment not found'; return d; }
      d.qstate = d.qstate || {};
      const q = Object.assign({}, d.qstate[a.id] || {});
      const already = q.arrival === 'checked_in';
      q.arrival = 'checked_in';
      q.arrivedAt = b.at || clock(new Date());
      q.arrivedOn = today;
      if (b.sign) { q.consent = 'signed'; q.signedName = String(b.sign).slice(0, 80); }
      if (b.insurance && b.insurance.captured) { q.ins = q.ins === 'verified' ? 'verified' : 'pending'; q.insCard = 'Photo captured at kiosk'; }
      if (b.vitals && typeof b.vitals === 'object') q.vitals = { hr: +b.vitals.hr || null, rr: +b.vitals.rr || null };
      if (!q.queueNo) q.queueNo = nextQueue(d, today);
      d.qstate[a.id] = q;
      if (!already) {
        pushNotif(d, a.patient + ' checked in', 'Checked in at the lobby kiosk at ' + q.arrivedAt + ' · ticket ' + q.queueNo + (q.vitals && q.vitals.hr ? ' · HR ' + q.vitals.hr + ' bpm' : '') + '.', b.at);
        pushAudit(d, 'Kiosk · ' + (me.first || me.email), a.patient + ' checked in (' + q.queueNo + ')', b.at, b.d);
      }
      out = { queueNo: q.queueNo, ahead: Math.max(0, waiting(d, today) - 1), time: a.time, date: a.date };
      return d;
    }, {});
    if (err) return C.bad(err, 404);
    return C.ok(out);
  })
});

app.http('kioskWalkin', {
  route: 'kiosk/walkin', methods: ['POST'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    const me = await C.requireUser(request, KIOSK);
    const s = await C.getSite();
    if (!s.kiosk.walkins) return C.bad('Walk-ins are not accepted at this kiosk. Please see the front desk.', 403);
    const b = await C.readJson(request, 64 * 1024);
    const first = String(b.first || '').trim(); const last = String(b.last || '').trim();
    if (!first || !last) return C.bad('Enter your first and last name.');
    const today = todayOf(b);
    const id = 'w' + Date.now();
    let out = null;
    await S.updateDoc(CLINIC_DOC, (d) => {
      const name = (first + ' ' + last).slice(0, 80);
      d.docAppts = (d.docAppts || []).concat([{ id, patient: name, dob: String(b.dob || '').slice(0, 10), phone: String(b.phone || '').slice(0, 30),
        reason: String(b.reason || 'Walk-in visit').slice(0, 200), date: today, time: b.at || clock(new Date()), type: 'inperson', status: 'scheduled', source: 'Walk-in (kiosk)', lang: String(b.lang || 'English').slice(0, 20) }]);
      d.qstate = d.qstate || {};
      const queueNo = nextQueue(d, today);
      d.qstate[id] = { intake: b.reason ? 'progress' : 'not_started', pct: b.reason ? 30 : 0, ins: b.insurance && b.insurance.captured ? 'pending' : 'self', consent: b.sign ? 'signed' : 'missing', arrival: 'checked_in', arrivedAt: b.at || '', arrivedOn: today, queueNo, walkin: true, flags: [] };
      pushNotif(d, 'Walk-in: ' + name, 'Registered at the kiosk · ticket ' + queueNo + (b.reason ? ' · "' + String(b.reason).slice(0, 80) + '"' : '') + '.', b.at);
      pushAudit(d, 'Kiosk · ' + (me.first || me.email), 'Walk-in registered: ' + name + ' (' + queueNo + ')', b.at, b.d);
      out = { id, queueNo, ahead: Math.max(0, waiting(d, today) - 1) };
      return d;
    }, {});
    return C.ok(out);
  })
});

app.http('kioskHelp', {
  route: 'kiosk/help', methods: ['POST'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    const me = await C.requireUser(request, KIOSK);
    const b = await C.readJson(request);
    await S.updateDoc(CLINIC_DOC, (d) => { pushNotif(d, 'Help requested at the kiosk', ((me.first || 'Lobby kiosk') + ': a patient asked for assistance.') + (b.note ? ' ' + String(b.note).slice(0, 120) : ''), b.at); return d; }, {});
    return C.ok({ ok: true });
  })
});
