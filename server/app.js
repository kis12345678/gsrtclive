import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchRoute, RouteError } from './routes.js';
import { UpstreamError } from './upstream.js';

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

export function createHandler({ upstream, limiter }) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });

      if (url.pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, upstream: upstream.health() });
      }

      const ip = req.socket.remoteAddress || 'unknown';
      const retryAfter = limiter.allow(ip);
      if (retryAfter) {
        return sendJson(res, 429, { error: 'Too many requests' }, { 'retry-after': String(retryAfter) });
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
