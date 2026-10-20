import './style.css';
import { supabase, configured, signedUrls, BUCKET } from './supabase.js';
import { TurMap, miniMap, miniMapPoints, miniMapTrack, drawLines } from './map.js';
import { isTrackFile, parseTrackFile, positionAt, withinTrack, profileSvg } from './tracks.js';
import { searchPlaces, elevationFor, nameForPoint } from './geo.js';
import { isImageFile, processFile, existingHashes, uploadAll, squareJpeg } from './upload.js';
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
  users: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.7.8 2.8 2.6 3 5.2"/></svg>',
  image: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  chevronLeft: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  route: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h7a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h7"/></svg>',
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
  people: [],
  showAllTracks: (() => {
    try {
      return localStorage.getItem('turkart.showTracks') === '1';
    } catch {
      return false;
    }
  })(),
  visitPeople: [],
  tracks: [],
  trackPoints: new Map(),
  tripPeople: [],
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
  const [p, v, t, ph, pe, vp, tp, tr] = await Promise.all([
    supabase.from('places').select('*').order('created_at'),
    supabase.from('visits').select('*').order('visited_on', { ascending: false }),
    supabase.from('trips').select('*').order('start_date', { ascending: false }),
    supabase.from('photos').select('id,thumb_path,storage_path,place_id,visit_id,trip_id,taken_at,lat,lon,created_at,focus_x,focus_y').order('taken_at'),
    supabase.from('people').select('*').order('created_at'),
    supabase.from('visit_people').select('*'),
    supabase.from('trip_people').select('*'),
    supabase.from('tracks').select('id,visit_id,source,original_name,started_at,duration_min,distance_km,ascent_m,max_ele')
  ]);
  for (const r of [p, v, t, ph]) if (r.error) throw r.error;
  state.places = p.data;
  state.visits = v.data;
  state.trips = t.data;
  state.photos = ph.data;
  state.people = pe.data ?? [];
  state.visitPeople = vp.data ?? [];
  state.tripPeople = tp.data ?? [];
  state.tracks = tr.data ?? [];
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
  for (const v of state.visits) {
    v.people = state.visitPeople.filter((x) => x.visit_id === v.id).map((x) => x.person_id);
    v.tracks = state.tracks.filter((x) => x.visit_id === v.id);
  }
  for (const t of state.trips) t.people = state.tripPeople.filter((x) => x.trip_id === t.id).map((x) => x.person_id);
}

// ---------- spor ----------
const fmtDuration = (min) => (min == null ? '' : min >= 60 ? `${Math.floor(min / 60)} t ${min % 60} min` : `${min} min`);
const fmtKm = (km) => (km == null ? '' : `${Number(km).toLocaleString('nb-NO', { maximumFractionDigits: 1 })} km`);
const SPORT_KIND = {
  crossCountrySkiing: 'skitur', alpineSkiing: 'toppskitur', snowshoeing: 'fjelltur', cycling: 'sykkeltur', eBiking: 'sykkeltur',
  paddling: 'padletur', kayaking: 'padletur', standUpPaddleboarding: 'padletur', rowing: 'padletur', rockClimbing: 'klatring',
  hiking: 'topptur', mountaineering: 'topptur', walking: 'fjelltur', running: 'fjelltur'
};
const sportKind = (sport) => (sport ? SPORT_KIND[sport] ?? SPORT_KIND[String(sport).replace(/_([a-z])/g, (_, c) => c.toUpperCase())] ?? null : null);
async function trackPointsFor(ids) {
  const missing = ids.filter((id) => !state.trackPoints.has(id));
  if (missing.length) {
    const { data, error } = await supabase.from('tracks').select('id,points').in('id', missing);
    if (error) throw error;
    for (const r of data) state.trackPoints.set(r.id, r.points);
  }
  return ids.map((id) => state.trackPoints.get(id)).filter(Boolean);
}
function trackBlock(tr) {
  const stats = [fmtKm(tr.distance_km), tr.ascent_m != null ? `${num(tr.ascent_m)} hm` : '', fmtDuration(tr.duration_min), tr.max_ele != null ? `topp ${num(tr.max_ele)} moh.` : ''].filter(Boolean).join(' · ');
  return `<div class="trk"><div class="trk-head">${ICON.route}<span>${stats || 'Spor'}</span></div><div class="trk-profile" data-track-profile="${tr.id}"></div></div>`;
}
/** Koble bilder i Usortert som er tatt mens sporet pågikk. Returnerer antall. */
async function adoptUnsortedForTrack(track, visit, place) {
  const cand = state.photos.filter((ph) => !ph.place_id && !ph.trip_id && ph.taken_at && withinTrack(track, new Date(ph.taken_at)));
  for (const ph of cand) {
    const patch = { place_id: place.id, visit_id: visit.id, trip_id: visit.trip_id ?? null };
    if (ph.lat == null) {
      const pos = positionAt(track, new Date(ph.taken_at));
      if (pos) Object.assign(patch, { lat: pos.lat, lon: pos.lon });
    }
    await supabase.from('photos').update(patch).eq('id', ph.id);
  }
  return cand.length;
}
async function insertTrack(visitId, tr) {
  const dup = state.tracks.find((x) => x.started_at && tr.start && new Date(x.started_at).getTime() === tr.start.getTime());
  if (dup) return dup.id;
  const { data, error } = await supabase
    .from('tracks')
    .insert({
      visit_id: visitId,
      source: tr.source,
      original_name: tr.name,
      started_at: tr.start?.toISOString() ?? null,
      duration_min: tr.durationMin,
      distance_km: tr.distanceKm,
      ascent_m: tr.ascentM,
      max_ele: tr.maxEle,
      points: tr.points
    })
    .select('id')
    .single();
  if (error) throw error;
  state.trackPoints.set(data.id, tr.points);
  return data.id;
}

// ---------- hovedbilder ----------
const focusPos = (ph) => `${ph?.focus_x ?? 50}% ${ph?.focus_y ?? 50}%`;
const photoById = (id) => (id ? state.photos.find((ph) => ph.id === id) : null);
const firstUploaded = (list) => [...list].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))[0] ?? null;
const tripPhotos = (t) => state.photos.filter((ph) => ph.trip_id === t.id);
const placeCover = (p) => photoById(p.cover_photo_id) ?? firstUploaded(p.photoList ?? []);
const tripCover = (t) => photoById(t.cover_photo_id) ?? firstUploaded(tripPhotos(t)) ?? tripStops(t).map(placeCover).find(Boolean) ?? null;

// ---------- personer ----------
const initials = (name) => {
  const w = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? '') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase() || '?';
};
const personById = (id) => state.people.find((p) => p.id === id);
/** Personen som er koblet til innlogget bruker (via e-post). */
const myPerson = () => {
  const me = userEmail().toLowerCase();
  return me ? state.people.find((p) => (p.emails ?? []).some((e) => e.toLowerCase() === me)) ?? null : null;
};
const meIds = () => (myPerson() ? [myPerson().id] : []);
async function addPeopleToVisit(visitId, ids) {
  if (!ids.length) return;
  await supabase.from('visit_people').upsert(ids.map((pid) => ({ visit_id: visitId, person_id: pid })), { onConflict: 'visit_id,person_id', ignoreDuplicates: true });
}
function renderMe() {
  const btn = $('.avatar');
  if (!btn) return;
  const me = myPerson();
  btn.textContent = me ? initials(me.name) : userInitial();
  btn.classList.toggle('avatar--photo', Boolean(me?.avatar_path));
  if (me?.avatar_path) {
    btn.dataset.thumb = me.avatar_path;
    delete btn.dataset.loaded;
  } else {
    delete btn.dataset.thumb;
    btn.style.backgroundImage = '';
  }
  const head = $('.user-menu-head b');
  if (head) head.textContent = me ? `${me.name} (${userEmail()})` : userEmail();
}
function personAvatar(p, size = 'sm') {
  return `<span class="pav pav--${size}" title="${esc(p.name)}" ${p.avatar_path ? `data-thumb="${esc(p.avatar_path)}"` : ''}>${esc(initials(p.name))}</span>`;
}
function peopleRow(ids = []) {
  const ps = ids.map(personById).filter(Boolean);
  if (!ps.length) return '';
  return `<div class="people">${ps.map((p) => `<span class="person">${personAvatar(p)}<span>${esc(p.name.split(' ')[0])}</span></span>`).join('')}</div>`;
}
function peoplePicker(name, selected = []) {
  return `<fieldset class="ppick" data-name="${name}"><legend>Hvem var med?</legend>
    <div class="ppick-list">${state.people
      .map((p) => `<label class="ppick-opt"><input type="checkbox" name="${name}" value="${p.id}" ${selected.includes(p.id) ? 'checked' : ''} />${personAvatar(p)}<span>${esc(p.name)}</span></label>`)
      .join('')}</div>
    <div class="ppick-add"><input type="text" placeholder="Legg til ny person" aria-label="Navn på ny person" /><button type="button" class="btn btn--ghost">Legg til</button></div>
  </fieldset>`;
}
function wirePeoplePicker(root) {
  hydrateThumbs(root);
  root.querySelectorAll('.ppick').forEach((fs) => {
    const input = $('.ppick-add input', fs);
    const add = async () => {
      const name = input.value.trim();
      if (!name) return;
      const { data, error } = await supabase.from('people').insert({ name }).select('*').single();
      if (error) return toast(`Kunne ikke legge til: ${error.message}`, 'err');
      state.people.push(data);
      $('.ppick-list', fs).insertAdjacentHTML('beforeend', `<label class="ppick-opt"><input type="checkbox" name="${fs.dataset.name}" value="${data.id}" checked />${personAvatar(data)}<span>${esc(data.name)}</span></label>`);
      input.value = '';
    };
    $('.ppick-add button', fs).addEventListener('click', add);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        add();
      }
    });
  });
}
const pickedPeople = (root, name) => [...root.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
async function setLinks(table, key, id, personIds) {
  const del = await supabase.from(table).delete().eq(key, id);
  if (del.error) throw del.error;
  if (personIds.length) {
    const ins = await supabase.from(table).insert(personIds.map((pid) => ({ [key]: id, person_id: pid })));
    if (ins.error) throw ins.error;
  }
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
            <button type="button" class="menu-link menu-link--btn" data-action="people">${ICON.users}<span>Personer<small>Navn og profilbilder</small></span></button>
            <button type="button" class="btn btn--ghost" data-action="signout">Logg ut</button>
          </div>
        </div>
      </div>
    </header>
    <div class="body">
      <aside class="side" id="side" aria-label="Turer og reiser"></aside>
      <div class="side-backdrop" data-action="side-close"></div>
      <main class="mapwrap">
        <div id="map" aria-label="Kart"></div>
        <div class="map-tools">
          <button type="button" class="side-toggle" data-action="side-open" aria-controls="side" aria-expanded="false">${ICON.list}<span id="side-toggle-label">Turer</span></button>
          <button type="button" class="map-chip" data-action="toggle-tracks" aria-pressed="${state.showAllTracks}" title="Vis spor for alle turer på kartet">${ICON.route}<span>Spor</span></button>
        </div>
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
  const header = $('.top');
  const setTop = () => document.documentElement.style.setProperty('--top-h', `${header.getBoundingClientRect().height}px`);
  setTop();
  new ResizeObserver(() => {
    setTop();
    state.map.invalidate();
  }).observe(header);
}

function render({ fit = false } = {}) {
  $('.shell').dataset.mode = state.mode;
  document.querySelectorAll('[data-action="mode"]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === state.mode));
  $('#add-label').textContent = state.mode === 'fjell' ? 'Legg til tur' : 'Legg til reise';
  const unsorted = state.photos.filter((p) => !p.place_id && !p.trip_id).length;
  $('#inbox-count').textContent = unsorted || '';
  $('#notes-count').textContent = state.notes.filter((n) => !n.done).length || '';
  renderMe();
  const count = state.mode === 'fjell' ? visiblePlaces().length : visibleTrips().length + visiblePlaces().filter((p) => p.status === 'wish').length;
  const label = state.mode === 'fjell' ? 'Turer' : 'Reiser';
  $('#side').innerHTML = `<div class="side-head"><h2>${label}</h2><button type="button" class="icon-btn" data-action="side-close" aria-label="Lukk liste">${ICON.chevronLeft}</button></div>${state.mode === 'fjell' ? sideFjell() : sideReise()}`;
  $('#side-toggle-label').textContent = `${label}${count ? ` (${count})` : ''}`;
  const places = visiblePlaces();
  const routes =
    state.mode === 'reise'
      ? visibleTrips().map((t) => tripStops(t).filter((p) => p.mode === 'reise').sort((a, b) => (a.lastVisit ?? '').localeCompare(b.lastVisit ?? '')))
      : [];
  for (const p of places) {
    const c = placeCover(p);
    p.pinThumb = c ? c.thumb_path : null;
    p.pinPos = c ? focusPos(c) : '50% 50%';
  }
  state.map.render(places, { selectedId: state.selected?.type === 'place' ? state.selected.id : null, routes });
  hydrateThumbs($('#map'));
  renderAllTracks(places);
  if (fit) state.map.fitTo(places);
  renderDetail();
}

function setSide(open) {
  $('.shell')?.classList.toggle('side-open', open);
  $('.side-toggle')?.setAttribute('aria-expanded', String(open));
}
const isMobile = () => window.matchMedia('(max-width: 760px)').matches;

function filterChips() {
  const f = (k, label, dot) =>
    `<button type="button" class="chip" data-action="filter" data-filter="${k}" aria-pressed="${state.filter === k}">${dot ?? ''}${label}</button>`;
  return `<div class="chips">${f('all', 'Alle')}${f('visited', state.mode === 'fjell' ? 'Besøkt' : 'Reist', '<span class="dot dot--solid"></span>')}${f('wish', 'Ønsker', '<span class="dot dot--wish"></span>')}</div>`;
}

function placeRow(p) {
  const thumb = placeCover(p);
  const meta =
    p.status === 'wish'
      ? [p.elevation ? `${num(p.elevation)} moh.` : '', p.wish_season ? `Beste tid: ${esc(p.wish_season)}` : ''].filter(Boolean).join(' · ')
      : [fmtDate(p.lastVisit), p.elevation ? `${num(p.elevation)} moh.` : '', p.photoList.length ? `${p.photoList.length} bilder` : '']
          .filter(Boolean)
          .join(' · ');
  return `<button type="button" class="row ${p.status === 'wish' ? 'row--wish' : ''} ${state.selected?.id === p.id ? 'row--on' : ''}" data-action="select-place" data-id="${p.id}">
    <span class="thumb" ${thumb ? `data-thumb="${esc(thumb.thumb_path)}" style="background-position:${focusPos(thumb)}"` : ''}>${thumb ? '' : ICON.mountain}</span>
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
  const thumb = tripCover(t);
  const meta = [fmtRange(t.start_date, t.end_date), nights(t.start_date, t.end_date) ? `${nights(t.start_date, t.end_date)} netter` : '', t.countries.join(', ')]
    .filter(Boolean)
    .join(' · ');
  return `<button type="button" class="row ${t.status === 'wish' ? 'row--wish' : ''} ${state.selected?.id === t.id ? 'row--on' : ''}" data-action="select-trip" data-id="${t.id}">
    <span class="thumb" ${thumb ? `data-thumb="${esc(thumb.thumb_path)}" style="background-position:${focusPos(thumb)}"` : ''}>${thumb ? '' : ICON.plane}</span>
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

/** Vis spor for alle synlige turer når bryteren er på. */
async function renderAllTracks(places) {
  $('[data-action="toggle-tracks"]')?.setAttribute('aria-pressed', String(state.showAllTracks));
  if (!state.showAllTracks) return state.map.clearAllTracks();
  const ids = new Set(places.map((p) => p.id));
  const trackIds = state.visits.filter((v) => ids.has(v.place_id)).flatMap((v) => (v.tracks ?? []).map((t) => t.id));
  if (!trackIds.length) return state.map.clearAllTracks();
  try {
    const lines = await trackPointsFor(trackIds);
    if (state.showAllTracks) state.map.showAllTracks(lines);
  } catch (err) {
    console.warn(err);
  }
}

async function showDetailTracks(sel, detailMap) {
  const visits =
    sel.type === 'place'
      ? state.visits.filter((v) => v.place_id === sel.id)
      : state.visits.filter((v) => v.trip_id === sel.id);
  const ids = visits.flatMap((v) => (v.tracks ?? []).map((t) => t.id));
  if (!ids.length) return state.map.clearTracks();
  try {
    await trackPointsFor(ids);
  } catch (err) {
    return console.warn(err);
  }
  if (state.selected?.id !== sel.id) return;
  const lines = ids.map((id) => state.trackPoints.get(id)).filter(Boolean);
  state.map.showTracks(lines, { fit: sel.type === 'place' && !isMobile() });
  if (detailMap) drawLines(detailMap, lines, { weight: 3, fit: true });
  document.querySelectorAll('[data-track-profile]').forEach((el) => {
    const pts = state.trackPoints.get(el.dataset.trackProfile);
    if (pts) el.innerHTML = profileSvg(pts);
  });
}

function renderDetail() {
  const el = $('#detail');
  const sel = state.selected;
  if (!sel) {
    state.map.clearTracks();
    el.hidden = true;
    hydrateThumbs();
    return;
  }
  el.hidden = false;
  el.innerHTML = sel.type === 'place' ? placeDetail(state.places.find((p) => p.id === sel.id)) : tripDetail(state.trips.find((t) => t.id === sel.id));
  el.scrollTop = 0;
  hydrateThumbs();
  const mapEl = $('#detail-map', el);
  let detailMap = null;
  if (mapEl && isMobile()) {
    if (sel.type === 'place') {
      const p = state.places.find((x) => x.id === sel.id);
      if (p) detailMap = miniMapPoints(mapEl, [{ lat: p.lat, lon: p.lon, color: p.mode === 'reise' ? '#2B5C8A' : '#2F5D50' }], { maxZoom: 12 });
    } else {
      const t = state.trips.find((x) => x.id === sel.id);
      if (t) detailMap = miniMapPoints(mapEl, tripStops(t).map((p) => ({ lat: p.lat, lon: p.lon, color: p.mode === 'reise' ? '#2B5C8A' : '#2F5D50' })), { maxZoom: 11 });
    }
  }
  showDetailTracks(sel, detailMap);
}

function photoGrid(photos) {
  if (!photos.length) return '<p class="muted">Ingen bilder ennå.</p>';
  return `<div class="grid">${photos
    .map((ph) => `<button type="button" class="gthumb" data-action="open-photo" data-path="${esc(ph.storage_path)}" data-thumb="${esc(ph.thumb_path)}" aria-label="Åpne bilde"></button>`)
    .join('')}</div>`;
}


function coverBlock(type, item, cover) {
  const chosen = Boolean(item.cover_photo_id && cover);
  return `<div class="cover ${cover ? '' : 'cover--empty'}" ${cover ? `data-thumb="${esc(cover.storage_path)}" style="background-position:${focusPos(cover)}"` : ''}>
    ${cover ? `<button type="button" class="cover-open" data-action="open-photo" data-path="${esc(cover.storage_path)}" aria-label="Åpne hovedbilde"></button>` : `<span class="cover-ph">${ICON.image}<span>Ingen bilder ennå</span></span>`}
    ${cover && !chosen ? '<span class="cover-badge">Første bilde</span>' : ''}
    <div class="cover-actions">
      <button type="button" class="btn btn--glass" data-action="cover-pick" data-type="${type}" data-id="${item.id}">${ICON.image}${cover ? 'Juster eller bytt' : 'Legg til hovedbilde'}</button>
      ${chosen ? `<button type="button" class="btn btn--glass" data-action="cover-reset" data-type="${type}" data-id="${item.id}">Fjern valg</button>` : ''}
    </div>
  </div>`;
}

function detailMapBlock(type, id, hasPoints) {
  if (!hasPoints) return '';
  return `<div class="detail-map-wrap mobile-only">
    <div class="detail-map" id="detail-map" aria-hidden="true"></div>
    <button type="button" class="btn btn--ghost detail-map-btn" data-action="show-on-map" data-type="${type}" data-id="${id}">${ICON.pin}Vis i hovedkartet</button>
  </div>`;
}

function placeDetail(p) {
  if (!p) return '';
  const trips = [...new Set(p.visitsList.map((v) => v.trip_id).filter(Boolean))].map((id) => state.trips.find((t) => t.id === id)).filter(Boolean);
  return `
    <div class="detail-head">
      <div class="chips-inline"><span class="tag">${KIND_LABEL[p.kind]}</span><span class="tag ${p.status === 'wish' ? 'tag--wish' : ''}">${p.status === 'wish' ? 'Ønsker' : 'Besøkt'}</span></div>
      <button type="button" class="icon-btn" data-action="close-detail" aria-label="Lukk">${ICON.close}</button>
    </div>
    ${coverBlock('place', p, placeCover(p))}
    <h2>${esc(p.name)}</h2>
    <p class="muted">${[p.elevation ? `${num(p.elevation)} moh.` : '', p.country].filter(Boolean).join(' · ')}</p>
    ${detailMapBlock('place', p.id, true)}
    ${p.status === 'wish' && (p.wish_season || p.wish_priority) ? `<p>${p.wish_season ? `Beste tid: ${esc(p.wish_season)}. ` : ''}${p.wish_priority ? `Prioritet: ${['', 'høy', 'middels', 'lav'][p.wish_priority]}.` : ''}</p>` : ''}
    ${p.notes ? `<p class="note">${esc(p.notes)}</p>` : ''}
    ${p.visitsList.length ? `<h3 class="eyebrow">Besøk</h3><ul class="visits">${p.visitsList
      .map(
        (v) => {
          const trip = state.trips.find((t) => t.id === v.trip_id);
          return `<li><div class="visit-head"><b>${v.visited_on ? fmtDate(v.visited_on) : 'Uten dato'}</b>
          <button type="button" class="btn btn--link btn--xs" data-action="edit-visit" data-id="${v.id}">Endre besøk</button></div>
          ${[v.distance_km ? `${num(v.distance_km)} km` : '', v.ascent_m ? `${num(v.ascent_m)} hm` : '', v.duration_min ? `${Math.floor(v.duration_min / 60)} t ${v.duration_min % 60} min` : ''].filter(Boolean).join(' · ')}
          ${(v.tracks ?? []).map(trackBlock).join('')}
          ${v.people?.length ? peopleRow(v.people) : `<button type="button" class="add-people" data-action="edit-visit" data-id="${v.id}">${ICON.users}Legg til hvem som var med</button>`}
          ${trip ? `<button type="button" class="trip-pill" data-action="select-trip" data-id="${trip.id}">${ICON.plane}${esc(trip.title)}</button>` : ''}
          ${v.notes ? `<p>${esc(v.notes)}</p>` : ''}</li>`;
        }
      )
      .join('')}</ul>` : ''}
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
  const tours = stops.filter((p) => p.mode === 'fjell');
  const others = stops.filter((p) => p.mode !== 'fjell');
  const photos = tripPhotos(t);
  return `
    <div class="detail-head">
      <div class="chips-inline"><span class="tag tag--trip">Reise</span>${t.status === 'wish' ? '<span class="tag tag--wish">Ønsker</span>' : ''}</div>
      <button type="button" class="icon-btn" data-action="close-detail" aria-label="Lukk">${ICON.close}</button>
    </div>
    ${coverBlock('trip', t, tripCover(t))}
    <h2>${esc(t.title)}</h2>
    <p class="muted">${[fmtRange(t.start_date, t.end_date), nights(t.start_date, t.end_date) ? `${nights(t.start_date, t.end_date)} netter` : '', t.countries.join(', ')].filter(Boolean).join(' · ')}</p>
    ${peopleRow(t.people)}
    ${detailMapBlock('trip', t.id, stops.length > 0)}
    ${t.notes ? `<p class="note">${esc(t.notes)}</p>` : ''}
    <div class="section-head"><h3 class="eyebrow">Turer på reisen${tours.length ? ` (${tours.length})` : ''}</h3>
      <button type="button" class="btn btn--link btn--xs" data-action="link-tours" data-id="${t.id}">${ICON.link}Koble til turer</button></div>
    ${tours.length ? tours.map(placeRow).join('') : '<p class="muted">Ingen turer koblet til ennå.</p>'}
    ${others.length ? `<h3 class="eyebrow">Steder</h3>${others.map(placeRow).join('')}` : ''}
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
      ${existing ? '' : `<fieldset class="visit-only"><legend>Første besøk</legend>
        <div class="field-row">
          <label class="field"><span>Dato</span><input id="pf-date" type="date" value="${preset.date ?? ''}" /></label>
          <label class="field"><span>Reise</span><select id="pf-trip">${tripOptions(preset.trip_id)}</select></label>
        </div>
        ${peoplePicker('pf-people', meIds())}
      </fieldset>`}
      <label class="field"><span>Notat</span><textarea id="pf-notes" rows="3">${esc(p.notes ?? '')}</textarea></label>
      <div class="dlg-actions"><button type="button" class="btn btn--ghost" data-action="close-dlg">Avbryt</button><button type="submit" class="btn btn--dark">Lagre</button></div>
    </form>`,
    (d) => {
      const form = $('#place-form', d);
      wirePeoplePicker(d);
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
            onSaved: preset.onSaved,
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
          let visitId = null;
          const people = pickedPeople(d, 'pf-people');
          if (existing) {
            const { error } = await supabase.from('places').update(row).eq('id', id);
            if (error) throw error;
          } else {
            const { data: ins, error } = await supabase.from('places').insert(row).select('id').single();
            if (error) throw error;
            id = ins.id;
          }
          if (!existing && row.status === 'visited' && (date || trip_id || people.length || preset.onSaved)) {
            const { data: vis, error: e2 } = await supabase.from('visits').insert({ place_id: id, visited_on: date || null, trip_id: trip_id || null }).select('id').single();
            if (e2) throw e2;
            visitId = vis.id;
            await setLinks('visit_people', 'visit_id', visitId, people);
          }
          if (preset.onSaved) await preset.onSaved(id, visitId, trip_id || null);
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

function visitForm(place, existing = null) {
  const v0 = existing ?? {};
  openDialog(
    `<form id="visit-form" class="form">
      <div class="dlg-head"><h2>${existing ? 'Endre besøk' : 'Besøk'} – ${esc(place.name)}</h2><button type="button" class="icon-btn" data-action="close-dlg" aria-label="Lukk">${ICON.close}</button></div>
      <div class="field-row">
        <label class="field"><span>Dato</span><input id="vf-date" type="date" value="${v0.visited_on ?? ''}" /></label>
        <label class="field"><span>Del av reise</span><select id="vf-trip">${tripOptions(v0.trip_id)}</select></label>
      </div>
      ${peoplePicker('vf-people', existing ? v0.people ?? [] : meIds())}
      <div class="field-row">
        <label class="field"><span>Lengde (km)</span><input id="vf-km" inputmode="decimal" value="${v0.distance_km ?? ''}" /></label>
        <label class="field"><span>Høydemeter</span><input id="vf-hm" type="number" inputmode="numeric" value="${v0.ascent_m ?? ''}" /></label>
        <label class="field"><span>Tid (minutter)</span><input id="vf-min" type="number" inputmode="numeric" value="${v0.duration_min ?? ''}" /></label>
      </div>
      ${existing ? `<fieldset class="vf-tracks"><legend>Spor fra klokka</legend>
        ${(v0.tracks ?? []).map((t) => `<div class="vf-track">${ICON.route}<span>${esc(t.original_name ?? 'Spor')} · ${[fmtKm(t.distance_km), t.ascent_m != null ? `${num(t.ascent_m)} hm` : ''].filter(Boolean).join(' · ')}</span><button type="button" class="icon-btn icon-btn--sm" data-del-track="${t.id}" aria-label="Fjern spor">${ICON.trash}</button></div>`).join('')}
        <label class="btn btn--ghost btn--file btn--sm">${ICON.upload}<span class="vf-track-label">Legg til spor (GPX, FIT, TCX)</span><input type="file" accept=".gpx,.fit,.tcx" id="vf-track" /></label>
      </fieldset>` : ''}
      <label class="field"><span>Notat</span><textarea id="vf-notes" rows="3">${esc(v0.notes ?? '')}</textarea></label>
      <div class="dlg-actions">
        ${existing ? '<button type="button" class="btn btn--danger" id="vf-delete">Slett besøk</button><span class="spacer"></span>' : ''}
        <button type="button" class="btn btn--ghost" data-action="close-dlg">Avbryt</button><button type="submit" class="btn btn--dark">Lagre besøk</button>
      </div>
    </form>`,
    (d) => {
      wirePeoplePicker(d);
      d.querySelectorAll('[data-del-track]').forEach((b) =>
        b.addEventListener('click', async () => {
          const { error } = await supabase.from('tracks').delete().eq('id', b.dataset.delTrack);
          if (error) return toast(error.message, 'err');
          state.trackPoints.delete(b.dataset.delTrack);
          b.closest('.vf-track').remove();
          await loadData();
          render();
          toast('Sporet er fjernet');
        })
      );
      $('#vf-track', d)?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const label = $('.vf-track-label', d);
        label.textContent = 'Leser spor …';
        try {
          const tr = await parseTrackFile(file);
          await insertTrack(existing.id, tr);
          // Fyll inn tomme felt fra sporet, så de lagres med besøket.
          const fill = (sel, val) => {
            const el = $(sel, d);
            if (el && !el.value && val != null) el.value = String(val).replace('.', ',');
          };
          fill('#vf-km', tr.distanceKm);
          fill('#vf-hm', tr.ascentM);
          fill('#vf-min', tr.durationMin);
          if (!$('#vf-date', d).value && tr.start) $('#vf-date', d).value = isoDay(tr.start);
          const adopted = await adoptUnsortedForTrack(tr, existing, place);
          await loadData();
          render();
          label.textContent = 'Legg til spor (GPX, FIT, TCX)';
          $('.vf-tracks', d).insertAdjacentHTML('afterbegin', `<div class="vf-track">${ICON.route}<span>${esc(tr.name)} · ${fmtKm(tr.distanceKm)}${tr.ascentM != null ? ` · ${num(tr.ascentM)} hm` : ''}</span></div>`);
          toast(adopted ? `Spor lagt til, og ${adopted} bilder fra Usortert koblet til` : 'Spor lagt til');
        } catch (err) {
          label.textContent = 'Legg til spor (GPX, FIT, TCX)';
          toast(`Kunne ikke lese sporet: ${err.message}`, 'err');
        }
      });
      $('#vf-delete', d)?.addEventListener('click', () =>
        confirmDialog('Besøket slettes. Bildene beholdes på stedet.', async () => {
          await supabase.from('photos').update({ visit_id: null }).eq('visit_id', existing.id);
          const { error } = await supabase.from('visits').delete().eq('id', existing.id);
          if (error) return toast(error.message, 'err');
          await loadData();
          render();
          toast('Besøket er slettet');
        })
      );
      $('#visit-form', d).addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = (id) => $(id, d).value.trim();
        const row = {
          visited_on: v('#vf-date') || null,
          trip_id: v('#vf-trip') || null,
          distance_km: v('#vf-km') ? parseFloat(v('#vf-km').replace(',', '.')) : null,
          ascent_m: v('#vf-hm') ? parseInt(v('#vf-hm'), 10) : null,
          duration_min: v('#vf-min') ? parseInt(v('#vf-min'), 10) : null,
          notes: v('#vf-notes') || null
        };
        try {
          let id = existing?.id;
          if (existing) {
            const { error } = await supabase.from('visits').update(row).eq('id', id);
            if (error) throw error;
          } else {
            const { data, error } = await supabase.from('visits').insert({ ...row, place_id: place.id }).select('id').single();
            if (error) throw error;
            id = data.id;
          }
          // Bildene fra besøket følger reisen.
          await supabase.from('photos').update({ trip_id: row.trip_id }).eq('visit_id', id);
          await setLinks('visit_people', 'visit_id', id, pickedPeople(d, 'vf-people'));
          if (place.status === 'wish') await supabase.from('places').update({ status: 'visited' }).eq('id', place.id);
          closeDialog();
          await loadData();
          render();
          toast('Besøk lagret');
        } catch (err) {
          toast(`Kunne ikke lagre: ${err.message}`, 'err');
        }
      });
    }
  );
}

function tripForm(existing = null, preset = {}) {
  const t = existing ?? { status: 'done', countries: [], start_date: preset.start_date ?? null, end_date: preset.end_date ?? null };
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
      ${peoplePicker('tf-people', existing ? t.people ?? [] : meIds())}
      <label class="field"><span>Notat</span><textarea id="tf-notes" rows="3">${esc(t.notes ?? '')}</textarea></label>
      <div class="dlg-actions"><button type="button" class="btn btn--ghost" data-action="close-dlg">Avbryt</button><button type="submit" class="btn btn--dark">Lagre</button></div>
    </form>`,
    (d) => {
      wirePeoplePicker(d);
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
          await setLinks('trip_people', 'trip_id', id, pickedPeople(d, 'tf-people'));
          if (preset.onSaved) await preset.onSaved(id);
          closeDialog();
          await loadData();
          state.mode = 'reise';
          state.map.setMode('reise');
          select('trip', id);
          toast('Lagret');
        } catch (err) {
          toast(`Kunne ikke lagre: ${err.message}`, 'err');
        }
      });
    }
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
      <div class="dlg-head"><h2>Last opp bilder og spor</h2><button type="button" class="icon-btn" data-action="close-dlg" aria-label="Lukk">${ICON.close}</button></div>
      <div id="upl-body">
        <label class="drop" id="drop">
          <input type="file" id="upl-files" multiple accept="image/*,.heic,.heif,.gpx,.fit,.tcx" />
          <b>Dra bilder, spor eller en hel mappe hit</b>
          <span>eller trykk for å velge. Bilder (JPEG, PNG, HEIC) og spor fra treningsklokka (GPX, FIT, TCX).</span>
        </label>
        <p class="hint">På iPhone: trykk <b>Valg</b> øverst i bildevelgeren og slå på <b>Posisjon</b>, ellers mangler bildene plassering.</p>
        <details class="hint howto"><summary>Hvordan får jeg spor fra klokka?</summary>
          <ul>
            <li><b>Garmin:</b> åpne økten i Garmin Connect → tannhjulet → <i>Eksporter til GPX</i> (eller <i>Eksporter original</i> for FIT).</li>
            <li><b>Apple Watch:</b> bruk appen <i>HealthFit</i> eller <i>RunGap</i> på iPhone og eksporter økten som GPX.</li>
            <li><b>Strava:</b> åpne økten → ⋯ → <i>Eksporter GPX</i>.</li>
          </ul>
          Bilder tatt under økten kobles til turen automatisk, også de som ligger i Usortert.</details>
        <label class="btn btn--ghost btn--file">Velg mappe<input type="file" id="upl-dir" webkitdirectory multiple /></label>
      </div>
    </div>`,
    (d) => {
      const go = (files) => runUpload([...files].filter((f) => isImageFile(f) || isTrackFile(f)), d);
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
  if (!files.length) return toast('Fant ingen bilder eller spor i utvalget.', 'err');
  const trackFiles = files.filter(isTrackFile);
  files = files.filter((f) => !isTrackFile(f));
  const progress = (label, done, total) => {
    body.innerHTML = `<p><b>${label}</b> ${done} av ${total}</p><progress max="${total}" value="${done}"></progress><div class="strip" id="strip"></div>`;
  };
  // 0. Les spor
  const tracks = [];
  let failed = 0;
  for (let i = 0; i < trackFiles.length; i++) {
    progress('Leser spor …', i, trackFiles.length);
    try {
      tracks.push(await parseTrackFile(trackFiles[i]));
    } catch (err) {
      console.warn(trackFiles[i].name, err);
      toast(`${trackFiles[i].name}: ${err.message}`, 'err');
      failed++;
    }
  }
  // 1. Les og forbered
  const items = [];
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
  // Bilder uten GPS, men tatt under en økt, får posisjon fra sporet.
  for (const it of items) {
    if (it.lat != null || !it.takenAt) continue;
    const tr = tracks.find((t) => withinTrack(t, it.takenAt));
    const pos = tr && positionAt(tr, it.takenAt);
    if (pos) Object.assign(it, { lat: pos.lat, lon: pos.lon, interp: true });
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
  // 4. Grupper: først én gruppe per spor (med bilder tatt under økten), så resten etter tid og sted.
  body.innerHTML = '<p><b>Lager forslag …</b> Finner stedsnavn for gruppene.</p><progress></progress>';
  let rest = ok;
  const trackGroups = tracks.map((tr) => {
    const mine = rest.filter((it) => it.takenAt && withinTrack(tr, it.takenAt));
    rest = rest.filter((it) => !mine.includes(it));
    const old = state.photos
      .filter((ph) => !ph.place_id && !ph.trip_id && ph.taken_at && withinTrack(tr, new Date(ph.taken_at)))
      .map((ph) => ({ id: ph.id, thumb_path: ph.thumb_path, takenAt: new Date(ph.taken_at), lat: ph.lat, lon: ph.lon, existing: true }));
    for (const it of old) {
      if (it.lat == null) {
        const pos = positionAt(tr, it.takenAt);
        if (pos) Object.assign(it, { lat: pos.lat, lon: pos.lon, interp: true });
      }
    }
    return { track: tr, items: [...mine, ...old], center: tr.summit, start: tr.start, end: tr.end };
  });
  const clustered = clusterPhotos(rest);
  const groups = [...trackGroups, ...clustered.groups];
  const unsorted = clustered.unsorted;
  await suggestForGroups(groups, state.places);
  for (const g of trackGroups) {
    const k = sportKind(g.track.sport);
    if (k && g.suggestion) g.suggestion.kind = k;
  }
  await loadData();
  render();
  body.innerHTML = `
    <div class="summary">
      <span><b>${ok.length}</b> bilder lastet opp</span>
      ${tracks.length ? `<span><b>${tracks.length}</b> spor lest inn</span>` : ''}
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
  hydrateThumbs(body);
  const previews = groups.map((g, i) => {
    if (g.track) {
      const el = $(`#g${i}-preview`, d);
      el.innerHTML = '<div class="minimap"></div>';
      miniMapTrack($('.minimap', el), g.track.points);
      return () => {};
    }
    return mountPreview($(`#g${i}-preview`, d), g.center?.lat, g.center?.lon);
  });
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
  const kind = s.kind ?? (mode === 'fjell' ? (s.isPeak ? 'topptur' : 'fjelltur') : 'sted');
  const tr = g.track;
  return `<div class="gcard ${tr ? 'gcard--track' : ''}" data-i="${i}" data-choice="${g.nearby.length ? 'existing' : 'new'}">
    ${g.items.length ? `<div class="gstrip">${g.items.slice(0, 6).map((it) => (it.thumbUrl ? `<img alt="" src="${it.thumbUrl}" />` : `<img alt="" data-thumb="${esc(it.thumb_path)}" />`)).join('')}${g.items.length > 6 ? `<span>+${g.items.length - 6}</span>` : ''}</div>` : ''}
    <p class="gmeta">${tr ? `${ICON.route}<b>Spor</b> · ` : ''}<b>${g.items.length} bilder</b> · ${date}</p>
    ${tr ? `<p class="gtrack-stats">${[fmtKm(tr.distanceKm), tr.ascentM != null ? `${num(tr.ascentM)} hm` : '', fmtDuration(tr.durationMin), tr.maxEle != null ? `topp ${num(tr.maxEle)} moh.` : ''].filter(Boolean).join(' · ')}${g.items.some((it) => it.existing) ? ` · ${g.items.filter((it) => it.existing).length} fra Usortert` : ''}</p>` : ''}
    ${g.noPosition ? `<p class="warnbox">Bildene mangler posisjon. Søk opp stedet under, så lagres turen likevel. <span class="muted">Tips: På iPhone, trykk <b>Valg</b> øverst i bildevelgeren og slå på <b>Posisjon</b>.</span></p>` : ''}
    <label class="field"><span>Hva er dette?</span>
      <select class="g-choice" id="g${i}-choice">
        ${g.nearby.length ? g.nearby.map((p, j) => {
          const same = g.start && (p.visitsList ?? []).some((v) => v.visited_on === isoDay(g.start));
          return `<option value="existing:${p.id}" ${j === 0 ? 'selected' : ''}>Besøk på ${esc(p.name)}${same ? ' (samme dag)' : ''}</option>`;
        }).join('') : ''}
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
        const elevation = (g.suggestion?.country === 'Norge' ? await elevationFor(lat, lon) : null) ?? g.track?.maxEle ?? null;
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
        await addPeopleToVisit(data.id, meIds());
      }
      await supabase.from('places').update({ status: 'visited' }).eq('id', placeId).eq('status', 'wish');
      const ids = g.items.map((it) => it.id).filter(Boolean);
      if (ids.length) {
        const { error } = await supabase.from('photos').update({ place_id: placeId, visit_id: visit.id, trip_id: tripId }).in('id', ids);
        if (error) throw error;
      }
      for (const it of g.items.filter((x) => x.existing && x.interp)) {
        await supabase.from('photos').update({ lat: it.lat, lon: it.lon }).eq('id', it.id);
      }
      if (g.track) {
        const tr = g.track;
        const patch = {};
        if (visit.distance_km == null && tr.distanceKm) patch.distance_km = tr.distanceKm;
        if (visit.ascent_m == null && tr.ascentM != null) patch.ascent_m = tr.ascentM;
        if (visit.duration_min == null && tr.durationMin != null) patch.duration_min = tr.durationMin;
        if (Object.keys(patch).length) await supabase.from('visits').update(patch).eq('id', visit.id);
        await insertTrack(visit.id, tr);
      }
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
        <label class="field"><span>Koble valgte til</span><select id="ib-target">
          <optgroup label="Opprett ny"><option value="new:place">+ Ny tur …</option><option value="new:trip">+ Ny reise …</option></optgroup>
          ${placeOpts ? `<optgroup label="Turer og steder">${placeOpts}</optgroup>` : ''}
          ${tripOpts ? `<optgroup label="Reiser">${tripOpts}</optgroup>` : ''}
        </select></label>
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
        if (type === 'new') return newFromInbox(id, ids);
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

/** Opprett ny tur eller reise fra valgte bilder i Usortert, og koble bildene til den. */
async function newFromInbox(kind, ids) {
  const sel = state.photos.filter((p) => ids.includes(p.id));
  const days = sel.map((p) => p.taken_at && isoDay(new Date(p.taken_at))).filter(Boolean).sort();
  const pos = sel.find((p) => p.lat != null && p.lon != null);
  const after = async (msg) => {
    await loadData();
    render();
    toast(msg);
  };
  if (kind === 'trip') {
    return tripForm(null, {
      start_date: days[0] ?? null,
      end_date: days[days.length - 1] ?? null,
      onSaved: async (tripId) => {
        const { error } = await supabase.from('photos').update({ trip_id: tripId }).in('id', ids);
        if (error) throw error;
        setTimeout(() => after(`${ids.length} bilder koblet til reisen`), 0);
      }
    });
  }
  const preset = {
    date: days[0] ?? '',
    onSaved: async (placeId, visitId, tripId) => {
      const { error } = await supabase.from('photos').update({ place_id: placeId, visit_id: visitId, trip_id: tripId }).in('id', ids);
      if (error) throw error;
      setTimeout(() => after(`${ids.length} bilder koblet til turen`), 0);
    }
  };
  if (pos) {
    toast('Finner sted ut fra bildene …');
    const [guess, z] = await Promise.all([nameForPoint(pos.lat, pos.lon), elevationFor(pos.lat, pos.lon)]);
    Object.assign(preset, {
      lat: Number(pos.lat.toFixed(5)),
      lon: Number(pos.lon.toFixed(5)),
      name: guess.name,
      country: guess.country,
      elevation: z,
      kind: guess.isPeak ? 'topptur' : 'fjelltur',
      mode: guess.country && guess.country !== 'Norge' ? 'reise' : 'fjell'
    });
  }
  placeForm(null, preset);
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

// ---------- personer (administrasjon) ----------
function peopleDialog() {
  openDialog(
    `<div class="form">
      <div class="dlg-head"><h2>Personer</h2><button type="button" class="icon-btn" data-action="close-dlg" aria-label="Lukk">${ICON.close}</button></div>
      <p class="muted">Personer kan kobles til besøk og reiser. Uten bilde vises initialene. Legg inn e-posten personen logger inn med, så blir hen valgt automatisk på nye besøk og reiser.</p>
      <ul class="plist">${state.people
        .map(
          (p) => `<li class="prow" data-id="${p.id}">
          ${personAvatar(p, 'md')}
          <div class="prow-main">
            <div class="prow-title"><input class="prow-name" value="${esc(p.name)}" aria-label="Navn" />${myPerson()?.id === p.id ? '<span class="tag">Deg</span>' : ''}</div>
            <input class="prow-emails" value="${esc((p.emails ?? []).join(', '))}" placeholder="E-post for innlogging (valgfritt)" aria-label="E-post for innlogging, kommaseparert" />
          </div>
          <div class="prow-actions">
            <label class="btn btn--ghost btn--file btn--sm">${p.avatar_path ? 'Bytt bilde' : 'Last opp bilde'}<input type="file" accept="image/*,.heic,.heif" class="prow-file" /></label>
            ${p.avatar_path ? '<button type="button" class="btn btn--ghost btn--sm prow-noimg">Fjern bilde</button>' : ''}
            <button type="button" class="icon-btn icon-btn--sm prow-del" aria-label="Slett ${esc(p.name)}">${ICON.trash}</button>
          </div>
        </li>`
        )
        .join('')}</ul>
      <form class="field-row" id="pnew">
        <label class="field"><span>Ny person</span><input id="pnew-name" placeholder="Fullt navn" required /></label>
        <button type="submit" class="btn btn--dark btn--self">Legg til</button>
      </form>
    </div>`,
    (d) => {
      hydrateThumbs(d);
      const refresh = async (msg) => {
        await loadData();
        render();
        peopleDialog();
        if (msg) toast(msg);
      };
      $('#pnew', d).addEventListener('submit', async (e) => {
        e.preventDefault();
        const { error } = await supabase.from('people').insert({ name: $('#pnew-name', d).value.trim() });
        if (error) return toast(error.message, 'err');
        refresh('Person lagt til');
      });
      d.querySelectorAll('.prow').forEach((row) => {
        const pid = row.dataset.id;
        const person = personById(pid);
        $('.prow-name', row).addEventListener('change', async (e) => {
          const name = e.target.value.trim();
          if (!name) return;
          const { error } = await supabase.from('people').update({ name }).eq('id', pid);
          if (error) return toast(error.message, 'err');
          refresh('Navn lagret');
        });
        $('.prow-emails', row).addEventListener('change', async (e) => {
          const emails = e.target.value.split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
          const { error } = await supabase.from('people').update({ emails }).eq('id', pid);
          if (error) return toast(error.message, 'err');
          refresh('Innlogging koblet');
        });
        $('.prow-file', row).addEventListener('change', async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          try {
            const blob = await squareJpeg(file, 256);
            const path = `avatars/${pid}-${Date.now()}.jpg`;
            const up = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
            if (up.error) throw up.error;
            if (person.avatar_path) await supabase.storage.from(BUCKET).remove([person.avatar_path]);
            const { error } = await supabase.from('people').update({ avatar_path: path }).eq('id', pid);
            if (error) throw error;
            refresh('Bilde lagret');
          } catch (err) {
            toast(`Kunne ikke laste opp: ${err.message}`, 'err');
          }
        });
        $('.prow-noimg', row)?.addEventListener('click', async () => {
          await supabase.storage.from(BUCKET).remove([person.avatar_path]);
          const { error } = await supabase.from('people').update({ avatar_path: null }).eq('id', pid);
          if (error) return toast(error.message, 'err');
          refresh('Bildet er fjernet');
        });
        $('.prow-del', row).addEventListener('click', () =>
          confirmDialog(`${esc(person.name)} slettes og fjernes fra alle turer og reiser.`, async () => {
            if (person.avatar_path) await supabase.storage.from(BUCKET).remove([person.avatar_path]);
            const { error } = await supabase.from('people').delete().eq('id', pid);
            if (error) return toast(error.message, 'err');
            refresh('Personen er slettet');
          })
        );
      });
    }
  );
}

// ---------- hovedbilde ----------
function coverTarget(type, id) {
  if (type === 'place') {
    const p = state.places.find((x) => x.id === id);
    return { item: p, table: 'places', photos: p?.photoList ?? [], cover: p && placeCover(p) };
  }
  const t = state.trips.find((x) => x.id === id);
  const own = t ? tripPhotos(t) : [];
  const fromStops = t ? tripStops(t).flatMap((p) => p.photoList) : [];
  const photos = [...new Map([...own, ...fromStops].map((ph) => [ph.id, ph])).values()];
  return { item: t, table: 'trips', photos, cover: t && tripCover(t) };
}

async function setCover(type, id, photoId) {
  const { table } = coverTarget(type, id);
  const { error } = await supabase.from(table).update({ cover_photo_id: photoId }).eq('id', id);
  if (error) return toast(`Kunne ikke lagre: ${error.message}`, 'err');
  await loadData();
  render();
  toast(photoId ? 'Hovedbilde valgt' : 'Bruker første bilde som hovedbilde');
}

function coverDialog(type, id) {
  const { item, photos, cover } = coverTarget(type, id);
  if (!item) return;
  openDialog(
    `<div class="form">
      <div class="dlg-head"><h2>Hovedbilde</h2><button type="button" class="icon-btn" data-action="close-dlg" aria-label="Lukk">${ICON.close}</button></div>
      ${cover ? `<section class="focus-edit">
        <h3 class="eyebrow">Midtpunkt</h3>
        <p class="muted hint-sm">Trykk eller dra i bildet for å velge hva som skal være i midten av utsnittet.</p>
        <div class="focus-stage" id="fx-stage">
          <img id="fx-img" alt="Hovedbildet" data-thumb="${esc(cover.storage_path)}" draggable="false" />
          <span class="focus-dot" id="fx-dot" style="left:${cover.focus_x ?? 50}%;top:${cover.focus_y ?? 50}%"></span>
        </div>
        <div class="focus-previews" aria-hidden="true">
          <span class="fprev fprev--wide" data-thumb="${esc(cover.storage_path)}" style="background-position:${focusPos(cover)}"></span>
          <span class="fprev fprev--sq" data-thumb="${esc(cover.thumb_path)}" style="background-position:${focusPos(cover)}"></span>
          <span class="fprev fprev--pin ${type === 'trip' ? 'fprev--reise' : ''}" data-thumb="${esc(cover.thumb_path)}" style="background-position:${focusPos(cover)}"></span>
        </div>
        <div class="dlg-actions"><button type="button" class="btn btn--ghost" id="fx-reset">Midtstill</button><button type="button" class="btn btn--dark" id="fx-save">Lagre midtpunkt</button></div>
      </section>
      <h3 class="eyebrow">Velg et annet bilde</h3>` : ''}
      <p class="muted">Velg et av bildene, eller last opp et nytt. Uten valg brukes det første bildet som ble lastet opp.</p>
      ${photos.length ? `<div class="cover-grid">${photos
        .map((ph) => `<button type="button" class="cthumb ${cover?.id === ph.id ? 'cthumb--on' : ''}" data-photo="${ph.id}" data-thumb="${esc(ph.thumb_path)}" aria-label="Velg som hovedbilde" aria-pressed="${cover?.id === ph.id}"></button>`)
        .join('')}</div>` : '<p class="muted">Ingen bilder ennå.</p>'}
      <div class="dlg-actions">
        ${item.cover_photo_id ? '<button type="button" class="btn btn--ghost" id="cv-reset">Fjern valg</button>' : ''}
        <label class="btn btn--dark btn--file">${ICON.upload}<span class="cv-label">Last opp nytt</span><input type="file" accept="image/*,.heic,.heif" id="cv-file" /></label>
      </div>
    </div>`,
    (d) => {
      hydrateThumbs(d);
      const stage = $('#fx-stage', d);
      if (stage) {
        let fx = cover.focus_x ?? 50;
        let fy = cover.focus_y ?? 50;
        const apply = () => {
          const pos = `${fx}% ${fy}%`;
          $('#fx-dot', d).style.left = `${fx}%`;
          $('#fx-dot', d).style.top = `${fy}%`;
          d.querySelectorAll('.fprev').forEach((el) => (el.style.backgroundPosition = pos));
        };
        const setFrom = (e) => {
          const r = $('#fx-img', d).getBoundingClientRect();
          fx = Math.round(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)));
          fy = Math.round(Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100)));
          apply();
        };
        let dragging = false;
        stage.addEventListener('pointerdown', (e) => {
          dragging = true;
          stage.setPointerCapture(e.pointerId);
          setFrom(e);
        });
        stage.addEventListener('pointermove', (e) => dragging && setFrom(e));
        stage.addEventListener('pointerup', () => (dragging = false));
        $('#fx-reset', d).addEventListener('click', () => {
          fx = 50;
          fy = 50;
          apply();
        });
        $('#fx-save', d).addEventListener('click', async () => {
          const { error } = await supabase.from('photos').update({ focus_x: fx, focus_y: fy }).eq('id', cover.id);
          if (error) return toast(`Kunne ikke lagre: ${error.message}`, 'err');
          closeDialog();
          await loadData();
          render();
          toast('Midtpunkt lagret');
        });
      }
      d.querySelectorAll('[data-photo]').forEach((b) =>
        b.addEventListener('click', async () => {
          closeDialog();
          await setCover(type, id, b.dataset.photo);
        })
      );
      $('#cv-reset', d)?.addEventListener('click', async () => {
        closeDialog();
        await setCover(type, id, null);
      });
      $('#cv-file', d).addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const label = e.target.closest('label');
        label.classList.add('is-busy');
        $('.cv-label', label).textContent = 'Laster opp …';
        try {
          const prepared = await processFile(file);
          const [up] = await uploadAll([prepared], () => {});
          if (!up.id) throw new Error(up.error ?? 'Opplasting feilet');
          let patch;
          if (type === 'place') {
            const visit = item.visitsList?.[0];
            patch = { place_id: id, visit_id: visit?.id ?? null, trip_id: visit?.trip_id ?? null };
          } else patch = { trip_id: id };
          await supabase.from('photos').update(patch).eq('id', up.id);
          closeDialog();
          await setCover(type, id, up.id);
        } catch (err) {
          toast(`Kunne ikke laste opp: ${err.message}`, 'err');
        }
      });
    }
  );
}

// ---------- koble turer til reise ----------
function linkToursDialog(trip) {
  const linked = new Set(state.visits.filter((v) => v.trip_id === trip.id).map((v) => v.place_id));
  const visited = state.places.filter((p) => p.status === 'visited');
  const sortKey = (p) => (p.lastVisit ?? '');
  const tours = visited.filter((p) => p.mode === 'fjell').sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  const steder = visited.filter((p) => p.mode !== 'fjell').sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  const inRange = (d) => trip.start_date && trip.end_date && d && trip.start_date <= d && d <= trip.end_date;
  const opt = (p) => {
    const hint = p.visitsList.some((v) => inRange(v.visited_on)) ? '<span class="tag">I reiseperioden</span>' : '';
    return `<label class="lt-opt"><input type="checkbox" value="${p.id}" ${linked.has(p.id) ? 'checked' : ''} />
      <span class="thumb thumb--sm" ${placeCover(p) ? `data-thumb="${esc(placeCover(p).thumb_path)}" style="background-position:${focusPos(placeCover(p))}"` : ''}>${placeCover(p) ? '' : ICON.mountain}</span>
      <span class="row-text"><span class="row-title">${esc(p.name)}</span><span class="row-meta">${[KIND_LABEL[p.kind], fmtDate(p.lastVisit)].filter(Boolean).join(' · ')}</span></span>${hint}</label>`;
  };
  openDialog(
    `<div class="form">
      <div class="dlg-head"><h2>Turer på ${esc(trip.title)}</h2><button type="button" class="icon-btn" data-action="close-dlg" aria-label="Lukk">${ICON.close}</button></div>
      <p class="muted">Huk av turene og stedene som hører til reisen${trip.start_date ? ` (${fmtRange(trip.start_date, trip.end_date)})` : ''}. Besøk innenfor reiseperioden kobles automatisk; ellers opprettes et nytt besøk på reisens startdato.</p>
      <div class="lt-list">
        ${tours.length ? `<h3 class="eyebrow">Turer</h3>${tours.map(opt).join('')}` : ''}
        ${steder.length ? `<h3 class="eyebrow">Steder</h3>${steder.map(opt).join('')}` : ''}
        ${!visited.length ? emptyState('Ingen turer ennå', 'Legg til turer først, så kan de kobles til reisen.') : ''}
      </div>
      <div class="dlg-actions"><button type="button" class="btn btn--ghost" data-action="close-dlg">Avbryt</button><button type="button" class="btn btn--dark" id="lt-save">Lagre</button></div>
    </div>`,
    (d) => {
      hydrateThumbs(d);
      $('#lt-save', d).addEventListener('click', async (e) => {
        e.target.disabled = true;
        const chosen = new Set([...d.querySelectorAll('.lt-opt input:checked')].map((i) => i.value));
        try {
          for (const placeId of chosen) {
            if (linked.has(placeId)) continue;
            const place = state.places.find((p) => p.id === placeId);
            const visit =
              place.visitsList.find((v) => !v.trip_id && inRange(v.visited_on)) ??
              place.visitsList.find((v) => inRange(v.visited_on)) ??
              place.visitsList.find((v) => !v.trip_id);
            let visitId = visit?.id;
            if (visit) {
              const { error } = await supabase.from('visits').update({ trip_id: trip.id }).eq('id', visit.id);
              if (error) throw error;
            } else {
              const { data, error } = await supabase.from('visits').insert({ place_id: placeId, trip_id: trip.id, visited_on: trip.start_date }).select('id').single();
              if (error) throw error;
              visitId = data.id;
              await addPeopleToVisit(visitId, trip.people?.length ? trip.people : meIds());
            }
            await supabase.from('photos').update({ trip_id: trip.id }).eq('visit_id', visitId);
          }
          for (const placeId of linked) {
            if (chosen.has(placeId)) continue;
            const ids = state.visits.filter((v) => v.place_id === placeId && v.trip_id === trip.id).map((v) => v.id);
            if (!ids.length) continue;
            await supabase.from('visits').update({ trip_id: null }).in('id', ids);
            await supabase.from('photos').update({ trip_id: null }).in('visit_id', ids).eq('trip_id', trip.id);
          }
          closeDialog();
          await loadData();
          render();
          toast('Reisen er oppdatert');
        } catch (err) {
          e.target.disabled = false;
          toast(`Kunne ikke lagre: ${err.message}`, 'err');
        }
      });
    }
  );
}

// ---------- lightbox ----------
async function openPhoto(path) {
  const lb = $('#lightbox');
  const photo = state.photos.find((p) => p.storage_path === path);
  lb.hidden = false;
  const sel = state.selected;
  const canCover = photo && sel && (sel.type === 'place' ? photo.place_id === sel.id : coverTarget('trip', sel.id).photos.some((x) => x.id === photo.id));
  const top = `<div class="lb-bar">${canCover ? `<button type="button" class="btn btn--glass" data-action="set-cover" data-id="${photo.id}">${ICON.image}Sett som hovedbilde</button>` : ''}<button type="button" class="icon-btn lb-btn" data-action="delete-photo" data-id="${photo?.id ?? ''}" aria-label="Slett bilde" title="Slett bilde">${ICON.trash}</button><button type="button" class="icon-btn lb-btn" data-action="close-photo" aria-label="Lukk">${ICON.close}</button></div>`;
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
  if (a === 'show-on-map') {
    const type = t.dataset.type;
    state.selected = null;
    render();
    if (type === 'place') {
      const p = state.places.find((x) => x.id === id);
      if (p) state.map.flyTo(p, 13);
    } else {
      const tr = state.trips.find((x) => x.id === id);
      if (tr) state.map.fitTo(tripStops(tr));
    }
    return;
  }
  if (a === 'toggle-tracks') {
    state.showAllTracks = !state.showAllTracks;
    try {
      localStorage.setItem('turkart.showTracks', state.showAllTracks ? '1' : '0');
    } catch {}
    renderAllTracks(visiblePlaces());
    toast(state.showAllTracks ? 'Viser spor for alle turer' : 'Viser spor bare for åpen tur');
    return;
  }
  if (a === 'side-open') return setSide(true);
  if (a === 'side-close') return setSide(false);
  if (isMobile() && (a === 'select-place' || a === 'select-trip') && t.closest('.side')) setSide(false);
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
  else if (a === 'edit-visit') {
    const v = state.visits.find((x) => x.id === id);
    if (v) visitForm(state.places.find((p) => p.id === v.place_id), v);
  } else if (a === 'people') peopleDialog();
  else if (a === 'cover-pick') coverDialog(t.dataset.type, id);
  else if (a === 'cover-reset') setCover(t.dataset.type, id, null);
  else if (a === 'set-cover') {
    $('#lightbox').hidden = true;
    if (state.selected) setCover(state.selected.type, state.selected.id, id);
  } else if (a === 'link-tours') linkToursDialog(state.trips.find((x) => x.id === id));
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
