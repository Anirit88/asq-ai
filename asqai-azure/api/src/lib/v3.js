// Small adapter: lets the handlers (written in the "app.http" style) run on the classic
// function.json programming model, which every Azure Static Web Apps plan supports.
const handlers = {};
const app = { http(name, opts) { handlers[name] = opts; } };

function toRequest(context, req) {
  const headers = {};
  Object.keys(req.headers || {}).forEach((k) => { headers[k.toLowerCase()] = req.headers[k]; });
  const query = new URLSearchParams();
  Object.keys(req.query || {}).forEach((k) => query.set(k, req.query[k]));
  return {
    method: String(req.method || 'GET').toUpperCase(),
    headers: { get: (k) => (headers[String(k).toLowerCase()] !== undefined ? headers[String(k).toLowerCase()] : null) },
    query,
    params: req.params || {},
    text: async () => {
      if (typeof req.rawBody === 'string') return req.rawBody;
      if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
      if (req.body === undefined || req.body === null) return '';
      return typeof req.body === 'string' ? req.body : (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body));
    }
  };
}

function run(name) {
  return async function (context, req) {
    const h = handlers[name];
    const ctx = { log: (...a) => context.log(...a), error: (...a) => (context.log.error ? context.log.error(...a) : context.log(...a)) };
    let r;
    try { r = await h.handler(toRequest(context, req), ctx); }
    catch (e) { ctx.error(e); r = { status: 500, jsonBody: { error: 'Server error' } }; }
    r = r || { status: 204 };
    const headers = Object.assign({}, r.headers || {});
    let body = r.body;
    if (r.jsonBody !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(r.jsonBody); }
    context.res = {
      status: r.status || 200,
      headers,
      body: body === undefined ? '' : body,
      cookies: (r.cookies || []).map((c) => ({ name: c.name, value: c.value, path: c.path || '/', maxAge: c.maxAge, httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite || 'Lax' }))
    };
  };
}

module.exports = { app, run, handlers };
