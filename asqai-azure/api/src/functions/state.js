// ASQAi data API: saves and loads each signed-in user's app data as a private JSON file in Azure Blob Storage.
// Route: /api/state   GET = load, PUT = save, DELETE = erase my data.
const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const crypto = require('crypto');

const CONTAINER = process.env.STORAGE_CONTAINER || 'asqai-data';
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB per user is plenty for the demo
let containerClient;

function container() {
  if (!containerClient) {
    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) throw new Error('STORAGE_CONNECTION_STRING app setting is missing');
    containerClient = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
  }
  return containerClient;
}

// Azure Static Web Apps passes the signed-in user in this header. It cannot be forged by the browser:
// the platform strips it from incoming requests and sets it itself.
function principal(request) {
  const h = request.headers.get('x-ms-client-principal');
  if (!h) return null;
  try {
    const p = JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
    return p && p.userId ? p : null;
  } catch (e) { return null; }
}

function blobFor(p) {
  // Hash provider + userId so the file name can never collide across users or contain path characters.
  const key = crypto.createHash('sha256').update(String(p.identityProvider || '') + ':' + String(p.userId)).digest('hex');
  return container().getBlockBlobClient('users/' + key + '.json');
}

app.http('state', {
  route: 'state',
  methods: ['GET', 'PUT', 'DELETE'],
  authLevel: 'anonymous', // access is enforced by staticwebapp.config.json + the principal check below
  handler: async (request, context) => {
    const p = principal(request);
    if (!p) return { status: 401, jsonBody: { error: 'Sign in required' } };
    const headers = { 'Cache-Control': 'no-store' };

    try {
      await container().createIfNotExists(); // private container, no public access
      const blob = blobFor(p);

      if (request.method === 'GET') {
        if (!(await blob.exists())) return { status: 204, headers };
        const buf = await blob.downloadToBuffer();
        return { status: 200, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: buf.toString('utf8') };
      }

      if (request.method === 'DELETE') {
        await blob.deleteIfExists();
        context.log('Data erased for user ' + p.userId);
        return { status: 204, headers };
      }

      // PUT
      const text = await request.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return { status: 413, jsonBody: { error: 'Too large' } };
      let data;
      try { data = JSON.parse(text); } catch (e) { return { status: 400, jsonBody: { error: 'Body must be JSON' } }; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return { status: 400, jsonBody: { error: 'Body must be a JSON object' } };
      const out = JSON.stringify(data);
      await blob.upload(out, Buffer.byteLength(out, 'utf8'), {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        metadata: { provider: String(p.identityProvider || ''), savedat: new Date().toISOString() }
      });
      return { status: 200, headers, jsonBody: { ok: true, savedAt: new Date().toISOString() } };
    } catch (e) {
      context.error(e);
      return { status: 500, jsonBody: { error: 'Storage error' } };
    }
  }
});
