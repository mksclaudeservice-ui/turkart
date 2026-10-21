# Turkart – notater for Claude

Privat kart over toppturer og reiser for Markus og Karoline. Vite + vanilla JS + Leaflet, Supabase som backend, GitHub Pages som hosting.

## Deploy
- Push til `main` → GitHub Actions (`.github/workflows/deploy.yml`) bygger og publiserer til GitHub Pages.
- Live: https://mksclaudeservice-ui.github.io/turkart/
- Netlify (amazing-douhua-ff1a85) er ikke lenger i bruk: gratiskredittene tok slutt.
- Samle gjerne flere endringer per push.

## Supabase
- Prosjekt-ref: `wucaivamwrnuvczrvios` (org «mksclaudeservice's Org»), region Europa.
- Skjema: `supabase/schema.sql` (idempotent). Nye endringer legges nederst som egen seksjon.
- Databaseendringer kan ikke kjøres fra sky-miljøet (supabase.co er blokkert). Kjør dem i
  SQL Editor via Chrome når brukeren er ved PC, eller be brukeren lime inn SQL-en.
- Tilgang styres av `public.allowed_users` + RLS-policy `members_all` på alle tabeller.
- Tabeller: places, visits, trips, photos, notes, allowed_users. Bildebøtte: `photos` (privat).

## Brukere
- E-postadresser skal ikke ligge i koden eller repoet. De ligger i `allowed_users` (tilgang, `is_admin`)
  og `people.emails` (kobling person ↔ innlogging). Endres i SQL Editor eller i appen.

## Konvensjoner
- All UI-tekst på norsk bokmål.
- Feedback fra brukerne ligger i tabellen `notes` (kind: feedback/ide/notat, done).
