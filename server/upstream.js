// Polite client for the upstream tracking API.
//
// Every outbound request goes through one token bucket, identical requests are
// coalesced and cached, and any 403/429/5xx pauses *all* traffic with
// exponential backoff so we never hammer the upstream after it pushes back.

export class UpstreamError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class Upstream {
  constructor({
    base,
    deviceId = '',
    rps = 2,
    burst = 4,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    timeoutMs = 10_000,
    maxQueue = 100,
    maxCacheEntries = 2_000,
    minBackoffMs = 5_000,
    maxBackoffMs = 5 * 60_000,
  }) {
    this.base = base;
    this.deviceId = deviceId;
    this.rps = rps;
    this.burst = burst;
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.maxQueue = maxQueue;
    this.maxCacheEntries = maxCacheEntries;
    this.minBackoffMs = minBackoffMs;
    this.maxBackoffMs = maxBackoffMs;

    this.tokens = burst;
    this.lastRefill = now();
    this.queue = [];
    this.timer = null;

    this.cache = new Map(); // url -> { expires, value }
    this.inflight = new Map(); // url -> Promise

    this.pausedUntil = 0;
    this.backoffMs = 0;
    this.stats = { requests: 0, cacheHits: 0, coalesced: 0, errors: 0, rejected: 0 };
  }

  url(path, query = {}) {
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  // GET JSON with caching (ttlMs > 0) and request coalescing.
  async get(path, query = {}, { ttlMs = 0 } = {}) {
    const url = this.url(path, query);

    const hit = this.cache.get(url);
    if (hit && hit.expires > this.now()) {
      this.stats.cacheHits++;
      return hit.value;
    }

    const pending = this.inflight.get(url);
    if (pending) {
      this.stats.coalesced++;
      return pending;
    }

    const p = this.#schedule(() => this.#fetchJson(url))
      .then((value) => {
        if (ttlMs > 0) this.#remember(url, value, ttlMs);
        return value;
      })
      .finally(() => this.inflight.delete(url));
    this.inflight.set(url, p);
    return p;
  }

  health() {
    const now = this.now();
    return {
      queued: this.queue.length,
      cached: this.cache.size,
      pausedForMs: Math.max(0, this.pausedUntil - now),
      ...this.stats,
    };
  }

  // Stop scheduling and fail anything still queued (shutdown, tests).
  close() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const { reject } of this.queue.splice(0)) reject(new UpstreamError('Upstream client closed', 503));
  }

  #remember(url, value, ttlMs) {
    if (this.cache.size >= this.maxCacheEntries) {
      // Map keeps insertion order: drop the oldest entry.
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(url, { expires: this.now() + ttlMs, value });
  }

  #schedule(task) {
    if (this.queue.length >= this.maxQueue) {
      this.stats.rejected++;
      return Promise.reject(new UpstreamError('Upstream queue full, try again shortly', 503));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.#drain();
    });
  }

  #refill() {
    const now = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastRefill) / 1000) * this.rps);
    this.lastRefill = now;
  }

  #drain() {
    if (this.timer) return;
    while (this.queue.length) {
      const now = this.now();
      if (now < this.pausedUntil) return this.#wake(this.pausedUntil - now);
      this.#refill();
      if (this.tokens < 1) return this.#wake(((1 - this.tokens) / this.rps) * 1000);
      this.tokens -= 1;
      const { task, resolve, reject } = this.queue.shift();
      task().then(resolve, reject);
    }
  }

  #wake(ms) {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#drain();
    }, Math.max(1, Math.ceil(ms)));
  }

  #pushBack(retryAfterSec) {
    this.backoffMs = this.backoffMs ? Math.min(this.maxBackoffMs, this.backoffMs * 2) : this.minBackoffMs;
    const wait = Math.max(this.backoffMs, (retryAfterSec || 0) * 1000);
    this.pausedUntil = this.now() + wait;
  }

  async #fetchJson(url) {
    this.stats.requests++;
    const headers = { accept: 'application/json' };
    if (this.deviceId) headers['x-device-id'] = this.deviceId;

    let res;
    try {
      res = await this.fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      this.stats.errors++;
      this.#pushBack();
      throw new UpstreamError(`Upstream unreachable: ${err.message}`, 502);
    }

    if (res.status === 403 || res.status === 429 || res.status >= 500) {
      this.stats.errors++;
      this.#pushBack(Number(res.headers.get('retry-after')) || 0);
      throw new UpstreamError(`Upstream responded ${res.status}`, res.status === 403 ? 502 : 503);
    }
    this.backoffMs = 0;

    if (!res.ok) throw new UpstreamError(`Upstream responded ${res.status}`, res.status);
    try {
      return await res.json();
    } catch {
      throw new UpstreamError('Upstream returned invalid JSON', 502);
    }
  }
}
