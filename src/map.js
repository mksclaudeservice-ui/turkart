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
  return (la, lo) => {
    marker.setLatLng([la, lo]);
    map.setView([la, lo], zoom);
    setTimeout(() => map.invalidateSize(), 50);
  };
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

export class TurMap {
  constructor(el, { onPlaceClick, onMapClick }) {
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
    this.onPlaceClick = onPlaceClick;
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
        .addTo(this.markers);
    }
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
