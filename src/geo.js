// Stedsnavn, høyde og avstand. Kartverket for Norge, OpenStreetMap (Nominatim) ellers.

const KV = 'https://ws.geonorge.no';
const NOMINATIM = 'https://nominatim.openstreetmap.org';

export function distanceKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/** Søk etter stedsnavn. Kartverket først, OpenStreetMap som reserve og for utlandet. */
export async function searchPlaces(query) {
  const q = query.trim();
  if (q.length < 2) return [];
  const results = [];
  try {
    const kv = await getJson(
      `${KV}/stedsnavn/v1/sted?sok=${encodeURIComponent(q)}&fuzzy=true&utkoordsys=4258&treffPerSide=8`
    );
    for (const n of kv.navn ?? []) {
      const p = n.representasjonspunkt;
      if (!p) continue;
      results.push({
        name: n.skrivemåte ?? n.stedsnavn?.[0]?.skrivemåte ?? q,
        detail: [n.navneobjekttype, n.kommuner?.[0]?.kommunenavn].filter(Boolean).join(' · '),
        lat: p.nord,
        lon: p.øst,
        country: 'Norge'
      });
    }
  } catch (e) {
    console.warn('Kartverket-søk feilet', e);
  }
  try {
    const osm = await getJson(
      `${NOMINATIM}/search?format=jsonv2&limit=6&accept-language=nb&addressdetails=1&q=${encodeURIComponent(q)}`
    );
    for (const r of osm) {
      results.push({
        name: r.name || r.display_name.split(',')[0],
        detail: r.display_name.split(',').slice(1, 3).join(',').trim(),
        lat: Number(r.lat),
        lon: Number(r.lon),
        country: r.address?.country ?? null
      });
    }
  } catch (e) {
    console.warn('OSM-søk feilet', e);
  }
  return results;
}

const PEAK_TYPES = ['Topp', 'Fjell', 'Tind', 'Egg', 'Fjellområde'];
const HILL_TYPES = ['Haug', 'Ås', 'Berg'];

/** Foreslå navn for et punkt. Prioriterer topper i Norge. */
export async function nameForPoint(lat, lon) {
  try {
    const kv = await getJson(
      `${KV}/stedsnavn/v1/punkt?nord=${lat}&ost=${lon}&koordsys=4258&utkoordsys=4258&radius=2500&treffPerSide=50`
    );
    const hits = (kv.navn ?? [])
      .map((n) => ({
        name: n.stedsnavn?.[0]?.skrivemåte ?? n.skrivemåte,
        type: n.navneobjekttype ?? '',
        dist: n.meterFraPunkt ?? 99999
      }))
      .filter((h) => h.name);
    if (hits.length) {
      const byDist = (a, b) => a.dist - b.dist;
      // Ekte topper først (Topp > Fjell > Tind …), deretter hauger/åser, ellers nærmeste navn.
      const peak = PEAK_TYPES.map((t) => hits.filter((h) => h.type === t).sort(byDist)[0]).find(Boolean);
      const hill = hits.filter((h) => HILL_TYPES.includes(h.type)).sort(byDist)[0];
      const best = peak ?? hill ?? hits.sort(byDist)[0];
      return { name: best.name, country: 'Norge', isPeak: Boolean(peak || hill) };
    }
  } catch (e) {
    console.warn('Kartverket punkt feilet', e);
  }
  try {
    const r = await getJson(
      `${NOMINATIM}/reverse?format=jsonv2&zoom=14&accept-language=nb&lat=${lat}&lon=${lon}`
    );
    const a = r.address ?? {};
    return {
      name: r.name || a.peak || a.village || a.town || a.city || a.municipality || a.county || 'Ukjent sted',
      country: a.country ?? null,
      isPeak: Boolean(a.peak)
    };
  } catch (e) {
    console.warn('OSM reverse feilet', e);
  }
  return { name: 'Ukjent sted', country: null, isPeak: false };
}

/** Høyde over havet fra Kartverket (bare Norge). */
export async function elevationFor(lat, lon) {
  try {
    const r = await getJson(`${KV}/hoydedata/v1/punkt?nord=${lat}&ost=${lon}&koordsys=4258&geojson=false`);
    const z = r.punkter?.[0]?.z;
    return typeof z === 'number' ? Math.round(z) : null;
  } catch {
    return null;
  }
}
