# GSRTC Live (web)

Live GSRTC bus tracking in the browser: track a bus by number on a map, and
find nearby bus stations.

```
browser ──► our Node server (/api/*) ──► upstream tracking API
             • token-bucket rate limit (whole server)
             • per-IP limit
             • response cache + request coalescing
             • global pause with exponential backoff on 403/429/5xx
```

The browser never calls the upstream directly. All traffic goes through one
polite client (`server/upstream.js`). Many viewers of the same bus cost one
upstream call every 10 s, and the server stops hitting the upstream as soon as
the upstream pushes back.

## Run

Requires Node 20+. There are no npm dependencies.

```bash
cp .env.example .env   # set UPSTREAM_BASE
npm start              # http://localhost:8080
npm test
```

## Upstream

`.env.example` points `UPSTREAM_BASE` at the third-party tracker proxy
(`https://tracker.shivrajsinh.in`, see `docs/tracker-proxy-api.md`). Every route in
`server/routes.js` was smoke-tested against it. It is a stop-gap: a small
single-developer service with no SLA that blocks clients that hammer it, so the
outbound budget in `.env.example` is deliberately low (1 req/s, burst 2).

Still to do: map the official infinium upstream from the APK and switch
`UPSTREAM_BASE`. Change only each route's `upstream()` function (and reshape the
response there if it differs); the frontend depends on our routes only.

The frontend reads fields leniently (`lat`/`Lat`/`latitude`, and so on), so it works
with either upstream.

## Upstream data caveats

Observed with the third-party upstream, and likely inherited from GSRTC's own data:
`Status` is almost always "Running", `Speed`/`speedKmh` is mostly missing, and trip
labels ("next stop", ETA) can belong to an earlier or later trip. Only the GPS
position is dependable. To tell whether a bus is really moving, compare two
positions a minute apart.

## Layout

- `server/`: HTTP server, route table, upstream client
- `web/`: static frontend (vanilla JS, with Leaflet and OSM tiles)
- `test/`: `node:test` suites for the upstream client and the HTTP layer
- `docs/`: API notes
