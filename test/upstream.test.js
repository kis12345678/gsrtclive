import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Upstream, UpstreamError } from '../server/upstream.js';

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const { status = 200, body = {}, headers = {} } = await handler(url, calls.length);
    return new Response(JSON.stringify(body), { status, headers });
  };
  fn.calls = calls;
  return fn;
}

test('caches responses for ttl and coalesces concurrent identical requests', async () => {
  const fetchImpl = fakeFetch(() => ({ body: [{ StationId: '594' }] }));
  const up = new Upstream({ base: 'https://up.test', fetchImpl, rps: 100, burst: 100 });

  const [a, b] = await Promise.all([
    up.get('/api/nearby', { lat: '23.250', lng: '69.670' }, { ttlMs: 60_000 }),
    up.get('/api/nearby', { lat: '23.250', lng: '69.670' }, { ttlMs: 60_000 }),
  ]);
  await up.get('/api/nearby', { lat: '23.250', lng: '69.670' }, { ttlMs: 60_000 });

  assert.deepEqual(a, [{ StationId: '594' }]);
  assert.equal(a, b);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(up.stats.coalesced, 1);
  assert.equal(up.stats.cacheHits, 1);
});

test('token bucket spaces out requests beyond the burst', async () => {
  const fetchImpl = fakeFetch(() => ({ body: {} }));
  const up = new Upstream({ base: 'https://up.test', fetchImpl, rps: 20, burst: 2 });

  const start = Date.now();
  await Promise.all([1, 2, 3, 4].map((i) => up.get(`/x/${i}`)));
  const elapsed = Date.now() - start;

  assert.equal(fetchImpl.calls.length, 4);
  // 2 immediate, then 2 more at 20 rps => at least ~100 ms.
  assert.ok(elapsed >= 90, `expected throttling, took ${elapsed} ms`);
});

test('403 pauses all traffic and surfaces as an UpstreamError', async () => {
  let t = 1_000_000;
  const fetchImpl = fakeFetch((_, n) => (n === 1 ? { status: 403, body: { blocked: true } } : { body: { ok: 1 } }));
  const up = new Upstream({ base: 'https://up.test', fetchImpl, now: () => t, minBackoffMs: 200 });

  await assert.rejects(up.get('/a'), (err) => err instanceof UpstreamError && err.status === 502);
  assert.equal(up.health().pausedForMs, 200);

  // Queued request must not go out while paused.
  const pending = up.get('/b');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetchImpl.calls.length, 1);

  t += 201;
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(await pending, { ok: 1 });
  assert.equal(fetchImpl.calls.length, 2);
});

test('honours Retry-After when longer than the backoff', async () => {
  const t = 1_000_000;
  const fetchImpl = fakeFetch(() => ({ status: 429, headers: { 'retry-after': '30' } }));
  const up = new Upstream({ base: 'https://up.test', fetchImpl, now: () => t, minBackoffMs: 5_000 });

  await assert.rejects(up.get('/a'));
  assert.equal(up.health().pausedForMs, 30_000);
});

test('non-retryable 4xx does not pause traffic', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 404 }));
  const up = new Upstream({ base: 'https://up.test', fetchImpl });
  await assert.rejects(up.get('/missing'), (err) => err.status === 404);
  assert.equal(up.health().pausedForMs, 0);
});

test('rejects when the queue is full instead of growing without bound', async () => {
  const fetchImpl = fakeFetch(() => ({ body: {} }));
  const up = new Upstream({ base: 'https://up.test', fetchImpl, rps: 0.001, burst: 1, maxQueue: 1 });
  up.get('/1');
  up.get('/2').catch(() => {});
  await assert.rejects(up.get('/3'), (err) => err.status === 503);
  up.close();
});
