import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchRoute, RouteError } from './routes.js';
import { UpstreamError } from './upstream.js';
import { normPlate } from './collector.js';

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

// Fixed-window per-client limiter, so one browser tab can't drain the shared
// upstream budget for everyone else.
export class ClientLimiter {
  constructor(perMinute, now = Date.now) {
    this.perMinute = perMinute;
    this.now = now;
    this.windows = new Map(); // ip -> { start, count }
  }

  allow(ip) {
    const t = this.now();
    let w = this.windows.get(ip);
    if (!w || t - w.start >= 60_000) {
      if (this.windows.size > 10_000) this.#sweep(t);
      w = { start: t, count: 0 };
      this.windows.set(ip, w);
    }
    w.count++;
    return w.count <= this.perMinute ? 0 : Math.ceil((w.start + 60_000 - t) / 1000);
  }

  #sweep(t) {
    for (const [ip, w] of this.windows) if (t - w.start >= 60_000) this.windows.delete(ip);
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

// Behind a reverse proxy or tunnel every request comes from the proxy's address, which
// would put all visitors in one rate-limit bucket. With trustProxy the real client is
// read from the proxy's headers; without it those headers are ignored (they are
// client-controlled and would let anyone dodge the limiter).
export function clientIp(req, trustProxy = false) {
  if (trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim().slice(0, 64);
    const xff = req.headers['x-forwarded-for'];
    // One trusted proxy hop: the proxy appends the address it saw, so take the last entry.
    if (xff) return String(xff).split(',').at(-1).trim().slice(0, 64);
  }
  return req.socket.remoteAddress || 'unknown';
}

export function createHandler({ upstream, limiter, collector = null, trustProxy = false }) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });

      if (url.pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          upstream: upstream.health(),
          ...(collector ? { collector: collector.status() } : {}),
        });
      }

      const ip = clientIp(req, trustProxy);
      const retryAfter = limiter.allow(ip);
      if (retryAfter) {
        return sendJson(res, 429, { error: 'Too many requests' }, { 'retry-after': String(retryAfter) });
      }

      if (collector && url.pathname.startsWith('/api/mundra/')) {
        return handleMundra(collector, url, res);
      }

      const match = matchRoute(url.pathname);
      if (!match) return sendJson(res, 404, { error: 'Not found' });

      try {
        const [path, query] = match.route.upstream(match.params, url.searchParams);
        const data = await upstream.get(path, query, { ttlMs: match.route.ttlMs });
        return sendJson(res, 200, data);
      } catch (err) {
        if (err instanceof RouteError || err instanceof UpstreamError) {
          return sendJson(res, err.status, { error: err.message });
        }
        console.error(err);
        return sendJson(res, 500, { error: 'Internal error' });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    return serveStatic(url.pathname, res);
  };
}

// Served from the collector's memory/disk: no upstream call per request.
async function handleMundra(collector, url, res) {
  const q = url.searchParams;
  try {
    switch (url.pathname) {
      case '/api/mundra/buses':
        return sendJson(res, 200, collector.snapshot({ corridorOnly: q.get('corridor') === '1', movingOnly: q.get('moving') === '1' }));
      case '/api/mundra/status':
        return sendJson(res, 200, collector.status());
      case '/api/mundra/history': {
        const plate = normPlate(q.get('plate'));
        if (!plate) return sendJson(res, 400, { error: 'Invalid plate' });
        const hours = Math.min(Math.max(Number(q.get('hours')) || 6, 1), 72);
        return sendJson(res, 200, { plate, hours, points: await collector.history(plate, hours) });
      }
      default:
        return sendJson(res, 404, { error: 'Not found' });
    }
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: 'Internal error' });
  }
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = normalize(join(WEB_ROOT, rel));
  if (!file.startsWith(WEB_ROOT.endsWith(sep) ? WEB_ROOT : WEB_ROOT + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}
