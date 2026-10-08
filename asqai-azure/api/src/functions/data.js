// App data: each user's private data, plus the clinic's shared data (schedule, check-in queue, intake template, settings).
const { app } = require('../lib/v3');
const crypto = require('crypto');
const C = require('../lib/core');
const S = require('../lib/store');

const CLINIC_DOC = 'clinic/state.json';
const userDoc = (u) => 'users/' + crypto.createHash('sha256').update(u.id).digest('hex') + '.json';
const STAFF = ['doctor', 'admin'];

// GET/PUT/DELETE /api/state -> the signed-in user's private data
app.http('state', {
  route: 'state', methods: ['GET', 'PUT', 'DELETE'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    const me = await C.requireUser(request, ['patient', 'doctor', 'admin']);
    if (request.method === 'GET') {
      const r = await S.getDoc(userDoc(me));
      return r.data == null ? { status: 204, headers: { 'Cache-Control': 'no-store' } } : C.ok(r.data);
    }
    if (request.method === 'DELETE') { await S.deleteDoc(userDoc(me)); await C.audit(me, 'Erased own app data'); return { status: 204 }; }
    const data = await C.readJson(request, 2 * 1024 * 1024);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return C.bad('Body must be a JSON object');
    await S.putDoc(userDoc(me), data);
    return C.ok({ ok: true, savedAt: new Date().toISOString() });
  })
});

// GET/PUT /api/clinic -> shared clinic data, staff only. PUT body: { data, etag }
app.http('clinic', {
  route: 'clinic', methods: ['GET', 'PUT'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    const me = await C.requireUser(request, STAFF);
    if (request.method === 'GET') {
      const r = await S.getDoc(CLINIC_DOC);
      return C.ok({ data: r.data, etag: r.etag });
    }
    const b = await C.readJson(request, 4 * 1024 * 1024);
    if (!b.data || typeof b.data !== 'object') return C.bad('Missing data');
    const r = await S.putDoc(CLINIC_DOC, b.data, b.etag === undefined ? null : b.etag);
    if (!r.ok) {
      const cur = await S.getDoc(CLINIC_DOC);
      return C.json(409, { error: 'Someone else changed clinic data. Latest copy loaded.', data: cur.data, etag: cur.etag });
    }
    return C.ok({ ok: true, etag: r.etag, by: me.email });
  })
});

// GET /api/clinic/public -> what every signed-in user needs to run an intake (published questions, enabled channels, languages, consents)
app.http('clinicPublic', {
  route: 'clinic/public', methods: ['GET'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    await C.requireUser(request);
    const d = (await S.getDoc(CLINIC_DOC)).data || {};
    const st = d.settings || null;
    return C.ok({
      published: d.published || null,
      settings: st ? { channels: st.channels, langs: st.langs, consents: st.consents, standalone: st.standalone } : null
    });
  })
});

// POST /api/clinic/book -> a patient's booking lands on the clinic schedule
// body: { appt: {id, reason, date, time, type, provider}, q: {...queue status}, rec: {...intake record} }
app.http('clinicBook', {
  route: 'clinic/book', methods: ['POST'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    const me = await C.requireUser(request);
    const b = await C.readJson(request, 512 * 1024);
    const a = b.appt || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.date || '')) || !a.time) return C.bad('Missing date or time');
    const name = ((me.first || '') + ' ' + (me.last || '')).trim() || b.name || me.email;
    const id = String(a.id || ('dx' + Date.now())).replace(/[^\w-]/g, '').slice(0, 40);
    await S.updateDoc(CLINIC_DOC, (d) => {
      d.docAppts = (d.docAppts || []).filter((x) => x.id !== id).concat([{
        id, patient: String(b.name || name).slice(0, 80), patientId: me.id, dob: me.dob || b.dob || '', phone: me.phone || '',
        reason: String(a.reason || 'Consultation').slice(0, 200), date: a.date, time: String(a.time).slice(0, 12),
        type: a.type === 'telehealth' ? 'telehealth' : 'inperson', status: 'scheduled', provider: String(a.provider || '').slice(0, 80), source: 'Patient portal'
      }]);
      d.qstate = Object.assign({}, d.qstate || {}, { [id]: Object.assign({ intake: 'completed', ins: 'pending', consent: 'missing', arrival: 'not_arrived', flags: [] }, b.q || {}) });
      if (b.rec && typeof b.rec === 'object') d.records = [Object.assign({}, b.rec, { isNew: true })].concat(d.records || []).slice(0, 500);
      d.notifs = [{ id: 'n' + Date.now(), to: 'd', ch: 'In-app', title: 'New booking', body: name + ' booked ' + a.date + ' at ' + a.time + ' and submitted an intake.', at: b.at || '', read: false }].concat(d.notifs || []).slice(0, 80);
      d.auditLog = [{ at: b.at || '', d: b.d || '', actor: name + ' (patient)', action: 'Booked ' + a.date + ' ' + a.time + ' and submitted intake' }].concat(d.auditLog || []).slice(0, 300);
      return d;
    }, {});
    return C.ok({ ok: true, id });
  })
});


