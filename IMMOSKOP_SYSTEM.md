# IMMOSKOP – Vollständiges Systemdokument
**Stand: April 2026 (Session 4) | Dies ist das Projektgedächtnis. Immer aktuell halten.**

---

## 1. WAS IST IMMOSKOP?

Eine kostenlose Schweizer Immobilien-Analysetool unter **www.immoskop.ch**.  
Nutzer geben eine Adresse ein (oder fügen einen Inseratstext ein), und erhalten:
- Preisbewertung (über/unter Markt?)
- Lärm, Besonnung, ÖV, Umgebung, Sicherheit
- Besichtigungs-Checkliste (Kauf/Miete)
- Optional: KI-Report (Claude)

**Sprachen:** DE / EN / FR  
**Typ:** Kauf und Miete, Wohnung und Haus

---

## 2. TECHNOLOGIE-STACK

| Schicht | Technologie |
|---|---|
| Frontend | Statisches HTML/CSS/JS (index.html) |
| Backend | Vercel Serverless Functions (Node.js) |
| Datenbank | Supabase (PostgreSQL) |
| KI | Anthropic Claude Sonnet API |
| Deployment | GitHub → Vercel Auto-Deploy |
| Domain | GoDaddy (immoskop.ch) |
| E-Mail | Protonmail (kontakt@immoskop.ch) |

**Repo:** `ldaescher/immoskop` auf GitHub  
**Vercel:** Free Plan (100 Deployments/Tag Limit!)  
**Supabase Project URL:** `clwdxufyeiznyhrfrysl.supabase.co`

---

## 3. DATEISTRUKTUR (GitHub Repo Root)

```
/
├── index.html              # Hauptseite (alles in einer Datei: HTML + CSS + JS)
├── ueber-uns.html
├── datenschutz.html
├── impressum.html
├── kontakt.html
├── logo.png
├── favicon.ico
├── IMMOSKOP_SYSTEM.md      # Projektgedächtnis (dieses Dokument)
├── api/
│   ├── data.js             # Hauptendpunkt: Geocoding, Preise, Lärm, Solar, ÖV
│   ├── parse.js            # Claude liest Inseratstext → strukturierte Daten
│   ├── report.js           # Claude generiert KI-Report
│   ├── contact.js          # Kontaktformular → Protonmail SMTP
│   └── track.js            # Analytics → Supabase
└── scraper/                # Datenerhebung (lokal ausführen, nicht auf Vercel)
    ├── run_all.js          # Master-Scraper (empfohlen)
    ├── 1_harvest_slugs.js  # Kantonsseiten → slugs.json
    ├── 1b_find_missing.js  # OpenPLZ → fehlende Gemeinden
    ├── 2_scrape_plz.js     # RSC-Endpoint → PLZ + Strassen
    ├── 3_scrape_streets.js # OBSOLET (in 2_scrape_plz.js integriert)
    ├── 4_merge_and_upload.js # Merge + Supabase-Upload
    ├── README.md
    ├── .gitignore
    └── data/
        ├── slugs.json          # ✅ committen – 2109 Gemeinden
        ├── plz_overrides.json  # ✅ committen – manuelle Korrekturen
        └── street_overrides.json # ✅ committen
        # plz_prices_raw.json   ← NICHT committen (gross, regenerierbar)
        # street_prices_raw.json ← NICHT committen
```

---

## 4. VERCEL ENVIRONMENT VARIABLES

Diese müssen in Vercel → Settings → Environment Variables gesetzt sein:

| Variable | Beschreibung |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API Key |
| `SUPABASE_URL` | `https://clwdxufyeiznyhrfrysl.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Supabase Service Role Key (umgeht RLS) |
| `GEOAPIFY_API_KEY` | Für Geocoding-Fallback (falls nötig) |
| `PROTONMAIL_USER` | `kontakt@immoskop.ch` |
| `PROTONMAIL_TOKEN` | Protonmail SMTP Token |

---

## 5. SUPABASE – DATENBANK

### Tabellen

#### `plz_prices` – PLZ-Marktpreise (Haupt-Preistabelle)
Befüllt durch `scraper/2_scrape_plz.js` (RSC-Endpoint). Enthält **2109 Gemeinden + 3936 PLZ-Localities** (fast alle CH-PLZ).

| Spalte | Typ | Beschreibung |
|---|---|---|
| `slug` | text | RealAdvisor-Slug (z.B. `stadt-zurich`, `8001-zurich`) |
| `typ` | text | `gemeinde` (aggregiert) oder `locality` (PLZ-spezifisch) |
| `name` | text | Gemeinde-/Ortsname |
| `plz` | text | Schweizer PLZ (nullable) |
| `kanton` | text | Kantonskürzel (z.B. `ZH`) |
| `gemeinde_slug` | text | Verweis auf Eltern-Gemeinde (nur bei typ=locality) |
| `kauf_whg_median` | numeric | Kaufpreis Wohnung Median CHF/m² |
| `kauf_whg_p10` | numeric | Kaufpreis Wohnung P10 |
| `kauf_whg_p90` | numeric | Kaufpreis Wohnung P90 |
| `kauf_haus_median` | numeric | Kaufpreis Haus Median CHF/m² |
| `kauf_haus_p10/p90` | numeric | Kaufpreis Haus Perzentile |
| `miete_whg_median` | numeric | Miete Wohnung Median CHF/m²/Monat |
| `miete_whg_p10/p90` | numeric | Miete Wohnung Perzentile |
| `miete_haus_median` | numeric | Miete Haus Median CHF/m²/Monat |
| `miete_haus_p10/p90` | numeric | Miete Haus Perzentile |
| `has_override` | boolean | Manuell korrigiert |
| `override_note` | text | Begründung der Korrektur |
| `source` | text | `realadvisor` |
| `scraped_at` | timestamptz | Zeitstempel |

**Priorität in api/data.js:** locality (PLZ-spezifisch) → gemeinde (aggregiert) → Fallback-Modell

**Wichtig:** Localities haben nur Median (kein P10/P90). P10/P90 nur bei typ=gemeinde.

#### `street_prices` – Strassengenaue Preise
Befüllt durch `scraper/2_scrape_plz.js` (gleicher RSC-Request wie PLZ). Enthält **25241 Strassen**.

| Spalte | Typ | Beschreibung |
|---|---|---|
| `gemeinde_slug` | text | RealAdvisor Gemeinde-Slug |
| `strasse_slug` | text | URL-Slug der Strasse |
| `strasse_name` | text | Strassenname (Original) |
| `strasse_name_lower` | text | Kleinschreibung (für ILIKE-Suche) |
| `plz` | text | PLZ (aus Locality-Slug, nullable) |
| `lat`, `lng` | numeric | Koordinaten |
| `is_cross_locality` | boolean | Strasse über mehrere PLZ |
| `kauf_median` | numeric | Kaufpreis Median CHF/m² (kombiniert, kein Typ-Split) |
| `kauf_p15` | numeric | 15. Perzentile Kauf |
| `kauf_p85` | numeric | 85. Perzentile Kauf |
| `transaction_count` | int | Anzahl Transaktionen (RealAdvisor-Makler, nicht repräsentativ) |
| `has_override` | boolean | Manuell korrigiert |
| `source` | text | `realadvisor` |
| `scraped_at` | timestamptz | Zeitstempel |

**Kein Mietpreis auf Strassenebene** – RealAdvisor liefert nur Kaufpreis pro Strasse.
Für Mietpreisschätzung: Strassen-Percentile berechnen und auf PLZ-Mietpreis anwenden.

**Suche in api/data.js:** Zuerst via `plz`, Fallback via `gemeinde_slug` (wichtig für Zürich).

**Wie street_prices in api/data.js verwendet wird:**
1. Strassenname wird aus der Adresse extrahiert (alles vor der Hausnummer)
2. Supabase-Query: `street_prices?plz=eq.{plz}&street_name_lower=ilike.*{street}*`
3. Falls Treffer: `streetPercentile` wird berechnet (lineare Interpolation: wo liegt die Strasse in der Gemeinde-Preisspanne P10–Median–P90?)
4. Dieser Percentile-Wert wird dann auch auf den Mietpreis angewendet
5. `priceSource` wird `'RealAdvisor (strassengenau)'` statt `'RealAdvisor'`
6. Im Frontend sichtbar: `· Rigistrasse (67. Perz.)`

**Beispiel Logik:**
```javascript
// Strassenpreis CHF 21'000/m², Gemeinde P10=12'000, Median=18'000, P90=25'000
// → Strasse liegt zwischen Median und P90
// → percentile = 50 + 40 * (21000-18000)/(25000-18000) = ~67. Perzentile
// → Mietpreis-Schätzung entsprechend nach oben angepasst
```

**Warum PLZ mehrfach pro Strasse?**  
`street_scraper.js` legt für jede PLZ einer Gemeinde einen Eintrag an.  
Zürich hat z.B. 20+ PLZ → jede Strasse erscheint 20+ mal (gleiche Daten, andere PLZ).  
Das ist gewollt, damit die Suche via PLZ immer funktioniert.

#### `analytics_events` – Usage-Tracking
| Spalte | Beschreibung |
|---|---|
| `event_type` | z.B. `analysis`, `report` |
| `city`, `street_name` | Anonymisiert |
| `listing_type` | `miete` / `kauf` |
| `delta_pct` | Preisabweichung in % |
| `is_owner` | Boolean (Owner-Mode via `?owner=true`) |
| `session_id` | Zufällige Session-ID |
| ... | Weitere Analytics-Felder |

#### `municipality_tax_burden` – Steuerbelastung (NOCH NICHT BEFÜLLT)
Geplant: Einkommenssteuer pro Gemeinde (ESTV-Daten).

### RLS-Policies
```sql
-- plz_prices, street_prices, municipality_tax_burden: public read
-- analytics_events: insert only (kein anonymes Lesen)
-- is_owner Spalte: ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS is_owner boolean DEFAULT false;
```

### Admin-Passwort
⚠️ **TODO: Admin-Passwort in Supabase ändern** (steht noch auf Default)

---

## 6. DATEN – MARKTPREISE (REALADVISOR)

### Wie die Daten entstehen (April 2026)

**Methode:** React Server Components (RSC) Endpoint – ein Request pro Gemeinde liefert alles.
URL: `GET https://realadvisor.ch/de/immobilienpreise-pro-m2/{slug}` mit Header `RSC: 1`

**Was ein Request liefert:**
- Kaufpreise Whg + Haus (Median, P10, P90) pro Gemeinde
- Jahresmiete Whg + Haus (Median, P10, P90) → ÷12 = CHF/m²/Monat
- PLZ-Localities (z.B. 8001, 8002... für Stadt Zürich) mit PLZ-spezifischen Medianen
- Alle Strassen mit Kaufpreis (Median, P15, P85)

**Scraper-Ablauf:**
1. `1_harvest_slugs.js` → Kantonsseiten (Top-75 pro Kanton)
2. `1b_find_missing.js` → OpenPLZ API → fehlende Gemeinden
3. Merge → ~2109 Gemeinden in `data/slugs.json`
4. `2_scrape_plz.js` → RSC-Endpoint → PLZ + Strassen in einem Durchgang
5. `4_merge_and_upload.js` → Merge mit Overrides → Supabase (atomar)

**Skript 3 (`3_scrape_streets.js`) ist obsolet** – Strassendaten kommen aus Schritt 4.

### Master-Scraper (empfohlen)
```bash
cd immoskop/scraper
export SUPABASE_URL=https://clwdxufyeiznyhrfrysl.supabase.co
export SUPABASE_SERVICE_KEY=eyJ...
node run_all.js
```

### Einzelne Schritte
```bash
node 1_harvest_slugs.js          # ~3 Min
node 1b_find_missing.js          # ~5 Min
# Merge: node /tmp/merge_missing.js (siehe HOW TO)
node 2_scrape_plz.js             # ~90 Min (--resume, --kanton ZH)
node 4_merge_and_upload.js       # ~5 Min (--dry-run, --plz-only)
```

### Fehlende PLZ manuell nachtragen
Für PLZ ohne RealAdvisor-Seite (z.B. 7402 Bonaduz): Direkt in Supabase einfügen:
```sql
INSERT INTO plz_prices (plz, median_price_sqm, rent_p10, rent_p90, 
  median_sale_price_sqm, sale_p10, sale_p90, source, scraped_at)
VALUES ('7402', 18.5, 12.0, 28.0, 7800, 4000, 13000, 'manual', NOW())
ON CONFLICT (plz) DO UPDATE SET 
  median_sale_price_sqm = EXCLUDED.median_sale_price_sqm,
  scraped_at = NOW();
```

### Fallback-Modell (für PLZ ohne Supabase-Eintrag)
In `api/data.js`:
```javascript
const BASE_QM = {
  '80':22.5, '81':21, '82':19.5, '83':17.5, '84':18, '85':20,
  '86':18.5, '87':17, '88':19, '89':16.5, '30':17, '31':16.5,
  '40':18.5, '41':17.8, '10':23, '12':25, '60':18, '70':15,
  '71':14.5, '72':14, '73':13.5, 'default':17
};
```
Quelle: `priceSource = 'Modell (keine Supabase-Daten für diese PLZ)'`

---

## 7. API-ENDPUNKTE (`/api/`)

### `POST /api/data`
**Input:** `{ address, rooms, area, price, type, propertyKind, year, floor, outdoor, condition, extraInfo }`  
**Was er tut:**
1. Geocoding via swisstopo API
2. Lädt PLZ-Preise aus Supabase (`plz_prices`)
3. Lädt Strassenpreise aus Supabase (`street_prices`)
4. Berechnet `expected`, `delta` (% Abweichung vom Markt)
5. Holt Lärmdaten (BAFU sonBASE Pixel-API)
6. Holt Solardaten (swisstopo BFE)
7. Holt ÖV + POI (OpenStreetMap Overpass API)
8. Steuerbelastung (ESTV, falls `municipality_tax_burden` befüllt)

**Output:** `{ meta: { delta, expected, priceSource, noiseDay, solarKwh, oevDist, oevName, amenitySummary, ... } }`

**Geocoding-Flow:**
1. Prüfe ob Adresse Hausnummer enthält
2. Wenn ja: `origins=address` via swisstopo
3. Wenn nein oder kein Ergebnis: `origins=gg25,zipcode` → `geoAccuracy='gemeinde'`
4. Bei Gemeinde-Fallback: `noiseDay=null`, Trust Layer zeigt Warnung

**Noise-Flow (BAFU Pixel-Klassifikation):**
- `sat < 0.08` → OSM-Fallback
- `hue 80–160` (grün) → 50 dB
- `hue 50–80` (gelbgrün) → 57 dB
- `hue 25–50` (orange) → 62 dB
- `hue 0–25 / 345+` (rot) → 67 dB
- `hue 270–345` (lila) → 73 dB

### `POST /api/parse`
**Input:** `{ text }` (Inseratstext)  
**Was er tut:** Claude extrahiert strukturierte Daten aus Inseratstext  
**Output:** `{ parsed: { adresse, preis, preistyp, flaeche, zimmer, baujahr_kategorie, aussenraum, zustand, befristet, befristet_details } }`

### `POST /api/report`
**Input:** Alle Analyse-Daten  
**Was er tut:** Claude generiert vollständigen KI-Report  
**Output:** `{ report: "..." }` (Markdown)

### `POST /api/track`
**Input:** Analytics-Felder  
**Was er tut:** Schreibt Event in `analytics_events`  
**Owner-Mode:** `?owner=true` in URL setzt LocalStorage-Flag, alle Tracks haben `is_owner=true`

### `POST /api/contact`
**Input:** `{ name, email, message }`  
**Was er tut:** Sendet E-Mail via Protonmail SMTP

---

## 8. FRONTEND (`index.html`)

### Wichtige globale Funktionen
| Funktion | Beschreibung |
|---|---|
| `runAnalysis()` | Hauptfluss: Geocode → /api/data → Render |
| `parseInserat()` | Inseratstext → /api/parse → Felder füllen |
| `generateReport()` | → /api/report → Render |
| `renderEnginesOnly()` | Re-render nach Sprachwechsel |
| `runInsightEngine()` | Insight-Text generieren |
| `runDealEngine()` | Deal-Score + Label |
| `runVerdictEngine()` | Hauptverdikt + Badge |
| `runConversionEngine()` | CTA-Logik |
| `runTrustEngine()` | Coverage + Warnings |
| `runNegotiationEngine()` | Verhandlungsmodul |
| `renderNegotiationBlock()` | UI-Render Verhandlung |
| `generateNegScript()` | Anfragetext generieren |
| `renderChecklist()` | i18n-aware Checkliste |
| `renderTrustLayer()` | Trust-Layer rendern |
| `makeMetricCard()` | Kachel-Builder |
| `getT()` / `getH()` | Live-Übersetzungen |

### i18n System
- `currentLang` Variable: `'de'` / `'en'` / `'fr'`
- `TRANSLATIONS` Objekt mit allen Texten in 3 Sprachen
- `data-i18n="key"` Attribute auf HTML-Elementen
- `applyTranslations()` wendet alle Übersetzungen an
- Bei Sprachwechsel: `renderEnginesOnly()` re-rendert alle dynamischen Blöcke

### Browser-Tab Titel
- DE: "Immoskop – Immobilien-Entscheider"
- EN: "Immoskop – Property Decider"
- FR: "Immoskop – Décideur immobilier"

### Owner-Mode (Analytics)
- URL: `https://www.immoskop.ch?owner=true` → setzt dauerhaft
- URL: `https://www.immoskop.ch?owner=false` → entfernt
- Alle Analyse-Events mit `is_owner=true` gefiltert in Analytics

---

## 9. EXTERNE APIS

| API | Zweck | Kosten |
|---|---|---|
| swisstopo SearchServer | Geocoding (Adressen → Koordinaten) | Kostenlos |
| BAFU sonBASE | Strassenlärmkarte (Pixel-Abfrage) | Kostenlos |
| swisstopo BFE | Solarpotenzial Fassaden | Kostenlos |
| OpenStreetMap Overpass | ÖV, POI (Schulen, Supermärkte etc.) | Kostenlos |
| Anthropic Claude Sonnet | KI-Report + Inserats-Parsing | Bezahlt |
| Geoapify | Geocoding-Fallback | Bezahlt (Key vorhanden) |

---

## 10. DEPLOYMENT

### Normales Deployment
1. Dateien ändern
2. Auf GitHub commiten (main branch)
3. Vercel deployed automatisch

### Vercel Limit beachten!
- Free Plan: **100 Deployments/Tag**
- Preview-Deployments zählen mit (können auf Free nicht deaktiviert werden)
- **Trick:** GitHub Web-Editor (`.`-Taste im Repo) für Multi-File-Commits verwenden, um Deployments zu sparen

### Wenn etwas nicht funktioniert:
1. Vercel Dashboard → Functions → Logs prüfen
2. `console.log` in api/*.js einbauen, re-deployen
3. Häufige Fehler: `req.body` ist null (fehlende Body-Parsing), JSON.parse schlägt fehl bei leerem Body

---

## 11. OFFENE PENDENZEN

### Hoch-Priorität
- [ ] **Admin-Passwort in Supabase ändern**
- [ ] **`municipality_tax_burden` Tabelle befüllen** (ESTV-Daten)
- [ ] **PLZ-Landingpages** für SEO (z.B. `/plz/8001`, `/plz/3000`)

### Mittel
- [ ] `checker.html` hat kein i18n-System
- [ ] FAQ-Sektion auf Hauptseite
- [ ] User-Inserate als Preis-Signale verwenden (inserat_signals.json)

### Niedrig
- [ ] PWA (Progressive Web App)
- [ ] Italienisch (IT) für Tessin
- [ ] Kanton-Median als zweite Fallback-Ebene in api/data.js

### Erledigt ✅
- [x] Alle ~2109 CH-Gemeinden gescrapt (April 2026)
- [x] 3936 PLZ-Localities mit PLZ-spezifischen Preisen
- [x] 25241 Strassen mit Kaufpreisen
- [x] api/data.js auf neue Spalten migriert
- [x] Street-Matching Fallback via gemeinde_slug (wichtig für Zürich)
- [x] parse.js Aussenraum-Bug gefixt
- [x] Autobahn-Kachel im Frontend (Overpass 25km, OSRM Fahrzeit)
- [x] Aussenraum: Checkboxen (Balkon + Terrasse + Garten kombinierbar)
- [x] Parkplatz: separate Stepper Aussen/TG mit präzisem Faktor
- [x] extraInfo-Adjustment via Claude Haiku (auch ohne Parse-Button)
- [x] Leerwohnungsziffer BFS 2024: 454 Gemeinden (Tagesanzeiger/BFS) + Kantons-Fallback
- [x] Marktlage-abhängige Verhandlungslogik (LWZ < 0.5% = kein Verhandlungstipp)
- [x] report.js: neue Spaltennamen, LWZ/Marktlage im Prompt
- [x] Basic Auth (JS Prompt, PW: Easypeazy78) für Preview-Schutz
- [x] SDMX-API für LWZ identifiziert (disseminate.stats.swiss)
- [x] LWZ alle 2278 Gemeinden via SDMX-API geladen (BFS 2024)
- [x] marktlage ReferenceError gefixt (war vor Deklaration verwendet → Autobahn/LWZ silent fail)
- [x] DealScore Hard Cap: delta≥10% → max 59/100, delta≥20% → max 44/100
- [x] Banner: 2100+ Gemeinden (war fälschlich 6000+)
- [x] Report-Widerspruch gefixt: Frontend-Verdict als PFLICHT-Anweisung in report.js Prompt (Session 4)
- [x] Autobahn-Bug gefixt: `out body` → `out geom` + bestRef-Fallback auf wayRefs (Session 4)
- [x] Strassenpreis-Fallback gefixt: gemeinde_slug für typ=gemeinde aus slug ableiten (Session 4)

---

## 12. DATEN-QUALITÄT PRÜFEN

### Aktueller Stand (April 2026)
```sql
SELECT typ, COUNT(*) FROM plz_prices GROUP BY typ;
-- gemeinde: 2109
-- locality: 3920

SELECT COUNT(*) FROM street_prices;
-- 25241
```

### PLZ-Daten für eine Region prüfen
```sql
-- Alle PLZ-Localities für Zürich
SELECT plz, name, kauf_whg_median, miete_whg_median 
FROM plz_prices WHERE gemeinde_slug = 'stadt-zurich' ORDER BY plz;

-- Gemeinde-Daten für Graubünden
SELECT slug, name, kauf_whg_median FROM plz_prices 
WHERE kanton = 'GR' AND typ = 'gemeinde' ORDER BY name;
```

### PLZ manuell korrigieren (via plz_overrides.json)
Nicht direkt in Supabase eintragen – stattdessen in `scraper/data/plz_overrides.json`:
```json
{
  "_note": "Korrektur April 2026",
  "_date": "2026-04-04",
  "slug": "gemeinde-bonaduz",
  "plz": "7402",
  "kauf_whg_median": 7800,
  "miete_whg_median": 18.0
}
```
Dann: `node 4_merge_and_upload.js` (kein Re-Scrape nötig)

---

## 13. SCRAPER VERWENDEN (falls Daten veraltet)

Siehe Abschnitt 17 (HOW TO) für den vollständigen Ablauf.

### Kurzversion
```bash
cd immoskop/scraper
export SUPABASE_URL=https://clwdxufyeiznyhrfrysl.supabase.co
export SUPABASE_SERVICE_KEY=eyJ...
node run_all.js
```

### Neue Gemeinde hinzufügen
Falls eine Gemeinde fehlt: Slug auf RealAdvisor suchen, dann in
`scraper/data/plz_overrides.json` eintragen und `node 4_merge_and_upload.js` ausführen.

Für kompletten Re-Scrape: `node run_all.js` (überschreibt alles).

---

## 14. WICHTIGE DESIGN-ENTSCHEIDUNGEN

### Warum eine einzelne HTML-Datei?
- Einfacher zu deployen, kein Build-Step nötig
- Vercel braucht nichts zu kompilieren
- Nachteil: Datei wird gross

### Warum Supabase statt direktem API-Call?
- Scraping einmal machen, Daten cachen
- Schneller als bei jeder Anfrage RealAdvisor scrapen
- RealAdvisor-ToS: direktes Scrapen im Produktivbetrieb problematisch

### Warum kein Framework (React/Vue)?
- Kein Build-Step = kein Deployment-Overhead
- Für ein Single-Page-Tool ausreichend
- Einfacher zu warten für eine Person

---

## 15. TROUBLESHOOTING

### "JSON Parse Error" oder leere Response
→ `req.body` in api/*.js prüfen, ob null guard vorhanden

### "404 Not Found" für API
→ Datei muss unter `api/` liegen, nicht `api/v1/` oder anderem Pfad

### Geocoding schlägt fehl
→ Flow: Hausnummer vorhanden? → `origins=address` → sonst `origins=gg25,zipcode`
→ Bei `geoAccuracy='gemeinde'`: noiseDay=null, Trust Layer zeigt Warnung

### Vercel Deployment schlägt fehl
→ Logs in Vercel Dashboard prüfen
→ Häufig: `SUPABASE_SERVICE_KEY` nicht gesetzt, oder Syntax-Error in api/*.js

### Supabase RLS-Fehler
→ Service Key verwendet RLS-Bypass → sollte nie ein Problem sein
→ Anon Key (im Frontend) braucht explizite Policies


---

## 16. PERIODISCHE AUFGABEN (TO DO)

### Jährlich (September)
- [ ] **Leerwohnungsziffer updaten** – BFS publiziert jeweils im September die neuen Daten per 1. Juni
  → `data.js` Konstanten `LWZ_GEMEINDE` + `LWZ_KANTON` updaten
  → Skript: `node /tmp/lwz_fetch.js` (fetcht von SDMX-API, schreibt /tmp/lwz_alle.json)
  → SDMX-API: `https://disseminate.stats.swiss/rest/data/CH1.LWZ,DF_LWZ_1,1.0.0/+.+.+.+.+.V.A?startPeriod=2024&endPeriod=2024&dimensionAtObservation=AllDimensions&format=jsondata`
  → Filter: LEERWOHN_TYP=`_T` (Total), MEASURE_DIMENSION=`PC` (Rate in %)
  → Aktuell: BFS Leerwohnungszählung 2024 (Stand: 1. Juni 2024)
  → 454 Gemeinden in LWZ_GEMEINDE (Tagesanzeiger-Daten), Kantons-Fallback in LWZ_KANTON

### Monatlich
- [ ] **Preisdaten neu scrapen** – RealAdvisor aktualisiert Preise monatlich
  → `cd immoskop/scraper && node run_all.js`
- [ ] **Supabase-Datenqualität prüfen** nach jedem Upload:
  ```sql
  SELECT typ, COUNT(*) FROM plz_prices GROUP BY typ;
  -- gemeinde: ~2109, locality: ~3920
  SELECT COUNT(*) FROM street_prices;
  -- ~25241
  ```

### Bei Bedarf
- [ ] **Manuelle Korrekturen** – wenn Scraper-Daten falsch sind
  → `scraper/data/plz_overrides.json` bearbeiten, dann `node 4_merge_and_upload.js`
- [ ] **Admin-Passwort in Supabase ändern** ⚠️ (noch offen!)
- [ ] **`municipality_tax_burden` befüllen** (ESTV-Daten)

---

## 17. HOW TO – SCHRITT FÜR SCHRITT

### Preisdaten scrapen und Supabase aktualisieren

**Voraussetzungen:**
- Node.js v18+ installiert
- Repo geklont: `git clone https://github.com/ldaescher/immoskop.git`
- Supabase Service Key (in Vercel → Settings → Environment Variables)

```bash
# Empfohlen: Master-Scraper
cd immoskop/scraper
export SUPABASE_URL=https://clwdxufyeiznyhrfrysl.supabase.co
export SUPABASE_SERVICE_KEY=eyJ...
node run_all.js
# Dauer: ~2 Stunden

# Optionen:
node run_all.js --skip-harvest   # Slugs nicht neu harvesten (slugs.json vorhanden)
node run_all.js --skip-scrape    # Scraping überspringen (Rohdaten vorhanden)
node run_all.js --dry-run        # Kein Upload (nur Merge prüfen)

# Einzelschritte:
node 1_harvest_slugs.js          # Kantonsseiten → slugs.json (~3 Min)
node 1b_find_missing.js          # OpenPLZ → fehlende Gemeinden (~5 Min)
node 2_scrape_plz.js             # PLZ + Strassen (~90 Min)
node 2_scrape_plz.js --resume    # Nach Unterbruch fortsetzen
node 2_scrape_plz.js --kanton ZG # Nur Kanton ZG testen (11 Gemeinden)
node 4_merge_and_upload.js --dry-run  # Merge prüfen ohne Upload
node 4_merge_and_upload.js       # Upload zu Supabase
```

### slugs.json nach GitHub pushen (nach Harvesting)

```bash
cd immoskop
git add scraper/data/slugs.json
git commit -m "Update slugs.json"
git push
```

### Manuelle Korrektur einer Gemeinde

```bash
# 1. scraper/data/plz_overrides.json bearbeiten:
{
  "_note": "Korrektur – falscher Wert",
  "_date": "2026-04-04",
  "slug": "stadt-zug",
  "kauf_whg_median": 18500
}

# 2. Nur Merge + Upload (kein Re-Scrape nötig)
export SUPABASE_URL=https://clwdxufyeiznyhrfrysl.supabase.co
export SUPABASE_SERVICE_KEY=eyJ...
cd immoskop/scraper
node 4_merge_and_upload.js
```

### Neues Feature deployen

```bash
cd ~/immoskop
git add .
git commit -m "Beschreibung"
git push --force
# → Vercel deployed automatisch (max 100 Deployments/Tag!)
# WICHTIG: --force verwenden um Merge-Konflikte zu vermeiden!
# KEIN git pull mehr nötig
```

### ⚠️ WICHTIG: Kein git pull / kein Merge
Merges überschreiben lokale Änderungen mit alten GitHub-Versionen.
Workflow: Änderungen lokal machen → direkt force-push.
```bash
# Einmalig setzen:
git config pull.rebase false
# Dann immer:
git push --force
```


---

## 18. LEERWOHNUNGSZIFFER – LOGIK UND UPDATE

### Datenquellen
- **454 Gemeinden:** Tagesanzeiger/BFS 2024, direkt in `data.js` als `LWZ_GEMEINDE`
- **26 Kantone:** BFS 2024 als `LWZ_KANTON` (Fallback)
- **CH-Schnitt:** 1.08% (Fallback wenn Kanton unbekannt)

### Lookup-Reihenfolge in api/data.js
1. `LWZ_GEMEINDE[communeNameLower]` – Gemeinde-spezifisch (454 Gemeinden)
2. `LWZ_KANTON[priceData.kanton]` – Kantons-Fallback
3. `1.08` – CH-Schnitt

### Marktlage-Schwellwerte
| LWZ | Marktlage | Verhandlungs-Schwelle | Delta-Bonus |
|---|---|---|---|
| < 0.5% | extrem_angespannt | +20% | +8% toleriert |
| 0.5–1% | angespannt | +12% | +4% toleriert |
| 1–2% | normal | +4% | 0 |
| > 2% | entspannt | +2% | 0 |

### Jährliches Update (September)
```bash
# 1. Neue Daten von SDMX-API holen
node /tmp/lwz_fetch.js
# → schreibt /tmp/lwz_alle.json (alle ~2200 Gemeinden wenn fix fertig)

# 2. LWZ_GEMEINDE in data.js ersetzen
# → python3 /tmp/build_lwz.py (generiert JS-Objekt aus JSON)

# 3. Deployen
cd immoskop
git add api/data.js
git commit -m "LWZ update [JAHR]"
git push
```

### SDMX-API – Status (April 2026)
- API URL funktioniert ✅
- Dimensionen bekannt: GR_KT_GDE, LEERWOHN_TYP (_T=Total), MEASURE_DIMENSION (PC=Rate)
- Skript `/tmp/lwz_fetch.js` existiert, liefert noch 0 Gemeinden (Filter-Bug offen)
- **TODO:** lwz_fetch.js debuggen – Problem: totalTypeIdx=-1 weil Suche nach 'Total' schlägt fehl, muss nach `_T` suchen (wurde gefunden in letzter Session, noch nicht getestet)

---

## 19. BEKANNTE PROBLEME & OFFENE PUNKTE (Session 4)

### Git/Deployment
- **Merges überschreiben Änderungen** – immer `git push --force` verwenden, nie `git pull`
- Vercel Free Plan: max 100 Deployments/Tag

### Daten
- **Kilchberg (8802):** `kauf_whg_median: null` – hat nur alte Spalten. Muss neu gescrapt werden (TODO).
- `kanton: null` bei manchen Einträgen → LWZ-Lookup fällt auf CH-Schnitt zurück

### API (data.js)
- **marktlage ReferenceError** → gefixt in Session 3
- **Autobahn-Kachel (out body / bestRef-Bug)** → gefixt in Session 4 (siehe Abschnitt 20)
- **Strassenpreis-Fallback für typ=gemeinde** → gefixt in Session 4 (siehe Abschnitt 20)

### API (report.js)
- **Report-Widerspruch** → gefixt in Session 4 (siehe Abschnitt 20)

### Frontend (index.html)
- DealScore Hard Cap eingebaut (delta≥10% → max 59/100)
- Aussenraum Checkboxen + Parkplatz Stepper funktionieren
- **TODO (niedrige Prio):** `generateReport()` könnte `marktlage` und `lwz` explizit als `marktlageFromData` / `lwzFromData` übergeben. Aktuell läuft das über den Fallback `req.body.lwz` — funktioniert bereits.

---

## 20. ÄNDERUNGEN SESSION 4

### Fix: Report-Widerspruch (`api/report.js`)

**Problem:** Claude im Report bewertete den Preis unabhängig und widersprach manchmal dem Frontend-Verdict.

**Ursache:** Der Prompt sagte nur `"Bewerte: fair / überteuert / günstig"` — kein explizites Verdict.

**Fix in `report.js`:**
1. `marktlageFromData` und `lwzFromData` werden aus `req.body` gelesen (Fallback: `req.body.lwz`)
2. Neuer Prompt-Block vor `## Preiseinschätzung`:

```
FRONTEND-VERDICT: spürbar überteuert (+12% vom Referenzpreis CHF 850'000).
PFLICHT: Das Angebot ist SPÜRBAR ÜBERTEUERT (+12%). Erkläre die Preisabweichung kritisch. Widerspreche dieser Einschätzung nicht.
Marktlage: LWZ 0.56% → angespannt — berücksichtige dies in der Preisbewertung.
```

**Verdict-Schwellwerte (identisch mit Frontend):**
| delta | Label | Anweisung |
|---|---|---|
| ≥ +20% | stark überteuert | Begründe klar warum |
| +10–20% | spürbar überteuert | Erkläre kritisch |
| +3–10% | leicht überteuert | Erwähne sachlich |
| -3–+3% | marktkonform | Bewerte als fair |
| -3–-10% | leicht günstig | Erwähne positiv |
| -10–-20% | günstig | Hebe als Vorteil hervor |
| < -20% | sehr günstig | Hebe deutlich hervor |

---

### Fix: Autobahn-Kachel (`api/data.js`)

**Problem:** Bei Kilchberg ZH (direkt an A3) wurde kein Autobahn-Anschluss gefunden.

**Ursachen (zwei kombinierte Bugs):**

1. **`out body` statt `out geom`:** Overpass `out body` liefert für Nodes keine Koordinaten → `j.lat` / `j.lon` waren `undefined` → alle Junction-Nodes wurden übersprungen (Distanz-Berechnung schlug fehl).

2. **`bestRef`-Logik zu streng:** Wenn eine Junction gefunden wurde aber keinen `A`-Ref auf dem Node-Tag hatte (häufig in OSM), blieb `bestRef = null` — auch wenn `wayRefs` die A3 enthielt.

**Fix (drei kombinierte Änderungen):**
```javascript
// 1. out body → out geom (Nodes brauchen lat/lon)
// 2. Junction-Radius 25000 → 8000 (in Zürich gibt es dutzende Junctions im 25km Umkreis;
//    mit Limit 30 wurden die ersten Elemente = Ways verbraucht, nächste Junction fehlte)
// 3. Limit 30 → 100
node[highway=motorway_junction](around:8000,${lat},${lon});
...
);out geom 100;

// 4. bestRef: Fallback auf wayRefs immer nutzen (auch wenn Junction gefunden aber ohne A-Ref)
const jRef = (tags['motorway:ref'] || tags['ref'] || '').split(';')
  .map(r => r.trim().toUpperCase()).find(r => r.match(/^A\d/)) || null;
const bestRef = jRef || [...wayRefs][0] || null;
```

**Diagnose Kilchberg:** Die Ausfahrt heisst "Wollishofen" (nicht "Thalwil/Kilchberg") und liegt auf der A3. Sie war im Overpass-Resultat nicht vorhanden weil das Limit von 30 durch motorway-Ways aufgebraucht wurde bevor Junction-Nodes geliefert wurden.

---

### Fix: Strassenpreis-Fallback für typ=gemeinde (`api/data.js`)

**Problem:** Für alle Gemeinden mit `typ = 'gemeinde'` (keine Locality-Einträge, d.h. Gemeinden mit nur einer PLZ wie Kilchberg, Thalwil etc.) wurde der strassenspezifische Preis nie gefunden – obwohl er in `street_prices` vorhanden ist.

**Ursache:** `buildGemeindeRow()` im Scraper setzt kein `gemeinde_slug`-Feld (by design – Gemeinde-Rows verweisen nicht auf sich selbst). `data.js` las `priceData?.gemeinde_slug` → immer `null` bei `typ = 'gemeinde'` → Versuch 2 (Fallback via gemeinde_slug) wurde nie ausgeführt.

**Betroffene Gemeinden:** Alle Gemeinden mit nur einer PLZ und keinen Locality-Einträgen. Betrifft potenziell hunderte Gemeinden (alle wo RealAdvisor keine PLZ-Aufschlüsselung liefert).

**Fix (eine Zeile in `data.js`):**
```javascript
// Vorher:
const gemeindeSlug = priceData?.gemeinde_slug || null;

// Nachher:
const gemeindeSlug = priceData?.gemeinde_slug ||
  (priceData?.typ === 'gemeinde' ? priceData?.slug : null);
```

**Auswirkung für Kilchberg (Beispiel):**
- Vorher: `refSalePerSqm = 19'886` (Gemeinde-Median, altes Feld)
- Nachher: Rigistrasse gefunden → `kauf_median = 21'771` → streetPercentile berechnet → Referenzpreis steigt

**extraInfo-Tipp dokumentiert:** Aussenraum-Grösse, Seesicht, Südlage etc. am besten im extraInfo-Feld erfassen ("Garten 300m², Südlage, Seesicht"). Claude Haiku bewertet das kontextuell und gibt einen preis_adjustment-Faktor zurück (max ±15%), der in `expected` einfliesst. Ehrlicher als Pseudopräzision mit m²-Brackets.

---

*Dieses Dokument soll bei jedem Entwicklungsgespräch als erste Referenz dienen.*  
*Stand: April 2026 (Session 4) | Bei Änderungen am System: Dieses Dokument aktualisieren!*
