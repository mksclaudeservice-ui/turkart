// GPS-spor fra treningsklokker: GPX (Strava, HealthFit/Apple Watch, de fleste), FIT (Garmin) og TCX.
// Et spor lagres forenklet som [[lat, lon, ele|null, sekunderFraStart|null], ...].
import { distanceKm } from './geo.js';

const MAX_POINTS = 1500;

export function isTrackFile(file) {
  return /\.(gpx|fit|tcx)$/i.test(file.name);
}

function parseXmlPoints(text, kind) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Filen kunne ikke leses');
  const pts = [];
  if (kind === 'gpx') {
    let nodes = [...doc.getElementsByTagName('trkpt')];
    if (!nodes.length) nodes = [...doc.getElementsByTagName('rtept')];
    for (const n of nodes) {
      const lat = parseFloat(n.getAttribute('lat'));
      const lon = parseFloat(n.getAttribute('lon'));
      const ele = parseFloat(n.getElementsByTagName('ele')[0]?.textContent);
      const t = n.getElementsByTagName('time')[0]?.textContent;
      pts.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null, time: t ? new Date(t) : null });
    }
    const name = doc.getElementsByTagName('trk')[0]?.getElementsByTagName('name')[0]?.textContent?.trim();
    return { pts, name };
  }
  for (const n of [...doc.getElementsByTagName('Trackpoint')]) {
    const pos = n.getElementsByTagName('Position')[0];
    if (!pos) continue;
    const lat = parseFloat(pos.getElementsByTagName('LatitudeDegrees')[0]?.textContent);
    const lon = parseFloat(pos.getElementsByTagName('LongitudeDegrees')[0]?.textContent);
    const ele = parseFloat(n.getElementsByTagName('AltitudeMeters')[0]?.textContent);
    const t = n.getElementsByTagName('Time')[0]?.textContent;
    pts.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null, time: t ? new Date(t) : null });
  }
  return { pts, name: null };
}

async function parseFit(buffer) {
  const { Decoder, Stream } = await import('@garmin/fitsdk');
  const decoder = new Decoder(Stream.fromArrayBuffer(buffer));
  if (!decoder.isFIT()) throw new Error('Ikke en gyldig FIT-fil');
  const { messages, errors } = decoder.read({ convertDateTimesToDates: true });
  if (errors?.length && !messages?.recordMesgs?.length) throw new Error('FIT-filen kunne ikke leses');
  const SC = 180 / 2 ** 31;
  const pts = (messages.recordMesgs ?? [])
    .filter((r) => r.positionLat != null && r.positionLong != null)
    .map((r) => ({
      lat: r.positionLat * SC,
      lon: r.positionLong * SC,
      ele: r.enhancedAltitude ?? r.altitude ?? null,
      time: r.timestamp ? new Date(r.timestamp) : null
    }));
  const ses = messages.sessionMesgs?.[0] ?? {};
  return {
    pts,
    name: null,
    sport: ses.sport ?? null,
    // Klokkas egne tall (barometer og bevegelsestid) er mer presise enn det vi kan regne ut av GPS-punktene.
    device: {
      ascentM: ses.totalAscent ?? null,
      distanceKm: ses.totalDistance != null ? ses.totalDistance / 1000 : null,
      durationMin: ses.totalElapsedTime != null ? Math.round(ses.totalElapsedTime / 60) : null
    }
  };
}

/** Høydemeter med enkel glatting og terskel, så GPS-støy ikke teller. */
function ascentOf(pts) {
  const eles = pts.map((p) => p.ele).filter((e) => e != null);
  if (eles.length < 2) return null;
  const smooth = eles.map((_, i) => {
    const w = eles.slice(Math.max(0, i - 2), i + 3);
    return w.reduce((s, x) => s + x, 0) / w.length;
  });
  let up = 0;
  let ref = smooth[0];
  for (const e of smooth) {
    if (e - ref >= 3) {
      up += e - ref;
      ref = e;
    } else if (e < ref) ref = e;
  }
  return Math.round(up);
}

function downsample(pts, maxIdx) {
  if (pts.length <= MAX_POINTS) return pts;
  const step = pts.length / MAX_POINTS;
  const out = [];
  for (let i = 0; i < MAX_POINTS; i++) out.push(pts[Math.floor(i * step)]);
  if (maxIdx != null && !out.includes(pts[maxIdx])) out.push(pts[maxIdx]);
  out.push(pts[pts.length - 1]);
  return [...new Set(out)].sort((a, b) => pts.indexOf(a) - pts.indexOf(b));
}

/** Les en sporfil og regn ut statistikk. */
export async function parseTrackFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  let parsed;
  if (ext === 'fit') parsed = await parseFit(await file.arrayBuffer());
  else parsed = parseXmlPoints(await file.text(), ext);
  const pts = parsed.pts.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (pts.length < 2) throw new Error('Fant ingen GPS-punkter i filen');

  let dist = 0;
  for (let i = 1; i < pts.length; i++) dist += distanceKm(pts[i - 1], pts[i]);
  let maxIdx = null;
  pts.forEach((p, i) => {
    if (p.ele != null && (maxIdx == null || p.ele > pts[maxIdx].ele)) maxIdx = i;
  });
  const times = pts.map((p) => p.time).filter((t) => t && !isNaN(t));
  const start = times[0] ?? null;
  const end = times[times.length - 1] ?? null;
  const summit = maxIdx != null ? pts[maxIdx] : pts[Math.floor(pts.length / 2)];
  const t0 = start?.getTime();
  const simple = downsample(pts, maxIdx).map((p) => [
    Number(p.lat.toFixed(6)),
    Number(p.lon.toFixed(6)),
    p.ele != null ? Math.round(p.ele) : null,
    p.time && t0 != null ? Math.round((p.time.getTime() - t0) / 1000) : null
  ]);
  return {
    name: file.name,
    title: parsed.name || null,
    source: ext,
    sport: parsed.sport ?? null,
    start,
    end,
    durationMin: parsed.device?.durationMin ?? (start && end ? Math.round((end - start) / 60000) : null),
    distanceKm: Math.round((parsed.device?.distanceKm ?? dist) * 100) / 100,
    ascentM: parsed.device?.ascentM ?? ascentOf(pts),
    maxEle: maxIdx != null ? Math.round(pts[maxIdx].ele) : null,
    summit: { lat: summit.lat, lon: summit.lon },
    points: simple
  };
}

/** Slå sammen flere spor fra samme tur (f.eks. klokka stoppet underveis) til ett. Delene beholdes i .parts. */
export function mergeTracks(list) {
  if (list.length === 1) return list[0];
  const parts = [...list].sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0));
  const sum = (k) => (parts.every((t) => t[k] == null) ? null : parts.reduce((s, t) => s + (t[k] ?? 0), 0));
  const top = parts.filter((t) => t.maxEle != null).sort((a, b) => b.maxEle - a.maxEle)[0] ?? parts[0];
  const ends = parts.map((t) => t.end).filter(Boolean);
  const dist = sum('distanceKm');
  return {
    ...parts[0],
    name: parts.map((t) => t.name).join(' + '),
    parts,
    start: parts[0].start,
    end: ends.length ? new Date(Math.max(...ends.map((e) => e.getTime()))) : null,
    durationMin: sum('durationMin'),
    distanceKm: dist != null ? Math.round(dist * 100) / 100 : null,
    ascentM: sum('ascentM'),
    maxEle: top.maxEle,
    summit: top.summit,
    points: parts.flatMap((t) => t.points)
  };
}

/** Grupper spor som hører til samme tur: samme dag og enten tett i tid (≤ 5 t) eller nær hverandre (≤ 10 km). */
export function clusterTracks(tracks) {
  const day = (d) => (d ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : null);
  const sorted = [...tracks].sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0));
  const clusters = [];
  for (const t of sorted) {
    const c = clusters.find((cl) =>
      cl.some((o) => {
        if (!t.start || !o.start || day(t.start) !== day(o.start)) return false;
        const gapH = Math.abs(t.start - (o.end ?? o.start)) / 3_600_000;
        return gapH <= 5 || distanceKm(t.summit, o.summit) <= 10;
      })
    );
    if (c) c.push(t);
    else clusters.push([t]);
  }
  return clusters.map(mergeTracks);
}

/** Posisjon langs sporet for et gitt tidspunkt (lineær interpolasjon). Null hvis utenfor sporet. */
export function positionAt(track, when, slackMin = 30) {
  if (track.parts) {
    for (const part of track.parts) {
      const pos = positionAt(part, when, 0);
      if (pos) return pos;
    }
    return track.parts.map((part) => positionAt(part, when, slackMin)).find(Boolean) ?? null;
  }
  if (!track.start || !when) return null;
  const sec = (when.getTime() - track.start.getTime()) / 1000;
  const pts = track.points.filter((p) => p[3] != null);
  if (!pts.length) return null;
  const last = pts[pts.length - 1][3];
  if (sec < -slackMin * 60 || sec > last + slackMin * 60) return null;
  if (sec <= pts[0][3]) return { lat: pts[0][0], lon: pts[0][1] };
  if (sec >= last) return { lat: pts[pts.length - 1][0], lon: pts[pts.length - 1][1] };
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][3] >= sec) {
      const a = pts[i - 1];
      const b = pts[i];
      const f = (sec - a[3]) / Math.max(1, b[3] - a[3]);
      return { lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f };
    }
  }
  return null;
}

/** Er tidspunktet innenfor sporets tidsrom (med slakk)? */
export function withinTrack(track, when, slackMin = 30) {
  if (!track.start || !track.end || !when) return false;
  const t = when.getTime();
  return t >= track.start.getTime() - slackMin * 60000 && t <= track.end.getTime() + slackMin * 60000;
}

/** Høydeprofil som SVG (avstand på x, høyde på y). */
export function profileSvg(points, { width = 320, height = 72 } = {}) {
  const withEle = points.filter((p) => p[2] != null);
  if (withEle.length < 2) return '';
  const xs = [0];
  for (let i = 1; i < withEle.length; i++) {
    xs.push(xs[i - 1] + distanceKm({ lat: withEle[i - 1][0], lon: withEle[i - 1][1] }, { lat: withEle[i][0], lon: withEle[i][1] }));
  }
  const total = xs[xs.length - 1] || 1;
  const eles = withEle.map((p) => p[2]);
  const min = Math.min(...eles);
  const max = Math.max(...eles);
  const span = Math.max(20, max - min);
  const pad = 4;
  const X = (d) => (d / total) * width;
  const Y = (e) => height - pad - ((e - min) / span) * (height - pad * 2 - 12);
  const line = withEle.map((p, i) => `${X(xs[i]).toFixed(1)},${Y(p[2]).toFixed(1)}`).join(' ');
  const maxI = eles.indexOf(max);
  return `<svg class="profile" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Høydeprofil fra ${Math.round(min)} til ${Math.round(max)} moh.">
    <polygon points="0,${height} ${line} ${width},${height}" class="profile-area" />
    <polyline points="${line}" class="profile-line" fill="none" vector-effect="non-scaling-stroke" />
    <circle cx="${X(xs[maxI]).toFixed(1)}" cy="${Y(max).toFixed(1)}" r="3" class="profile-top" />
  </svg>
  <div class="profile-legend"><span>${Math.round(min)} moh.</span><span>Topp ${Math.round(max)} moh.</span><span>${total.toFixed(1).replace('.', ',')} km</span></div>`;
}
