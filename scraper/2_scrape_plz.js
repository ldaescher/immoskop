/**
 * IMMOSKOP Scraper 2/4 – PLZ-Preis-Scraper
 * ==========================================
 * Liest data/slugs.json und scrapt für jede Gemeinde:
 *
 *   KAUF (CHF/m²):
 *     Wohnung: Median, P10, P90
 *     Haus:    Median, P10, P90
 *
 *   MIETE (CHF/m²/Monat, konvertiert aus Jahreswert):
 *     Wohnung: Median, P10, P90
 *     Haus:    Median, P10, P90
 *
 * Was RealAdvisor auf Gemeindeebene zeigt:
 *   - "Preis pro m²":  Median + "80%-Spanne" (≈ P10–P90) für Whg und Haus
 *   - "Miete pro m²":  Jahresmiete Median + Spanne für Whg und Haus
 *   → Wir speichern beides vollständig und getrennt.
 *
 * Output:     data/plz_prices_raw.json   (NICHT committen – gross!)
 *             data/scrape_plz_log.json
 * Resume:     node 2_scrape_plz.js --resume
 * Kanton:     node 2_scrape_plz.js --kanton ZH   (nur ein Kanton, zum Testen)
 * Dauer:      ~60–90 Minuten für alle Gemeinden
 */

'use strict';
const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Konfiguration ─────────────────────────────────────────────────────────────

const DELAY_MS    = 1100;
const BATCH_SIZE  = 50;   // Zwischenstand alle N Gemeinden speichern
const DATA_DIR    = path.join(__dirname, 'data');
const SLUGS_FILE  = path.join(DATA_DIR, 'slugs.json');
const OUTPUT_FILE = path.join(DATA_DIR, 'plz_prices_raw.json');
const LOG_FILE    = path.join(DATA_DIR, 'scrape_plz_log.json');
const RESUME_FILE = path.join(DATA_DIR, '.plz_progress.json');

const RESUME_MODE   = process.argv.includes('--resume');
const KANTON_FILTER = (() => {
  const i = process.argv.indexOf('--kanton');
  return i !== -1 ? process.argv[i + 1].toUpperCase() : null;
})();

// ── HTTP ──────────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'de-CH,de;q=0.9',
      },
      timeout: 20000,
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parst eine CHF-Zahl aus einem String wie "CHF 13'240" oder "13'240".
 * Gibt null zurück wenn nicht parsbar.
 */
function parseChf(str) {
  if (!str) return null;
  const n = parseFloat(String(str).replace(/['']/g, '').replace(/[^0-9.]/g, ''));
  return isNaN(n) || n === 0 ? null : n;
}

/**
 * Konvertiert CHF/m²/Jahr → CHF/m²/Monat, gerundet auf 1 Stelle.
 */
function yearly2monthly(val) {
  if (!val) return null;
  return Math.round(val / 12 * 10) / 10;
}

/**
 * Extrahiert alle Preisdaten aus dem HTML einer Gemeinde-Seite.
 *
 * RealAdvisor rendert die Seite serverseitig (Next.js), die Zahlen
 * sind direkt im HTML-Text sichtbar. Wir parsen sie mit RegEx.
 *
 * Aufbau der Seite (relevant):
 *
 *   ## Preis pro m²       ## Miete pro m²
 *   Wohnungen             Wohnungen
 *   CHF 13'240            CHF 327
 *   CHF 7'850 - 26'363    CHF 194 - CHF 652
 *   Häuser                Häuser
 *   CHF 11'934            CHF 298
 *   CHF 6'713 - 24'614    CHF 168 - CHF 615
 *
 * Die "80%-Spanne" (P10–P90) ist das was RealAdvisor als Range zeigt.
 */
function extractPreise(html) {
  // Hilfsfunktion: ersten CHF-Wert nach einem Anker-Text finden
  function findAfter(anchor, html, offset = 0) {
    const idx = html.indexOf(anchor, offset);
    if (idx === -1) return null;
    const snippet = html.slice(idx, idx + 500);
    const m = snippet.match(/CHF\s+([\d']+)/);
    return m ? parseChf(m[1]) : null;
  }

  // Hilfsfunktion: Median + Range (P10, P90) nach einem Anker-Text finden
  function findMedianAndRange(anchor, html, offset = 0) {
    const idx = html.indexOf(anchor, offset);
    if (idx === -1) return { median: null, p10: null, p90: null };
    const snippet = html.slice(idx, idx + 800);

    // Alle CHF-Zahlen in diesem Snippet sammeln
    const matches = [...snippet.matchAll(/CHF\s+([\d']+)/g)].map(m => parseChf(m[1]));

    // Erste Zahl = Median, danach folgt "CHF X - CHF Y" = Range
    // Pattern: "CHF 13'240\n\nCHF 7'850 - CHF 26'363"
    const rangeM = snippet.match(/CHF\s+([\d']+)\s*[-–]\s*(?:CHF\s+)?([\d']+)/);

    return {
      median: matches[0] ?? null,
      p10:    rangeM ? parseChf(rangeM[1]) : (matches[1] ?? null),
      p90:    rangeM ? parseChf(rangeM[2]) : (matches[2] ?? null),
    };
  }

  // ── Kauf-Abschnitt ──
  // Suche den Block "Preis pro m²" → darunter Wohnungen, dann Häuser
  const kaufStart = html.indexOf('Preis pro m');
  const mieteStart = html.indexOf('Miete pro m');

  let kauf_whg  = { median: null, p10: null, p90: null };
  let kauf_haus = { median: null, p10: null, p90: null };
  let miete_whg  = { median: null, p10: null, p90: null };
  let miete_haus = { median: null, p10: null, p90: null };

  if (kaufStart !== -1) {
    const kaufEnd = mieteStart !== -1 ? mieteStart : kaufStart + 2000;
    const kaufHtml = html.slice(kaufStart, kaufEnd);

    const whgIdx  = kaufHtml.indexOf('Wohnungen');
    const hausIdx = kaufHtml.indexOf('Häuser');

    if (whgIdx !== -1)  kauf_whg  = findMedianAndRange('Wohnungen', kaufHtml, whgIdx);
    if (hausIdx !== -1) kauf_haus = findMedianAndRange('Häuser',    kaufHtml, hausIdx);
  }

  // ── Miete-Abschnitt ──
  // Jahresmiete CHF/m²/Jahr (wir konvertieren zu Monatsmiete)
  if (mieteStart !== -1) {
    const mieteHtml = html.slice(mieteStart, mieteStart + 2000);

    const whgIdx  = mieteHtml.indexOf('Wohnungen');
    const hausIdx = mieteHtml.indexOf('Häuser');

    if (whgIdx !== -1)  miete_whg  = findMedianAndRange('Wohnungen', mieteHtml, whgIdx);
    if (hausIdx !== -1) miete_haus = findMedianAndRange('Häuser',    mieteHtml, hausIdx);
  }

  return { kauf_whg, kauf_haus, miete_whg, miete_haus };
}

/**
 * Extrahiert die Liste der Strassen aus der Gemeinde-Seite.
 * Wir speichern sie hier nur als einfache Liste (Slug + Name),
 * damit Skript 3 weiss welche Seiten es aufrufen muss.
 *
 * Strassen-URLs: /de/immobilienpreise-pro-m2/{plz-slug}/{strassen-slug}
 */
function extractStrassenLinks(html, gemeindeSlug) {
  const prefix = `/de/immobilienpreise-pro-m2/${gemeindeSlug}/`;
  const re     = new RegExp(`href="${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^"]+)"[^>]*>\\s*([^<]+?)\\s*<`, 'g');
  const strassen = [];
  const seen   = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    const strassenSlug = m[1].trim();
    const name         = m[2].trim();
    if (seen.has(strassenSlug)) continue;
    seen.add(strassenSlug);
    strassen.push({
      slug: strassenSlug,
      name,
      url: `https://realadvisor.ch${prefix}${strassenSlug}`,
    });
  }
  return strassen;
}

/**
 * Baut den finalen Datensatz für eine Gemeinde zusammen.
 * Alle Preisfelder explizit, kein implizites Fallback auf andere Typen.
 */
function buildRow(gemeinde, preise) {
  const { kauf_whg, kauf_haus, miete_whg, miete_haus } = preise;
  return {
    // Identifikation
    slug:   gemeinde.slug,
    name:   gemeinde.name,
    plz:    gemeinde.plz,     // null wenn nicht aus Slug erkennbar
    kanton: gemeinde.kanton,

    // ── KAUF (CHF/m²) ──────────────────────────────
    // Wohnung
    kauf_whg_median: kauf_whg.median,
    kauf_whg_p10:    kauf_whg.p10,
    kauf_whg_p90:    kauf_whg.p90,
    // Haus
    kauf_haus_median: kauf_haus.median,
    kauf_haus_p10:    kauf_haus.p10,
    kauf_haus_p90:    kauf_haus.p90,

    // ── MIETE (CHF/m²/Monat) ───────────────────────
    // RealAdvisor liefert Jahreswerte → ÷ 12
    // Wohnung
    miete_whg_median: yearly2monthly(miete_whg.median),
    miete_whg_p10:    yearly2monthly(miete_whg.p10),
    miete_whg_p90:    yearly2monthly(miete_whg.p90),
    // Haus
    miete_haus_median: yearly2monthly(miete_haus.median),
    miete_haus_p10:    yearly2monthly(miete_haus.p10),
    miete_haus_p90:    yearly2monthly(miete_haus.p90),

    // ── Meta ────────────────────────────────────────
    source:     'realadvisor',
    scraped_at: new Date().toISOString(),
    has_data:   !!(kauf_whg.median || kauf_haus.median || miete_whg.median),
  };
}

// ── Persistenz ────────────────────────────────────────────────────────────────

function saveIntermediate(results, strassenMap, errors) {
  // Hauptoutput (immer aktuell halten)
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
    _info: 'Output von 2_scrape_plz.js – NICHT committen! Gross und regenerierbar.',
    scraped_at: new Date().toISOString(),
    total: results.length,
    with_data: results.filter(r => r.has_data).length,
    gemeinden: results,
  }, null, 2), 'utf8');

  // Resume-Datei
  fs.writeFileSync(RESUME_FILE, JSON.stringify({
    saved_at: new Date().toISOString(),
    done_slugs: results.map(r => r.slug),
    results,
    strassenMap,
    errors,
  }, null, 2), 'utf8');
}

// ── Hauptlogik ────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('╔══════════════════════════════════════════════════╗');
  console.log(`║  IMMOSKOP Scraper 2/4 – PLZ-Preis-Scraper        ║`);
  if (KANTON_FILTER) console.log(`║  Filter: nur Kanton ${KANTON_FILTER.padEnd(29)}║`);
  if (RESUME_MODE)   console.log(`║  Modus: RESUME                                   ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (!fs.existsSync(SLUGS_FILE)) {
    console.error(`❌ data/slugs.json fehlt → zuerst node 1_harvest_slugs.js ausführen`);
    process.exit(1);
  }

  let gemeinden = JSON.parse(fs.readFileSync(SLUGS_FILE, 'utf8')).gemeinden;
  if (KANTON_FILTER) gemeinden = gemeinden.filter(g => g.kanton === KANTON_FILTER);
  console.log(`📋 ${gemeinden.length} Gemeinden geladen${KANTON_FILTER ? ` (Kanton ${KANTON_FILTER})` : ''}\n`);

  // Resume
  let results      = [];
  let strassenMap  = {};  // slug → [{slug, name, url}]
  let errors       = [];
  let doneSlugs    = new Set();

  if (RESUME_MODE && fs.existsSync(RESUME_FILE)) {
    const p = JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8'));
    results     = p.results     || [];
    strassenMap = p.strassenMap || {};
    errors      = p.errors      || [];
    doneSlugs   = new Set(p.done_slugs || []);
    gemeinden   = gemeinden.filter(g => !doneSlugs.has(g.slug));
    console.log(`▶ Resume: ${doneSlugs.size} bereits fertig, ${gemeinden.length} verbleibend\n`);
  }

  const total   = gemeinden.length + doneSlugs.size;
  const startTs = Date.now();

  for (let i = 0; i < gemeinden.length; i++) {
    const g       = gemeinden[i];
    const done    = i + doneSlugs.size;
    const pct     = Math.round((done + 1) / total * 100);
    const elapsed = (Date.now() - startTs) / 1000;
    const eta     = i > 0
      ? Math.round(elapsed / i * (gemeinden.length - i) / 60)
      : '?';

    process.stdout.write(
      `[${String(done + 1).padStart(4, '0')}/${total}] ${String(pct).padStart(3)}% ` +
      `${g.slug.slice(0, 33).padEnd(33)} `
    );

    try {
      const { status, body } = await fetchPage(g.url);
      if (status === 404) {
        console.log(`⚠  404`);
        errors.push({ slug: g.slug, kanton: g.kanton, error: '404' });
        results.push({ ...buildRow(g, { kauf_whg: {}, kauf_haus: {}, miete_whg: {}, miete_haus: {} }), error: '404' });
      } else if (status !== 200) {
        throw new Error(`HTTP ${status}`);
      } else {
        const preise   = extractPreise(body);
        const row      = buildRow(g, preise);
        const strassen = extractStrassenLinks(body, g.slug);

        results.push(row);
        if (strassen.length > 0) strassenMap[g.slug] = strassen;

        const info = row.has_data
          ? `Kauf: ${row.kauf_whg_median ? 'CHF ' + row.kauf_whg_median.toLocaleString('de-CH') : '–'}/m²` +
            `  Miete: ${row.miete_whg_median ? 'CHF ' + row.miete_whg_median : '–'}/m²/Mt` +
            `  Str: ${strassen.length}`
          : '⚠ keine Daten extrahiert';
        console.log(`${row.has_data ? '✓' : '⚠'}  ${info}`);
      }
    } catch (err) {
      console.log(`❌  ${err.message}`);
      errors.push({ slug: g.slug, kanton: g.kanton, error: err.message });
    }

    // Zwischenstand
    if ((i + 1) % BATCH_SIZE === 0) {
      saveIntermediate(results, strassenMap, errors);
      console.log(`\n   💾 Zwischenstand gespeichert (~${eta} Min verbleibend)\n`);
    }

    if (i < gemeinden.length - 1) await sleep(DELAY_MS);
  }

  // ── Finale Outputs ────────────────────────────────────────────────────────

  // Strassenliste für Skript 3 separat speichern
  const strassenFile = path.join(DATA_DIR, 'strassen_links.json');
  fs.writeFileSync(strassenFile, JSON.stringify({
    _info: 'Output von 2_scrape_plz.js – wird von 3_scrape_streets.js gelesen. Nicht committen.',
    generated_at: new Date().toISOString(),
    total_gemeinden: Object.keys(strassenMap).length,
    total_strassen: Object.values(strassenMap).reduce((s, a) => s + a.length, 0),
    strassen: strassenMap,
  }, null, 2), 'utf8');

  saveIntermediate(results, strassenMap, errors);

  // Log
  const withData    = results.filter(r => r.has_data).length;
  const byKanton    = {};
  for (const r of results) {
    if (!byKanton[r.kanton]) byKanton[r.kanton] = { total: 0, mit_daten: 0, fehler: 0 };
    byKanton[r.kanton].total++;
    if (r.has_data) byKanton[r.kanton].mit_daten++;
  }
  for (const e of errors) {
    if (byKanton[e.kanton]) byKanton[e.kanton].fehler++;
  }

  fs.writeFileSync(LOG_FILE, JSON.stringify({
    scraped_at: new Date().toISOString(),
    total: results.length,
    with_data: withData,
    without_data: results.length - withData,
    errors,
    by_kanton: byKanton,
  }, null, 2), 'utf8');

  // Resume aufräumen
  if (fs.existsSync(RESUME_FILE)) fs.unlinkSync(RESUME_FILE);

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(`║  ✓ Fertig!                                        ║`);
  console.log(`║  Gesamt:      ${String(results.length).padEnd(35)}║`);
  console.log(`║  Mit Daten:   ${String(withData).padEnd(35)}║`);
  console.log(`║  Ohne Daten:  ${String(results.length - withData).padEnd(35)}║`);
  console.log(`║  Fehler:      ${String(errors.length).padEnd(35)}║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Outputs:                                         ║');
  console.log('║  • data/plz_prices_raw.json                       ║');
  console.log('║  • data/strassen_links.json  (für Skript 3)       ║');
  console.log('║  • data/scrape_plz_log.json                       ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Nächster Schritt:  node 3_scrape_streets.js      ║');
  console.log('╚══════════════════════════════════════════════════╝');
}

main().catch(e => { console.error('Fataler Fehler:', e); process.exit(1); });
