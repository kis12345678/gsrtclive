import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ClientLimiter, createHandler } from '../server/app.js';

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
