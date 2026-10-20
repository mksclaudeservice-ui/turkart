-- Turkart – databaseoppsett for Supabase
-- Kjør hele filen i Supabase: SQL Editor → New query → lim inn → Run.
-- Filen kan kjøres flere ganger uten å ødelegge noe.

-- 1. Hvem som har tilgang ---------------------------------------------------
create table if not exists public.allowed_users (
  email text primary key
);

-- Bytt ut med deres to e-postadresser før du kjører:
insert into public.allowed_users (email) values
  ('admin1@example.com')
on conflict do nothing;

create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.allowed_users
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- 2. Reiser -----------------------------------------------------------------
create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  start_date date,
  end_date date,
  countries text[] not null default '{}',
  status text not null default 'done' check (status in ('done', 'wish')),
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- 3. Steder (topper, utsiktspunkter, byer, overnattinger …) -----------------
create table if not exists public.places (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mode text not null default 'fjell' check (mode in ('fjell', 'reise')),
  kind text not null default 'topptur'
    check (kind in ('topptur', 'skitur', 'toppskitur', 'fjelltur', 'sykkeltur', 'padletur', 'klatring', 'utsikt', 'hytte', 'sted', 'by', 'overnatting')),
  status text not null default 'visited' check (status in ('visited', 'wish')),
  lat double precision not null,
  lon double precision not null,
  elevation integer,
  country text,
  wish_season text,
  wish_priority smallint check (wish_priority between 1 and 3),
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- 4. Besøk (ett sted kan besøkes flere ganger) ------------------------------
create table if not exists public.visits (
  id uuid primary key default gen_random_uuid(),
  place_id uuid not null references public.places (id) on delete cascade,
  trip_id uuid references public.trips (id) on delete set null,
  visited_on date,
  notes text,
  distance_km numeric(6, 1),
  ascent_m integer,
  duration_min integer,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- 5. Bilder -----------------------------------------------------------------
create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null,
  thumb_path text not null,
  sha256 text not null unique,
  original_name text,
  taken_at timestamptz,
  lat double precision,
  lon double precision,
  width integer,
  height integer,
  place_id uuid references public.places (id) on delete set null,
  visit_id uuid references public.visits (id) on delete set null,
  trip_id uuid references public.trips (id) on delete set null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists photos_place_idx on public.photos (place_id);
create index if not exists photos_visit_idx on public.photos (visit_id);
create index if not exists photos_taken_idx on public.photos (taken_at);
create index if not exists visits_place_idx on public.visits (place_id);

-- 6. Tilgangsregler: bare medlemmer leser og skriver ------------------------
alter table public.allowed_users enable row level security;
alter table public.trips enable row level security;
alter table public.places enable row level security;
alter table public.visits enable row level security;
alter table public.photos enable row level security;

do $$
declare t text;
begin
  foreach t in array array['trips', 'places', 'visits', 'photos'] loop
    execute format('drop policy if exists "members_all" on public.%I', t);
    execute format(
      'create policy "members_all" on public.%I for all to authenticated using (public.is_member()) with check (public.is_member())',
      t
    );
  end loop;
end $$;

drop policy if exists "members_read" on public.allowed_users;
create policy "members_read" on public.allowed_users
  for select to authenticated using (public.is_member());

-- 7. Bildelagring (privat bøtte) --------------------------------------------
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do update set public = false;

drop policy if exists "photos_members_select" on storage.objects;
drop policy if exists "photos_members_insert" on storage.objects;
drop policy if exists "photos_members_update" on storage.objects;
drop policy if exists "photos_members_delete" on storage.objects;

create policy "photos_members_select" on storage.objects
  for select to authenticated using (bucket_id = 'photos' and public.is_member());
create policy "photos_members_insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'photos' and public.is_member());
create policy "photos_members_update" on storage.objects
  for update to authenticated using (bucket_id = 'photos' and public.is_member());
create policy "photos_members_delete" on storage.objects
  for delete to authenticated using (bucket_id = 'photos' and public.is_member());

-- 8. Oppdater lovlige typer (kjøres på eksisterende database) -----------------
alter table public.places drop constraint if exists places_kind_check;
alter table public.places add constraint places_kind_check
  check (kind in ('topptur', 'skitur', 'toppskitur', 'fjelltur', 'sykkeltur', 'padletur', 'klatring', 'utsikt', 'hytte', 'sted', 'by', 'overnatting'));

-- 9. Notater og feedback ------------------------------------------------------
create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  body text not null,
  kind text not null default 'feedback' check (kind in ('feedback', 'ide', 'notat')),
  context text,
  done boolean not null default false,
  author_email text default (auth.jwt() ->> 'email'),
  created_at timestamptz not null default now()
);
alter table public.notes enable row level security;
drop policy if exists "members_all" on public.notes;
create policy "members_all" on public.notes for all to authenticated
  using (public.is_member()) with check (public.is_member());

-- 10. Personer, hovedbilder ---------------------------------------------------
create table if not exists public.people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  avatar_path text,
  created_at timestamptz not null default now()
);
create table if not exists public.visit_people (
  visit_id uuid not null references public.visits (id) on delete cascade,
  person_id uuid not null references public.people (id) on delete cascade,
  primary key (visit_id, person_id)
);
create table if not exists public.trip_people (
  trip_id uuid not null references public.trips (id) on delete cascade,
  person_id uuid not null references public.people (id) on delete cascade,
  primary key (trip_id, person_id)
);
alter table public.places add column if not exists cover_photo_id uuid references public.photos (id) on delete set null;
alter table public.trips add column if not exists cover_photo_id uuid references public.photos (id) on delete set null;

do $$
declare t text;
begin
  foreach t in array array['people', 'visit_people', 'trip_people'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "members_all" on public.%I', t);
    execute format(
      'create policy "members_all" on public.%I for all to authenticated using (public.is_member()) with check (public.is_member())',
      t
    );
  end loop;
end $$;

insert into public.people (name)
select n from (values ('Markus Søderlind'), ('Karoline')) as v(n)
where not exists (select 1 from public.people);

-- 11. Personer koblet til innlogging -------------------------------------------
alter table public.people add column if not exists emails text[] not null default '{}';
update public.people set emails = array['admin1@example.com', 'admin2@example.com']
  where name = 'Markus Søderlind' and emails = '{}';
update public.people set emails = array['medlem@example.com']
  where name = 'Karoline' and emails = '{}';

-- 12. Midtpunkt for bildeutsnitt (prosent, null = midten) ------------------------
alter table public.photos add column if not exists focus_x real;
alter table public.photos add column if not exists focus_y real;

-- 13. GPS-spor fra treningsklokke ------------------------------------------------
create table if not exists public.tracks (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references public.visits (id) on delete cascade,
  source text,
  original_name text,
  started_at timestamptz,
  duration_min integer,
  distance_km numeric(7, 2),
  ascent_m integer,
  max_ele integer,
  points jsonb not null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists tracks_visit_idx on public.tracks (visit_id);
alter table public.tracks enable row level security;
drop policy if exists "members_all" on public.tracks;
create policy "members_all" on public.tracks for all to authenticated
  using (public.is_member()) with check (public.is_member());
