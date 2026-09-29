import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ClientLimiter, clientIp, createHandler } from '../server/app.js';

function fakeUpstream() {
  const calls = [];
  return {
    calls,
    async get(path, query, opts) {
      calls.push({ path, query, opts });
      return { path, query };
    },
    health: () => ({ queued: 0 }),
  };
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('maps /api/nearby to upstream with rounded coords', async () => {
  const upstream = fakeUpstream();
  await withServer(createHandler({ upstream, limiter: new ClientLimiter(100) }), async (base) => {
    const res = await fetch(`${base}/api/nearby?lat=23.25123&lng=69.67789&junk=1`);
    assert.equal(res.status, 200);
    assert.deepEqual(upstream.calls[0].path, '/api/nearby');
    assert.deepEqual(upstream.calls[0].query, { lat: '23.251', lng: '69.678' });
  });
});

test('normalizes plates and rejects bad input without calling upstream', async () => {
  const upstream = fakeUpstream();
  await withServer(createHandler({ upstream, limiter: new ClientLimiter(100) }), async (base) => {
    assert.equal((await fetch(`${base}/api/vehicle/gj-18 z1234`)).status, 200);
    assert.equal(upstream.calls[0].path, '/api/vehicle/GJ18Z1234');

    assert.equal((await fetch(`${base}/api/vehicle/..%2F..%2Fetc`)).status, 400);
    assert.equal((await fetch(`${base}/api/nearby?lat=abc&lng=1`)).status, 400);
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/report`, { method: 'POST' })).status, 405);
    assert.equal(upstream.calls.length, 1);
  });
});

test('per-client limiter returns 429 with retry-after', async () => {
  const upstream = fakeUpstream();
  await withServer(createHandler({ upstream, limiter: new ClientLimiter(2) }), async (base) => {
    await fetch(`${base}/api/servicetypes`);
    await fetch(`${base}/api/servicetypes`);
    const res = await fetch(`${base}/api/servicetypes`);
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
  });
});

test('serves the frontend and blocks path traversal', async () => {
  await withServer(createHandler({ upstream: fakeUpstream(), limiter: new ClientLimiter(100) }), async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /GSRTC Live/);
    assert.notEqual((await fetch(`${base}/..%2Fpackage.json`)).status, 200);
  });
});

test('stations route is a name search: spaces and brackets pass, junk and bad encoding do not', async () => {
  const upstream = fakeUpstream();
  await withServer(createHandler({ upstream, limiter: new ClientLimiter(100) }), async (base) => {
    assert.equal((await fetch(`${base}/api/stations/Mundra%20port`)).status, 200);
    assert.equal(upstream.calls[0].path, '/api/stations/Mundra%20port');
    assert.equal((await fetch(`${base}/api/stations/Toda(Mundra)`)).status, 200);

    assert.equal((await fetch(`${base}/api/stations/a`)).status, 400); // too short
    assert.equal((await fetch(`${base}/api/stations/..%2Fhealth`)).status, 400);
    assert.equal((await fetch(`${base}/api/stations/%E0%A4%A`)).status, 400); // malformed %-escape
    assert.equal(upstream.calls.length, 2);
  });
});

test('stops: ids list and snapped bounding box, oversized areas rejected', async () => {
  const upstream = fakeUpstream();
  await withServer(createHandler({ upstream, limiter: new ClientLimiter(100) }), async (base) => {
    assert.equal((await fetch(`${base}/api/stops?ids=594,1082`)).status, 200);
    assert.deepEqual(upstream.calls[0].query, { ids: '594,1082' });

    assert.equal((await fetch(`${base}/api/stops?south=23.2011&west=69.6234&north=23.3021&east=69.7212`)).status, 200);
    assert.deepEqual(upstream.calls[1].query, { south: '23.20', west: '69.62', north: '23.31', east: '69.73' });

    assert.equal((await fetch(`${base}/api/stops?south=20&west=68&north=24&east=72`)).status, 400);
    assert.equal((await fetch(`${base}/api/stops?south=23.3&west=69&north=23.2&east=70`)).status, 400);
    assert.equal((await fetch(`${base}/api/stops?ids=a%2Fb`)).status, 400);
    assert.equal((await fetch(`${base}/api/stops`)).status, 400);
    assert.equal(upstream.calls.length, 2);
  });
});

test('crowd: normalizes, de-duplicates and caps plates', async () => {
  const upstream = fakeUpstream();
  await withServer(createHandler({ upstream, limiter: new ClientLimiter(100) }), async (base) => {
    assert.equal((await fetch(`${base}/api/crowd?plates=GJ-18-Z-6224,gj18z6224,GJ18Z0001`)).status, 200);
    assert.deepEqual(upstream.calls[0].query, { plates: 'GJ18Z0001,GJ18Z6224' });

    const many = Array.from({ length: 11 }, (_, i) => `GJ18Z${1000 + i}`).join(',');
    assert.equal((await fetch(`${base}/api/crowd?plates=${many}`)).status, 400);
    assert.equal((await fetch(`${base}/api/crowd?plates=`)).status, 400);
    assert.equal((await fetch(`${base}/api/crowd?plates=x`)).status, 400);
  });
});

test('geometry/eta, eta/segments and station/parent map onto the upstream', async () => {
  const upstream = fakeUpstream();
  await withServer(createHandler({ upstream, limiter: new ClientLimiter(100) }), async (base) => {
    assert.equal((await fetch(`${base}/api/geometry/eta?fromLat=23.250171&fromLng=69.6707&toLat=23.0715&toLng=70.1461`)).status, 200);
    assert.deepEqual(upstream.calls[0].query, { fromLat: '23.2502', fromLng: '69.6707', toLat: '23.0715', toLng: '70.1461' });
    assert.equal((await fetch(`${base}/api/geometry/eta?fromLat=x&fromLng=1&toLat=2&toLng=3`)).status, 400);

    assert.equal((await fetch(`${base}/api/eta/segments?route=3291`)).status, 200);
    assert.deepEqual(upstream.calls[1], { path: '/api/eta/segments', query: { route: '3291' }, opts: { ttlMs: 600000 } });
    assert.equal((await fetch(`${base}/api/eta/segments`)).status, 400);

    assert.equal((await fetch(`${base}/api/station/parent?id=594&name=Bhuj&junk=1`)).status, 200);
    assert.deepEqual(upstream.calls[2].query, { id: '594', name: 'Bhuj' });
    assert.equal((await fetch(`${base}/api/station/parent`)).status, 400);
  });
});

test('trip, timetable, depot and nearby/buses pass their extra params', async () => {
  const upstream = fakeUpstream();
  await withServer(createHandler({ upstream, limiter: new ClientLimiter(100) }), async (base) => {
    await fetch(`${base}/api/trip?tripId=1&status=1&plate=GJ18Z6224&route=3291&junk=x`);
    assert.deepEqual(upstream.calls[0].query, { tripId: '1', status: '1', plate: 'GJ18Z6224', route: '3291' });

    await fetch(`${base}/api/timetable?from=594&to=1082&combine=1&fromName=Bhuj&junk=x`);
    assert.deepEqual(upstream.calls[1].query, { from: '594', to: '1082', fromName: 'Bhuj', combine: '1' });

    await fetch(`${base}/api/depot/departures?depotId=594&date=2026-09-29&page=2&pageSize=50`);
    assert.deepEqual(upstream.calls[2].query, { depotId: '594', date: '2026-09-29', page: '2', pageSize: '50' });

    await fetch(`${base}/api/nearby/buses?lat=23.25017&lng=69.6707&radius=500`);
    assert.deepEqual(upstream.calls[3].query, { lat: '23.250', lng: '69.671', radius: 50 });
  });
});

test('client ip: proxy headers are ignored unless trustProxy is set', () => {
  const req = (headers) => ({ headers, socket: { remoteAddress: '10.0.0.1' } });
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.1.1.1' })), '10.0.0.1');
  assert.equal(clientIp(req({ 'cf-connecting-ip': '2.2.2.2' })), '10.0.0.1');
  assert.equal(clientIp(req({ 'cf-connecting-ip': '2.2.2.2' }), true), '2.2.2.2');
  // One trusted hop appends the address it saw: a spoofed first entry must not win.
  assert.equal(clientIp(req({ 'x-forwarded-for': '9.9.9.9, 3.3.3.3' }), true), '3.3.3.3');
  assert.equal(clientIp(req({}), true), '10.0.0.1');
  assert.equal(clientIp(req({ 'x-forwarded-for': 'a'.repeat(500) }), true).length, 64);
});

test('behind a trusted proxy each real client gets its own rate-limit bucket', async () => {
  const mk = (trustProxy) => createHandler({ upstream: fakeUpstream(), limiter: new ClientLimiter(2), trustProxy });
  const hit = (base, ip) => fetch(`${base}/api/servicetypes`, { headers: { 'x-forwarded-for': ip } }).then((r) => r.status);

  await withServer(mk(true), async (base) => {
    assert.deepEqual([await hit(base, '1.1.1.1'), await hit(base, '1.1.1.1'), await hit(base, '1.1.1.1')], [200, 200, 429]);
    assert.equal(await hit(base, '2.2.2.2'), 200); // a different visitor is unaffected
  });
  await withServer(mk(false), async (base) => {
    // Not trusted: the header can't be used to dodge the limit.
    assert.deepEqual([await hit(base, '1.1.1.1'), await hit(base, '2.2.2.2'), await hit(base, '3.3.3.3')], [200, 200, 429]);
  });
});
