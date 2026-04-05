# IMMOSKOP – Vollständiges Systemdokument
**Stand: April 2026 | Dies ist das Projektgedächtnis. Immer aktuell halten.**

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
  → `data.js` Konstante `LWZ_KANTON` updaten
  → URL: https://www.bfs.admin.ch/bfs/de/home/statistiken/bau-wohnungswesen/wohnungen/leerwohnungen.html
  → Aktuell: BFS Leerwohnungszählung 2024 (Stand: 1. Juni 2024)

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
cd immoskop
git add .
git commit -m "Beschreibung"
git pull --no-rebase && git push
# → Vercel deployed automatisch (max 100 Deployments/Tag!)
```

### Bei Git-Konflikten

```bash
git config pull.rebase false
git pull --no-rebase
# Merge-Editor öffnet sich → Ctrl+X → Y → Enter
git push
```

---

*Dieses Dokument soll bei jedem Entwicklungsgespräch als erste Referenz dienen.*  
*Stand: April 2026 | Bei Änderungen am System: Dieses Dokument aktualisieren!*
