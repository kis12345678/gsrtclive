# Third-party tracker proxy — API reference

> **Stop-gap upstream.** This is someone else's small, single-developer proxy. It
> is the configured upstream for now (`.env.example`), behind our rate-limited
> client, but the plan is to talk to the official upstream directly (see "Upstream"
> below). Do not expose it to browsers from our pages, and keep the request rate low.

- Base: `https://tracker.shivrajsinh.in`
- Dev instance: `https://dev-tracker.shivrajsinh.in`
- Upstream it proxies to: `https://gujaratrajyamargvahanvyavaharcorporationtrackingapi.infinium.management`
  (official GSRTC tracking backend, also seen in the GSRTC Live APK)
- Auth: none. Optional header `x-device-id` (the site reads it from
  `localStorage["st_device_id"]`).

## Constraints observed

- `/api/health` reports the upstream host, a limit of **60 watched plates**,
  and upstream error/backoff counters.
- The frontend handles `403` with a `blocked` body — the server blocks clients
  that hammer it. Any request to it must be rate limited.

## Endpoints

### Live / tracking

| Method | Path | Notes |
|---|---|---|
| GET | `/api/vehicle/{plate}?date=&focus=1&tripId=&start=` | vehicle + track |
| GET | `/api/live?from=&to=&date=&limit=25` | |
| GET | `/api/nearby/buses?lat=&lng=` | |
| GET | `/api/trip?tripId=&status=1&start=` | |
| GET | `/api/geometry?tripId=&status=&start=` | |
| GET | `/api/geometry/eta?fromLat=&fromLng=&toLat=&toLng=` | |
| GET | `/api/eta/segments?route=` | |
| GET | `/api/crowd?plates=GJ18Z1234,GJ...` | comma-separated plates |
| GET | `/api/plates?q=` | plate search |
| GET | `/api/tripcode/{code}` | |

### Timetable / stations

| Method | Path | Notes |
|---|---|---|
| GET | `/api/timetable?from=&to=&date=&type=&page=&pageSize=` | |
| GET | `/api/servicetypes` | |
| GET | `/api/nearby?lat=&lng=` | nearby stations |
| GET | `/api/stations/{query}` | station **name search** (`/api/stations/Bhuj` → list with `StationId`, `lat`, `lng`) |
| GET | `/api/station/parent?id=&name=` | |
| GET | `/api/stops?ids=1,2,3` | |
| GET | `/api/stops?south=&west=&north=&east=` | bounding box |
| GET | `/api/depot/departures?depotId=` | |
| GET | `/api/conductor?plate=&from=&to=` | |

### PNR / ticket

| Method | Path |
|---|---|
| GET | `/api/pnr/{pnr}` |
| GET | `/api/ticket?pnr=&mobile=` |
| GET | `/api/pickup-points?pnr=&trip=&vehicle=&status=` |

### Misc

| Method | Path |
|---|---|
| GET | `/api/health`, `/api/status`, `/api/ratings`, `/api/push/key` |
| GET | `/api/reputation?route=&start=[&stop=]` |
| GET | `/api/reports/{id}` |
| POST | `/api/report`, `/api/report/resolve`, `/api/report/undo`, `/api/feedback` |
| POST | `/api/push/subscribe`, `/api/push/cancel`, `/api/push/test` |
| POST | `/api/stat`, `/api/stat/forget`, `/api/error`, `/api/geometry/match`, `/api/sponsor/impression` |

## Example

```bash
curl "https://tracker.shivrajsinh.in/api/nearby?lat=23.25&lng=69.67"
# → [{"StationId":"594","StationName":"Bhuj",...}]
```

Field names such as `StationId` / `StationName` look passed through from the
upstream, which is useful when mapping the infinium API from the APK.

## Verified response shapes (smoke-tested 2026-09-29)

| Endpoint | Shape |
|---|---|
| `/api/vehicle/{plate}` | `{ vehicle: { VehicleNo, Status, RouteName, LastBusStation, NextLocation, ETA, Latitude, Longitude, DepartureDateTime, CurrentLocationName, TripId, Speed }, track: { fixes: [{lat,lng,at}], trail, speedKmh, movement, updatedAt, ... } }`. Plate works with or without dashes. |
| `/api/live` | `{ buses: [{ plate, tripId, route, nextStop, lat, lng, speedKmh, movement, updatedAt }], running }` |
| `/api/nearby` | `[{ StationId, StationName, Center_Lat, Center_Lon, Distance }]` |
| `/api/nearby/buses` | `[{ plate, lat, lng, distanceKm, routeName, lastStation, nextStation, status }]` (slow, up to ~8 s) |
| `/api/plates?q=` | `[{ plate, depot, division }]` |
| `/api/stops?south&west&north&east` | `[{ id, name, nameGu, lat, lng }]` |
| `/api/geometry/eta` | `{ distanceKm, durationMinutes, source }` |

Not wired into our routes on purpose: `/api/conductor` (returns a person's mobile
number), `/api/ticket` and `/api/pickup-points` (passenger data), and all `POST`
endpoints (they write to the third party's database).
