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
├── logo.png                # Neues Logo (Icon + IMMOSKOP Text, transparenter Hintergrund)
├── favicon.ico
├── favicon-32.png
├── favicon-16.png
├── apple-touch-icon.png
└── api/
    ├── data.js             # Hauptendpunkt: Geocoding, Preise, Lärm, Solar, ÖV
    ├── parse.js            # Claude liest Inseratstext → strukturierte Daten
    ├── report.js           # Claude generiert KI-Report
    ├── contact.js          # Kontaktformular → Protonmail SMTP
    └── track.js            # Analytics → Supabase
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
Befüllt durch `scraper.js`. Enthält ~155 Schweizer Gemeinden (die grössten/bevölkerungsreichsten).

| Spalte | Typ | Beschreibung |
|---|---|---|
| `plz` | text (PK) | Schweizer PLZ |
| `median_price_sqm` | numeric | Median Mietpreis CHF/m²/Monat |
| `rent_p10` | numeric | 10. Perzentile Miete |
| `rent_p90` | numeric | 90. Perzentile Miete |
| `median_sale_price_sqm` | numeric | Median Kaufpreis CHF/m² |
| `sale_p10` | numeric | 10. Perzentile Kauf |
| `sale_p90` | numeric | 90. Perzentile Kauf |
| `source` | text | z.B. `realadvisor:stadt-zurich` |
| `scraped_at` | timestamptz | Zeitstempel des Scraping |

**Wichtig:** Für PLZ ohne Eintrag verwendet `api/data.js` ein statisches Fallback-Modell (BASE_QM nach PLZ-Prefix).

#### `street_prices` – Strassengenaue Preise
Befüllt durch `street_scraper.js`. Erlaubt präzisere Preisschätzung wenn Adresse bekannt.

| Spalte | Typ | Beschreibung |
|---|---|---|
| `plz` | text | PLZ der Gemeinde |
| `street_name` | text | Strassenname (Original-Schreibweise) |
| `street_name_lower` | text | Kleinschreibung (für ILIKE-Suche) |
| `street_slug` | text | URL-Slug von RealAdvisor |
| `median_sale_price_sqm` | numeric | Median Kaufpreis der Strasse CHF/m² |
| `sale_p15` | numeric | 15. Perzentile Kauf |
| `sale_p85` | numeric | 85. Perzentile Kauf |
| `transaction_count` | int | Anzahl erfasster Transaktionen |
| `lat`, `lng` | numeric | Koordinaten der Strasse |
| `source` | text | `realadvisor` |
| `scraped_at` | timestamptz | Zeitstempel |

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

### Wie die Daten entstehen

**Schritt 1: PLZ-Preise** (`scraper.js`)
- Scrapt `https://realadvisor.ch/de/immobilienpreise-pro-m2/{slug}`
- Extrahiert: yearly_rent_m2 (P10/P50/P90) + sale_price_m2 (P10/P50/P90)
- Konvertiert Jahresmiete → Monatsmiete (÷12)
- Schreibt in `plz_prices` (Supabase) + `realadvisor_data.json` (lokal)
- ~155 Gemeinden, manuell definiert in der `GEMEINDEN`-Liste

**Schritt 2: Strassenpreise** (`street_scraper.js`)
- Liest `realadvisor_data.json` (Output von Schritt 1)
- Scrapt detailliertere Strassenseite derselben URLs
- Extrahiert `street_places` Array mit Median/P15/P85 pro Strasse
- Schreibt in `street_prices` (Supabase) + `street_data.json` (lokal)

### Scraper ausführen (lokal, Node.js erforderlich)
```bash
# PLZ-Preise
export SUPABASE_SERVICE_KEY=eyJ...
node scraper.js

# Strassenpreise (braucht realadvisor_data.json vom PLZ-Scraper)
node street_scraper.js realadvisor_data.json
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
- [ ] Fehlende PLZ in `plz_prices` prüfen und ggf. nachtragen (SQL: `SELECT COUNT(*) FROM plz_prices;`)
- [ ] `checker.html` hat kein i18n-System
- [ ] FAQ-Sektion auf Hauptseite

### Niedrig
- [ ] PWA (Progressive Web App)
- [ ] Italienisch (IT) für Tessin
- [ ] Admin-UI für `price_signals`

---

## 12. DATEN-QUALITÄT PRÜFEN

### Wie viele PLZ sind in der DB?
```sql
SELECT COUNT(*) FROM plz_prices;
-- Erwartet: ~155-170 (nur grosse Gemeinden)
-- Für alle anderen greift das Fallback-Modell
```

### Welche PLZ fehlen für eine Region?
```sql
SELECT plz, source FROM plz_prices WHERE plz LIKE '74%' ORDER BY plz;
-- Zeigt alle Graubündner PLZ 74xx
```

### PLZ manuell nachtragen (Beispiel Bonaduz 7402):
Daten von realadvisor.ch/de/immobilienpreise-pro-m2/bonaduz ablesen, dann:
```sql
INSERT INTO plz_prices (plz, median_price_sqm, rent_p10, rent_p90, 
  median_sale_price_sqm, sale_p10, sale_p90, source, scraped_at)
VALUES ('7402', 18.0, 12.0, 26.0, 7800, 3079, 17674, 'manual:bonaduz', NOW())
ON CONFLICT (plz) DO UPDATE SET 
  median_sale_price_sqm = EXCLUDED.median_sale_price_sqm,
  source = EXCLUDED.source,
  scraped_at = NOW();
```
*(Werte laut Screenshot April 2026: Median Wohnung CHF 7'243/m², Range 3'079–17'674)*

---

## 13. SCRAPER VERWENDEN (falls Daten veraltet)

### Voraussetzungen
- Node.js installiert
- Supabase Service Key

### PLZ-Preise neu scrapen
```bash
export SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
node scraper.js
# Output: realadvisor_data.json + Daten in Supabase plz_prices
```

### Strassenpreise neu scrapen  
```bash
node street_scraper.js realadvisor_data.json
# Output: street_data.json + Daten in Supabase street_prices
```

### Neue Gemeinde zum Scraper hinzufügen
In `scraper.js` in der `GEMEINDEN`-Liste eintragen:
```javascript
{slug:'gemeinde-bonaduz', plz:['7402'], name:'Bonaduz'},
```
Slug kommt von der RealAdvisor-URL: `realadvisor.ch/de/immobilienpreise-pro-m2/**gemeinde-bonaduz**`

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

*Dieses Dokument soll bei jedem Entwicklungsgespräch als erste Referenz dienen.*  
*Bei Änderungen am System: Dieses Dokument aktualisieren!*
