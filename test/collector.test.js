import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collector, distToSegmentM, haversineM, istDay, normPlate, parseWindows } from '../server/collector.js';
import { UpstreamError } from '../server/upstream.js';
import { ClientLimiter, createHandler } from '../server/app.js';

const A = { id: '594', name: 'Bhuj', lat: 23.25017, lng: 69.6707 };
const B = { id: '1082', name: 'Mundra', lat: 22.83904, lng: 69.72438 };
const T0 = Date.parse('2026-09-29T02:00:00Z');
const silent = { error() {}, warn() {}, log() {} };

// Fake upstream: timetable rows and per-plate positions are set by each test.
function fake({ timetable = {}, vehicles = {} } = {}) {
  const calls = [];
  return {
    calls,
    timetable,
    vehicles,
    paused: 0,
    failNext: null,
    health() {
      return { pausedForMs: this.paused, queued: 0 };
    },
    async get(path, query) {
      calls.push({ path, query });
      if (this.failNext) {
        const e = this.failNext;
        this.failNext = null;
        throw e;
      }
      if (path === '/api/timetable') return this.timetable[`${query.from}>${query.to}`] ?? [];
      const plate = path.replace('/api/vehicle/', '');
      const v = this.vehicles[plate];
      return { vehicle: v ? { VehicleNo: plate, RouteName: 'Bhuj to Mundra', Latitude: String(v[0]), Longitude: String(v[1]), TripId: 7 } : null };
    },
  };
}

async function setup(upstream, extra = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'gsrtc-'));
  let now = T0;
  const c = new Collector({
    upstream, routeA: A, routeB: B, dataDir, now: () => now, log: silent, perTick: 50, ...extra,
  });
  return {
    c,
    dataDir,
    advance: (ms) => (now += ms),
    cleanup: async () => {
      await c.flush(); // let queued history writes land before deleting the directory
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('helpers: plate normalisation, IST day, distances', () => {
  assert.equal(normPlate('Gj-18-ZT 2141'), 'GJ18ZT2141');
  assert.equal(normPlate('x'), null);
  assert.equal(normPlate(undefined), null);
  assert.equal(istDay(Date.parse('2026-09-29T20:00:00Z')), '2026-09-30'); // 01:30 IST next day
  assert.ok(Math.abs(haversineM(A.lat, A.lng, B.lat, B.lng) - 46000) < 1500);
  assert.ok(distToSegmentM({ lat: 23.04, lng: 69.7 }, A, B) < 5000);
  assert.ok(distToSegmentM({ lat: 23.02, lng: 72.57 }, A, B) > 200000); // Ahmedabad
});

test('roster: both directions, normalised and de-duplicated, junk ignored', async () => {
  const up = fake({
    timetable: {
      '594>1082': [{ BusNo: 'Gj-18-ZT-2141' }, { BusNo: 'GJ-18-Z-4822' }, { BusNo: '' }, {}],
      '1082>594': [{ BusNo: 'GJ-18-ZT-2141' }, { BusNo: 'GJ-18-Z-3021' }],
    },
  });
  const { c, cleanup } = await setup(up);
  await c.refreshRoster();
  assert.deepEqual([...c.roster.keys()].sort(), ['GJ18Z3021', 'GJ18Z4822', 'GJ18ZT2141']);
  assert.equal(c.buses.size, 3);
  assert.deepEqual(up.calls.map((x) => `${x.query.from}>${x.query.to}`), ['594>1082', '1082>594']);
  assert.equal(up.calls[0].query.date, '2026-09-29');
  await cleanup();
});

test('roster: capped, and a failed refresh is retried after a minute', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ BusNo: `GJ18Z${1000 + i}` }));
  const up = fake({ timetable: { '594>1082': rows } });
  const { c, cleanup } = await setup(up, { maxPlates: 4 });
  await c.refreshRoster();
  assert.equal(c.roster.size, 4);

  const up2 = fake();
  const s2 = await setup(up2);
  up2.failNext = new UpstreamError('down', 503);
  const before = s2.c.stats.errors;
  await s2.c.refreshRoster(); // first direction fails, second returns []
  assert.equal(s2.c.stats.errors, before + 1);
  assert.equal(s2.c.stats.rosterRefreshes, 1); // second direction succeeded
  await cleanup();
  await s2.cleanup();
});

test('movement: first sample unknown, then moving vs parked from consecutive samples', async () => {
  const up = fake({ timetable: { '594>1082': [{ BusNo: 'GJ18Z1111' }, { BusNo: 'GJ18Z2222' }] } });
  up.vehicles.GJ18Z1111 = [22.95, 69.70];
  up.vehicles.GJ18Z2222 = [23.2, 69.66];
  const { c, advance, cleanup } = await setup(up);
  await c.refreshRoster();
  await c.tick();

  let snap = c.snapshot();
  assert.equal(snap.tracked, 2);
  assert.equal(snap.moving, 0); // can't tell yet
  assert.equal(snap.buses[0].speedKmh, null);
  assert.equal(c.buses.get('GJ18Z1111').nextPollAt, T0 + 30_000); // look again soon

  advance(30_000);
  up.vehicles.GJ18Z1111 = [22.94, 69.70]; // ~1.1 km south in 30 s ~ 130 km/h
  await c.tick();
  snap = c.snapshot();
  const mover = snap.buses.find((b) => b.plate === 'GJ18Z1111');
  const parked = snap.buses.find((b) => b.plate === 'GJ18Z2222');
  assert.equal(mover.moving, true);
  assert.ok(mover.speedKmh > 100 && mover.speedKmh < 150);
  assert.equal(mover.towards, 'Mundra');
  assert.equal(mover.inCorridor, true);
  assert.equal(parked.moving, false);
  assert.equal(snap.moving, 1);
  assert.equal(snap.buses[0].plate, 'GJ18Z1111'); // movers sort first

  // Moving buses are polled every 30 s, parked ones every 5 min.
  assert.equal(c.buses.get('GJ18Z1111').nextPollAt, T0 + 60_000);
  assert.equal(c.buses.get('GJ18Z2222').nextPollAt, T0 + 30_000 + 300_000);
  await cleanup();
});

test('GPS jitter is not movement, and direction flips when the bus turns round', async () => {
  const up = fake({ timetable: { '594>1082': [{ BusNo: 'GJ18Z3333' }] } });
  up.vehicles.GJ18Z3333 = [23.0, 69.7];
  const { c, advance, cleanup } = await setup(up);
  await c.refreshRoster();
  await c.tick();

  advance(30_000);
  up.vehicles.GJ18Z3333 = [23.00003, 69.70002]; // ~4 m
  await c.tick();
  assert.equal(c.snapshot().buses[0].moving, false);

  advance(300_000); // parked buses are only re-polled after the idle interval
  up.vehicles.GJ18Z3333 = [23.01, 69.7]; // north = away from Mundra, toward Bhuj
  await c.tick();
  assert.equal(c.snapshot().buses[0].moving, true);
  assert.equal(c.snapshot().buses[0].towards, 'Bhuj');
  await cleanup();
});

test('corridor filter hides buses far from the Bhuj-Mundra road', async () => {
  const up = fake({ timetable: { '594>1082': [{ BusNo: 'GJ18Z4444' }, { BusNo: 'GJ18Z5555' }] } });
  up.vehicles.GJ18Z4444 = [23.05, 69.7];
  up.vehicles.GJ18Z5555 = [23.02, 72.57];
  const { c, cleanup } = await setup(up);
  await c.refreshRoster();
  await c.tick();
  assert.equal(c.snapshot().buses.length, 2);
  assert.deepEqual(c.snapshot({ corridorOnly: true }).buses.map((b) => b.plate), ['GJ18Z4444']);
  await cleanup();
});

test('backs off while the upstream is paused, and survives upstream errors', async () => {
  const up = fake({ timetable: { '594>1082': [{ BusNo: 'GJ18Z6666' }] } });
  up.vehicles.GJ18Z6666 = [23.0, 69.7];
  const { c, cleanup } = await setup(up);
  await c.refreshRoster();
  const callsBefore = up.calls.length;

  up.paused = 5000;
  await c.tick();
  assert.equal(up.calls.length, callsBefore); // nothing sent
  assert.equal(c.stats.skippedBackoff, 1);

  up.paused = 0;
  up.failNext = new UpstreamError('Upstream responded 403', 502);
  await c.tick(); // must not throw
  assert.equal(c.stats.errors, 1);
  assert.match(c.stats.lastError, /403/);
  assert.equal(c.buses.get('GJ18Z6666').nextPollAt, T0 + 300_000); // pushed out, not hammered
  await cleanup();
});

test('never asks the upstream to focus/watch a plate', async () => {
  const up = fake({ timetable: { '594>1082': [{ BusNo: 'GJ18Z7777' }] } });
  up.vehicles.GJ18Z7777 = [23.0, 69.7];
  const { c, cleanup } = await setup(up);
  await c.refreshRoster();
  await c.tick();
  const vehicleCall = up.calls.find((x) => x.path.startsWith('/api/vehicle/'));
  assert.equal(vehicleCall.path, '/api/vehicle/GJ18Z7777');
  assert.deepEqual(vehicleCall.query, {});
  await cleanup();
});

test('history: written on change only, read back per plate, thinned, torn lines skipped', async () => {
  const up = fake({ timetable: { '594>1082': [{ BusNo: 'GJ18Z8888' }, { BusNo: 'GJ18Z9999' }] } });
  up.vehicles.GJ18Z8888 = [23.0, 69.7];
  up.vehicles.GJ18Z9999 = [23.1, 69.7];
  const { c, dataDir, advance, cleanup } = await setup(up);
  await c.refreshRoster();
  await c.tick(); // both logged (first sample)
  advance(30_000);
  up.vehicles.GJ18Z8888 = [22.99, 69.7]; // moved
  await c.tick(); // 8888 logged; 9999 unchanged and not yet due
  advance(30_000);
  up.vehicles.GJ18Z8888 = [22.98, 69.7];
  await c.tick();
  await c.flush();

  const file = join(dataDir, 'positions-2026-09-29.jsonl');
  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 4); // 2 first samples + 2 moves, parked bus not repeated

  await writeFile(file, (await readFile(file, 'utf8')) + '{"t":1,"p":"GJ18Z88'); // simulated crash mid-write
  const pts = await c.history('GJ18Z8888', 6);
  assert.equal(pts.length, 3);
  assert.ok(pts[0].t <= pts[1].t && pts[1].t <= pts[2].t);
  assert.equal(pts[2].lat, 22.98);
  assert.equal((await c.history('GJ18Z9999', 6)).length, 1);
  assert.equal((await c.history('GJ18Z8888', 6, 2)).length, 2); // thinned, keeps the latest
  assert.equal((await c.history('GJ18Z8888', 6, 2)).at(-1).lat, 22.98);
  await cleanup();
});

test('prune removes only history older than the retention window', async () => {
  const { c, dataDir, cleanup } = await setup(fake(), { retentionDays: 30 });
  for (const d of ['2026-07-01', '2026-08-29', '2026-08-30', '2026-09-28', '2026-09-29']) {
    await writeFile(join(dataDir, `positions-${d}.jsonl`), '');
  }
  await writeFile(join(dataDir, 'notes.txt'), 'keep me');
  await c.prune();
  assert.deepEqual((await readdir(dataDir)).sort(), ['notes.txt', 'positions-2026-08-30.jsonl', 'positions-2026-09-28.jsonl', 'positions-2026-09-29.jsonl']);
  await cleanup();
});

test('HTTP: /api/mundra/* served from the collector, with validation', async () => {
  const up = fake({ timetable: { '594>1082': [{ BusNo: 'GJ18Z4444' }, { BusNo: 'GJ18Z5555' }] } });
  up.vehicles.GJ18Z4444 = [23.05, 69.7];
  up.vehicles.GJ18Z5555 = [23.02, 72.57];
  const { c, cleanup } = await setup(up);
  await c.refreshRoster();
  await c.tick();
  await c.flush();

  const server = createServer(createHandler({ upstream: up, limiter: new ClientLimiter(1000), collector: c }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const callsBefore = up.calls.length;
  try {
    const all = await (await fetch(`${base}/api/mundra/buses`)).json();
    assert.equal(all.buses.length, 2);
    const corridor = await (await fetch(`${base}/api/mundra/buses?corridor=1`)).json();
    assert.deepEqual(corridor.buses.map((b) => b.plate), ['GJ18Z4444']);

    const hist = await (await fetch(`${base}/api/mundra/history?plate=gj-18-z-4444&hours=6`)).json();
    assert.equal(hist.plate, 'GJ18Z4444');
    assert.equal(hist.points.length, 1);
    assert.equal((await fetch(`${base}/api/mundra/history?plate=..%2F..`)).status, 400);
    assert.equal((await fetch(`${base}/api/mundra/history`)).status, 400);

    const status = await (await fetch(`${base}/api/mundra/status`)).json();
    assert.equal(status.roster, 2);
    assert.equal(status.polls, 2);
    assert.equal((await fetch(`${base}/api/mundra/nope`)).status, 404);

    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.collector.roster, 2);
    assert.equal(up.calls.length, callsBefore, 'serving the browser must not hit the upstream');
  } finally {
    server.close();
    await cleanup();
  }
});

test('fixed mode (TRACK_PLATES): only the listed buses, no timetable queries', async () => {
  const up = fake({ timetable: { '594>1082': [{ BusNo: 'GJ18Z9999' }] } }); // must be ignored
  up.vehicles.GJ18Z3021 = [23.2, 69.66];
  up.vehicles.GJ18ZT2141 = [23.1, 69.7];
  up.vehicles.GJ18Z9999 = [23.0, 69.7];
  const { c, cleanup } = await setup(up, { plates: ['GJ-18-Z-3021', 'gj18zt2141', 'GJ18Z3021', 'bad!', ''] });

  await c.refreshRoster();
  await c.tick();
  assert.deepEqual([...c.roster.keys()].sort(), ['GJ18Z3021', 'GJ18ZT2141']); // normalised, de-duplicated
  assert.equal(up.calls.filter((x) => x.path === '/api/timetable').length, 0);
  assert.deepEqual(up.calls.map((x) => x.path).sort(), ['/api/vehicle/GJ18Z3021', '/api/vehicle/GJ18ZT2141']);
  assert.equal(c.status().mode, 'fixed');
  assert.equal(c.snapshot().tracked, 2);
  await cleanup();
});

test('fixed mode: fails loudly when no plate is valid, and the cap still applies', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gsrtc-'));
  const mk = (plates, extra = {}) => new Collector({ upstream: fake(), routeA: A, routeB: B, dataDir, log: silent, plates, ...extra });
  assert.throws(() => mk(['x', '!!']), /no valid bus numbers/);
  const capped = mk(['GJ18Z1001', 'GJ18Z1002', 'GJ18Z1003'], { maxPlates: 2 });
  await capped.refreshRoster();
  assert.deepEqual([...capped.roster.keys()], ['GJ18Z1001', 'GJ18Z1002']); // first two, in the order given
  assert.equal(mk([]).status().mode, 'timetable');
  await rm(dataDir, { recursive: true, force: true });
});

// IST wall-clock time on 2026-09-29 as a timestamp (07:30 IST = 02:00Z = T0).
const ist = (h, m = 0) => Date.parse('2026-09-29T00:00:00Z') + (h * 60 + m) * 60_000 - 330 * 60_000;

test('parseWindows: ranges, wrap-around and bad input', () => {
  assert.deepEqual(parseWindows(''), []);
  assert.deepEqual(parseWindows(' 06:00-10:30 , 6:00 - 20:30 '), [
    { start: 360, end: 630, label: '06:00-10:30' },
    { start: 360, end: 1230, label: '06:00-20:30' },
  ]);
  assert.equal(parseWindows('22:00-02:00')[0].end, 120);
  assert.equal(parseWindows('00:00-24:00')[0].end, 1440);
  for (const bad of ['6-10', '10:00', '25:00-26:00', '10:60-11:00', '10:00-10:00', '24:00-01:00', 'morning']) {
    assert.throws(() => parseWindows(bad), /ACTIVE_WINDOWS/, bad);
  }
});

test('active hours: inside/outside, wrap past midnight, next start', async () => {
  const { c, cleanup } = await setup(fake(), { windows: '06:00-10:30, 16:00-20:30' });
  for (const [h, m, want] of [[6, 0, true], [10, 29, true], [10, 30, false], [12, 0, false], [16, 0, true], [20, 30, false], [3, 0, false]]) {
    assert.equal(c.isActive(ist(h, m)), want, `${h}:${m}`);
  }
  assert.equal(c.nextWindowStart(ist(12, 0)), '16:00');
  assert.equal(c.nextWindowStart(ist(21, 0)), '06:00'); // wraps to tomorrow morning
  assert.equal(c.nextWindowStart(ist(3, 0)), '06:00');
  assert.equal(c.nextWindowStart(ist(8, 0)), null); // already active
  await cleanup();

  const night = await setup(fake(), { windows: '22:00-02:00' });
  for (const [h, want] of [[23, true], [1, true], [2, false], [12, false]]) assert.equal(night.c.isActive(ist(h)), want, `night ${h}`);
  await night.cleanup();

  const always = await setup(fake());
  assert.equal(always.c.isActive(ist(3)), true);
  assert.equal(always.c.nextWindowStart(ist(3)), null);
  await always.cleanup();
});

test('outside the active hours nothing is sent to the upstream', async () => {
  const up = fake();
  up.vehicles.GJ18Z1111 = [23.0, 69.7];
  const { c, advance, cleanup } = await setup(up, { plates: ['GJ18Z1111'], windows: '16:00-20:30' }); // T0 = 07:30 IST
  await c.tick();
  await c.tick();
  assert.equal(up.calls.length, 0);
  assert.equal(c.stats.pausedTicks, 2);
  const st = c.status();
  assert.deepEqual([st.active, st.windows, st.nextWindowStart], [false, '16:00-20:30', '16:00']);
  assert.equal(c.snapshot().active, false);

  advance(9 * 3600_000); // 16:30 IST
  await c.tick();
  assert.equal(up.calls.length, 1);
  assert.equal(c.status().active, true);
  await cleanup();
});

test('a reopened window is not compared with hours-old positions', async () => {
  const up = fake();
  up.vehicles.GJ18Z1111 = [23.0, 69.7];
  const { c, advance, dataDir, cleanup } = await setup(up, { plates: ['GJ18Z1111'], windows: '06:00-10:30' }); // T0 = 07:30 IST
  await c.tick();
  advance(30_000);
  up.vehicles.GJ18Z1111 = [22.99, 69.7];
  await c.tick();
  assert.equal(c.snapshot().buses[0].moving, true);

  advance(3.5 * 3600_000); // 11:00 IST: window closed
  await c.tick();
  const paused = c.snapshot();
  assert.equal(paused.active, false);
  assert.equal(paused.moving, 0);
  assert.equal(paused.buses[0].moving, false); // last position only, not "moving"
  assert.equal(paused.buses[0].speedKmh, null);

  advance(20.5 * 3600_000 - 30_000); // next morning, 07:29:30 IST
  up.vehicles.GJ18Z1111 = [23.2, 69.7]; // 20+ km away from where it was last seen
  await c.tick();
  const bus = c.snapshot().buses[0];
  assert.equal(bus.moving, false); // would be a ~700 km/h "speed" if compared with yesterday
  assert.equal(bus.speedKmh, null);
  assert.equal(c.buses.get('GJ18Z1111').nextPollAt, c.now() + 30_000); // look again soon
  await c.flush();
  const rows = (await readFile(join(dataDir, 'positions-2026-09-30.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(rows.length, 1); // the fresh first sample of the new day is logged
  await cleanup();
});
