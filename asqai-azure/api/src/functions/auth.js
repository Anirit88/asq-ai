// Sign-in for outside users (email + password), sign-up, sign-out, password change, "who am I", public site settings.
const { app } = require('../lib/v3');
const C = require('../lib/core');

// GET /api/site -> public login-page settings (no secrets)
app.http('site', {
  route: 'site', methods: ['GET'], authLevel: 'anonymous',
  handler: C.handle(async () => C.ok(C.publicSite(await C.getSite())))
});

// GET /api/me -> the signed-in user, or 401
app.http('me', {
  route: 'me', methods: ['GET'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    const r = await C.currentUser(request);
    if (!r.user) return C.json(401, { error: 'Sign in required', reason: r.reason });
    const site = await C.getSite();
    return C.ok({ user: C.publicUser(r.user), via: r.via, views: C.VIEWS[r.user.role] || [], site: C.publicSite(site) });
  })
});

// POST /api/auth/login { email, password }
app.http('authLogin', {
  route: 'auth/login', methods: ['POST'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    const body = await C.readJson(request);
    const email = String(body.email || '').trim().toLowerCase();
    const pw = String(body.password || '');
    const site = await C.getSite();
    if (!site.methods.password) return C.bad('Email and password sign-in is turned off. Use the other sign-in options.', 403);
    if (!email || !pw) return C.bad('Enter your email and password.');

    let users = await C.getUsers();
    // First-run bootstrap: the ADMIN_EMAIL / ADMIN_PASSWORD app settings create the first admin.
    const envEmail = String(process.env.ADMIN_EMAIL || '').toLowerCase();
    if (envEmail && email === envEmail && process.env.ADMIN_PASSWORD && pw === process.env.ADMIN_PASSWORD &&
        !users.some((u) => u.email === envEmail && u.pw)) {
      await C.updateUsers((list) => {
        let u = list.find((x) => x.email === envEmail);
        if (!u) { u = C.newUser({ email: envEmail, first: 'Admin', role: 'admin' }); list.push(u); }
        u.role = 'admin'; u.status = 'active'; u.pw = C.hashPassword(pw); u.mustChange = true;
      });
      await C.audit(envEmail, 'First admin account created from app settings');
      users = await C.getUsers();
    }

    const u = users.find((x) => x.email === email);
    if (u && u.lockUntil && u.lockUntil > Date.now()) {
      const mins = Math.ceil((u.lockUntil - Date.now()) / 60000);
      return C.bad('Too many attempts. Try again in ' + mins + ' minute' + (mins > 1 ? 's' : '') + ', or ask the clinic to unlock your account.', 429);
    }
    const good = C.verifyPassword(pw, u && u.pw);
    if (!u || !good) {
      if (u) {
        await C.updateUsers((list) => {
          const x = list.find((y) => y.id === u.id); if (!x) return;
          x.failed = (x.failed || 0) + 1;
          if (x.failed >= (site.lockout || 5)) { x.lockUntil = Date.now() + 15 * 60000; x.failed = 0; }
        });
        if ((u.failed || 0) + 1 >= (site.lockout || 5)) await C.audit(email, 'Account locked for 15 minutes after failed sign-ins');
      }
      return C.bad('That email and password do not match.', 401);
    }
    if (u.status !== 'active') return C.bad('This account is disabled. Contact the clinic.', 403);
    let fresh = u;
    await C.updateUsers((list) => { const x = list.find((y) => y.id === u.id); if (x) { x.failed = 0; x.lockUntil = 0; x.lastLogin = new Date().toISOString(); fresh = x; } });
    const hours = site.sessionHours || 12;
    return C.ok({ user: C.publicUser(fresh) }, { cookies: [C.sessionCookie(C.signToken(fresh, hours), hours)] });
  })
});

// POST /api/auth/signup { first, last, email, password, dob, phone } -> patient account
app.http('authSignup', {
  route: 'auth/signup', methods: ['POST'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    const site = await C.getSite();
    const b = await C.readJson(request);
    const wantsDoctor = b.role === 'doctor';
    if (!site.methods.password) return C.bad('Email and password sign-up is turned off for this clinic.', 403);
    if (wantsDoctor) {
      if (!site.doctorCode) return C.bad('Doctor sign-up is not open. Ask your clinic admin to create your account or share the clinic code.', 403);
      const given = Buffer.from(String(b.code || '').trim().toUpperCase()); const want = Buffer.from(String(site.doctorCode).trim().toUpperCase());
      if (given.length !== want.length || !require('crypto').timingSafeEqual(given, want)) return C.bad('That clinic code is not correct. Ask your clinic admin for the current code.', 403);
    } else if (!site.allowSignup) return C.bad('New patient sign-up is turned off. Contact the clinic to get an account.', 403);
    const email = String(b.email || '').trim().toLowerCase();
    if (!C.validEmail(email)) return C.bad('Enter a valid email address.');
    if (!String(b.first || '').trim() || !String(b.last || '').trim()) return C.bad('Enter your first and last name.');
    const prob = C.passwordProblem(b.password, site.passwordMin); if (prob) return C.bad(prob);
    let created = null; let exists = false;
    await C.updateUsers((list) => {
      if (list.some((x) => x.email === email)) { exists = true; return; }
      created = C.newUser({ email, first: b.first, last: b.last, dob: b.dob, phone: b.phone, role: wantsDoctor ? 'doctor' : 'patient' });
      if (wantsDoctor) created.doctor = { specialty: String(b.specialty || '').slice(0, 80), clinic: site.clinicName || '', fee: '', years: '', tele: true };
      created.pw = C.hashPassword(b.password); created.lastLogin = new Date().toISOString();
      list.push(created);
    });
    if (exists) return C.bad('An account with this email already exists. Sign in instead.', 409);
    await C.audit(email, (wantsDoctor ? 'Doctor' : 'Patient') + ' created an account (self sign-up' + (wantsDoctor ? ' with clinic code' : '') + ')');
    const hours = site.sessionHours || 12;
    return C.ok({ user: C.publicUser(created) }, { cookies: [C.sessionCookie(C.signToken(created, hours), hours)] });
  })
});

// POST /api/auth/logout
app.http('authLogout', {
  route: 'auth/logout', methods: ['POST'], authLevel: 'anonymous',
  handler: C.handle(async () => C.ok({ ok: true }, { cookies: [C.clearCookie()] }))
});

// POST /api/auth/password { current, next }
app.http('authPassword', {
  route: 'auth/password', methods: ['POST'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    const me = await C.requireUser(request);
    const b = await C.readJson(request);
    const site = await C.getSite();
    if (me.pw && !C.verifyPassword(b.current, me.pw)) return C.bad('Your current password is not correct.', 401);
    const prob = C.passwordProblem(b.next, site.passwordMin); if (prob) return C.bad(prob);
    if (b.current && b.current === b.next) return C.bad('Choose a password that is different from the current one.');
    let fresh = me;
    await C.updateUsers((list) => { const x = list.find((y) => y.id === me.id); if (x) { x.pw = C.hashPassword(b.next); x.mustChange = false; x.tv = (x.tv || 1) + 1; fresh = x; } });
    await C.audit(me.email, 'Changed password');
    const hours = site.sessionHours || 12;
    return C.ok({ user: C.publicUser(fresh) }, { cookies: [C.sessionCookie(C.signToken(fresh, hours), hours)] });
  })
});

// PUT /api/me/profile { first, last, phone, dob, doctor: { specialty, clinic, fee, years, tele, bio } }
app.http('meProfile', {
  route: 'me/profile', methods: ['PUT'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    const me = await C.requireUser(request, ['patient', 'doctor', 'admin']);
    const b = await C.readJson(request);
    let fresh = null;
    await C.updateUsers((list) => {
      const x = list.find((y) => y.id === me.id); if (!x) return;
      ['first', 'last', 'phone'].forEach((k) => { if (typeof b[k] === 'string') x[k] = b[k].trim().slice(0, 60); });
      if (typeof b.dob === 'string') x.dob = b.dob.slice(0, 10);
      if (b.doctor && typeof b.doctor === 'object' && (x.role === 'doctor' || x.role === 'admin')) {
        const d = b.doctor;
        x.doctor = { specialty: String(d.specialty || '').slice(0, 80), clinic: String(d.clinic || '').slice(0, 80), fee: String(d.fee || '').slice(0, 10), years: String(d.years || '').slice(0, 4), tele: !!d.tele, bio: String(d.bio || '').slice(0, 400) };
      }
      fresh = x;
    });
    return C.ok({ user: C.publicUser(fresh) });
  })
});

// GET /api/clinic/doctors -> the clinic's doctors, for patients choosing a provider
app.http('clinicDoctors', {
  route: 'clinic/doctors', methods: ['GET'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    await C.requireUser(request);
    const users = await C.getUsers();
    const docs = users.filter((u) => u.status === 'active' && (u.role === 'doctor' || (u.role === 'admin' && u.doctor && u.doctor.specialty)))
      .map((u) => ({ id: u.id, name: 'Dr. ' + ((u.first || '') + ' ' + (u.last || '')).trim(), specialty: (u.doctor && u.doctor.specialty) || 'General Medicine', clinic: (u.doctor && u.doctor.clinic) || '', years: +((u.doctor && u.doctor.years) || 0) || 0, fee: (u.doctor && u.doctor.fee) || '', tele: u.doctor ? u.doctor.tele !== false : true, bio: (u.doctor && u.doctor.bio) || '' }));
    return C.ok({ doctors: docs });
  })
});
