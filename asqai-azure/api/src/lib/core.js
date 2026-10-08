// Shared helpers: HTTP responses, accounts, sessions, site settings, audit log.
const crypto = require('crypto');
const { getDoc, updateDoc } = require('./store');

const USERS_DOC = 'auth/users.json';
const SITE_DOC = 'config/site.json';
const AUDIT_DOC = 'admin/audit.json';
const COOKIE = 'asq_s';
const ROLES = ['patient', 'doctor', 'admin', 'kiosk'];

/* ---------------- http ---------------- */
function json(status, body, extra) {
  return Object.assign({ status, jsonBody: body, headers: { 'Cache-Control': 'no-store' } }, extra || {});
}
const ok = (body, extra) => json(200, body, extra);
const bad = (msg, status) => json(status || 400, { error: msg });

async function readJson(request, maxBytes) {
  const ct = request.headers.get('content-type') || '';
  if (!/application\/json/i.test(ct)) { const e = new Error('Content-Type must be application/json'); e.status = 415; throw e; }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > (maxBytes || 256 * 1024)) { const e = new Error('Request too large'); e.status = 413; throw e; }
  try { return JSON.parse(text || '{}'); } catch (e) { const er = new Error('Body must be JSON'); er.status = 400; throw er; }
}

// Wrap a handler: turns thrown errors into JSON responses.
function handle(fn) {
  return async (request, context) => {
    try { return await fn(request, context); }
    catch (e) {
      if (e.status) return bad(e.message, e.status);
      context.error(e);
      return bad('Server error', 500);
    }
  };
}

/* ---------------- site settings ---------------- */
function defaultSite() {
  return {
    clinicName: 'Ghadiali Healthcare Center',
    supportPhone: '(555) 010-2040',
    accent: '#0F766E',
    methods: { password: true, microsoft: true, github: true },
    allowSignup: true,
    passwordMin: 8,
    sessionHours: 12,
    lockout: 5,
    announcement: '',
    maintenance: false,
    portals: {
      patient: {
        headline: 'Your care, ready before you arrive',
        sub: 'Complete your intake, book visits and see your records in one secure place.',
        bullets: ['Finish your intake from home in a few minutes', 'Book in-person or video visits', 'Check in at the lobby kiosk in seconds'],
        cta: 'Sign in'
      },
      doctor: {
        headline: 'Your clinic workspace',
        sub: 'Schedule, check-in queue, AI-reviewed intakes and your intake builder.',
        bullets: ['See who has arrived and who needs follow-up', 'Review intakes with flagged fields first', 'Publish intake questions without IT'],
        cta: 'Sign in'
      }
    },
    kiosk: { pin: '2468', idleSeconds: 90, walkins: true, insurance: true, vitals: true, consent: true, languages: ['English', 'Spanish'], welcome: 'Welcome. Let us check you in.' }
  };
}

function mergeSite(saved) {
  const d = defaultSite();
  if (!saved) return d;
  const out = Object.assign({}, d, saved);
  out.methods = Object.assign({}, d.methods, saved.methods || {});
  out.portals = {
    patient: Object.assign({}, d.portals.patient, (saved.portals || {}).patient || {}),
    doctor: Object.assign({}, d.portals.doctor, (saved.portals || {}).doctor || {})
  };
  out.kiosk = Object.assign({}, d.kiosk, saved.kiosk || {});
  return out;
}

let siteCache = { at: 0, v: null };
async function getSite(fresh) {
  if (!fresh && siteCache.v && Date.now() - siteCache.at < 10000) return siteCache.v;
  const r = await getDoc(SITE_DOC);
  siteCache = { at: Date.now(), v: mergeSite(r.data) };
  return siteCache.v;
}
function clearSiteCache() { siteCache = { at: 0, v: null }; }

function publicSite(s) {
  const k = Object.assign({}, s.kiosk); delete k.pin;
  return {
    clinicName: s.clinicName, supportPhone: s.supportPhone, accent: s.accent, methods: s.methods,
    allowSignup: s.allowSignup, passwordMin: s.passwordMin, announcement: s.announcement, maintenance: s.maintenance,
    portals: s.portals, kiosk: k
  };
}

/* ---------------- passwords ---------------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return { alg: 'scrypt', salt: salt.toString('base64'), hash: hash.toString('base64') };
}
function verifyPassword(pw, rec) {
  if (!rec || !rec.salt) { crypto.scryptSync(String(pw), 'x', 64); return false; }
  const hash = crypto.scryptSync(String(pw), Buffer.from(rec.salt, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(rec.hash, 'base64');
  return want.length === hash.length && crypto.timingSafeEqual(want, hash);
}
function tempPassword() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  const b = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) s += A[b[i] % A.length];
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8);
}
function passwordProblem(pw, min) {
  pw = String(pw || '');
  if (pw.length < (min || 8)) return 'Password must be at least ' + (min || 8) + ' characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password needs at least one letter and one number.';
  return null;
}

/* ---------------- users ---------------- */
async function getUsers() { const r = await getDoc(USERS_DOC); return (r.data && r.data.users) || []; }
async function updateUsers(fn) { return updateDoc(USERS_DOC, async (doc) => { doc.users = doc.users || []; await fn(doc.users); return doc; }, { users: [] }); }

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, first: u.first || '', last: u.last || '', role: u.role, status: u.status,
    created: u.created, lastLogin: u.lastLogin || null, mustChange: !!u.mustChange, phone: u.phone || '', dob: u.dob || '',
    methods: ['password'].filter(() => !!u.pw).concat((u.providers || []).map((p) => p.p === 'aad' ? 'microsoft' : p.p)),
    locked: !!(u.lockUntil && u.lockUntil > Date.now())
  };
}
function newUser(f) {
  return {
    id: 'u_' + crypto.randomBytes(8).toString('hex'),
    email: String(f.email || '').trim().toLowerCase(),
    first: String(f.first || '').trim().slice(0, 60), last: String(f.last || '').trim().slice(0, 60),
    role: ROLES.indexOf(f.role) >= 0 ? f.role : 'patient', status: 'active',
    phone: String(f.phone || '').slice(0, 30), dob: String(f.dob || '').slice(0, 10),
    created: new Date().toISOString(), tv: 1, providers: []
  };
}
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '')) && String(e).length <= 254;

/* ---------------- sessions ---------------- */
function secret() {
  return process.env.SESSION_SECRET || crypto.createHash('sha256').update('asq-session:' + (process.env.STORAGE_CONNECTION_STRING || '')).digest('hex');
}
const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function signToken(u, hours) {
  const body = b64u(JSON.stringify({ uid: u.id, tv: u.tv || 1, exp: Date.now() + hours * 3600 * 1000 }));
  const sig = b64u(crypto.createHmac('sha256', secret()).update(body).digest());
  return body + '.' + sig;
}
function verifyToken(t) {
  if (!t || t.indexOf('.') < 0) return null;
  const [body, sig] = t.split('.');
  const want = b64u(crypto.createHmac('sha256', secret()).update(body).digest());
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try {
    const p = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return p.exp > Date.now() ? p : null;
  } catch (e) { return null; }
}
function sessionCookie(token, hours) {
  return { name: COOKIE, value: token, httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: Math.round(hours * 3600) };
}
function clearCookie() { return { name: COOKIE, value: '', httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 0 }; }
function readCookie(request, name) {
  const c = request.headers.get('cookie') || '';
  const m = c.split(/;\s*/).find((x) => x.indexOf(name + '=') === 0);
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function swaPrincipal(request) {
  const h = request.headers.get('x-ms-client-principal');
  if (!h) return null;
  try { const p = JSON.parse(Buffer.from(h, 'base64').toString('utf8')); return p && p.userId ? p : null; } catch (e) { return null; }
}

// Who is calling? Returns { user } or { user: null, reason }.
async function currentUser(request) {
  const tok = verifyToken(readCookie(request, COOKIE));
  if (tok) {
    const u = (await getUsers()).find((x) => x.id === tok.uid);
    if (u && u.status === 'active' && (u.tv || 1) === tok.tv) return { user: u, via: 'password' };
  }
  const p = swaPrincipal(request);
  if (!p) return { user: null, reason: 'signed-out' };
  const site = await getSite();
  const method = p.identityProvider === 'aad' ? 'microsoft' : p.identityProvider;
  if (!site.methods[method]) return { user: null, reason: 'method-disabled' };
  const ident = String(p.userDetails || '').toLowerCase();
  // Fast path: already linked and seen within the last hour -> no write needed.
  const linked = (await getUsers()).find((x) => (x.providers || []).some((q) => q.p === p.identityProvider && q.uid === p.userId));
  if (linked && linked.status === 'active' && linked.lastLogin && Date.now() - Date.parse(linked.lastLogin) < 3600 * 1000) return { user: linked, via: method };
  if (linked && linked.status !== 'active') return { user: null, reason: 'disabled' };
  let found = null; let reason = 'not-registered';
  await updateUsers((users) => {
    let u = users.find((x) => (x.providers || []).some((q) => q.p === p.identityProvider && q.uid === p.userId));
    if (!u && validEmail(ident)) u = users.find((x) => x.email === ident);
    if (!u) {
      const isBootstrap = process.env.ADMIN_EMAIL && ident === String(process.env.ADMIN_EMAIL).toLowerCase();
      if (isBootstrap || site.allowSignup) {
        u = newUser({ email: validEmail(ident) ? ident : ident + '@' + p.identityProvider, first: ident.split('@')[0], role: isBootstrap ? 'admin' : 'patient' });
        users.push(u);
      }
    }
    if (!u) return;
    if (u.status !== 'active') { reason = 'disabled'; return; }
    u.providers = u.providers || [];
    if (!u.providers.some((q) => q.p === p.identityProvider && q.uid === p.userId)) u.providers.push({ p: p.identityProvider, uid: p.userId });
    u.lastLogin = new Date().toISOString();
    found = u;
  });
  return found ? { user: found, via: method } : { user: null, reason };
}

async function requireUser(request, roles) {
  const r = await currentUser(request);
  if (!r.user) { const e = new Error(r.reason === 'disabled' ? 'Account disabled' : 'Sign in required'); e.status = 401; throw e; }
  if (roles && roles.indexOf(r.user.role) < 0) { const e = new Error('Not allowed for your role'); e.status = 403; throw e; }
  return r.user;
}

/* ---------------- audit ---------------- */
async function audit(actor, action) {
  try {
    await updateDoc(AUDIT_DOC, (doc) => {
      doc.items = [{ at: new Date().toISOString(), actor: actor ? (actor.email || actor) : 'system', action }].concat(doc.items || []).slice(0, 1000);
      return doc;
    }, { items: [] });
  } catch (e) { /* audit must never break the request */ }
}

module.exports = {
  json, ok, bad, readJson, handle,
  SITE_DOC, USERS_DOC, AUDIT_DOC, ROLES,
  defaultSite, mergeSite, getSite, clearSiteCache, publicSite,
  hashPassword, verifyPassword, tempPassword, passwordProblem,
  getUsers, updateUsers, publicUser, newUser, validEmail,
  signToken, sessionCookie, clearCookie, currentUser, requireUser, audit
};
