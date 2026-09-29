// Our public API (/api/...) and how each route maps onto the upstream.
//
// The upstream paths below mirror the third-party proxy (docs/tracker-proxy-api.md),
// which is the configured upstream for now (see .env.example) and was smoke-tested
// against https://tracker.shivrajsinh.in. They are NOT verified against the official
// infinium upstream. When mapping the real upstream from the APK, change only
// `upstream` (path + query) per route; the frontend depends on our paths, not the
// upstream's.
//
// `ttlMs` is how long a response is cached server-side. Live positions are
// cached briefly so many viewers of one bus cost one upstream call.

const SEC = 1000;
const MIN = 60 * SEC;

const PLATE = /^[A-Z0-9]{4,12}$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
// Station search text ("Bhuj", "Mundra port", "Toda(Mundra)"), Gujarati letters allowed.
const STATION_Q = /^[\p{L}\p{N} ()._-]{2,40}$/u;

// decodeURIComponent throws on malformed input; turn that into a 400, not a 500.
function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new RouteError('Bad URL encoding');
  }
}

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
      plate = decode(plate).toUpperCase().replace(/[\s-]/g, '');
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
      const query = roundCoords(pick(q, ['lat', 'lng']), 3);
      const radius = Number(q.get('radius'));
      if (Number.isFinite(radius) && radius > 0) query.radius = Math.min(radius, 50);
      return ['/api/nearby/buses', query];
    },
  },
  {
    path: /^\/api\/trip$/,
    ttlMs: 30 * SEC,
    upstream(_, q) {
      requireAll(q, ['tripId']);
      return ['/api/trip', pick(q, ['tripId', 'status', 'start', 'plate', 'route'])];
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
      code = decode(code);
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
      return ['/api/timetable', pick(q, ['from', 'to', 'date', 'type', 'page', 'pageSize', 'fromName', 'toName', 'combine'])];
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
    // Upstream treats the last segment as a search term (name), not an id.
    upstream([term]) {
      term = decode(term).trim();
      if (!STATION_Q.test(term)) throw new RouteError('Invalid station search');
      return [`/api/stations/${encodeURIComponent(term)}`, {}];
    },
  },
  {
    path: /^\/api\/depot\/departures$/,
    ttlMs: 60 * SEC,
    upstream(_, q) {
      requireAll(q, ['depotId']);
      return ['/api/depot/departures', pick(q, ['depotId', 'date', 'page', 'pageSize'])];
    },
  },

  // ---- Map / ETA / stops ----
  {
    path: /^\/api\/geometry\/eta$/,
    ttlMs: 5 * MIN,
    upstream(_, q) {
      requireCoords(q, ['fromLat', 'fromLng', 'toLat', 'toLng']);
      const out = {};
      for (const k of ['fromLat', 'fromLng', 'toLat', 'toLng']) out[k] = Number(q.get(k)).toFixed(4);
      return ['/api/geometry/eta', out];
    },
  },
  {
    path: /^\/api\/eta\/segments$/,
    ttlMs: 10 * MIN,
    upstream(_, q) {
      requireAll(q, ['route']);
      if (!ID.test(q.get('route'))) throw new RouteError('Invalid route');
      return ['/api/eta/segments', { route: q.get('route') }];
    },
  },
  {
    path: /^\/api\/crowd$/,
    ttlMs: 30 * SEC,
    upstream(_, q) {
      const plates = (q.get('plates') || '')
        .split(',')
        .map((p) => p.toUpperCase().replace(/[\s-]/g, ''))
        .filter(Boolean);
      if (!plates.length || plates.length > 10 || !plates.every((p) => PLATE.test(p))) {
        throw new RouteError('plates must be 1-10 valid bus numbers, comma separated');
      }
      return ['/api/crowd', { plates: [...new Set(plates)].sort().join(',') }];
    },
  },
  {
    path: /^\/api\/stops$/,
    ttlMs: 60 * MIN,
    upstream(_, q) {
      if (q.has('ids')) {
        const ids = q.get('ids').split(',').map((s) => s.trim()).filter(Boolean);
        if (!ids.length || ids.length > 50 || !ids.every((i) => ID.test(i))) throw new RouteError('Invalid ids');
        return ['/api/stops', { ids: ids.join(',') }];
      }
      requireCoords(q, ['south', 'west', 'north', 'east']);
      const [south, west, north, east] = ['south', 'west', 'north', 'east'].map((k) => Number(q.get(k)));
      if (north <= south || east <= west) throw new RouteError('Invalid bounding box');
      if (north - south > 2 || east - west > 2) throw new RouteError('Area too large (max 2 degrees)');
      // Snap outwards to a ~1 km grid so nearby map views share a cache entry.
      const f = (n, fn) => (fn(n * 100) / 100).toFixed(2);
      return ['/api/stops', { south: f(south, Math.floor), west: f(west, Math.floor), north: f(north, Math.ceil), east: f(east, Math.ceil) }];
    },
  },
  {
    path: /^\/api\/station\/parent$/,
    ttlMs: 60 * MIN,
    upstream(_, q) {
      if (!q.get('id') && !q.get('name')) throw new RouteError('Missing query parameter: id or name');
      if (q.get('id') && !ID.test(q.get('id'))) throw new RouteError('Invalid station id');
      return ['/api/station/parent', pick(q, ['id', 'name', 'exclude'])];
    },
  },

  // ---- PNR ----
  {
    path: /^\/api\/pnr\/([^/]+)$/,
    ttlMs: 60 * SEC,
    upstream([pnr]) {
      pnr = decode(pnr);
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
