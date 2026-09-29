// Frontend for our own backend (/api/...). Upstream response shapes are not
// pinned down yet, so field access goes through tolerant helpers.

const POLL_MS = 15_000;
const $ = (sel) => document.querySelector(sel);

const map = L.map('map').setView([22.7, 71.6], 7); // Gujarat
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const layers = { stations: L.layerGroup().addTo(map), bus: L.layerGroup().addTo(map) };
let pollTimer = null;

function setStatus(text) {
  $('#status').textContent = text;
}

async function api(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// Case-insensitive lookup across a few candidate field names.
function field(obj, ...names) {
  if (!obj || typeof obj !== 'object') return undefined;
  const keys = Object.keys(obj);
  for (const name of names) {
    const k = keys.find((key) => key.toLowerCase() === name.toLowerCase());
    if (k !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function coords(obj) {
  const lat = Number(field(obj, 'lat', 'latitude', 'Lat', 'Latitude'));
  const lng = Number(field(obj, 'lng', 'lon', 'long', 'longitude', 'Lng', 'Longitude'));
  return Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng) ? [lat, lng] : null;
}

function asList(data) {
  if (Array.isArray(data)) return data;
  for (const v of Object.values(data || {})) if (Array.isArray(v)) return v;
  return [];
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// ---- Tabs ----
for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('[role="tab"]')) {
      t.setAttribute('aria-selected', String(t === tab));
    }
    for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab.dataset.tab;
    setStatus('');
  });
}

// ---- Track bus ----
const normalizePlate = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

let suggestTimer = null;
$('#plate').addEventListener('input', (e) => {
  clearTimeout(suggestTimer);
  const q = normalizePlate(e.target.value);
  $('#plate-suggest').replaceChildren();
  if (q.length < 3) return;
  suggestTimer = setTimeout(async () => {
    try {
      const plates = asList(await api(`/api/plates?q=${encodeURIComponent(q)}`)).slice(0, 8);
      $('#plate-suggest').replaceChildren(
        ...plates.map((p) => {
          const plate = typeof p === 'string' ? p : field(p, 'plate', 'vehicleNo', 'VehicleNo', 'regNo');
          const li = el('li', { textContent: plate ?? JSON.stringify(p) });
          li.addEventListener('click', () => {
            $('#plate').value = plate;
            $('#plate-suggest').replaceChildren();
            track(plate);
          });
          return li;
        }),
      );
    } catch {
      // Suggestions are best-effort.
    }
  }, 400);
});

$('#plate-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('#plate-suggest').replaceChildren();
  track(normalizePlate($('#plate').value));
});

async function track(plate) {
  clearTimeout(pollTimer);
  if (!plate) return;
  const url = new URL(location.href);
  url.searchParams.set('plate', plate);
  history.replaceState(null, '', url);

  let first = true;
  const tick = async () => {
    setStatus(first ? `Looking up ${plate}…` : `Updating ${plate}…`);
    try {
      const data = await api(`/api/vehicle/${encodeURIComponent(plate)}?focus=1`);
      renderVehicle(plate, data, first);
      first = false;
      setStatus(`Updated ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      setStatus(err.message);
    }
    // Stop polling while the tab is hidden; resume on visibility change.
    if (!document.hidden) pollTimer = setTimeout(tick, POLL_MS);
  };
  track.resume = tick;
  tick();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(pollTimer);
  else if (track.resume) track.resume();
});

function renderVehicle(plate, data, fit) {
  const vehicle = field(data, 'vehicle') || data;
  const pos = coords(vehicle) || coords(field(vehicle, 'position', 'location', 'lastLocation'));
  const trail = asList(field(data, 'track', 'path', 'points')).map(coords).filter(Boolean);

  layers.bus.clearLayers();
  if (trail.length > 1) L.polyline(trail, { color: '#c8102e', weight: 4, opacity: 0.7 }).addTo(layers.bus);
  if (pos) {
    L.circleMarker(pos, { radius: 9, color: '#fff', weight: 2, fillColor: '#c8102e', fillOpacity: 1 })
      .bindTooltip(plate)
      .addTo(layers.bus);
    if (fit) map.setView(pos, 13);
  }

  const rows = [
    ['Bus', plate],
    ['Route', field(vehicle, 'routeName', 'route', 'RouteName')],
    ['From', field(vehicle, 'from', 'fromStation', 'FromStationName')],
    ['To', field(vehicle, 'to', 'toStation', 'ToStationName')],
    ['Location', field(vehicle, 'CurrentLocationName')],
    ['Last stop', field(vehicle, 'LastBusStation')],
    ['Next stop', field(vehicle, 'NextLocation')],
    ['Speed', field(vehicle, 'speed', 'Speed')],
    ['Last seen', field(vehicle, 'time', 'timestamp', 'lastUpdated', 'gpsTime', 'DateTime')],
  ].filter(([, v]) => v !== undefined && typeof v !== 'object');

  $('#vehicle-info').replaceChildren(
    el('dl', {}, ...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: String(v) })])),
    pos ? '' : el('p', { textContent: 'No live position for this bus right now.' }),
  );
}

// ---- Nearby stations ----
$('#locate').addEventListener('click', () => {
  if (!navigator.geolocation) return setStatus('Geolocation not supported in this browser.');
  setStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    (p) => loadNearby(p.coords.latitude, p.coords.longitude),
    () => setStatus('Location permission denied. Tap the map to pick a spot instead.'),
    { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
  );
});

map.on('click', (e) => {
  if (!$('[data-panel="nearby"]').hidden) loadNearby(e.latlng.lat, e.latlng.lng);
});

async function loadNearby(lat, lng) {
  setStatus('Loading nearby stations…');
  try {
    const stations = asList(await api(`/api/nearby?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}`));
    layers.stations.clearLayers();
    L.circleMarker([lat, lng], { radius: 6, color: '#2563eb' }).addTo(layers.stations);

    $('#stations').replaceChildren(
      ...stations.map((s) => {
        const name = field(s, 'StationName', 'name') ?? 'Station';
        const pos = coords(s);
        if (pos) L.marker(pos).bindTooltip(name).addTo(layers.stations);
        const li = el('li', {}, name, ' ', el('small', { textContent: `#${field(s, 'StationId', 'id') ?? '?'}` }));
        if (pos) li.addEventListener('click', () => map.setView(pos, 15));
        return li;
      }),
    );
    map.setView([lat, lng], 12);
    setStatus(stations.length ? `${stations.length} stations nearby` : 'No stations found nearby.');
  } catch (err) {
    setStatus(err.message);
  }
}

// Deep link: ?plate=GJ18Z1234
const initial = new URL(location.href).searchParams.get('plate');
if (initial) {
  $('#plate').value = initial;
  track(normalizePlate(initial));
}
