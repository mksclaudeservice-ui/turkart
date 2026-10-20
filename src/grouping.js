// Gruppér opplastede bilder til forslag om turer, basert på tid og sted.
import { distanceKm, nameForPoint } from './geo.js';

const MAX_GAP_HOURS = 5;
const MAX_DIST_KM = 5;
const MATCH_EXISTING_KM = 2;

function centroid(items) {
  const n = items.length;
  return {
    lat: items.reduce((s, i) => s + i.lat, 0) / n,
    lon: items.reduce((s, i) => s + i.lon, 0) / n
  };
}

export function clusterPhotos(items) {
  const withPos = items.filter((i) => i.lat != null && i.lon != null && i.takenAt).sort((a, b) => a.takenAt - b.takenAt);
  const posNoTime = items.filter((i) => i.lat != null && i.lon != null && !i.takenAt);
  const noPos = items.filter((i) => i.lat == null || i.lon == null);

  const groups = [];
  let current = null;
  for (const item of withPos) {
    if (current) {
      const last = current.items[current.items.length - 1];
      const gapH = (item.takenAt - last.takenAt) / 3_600_000;
      const dist = distanceKm(centroid(current.items), item);
      if (gapH <= MAX_GAP_HOURS && dist <= MAX_DIST_KM) {
        current.items.push(item);
        continue;
      }
    }
    current = { items: [item] };
    groups.push(current);
  }
  for (const item of posNoTime) {
    const near = groups.find((g) => distanceKm(centroid(g.items), item) <= MAX_DIST_KM);
    if (near) near.items.push(item);
    else groups.push({ items: [item] });
  }

  // Bilder uten posisjon, men tatt innenfor en gruppes tidsrom, følger gruppen.
  const unsorted = [];
  for (const item of noPos) {
    const g = item.takenAt
      ? groups.find((gr) => {
          const times = gr.items.filter((i) => i.takenAt).map((i) => i.takenAt.getTime());
          if (!times.length) return false;
          const t = item.takenAt.getTime();
          return t >= Math.min(...times) - 3_600_000 && t <= Math.max(...times) + 3_600_000;
        })
      : null;
    if (g) g.items.push(item);
    else unsorted.push(item);
  }

  // Bilder med dato men uten posisjon: grupper per dag, så de kan kobles til en tur manuelt.
  const byDay = new Map();
  for (const item of unsorted.filter((i) => i.takenAt)) {
    const key = item.takenAt.toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, { items: [], noPosition: true });
    byDay.get(key).items.push(item);
  }
  groups.push(...byDay.values());
  const stillUnsorted = unsorted.filter((i) => !i.takenAt);

  for (const g of groups) {
    const located = g.items.filter((i) => i.lat != null);
    g.center = located.length ? centroid(located) : null;
    const times = g.items.filter((i) => i.takenAt).map((i) => i.takenAt.getTime());
    g.start = times.length ? new Date(Math.min(...times)) : null;
    g.end = times.length ? new Date(Math.max(...times)) : null;
  }
  return { groups, unsorted: stillUnsorted };
}

/** Legg til forslag: eksisterende sted i nærheten, ellers et navneforslag. */
export async function suggestForGroups(groups, places) {
  for (const g of groups) {
    if (!g.center) {
      // Uten posisjon: foreslå steder besøkt samme dag, ellers tomt navn som brukeren fyller inn.
      const day = g.start?.toISOString().slice(0, 10);
      g.nearby = places.filter((p) => day && (p.visitsList ?? []).some((v) => v.visited_on === day));
      g.suggestion = g.nearby[0]
        ? { name: g.nearby[0].name, country: g.nearby[0].country, isPeak: g.nearby[0].kind === 'topptur' }
        : { name: '', country: 'Norge', isPeak: true };
      continue;
    }
    let nearby;
    if (g.track) {
      // Spor: et sted er truffet hvis sporet går innom det (innen 1 km), eller toppen er nær.
      // Steder med besøk samme dag kommer først.
      const day = g.start ? new Date(g.start.getTime() - g.start.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : null;
      const pts = g.track.points.filter((_, i) => i % 5 === 0);
      nearby = places
        .map((p) => {
          let route = Infinity;
          for (const q of pts) route = Math.min(route, distanceKm({ lat: q[0], lon: q[1] }, p));
          return { p, d: Math.min(route, distanceKm(g.center, p)), sameDay: (p.visitsList ?? []).some((v) => v.visited_on === day) };
        })
        .filter((x) => x.d <= 1 || distanceKm(g.center, x.p) <= MATCH_EXISTING_KM)
        .sort((a, b) => Number(b.sameDay) - Number(a.sameDay) || a.d - b.d);
    } else {
      nearby = places
        .map((p) => ({ p, d: distanceKm(g.center, p) }))
        .filter((x) => x.d <= MATCH_EXISTING_KM)
        .sort((a, b) => a.d - b.d);
    }
    g.nearby = nearby.map((x) => x.p);
    if (g.nearby.length) {
      g.suggestion = { name: g.nearby[0].name, country: g.nearby[0].country, isPeak: g.nearby[0].kind === 'topptur' };
    } else {
      g.suggestion = await nameForPoint(g.center.lat, g.center.lon);
      await new Promise((r) => setTimeout(r, 1100)); // OpenStreetMap tillater ett oppslag i sekundet
    }
  }
  return groups;
}
