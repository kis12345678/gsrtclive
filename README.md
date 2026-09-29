# GSRTC Live (web)

Live GSRTC bus tracking in the browser: a 24x7 view of the Bhuj <-> Mundra route,
track any bus by number on a map, and find nearby bus stations.

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

## Deploy (24x7)

**Docker Compose** (recommended: home server or any small VPS):

```bash
cp .env.example .env      # edit: COLLECTOR=on to record the route, TRUST_PROXY=on behind a tunnel/proxy
docker compose up -d --build
docker compose logs -f          # "collector on: Bhuj <-> Mundra ..."
curl localhost:8080/api/health  # server + collector status
```

History lives in the `gsrtc-data` volume and survives rebuilds. Back it up with
`docker compose cp gsrtclive:/app/data ./data-backup`. Update with `git pull && docker compose up -d --build`.

**systemd** without Docker: `deploy/gsrtclive.service`.

To reach it from outside your network, put a reverse proxy or a Cloudflare Tunnel in
front (HTTPS) and set `TRUST_PROXY=on`.

**Not Vercel.** The collector is a long-running process that writes to disk and keeps
rate-limit/backoff state in memory; serverless functions keep neither, so the Mundra
tab would never have data.

## 24x7 Mundra route tracking

With `COLLECTOR=on` the server keeps watching the Bhuj <-> Mundra route (around the
clock, or only inside `ACTIVE_WINDOWS`), whether or not anyone has the page open:

```
TRACK_PLATES (or the timetable, both directions) ──► bus roster ──► poll each bus (POLL_ACTIVE_MS moving / POLL_IDLE_MS stopped)
                                                  │
                          speed + direction worked out from consecutive positions
                                                  │
                     memory (live view)  +  data/positions-YYYY-MM-DD.jsonl (history)
browser ──► /api/mundra/*  (served from memory/disk, never touches the upstream)
```

- The **Mundra route** tab shows every bus on the route (green = moving, grey =
  stopped), how far it is from Bhuj and Mundra, and a 6 h trail when you click one.
- `GET /api/mundra/buses[?corridor=1][&moving=1]`, `GET /api/mundra/history?plate=&hours=`
  (max 72), `GET /api/mundra/status` (also included in `/api/health`).
- History is one JSON line per position change (plus a 10 min heartbeat) in
  `DATA_DIR`, pruned after `RETENTION_DAYS`. Timestamps are when *we* observed the
  bus, not GPS time. Copy the files elsewhere for long-term analysis.
- Run it as a service: see `deploy/gsrtclive.service`. Set every option in `.env`
  (see `.env.example`).

What the numbers mean, and don't:

- Speed and "moving" come from the distance between two polls. A bus that starts
  moving after a long stop is noticed at the next poll (up to 5 min later), and its
  first speed is averaged over that gap.
- "Stopped" also covers a GPS device that stopped reporting; the upstream doesn't
  let us tell the two apart.
- "Towards Bhuj/Mundra" compares straight-line distances, so it is only meaningful
  for buses in the corridor (`inCorridor`).
- The upstream's location name (`CurrentLocationName`) is often wrong (a bus 5 km
  from Mundra reported "Rajkot"), so the UI doesn't show it.
- Which buses: with `TRACK_PLATES` set (the default in `.env.example`) exactly those
  buses are tracked and the timetable is never queried; leave it empty to follow
  whatever the timetable lists each day. Either way an unlisted replacement bus is
  missed, so revisit the list now and then. To add a bus: edit `TRACK_PLATES` in
  `.env` and `docker compose up -d`.
- Active hours: with `ACTIVE_WINDOWS` set (default in `.env.example`: 06:00-10:30 and
  16:00-20:30 IST) nothing is sent to the upstream outside those hours, and the page
  says tracking is paused and shows the last known positions. Each time a window
  opens, the first sample of every bus starts fresh instead of being compared with
  positions from hours ago.
- Load on the upstream = number of buses x poll rate x hours active. At the shipped
  2-minute setting a moving bus costs 0.5 requests/min and a stopped one 0.2/min, so
  14 buses with 3-4 moving is roughly 4 requests/min, only during the 8.5 active
  hours a day: about 2,000 requests/day. For comparison, 30 s polling around the
  clock would be about 14,000/day. These are estimates, not measured on the live route.

**One shared client, on purpose.** Splitting the work into one script per bus, or
making requests look like they come from different users (rotating device ids or
IPs), would not lower the load, it would only hide it from the operator's abuse limits.
So there is a single rate-limited client with one fixed `UPSTREAM_DEVICE_ID`, and the
way to lower the load is fewer buses, longer intervals and shorter active hours.

**Do not point this at a service you don't run without asking.** Measured against the
third-party proxy: every polled plate (with or without `focus=1`) is added to its
watch list (max 60) and polled against GSRTC, and 14 polled plates raised its
`watching` count from 19 to 35 in under two minutes while its tracker was already
backing off. Around-the-clock polling of ~25 plates would tie up a large share of a
one-person hobby service. Get the operator's OK, or map the official upstream first.

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
