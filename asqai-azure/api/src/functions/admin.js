// Admin console API: accounts, login-page settings, audit log, platform stats and export. Admins only.
const { app } = require('../lib/v3');
const C = require('../lib/core');
const S = require('../lib/store');

const ADMIN = ['admin'];
const CLINIC_DOC = 'clinic/state.json';

// GET  /api/admin/users        -> list accounts
// POST /api/admin/users        -> create { first, last, email, role, phone, dob, password? } -> returns temp password once
app.http('adminUsers', {
  route: 'admin/users', methods: ['GET', 'POST'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    const me = await C.requireUser(request, ADMIN);
    if (request.method === 'GET') return C.ok({ users: (await C.getUsers()).map(C.publicUser) });
    const b = await C.readJson(request);
    const email = String(b.email || '').trim().toLowerCase();
    if (!C.validEmail(email)) return C.bad('Enter a valid email address.');
    if (C.ROLES.indexOf(b.role) < 0) return C.bad('Pick a role.');
    const site = await C.getSite();
    let pw = b.password ? String(b.password) : C.tempPassword();
    if (b.password) { const prob = C.passwordProblem(pw, site.passwordMin); if (prob) return C.bad(prob); }
    let created = null; let exists = false;
    await C.updateUsers((list) => {
      if (list.some((x) => x.email === email)) { exists = true; return; }
      created = C.newUser({ email, first: b.first, last: b.last, role: b.role, phone: b.phone, dob: b.dob });
      created.pw = C.hashPassword(pw); created.mustChange = b.mustChange !== false; created.createdBy = me.email;
      list.push(created);
    });
    if (exists) return C.bad('An account with this email already exists.', 409);
    await C.audit(me, 'Created ' + b.role + ' account ' + email);
    return C.ok({ user: C.publicUser(created), tempPassword: pw });
  })
});

// PATCH  /api/admin/users/{id} { first, last, role, status, phone, dob, unlock }
// DELETE /api/admin/users/{id}
// POST   /api/admin/users/{id}/reset -> new temporary password
app.http('adminUser', {
  route: 'admin/users/{id}/{action?}', methods: ['PATCH', 'DELETE', 'POST'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    const me = await C.requireUser(request, ADMIN);
    const id = request.params.id; const action = request.params.action;
    const users = await C.getUsers();
    const target = users.find((x) => x.id === id);
    if (!target) return C.bad('Account not found', 404);
    const admins = users.filter((x) => x.role === 'admin' && x.status === 'active');
    const lastAdmin = target.role === 'admin' && target.status === 'active' && admins.length <= 1;

    if (request.method === 'DELETE') {
      if (target.id === me.id) return C.bad('You cannot delete your own account.');
      if (lastAdmin) return C.bad('Keep at least one active admin.');
      await C.updateUsers((list) => { const i = list.findIndex((x) => x.id === id); if (i >= 0) list.splice(i, 1); });
      await C.audit(me, 'Deleted account ' + target.email);
      return C.ok({ ok: true });
    }
    if (request.method === 'POST' && action === 'reset') {
      const pw = C.tempPassword();
      await C.updateUsers((list) => { const x = list.find((y) => y.id === id); if (x) { x.pw = C.hashPassword(pw); x.mustChange = true; x.tv = (x.tv || 1) + 1; x.lockUntil = 0; x.failed = 0; } });
      await C.audit(me, 'Reset password for ' + target.email);
      return C.ok({ tempPassword: pw });
    }
    if (request.method !== 'PATCH') return C.bad('Not supported', 405);
    const b = await C.readJson(request);
    if (b.role && C.ROLES.indexOf(b.role) < 0) return C.bad('Unknown role');
    if (lastAdmin && ((b.role && b.role !== 'admin') || b.status === 'disabled')) return C.bad('Keep at least one active admin.');
    if (target.id === me.id && b.status === 'disabled') return C.bad('You cannot disable your own account.');
    let fresh = null; const changes = [];
    await C.updateUsers((list) => {
      const x = list.find((y) => y.id === id); if (!x) return;
      ['first', 'last', 'phone', 'dob'].forEach((k) => { if (typeof b[k] === 'string') x[k] = b[k].trim().slice(0, k === 'dob' ? 10 : 60); });
      if (b.role && b.role !== x.role) { changes.push('role ' + x.role + ' → ' + b.role); x.role = b.role; x.tv = (x.tv || 1) + 1; }
      if (b.status && b.status !== x.status && (b.status === 'active' || b.status === 'disabled')) { changes.push(b.status === 'disabled' ? 'disabled' : 're-enabled'); x.status = b.status; x.tv = (x.tv || 1) + 1; }
      if (b.unlock) { x.lockUntil = 0; x.failed = 0; changes.push('unlocked'); }
      fresh = x;
    });
    await C.audit(me, 'Updated ' + target.email + (changes.length ? ': ' + changes.join(', ') : ''));
    return C.ok({ user: C.publicUser(fresh) });
  })
});

// GET/PUT /api/admin/site -> full login/kiosk/security settings (includes kiosk PIN)
app.http('adminSite', {
  route: 'admin/site', methods: ['GET', 'PUT'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    const me = await C.requireUser(request, ADMIN);
    if (request.method === 'GET') return C.ok(await C.getSite(true));
    const b = await C.readJson(request);
    const cur = await C.getSite(true);
    const next = C.mergeSite(Object.assign({}, cur, b, {
      methods: Object.assign({}, cur.methods, b.methods || {}),
      portals: { patient: Object.assign({}, cur.portals.patient, (b.portals || {}).patient || {}), doctor: Object.assign({}, cur.portals.doctor, (b.portals || {}).doctor || {}) },
      kiosk: Object.assign({}, cur.kiosk, b.kiosk || {})
    }));
    if (!next.methods.password && !next.methods.microsoft && !next.methods.github) return C.bad('Keep at least one sign-in method turned on.');
    next.passwordMin = Math.max(8, Math.min(64, +next.passwordMin || 8));
    next.sessionHours = Math.max(1, Math.min(720, +next.sessionHours || 12));
    next.lockout = Math.max(3, Math.min(20, +next.lockout || 5));
    if (!/^#[0-9a-fA-F]{6}$/.test(next.accent)) next.accent = '#0F766E';
    if (!/^\d{4,8}$/.test(String(next.kiosk.pin))) return C.bad('Kiosk PIN must be 4 to 8 digits.');
    await S.putDoc(C.SITE_DOC, next);
    C.clearSiteCache();
    await C.audit(me, 'Updated sign-in, login page or kiosk settings');
    return C.ok(next);
  })
});

// GET /api/admin/audit -> last 300 admin and security events
app.http('adminAudit', {
  route: 'admin/audit', methods: ['GET'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    await C.requireUser(request, ADMIN);
    const r = await S.getDoc(C.AUDIT_DOC);
    return C.ok({ items: ((r.data && r.data.items) || []).slice(0, 300) });
  })
});

// GET /api/admin/export -> everything (minus password hashes) as one JSON download
app.http('adminExport', {
  route: 'admin/export', methods: ['GET'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    const me = await C.requireUser(request, ADMIN);
    const [users, clinic, site, auditLog] = await Promise.all([C.getUsers(), S.getDoc(CLINIC_DOC), C.getSite(true), S.getDoc(C.AUDIT_DOC)]);
    await C.audit(me, 'Exported all clinic data');
    const s = Object.assign({}, site, { kiosk: Object.assign({}, site.kiosk, { pin: '••••' }) });
    return C.ok({ exportedAt: new Date().toISOString(), by: me.email, users: users.map(C.publicUser), site: s, clinic: clinic.data, audit: (auditLog.data || {}).items || [] });
  })
});

// GET /api/health -> storage and configuration check (admins see details)
app.http('health', {
  route: 'health', methods: ['GET'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    const t0 = Date.now();
    let storage = 'ok';
    try { await S.getDoc(C.SITE_DOC); } catch (e) { storage = 'error: ' + (e.code || e.message); }
    const r = await C.currentUser(request).catch(() => ({}));
    const base = { ok: storage === 'ok', time: new Date().toISOString(), ms: Date.now() - t0 };
    if (!r.user || r.user.role !== 'admin') return C.ok(base);
    return C.ok(Object.assign(base, {
      storage, region: process.env.REGION_NAME || process.env.WEBSITE_REGION || '', node: process.version,
      config: { storage: !!process.env.STORAGE_CONNECTION_STRING, adminBootstrap: !!process.env.ADMIN_EMAIL, sessionSecret: !!process.env.SESSION_SECRET }
    }));
  })
});
