import './style.css';
import { supabase, configured, signedUrls, BUCKET } from './supabase.js';
import { TurMap, miniMap } from './map.js';
import { searchPlaces, elevationFor, nameForPoint } from './geo.js';
import { isImageFile, processFile, existingHashes, uploadAll } from './upload.js';
import { clusterPhotos, suggestForGroups } from './grouping.js';

const app = document.getElementById('app');

// ---------- helpers ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const fmtRange = (a, b) => {
  if (!a) return '';
  if (!b || a === b) return fmtDate(a);
  const da = new Date(a), db = new Date(b);
  if (da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth())
    return `${da.getDate()}.–${fmtDate(b)}`;
  return `${fmtDate(a)} – ${fmtDate(b)}`;
};
const nights = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 86_400_000)) : 0);
const num = (n) => (n == null ? '' : Number(n).toLocaleString('nb-NO'));
const fmtCoord = (lat, lon) => `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? 'Ø' : 'V'}`;
/** Monter/oppdater et forhåndsvisningskart i wrapper-elementet. Returnerer oppdateringsfunksjon. */
function mountPreview(wrapper, lat, lon, opts) {
  if (!wrapper) return () => {};
  const ok = Number.isFinite(lat) && Number.isFinite(lon);
  wrapper.innerHTML = `<div class="minimap"></div><div class="coord">${ok ? fmtCoord(lat, lon) : 'Ingen posisjon valgt'}</div>`;
  wrapper.classList.toggle('preview--empty', !ok);
  let move = ok ? miniMap($('.minimap', wrapper), lat, lon, opts) : null;
  return (la, lo) => {
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return;
    $('.coord', wrapper).textContent = fmtCoord(la, lo);
    wrapper.classList.remove('preview--empty');
    if (move) move(la, lo);
    else move = miniMap($('.minimap', wrapper), la, lo, opts);
  };
}
const isoDay = (d) => (d ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : null);
const $ = (sel, root = document) => root.querySelector(sel);

const KIND_LABEL = {
  topptur: 'Topptur', skitur: 'Skitur', toppskitur: 'Toppskitur', fjelltur: 'Fjelltur', sykkeltur: 'Sykkeltur',
  padletur: 'Padletur', klatring: 'Klatring', utsikt: 'Utsiktspunkt', hytte: 'Hytte',
  sted: 'Sted', by: 'By', overnatting: 'Overnatting'
};
const ICON = {
  mountain: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20l6-11 4 6 2-3 6 8z"/></svg>',
  plane: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 16l20-6-3-3-7 2-5-5-2 1 3 6-4 1-2-2-1 1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  upload: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M6 10l6-6 6 6M4 20h16"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 13l3-8h10l3 8v6H4z"/><path d="M4 13h5l1 2h4l1-2h5"/></svg>',
  note: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h10l4 4v12H5z"/><path d="M15 4v4h4M8 12h8M8 16h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
};

// ---------- state ----------
const state = {
  session: null,
  mode: 'fjell',
  filter: 'all',
  places: [],
  visits: [],
  trips: [],
  photos: [],
  notes: [],
  notesFilter: 'open',
  selected: null, // {type:'place'|'trip', id}
  picking: null,
  map: null
};

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ---------- data ----------
async function loadData() {
  const [p, v, t, ph] = await Promise.all([
    supabase.from('places').select('*').order('created_at'),
    supabase.from('visits').select('*').order('visited_on', { ascending: false }),
    supabase.from('trips').select('*').order('start_date', { ascending: false }),
    supabase.from('photos').select('id,thumb_path,storage_path,place_id,visit_id,trip_id,taken_at,lat,lon').order('taken_at')
  ]);
  for (const r of [p, v, t, ph]) if (r.error) throw r.error;
  state.places = p.data;
  state.visits = v.data;
  state.trips = t.data;
  state.photos = ph.data;
  derive();
  await loadNotes();
}

async function loadNotes() {
  const { data, error } = await supabase.from('notes').select('*').order('created_at', { ascending: false });
  if (error) return console.warn('Notater kunne ikke hentes', error);
  state.notes = data;
  const el = $('#notes-count');
  if (el) el.textContent = data.filter((n) => !n.done).length || '';
}

function derive() {
  const byPlace = new Map(state.places.map((pl) => [pl.id, Object.assign(pl, { visitsList: [], photoList: [] })]));
  for (const v of state.visits) byPlace.get(v.place_id)?.visitsList.push(v);
  for (const ph of state.photos) if (ph.place_id) byPlace.get(ph.place_id)?.photoList.push(ph);
  for (const pl of state.places) pl.lastVisit = pl.visitsList.find((v) => v.visited_on)?.visited_on ?? null;
}

const visibleTrips = () =>
  state.trips.filter((t) => (state.filter === 'all' ? true : state.filter === 'visited' ? t.status === 'done' : t.status === 'wish'));

function visiblePlaces() {
  return state.places.filter(
    (p) =>
      p.mode === state.mode &&
      (state.filter === 'all' || (state.filter === 'visited' ? p.status === 'visited' : p.status === 'wish'))
  );
}

function tripStops(trip) {
  const ids = new Set(state.visits.filter((v) => v.trip_id === trip.id).map((v) => v.place_id));
  return state.places.filter((p) => ids.has(p.id));
}

// ---------- rendering ----------
const userEmail = () => state.session?.user?.email ?? '';
const userInitial = () => (userEmail()[0] ?? '?').toUpperCase();
const ADMIN_EMAILS = ['admin1@example.com', 'admin2@example.com'];
const isAdmin = () => ADMIN_EMAILS.includes(userEmail().toLowerCase());
const ADMIN = {
  deploy: 'https://app.netlify.com/projects/amazing-douhua-ff1a85/deploys',
  db: 'https://supabase.com/dashboard/project/wucaivamwrnuvczrvios/editor',
  auth: 'https://supabase.com/dashboard/project/wucaivamwrnuvczrvios/auth/users'
};

function renderShell() {
  app.innerHTML = `
  <div class="shell" data-mode="${state.mode}">
    <header class="top">
      <div class="brand">${ICON.mountain}<span>Turkart</span></div>
      <div class="seg" role="group" aria-label="Visning">
        <button type="button" data-action="mode" data-mode="fjell" aria-pressed="${state.mode === 'fjell'}">${ICON.mountain}Fjell</button>
        <button type="button" data-action="mode" data-mode="reise" aria-pressed="${state.mode === 'reise'}">${ICON.plane}Reise</button>
      </div>
      <div class="top-actions">
        <button type="button" class="btn btn--ghost" data-action="inbox" id="inbox-btn" aria-label="Usorterte bilder">${ICON.inbox}<span>Usortert</span><span class="badge" id="inbox-count"></span></button>
        <button type="button" class="btn btn--ghost" data-action="notes" aria-label="Notater">${ICON.note}<span>Notater</span><span class="badge" id="notes-count"></span></button>
        <button type="button" class="btn btn--ghost" data-action="upload" aria-label="Last opp bilder">${ICON.upload}<span>Last opp bilder</span></button>
        <button type="button" class="btn btn--dark" data-action="add" aria-label="Legg til">${ICON.plus}<span id="add-label"></span></button>
        <div class="user">
          <button type="button" class="avatar" data-action="user-menu" aria-haspopup="true" aria-expanded="false" aria-label="Innlogget som ${esc(userEmail())}" title="${esc(userEmail())}">${esc(userInitial())}</button>
          <div class="user-menu" id="user-menu" hidden>
            <div class="user-menu-head"><span class="muted">Innlogget som</span><b>${esc(userEmail())}</b></div>
            ${isAdmin() ? `<div class="user-menu-admin">
              <span class="eyebrow">Admin</span>
              <a class="menu-link" href="${ADMIN.deploy}" target="_blank" rel="noopener">${ICON.upload}<span>Publiser ny versjon<small>Netlify · dra inn zip-fil</small></span></a>
              <a class="menu-link" href="${ADMIN.db}" target="_blank" rel="noopener">${ICON.inbox}<span>Database og brukere<small>Supabase</small></span></a>
              <a class="menu-link" href="${ADMIN.auth}" target="_blank" rel="noopener">${ICON.plane}<span>Innlogging og tilgang<small>Supabase Auth</small></span></a>
            </div>` : ''}
            <button type="button" class="btn btn--ghost" data-action="signout">Logg ut</button>
          </div>
        </div>
      </div>
    </header>
    <div class="body">
      <aside class="side" id="side"></aside>
      <main class="mapwrap">
        <div id="map" aria-label="Kart"></div>
        <div class="pick-banner" id="pick-banner" hidden>Klikk i kartet for å plassere stedet <button type="button" class="btn btn--link" data-action="cancel-pick">Avbryt</button></div>
        <section class="detail" id="detail" hidden aria-live="polite"></section>
      </main>
    </div>
  </div>
  <dialog id="dlg" class="dlg"></dialog>
  <div class="lightbox" id="lightbox" hidden></div>`;
  state.map = new TurMap($('#map'), {
    onPlaceClick: (p) => select('place', p.id),
    onMapClick: (ll) => {
      if (state.picking) {
        const cb = state.picking;
        state.picking = null;
        $('#pick-banner').hidden = true;
        cb(ll);
      }
    }
  });
  state.map.setMode(state.mode);
}

function render({ fit = false } = {}) {
  $('.shell').dataset.mode = state.mode;
  document.querySelectorAll('[data-action="mode"]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === state.mode));
  $('#add-label').textContent = state.mode === 'fjell' ? 'Legg til tur' : 'Legg til reise';
  const unsorted = state.photos.filter((p) => !p.place_id && !p.trip_id).length;
  $('#inbox-count').textContent = unsorted || '';
  $('#notes-count').textContent = state.notes.filter((n) => !n.done).length || '';
  $('#side').innerHTML = state.mode === 'fjell' ? sideFjell() : sideReise();
  const places = visiblePlaces();
  const routes =
    state.mode === 'reise'
      ? visibleTrips().map((t) => tripStops(t).filter((p) => p.mode === 'reise').sort((a, b) => (a.lastVisit ?? '').localeCompare(b.lastVisit ?? '')))
      : [];
  state.map.render(places, { selectedId: state.selected?.type === 'place' ? state.selected.id : null, routes });
  if (fit) state.map.fitTo(places);
  renderDetail();
}

function filterChips() {
  const f = (k, label, dot) =>
    `<button type="button" class="chip" data-action="filter" data-filter="${k}" aria-pressed="${state.filter === k}">${dot ?? ''}${label}</button>`;
  return `<div class="chips">${f('all', 'Alle')}${f('visited', state.mode === 'fjell' ? 'Besøkt' : 'Reist', '<span class="dot dot--solid"></span>')}${f('wish', 'Ønsker', '<span class="dot dot--wish"></span>')}</div>`;
}

function placeRow(p) {
  const thumb = p.photoList[0];
  const meta =
    p.status === 'wish'
      ? [p.elevation ? `${num(p.elevation)} moh.` : '', p.wish_season ? `Beste tid: ${esc(p.wish_season)}` : ''].filter(Boolean).join(' · ')
      : [fmtDate(p.lastVisit), p.elevation ? `${num(p.elevation)} moh.` : '', p.photoList.length ? `${p.photoList.length} bilder` : '']
          .filter(Boolean)
          .join(' · ');
  return `<button type="button" class="row ${p.status === 'wish' ? 'row--wish' : ''} ${state.selected?.id === p.id ? 'row--on' : ''}" data-action="select-place" data-id="${p.id}">
    <span class="thumb" ${thumb ? `data-thumb="${esc(thumb.thumb_path)}"` : ''}>${thumb ? '' : ICON.mountain}</span>
    <span class="row-text"><span class="row-title">${esc(p.name)}</span><span class="row-meta">${meta || KIND_LABEL[p.kind]}</span></span>
  </button>`;
}

function groupByYear(items, dateOf) {
  const out = new Map();
  for (const it of items) {
    const d = dateOf(it);
    const y = d ? new Date(d).getFullYear() : 'Uten dato';
    if (!out.has(y)) out.set(y, []);
    out.get(y).push(it);
  }
  return [...out.entries()].sort((a, b) => (b[0] === 'Uten dato' ? -1 : a[0] === 'Uten dato' ? 1 : b[0] - a[0]));
}

function sideFjell() {
  const all = state.places.filter((p) => p.mode === 'fjell');
  const visited = all.filter((p) => p.status === 'visited');
  const wish = all.filter((p) => p.status === 'wish');
  const peaks = visited.filter((p) => p.kind === 'topptur' || p.kind === 'toppskitur');
  const highest = Math.max(0, ...visited.map((p) => p.elevation ?? 0));
  const list = visiblePlaces();
  const vis = list.filter((p) => p.status === 'visited').sort((a, b) => (b.lastVisit ?? '').localeCompare(a.lastVisit ?? ''));
  const w = list.filter((p) => p.status === 'wish').sort((a, b) => (a.wish_priority ?? 9) - (b.wish_priority ?? 9));
  return `
    <div class="stats">
      <div class="stat"><b>${peaks.length}</b><span>topper</span></div>
      <div class="stat"><b>${highest ? num(highest) : '–'}</b><span>høyeste (moh.)</span></div>
      <div class="stat"><b>${wish.length}</b><span>på ønskelista</span></div>
    </div>
    ${filterChips()}
    <div class="list">
      ${groupByYear(vis, (p) => p.lastVisit).map(([y, ps]) => `<h3 class="eyebrow">${y}</h3>${ps.map(placeRow).join('')}`).join('')}
      ${w.length ? `<h3 class="eyebrow eyebrow--wish">Ønskeliste</h3>${w.map(placeRow).join('')}` : ''}
      ${!list.length ? emptyState('Ingen turer ennå', 'Legg til en tur, eller last opp bilder så foreslår vi turer ut fra hvor og når de er tatt.') : ''}
    </div>`;
}

function tripRow(t) {
  const stops = tripStops(t);
  const peaks = stops.filter((p) => p.mode === 'fjell').length;
  const thumb = state.photos.find((ph) => ph.trip_id === t.id);
  const meta = [fmtRange(t.start_date, t.end_date), nights(t.start_date, t.end_date) ? `${nights(t.start_date, t.end_date)} netter` : '', t.countries.join(', ')]
    .filter(Boolean)
    .join(' · ');
  return `<button type="button" class="row ${t.status === 'wish' ? 'row--wish' : ''} ${state.selected?.id === t.id ? 'row--on' : ''}" data-action="select-trip" data-id="${t.id}">
    <span class="thumb" ${thumb ? `data-thumb="${esc(thumb.thumb_path)}"` : ''}>${thumb ? '' : ICON.plane}</span>
    <span class="row-text"><span class="row-title">${esc(t.title)}</span><span class="row-meta">${meta || 'Uten dato'}${peaks ? ` · ${peaks} toppturer` : ''}</span></span>
  </button>`;
}

function sideReise() {
  const done = state.trips.filter((t) => t.status === 'done');
  const countries = new Set([
    ...done.flatMap((t) => t.countries),
    ...state.places.filter((p) => p.mode === 'reise' && p.status === 'visited' && p.country).map((p) => p.country)
  ]);
  const totalNights = done.reduce((s, t) => s + nights(t.start_date, t.end_date), 0);
  const trips = visibleTrips();
  const wishPlaces = visiblePlaces().filter((p) => p.status === 'wish');
  return `
    <div class="stats">
      <div class="stat"><b>${countries.size}</b><span>land</span></div>
      <div class="stat"><b>${done.length}</b><span>reiser</span></div>
      <div class="stat"><b>${totalNights}</b><span>netter borte</span></div>
    </div>
    ${filterChips()}
    <div class="list">
      ${groupByYear(trips.filter((t) => t.status === 'done'), (t) => t.start_date).map(([y, ts]) => `<h3 class="eyebrow">${y}</h3>${ts.map(tripRow).join('')}`).join('')}
      ${trips.some((t) => t.status === 'wish') || wishPlaces.length ? `<h3 class="eyebrow eyebrow--wish">Ønskeliste</h3>${trips.filter((t) => t.status === 'wish').map(tripRow).join('')}${wishPlaces.map(placeRow).join('')}` : ''}
      ${!trips.length && !wishPlaces.length ? emptyState('Ingen reiser ennå', 'Legg til en reise med datoer og land. Steder og toppturer kan kobles til reisen etterpå.') : ''}
    </div>`;
}

function emptyState(title, text) {
  return `<div class="empty"><b>${title}</b><p>${text}</p></div>`;
}

async function hydrateThumbs(root = document) {
  const els = [...root.querySelectorAll('[data-thumb]')].filter((e) => !e.dataset.loaded);
  if (!els.length) return;
  try {
    const urls = await signedUrls(els.map((e) => e.dataset.thumb));
    for (const e of els) {
      const u = urls[e.dataset.thumb];
      if (!u) continue;
      e.dataset.loaded = '1';
      if (e.tagName === 'IMG') e.src = u;
      else e.style.backgroundImage = `url("${u}")`;
    }
  } catch (err) {
    console.warn(err);
  }
}

// ---------- detail ----------
function select(type, id) {
  state.selected = { type, id };
  render();
  if (type === 'place') {
    const p = state.places.find((x) => x.id === id);
    if (p) {
      if (p.mode !== state.mode) {
        state.mode = p.mode;
        state.map.setMode(p.mode);
        render();
      }
      state.map.flyTo(p);
    }
  } else {
    const stops = tripStops(state.trips.find((t) => t.id === id) ?? {});
    if (stops.length) state.map.fitTo(stops);
  }
}

function renderDetail() {
  const el = $('#detail');
  const sel = state.selected;
  if (!sel) {
    el.hidden = true;
    hydrateThumbs();
    return;
  }
  el.hidden = false;
  el.innerHTML = sel.type === 'place' ? placeDetail(state.places.find((p) => p.id === sel.id)) : tripDetail(state.trips.find((t) => t.id === sel.id));
  hydrateThumbs();
}

function photoGrid(photos) {
  if (!photos.length) return '<p class="muted">Ingen bilder ennå.</p>';
  return `<div class="grid">${photos
    .map((ph) => `<button type="button" class="gthumb" data-action="open-photo" data-path="${esc(ph.storage_path)}" data-thumb="${esc(ph.thumb_path)}" aria-label="Åpne bilde"></button>`)
    .join('')}</div>`;
}

function placeDetail(p) {
  if (!p) return '';
  const trips = [...new Set(p.visitsList.map((v) => v.trip_id).filter(Boolean))].map((id) => state.trips.find((t) => t.id === id)).filter(Boolean);
  return `
    <div class="detail-head">
      <div class="chips-inline"><span class="tag">${KIND_LABEL[p.kind]}</span><span class="tag ${p.status === 'wish' ? 'tag--wish' : ''}">${p.status === 'wish' ? 'Ønsker' : 'Besøkt'}</span></div>
      <button type="button" class="icon-btn" data-action="close-detail" aria-label="Lukk">${ICON.close}</button>
    </div>
    <h2>${esc(p.name)}</h2>
    <p class="muted">${[p.elevation ? `${num(p.elevation)} moh.` : '', p.country].filter(Boolean).join(' · ')}</p>
    ${p.status === 'wish' && (p.wish_season || p.wish_priority) ? `<p>${p.wish_season ? `Beste tid: ${esc(p.wish_season)}. ` : ''}${p.wish_priority ? `Prioritet: ${['', 'høy', 'middels', 'lav'][p.wish_priority]}.` : ''}</p>` : ''}
    ${p.notes ? `<p class="note">${esc(p.notes)}</p>` : ''}
    ${p.visitsList.length ? `<h3 class="eyebrow">Besøk</h3><ul class="visits">${p.visitsList
      .map(
        (v) => `<li><b>${v.visited_on ? fmtDate(v.visited_on) : 'Uten dato'}</b>
        ${[v.distance_km ? `${num(v.distance_km)} km` : '', v.ascent_m ? `${num(v.ascent_m)} hm` : '', v.duration_min ? `${Math.floor(v.duration_min / 60)} t ${v.duration_min % 60} min` : ''].filter(Boolean).join(' · ')}
        ${v.notes ? `<p>${esc(v.notes)}</p>` : ''}</li>`
      )
      .join('')}</ul>` : ''}
    ${trips.map((t) => `<button type="button" class="link-card" data-action="select-trip" data-id="${t.id}">${ICON.plane}<span>Del av reisen <b>${esc(t.title)}</b></span></button>`).join('')}
    <h3 class="eyebrow">Bilder</h3>
    ${photoGrid(p.photoList)}
    <div class="detail-actions">
      <button type="button" class="btn btn--dark" data-action="edit-place" data-id="${p.id}">Rediger</button>
      <button type="button" class="btn btn--ghost" data-action="add-visit" data-id="${p.id}">${p.status === 'wish' ? 'Marker som besøkt' : 'Legg til besøk'}</button>
      <button type="button" class="btn btn--danger" data-action="delete-place" data-id="${p.id}">Slett</button>
    </div>`;
}

function tripDetail(t) {
  if (!t) return '';
  const stops = tripStops(t);
  const photos = state.photos.filter((ph) => ph.trip_id === t.id);
  return `
    <div class="detail-head">
      <div class="chips-inline"><span class="tag tag--trip">Reise</span>${t.status === 'wish' ? '<span class="tag tag--wish">Ønsker</span>' : ''}</div>
      <button type="button" class="icon-btn" data-action="close-detail" aria-label="Lukk">${ICON.close}</button>
    </div>
    <h2>${esc(t.title)}</h2>
    <p class="muted">${[fmtRange(t.start_date, t.end_date), nights(t.start_date, t.end_date) ? `${nights(t.start_date, t.end_date)} netter` : '', t.countries.join(', ')].filter(Boolean).join(' · ')}</p>
    ${t.notes ? `<p class="note">${esc(t.notes)}</p>` : ''}
    <h3 class="eyebrow">Steder på reisen</h3>
    ${stops.length ? stops.map(placeRow).join('') : '<p class="muted">Ingen steder koblet til ennå. Legg til et sted og velg denne reisen.</p>'}
    <h3 class="eyebrow">Bilder</h3>
    ${photoGrid(photos)}
    <div class="detail-actions">
      <button type="button" class="btn btn--dark" data-action="edit-trip" data-id="${t.id}">Rediger</button>
      <button type="button" class="btn btn--danger" data-action="delete-trip" data-id="${t.id}">Slett</button>
    </div>`;
}

// ---------- dialogs ----------
function openDialog(html, onMount) {
  const d = $('#dlg');
  d.innerHTML = `<div class="dlg-inner">${html}</div>`;
  if (!d.open) d.showModal();
  onMount?.(d);
  return d;
}
const closeDialog = () => $('#dlg').open && $('#dlg').close();

function tripOptions(selected) {
  return `<option value="">Ingen reise</option>${state.trips
    .map((t) => `<option value="${t.id}" ${t.id === selected ? 'selected' : ''}>${esc(t.title)}${t.start_date ? ` (${fmtDate(t.start_date)})` : ''}</option>`)
    .join('')}`;
}

function placeForm(existing = null, preset = {}) {
  const p = existing ?? { mode: state.mode, kind: state.mode === 'fjell' ? 'topptur' : 'sted', status: 'visited', ...preset };
  const kinds = state.mode === 'fjell' || p.mode === 'fjell' ? ['topptur', 'skitur', 'toppskitur', 'fjelltur', 'sykkeltur', 'padletur', 'klatring', 'utsikt', 'hytte', 'sted'] : ['sted', 'by', 'overnatting', 'utsikt', 'topptur'];
  const allKinds = [...new Set([...kinds, ...Object.keys(KIND_LABEL)])];
  openDialog(
    `<form id="place-form" class="form">
      <div class="dlg-head"><h2>${existing ? 'Rediger sted' : state.mode === 'fjell' ? 'Ny tur' : 'Nytt sted'}</h2>
      <button type="button" class="icon-btn" data-action="close-dlg" aria-label="Lukk">${ICON.close}</button></div>
      <label class="field"><span>Søk etter sted</span>
        <input id="pf-search" type="search" autocomplete="off" placeholder="F.eks. Slogen eller Reine" />
      </label>
      <div id="pf-results" class="results" role="listbox"></div>
      <div class="field-row">
        <label class="field"><span>Navn</span><input id="pf-name" required value="${esc(p.name)}" /></label>
        <label class="field field--sm"><span>Høyde (moh.)</span><input id="pf-ele" type="number" inputmode="numeric" value="${p.elevation ?? ''}" /></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Breddegrad</span><input id="pf-lat" required inputmode="decimal" value="${p.lat ?? ''}" /></label>
        <label class="field"><span>Lengdegrad</span><input id="pf-lon" required inputmode="decimal" value="${p.lon ?? ''}" /></label>
        <button type="button" class="btn btn--ghost btn--self" id="pf-pick">Velg i kartet</button>
      </div>
      <div class="preview" id="pf-preview"></div>
      <div class="field-row">
        <label class="field"><span>Visning</span><select id="pf-mode"><option value="fjell" ${p.mode === 'fjell' ? 'selected' : ''}>Fjell</option><option value="reise" ${p.mode === 'reise' ? 'selected' : ''}>Reise</option></select></label>
        <label class="field"><span>Type</span><select id="pf-kind">${allKinds.map((k) => `<option value="${k}" ${p.kind === k ? 'selected' : ''}>${KIND_LABEL[k]}</option>`).join('')}</select></label>
        <label class="field"><span>Status</span><select id="pf-status"><option value="visited" ${p.status === 'visited' ? 'selected' : ''}>Besøkt</option><option value="wish" ${p.status === 'wish' ? 'selected' : ''}>Ønsker å dra</option></select></label>
      </div>
      <label class="field"><span>Land</span><input id="pf-country" value="${esc(p.country ?? '')}" /></label>
      <div class="wish-only field-row">
        <label class="field"><span>Beste tid</span><input id="pf-season" placeholder="F.eks. jul–aug" value="${esc(p.wish_season ?? '')}" /></label>
        <label class="field"><span>Prioritet</span><select id="pf-prio"><option value="">–</option>${[1, 2, 3].map((n) => `<option value="${n}" ${p.wish_priority === n ? 'selected' : ''}>${['', 'Høy', 'Middels', 'Lav'][n]}</option>`).join('')}</select></label>
      </div>
      ${existing ? '' : `<fieldset class="visit-only"><legend>Besøk</legend>
        <div class="field-row">
          <label class="field"><span>Dato</span><input id="pf-date" type="date" value="${preset.date ?? ''}" /></label>
          <label class="field"><span>Reise</span><select id="pf-trip">${tripOptions(preset.trip_id)}</select></label>
        </div></fieldset>`}
      <label class="field"><span>Notat</span><textarea id="pf-notes" rows="3">${esc(p.notes ?? '')}</textarea></label>
      <div class="dlg-actions"><button type="button" class="btn btn--ghost" data-action="close-dlg">Avbryt</button><button type="submit" class="btn btn--dark">Lagre</button></div>
    </form>`,
    (d) => {
      const form = $('#place-form', d);
      const statusSel = $('#pf-status', d);
      const updatePreview = mountPreview($('#pf-preview', d), parseFloat(p.lat), parseFloat(p.lon));
      const syncFromFields = () => updatePreview(parseFloat($('#pf-lat', d).value.replace(',', '.')), parseFloat($('#pf-lon', d).value.replace(',', '.')));
      $('#pf-lat', d).addEventListener('change', syncFromFields);
      $('#pf-lon', d).addEventListener('change', syncFromFields);
      const syncStatus = () => form.classList.toggle('is-wish', statusSel.value === 'wish');
      statusSel.addEventListener('change', syncStatus);
      syncStatus();
      let timer;
      $('#pf-search', d).addEventListener('input', (e) => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const res = await searchPlaces(e.target.value);
          $('#pf-results', d).innerHTML = res
            .slice(0, 10)
            .map((r, i) => `<button type="button" class="result" data-i="${i}"><b>${esc(r.name)}</b><span>${esc(r.detail)}</span></button>`)
            .join('');
          $('#pf-results', d).onclick = async (ev) => {
            const b = ev.target.closest('.result');
            if (!b) return;
            const r = res[Number(b.dataset.i)];
            $('#pf-name', d).value = r.name;
            $('#pf-lat', d).value = r.lat.toFixed(5);
            $('#pf-lon', d).value = r.lon.toFixed(5);
            updatePreview(r.lat, r.lon);
            if (r.country) $('#pf-country', d).value = r.country;
            $('#pf-results', d).innerHTML = '';
            if (!$('#pf-ele', d).value) {
              const z = await elevationFor(r.lat, r.lon);
              if (z != null) $('#pf-ele', d).value = z;
            }
          };
        }, 350);
      });
      $('#pf-pick', d).addEventListener('click', () => {
        const snapshot = collectPlace(d);
        closeDialog();
        state.picking = async (ll) => {
          const guess = await nameForPoint(ll.lat, ll.lng);
          const z = await elevationFor(ll.lat, ll.lng);
          placeForm(existing, {
            ...snapshot,
            name: snapshot.name || guess.name,
            country: snapshot.country || guess.country,
            elevation: snapshot.elevation ?? z,
            lat: Number(ll.lat.toFixed(5)),
            lon: Number(ll.lng.toFixed(5))
          });
        };
        $('#pick-banner').hidden = false;
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = collectPlace(d);
        if (Number.isNaN(data.lat) || Number.isNaN(data.lon)) return toast('Sett en gyldig posisjon.', 'err');
        const { date, trip_id, ...row } = data;
        try {
          let id = existing?.id;
          if (existing) {
            const { error } = await supabase.from('places').update(row).eq('id', id);
            if (error) throw error;
          } else {
            const { data: ins, error } = await supabase.from('places').insert(row).select('id').single();
            if (error) throw error;
            id = ins.id;
            if (row.status === 'visited' && (date || trip_id)) {
              const { error: e2 } = await supabase.from('visits').insert({ place_id: id, visited_on: date || null, trip_id: trip_id || null });
              if (e2) throw e2;
            }
          }
          closeDialog();
          await loadData();
          state.mode = row.mode;
          state.map.setMode(row.mode);
          select('place', id);
          toast('Lagret');
        } catch (err) {
          toast(`Kunne ikke lagre: ${err.message}`, 'err');
        }
      });
    }
  );
}

function collectPlace(d) {
  const v = (id) => $(id, d)?.value?.trim() ?? '';
  const ele = v('#pf-ele');
  const prio = v('#pf-prio');
  return {
    name: v('#pf-name'),
    lat: parseFloat(v('#pf-lat').replace(',', '.')),
    lon: parseFloat(v('#pf-lon').replace(',', '.')),
    elevation: ele ? parseInt(ele, 10) : null,
    mode: v('#pf-mode'),
    kind: v('#pf-kind'),
    status: v('#pf-status'),
    country: v('#pf-country') || null,
    wish_season: v('#pf-season') || null,
    wish_priority: prio ? Number(prio) : null,
    notes: v('#pf-notes') || null,
    date: v('#pf-date') || null,
    trip_id: v('#pf-trip') || null
  };
}

function visitForm(place) {
  openDialog(
    `<form id="visit-form" class="form">
      <div class="dlg-head"><h2>Besøk – ${esc(place.name)}</h2><button type="button" class="icon-btn" data-action="close-dlg" aria-label="Lukk">${ICON.close}</button></div>
      <div class="field-row">
        <label class="field"><span>Dato</span><input id="vf-date" type="date" required /></label>
        <label class="field"><span>Reise</span><select id="vf-trip">${tripOptions()}</select></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Lengde (km)</span><input id="vf-km" inputmode="decimal" /></label>
        <label class="field"><span>Høydemeter</span><input id="vf-hm" type="number" inputmode="numeric" /></label>
        <label class="field"><span>Tid (minutter)</span><input id="vf-min" type="number" inputmode="numeric" /></label>
      </div>
      <label class="field"><span>Notat</span><textarea id="vf-notes" rows="3"></textarea></label>
      <div class="dlg-actions"><button type="button" class="btn btn--ghost" data-action="close-dlg">Avbryt</button><button type="submit" class="btn btn--dark">Lagre besøk</button></div>
    </form>`,
    (d) =>
      $('#visit-form', d).addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = (id) => $(id, d).value.trim();
        try {
          const { error } = await supabase.from('visits').insert({
            place_id: place.id,
            visited_on: v('#vf-date'),
            trip_id: v('#vf-trip') || null,
            distance_km: v('#vf-km') ? parseFloat(v('#vf-km').replace(',', '.')) : null,
            ascent_m: v('#vf-hm') ? parseInt(v('#vf-hm'), 10) : null,
            duration_min: v('#vf-min') ? parseInt(v('#vf-min'), 10) : null,
            notes: v('#vf-notes') || null
          });
          if (error) throw error;
          if (place.status === 'wish') await supabase.from('places').update({ status: 'visited' }).eq('id', place.id);
          closeDialog();
          await loadData();
          render();
          toast('Besøk lagret');
        } catch (err) {
          toast(`Kunne ikke lagre: ${err.message}`, 'err');
        }
      })
  );
}

function tripForm(existing = null) {
  const t = existing ?? { status: 'done', countries: [] };
  openDialog(
    `<form id="trip-form" class="form">
      <div class="dlg-head"><h2>${existing ? 'Rediger reise' : 'Ny reise'}</h2><button type="button" class="icon-btn" data-action="close-dlg" aria-label="Lukk">${ICON.close}</button></div>
      <label class="field"><span>Tittel</span><input id="tf-title" required placeholder="F.eks. Lofoten" value="${esc(t.title)}" /></label>
      <div class="field-row">
        <label class="field"><span>Fra</span><input id="tf-start" type="date" value="${t.start_date ?? ''}" /></label>
        <label class="field"><span>Til</span><input id="tf-end" type="date" value="${t.end_date ?? ''}" /></label>
        <label class="field"><span>Status</span><select id="tf-status"><option value="done" ${t.status === 'done' ? 'selected' : ''}>Reist</option><option value="wish" ${t.status === 'wish' ? 'selected' : ''}>Ønsker</option></select></label>
      </div>
      <label class="field"><span>Land (kommaseparert)</span><input id="tf-countries" placeholder="Norge, Portugal" value="${esc(t.countries.join(', '))}" /></label>
      <label class="field"><span>Notat</span><textarea id="tf-notes" rows="3">${esc(t.notes ?? '')}</textarea></label>
      <div class="dlg-actions"><button type="button" class="btn btn--ghost" data-action="close-dlg">Avbryt</button><button type="submit" class="btn btn--dark">Lagre</button></div>
    </form>`,
    (d) =>
      $('#trip-form', d).addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = (id) => $(id, d).value.trim();
        const row = {
          title: v('#tf-title'),
          start_date: v('#tf-start') || null,
          end_date: v('#tf-end') || null,
          status: v('#tf-status'),
          countries: v('#tf-countries') ? v('#tf-countries').split(',').map((s) => s.trim()).filter(Boolean) : [],
          notes: v('#tf-notes') || null
        };
        try {
          let id = existing?.id;
          if (existing) {
            const { error } = await supabase.from('trips').update(row).eq('id', id);
            if (error) throw error;
          } else {
            const { data, error } = await supabase.from('trips').insert(row).select('id').single();
            if (error) throw error;
            id = data.id;
          }
          closeDialog();
          await loadData();
          state.mode = 'reise';
          state.map.setMode('reise');
          select('trip', id);
          toast('Lagret');
        } catch (err) {
          toast(`Kunne ikke lagre: ${err.message}`, 'err');
        }
      })
  );
}

function confirmDialog(text, onYes) {
  openDialog(
    `<div class="form"><div class="dlg-head"><h2>Er du sikker?</h2></div><p>${text}</p>
      <div class="dlg-actions"><button type="button" class="btn btn--ghost" data-action="close-dlg">Avbryt</button><button type="button" class="btn btn--danger" id="confirm-yes">Slett</button></div></div>`,
    (d) => $('#confirm-yes', d).addEventListener('click', async () => {
      closeDialog();
      await onYes();
    })
  );
}

// ---------- upload wizard ----------
function uploadWizard() {
  openDialog(
    `<div class="form upl">
      <div class="dlg-head"><h2>Last opp bilder</h2><button type="button" class="icon-btn" data-action="close-dlg" aria-label="Lukk">${ICON.close}</button></div>
      <div id="upl-body">
        <label class="drop" id="drop">
          <input type="file" id="upl-files" multiple accept="image/*,.heic,.heif" />
          <b>Dra bilder eller en hel mappe hit</b>
          <span>eller trykk for å velge. JPEG, PNG og iPhone-bilder (HEIC).</span>
        </label>
        <p class="hint">På iPhone: trykk <b>Valg</b> øverst i bildevelgeren og slå på <b>Posisjon</b>, ellers mangler bildene plassering.</p>
        <label class="btn btn--ghost btn--file">Velg mappe<input type="file" id="upl-dir" webkitdirectory multiple /></label>
      </div>
    </div>`,
    (d) => {
      const go = (files) => runUpload([...files].filter(isImageFile), d);
      $('#upl-files', d).addEventListener('change', (e) => go(e.target.files));
      $('#upl-dir', d).addEventListener('change', (e) => go(e.target.files));
      const drop = $('#drop', d);
      drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('drop--over')));
      drop.addEventListener('dragleave', () => drop.classList.remove('drop--over'));
      drop.addEventListener('drop', async (e) => {
        e.preventDefault();
        drop.classList.remove('drop--over');
        go(await filesFromDrop(e.dataTransfer));
      });
    }
  );
}

async function filesFromDrop(dt) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  async function walk(entry) {
    if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e);
      } while (batch.length);
    }
  }
  for (const e of entries) await walk(e);
  return out;
}

async function runUpload(files, d) {
  const body = $('#upl-body', d);
  if (!files.length) return toast('Fant ingen bilder i utvalget.', 'err');
  const progress = (label, done, total) => {
    body.innerHTML = `<p><b>${label}</b> ${done} av ${total}</p><progress max="${total}" value="${done}"></progress><div class="strip" id="strip"></div>`;
  };
  // 1. Les og forbered
  const items = [];
  let failed = 0;
  progress('Leser bilder …', 0, files.length);
  for (let i = 0; i < files.length; i++) {
    try {
      items.push(await processFile(files[i]));
    } catch (err) {
      console.warn(files[i].name, err);
      failed++;
    }
    progress('Leser bilder …', i + 1, files.length);
  }
  // 2. Duplikater
  const seen = new Set();
  const unique = items.filter((i) => !seen.has(i.sha256) && seen.add(i.sha256));
  const existing = await existingHashes(unique.map((i) => i.sha256));
  const fresh = unique.filter((i) => !existing.has(i.sha256));
  const skipped = items.length - fresh.length;
  // 3. Last opp
  progress('Laster opp …', 0, fresh.length);
  await uploadAll(fresh, (done, total) => progress('Laster opp …', done, total));
  const ok = fresh.filter((i) => i.id);
  const errors = fresh.length - ok.length + failed;
  const noPos = ok.filter((i) => i.lat == null).length;
  // 4. Grupper
  body.innerHTML = '<p><b>Lager forslag …</b> Finner stedsnavn for gruppene.</p><progress></progress>';
  const { groups, unsorted } = clusterPhotos(ok);
  await suggestForGroups(groups, state.places);
  await loadData();
  render();
  body.innerHTML = `
    <div class="summary">
      <span><b>${ok.length}</b> lastet opp</span>
      ${skipped ? `<span><b>${skipped}</b> fantes fra før</span>` : ''}
      ${errors ? `<span class="warn"><b>${errors}</b> feilet</span>` : ''}
      ${noPos ? `<span class="warn"><b>${noPos}</b> uten posisjon</span>` : ''}
    </div>
    ${groups.length ? `<p>Vi fant <b>${groups.length}</b> mulige turer. Se over forslagene og lagre.</p>` : '<p>Ingen av bildene hadde dato eller posisjon, så de ligger i Usortert.</p>'}
    <div class="groups">${groups.map((g, i) => groupCard(g, i)).join('')}</div>
    ${unsorted.length ? `<p class="muted">${unsorted.length} bilder uten dato og posisjon legges i Usortert, der du kan plassere dem selv.</p>` : ''}
    <div class="dlg-actions"><button type="button" class="btn btn--ghost" data-action="close-dlg">Lukk</button>${groups.length ? '<button type="button" class="btn btn--dark" id="save-groups">Lagre turer</button>' : ''}</div>`;
  body.querySelectorAll('.g-choice').forEach((sel) =>
    sel.addEventListener('change', () => (sel.closest('.gcard').dataset.choice = sel.value === 'new' ? 'new' : sel.value === 'skip' ? 'skip' : 'existing'))
  );
  body.querySelectorAll('.g-trip').forEach((sel) =>
    sel.addEventListener('change', () => {
      const card = sel.closest('.gcard');
      $('.g-newtrip', card).hidden = sel.value !== '__new';
    })
  );
  const previews = groups.map((g, i) => mountPreview($(`#g${i}-preview`, d), g.center?.lat, g.center?.lon));
  groups.forEach((g, i) => {
    const input = $(`#g${i}-search`, d);
    if (!input) return;
    let timer;
    input.addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const res = await searchPlaces(e.target.value);
        const box = $(`#g${i}-results`, d);
        box.innerHTML = res.slice(0, 8).map((r, j) => `<button type="button" class="result" data-j="${j}"><b>${esc(r.name)}</b><span>${esc(r.detail)}</span></button>`).join('');
        box.onclick = (ev) => {
          const b = ev.target.closest('.result');
          if (!b) return;
          const r = res[Number(b.dataset.j)];
          $(`#g${i}-name`, d).value = r.name;
          $(`#g${i}-lat`, d).value = r.lat.toFixed(5);
          $(`#g${i}-lon`, d).value = r.lon.toFixed(5);
          g.suggestion = { ...g.suggestion, country: r.country ?? g.suggestion?.country };
          previews[i](r.lat, r.lon);
          box.innerHTML = '';
        };
      }, 350);
    });
  });
  $('#save-groups', d)?.addEventListener('click', () => saveGroups(groups, d));
}

function groupCard(g, i) {
  const date = g.start ? fmtRange(isoDay(g.start), isoDay(g.end)) : 'Ukjent dato';
  const s = g.suggestion ?? { name: 'Ukjent sted' };
  const mode = s.country && s.country !== 'Norge' ? 'reise' : 'fjell';
  const kind = mode === 'fjell' ? (s.isPeak ? 'topptur' : 'fjelltur') : 'sted';
  return `<div class="gcard" data-i="${i}" data-choice="${g.nearby.length ? 'existing' : 'new'}">
    <div class="gstrip">${g.items.slice(0, 6).map((it) => `<img alt="" src="${it.thumbUrl}" />`).join('')}${g.items.length > 6 ? `<span>+${g.items.length - 6}</span>` : ''}</div>
    <p class="gmeta"><b>${g.items.length} bilder</b> · ${date}</p>
    ${g.noPosition ? `<p class="warnbox">Bildene mangler posisjon. Søk opp stedet under, så lagres turen likevel. <span class="muted">Tips: På iPhone, trykk <b>Valg</b> øverst i bildevelgeren og slå på <b>Posisjon</b>.</span></p>` : ''}
    <label class="field"><span>Hva er dette?</span>
      <select class="g-choice" id="g${i}-choice">
        ${g.nearby.length ? g.nearby.map((p, j) => `<option value="existing:${p.id}" ${j === 0 ? 'selected' : ''}>Besøk på ${esc(p.name)}</option>`).join('') : ''}
        <option value="new" ${g.nearby.length ? '' : 'selected'}>Nytt sted</option>
        <option value="skip">Hopp over (legg i Usortert)</option>
      </select></label>
    <div class="preview preview--sm" id="g${i}-preview"></div>
    ${g.noPosition ? `<div class="g-new"><label class="field"><span>Søk etter sted</span><input id="g${i}-search" type="search" autocomplete="off" placeholder="F.eks. Gaustatoppen" /></label><div id="g${i}-results" class="results"></div></div>` : ''}
    <div class="field-row g-new">
      <label class="field"><span>Navn</span><input id="g${i}-name" value="${esc(s.name)}" placeholder="${g.noPosition ? 'Velg fra søket over' : ''}" /></label>
      <input type="hidden" id="g${i}-lat" value="${g.center ? g.center.lat.toFixed(5) : ''}" /><input type="hidden" id="g${i}-lon" value="${g.center ? g.center.lon.toFixed(5) : ''}" />
    </div>
    <div class="field-row g-new">
      <label class="field"><span>Visning</span><select id="g${i}-mode"><option value="fjell" ${mode === 'fjell' ? 'selected' : ''}>Fjell</option><option value="reise" ${mode === 'reise' ? 'selected' : ''}>Reise</option></select></label>
      <label class="field"><span>Type</span><select id="g${i}-kind">${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <label class="field"><span>Reise</span><select id="g${i}-trip" class="g-trip">${tripOptions(matchTrip(g)?.id)}<option value="__new">+ Ny reise …</option></select></label>
    <div class="field-row g-newtrip" hidden>
      <label class="field"><span>Reisens tittel</span><input id="g${i}-trip-title" placeholder="F.eks. Rjukan-helg" /></label>
      <label class="field field--sm"><span>Fra</span><input id="g${i}-trip-start" type="date" value="${g.start ? isoDay(g.start) : ''}" /></label>
      <label class="field field--sm"><span>Til</span><input id="g${i}-trip-end" type="date" value="${g.end ? isoDay(g.end) : ''}" /></label>
    </div>
  </div>`;
}

function matchTrip(g) {
  if (!g.start) return null;
  const day = isoDay(g.start);
  return state.trips.find((t) => t.start_date && t.end_date && t.start_date <= day && day <= t.end_date) ?? null;
}

async function saveGroups(groups, d) {
  const btn = $('#save-groups', d);
  btn.disabled = true;
  btn.textContent = 'Lagrer …';
  let saved = 0;
  try {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const choice = $(`#g${i}-choice`, d).value;
      if (choice === 'skip') continue;
      let tripId = $(`#g${i}-trip`, d).value || null;
      if (tripId === '__new') {
        const title = $(`#g${i}-trip-title`, d).value.trim();
        if (!title) {
          toast(`Gruppe ${i + 1}: gi reisen en tittel.`, 'err');
          btn.disabled = false;
          btn.textContent = 'Lagre turer';
          return;
        }
        const existing = state.trips.find((t) => t.title.toLowerCase() === title.toLowerCase());
        if (existing) tripId = existing.id;
        else {
          const { data, error } = await supabase
            .from('trips')
            .insert({
              title,
              start_date: $(`#g${i}-trip-start`, d).value || null,
              end_date: $(`#g${i}-trip-end`, d).value || null,
              status: 'done',
              countries: g.suggestion?.country ? [g.suggestion.country] : []
            })
            .select('*')
            .single();
          if (error) throw error;
          state.trips.push(data);
          tripId = data.id;
        }
      }
      const day = g.start ? isoDay(g.start) : null;
      let placeId;
      if (choice.startsWith('existing:')) {
        placeId = choice.slice(9);
      } else {
        const lat = parseFloat($(`#g${i}-lat`, d).value);
        const lon = parseFloat($(`#g${i}-lon`, d).value);
        if (Number.isNaN(lat) || Number.isNaN(lon)) {
          toast(`Gruppe ${i + 1}: søk opp og velg et sted først.`, 'err');
          btn.disabled = false;
          btn.textContent = 'Lagre turer';
          return;
        }
        const elevation = g.suggestion?.country === 'Norge' ? await elevationFor(lat, lon) : null;
        const { data, error } = await supabase
          .from('places')
          .insert({
            name: $(`#g${i}-name`, d).value.trim() || 'Ukjent sted',
            mode: $(`#g${i}-mode`, d).value,
            kind: $(`#g${i}-kind`, d).value,
            status: 'visited',
            lat,
            lon,
            elevation,
            country: g.suggestion?.country ?? null
          })
          .select('id')
          .single();
        if (error) throw error;
        placeId = data.id;
      }
      // Gjenbruk besøk samme dag, ellers nytt besøk
      let visit = state.visits.find((v) => v.place_id === placeId && v.visited_on === day);
      if (!visit) {
        const { data, error } = await supabase.from('visits').insert({ place_id: placeId, visited_on: day, trip_id: tripId }).select('*').single();
        if (error) throw error;
        visit = data;
        state.visits.push(data);
      }
      await supabase.from('places').update({ status: 'visited' }).eq('id', placeId).eq('status', 'wish');
      const ids = g.items.map((it) => it.id);
      const { error } = await supabase.from('photos').update({ place_id: placeId, visit_id: visit.id, trip_id: tripId }).in('id', ids);
      if (error) throw error;
      saved++;
    }
    closeDialog();
    await loadData();
    render({ fit: true });
    toast(`${saved} turer lagret`);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Lagre turer';
    toast(`Kunne ikke lagre: ${err.message}`, 'err');
  }
}

// ---------- inbox ----------
function inbox() {
  const photos = state.photos.filter((p) => !p.place_id && !p.trip_id);
  const placeOpts = [...state.places]
    .sort((a, b) => a.name.localeCompare(b.name, 'nb'))
    .map((p) => `<option value="p:${p.id}">${esc(p.name)} (${p.mode === 'fjell' ? 'fjell' : 'reise'})</option>`)
    .join('');
  const tripOpts = state.trips.map((t) => `<option value="t:${t.id}">Reise: ${esc(t.title)}</option>`).join('');
  openDialog(
    `<div class="form">
      <div class="dlg-head"><h2>Usortert (${photos.length})</h2><button type="button" class="icon-btn" data-action="close-dlg" aria-label="Lukk">${ICON.close}</button></div>
      ${photos.length ? `<p class="muted">Bilder uten posisjon eller som ble hoppet over. Velg bilder og koble dem til et sted eller en reise.</p>
      <div class="inbox-grid">${photos
        .map((p) => `<label class="ithumb"><input type="checkbox" value="${p.id}" /><img alt="" data-thumb="${esc(p.thumb_path)}" /><span>${p.taken_at ? fmtDate(p.taken_at) : 'Uten dato'}</span></label>`)
        .join('')}</div>
      <div class="field-row">
        <label class="field"><span>Koble valgte til</span><select id="ib-target">${placeOpts}${tripOpts}</select></label>
        <button type="button" class="btn btn--dark btn--self" id="ib-apply">Koble til</button>
        <button type="button" class="btn btn--danger btn--self" id="ib-delete">Slett valgte</button>
      </div>` : emptyState('Alt er sortert', 'Bilder uten posisjon havner her etter opplasting.')}
    </div>`,
    (d) => {
      hydrateThumbs(d);
      $('#ib-apply', d)?.addEventListener('click', async () => {
        const ids = [...d.querySelectorAll('.ithumb input:checked')].map((i) => i.value);
        const target = $('#ib-target', d).value;
        if (!ids.length || !target) return toast('Velg minst ett bilde og et mål.', 'err');
        const [type, id] = target.split(':');
        let patch;
        if (type === 'p') {
          const visit = state.visits.find((v) => v.place_id === id);
          patch = { place_id: id, visit_id: visit?.id ?? null, trip_id: visit?.trip_id ?? null };
        } else patch = { trip_id: id };
        const { error } = await supabase.from('photos').update(patch).in('id', ids);
        if (error) return toast(`Kunne ikke lagre: ${error.message}`, 'err');
        await loadData();
        render();
        inbox();
        toast(`${ids.length} bilder koblet`);
      });
      $('#ib-delete', d)?.addEventListener('click', () => {
        const ids = [...d.querySelectorAll('.ithumb input:checked')].map((i) => i.value);
        if (!ids.length) return toast('Velg minst ett bilde.', 'err');
        confirmDialog(`${ids.length} ${ids.length === 1 ? 'bilde' : 'bilder'} slettes permanent fra Turkart. Originalene i iCloud påvirkes ikke.`, async () => {
          await deletePhotos(ids);
          inbox();
        });
      });
    }
  );
}

/** Slett bilder: filer i lagringen og raden i databasen. */
async function deletePhotos(ids) {
  const rows = state.photos.filter((p) => ids.includes(p.id));
  const paths = rows.flatMap((p) => [p.storage_path, p.thumb_path]);
  if (paths.length) {
    const { error } = await supabase.storage.from(BUCKET).remove(paths);
    if (error) return toast(`Kunne ikke slette filer: ${error.message}`, 'err');
  }
  const { error } = await supabase.from('photos').delete().in('id', ids);
  if (error) return toast(`Kunne ikke slette: ${error.message}`, 'err');
  await loadData();
  render();
  toast(ids.length === 1 ? 'Bildet er slettet' : `${ids.length} bilder slettet`);
}

// ---------- notater ----------
const NOTE_KIND = { feedback: 'Feedback', ide: 'Idé', notat: 'Notat' };

function currentContext() {
  const parts = [state.mode === 'fjell' ? 'Fjell' : 'Reise'];
  const sel = state.selected;
  if (sel?.type === 'place') parts.push(state.places.find((p) => p.id === sel.id)?.name);
  if (sel?.type === 'trip') parts.push(state.trips.find((t) => t.id === sel.id)?.title);
  if ($('#dlg')?.open && $('#dlg h2')) parts.push($('#dlg h2').textContent);
  return parts.filter(Boolean).join(' · ');
}

function notesDialog(context = currentContext()) {
  const f = state.notesFilter;
  const list = state.notes.filter((n) => (f === 'open' ? !n.done : f === 'done' ? n.done : true));
  const openCount = state.notes.filter((n) => !n.done).length;
  const doneCount = state.notes.length - openCount;
  const who = (email) => (email === userEmail() ? 'deg' : (email ?? '').split('@')[0]);
  openDialog(
    `<div class="form notes">
      <div class="dlg-head"><h2>Notater</h2><button type="button" class="icon-btn" data-action="close-dlg" aria-label="Lukk">${ICON.close}</button></div>
      <form id="note-form" class="note-new">
        <label class="field"><span>Nytt notat</span><textarea id="note-body" rows="3" required placeholder="F.eks. «Navneforslaget ble feil for Storeble»"></textarea></label>
        <div class="field-row">
          <div class="seg seg--sm" role="group" aria-label="Type">
            ${Object.entries(NOTE_KIND).map(([k, l], i) => `<label class="seg-opt"><input type="radio" name="note-kind" value="${k}" ${i === 0 ? 'checked' : ''} /><span>${l}</span></label>`).join('')}
          </div>
          <button type="submit" class="btn btn--dark btn--self">Legg til</button>
        </div>
        ${context ? `<p class="muted note-ctx">Lagres med kontekst: ${esc(context)}</p>` : ''}
      </form>
      <div class="chips">
        <button type="button" class="chip" data-action="notes-filter" data-filter="open" aria-pressed="${f === 'open'}">Åpne (${openCount})</button>
        <button type="button" class="chip" data-action="notes-filter" data-filter="done" aria-pressed="${f === 'done'}">Ferdige (${doneCount})</button>
        <button type="button" class="chip" data-action="notes-filter" data-filter="all" aria-pressed="${f === 'all'}">Alle</button>
      </div>
      <ul class="note-list">
        ${list.length ? list.map((n) => `<li class="note ${n.done ? 'note--done' : ''}">
          <label class="note-check"><input type="checkbox" data-note-done="${n.id}" ${n.done ? 'checked' : ''} aria-label="Marker som ferdig" /></label>
          <div class="note-main">
            <p class="note-body">${esc(n.body)}</p>
            <p class="note-meta"><span class="tag tag--${n.kind}">${NOTE_KIND[n.kind] ?? n.kind}</span> ${fmtDate(n.created_at)} · ${esc(who(n.author_email))}${n.context ? ` · ${esc(n.context)}` : ''}</p>
          </div>
          <button type="button" class="icon-btn icon-btn--sm" data-note-delete="${n.id}" aria-label="Slett notat">${ICON.trash}</button>
        </li>`).join('') : `<li>${emptyState(f === 'done' ? 'Ingen ferdige notater' : 'Ingen åpne notater', 'Skriv ned ting du legger merke til mens du bruker appen.')}</li>`}
      </ul>
    </div>`,
    (d) => {
      $('#note-body', d).focus();
      $('#note-form', d).addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = $('#note-body', d).value.trim();
        if (!body) return;
        const kind = d.querySelector('input[name="note-kind"]:checked')?.value ?? 'feedback';
        const { error } = await supabase.from('notes').insert({ body, kind, context: context || null });
        if (error) return toast(`Kunne ikke lagre: ${error.message}`, 'err');
        await loadNotes();
        state.notesFilter = 'open';
        notesDialog(context);
        toast('Notat lagret');
      });
      d.querySelectorAll('[data-note-done]').forEach((cb) =>
        cb.addEventListener('change', async () => {
          const { error } = await supabase.from('notes').update({ done: cb.checked }).eq('id', cb.dataset.noteDone);
          if (error) return toast(error.message, 'err');
          await loadNotes();
          notesDialog(context);
        })
      );
      d.querySelectorAll('[data-note-delete]').forEach((b) =>
        b.addEventListener('click', async () => {
          const { error } = await supabase.from('notes').delete().eq('id', b.dataset.noteDelete);
          if (error) return toast(error.message, 'err');
          await loadNotes();
          notesDialog(context);
        })
      );
    }
  );
}

// ---------- lightbox ----------
async function openPhoto(path) {
  const lb = $('#lightbox');
  const photo = state.photos.find((p) => p.storage_path === path);
  lb.hidden = false;
  const top = `<div class="lb-bar"><button type="button" class="icon-btn lb-btn" data-action="delete-photo" data-id="${photo?.id ?? ''}" aria-label="Slett bilde" title="Slett bilde">${ICON.trash}</button><button type="button" class="icon-btn lb-btn" data-action="close-photo" aria-label="Lukk">${ICON.close}</button></div>`;
  lb.innerHTML = `${top}<p>Laster …</p>`;
  const urls = await signedUrls([path]);
  const hasPos = photo && photo.lat != null && photo.lon != null;
  lb.innerHTML = `${top}<img alt="" src="${urls[path]}" />${
    photo ? `<div class="lb-info">${photo.taken_at ? `<span>${fmtDate(photo.taken_at)}</span>` : ''}${hasPos ? `<span>${fmtCoord(photo.lat, photo.lon)}</span><div class="minimap minimap--lb"></div>` : '<span class="muted">Ingen posisjon i bildet</span>'}</div>` : ''
  }`;
  if (hasPos) miniMap($('.minimap--lb', lb), photo.lat, photo.lon, { zoom: 12 });
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action]');
  const menu = $('#user-menu');
  if (menu && !menu.hidden && !e.target.closest('.user')) {
    menu.hidden = true;
    $('.avatar')?.setAttribute('aria-expanded', 'false');
  }
  if (!t) {
    if (e.target.id === 'lightbox') $('#lightbox').hidden = true;
    return;
  }
  const a = t.dataset.action;
  if (a === 'user-menu') {
    menu.hidden = !menu.hidden;
    t.setAttribute('aria-expanded', String(!menu.hidden));
    return;
  }
  const id = t.dataset.id;
  if (a === 'mode') {
    state.mode = t.dataset.mode;
    state.selected = null;
    state.map.setMode(state.mode);
    render({ fit: true });
  } else if (a === 'filter') {
    state.filter = t.dataset.filter;
    render();
  } else if (a === 'select-place') select('place', id);
  else if (a === 'select-trip') {
    state.mode = 'reise';
    state.map.setMode('reise');
    select('trip', id);
  } else if (a === 'close-detail') {
    state.selected = null;
    render();
  } else if (a === 'add') state.mode === 'fjell' ? placeForm() : addMenu();
  else if (a === 'add-place-reise') placeForm(null, { mode: 'reise', kind: 'sted' });
  else if (a === 'add-trip') tripForm();
  else if (a === 'edit-place') placeForm(state.places.find((p) => p.id === id));
  else if (a === 'add-visit') visitForm(state.places.find((p) => p.id === id));
  else if (a === 'edit-trip') tripForm(state.trips.find((x) => x.id === id));
  else if (a === 'delete-place')
    confirmDialog('Stedet og besøkene slettes. Bildene beholdes og havner i Usortert.', async () => {
      await supabase.from('photos').update({ place_id: null, visit_id: null }).eq('place_id', id);
      const { error } = await supabase.from('places').delete().eq('id', id);
      if (error) return toast(error.message, 'err');
      state.selected = null;
      await loadData();
      render();
      toast('Slettet');
    });
  else if (a === 'delete-trip')
    confirmDialog('Reisen slettes. Steder og bilder beholdes.', async () => {
      const { error } = await supabase.from('trips').delete().eq('id', id);
      if (error) return toast(error.message, 'err');
      state.selected = null;
      await loadData();
      render();
      toast('Slettet');
    });
  else if (a === 'upload') uploadWizard();
  else if (a === 'notes') notesDialog();
  else if (a === 'notes-filter') {
    state.notesFilter = t.dataset.filter;
    notesDialog($('.note-ctx')?.textContent.replace('Lagres med kontekst: ', '') ?? currentContext());
  }
  else if (a === 'inbox') inbox();
  else if (a === 'close-dlg') closeDialog();
  else if (a === 'open-photo') openPhoto(t.dataset.path);
  else if (a === 'close-photo') $('#lightbox').hidden = true;
  else if (a === 'delete-photo') {
    if (!id) return;
    confirmDialog('Bildet slettes permanent fra Turkart. Originalen i iCloud påvirkes ikke.', async () => {
      $('#lightbox').hidden = true;
      await deletePhotos([id]);
    });
  }
  else if (a === 'cancel-pick') {
    state.picking = null;
    $('#pick-banner').hidden = true;
  } else if (a === 'signout') {
    await supabase.auth.signOut();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#lightbox')?.hidden) $('#lightbox').hidden = true;
});

function addMenu() {
  openDialog(
    `<div class="form"><div class="dlg-head"><h2>Hva vil du legge til?</h2><button type="button" class="icon-btn" data-action="close-dlg" aria-label="Lukk">${ICON.close}</button></div>
      <div class="choice-list">
        <button type="button" class="choice" data-action="add-trip">${ICON.plane}<span><b>Reise</b><small>Periode, land og notater. Steder kobles til etterpå.</small></span></button>
        <button type="button" class="choice" data-action="add-place-reise">${ICON.plus}<span><b>Sted</b><small>En by, et stopp, en overnatting eller et sted dere vil besøke.</small></span></button>
      </div></div>`
  );
}

// ---------- auth ----------
function loginView(msg = '') {
  app.innerHTML = `
    <div class="login">
      <form class="login-card" id="login">
        <div class="brand brand--big">${ICON.mountain}<span>Turkart</span></div>
        <p>Logg inn med e-post. Du får en lenke som logger deg inn – ingen passord.</p>
        <label class="field"><span>E-post</span><input id="login-email" type="email" required autocomplete="email" /></label>
        <button type="submit" class="btn btn--dark">Send innloggingslenke</button>
        <p class="login-msg" role="status">${msg}</p>
      </form>
    </div>`;
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#login-email').value.trim();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin } });
    btn.disabled = false;
    $('.login-msg').textContent = error
      ? `Kunne ikke sende lenke: ${error.message}`
      : `Sjekk innboksen til ${email} og trykk på lenken.`;
  });
}

function noAccessView() {
  app.innerHTML = `<div class="login"><div class="login-card"><div class="brand brand--big">${ICON.mountain}<span>Turkart</span></div>
    <p>Denne e-postadressen har ikke tilgang til kartet.</p>
    <button type="button" class="btn btn--dark" data-action="signout">Logg ut</button></div></div>`;
}

function setupView() {
  app.innerHTML = `<div class="login"><div class="login-card"><div class="brand brand--big">${ICON.mountain}<span>Turkart</span></div>
    <p>Appen er ikke koblet til Supabase ennå. Legg inn <code>VITE_SUPABASE_URL</code> og <code>VITE_SUPABASE_ANON_KEY</code> i <code>.env</code> (se README).</p></div></div>`;
}

async function start(session) {
  state.session = session;
  if (!session) return loginView();
  const { data: member, error } = await supabase.rpc('is_member');
  if (error || !member) return noAccessView();
  renderShell();
  try {
    await loadData();
    render({ fit: true });
  } catch (err) {
    toast(`Kunne ikke hente data: ${err.message}`, 'err');
  }
}

if (!configured) setupView();
else {
  let current;
  supabase.auth.onAuthStateChange((_event, session) => {
    const uid = session?.user?.id ?? null;
    if (uid === current) return;
    current = uid;
    start(session);
  });
}
