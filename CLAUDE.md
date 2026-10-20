# Turkart – notater for Claude

Privat kart over toppturer og reiser for Markus og Karoline. Vite + vanilla JS + Leaflet, Supabase som backend, Netlify som hosting.

## Deploy
- Push til `main` → Netlify bygger og publiserer automatisk (`netlify.toml`).
- Live: https://amazing-douhua-ff1a85.netlify.app
- Ikke lag zip-filer lenger; push er hele deployen.

## Supabase
- Prosjekt-ref: `wucaivamwrnuvczrvios` (org «mksclaudeservice's Org»), region Europa.
- Skjema: `supabase/schema.sql` (idempotent). Nye endringer legges nederst som egen seksjon.
- Databaseendringer kan ikke kjøres fra sky-miljøet (supabase.co er blokkert). Kjør dem i
  SQL Editor via Chrome når brukeren er ved PC, eller be brukeren lime inn SQL-en.
- Tilgang styres av `public.allowed_users` + RLS-policy `members_all` på alle tabeller.
- Tabeller: places, visits, trips, photos, notes, allowed_users. Bildebøtte: `photos` (privat).

## Brukere
- Admin: admin1@example.com, admin2@example.com (se `ADMIN_EMAILS` i `src/main.js`).
- Medlem: medlem@example.com.

## Konvensjoner
- All UI-tekst på norsk bokmål.
- Feedback fra brukerne ligger i tabellen `notes` (kind: feedback/ide/notat, done).
