function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n;
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function route(prefix, defaults) {
  return {
    id: str(`${prefix}_ID`, defaults.id),
    name: str(`${prefix}_NAME`, defaults.name),
    lat: num(`${prefix}_LAT`, defaults.lat),
    lng: num(`${prefix}_LNG`, defaults.lng),
  };
}

export function loadConfig() {
  const upstreamBase = (process.env.UPSTREAM_BASE || '').replace(/\/+$/, '');
  if (!upstreamBase) throw new Error('UPSTREAM_BASE is required (see .env.example)');
  return {
    port: num('PORT', 8080),
    upstreamBase,
    deviceId: process.env.UPSTREAM_DEVICE_ID || '',
    upstreamRps: num('UPSTREAM_RPS', 2),
    upstreamBurst: num('UPSTREAM_BURST', 4),
    clientRpm: num('CLIENT_RPM', 60),
    trustProxy: ['on', '1', 'true', 'yes'].includes(str('TRUST_PROXY', 'off').toLowerCase()),
    collector: {
      enabled: ['on', '1', 'true', 'yes'].includes(str('COLLECTOR', 'off').toLowerCase()),
      routeA: route('ROUTE_A', { id: '594', name: 'Bhuj', lat: 23.25017, lng: 69.6707 }),
      routeB: route('ROUTE_B', { id: '1082', name: 'Mundra', lat: 22.83904, lng: 69.72438 }),
      dataDir: str('DATA_DIR', 'data'),
      pollActiveMs: num('POLL_ACTIVE_MS', 30_000),
      pollIdleMs: num('POLL_IDLE_MS', 5 * 60_000),
      rosterRefreshMs: num('ROSTER_REFRESH_MS', 30 * 60_000),
      retentionDays: num('RETENTION_DAYS', 30),
      maxPlates: num('MAX_PLATES', 30),
      corridorKm: num('CORRIDOR_KM', 20),
    },
  };
}
