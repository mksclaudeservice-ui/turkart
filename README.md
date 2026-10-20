# Turkart

Privat kart over toppturer, reiser og steder dere vil besøke – med bilder.

- **Fjell-modus:** Kartverkets topokart, toppturer og fjellturer, ønskeliste.
- **Reise-modus:** verdenskart, reiser med stopp, land og netter.
- **Bilder:** masseopplasting med automatisk gruppering etter tid og GPS, HEIC-støtte, duplikatsjekk og en innboks for bilder uten posisjon.
- **Innlogging:** e-postlenke. Bare adressene i `allowed_users` får se eller endre noe.

## Oppsett

### 1. Supabase
1. Opprett et prosjekt på supabase.com (region Stockholm).
2. Åpne **SQL Editor**, lim inn `supabase/schema.sql`, bytt ut de to e-postadressene øverst og trykk **Run**.
3. Under **Authentication → URL Configuration**: sett **Site URL** til adressen appen skal ligge på, og legg til `http://localhost:5173` under **Redirect URLs**.
4. Når dere begge har logget inn én gang: slå av **Allow new users to sign up** under Authentication → Sign In / Providers. Data er beskyttet av tilgangslisten uansett, men da kan ingen andre opprette brukere.

### 2. Lokalt
```bash
cp .env.example .env   # fyll inn URL og anon key fra Project Settings → API
npm install
npm run dev
```

### 3. Publisering
Bygg med `npm run build` og legg `dist/` på Cloudflare Pages, Netlify eller Vercel. Sett miljøvariablene `VITE_SUPABASE_URL` og `VITE_SUPABASE_ANON_KEY` der.

## Importere bilder fra iCloud
- **Mac:** Bilder-appen → merk bildene → Arkiv → Eksporter → *Eksporter uendrede originaler* → dra mappen inn i «Last opp bilder».
- **PC:** icloud.com/photos → merk → last ned → pakk ut zip-filen → dra mappen inn.
- **iPhone:** last opp fra nettsiden. Trykk *Valg* øverst i bildevelgeren og slå på *Posisjon*.

Appen lagrer en nettversjon (maks 2048 px) og en miniatyr av hvert bilde. Originalene blir i iCloud.

## Struktur
| Fil | Innhold |
| --- | --- |
| `supabase/schema.sql` | Tabeller, tilgangsregler og privat bildelagring |
| `src/main.js` | App, visninger, skjemaer, opplastingsveiviser |
| `src/map.js` | Leaflet-kart med kartlag og nåler |
| `src/upload.js` | EXIF, HEIC-konvertering, nedskalering, opplasting |
| `src/grouping.js` | Gruppering av bilder til turforslag |
| `src/geo.js` | Stedsnavn og høyde (Kartverket, OpenStreetMap) |
