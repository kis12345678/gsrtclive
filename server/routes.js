// Our public API (/api/...) and how each route maps onto the upstream.
//
// The upstream paths below mirror the third-party proxy (docs/tracker-proxy-api.md)
// and are NOT yet verified against the infinium upstream. When mapping the real
// upstream from the APK, change only `upstream` (path + query) per route; the
// frontend depends on our paths, not the upstream's.
//
// `ttlMs` is how long a response is cached server-side. Live positions are
// cached briefly so many viewers of one bus cost one upstream call.

const SEC = 1000;
const MIN = 60 * SEC;

const PLATE = /^[A-Z0-9]{4,12}$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;

function pick(q, keys) {
  const out = {};
  for (const k of keys) if (q.has(k)) out[k] = q.get(k).slice(0, 100);
  return out;
}

function requireAll(q, keys) {
  for (const k of keys) if (!q.get(k)) throw new RouteError(`Missing query parameter: ${k}`);
}

function requireCoords(q, keys) {
  for (const k of keys) {
    const n = Number(q.get(k));
    if (!q.get(k) || !Number.isFinite(n)) throw new RouteError(`${k} must be a number`);
  }
}

export class RouteError extends Error {
  status = 400;
}

export const routes = [
  // ---- Live / tracking ----
  {
    path: /^\/api\/vehicle\/([^/]+)$/,
    ttlMs: 10 * SEC,
    upstream([plate], q) {
      plate = decodeURIComponent(plate).toUpperCase().replace(/[\s-]/g, '');
      if (!PLATE.test(plate)) throw new RouteError('Invalid plate');
      return [`/api/vehicle/${plate}`, pick(q, ['date', 'focus', 'tripId', 'start'])];
    },
  },
  {
    path: /^\/api\/live$/,
    ttlMs: 30 * SEC,
    upstream(_, q) {
      requireAll(q, ['from', 'to']);
      return ['/api/live', { ...pick(q, ['from', 'to', 'date']), limit: Math.min(Number(q.get('limit')) || 25, 25) }];
    },
  },
  {
    path: /^\/api\/nearby\/buses$/,
    ttlMs: 15 * SEC,
    upstream(_, q) {
      requireCoords(q, ['lat', 'lng']);
      return ['/api/nearby/buses', roundCoords(pick(q, ['lat', 'lng']), 3)];
    },
  },
  {
    path: /^\/api\/trip$/,
    ttlMs: 30 * SEC,
    upstream(_, q) {
      requireAll(q, ['tripId']);
      return ['/api/trip', pick(q, ['tripId', 'status', 'start'])];
    },
  },
  {
    path: /^\/api\/geometry$/,
    ttlMs: 30 * MIN,
    upstream(_, q) {
      requireAll(q, ['tripId']);
      return ['/api/geometry', pick(q, ['tripId', 'status', 'start'])];
    },
  },
  {
    path: /^\/api\/plates$/,
    ttlMs: 5 * MIN,
    upstream(_, q) {
      const term = (q.get('q') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (term.length < 3) throw new RouteError('Search needs at least 3 characters');
      return ['/api/plates', { q: term }];
    },
  },
  {
    path: /^\/api\/tripcode\/([^/]+)$/,
    ttlMs: 5 * MIN,
    upstream([code]) {
      code = decodeURIComponent(code);
      if (!ID.test(code)) throw new RouteError('Invalid trip code');
      return [`/api/tripcode/${code}`, {}];
    },
  },

  // ---- Timetable / stations ----
  {
    path: /^\/api\/timetable$/,
    ttlMs: 10 * MIN,
    upstream(_, q) {
      requireAll(q, ['from', 'to']);
      return ['/api/timetable', pick(q, ['from', 'to', 'date', 'type', 'page', 'pageSize'])];
    },
  },
  {
    path: /^\/api\/servicetypes$/,
    ttlMs: 24 * 60 * MIN,
    upstream: () => ['/api/servicetypes', {}],
  },
  {
    path: /^\/api\/nearby$/,
    ttlMs: 60 * MIN,
    upstream(_, q) {
      requireCoords(q, ['lat', 'lng']);
      // Rounding (~100 m) lets nearby users share a cache entry.
      return ['/api/nearby', roundCoords(pick(q, ['lat', 'lng']), 3)];
    },
  },
  {
    path: /^\/api\/stations\/([^/]+)$/,
    ttlMs: 60 * MIN,
    upstream([id]) {
      id = decodeURIComponent(id);
      if (!ID.test(id)) throw new RouteError('Invalid station id');
      return [`/api/stations/${id}`, {}];
    },
  },
  {
    path: /^\/api\/depot\/departures$/,
    ttlMs: 60 * SEC,
    upstream(_, q) {
      requireAll(q, ['depotId']);
      return ['/api/depot/departures', pick(q, ['depotId'])];
    },
  },

  // ---- PNR ----
  {
    path: /^\/api\/pnr\/([^/]+)$/,
    ttlMs: 60 * SEC,
    upstream([pnr]) {
      pnr = decodeURIComponent(pnr);
      if (!ID.test(pnr)) throw new RouteError('Invalid PNR');
      return [`/api/pnr/${pnr}`, {}];
    },
  },
];

function roundCoords(obj, digits) {
  const out = { ...obj };
  for (const k of ['lat', 'lng']) if (out[k] !== undefined) out[k] = Number(out[k]).toFixed(digits);
  return out;
}

export function matchRoute(pathname) {
  for (const route of routes) {
    const m = route.path.exec(pathname);
    if (m) return { route, params: m.slice(1) };
  }
  return null;
}
