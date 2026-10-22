import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const LAYERS = {
  topo: {
    label: 'Terreng (Kartverket)',
    layer: () =>
      L.tileLayer('https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png', {
        maxZoom: 18,
        attribution: '© <a href="https://www.kartverket.no/">Kartverket</a>'
      })
  },
  grey: {
    label: 'Gråtone (Kartverket)',
    layer: () =>
      L.tileLayer('https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/{z}/{y}/{x}.png', {
        maxZoom: 18,
        attribution: '© <a href="https://www.kartverket.no/">Kartverket</a>'
      })
  },
  photo: {
    label: 'Flyfoto',
    layer: () =>
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Bilder © Esri, Maxar, Earthstar Geographics'
      })
  },
  osm: {
    label: 'Verdenskart (OSM)',
    layer: () =>
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      })
  }
};

const ICON_PLANE =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 16l20-6-3-3-7 2-5-5-2 1 3 6-4 1-2-2-1 1z"/></svg>';
const ICON_MOUNTAIN =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20l6-11 4 6 2-3 6 8z"/></svg>';

/** Lite, statisk forhåndsvisningskart med én nål. Returnerer en funksjon for å flytte nålen. */
export function miniMap(el, lat, lon, { zoom = 11, color = '#2F5D50' } = {}) {
  const map = L.map(el, {
    zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, opacity: 0.6 }).addTo(map);
  L.tileLayer('https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png', { maxZoom: 18 }).addTo(map);
  const icon = L.divIcon({ className: 'pin pin--mini', html: '', iconSize: [18, 18], iconAnchor: [9, 9] });
  const marker = L.marker([lat, lon], { icon, interactive: false }).addTo(map);
  marker.getElement()?.style.setProperty('background', color);
  map.setView([lat, lon], zoom);
  setTimeout(() => map.invalidateSize(), 50);
  const move = (la, lo) => {
    marker.setLatLng([la, lo]);
    map.setView([la, lo], zoom);
    setTimeout(() => map.invalidateSize(), 50);
  };
  move.map = map;
  move.marker = marker;
  return move;
}

/** Lite kart med flere nåler, tilpasset slik at alle vises. */
export function miniMapPoints(el, points, { color = '#2F5D50', maxZoom = 12 } = {}) {
  const pts = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (!pts.length) return null;
  const map = L.map(el, {
    zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false, tap: false
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, opacity: 0.6 }).addTo(map);
  L.tileLayer('https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png', { maxZoom: 18 }).addTo(map);
  for (const p of pts) {
    const icon = L.divIcon({ className: 'pin pin--mini', html: '', iconSize: [18, 18], iconAnchor: [9, 9] });
    const m = L.marker([p.lat, p.lon], { icon, interactive: false }).addTo(map);
    m.getElement()?.style.setProperty('background', p.color ?? color);
  }
  const fit = () => {
    map.invalidateSize();
    if (pts.length === 1) map.setView([pts[0].lat, pts[0].lon], maxZoom);
    else map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon])).pad(0.3), { maxZoom });
  };
  fit();
  setTimeout(fit, 60);
  return map;
}

/** Tegn ett eller flere spor på et Leaflet-kart. Returnerer laget. */
export function drawLines(map, lines, { color = '#d1461f', weight = 4, fit = false } = {}) {
  const group = L.layerGroup().addTo(map);
  const all = [];
  for (const pts of lines) {
    const ll = pts.map((p) => [p[0], p[1]]);
    if (ll.length < 2) continue;
    L.polyline(ll, { color: '#fff', weight: weight + 3, opacity: 0.85, interactive: false }).addTo(group);
    L.polyline(ll, { color, weight, opacity: 0.95, interactive: false }).addTo(group);
    all.push(...ll);
  }
  if (fit && all.length) map.fitBounds(L.latLngBounds(all).pad(0.15), { maxZoom: 14 });
  return group;
}

/** Reiserute: nummererte stopp i rekkefølge, heltrukket linje med retningspiler. Returnerer laget. */
const LEG_STYLE = {
  bil: { weight: 3.5 },
  sykkel: { weight: 3 },
  gange: { weight: 3 },
  tog: { weight: 3, dashArray: '10 6' },
  ferje: { weight: 3, dashArray: '2 8' },
  fly: { weight: 2.5, dashArray: '7 7' }
};

export function tripLayer(map, stops, { activeId = null, color = '#2B5C8A', legs = [], onStopClick, onPinShown } = {}) {
  const group = L.layerGroup().addTo(map);
  for (let i = 1; i < stops.length; i++) {
    const leg = legs[i - 1];
    const pts = leg?.points?.length > 1 ? leg.points : [[stops[i - 1].lat, stops[i - 1].lon], [stops[i].lat, stops[i].lon]];
    const st = LEG_STYLE[leg?.mode] ?? LEG_STYLE.bil;
    // Mens ruten beregnes vises en svak, rett linje.
    const pending = !leg?.points;
    L.polyline(pts, { color: '#fff', weight: st.weight + 3.5, opacity: pending ? 0.5 : 0.9, interactive: false, lineJoin: 'round', lineCap: 'round' }).addTo(group);
    L.polyline(pts, { color, weight: st.weight, dashArray: pending ? '2 6' : st.dashArray, opacity: pending ? 0.5 : 1, interactive: false, lineJoin: 'round', lineCap: 'round' }).addTo(group);
    // Pil midt på etappen som viser reiseretningen (Mercator er vinkeltro, så vinkelen holder ved zoom).
    const k = Math.floor((pts.length - 1) / 2);
    const p0 = pts[k];
    const p1 = pts[Math.min(k + 1, pts.length - 1)];
    const a = L.Projection.SphericalMercator.project(L.latLng(p0));
    const b = L.Projection.SphericalMercator.project(L.latLng(p1));
    if (a.distanceTo(b) < 0.01) continue;
    const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    const mid = pts.length > 2 ? L.latLng(p0) : L.latLng((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
    const html = `<svg viewBox="0 0 16 16" width="16" height="16" style="transform:rotate(${-deg}deg)" aria-hidden="true"><path d="M5 3l6 5-6 5" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    L.marker(mid, { icon: L.divIcon({ className: 'trip-arrow', html, iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false, keyboard: false }).addTo(group);
  }
  for (const s of stops) {
    const on = s.id === activeId;
    const html = on
      ? `<span class="pin-num-photo" ${s.thumb ? `data-thumb="${s.thumb}" style="background-position:${s.pos ?? '50% 50%'}"` : ''}></span><span class="pin-num-badge">${s.n}</span><span class="pin-num-label">${s.label}</span>`
      : `${s.n}`;
    const size = on ? 56 : 30;
    const icon = L.divIcon({ className: `pin-num ${on ? 'pin-num--on' : ''}`, html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
    L.marker([s.lat, s.lon], { icon, title: `${s.n}. ${s.name}`, keyboard: true, zIndexOffset: on ? 1000 : 0 })
      .on('click', () => onStopClick?.(s.id))
      .on('add', (e) => { const el = e.target.getElement(); if (el) onPinShown?.(el); })
      .addTo(group);
  }
  return group;
}

/** Lite kart som viser en reiserute. Returnerer kartet; tegn om med .redraw(activeId). */
export function miniMapTrip(el, stops, opts = {}) {
  const map = L.map(el, {
    zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false, tap: false
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, opacity: 0.6 }).addTo(map);
  L.tileLayer('https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png', { maxZoom: 18 }).addTo(map);
  let layer = tripLayer(map, stops, opts);
  map.redraw = (activeId, legs = opts.legs) => {
    map.removeLayer(layer);
    opts = { ...opts, activeId, legs };
    layer = tripLayer(map, stops, opts);
  };
  const fit = () => {
    map.invalidateSize();
    if (stops.length === 1) map.setView([stops[0].lat, stops[0].lon], 10);
    else if (stops.length) map.fitBounds(L.latLngBounds(stops.map((s) => [s.lat, s.lon])).pad(0.25), { maxZoom: 11 });
  };
  fit();
  setTimeout(fit, 60);
  return map;
}

/** Lite, statisk kart som viser et spor. */
export function miniMapTrack(el, points, { color = '#d1461f', lines = null } = {}) {
  const map = L.map(el, {
    zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false, tap: false
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, opacity: 0.6 }).addTo(map);
  L.tileLayer('https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png', { maxZoom: 18 }).addTo(map);
  const fit = () => {
    map.invalidateSize();
    map.fitBounds(L.latLngBounds(points.map((p) => [p[0], p[1]])).pad(0.15), { maxZoom: 14 });
  };
  drawLines(map, lines ?? [points], { color, weight: 3 });
  fit();
  setTimeout(fit, 60);
  return map;
}

export class TurMap {
  constructor(el, { onPlaceClick, onMapClick, onPinShown }) {
    this.map = L.map(el, { zoomControl: false, worldCopyJump: true }).setView([64.5, 12], 5);
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    this.layers = Object.fromEntries(Object.entries(LAYERS).map(([k, v]) => [k, v.layer()]));
    this.control = L.control
      .layers(Object.fromEntries(Object.entries(LAYERS).map(([k, v]) => [v.label, this.layers[k]])), null, {
        position: 'topright',
        collapsed: true
      })
      .addTo(this.map);
    this.userPickedLayer = false;
    this.current = null;
    // Kartverket dekker bare Norge; et nøytralt verdenskart under fyller resten.
    this.backdrop = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, opacity: 0.6 }).addTo(this.map);
    this.setBase('topo');
    this.map.on('baselayerchange', (e) => { this.userPickedLayer = true; this.current = e.layer; this.backdrop.setOpacity(e.layer === this.layers.osm ? 0 : 0.6); });
    this.markers = L.layerGroup().addTo(this.map);
    this.routes = L.layerGroup().addTo(this.map);
    this.tracks = null;
    this.onPlaceClick = onPlaceClick;
    this.onPinShown = onPinShown;
    this.map.on('click', (e) => onMapClick?.(e.latlng));
  }

  setBase(key) {
    if (this.current) this.map.removeLayer(this.current);
    this.current = this.layers[key];
    this.current.addTo(this.map);
    this.backdrop.setOpacity(key === 'osm' ? 0 : 0.6);
  }

  setMode(mode) {
    if (!this.userPickedLayer) this.setBase(mode === 'reise' ? 'osm' : 'topo');
  }

  render(places, { selectedId, routes = [] } = {}) {
    this.markers.clearLayers();
    this.routes.clearLayers();
    for (const r of routes) {
      if (r.length > 1)
        L.polyline(r.map((p) => [p.lat, p.lon]), { color: '#2B5C8A', weight: 3, dashArray: '6 6' }).addTo(this.routes);
    }
    for (const p of places) {
      let icon;
      if (p.pinThumb) {
        // Bildenål: rundt utsnitt av hovedbildet, farget ramme og et lite merke på toppen.
        const cls = ['pin-ph', `pin-ph--${p.status === 'wish' ? 'wish' : p.mode}`, p.id === selectedId ? 'pin--selected' : ''].join(' ');
        const badge = p.mode === 'fjell' ? ICON_MOUNTAIN : ICON_PLANE;
        const html = `<span class="pin-photo" data-thumb="${p.pinThumb}" style="background-position:${p.pinPos}"></span><span class="pin-peak">${badge}</span>`;
        icon = L.divIcon({ className: cls, html, iconSize: [46, 46], iconAnchor: [23, 23] });
      } else {
        const cls = ['pin', p.status === 'wish' ? 'pin--wish' : `pin--${p.mode}`, p.id === selectedId ? 'pin--selected' : ''].join(' ');
        const html = p.status === 'wish' ? '' : p.mode === 'fjell' ? ICON_MOUNTAIN : '';
        icon = L.divIcon({ className: cls, html, iconSize: [28, 28], iconAnchor: [14, 14] });
      }
      L.marker([p.lat, p.lon], { icon, title: p.name, keyboard: true, riseOnHover: true })
        .on('click', () => this.onPlaceClick?.(p))
        // Leaflet lager nålen på nytt hver gang den vises, så bildet må hentes inn igjen.
        .on('add', (e) => { const el = e.target.getElement(); if (el) this.onPinShown?.(el); })
        .addTo(this.markers);
    }
  }

  showTrip(stops, { activeId = null, legs = [], onStopClick } = {}) {
    this.clearTrip();
    this.trip = tripLayer(this.map, stops, { activeId, legs, onStopClick, onPinShown: this.onPinShown });
  }

  clearTrip() {
    if (this.trip) this.map.removeLayer(this.trip);
    this.trip = null;
  }

  setPinsVisible(on) {
    if (on && !this.map.hasLayer(this.markers)) this.markers.addTo(this.map);
    if (!on && this.map.hasLayer(this.markers)) this.map.removeLayer(this.markers);
  }

  showAllTracks(lines) {
    this.clearAllTracks();
    if (lines.length) this.allTracks = drawLines(this.map, lines, { color: '#d1461f', weight: 3 });
    this.tracks?.eachLayer((l) => l.bringToFront?.());
  }

  clearAllTracks() {
    if (this.allTracks) this.map.removeLayer(this.allTracks);
    this.allTracks = null;
  }

  showTracks(lines, { fit = false } = {}) {
    this.clearTracks();
    if (lines.length) this.tracks = drawLines(this.map, lines, { fit });
  }

  clearTracks() {
    if (this.tracks) this.map.removeLayer(this.tracks);
    this.tracks = null;
  }

  fitTo(places) {
    if (!places.length) return;
    const b = L.latLngBounds(places.map((p) => [p.lat, p.lon]));
    this.map.fitBounds(b.pad(0.25), { maxZoom: 11 });
  }

  flyTo(p, zoom = 12) {
    this.map.flyTo([p.lat, p.lon], Math.max(zoom, this.map.getZoom()), { duration: 0.6 });
  }

  invalidate() {
    setTimeout(() => this.map.invalidateSize(), 50);
  }
}
