import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { Upstream } from './upstream.js';
import { ClientLimiter, createHandler } from './app.js';
import { Collector } from './collector.js';

try {
  process.loadEnvFile?.();
} catch {
  // No .env file: rely on the real environment.
}

const config = loadConfig();

const upstream = new Upstream({
  base: config.upstreamBase,
  deviceId: config.deviceId,
  rps: config.upstreamRps,
  burst: config.upstreamBurst,
});

const collector = config.collector.enabled ? new Collector({ upstream, ...config.collector }) : null;

const handler = createHandler({
  upstream,
  limiter: new ClientLimiter(config.clientRpm),
  collector,
  trustProxy: config.trustProxy,
});
const server = createServer(handler);

server.listen(config.port, () => {
  console.log(`gsrtclive listening on http://localhost:${config.port} (upstream ${config.upstreamBase})`);
  if (collector) {
    const { routeA, routeB } = config.collector;
    const which = config.collector.plates.length ? `${config.collector.plates.length} fixed buses (TRACK_PLATES)` : 'buses from the timetable';
    console.log(`collector on: ${routeA.name} <-> ${routeB.name}, ${which}, history in ${config.collector.dataDir}/`);
  } else {
    console.log('collector off (set COLLECTOR=on for 24x7 route tracking, see README)');
  }
});

collector?.start().catch((err) => {
  console.error('collector failed to start:', err.message);
});

// Let systemd/docker stop us cleanly so queued history lines reach the disk.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    collector?.stop();
    upstream.close();
    server.close();
    await collector?.flush();
    process.exit(0);
  });
}
