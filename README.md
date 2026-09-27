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

## Upstream mapping: still to do

`server/routes.js` defines our `/api/*` routes, and says how each one maps to
an upstream path and which query parameters it passes on. Those upstream paths
currently copy the third-party proxy (see `docs/tracker-proxy-api.md`). They
have **not** been checked against the official infinium upstream.

After the real endpoints are mapped from the APK, edit each route's `upstream()`
function. If the response shape differs, reshape it there too. The frontend
only depends on our routes.

The frontend reads fields leniently (`lat`/`Lat`/`latitude`, and so on) because
the response shapes are not pinned down yet.

## Layout

- `server/`: HTTP server, route table, upstream client
- `web/`: static frontend (vanilla JS, with Leaflet and OSM tiles)
- `test/`: `node:test` suites for the upstream client and the HTTP layer
- `docs/`: API notes
