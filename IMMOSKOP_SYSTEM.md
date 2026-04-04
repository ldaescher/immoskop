# IMMOSKOP – Systemdokument
**Stand: April 2026 | Projektgedächtnis. Bei jedem Gespräch hochladen. Nach Änderungen aktualisieren.**

---

## 1. WAS IST IMMOSKOP?

Kostenloser Schweizer Immobilien-Analyseservice unter **www.immoskop.ch**.  
Nutzer geben eine Adresse ein (oder fügen einen Inseratstext ein) und erhalten:

- Preisbewertung (über/unter Markt?)
- Lärm, Besonnung, ÖV, Umgebung, Sicherheit
- Besichtigungs-Checkliste (Kauf/Miete)
- Optional: KI-Report (Claude)

**Sprachen:** DE / EN / FR | **Typ:** Kauf und Miete, Wohnung und Haus  
**Betreiber:** Däscher & Partner Immobilien GmbH, Cresta 3, 7415 Pratval

---

## 2. TECHNOLOGIE-STACK

| Schicht | Technologie |
|---|---|
| Frontend | Statisches HTML/CSS/JS (`index.html`) |
| Backend | Vercel Serverless Functions (Node.js) |
| Datenbank | Supabase (PostgreSQL) |
| KI | Anthropic Claude Sonnet API |
| Deployment | GitHub → Vercel Auto-Deploy |
| Domain | GoDaddy (immoskop.ch) |
| E-Mail | Protonmail (kontakt@immoskop.ch) |

**Repo:** `ldaescher/immoskop` auf GitHub  
**Vercel:** Free Plan (100 Deployments/Tag Limit!)  
**Supabase:** `clwdxufyeiznyhrfrysl.supabase.co`  
**Lokales Projektverzeichnis:** `/home/lukas/Desktop/Däscher & Partner Immobilien GmbH/ImmoPortal/immoskop`

---

## 3. DATEISTRUKTUR (GitHub Repo)

```
/
├── index.html                  # Hauptseite mit eingebettetem Checker (HTML + CSS + JS)
├── checker.html                # Standalone Checker
├── admin.html                  # Analytics-Dashboard ⚠ Passwort noch Standard!
├── ueber-uns.html
├── datenschutz.html
├── impressum.html              # ⚠ Platzhalter noch nicht ausgefüllt
├── kontakt.html
├── sitemap.xml
├── robots.txt
├── vercel.json                 # Routing + Headers
├── package.json                # {"type":"module"}
├── logo.png                    # Rot #C8371A, transparenter Hintergrund
├── favicon.ico / favicon-32.png / favicon-16.png / apple-touch-icon.png
├── api/
│   ├── data.js                 # Geo + Supabase + Solar + BAFU + Steuern → Kacheln (~5s, kein Claude)
│   ├── report.js               # Wie data.js + Claude KI-Report (~20s zusätzlich)
│   ├── parse.js                # Claude liest Inseratstext → strukturierte Felder
│   ├── track.js                # Anonymes Tracking → Supabase analytics_events
│   └── contact.js              # Kontaktformular → Protonmail SMTP
└── scraper/                    # Daten-Pipeline (lokal ausführen, nie auf Vercel)
    ├── 1_harvest_slugs.js      # Alle 26 Kantone → data/slugs.json
    ├── 2_scrape_plz.js         # Alle Gemeinden → data/plz_prices_raw.json
    ├── 3_scrape_streets.js     # Alle Strassen → data/street_prices_raw.json
    ├── 4_merge_and_upload.js   # Raw + Overrides → Supabase (atomar)
    ├── README.md
    └── data/
        ├── slugs.json              # Alle Gemeinde-Slugs (Output Skript 1, committen)
        ├── plz_prices_raw.json     # Rohdaten PLZ (Output Skript 2, nie manuell bearbeiten)
        ├── plz_overrides.json      # Manuelle Korrekturen PLZ (manuell pflegen, committen)
        ├── street_prices_raw.json  # Rohdaten Strassen (Output Skript 3, nie manuell bearbeiten)
        └── street_overrides.json   # Manuelle Korrekturen Strassen (manuell pflegen, committen)
```

**Dateipflege-Regel:** `*_raw.json` → bei jedem Scrape neu geschrieben, nie manuell anfassen. `*_overrides.json` → nie von Skripten überschrieben, immer committen.

---

## 4. VERCEL ENVIRONMENT VARIABLES

| Variable | Wert / Beschreibung |
|---|---|
| `SUPABASE_URL` | `https://clwdxufyeiznyhrfrysl.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Service Role Key (umgeht RLS) |
| `ANTHROPIC_API_KEY` | Claude API Key |
| `GEOAPIFY_API_KEY` | ÖV + Amenities (Geoapify Places API) |
| `PROTONMAIL_USER` | `kontakt@immoskop.ch` |
| `PROTONMAIL_TOKEN` | Protonmail SMTP Token |

---

## 5. SUPABASE – DATENBANK

### Tabellen

#### `plz_prices` – Gemeinde-Marktpreise
Befüllt durch `scraper/4_merge_and_upload.js`. Ziel: alle CH-Gemeinden mit RealAdvisor-Daten.

| Spalte | Typ | Beschreibung |
|---|---|---|
| `plz` | text (PK) | Schweizer PLZ |
| `slug` | text | RealAdvisor-Slug (z.B. `stadt-zurich`) |
| `name` | text | Gemeindename |
| `kanton` | text | Kantonskürzel (z.B. `ZH`) |
| `kauf_whg_median` | numeric | Kaufpreis Wohnung Median CHF/m² |
| `kauf_whg_p10` | numeric | Kaufpreis Wohnung P10 CHF/m² |
| `kauf_whg_p90` | numeric | Kaufpreis Wohnung P90 CHF/m² |
| `kauf_haus_median` | numeric | Kaufpreis Haus Median CHF/m² |
| `kauf_haus_p10` | numeric | Kaufpreis Haus P10 CHF/m² |
| `kauf_haus_p90` | numeric | Kaufpreis Haus P90 CHF/m² |
| `miete_whg_median` | numeric | Monatsmiete Wohnung Median CHF/m²/Mt |
| `miete_whg_p10` | numeric | Monatsmiete Wohnung P10 CHF/m²/Mt |
| `miete_whg_p90` | numeric | Monatsmiete Wohnung P90 CHF/m²/Mt |
| `miete_haus_median` | numeric | Monatsmiete Haus Median CHF/m²/Mt |
| `miete_haus_p10` | numeric | Monatsmiete Haus P10 CHF/m²/Mt |
| `miete_haus_p90` | numeric | Monatsmiete Haus P90 CHF/m²/Mt |
| `has_data` | boolean | false wenn RealAdvisor keine Daten hat |
| `source` | text | `realadvisor`, `manual` |
| `scraped_at` | timestamptz | Zeitstempel |

⚠ **`api/data.js` muss noch auf dieses neue Schema migriert werden** (alte Spalten: `median_price_sqm`, `median_sale_price_sqm` etc.).

Für PLZ ohne Supabase-Eintrag greift das statische Fallback-Modell in `api/data.js`:
```javascript
const BASE_QM = {
  '80':22.5, '81':21, '82':19.5, '83':17.5, '84':18, '85':20,
  '86':18.5, '87':17, '88':19, '89':16.5, '30':17, '31':16.5,
  '40':18.5, '41':17.8, '10':23, '12':25, '60':18, '70':15,
  '71':14.5, '72':14, '73':13.5, 'default':17
};
```

#### `plz_prices_staging` – Staging für atomaren Upload
```sql
CREATE TABLE IF NOT EXISTS plz_prices_staging (LIKE plz_prices INCLUDING ALL);
```

#### `street_prices` – Strassengenaue Kaufpreise
Aktuell: 5800+ Strassen. Befüllt durch `scraper/4_merge_and_upload.js`.

| Spalte | Typ | Beschreibung |
|---|---|---|
| `gemeinde_slug` | text | RealAdvisor-Slug der Gemeinde |
| `gemeinde_name` | text | Gemeindename |
| `kanton` | text | Kantonskürzel |
| `plz` | text | PLZ der Gemeinde |
| `strassen_slug` | text | RealAdvisor-Slug der Strasse |
| `strassen_name` | text | Strassenname (Originalschreibweise) |
| `kauf_median` | numeric | Kaufpreis Median CHF/m² (kombiniert, kein Typ-Split) |
| `kauf_p10` | numeric | Kaufpreis P10 CHF/m² |
| `kauf_p90` | numeric | Kaufpreis P90 CHF/m² |
| `has_data` | boolean | false wenn keine Preisdaten vorhanden |
| `source` | text | `realadvisor` |
| `scraped_at` | timestamptz | Zeitstempel |

RealAdvisor liefert auf Strassenebene nur kombinierten Kaufpreis (kein Typ-Split, keine Mietpreise). Mietpreise werden in `api/data.js` interpoliert:
```javascript
// Strasse CHF 13'125/m², Gemeinde P10=7'850, P90=26'363
// → percentile = (13125 - 7850) / (26363 - 7850) = ~28. Perzentil
// → miete_estimate = lerp(miete_whg_p10, miete_whg_p90, 0.28)
// → priceSource = 'RealAdvisor (strassengenau)'
```

```sql
CREATE TABLE IF NOT EXISTS street_prices_staging (LIKE street_prices INCLUDING ALL);
```

#### `analytics_events` – Usage-Tracking

| Spalte | Beschreibung |
|---|---|
| `event_type` | `analysis`, `report` |
| `city`, `street_name` | Anonymisiert |
| `listing_type` | `miete` / `kauf` |
| `delta_pct` | Preisabweichung in % |
| `is_owner` | Boolean – Owner-Mode via `?owner=true` in URL |
| `session_id` | Zufällige Session-ID |

#### `municipality_tax_burden` – ESTV Steuerbelastung 2025
**Status: Befüllt ✓** (2122 Schweizer Gemeinden)  
**Quelle:** ESTV „Gesamtsteuerbelastung des Bruttoarbeitseinkommens" 2025  
**Profil:** Ledig, ohne Kinder, ohne Kirchensteuer, CHF 150'000 Bruttoeinkommen  
**Felder:** `total_chf`, `federal_chf`, `cantonal_chf`, `municipal_chf`, `effective_pct`  
**Architektur:** `ESTV_BURDEN`-Objekt direkt in `data.js` / `report.js` eingebettet (funktioniert ohne DB) + Supabase-Tabelle für Percentile-View.

**View `municipality_tax_percentiles`:** Automatische nationale + kantonale Perzentile.

**Beispiel-Anzeige (Laax):** `Einkommenssteuer CHF 19'765/J · Sehr günstig ★★★★★ · 2. Perz. in GR · CH: 2%`

**Jährlich aktualisieren** (Januar):
```bash
# 1. Neues XLSX von estv.admin.ch → an Claude → ESTV_BURDEN in data.js + report.js aktualisieren
# 2. Supabase befüllen:
SUPABASE_URL=https://clwdxufyeiznyhrfrysl.supabase.co \
SUPABASE_SERVICE_KEY=xxx node estv_populate.js
```

#### `price_signals` – Korrektursignale aus Nutzerdaten
Vierteljährlich auswerten. `sample_size >= 5` UND `avg_delta >= +10%` oder `<= -10%` → manuelle Korrektur via `plz_overrides.json`.

### RLS-Policies
```sql
-- plz_prices, street_prices, municipality_tax_burden: public read
-- analytics_events: insert only (kein anonymes Lesen)
```

---

## 6. DATENQUELLEN

| Quelle | Was | Wie |
|---|---|---|
| RealAdvisor | Marktpreise Gemeinden + Strassen | Scraper (monatlich) |
| swisstopo API | Geocodierung, Solarpotenzial | REST API (live) |
| BAFU WMS | Strassenlärm (`ch.bafu.laerm-strassenlaerm_tag`) | PNG-Pixeldekodierung (live) |
| Geoapify | ÖV + Amenities (Places API) | REST API (live) |
| BFS PKS | Kriminalstatistik | Hartcodiert in `data.js` / `report.js` |
| ESTV 2025 | Steuerbelastung CHF | XLSX-Import → inline JS + Supabase |
| Anthropic Claude | KI-Report, Inserats-Parsing | API (on demand) |

---

## 7. PREISBERECHNUNG (`api/data.js`)

```
Referenzpreis = miete_whg_median (Supabase, strassengenau wenn verfügbar)
  × yearFactor       (2020: +8% | 2010: +4% | 2000: 0% | 1990: −4% | 1980: −8% | älter: −12%)
  × conditionFactor  (neuwertig: +8% NUR wenn Baujahr < 2010 | gut: 0% | mittel: −8% | renovationsbedürftig: −18%)
  × outdoorFactor    (nur Wohnungen: kein Aussenraum: −8% | Balkon: 0% | Terrasse: +5% | Garten: +8%)
  × propertyFactor   (Haus: +5% urban / 0% ländlich | Wohnung: 0%)
  × floorFactor      (EG: −5% | 1.OG: 0% | höher: +1.5% pro Etage)
```

**Wichtig:** EFH hat immer `outdoorFactor = 1.0` und kein Etagen-Display.

---

## 8. DATEN-PIPELINE (RealAdvisor-Scraper)

### Was RealAdvisor liefert

**Gemeinde-Ebene** (vollständig): Kauf Wohnung/Haus + Jahresmiete Wohnung/Haus, je Median + P10/P90. Jahresmiete ÷12 → Monatsmiete.

**Strassen-Ebene** (eingeschränkt): Nur kombinierter Kaufpreis-Median + P10/P90. Kein Typ-Split, keine Mietpreise.

### Ausführen (lokal, Node.js erforderlich)

```bash
cd scraper/

node 1_harvest_slugs.js          # ~3 Min  → data/slugs.json
node 2_scrape_plz.js             # ~90 Min → data/plz_prices_raw.json
node 3_scrape_streets.js         # ~4 Std  → data/street_prices_raw.json

export SUPABASE_URL=https://clwdxufyeiznyhrfrysl.supabase.co
export SUPABASE_SERVICE_KEY=eyJ...
node 4_merge_and_upload.js       # ~5 Min  → Supabase (atomar)
```

### Optionen

```bash
node 2_scrape_plz.js --kanton ZH          # Nur ein Kanton (Test)
node 2_scrape_plz.js --resume             # Nach Unterbruch fortsetzen
node 3_scrape_streets.js --only-with-data
node 4_merge_and_upload.js --dry-run      # Merge prüfen ohne Upload
node 4_merge_and_upload.js --plz-only
node 4_merge_and_upload.js --streets-only
```

### Atomarer Upload (Skript 4)
1. Neue Daten in Staging laden → 2. Sanity-Check (nicht leer, kein >50%-Verlust) → 3. Produktion truncaten + aus Staging befüllen. Bei Fehler: Produktion bleibt unberührt.

### Manuelle Korrekturen

In `data/plz_overrides.json` eintragen (wird nie von Skripten überschrieben):
```json
{
  "overrides": [
    {
      "_comment": "Manuell April 2026",
      "slug": "7402-bonaduz",
      "plz": "7402",
      "kauf_whg_median": 7243,
      "kauf_whg_p10": 3079,
      "kauf_whg_p90": 17674,
      "miete_whg_median": 14.5
    }
  ]
}
```

---

## 9. API-ENDPUNKTE (`/api/`)

### `POST /api/data`
**Input:** `{ address, rooms, area, price, type, propertyKind, year, floor, outdoor, condition, extraInfo }`  
**Was:** Geocoding → PLZ-Preise → Strassenpreise → delta/expected → Lärm → Solar → ÖV → Steuern  
**Output:** `{ meta: { delta, expected, priceSource, noiseDay, solarKwh, oevDist, oevName, amenitySummary, ... } }`  
**Dauer:** ~5s (kein Claude)

**Geocoding-Flow:** Hausnummer vorhanden? → `origins=address` via swisstopo. Sonst: `origins=gg25,zipcode` → `geoAccuracy='gemeinde'` → `noiseDay=null`, Trust Layer zeigt Warnung.

**Noise-Flow (BAFU Pixel-Klassifikation):**  
`sat < 0.08` → OSM-Fallback | `hue 80–160` → 50 dB | `hue 50–80` → 57 dB | `hue 25–50` → 62 dB | `hue 0–25/345+` → 67 dB | `hue 270–345` → 73 dB

### `POST /api/report`
Wie `/api/data` + Claude KI-Report. Dauer: ~20s zusätzlich. Output: `{ report: "..." }` (Markdown)

### `POST /api/parse`
**Input:** `{ text }` (Inseratstext via Copy-Paste)  
**Output:** `{ parsed: { adresse, preis, preistyp, flaeche, zimmer, baujahr_kategorie, aussenraum, zustand, befristet, befristet_details } }`

### `POST /api/track`
Schreibt anonymes Event in `analytics_events`. Owner-Mode: `?owner=true` in URL → `is_owner=true`.

### `POST /api/contact`
`{ name, email, message }` → Protonmail SMTP

---

## 10. FRONTEND (`index.html`)

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
`currentLang`: `'de'` / `'en'` / `'fr'` | `TRANSLATIONS`-Objekt | `data-i18n="key"` auf HTML-Elementen | `applyTranslations()` | Bei Sprachwechsel: `renderEnginesOnly()`.

**Tab-Titel:** DE: "Immoskop – Immobilien-Entscheider" | EN: "Immoskop – Property Decider" | FR: "Immoskop – Décideur immobilier"

### Owner-Mode (Analytics-Filter)
`https://www.immoskop.ch?owner=true` → setzt dauerhaft per LocalStorage | `?owner=false` → entfernt

---

## 11. DEPLOYMENT

**Normaler Ablauf:** Dateien ändern → GitHub committen (main) → Vercel deployed automatisch.

**Vercel Limit:** 100 Deployments/Tag. Trick: GitHub Web-Editor (`.`-Taste im Repo) für Multi-File-Commits.

**Debugging:** Vercel Dashboard → Functions → Logs. Häufige Fehler: `req.body` ist null, JSON.parse schlägt fehl bei leerem Body.

---

## 12. DESIGN-ENTSCHEIDUNGEN

**Warum eine einzelne HTML-Datei?** Kein Build-Step, Vercel kompiliert nichts. Nachteil: Datei wird gross.

**Warum Supabase statt direktem Scraping?** Einmal scrapen, Daten cachen. Schneller. RealAdvisor-ToS: direktes Scrapen im Produktivbetrieb problematisch.

**Warum kein Framework?** Kein Build-Step = kein Deployment-Overhead. Für ein Single-Page-Tool ausreichend. Einfacher zu warten für eine Person.

**Warum atomarer Upload statt Upsert?** Kein partieller Zustand möglich. Alte Daten bleiben vollständig bis neuer Datensatz validiert ist.

---

## 13. TROUBLESHOOTING

| Problem | Lösung |
|---|---|
| "JSON Parse Error" / leere Response | `req.body` null-guard in `api/*.js` prüfen |
| "404 Not Found" für API | Datei muss unter `api/` liegen |
| Geocoding schlägt fehl | Hausnummer? → `origins=address` sonst `origins=gg25,zipcode` |
| Vercel Deployment schlägt fehl | Logs prüfen; häufig: `SUPABASE_SERVICE_KEY` fehlt oder Syntax-Error |
| Supabase RLS-Fehler | Service Key umgeht RLS – sollte nie auftreten |
| Scraper unterbrochen | `--resume` Flag bei Skript 2 oder 3 |
| Upload schlägt fehl | Produktion unberührt (atomare Strategie). Log prüfen, neu versuchen |
| Zimmerzahl-Halluzination | Prompt in `parse.js` verschärfen (teilweise gefixt) |

---

## 14. OFFENE PENDENZEN

### Hoch
- [ ] **Impressum ausfüllen** – `impressum.html` → Firma: Däscher & Partner Immobilien GmbH, Cresta 3, 7415 Pratval (DE/EN/FR)
- [ ] **Admin-Passwort setzen** – `admin.html` → Konstante `ADMIN_PWD_HASH`
- [ ] **Staging-Tabellen in Supabase anlegen** (SQL in `scraper/README.md`)
- [ ] **Scraper Skripte 1–4 ausführen** – komplette Daten aller CH-Gemeinden laden
- [ ] **`api/data.js` auf neues DB-Schema migrieren** (neue Spaltennamen `kauf_whg_median` etc. statt alter `median_sale_price_sqm`)

### Mittel
- [ ] PLZ-Landingpages für SEO (z.B. `/mietpreise/8005`)
- [ ] FAQ-Sektion auf Hauptseite ("Was bedeutet Delta?", "Wie aktuell sind Daten?")
- [ ] ESTV weitere Profile (Verheiratet, 2 Kinder)
- [ ] Fehlerbehandlung verbessern (freundlichere Meldungen bei Geocoder-Fehler)

### Niedrig
- [ ] PWA (als App installierbar)
- [ ] Italienisch (IT) für Tessin
- [ ] `checker.html` i18n-System
- [ ] Admin-Passwort serverseitig (statt Client-seitig)

---

## 15. WIEDERKEHRENDE TASKS

### Monatlich
**Scraping** (RealAdvisor-Daten aktualisieren):
```bash
cd "/home/lukas/Desktop/Däscher & Partner Immobilien GmbH/ImmoPortal/immoskop/scraper"
node 1_harvest_slugs.js
node 2_scrape_plz.js
node 3_scrape_streets.js
export SUPABASE_SERVICE_KEY=xxx
node 4_merge_and_upload.js
```
Prüfen: `SELECT COUNT(*) FROM plz_prices WHERE has_data = true;`

**Google Search Console:** search.google.com/search-console → Klicks, Impressionen, Abdeckung, Sitemaps.

### Vierteljährlich
**Preissignale auswerten:**
```sql
SELECT * FROM price_signals ORDER BY sample_size DESC;
-- sample_size >= 5 UND avg_delta >= +10% oder <= -10% → Korrektur via plz_overrides.json
```
**Admin-Dashboard:** https://www.immoskop.ch/admin → häufigste Gemeinden, Vercel Logs auf ERROR prüfen.

### Jährlich (Januar)
**ESTV Steuerdaten aktualisieren:**
1. estv.admin.ch → Steuerbelastung in den Gemeinden → XLSX (ledig, CHF 150k, ohne Kirchensteuer)
2. An Claude schicken → `ESTV_BURDEN` in `data.js` + `report.js` aktualisieren
3. `node estv_populate.js` → Supabase | 4. Pushen auf GitHub

**ZH Steuerfüsse aktualisieren:**
```
https://www.web.statistik.zh.ch/ogd/data/steuerfuesse/kanton_zuerich_stf_aktuell.csv
```
→ An Claude schicken → `TAX_ZH` in `data.js` + `report.js` aktualisieren → pushen.

**BAFU + Solar Layer prüfen:** Layer-Namen in `data.js` / `report.js` kontrollieren, Testanalyse durchführen.

### Task-Kalender

| Task | Jan | Feb–Nov | Dez |
|---|:---:|:---:|:---:|
| Scraping (monatlich) | ✓ | ✓ | ✓ |
| Search Console (monatlich) | ✓ | ✓ | ✓ |
| Preissignale (vierteljährlich) | ✓ | Mrz/Jun/Sep | ✓ |
| Admin-Dashboard (vierteljährlich) | ✓ | Mrz/Jun/Sep | ✓ |
| ESTV Steuern | ✓ | — | — |
| ZH Steuerfüsse | ✓ | — | — |
| BAFU + Solar | ✓ | — | — |

---

## 16. NÜTZLICHE SQL-ABFRAGEN

```sql
-- Datenbestand prüfen
SELECT COUNT(*) FROM plz_prices WHERE has_data = true;
SELECT kanton, COUNT(*) FROM plz_prices GROUP BY kanton ORDER BY kanton;
SELECT COUNT(*) FROM street_prices WHERE has_data = true;
SELECT COUNT(*) FROM municipality_tax_burden;  -- Erwartet: 2122

-- Gemeinden ohne Preisdaten
SELECT slug, name, kanton FROM plz_prices WHERE has_data = false;

-- Strassenpreise einer Gemeinde
SELECT strassen_name, kauf_median, kauf_p10, kauf_p90
FROM street_prices WHERE plz = '8001' ORDER BY kauf_median DESC;

-- Manuell überschriebene Einträge
SELECT slug, name FROM plz_prices WHERE source = 'manual';

-- Preissignale auswerten
SELECT * FROM price_signals ORDER BY sample_size DESC;

-- Letzte Scraping-Zeitstempel
SELECT plz, name, scraped_at FROM plz_prices ORDER BY scraped_at DESC LIMIT 10;
```

---

*Bei Änderungen am System dieses Dokument aktualisieren. Für zukünftige Chats genügt es, nur diese eine Datei hochzuladen.*
