import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { Upstream } from './upstream.js';
import { ClientLimiter, createHandler } from './app.js';

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

const server = createServer(createHandler({ upstream, limiter: new ClientLimiter(config.clientRpm) }));

server.listen(config.port, () => {
  console.log(`gsrtclive listening on http://localhost:${config.port} (upstream ${config.upstreamBase})`);
});
