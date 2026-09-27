function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n;
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
  };
}
