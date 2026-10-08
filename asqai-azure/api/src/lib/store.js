// Tiny JSON document store on Azure Blob Storage, with optimistic concurrency (ETags).
const { BlobServiceClient } = require('@azure/storage-blob');

const CONTAINER = process.env.STORAGE_CONTAINER || 'asqai-data';
let containerClient = null;
let ensured = false;

function container() {
  if (!containerClient) {
    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) throw new Error('STORAGE_CONNECTION_STRING app setting is missing');
    containerClient = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
  }
  return containerClient;
}

async function ensure() {
  if (ensured) return;
  await container().createIfNotExists(); // private: no public access
  ensured = true;
}

// Returns { data, etag } or { data: null, etag: null } when missing.
async function getDoc(name) {
  await ensure();
  const blob = container().getBlockBlobClient(name);
  try {
    const res = await blob.download();
    const buf = await streamToBuffer(res.readableStreamBody);
    return { data: JSON.parse(buf.toString('utf8') || 'null'), etag: res.etag };
  } catch (e) {
    if (e.statusCode === 404) return { data: null, etag: null };
    throw e;
  }
}

// etag: string -> only write if unchanged; null -> only write if missing; undefined -> overwrite.
async function putDoc(name, data, etag) {
  await ensure();
  const blob = container().getBlockBlobClient(name);
  const body = JSON.stringify(data);
  const conditions = etag === undefined ? {} : etag === null ? { ifNoneMatch: '*' } : { ifMatch: etag };
  try {
    const r = await blob.upload(body, Buffer.byteLength(body, 'utf8'), {
      blobHTTPHeaders: { blobContentType: 'application/json' },
      conditions
    });
    return { ok: true, etag: r.etag };
  } catch (e) {
    if (e.statusCode === 412 || e.statusCode === 409) return { ok: false, conflict: true };
    throw e;
  }
}

async function deleteDoc(name) {
  await ensure();
  await container().getBlockBlobClient(name).deleteIfExists();
}

// Read-modify-write with retries on conflict. fn(current) returns the new doc (or throws).
async function updateDoc(name, fn, fallback) {
  for (let i = 0; i < 6; i++) {
    const cur = await getDoc(name);
    const base = cur.data == null ? (typeof fallback === 'function' ? fallback() : fallback) : cur.data;
    const next = await fn(JSON.parse(JSON.stringify(base)));
    const r = await putDoc(name, next, cur.etag);
    if (r.ok) return next;
    await new Promise((res) => setTimeout(res, 60 + Math.random() * 140));
  }
  const err = new Error('Busy, please retry');
  err.status = 409;
  throw err;
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

module.exports = { getDoc, putDoc, updateDoc, deleteDoc };
