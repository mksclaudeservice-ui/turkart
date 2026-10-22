// Etapper mellom stopp på en reise: vei langs veinettet (OpenStreetMap-ruting), bue for fly, stiplet for ferje/tog.
import L from 'leaflet';
import { distanceKm } from './geo.js';

export const LEG_MODES = {
  bil: { label: 'Bil', profile: 'routed-car', speed: 70 },
  fly: { label: 'Fly', speed: 700 },
  ferje: { label: 'Ferje', speed: 30 },
  tog: { label: 'Tog', speed: 90 },
  sykkel: { label: 'Sykkel', profile: 'routed-bike', speed: 18 },
  gange: { label: 'Til fots', profile: 'routed-foot', speed: 4.5 }
};

/** Forslag når ingen transport er valgt: lange etapper er fly, resten bil. */
export const defaultMode = (a, b) => (distanceKm(a, b) > 600 ? 'fly' : 'bil');

/** Bue mellom to punkter (tegnes i kartets projeksjon, så den ser lik ut på alle zoomnivåer). */
export function arcPoints(a, b, bend = 0.2, n = 48) {
  const P = L.Projection.SphericalMercator;
  const pa = P.project(L.latLng(a.lat, a.lon));
  const pb = P.project(L.latLng(b.lat, b.lon));
  const mx = (pa.x + pb.x) / 2;
  const my = (pa.y + pb.y) / 2;
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const c = L.point(mx - dy * bend, my + dx * bend);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = (1 - t) * (1 - t) * pa.x + 2 * (1 - t) * t * c.x + t * t * pb.x;
    const y = (1 - t) * (1 - t) * pa.y + 2 * (1 - t) * t * c.y + t * t * pb.y;
    const ll = P.unproject(L.point(x, y));
    out.push([Number(ll.lat.toFixed(5)), Number(ll.lng.toFixed(5))]);
  }
  return out;
}

/** Forenkle en linje til maks antall punkter. */
function thin(points, max = 400) {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

/** Beregn en etappe. Vei hentes fra routing.openstreetmap.de; finnes ingen vei, brukes en rett linje. */
export async function routeLeg(a, b, mode) {
  const m = LEG_MODES[mode] ?? LEG_MODES.bil;
  const crow = distanceKm(a, b);
  const fallback = (pts) => ({ points: pts, distanceKm: Math.round(crow * 10) / 10, durationMin: Math.round((crow / m.speed) * 60), routed: false });
  if (mode === 'fly') return fallback(arcPoints(a, b, 0.18));
  if (mode === 'ferje') return fallback(arcPoints(a, b, 0.06, 16));
  if (!m.profile) return fallback([[a.lat, a.lon], [b.lat, b.lon]]);
  try {
    const url = `https://routing.openstreetmap.de/${m.profile}/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=simplified&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ruting ${res.status}`);
    const data = await res.json();
    const r = data.routes?.[0];
    if (!r) throw new Error('ingen rute');
    return {
      points: thin(r.geometry.coordinates.map(([lon, lat]) => [Number(lat.toFixed(5)), Number(lon.toFixed(5))])),
      distanceKm: Math.round((r.distance / 1000) * 10) / 10,
      durationMin: Math.round(r.duration / 60),
      routed: true
    };
  } catch (err) {
    console.warn('Ruting feilet, bruker rett linje', err);
    return fallback([[a.lat, a.lon], [b.lat, b.lon]]);
  }
}
