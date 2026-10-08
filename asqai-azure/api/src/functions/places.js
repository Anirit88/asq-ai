// Real doctors near a location (United States).
//  - Doctors: CMS NPPES NPI Registry (every licensed US provider, with specialty, practice address and phone)
//  - Map positions: US Census Bureau geocoder (practice address -> coordinates)
//  - Clinics and hospitals on the map: OpenStreetMap (Overpass API)
//  - Address search and "use my location": OpenStreetMap Nominatim
// All are free public services with no API key. Results are cached for 30 minutes to stay polite.
const { app } = require('@azure/functions');
const C = require('../lib/core');

const UA = 'ASQAi/2.0 (clinic intake demo; Azure Static Web Apps)';
const cache = new Map();
function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.p;
  const p = fn().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, { at: Date.now(), p });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return p;
}
async function getJson(url, opts, ms) {
  const r = await fetch(url, Object.assign({ headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(ms || 8000) }, opts || {}));
  if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + new URL(url).host);
  return r.json();
}
function miles(a, b, c, d) {
  const R = 3958.8, rad = Math.PI / 180;
  const x = Math.sin((c - a) * rad / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin((d - b) * rad / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const title = (s) => String(s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Md|Do|Np|Pa|Llc|Pc|Ii|Iii|Iv|Ste|Mph|Phd)\b/g, (m) => m.toUpperCase());
const fmtPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : (p || ''); };

const SPEC_TAX = {
  'General Medicine': ['Family Medicine', 'Internal Medicine'],
  'Neurology': ['Neurology'],
  'Orthopedics': ['Orthopaedic Surgery'],
  'Cardiology': ['Cardiovascular Disease'],
  'Dermatology': ['Dermatology'],
  'Pediatrics': ['Pediatrics'],
  'OB/GYN': ['Obstetrics & Gynecology'],
  'Psychiatry': ['Psychiatry'],
  'Surgical Oncology': ['Surgical Oncology'],
  'Ophthalmology': ['Ophthalmology'],
  'ENT': ['Otolaryngology']
};
const ALL_TAX = ['Family Medicine', 'Internal Medicine', 'Pediatrics', 'Cardiovascular Disease', 'Dermatology', 'Neurology', 'Orthopaedic Surgery'];

async function reverse(lat, lon) {
  return cached('rev:' + lat.toFixed(3) + ',' + lon.toFixed(3), 86400000, async () => {
    const j = await getJson('https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=16&lat=' + lat + '&lon=' + lon);
    const a = j.address || {};
    const st = String(a['ISO3166-2-lvl4'] || '').replace(/^US-/, '');
    return { zip: String(a.postcode || '').slice(0, 5), city: a.city || a.town || a.village || a.suburb || a.county || '', state: st, country: a.country_code || '', label: [a.road ? (a.house_number ? a.house_number + ' ' : '') + a.road : '', a.city || a.town || a.village || '', st].filter(Boolean).join(', ') };
  });
}

async function npi(tax, postal, limit) {
  return cached('npi:' + tax + ':' + postal + ':' + limit, 1800000, async () => {
    const u = 'https://npiregistry.cms.hhs.gov/api/?version=2.1&enumeration_type=NPI-1&address_purpose=LOCATION&limit=' + limit +
      '&postal_code=' + encodeURIComponent(postal) + '&taxonomy_description=' + encodeURIComponent(tax);
    const j = await getJson(u, null, 9000);
    return j.results || [];
  });
}

async function census(addr) {
  return cached('geo:' + addr, 7 * 86400000, async () => {
    const j = await getJson('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=' + encodeURIComponent(addr), null, 7000);
    const m = j.result && j.result.addressMatches && j.result.addressMatches[0];
    return m ? { lat: m.coordinates.y, lon: m.coordinates.x } : null;
  });
}

function toDoctor(r, prefix, want) {
  const b = r.basic || {};
  const locs = (r.addresses || []).filter((a) => a.address_purpose === 'LOCATION').concat(r.practiceLocations || []);
  const loc = locs.find((a) => String(a.postal_code || '').indexOf(prefix) === 0) || locs[0];
  if (!loc || b.status === 'D') return null;
  const txs = r.taxonomies || [];
  const tx = (want && txs.find((t) => String(t.desc || '').indexOf(want) >= 0)) || txs.find((t) => t.primary) || txs[0] || {};
  const spec = String(tx.desc || '').split(',').pop().trim();
  const cred = String(b.credential || '').replace(/\./g, '').toUpperCase();
  const first = title(b.first_name), last = title(b.last_name);
  const isDr = /\b(MD|DO)\b/.test(cred) || /dr/i.test(b.name_prefix || '');
  const street = title([loc.address_1, loc.address_2].filter(Boolean).join(' '));
  const zip = String(loc.postal_code || '').slice(0, 5);
  return {
    id: 'npi' + r.number, npi: r.number, name: isDr ? 'Dr. ' + first + ' ' + last : first + ' ' + last + (cred ? ', ' + cred.replace(/\s+/g, ' ') : ''),
    first, last, credential: cred, specialty: spec || 'Clinician', taxonomy: tx.desc || '', gender: b.sex || b.gender || '',
    address: street, city: title(loc.city), state: loc.state, zip, phone: fmtPhone(loc.telephone_number),
    full: street + ', ' + title(loc.city) + ', ' + loc.state + ' ' + zip, source: 'NPI Registry'
  };
}

async function findDoctors(lat, lon, spec, radius) {
  const where = await reverse(lat, lon);
  if (where.country && where.country !== 'us') { const e = new Error('Doctor search covers the United States only.'); e.status = 422; throw e; }
  if (!where.zip) { const e = new Error('Could not find a ZIP code for this location. Try typing a US ZIP code.'); e.status = 422; throw e; }
  const taxes = SPEC_TAX[spec] || ALL_TAX;
  const per = spec && SPEC_TAX[spec] ? 120 : 40;
  const pull = async (prefix, limit) => {
    const lists = await Promise.all(taxes.map((t) => npi(t, prefix + '*', limit).catch(() => [])));
    const out = new Map();
    lists.forEach((list, i) => list.forEach((r) => { const d = toDoctor(r, prefix, taxes[i]); if (d && !out.has(d.npi)) out.set(d.npi, d); }));
    return Array.from(out.values());
  };
  let docs = await pull(where.zip, Math.min(per, 60));
  if (docs.length < 15) {
    const wide = await pull(where.zip.slice(0, 3), per);
    const seen = new Set(docs.map((d) => d.npi));
    docs = docs.concat(wide.filter((d) => !seen.has(d.npi)));
  }
  // Same ZIP first, then nearby ZIPs (closest number first), then place each practice on the map.
  docs.sort((a, b) => Math.abs(+a.zip - +where.zip) - Math.abs(+b.zip - +where.zip));
  docs = docs.slice(0, 60);
  const addrs = Array.from(new Set(docs.map((d) => d.full))).slice(0, 36);
  const coords = new Map();
  for (let i = 0; i < addrs.length; i += 12) {
    const part = addrs.slice(i, i + 12);
    const res = await Promise.all(part.map((a) => census(a).catch(() => null)));
    part.forEach((a, j) => coords.set(a, res[j]));
  }
  docs.forEach((d) => {
    const c = coords.get(d.full);
    if (c) { d.lat = c.lat; d.lon = c.lon; d.dist = Math.round(miles(lat, lon, c.lat, c.lon) * 10) / 10; }
  });
  const placed = docs.filter((d) => d.dist != null && d.dist <= radius).sort((a, b) => a.dist - b.dist);
  const unplaced = docs.filter((d) => d.dist == null).slice(0, Math.max(0, 12 - placed.length));
  return { where, doctors: placed.slice(0, 40).concat(unplaced) };
}

async function findPlaces(lat, lon, radius) {
  const m = Math.round(Math.min(radius, 15) * 1609);
  return cached('osm:' + lat.toFixed(3) + ',' + lon.toFixed(3) + ':' + m, 1800000, async () => {
    const q = '[out:json][timeout:15];(' +
      'nwr(around:' + m + ',' + lat + ',' + lon + ')["amenity"~"^(clinic|doctors|hospital)$"]["name"];' +
      'nwr(around:' + m + ',' + lat + ',' + lon + ')["healthcare"~"^(clinic|doctor|hospital|centre)$"]["name"];' +
      ');out center tags 80;';
    const j = await getJson('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' } }, 16000);
    const seen = new Set();
    return (j.elements || []).map((e) => {
      const t = e.tags || {}; const la = e.lat || (e.center && e.center.lat); const lo = e.lon || (e.center && e.center.lon);
      if (!la || !lo || seen.has(t.name)) return null; seen.add(t.name);
      const kind = t.amenity === 'hospital' || t.healthcare === 'hospital' ? 'Hospital' : (t.amenity === 'doctors' || t.healthcare === 'doctor') ? 'Doctor’s office' : 'Clinic';
      return { id: 'osm' + e.type[0] + e.id, name: t.name, kind, lat: la, lon: lo, dist: Math.round(miles(lat, lon, la, lo) * 10) / 10,
        address: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ') + (t['addr:city'] ? ', ' + t['addr:city'] : ''),
        phone: t.phone || t['contact:phone'] || '', website: t.website || t['contact:website'] || '', specialty: String(t['healthcare:speciality'] || '').replace(/_/g, ' '),
        hours: t.opening_hours || '', source: 'OpenStreetMap' };
    }).filter(Boolean).sort((a, b) => a.dist - b.dist).slice(0, 40);
  });
}

// GET /api/geocode?q=60601  -> { lat, lon, label }
app.http('geocode', {
  route: 'geocode', methods: ['GET'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    await C.requireUser(request);
    const q = String(request.query.get('q') || '').trim().slice(0, 120);
    if (q.length < 2) return C.bad('Type a city, address or ZIP code.');
    const list = await cached('fwd:' + q.toLowerCase(), 86400000, () => getJson('https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=us&limit=1&addressdetails=1&q=' + encodeURIComponent(q)));
    if (!list.length) return C.bad('We could not find that place in the US. Try a ZIP code.', 404);
    const a = list[0].address || {};
    const st = String(a['ISO3166-2-lvl4'] || '').replace(/^US-/, '');
    return C.ok({ lat: +list[0].lat, lon: +list[0].lon, label: [a.city || a.town || a.village || a.suburb || a.county || list[0].name, st].filter(Boolean).join(', ') + (a.postcode && /^\d/.test(q) ? ' ' + a.postcode : '') });
  })
});

// GET /api/doctors?lat=..&lon=..&spec=Cardiology&radius=10
app.http('doctors', {
  route: 'doctors', methods: ['GET'], authLevel: 'anonymous',
  handler: C.handle(async (request) => {
    await C.requireUser(request);
    const lat = +request.query.get('lat'), lon = +request.query.get('lon');
    const radius = Math.max(1, Math.min(50, +request.query.get('radius') || 10));
    const spec = String(request.query.get('spec') || 'All');
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return C.bad('Missing location');
    const [docs, places] = await Promise.all([
      findDoctors(lat, lon, spec, radius),
      findPlaces(lat, lon, radius).catch(() => [])
    ]);
    return C.ok({ center: { lat, lon, label: docs.where.label || docs.where.city, zip: docs.where.zip }, doctors: docs.doctors, places: places.filter((p) => p.dist <= radius), sources: ['NPI Registry (CMS)', 'US Census Geocoder', 'OpenStreetMap'] });
  })
});
