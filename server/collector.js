// 24x7 collector for one route (default: Bhuj <-> Mundra).
//
// It keeps a roster of the buses the timetable says run the route (both
// directions), polls each bus through the shared, rate-limited Upstream client,
// derives movement itself (the upstream almost never reports a usable speed),
// and appends a position history to disk. The browser only ever talks to our
// own /api/mundra/* endpoints, which are served from memory.
//
// Polite by design: idle buses are polled rarely, everything shares the
// Upstream token bucket, nothing is polled while the upstream is backing off,
// and it never asks the third-party proxy to "focus"/watch a plate.

import { appendFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const PLATE = /^[A-Z0-9]{4,12}$/;
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const FILE_RE = /^positions-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function normPlate(raw) {
  const p = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return PLATE.test(p) ? p : null;
}

export function istDay(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function haversineM(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

// Distance from a point to the straight segment a-b (local flat projection,
// fine at this scale). Used to tell "on the Bhuj-Mundra corridor" from "elsewhere".
export function distToSegmentM(p, a, b) {
  const k = Math.cos(a.lat * (Math.PI / 180));
  const px = (p.lng - a.lng) * k * 111320;
  const py = (p.lat - a.lat) * 110540;
  const bx = (b.lng - a.lng) * k * 111320;
  const by = (b.lat - a.lat) * 110540;
  const len2 = bx * bx + by * by;
  const t = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
  return Math.hypot(px - t * bx, py - t * by);
}

export class Collector {
  constructor({
    upstream,
    routeA,
    routeB,
    plates = [],
    dataDir = 'data',
    pollActiveMs = 30_000,
    pollIdleMs = 5 * 60_000,
    rosterRefreshMs = 30 * 60_000,
    rosterKeepMs = 3 * DAY_MS,
    retentionDays = 30,
    maxPlates = 30,
    corridorKm = 20,
    heartbeatMs = 10 * 60_000,
    tickMs = 5_000,
    perTick = 2,
    now = Date.now,
    log = console,
  }) {
    Object.assign(this, {
      upstream, routeA, routeB, dataDir, pollActiveMs, pollIdleMs, rosterRefreshMs, rosterKeepMs,
      retentionDays, maxPlates, corridorKm, heartbeatMs, tickMs, perTick, now, log,
    });
    // Fixed mode: track exactly these buses and never ask the timetable who runs the route.
    const wanted = [...new Set(plates.map(normPlate).filter(Boolean))];
    if (plates.length && !wanted.length) throw new Error('TRACK_PLATES contains no valid bus numbers');
    if (wanted.length < plates.length) {
      log.warn?.(`TRACK_PLATES: ignored ${plates.length - wanted.length} invalid or duplicate entries`);
    }
    if (wanted.length > maxPlates) log.warn?.(`TRACK_PLATES: only the first ${maxPlates} of ${wanted.length} buses are tracked (MAX_PLATES)`);
    this.fixed = wanted.slice(0, maxPlates);

    this.roster = new Map(); // plate -> last time the timetable listed it
    this.buses = new Map(); // plate -> live state
    this.rosterAt = 0;
    this.busy = false;
    this.timer = null;
    this.writeChain = Promise.resolve();
    this.writeFailed = false;
    this.stats = {
      startedAt: now(), polls: 0, errors: 0, skippedBackoff: 0, rosterRefreshes: 0,
      lastPollAt: 0, lastError: '', historyWrites: 0,
    };
  }

  async start() {
    await mkdir(this.dataDir, { recursive: true });
    await this.prune().catch((e) => this.log.error('prune failed:', e.message));
    this.timer = setInterval(() => this.tick().catch((e) => this.log.error('tick failed:', e.message)), this.tickMs);
    this.tick().catch((e) => this.log.error('tick failed:', e.message));
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // Resolves once queued history writes have hit the disk.
  flush() {
    return this.writeChain;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const h = this.upstream.health();
      if (h.pausedForMs > 0 || h.queued > 5) {
        this.stats.skippedBackoff++;
        return;
      }
      const t = this.now();
      if (t - this.rosterAt >= this.rosterRefreshMs) await this.refreshRoster();
      const due = [...this.buses.values()]
        .filter((b) => b.nextPollAt <= t)
        .sort((a, b) => a.nextPollAt - b.nextPollAt)
        .slice(0, this.perTick);
      for (const b of due) await this.poll(b.plate);
    } finally {
      this.busy = false;
    }
  }

  // ---- roster ----

  async refreshRoster() {
    const t = this.now();
    if (this.fixed.length) {
      for (const plate of this.fixed) this.roster.set(plate, t);
      this.rosterAt = t;
      this.#syncBuses();
      return;
    }
    const day = istDay(t);
    let ok = 0;
    for (const [from, to] of [[this.routeA.id, this.routeB.id], [this.routeB.id, this.routeA.id]]) {
      try {
        const rows = await this.upstream.get('/api/timetable', {
          from, to, date: day, type: 0, page: 1, pageSize: 100, combine: 1,
        });
        for (const row of Array.isArray(rows) ? rows : []) {
          const plate = normPlate(row?.BusNo);
          if (plate) this.roster.set(plate, t);
        }
        ok++;
      } catch (err) {
        this.#fail(err);
      }
    }
    // A failed refresh is retried in a minute rather than after the full interval.
    this.rosterAt = ok ? t : t - this.rosterRefreshMs + 60_000;
    if (ok) this.stats.rosterRefreshes++;

    for (const [plate, seen] of this.roster) if (t - seen > this.rosterKeepMs) this.roster.delete(plate);
    // Hard cap: keep the most recently listed plates.
    if (this.roster.size > this.maxPlates) {
      const keep = [...this.roster].sort((a, b) => b[1] - a[1]).slice(0, this.maxPlates);
      this.log.warn?.(`roster capped at ${this.maxPlates} buses (timetable listed ${this.roster.size})`);
      this.roster = new Map(keep);
    }
    this.#syncBuses();
  }

  #syncBuses() {
    for (const plate of this.roster.keys()) {
      if (!this.buses.has(plate)) this.buses.set(plate, { plate, nextPollAt: 0, hasData: false });
    }
    for (const plate of this.buses.keys()) if (!this.roster.has(plate)) this.buses.delete(plate);
  }

  // ---- polling ----

  async poll(plate) {
    const bus = this.buses.get(plate);
    if (!bus) return;
    let data;
    try {
      // No `focus`: we keep our own history and must not ask the third party to watch plates.
      data = await this.upstream.get(`/api/vehicle/${plate}`, {}, { ttlMs: 0 });
    } catch (err) {
      bus.nextPollAt = this.now() + this.pollIdleMs;
      this.#fail(err);
      return;
    }
    const t = this.now();
    this.stats.polls++;
    this.stats.lastPollAt = t;

    const v = data?.vehicle;
    const lat = Number(v?.Latitude);
    const lng = Number(v?.Longitude);
    if (!v || !Number.isFinite(lat) || !Number.isFinite(lng) || (!lat && !lng)) {
      bus.hasData = false;
      bus.nextPollAt = t + this.pollIdleMs;
      return;
    }

    const prev = bus.hasData ? { lat: bus.lat, lng: bus.lng, at: bus.seenAt } : null;
    const movedM = prev ? haversineM(prev.lat, prev.lng, lat, lng) : 0;
    const dtS = prev ? (t - prev.at) / 1000 : 0;
    const speedKmh = prev && dtS >= 5 ? (movedM / dtS) * 3.6 : null;
    const moving = speedKmh !== null && speedKmh >= 3 && movedM >= 15;

    const pos = { lat, lng };
    const distBhujM = haversineM(lat, lng, this.routeA.lat, this.routeA.lng);
    const distMundraM = haversineM(lat, lng, this.routeB.lat, this.routeB.lng);
    const inCorridor = distToSegmentM(pos, this.routeA, this.routeB) <= this.corridorKm * 1000;

    let towards = null;
    if (moving && inCorridor && prev) {
      const before = haversineM(prev.lat, prev.lng, this.routeB.lat, this.routeB.lng);
      if (Math.abs(before - distMundraM) >= 15) towards = distMundraM < before ? this.routeB.name : this.routeA.name;
    }

    const first = !bus.hasData;
    Object.assign(bus, {
      hasData: true, lat, lng, seenAt: t, moving, speedKmh: speedKmh === null ? null : Math.round(speedKmh * 10) / 10,
      distBhujM, distMundraM, inCorridor, towards,
      label: v.RouteName || '', lastStop: v.LastBusStation || '', nextStop: v.NextLocation || '',
      location: v.CurrentLocationName || '', tripId: v.TripId ? String(v.TripId) : '',
    });
    if (first || movedM >= 5) bus.changedAt = t;

    if (first || movedM >= 15 || t - (bus.loggedAt || 0) >= this.heartbeatMs) {
      bus.loggedAt = t;
      this.#record({
        t, p: plate, lat: +lat.toFixed(6), lng: +lng.toFixed(6),
        s: bus.speedKmh, m: moving ? 1 : 0, trip: bus.tripId || undefined,
      });
    }
    // The first sample can't tell moving from parked, so look again soon.
    bus.nextPollAt = t + (first || moving ? this.pollActiveMs : this.pollIdleMs);
  }

  #fail(err) {
    this.stats.errors++;
    this.stats.lastError = `${new Date(this.now()).toISOString()} ${err.message}`;
  }

  // ---- reading ----

  snapshot({ corridorOnly = false, movingOnly = false } = {}) {
    const t = this.now();
    const all = [...this.buses.values()].filter((b) => b.hasData);
    const buses = all
      .filter((b) => (!corridorOnly || b.inCorridor) && (!movingOnly || b.moving))
      .map((b) => ({
        plate: b.plate,
        lat: b.lat,
        lng: b.lng,
        moving: b.moving,
        speedKmh: b.speedKmh,
        stillForMin: b.moving ? 0 : Math.floor((t - (b.changedAt ?? b.seenAt)) / 60_000),
        distBhujKm: Math.round(b.distBhujM / 100) / 10,
        distMundraKm: Math.round(b.distMundraM / 100) / 10,
        inCorridor: b.inCorridor,
        towards: b.towards,
        label: b.label,
        lastStop: b.lastStop,
        nextStop: b.nextStop,
        location: b.location,
        tripId: b.tripId,
        ageSec: Math.round((t - b.seenAt) / 1000),
      }))
      .sort((a, b) => Number(b.moving) - Number(a.moving) || a.distMundraKm - b.distMundraKm);
    return {
      updatedAt: t,
      tracked: this.buses.size,
      withData: all.length,
      moving: all.filter((b) => b.moving).length,
      buses,
    };
  }

  status() {
    const t = this.now();
    const h = this.upstream.health();
    return {
      running: Boolean(this.timer),
      route: `${this.routeA.name} <-> ${this.routeB.name}`,
      mode: this.fixed.length ? 'fixed' : 'timetable',
      uptimeSec: Math.round((t - this.stats.startedAt) / 1000),
      roster: this.roster.size,
      rosterAgeSec: this.rosterAt ? Math.round((t - this.rosterAt) / 1000) : null,
      ...this.stats,
      lastPollAgeSec: this.stats.lastPollAt ? Math.round((t - this.stats.lastPollAt) / 1000) : null,
      upstreamPausedForMs: h.pausedForMs,
    };
  }

  // Positions for one bus, oldest first, thinned to at most `maxPoints`.
  async history(plate, hours = 6, maxPoints = 1500) {
    const t = this.now();
    const since = t - hours * 3600 * 1000;
    const days = [];
    for (let d = istDay(since); d <= istDay(t); d = istDay(Date.parse(`${d}T00:00:00Z`) + DAY_MS)) {
      days.push(d);
    }
    const points = [];
    for (const day of days) {
      let text;
      try {
        text = await readFile(join(this.dataDir, `positions-${day}.jsonl`), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          if (r.p === plate && r.t >= since) points.push({ t: r.t, lat: r.lat, lng: r.lng, speedKmh: r.s, moving: r.m === 1 });
        } catch {
          // A torn last line after a crash is skipped.
        }
      }
    }
    points.sort((a, b) => a.t - b.t);
    if (points.length <= maxPoints) return points;
    const step = points.length / maxPoints;
    const thinned = Array.from({ length: maxPoints - 1 }, (_, i) => points[Math.floor(i * step)]);
    thinned.push(points.at(-1));
    return thinned;
  }

  // ---- storage ----

  #record(row) {
    const file = join(this.dataDir, `positions-${istDay(row.t)}.jsonl`);
    this.writeChain = this.writeChain
      .then(() => appendFile(file, JSON.stringify(row) + '\n'))
      .then(() => {
        this.stats.historyWrites++;
      })
      .catch((err) => {
        if (!this.writeFailed) this.log.error('history write failed (will keep trying):', err.message);
        this.writeFailed = true;
      });
  }

  async prune() {
    const cutoff = istDay(this.now() - this.retentionDays * DAY_MS);
    for (const name of await readdir(this.dataDir)) {
      const m = FILE_RE.exec(name);
      if (m && m[1] < cutoff) await unlink(join(this.dataDir, name));
    }
  }
}
