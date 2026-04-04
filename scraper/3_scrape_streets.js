/**
 * IMMOSKOP Scraper 3/4 – Strassen-Scraper
 * =========================================
 * Liest data/strassen_links.json (Output von Skript 2) und scrapt
 * für jede Strasse die verfügbaren Preisdaten.
 *
 * Was RealAdvisor auf Strassenebene zeigt:
 *   ✓  Kauf-Median CHF/m² (kombiniert, kein Typ)
 *   ✓  Kauf-Spanne: P10–P90 (ca.)
 *   ✗  Kein Typ-Split (Whg vs. Haus)
 *   ✗  Keine strassenspezifische Miete
 *      (Mietdaten = Gemeindedaten, nicht strassenspezifisch)
 *
 * Wir speichern daher nur was wirklich strassenspezifisch ist:
 *   kauf_median, kauf_p10, kauf_p90
 *
 * Für die Immoskop-Analyse wird der Strassen-Preis relativ zur
 * Gemeinde-Spanne interpretiert (Percentile), und dieser Percentile
 * dann auch auf die Miete angewendet.
 *
 * Output:     data/street_prices_raw.json   (NICHT committen!)
 *             data/scrape_streets_log.json
 * Resume:     node 3_scrape_streets.js --resume
 * Kanton:     node 3_scrape_streets.js --kanton ZH
 * Dauer:      ~3–6 Stunden (viele mehr Seiten als Gemeinden)
 */

'use strict';
const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Konfiguration ─────────────────────────────────────────────────────────────

const DELAY_MS    = 1000;
const BATCH_SIZE  = 100;
const DATA_DIR    = path.join(__dirname, 'data');
const INPUT_FILE  = path.join(DATA_DIR, 'strassen_links.json');
const OUTPUT_FILE = path.join(DATA_DIR, 'street_prices_raw.json');
const LOG_FILE    = path.join(DATA_DIR, 'scrape_streets_log.json');
const RESUME_FILE = path.join(DATA_DIR, '.streets_progress.json');

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

function parseChf(str) {
  if (!str) return null;
  const n = parseFloat(String(str).replace(/['']/g, '').replace(/[^0-9.]/g, ''));
  return isNaN(n) || n === 0 ? null : n;
}

/**
 * Extrahiert den strassenspezifischen Preis aus dem HTML.
 *
 * Aufbau der Strassenseite:
 *   "Strasse"
 *   CHF 13'125           ← Kauf-Median
 *   CHF 8'309 - CHF 15'394  ← Kauf-Spanne (≈P10–P90)
 *
 * Achtung: Darunter folgen Gemeinde-Daten (Haus/Whg getrennt),
 * die wir NICHT als Strassendaten interpretieren.
 */
function extractStrassenPreis(html) {
  // Wir suchen den Block direkt nach dem Titel der Seite.
  // Das Label "Strasse" erscheint kurz vor den strassenspezifischen Zahlen.
  const strasseIdx = html.indexOf('>Strasse<');
  if (strasseIdx === -1) {
    // Alternativ: Suche nach dem Heading-Muster
    // "Der durchschnittliche Immobilienpreis an der X beträgt..."
    return extractFallback(html);
  }

  // Snippet: 600 Zeichen nach "Strasse"-Label
  const snippet = html.slice(strasseIdx, strasseIdx + 600);

  const chfMatches = [...snippet.matchAll(/CHF\s+([\d']+)/g)];
  if (chfMatches.length === 0) return { median: null, p10: null, p90: null };

  const median = parseChf(chfMatches[0]?.[1]);

  // Range: "CHF X - CHF Y" oder "CHF X - Y"
  const rangeM = snippet.match(/CHF\s+([\d']+)\s*[-–]\s*(?:CHF\s+)?([\d']+)/);
  const p10    = rangeM ? parseChf(rangeM[1]) : (parseChf(chfMatches[1]?.[1]) ?? null);
  const p90    = rangeM ? parseChf(rangeM[2]) : (parseChf(chfMatches[2]?.[1]) ?? null);

  return { median, p10, p90 };
}

function extractFallback(html) {
  // Suche nach "beträgt im ... CHF X"
  const m = html.match(/betr[äa]gt[^C]{0,100}CHF\s+([\d']+)/);
  return {
    median: m ? parseChf(m[1]) : null,
    p10: null,
    p90: null,
  };
}

// ── Hauptlogik ────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  IMMOSKOP Scraper 3/4 – Strassen-Scraper         ║');
  if (KANTON_FILTER) console.log(`║  Filter: nur Kanton ${KANTON_FILTER.padEnd(29)}║`);
  if (RESUME_MODE)   console.log('║  Modus: RESUME                                   ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (!fs.existsSync(INPUT_FILE)) {
    console.error('❌ data/strassen_links.json fehlt → zuerst node 2_scrape_plz.js ausführen');
    process.exit(1);
  }

  const input       = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const strassenMap = input.strassen; // { gemeindeSlug: [{slug, name, url}] }

  // Flache Liste aller Strassen aufbauen
  let allStrassen = [];
  for (const [gemeindeSlug, strassen] of Object.entries(strassenMap)) {
    for (const s of strassen) {
      allStrassen.push({ ...s, gemeinde_slug: gemeindeSlug });
    }
  }

  // Kanton-Filter: Wir brauchen die Kantonsinfo aus slugs.json
  if (KANTON_FILTER) {
    const slugsFile = path.join(DATA_DIR, 'slugs.json');
    if (fs.existsSync(slugsFile)) {
      const slugsData  = JSON.parse(fs.readFileSync(slugsFile, 'utf8'));
      const kantonSlugs = new Set(
        slugsData.gemeinden.filter(g => g.kanton === KANTON_FILTER).map(g => g.slug)
      );
      allStrassen = allStrassen.filter(s => kantonSlugs.has(s.gemeinde_slug));
    }
  }

  console.log(`📋 ${allStrassen.length} Strassen geladen\n`);

  // Resume
  let results   = [];
  let errors    = [];
  let doneSlugs = new Set();

  if (RESUME_MODE && fs.existsSync(RESUME_FILE)) {
    const p   = JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8'));
    results   = p.results || [];
    errors    = p.errors  || [];
    doneSlugs = new Set(p.done_keys || []);
    allStrassen = allStrassen.filter(s => !doneSlugs.has(`${s.gemeinde_slug}/${s.slug}`));
    console.log(`▶ Resume: ${doneSlugs.size} bereits fertig, ${allStrassen.length} verbleibend\n`);
  }

  const total   = allStrassen.length + doneSlugs.size;
  const startTs = Date.now();

  for (let i = 0; i < allStrassen.length; i++) {
    const s    = allStrassen[i];
    const key  = `${s.gemeinde_slug}/${s.slug}`;
    const done = i + doneSlugs.size;
    const pct  = Math.round((done + 1) / total * 100);
    const eta  = i > 1
      ? Math.round((Date.now() - startTs) / 1000 / i * (allStrassen.length - i) / 60)
      : '?';

    process.stdout.write(
      `[${String(done + 1).padStart(5, '0')}/${total}] ${String(pct).padStart(3)}% ` +
      `${key.slice(0, 40).padEnd(40)} `
    );

    try {
      const { status, body } = await fetchPage(s.url);
      if (status === 404) {
        console.log('⚠  404');
        errors.push({ key, error: '404' });
      } else if (status !== 200) {
        throw new Error(`HTTP ${status}`);
      } else {
        const preis = extractStrassenPreis(body);
        const row = {
          // Identifikation
          gemeinde_slug:  s.gemeinde_slug,
          strasse_slug:   s.slug,
          strasse_name:   s.name,
          strasse_name_lower: s.name.toLowerCase(),
          // PLZ aus Gemeinde-Slug ableiten (z. B. "8904-aesch-zh" → "8904")
          plz: s.gemeinde_slug.match(/^(\d{4})-/)?.[1] ?? null,

          // ── KAUF (strassenspezifisch) ──────────────
          // Nur Kauf, kein Typ-Split (Whg/Haus), kein Mietpreis.
          // Miete wird über Gemeinde-Percentile interpoliert (in api/data.js).
          kauf_median: preis.median,
          kauf_p10:    preis.p10,
          kauf_p90:    preis.p90,

          // ── Meta ────────────────────────────────────
          source:     'realadvisor',
          scraped_at: new Date().toISOString(),
          has_data:   !!preis.median,
          url:        s.url,
        };
        results.push(row);

        const info = row.has_data
          ? `CHF ${row.kauf_median?.toLocaleString('de-CH')}/m²` +
            (row.kauf_p10 && row.kauf_p90
              ? `  (${row.kauf_p10.toLocaleString('de-CH')}–${row.kauf_p90.toLocaleString('de-CH')})`
              : '')
          : '⚠ keine Daten';
        console.log(`${row.has_data ? '✓' : '⚠'}  ${info}`);
      }
    } catch (err) {
      console.log(`❌  ${err.message}`);
      errors.push({ key, error: err.message });
    }

    // Zwischenstand
    if ((i + 1) % BATCH_SIZE === 0) {
      saveIntermediate(results, errors, doneSlugs, allStrassen.slice(0, i + 1).map(s => `${s.gemeinde_slug}/${s.slug}`));
      console.log(`\n   💾 Zwischenstand (~${eta} Min verbleibend)\n`);
    }

    if (i < allStrassen.length - 1) await sleep(DELAY_MS);
  }

  // ── Finale Outputs ────────────────────────────────────────────────────────

  const withData = results.filter(r => r.has_data).length;

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
    _info: 'Output von 3_scrape_streets.js – NICHT committen!',
    scraped_at: new Date().toISOString(),
    total: results.length,
    with_data: withData,
    strassen: results,
  }, null, 2), 'utf8');

  fs.writeFileSync(LOG_FILE, JSON.stringify({
    scraped_at: new Date().toISOString(),
    total: results.length,
    with_data: withData,
    without_data: results.length - withData,
    errors,
  }, null, 2), 'utf8');

  if (fs.existsSync(RESUME_FILE)) fs.unlinkSync(RESUME_FILE);

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  ✓ Fertig!                                        ║');
  console.log(`║  Strassen gesamt:    ${String(results.length).padEnd(28)}║`);
  console.log(`║  Mit Daten:          ${String(withData).padEnd(28)}║`);
  console.log(`║  Fehler:             ${String(errors.length).padEnd(28)}║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  → data/street_prices_raw.json                   ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Nächster Schritt:  node 4_merge_and_upload.js   ║');
  console.log('╚══════════════════════════════════════════════════╝');
}

function saveIntermediate(results, errors, doneSlugs, newKeys) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
    _info: 'Zwischenstand – NICHT committen!',
    scraped_at: new Date().toISOString(),
    total: results.length,
    with_data: results.filter(r => r.has_data).length,
    strassen: results,
  }, null, 2), 'utf8');

  const allDone = new Set([...doneSlugs, ...newKeys]);
  fs.writeFileSync(RESUME_FILE, JSON.stringify({
    saved_at: new Date().toISOString(),
    done_keys: [...allDone],
    results,
    errors,
  }, null, 2), 'utf8');
}

main().catch(e => { console.error('Fataler Fehler:', e); process.exit(1); });
