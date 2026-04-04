/**
 * IMMOSKOP Scraper 2/4 – PLZ + Strassen (kombiniert)
 * ====================================================
 * Liest data/slugs.json und scrapt für jede Gemeinde
 * den React Server Components (RSC) Endpoint von RealAdvisor.
 *
 * Ein einziger Request pro Gemeinde liefert:
 *   ✓ Kaufpreise Whg + Haus (Median, P10, P90) – pro Gemeinde
 *   ✓ Jahresmiete Whg + Haus – pro Gemeinde
 *   ✓ Preise pro PLZ/Ortschaft (localities) – z.B. 8001, 8002... für Zürich
 *   ✓ Alle Strassen mit Kaufpreis (Median, P15, P85)
 *
 * Skript 3 (Strassen separat) ist damit überflüssig!
 *
 * Output:  data/plz_prices_raw.json     (Gemeinden + PLZ-Ortschaften)
 *          data/street_prices_raw.json  (Strassen)
 *          data/scrape_log.json
 *
 * Optionen:
 *   --resume       Nach Unterbruch fortsetzen
 *   --kanton ZH    Nur einen Kanton (zum Testen)
 *
 * Ausführen:  node 2_scrape_plz.js
 * Dauer:      ~60–90 Minuten für alle 2109 Gemeinden
 */

'use strict';
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const DELAY_MS   = 1100;
const BATCH_SIZE = 50;
const DATA_DIR   = path.join(__dirname, 'data');

const SLUGS_FILE  = path.join(DATA_DIR, 'slugs.json');
const PLZ_OUT     = path.join(DATA_DIR, 'plz_prices_raw.json');
const STR_OUT     = path.join(DATA_DIR, 'street_prices_raw.json');
const LOG_FILE    = path.join(DATA_DIR, 'scrape_log.json');
const RESUME_FILE = path.join(DATA_DIR, '.scrape_progress.json');

const RESUME_MODE   = process.argv.includes('--resume');
const KANTON_FILTER = (() => {
  const i = process.argv.indexOf('--kanton');
  return i !== -1 ? process.argv[i + 1]?.toUpperCase() : null;
})();

// ── HTTP ──────────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fetchRsc(slug) {
  return new Promise((resolve, reject) => {
    const url = `https://realadvisor.ch/de/immobilienpreise-pro-m2/${slug}`;
    const req = https.get(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept':          'text/x-component',
        'Accept-Language': 'de-CH,de;q=0.9',
        'RSC':             '1',
        'Next-Router-State-Tree': '%5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%5D',
      },
      timeout: 25000,
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location || '';
        const newSlug  = location.split('/immobilienpreise-pro-m2/')[1]?.split('?')[0];
        if (newSlug && newSlug !== slug) {
          return fetchRsc(newSlug).then(r => resolve({ ...r, redirectedFrom: slug })).catch(reject);
        }
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body, finalSlug: slug }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Extrahiert einen JSON-Array-Block nach einem Marker-String.
 */
function extractJsonBlock(body, marker) {
  const idx = body.indexOf(marker);
  if (idx === -1) return null;
  const start = body.indexOf('[', idx);
  if (start === -1) return null;
  let depth = 0, end = -1;
  for (let i = start; i < Math.min(start + 500000, body.length); i++) {
    if (body[i] === '[' || body[i] === '{') depth++;
    else if (body[i] === ']' || body[i] === '}') {
      if (--depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) return null;
  try { return JSON.parse(body.slice(start, end)); } catch { return null; }
}

/**
 * Extrahiert Gemeinde-Preise (priceStats).
 * Liefert APPT und HOUSE separat.
 */
function extractPriceStats(body) {
  const arr = extractJsonBlock(body, '"priceStats":');
  if (!arr) return null;
  return {
    appt:  arr.find(r => r.property_main_type === 'APPT'),
    house: arr.find(r => r.property_main_type === 'HOUSE'),
  };
}

/**
 * Extrahiert PLZ-Ortschaften (localities) aus dem RSC-Payload.
 *
 * Beispiel aus Uster-Response:
 * "localities":[
 *   {"label":"8610 Uster","slug":"8610-uster",
 *    "price_stats_appt":[{"sale_price_m2_50":10535}],
 *    "price_stats_house":[{"sale_price_m2_50":11185}],
 *    "price_stats_rent":[{"yearly_rent_m2_50":360}]},
 *   {"label":"8615 Wermatswil","slug":"8615-wermatswil",...}
 * ]
 *
 * Für Stadt Zürich gibt das z.B. 8001, 8002, 8003... mit je eigenen Preisen.
 */
function extractLocalities(body) {
  const arr = extractJsonBlock(body, '"localities":');
  if (!Array.isArray(arr)) return [];
  return arr;
}

/**
 * Extrahiert Strassen (street_places).
 */
function extractStreetPlaces(body) {
  return extractJsonBlock(body, '"street_places":') || [];
}

function plzFromSlug(slug) {
  return (slug || '').match(/^(\d{4})-/)?.[1] ?? null;
}

// ── Row-Builder ───────────────────────────────────────────────────────────────

const m = v => v ? Math.round(v / 12 * 10) / 10 : null;

/**
 * Baut einen PLZ-Row aus Gemeinde-Preisen (priceStats).
 * Typ: 'gemeinde' – aggregierter Wert für die ganze Gemeinde.
 */
function buildGemeindeRow(gemeinde, priceStats, finalSlug) {
  const appt  = priceStats?.appt  || {};
  const house = priceStats?.house || {};

  return {
    typ:    'gemeinde',           // 'gemeinde' oder 'locality'
    slug:   finalSlug || gemeinde.slug,
    name:   gemeinde.name,
    plz:    gemeinde.plz,
    kanton: gemeinde.kanton,

    // Kauf CHF/m²
    kauf_whg_median:  appt.sale_price_m2_50  ?? null,
    kauf_whg_p10:     appt.sale_price_m2_10  ?? null,
    kauf_whg_p90:     appt.sale_price_m2_90  ?? null,
    kauf_haus_median: house.sale_price_m2_50 ?? null,
    kauf_haus_p10:    house.sale_price_m2_10 ?? null,
    kauf_haus_p90:    house.sale_price_m2_90 ?? null,

    // Miete CHF/m²/Monat (aus Jahreswert ÷ 12)
    miete_whg_median:  m(appt.yearly_rent_m2_50),
    miete_whg_p10:     m(appt.yearly_rent_m2_10),
    miete_whg_p90:     m(appt.yearly_rent_m2_90),
    miete_haus_median: m(house.yearly_rent_m2_50),
    miete_haus_p10:    m(house.yearly_rent_m2_10),
    miete_haus_p90:    m(house.yearly_rent_m2_90),

    source:     'realadvisor',
    scraped_at: new Date().toISOString(),
    has_data:   !!(appt.sale_price_m2_50 || house.sale_price_m2_50),
  };
}

/**
 * Baut PLZ-Rows aus dem localities-Block.
 * Typ: 'locality' – PLZ-spezifischer Wert innerhalb einer Gemeinde.
 *
 * Localities haben weniger Felder als Gemeinden:
 *   price_stats_appt:  [{ sale_price_m2_50 }]
 *   price_stats_house: [{ sale_price_m2_50 }]
 *   price_stats_rent:  [{ yearly_rent_m2_50 }]
 * (Nur Median, kein P10/P90 auf Locality-Ebene)
 */
function buildLocalityRows(localities, gemeindeKanton, gemeindeSlug) {
  const rows = [];
  for (const loc of localities) {
    if (!loc.slug) continue;

    const plz  = plzFromSlug(loc.slug);
    const appt  = loc.price_stats_appt?.[0]  || {};
    const house = loc.price_stats_house?.[0] || {};
    const rent  = loc.price_stats_rent?.[0]  || {};

    // Mietpreis: rent-Array hat yearly_rent_m2_50, sonst aus appt schätzen
    const rentMedian = rent.yearly_rent_m2_50 ?? null;

    rows.push({
      typ:    'locality',
      slug:   loc.slug,
      name:   loc.label || loc.slug,
      plz,
      kanton: gemeindeKanton,
      gemeinde_slug: gemeindeSlug,   // Verweis auf Eltern-Gemeinde

      // Kauf – nur Median verfügbar auf Locality-Ebene
      kauf_whg_median:  appt.sale_price_m2_50  ?? null,
      kauf_whg_p10:     null,  // nicht verfügbar
      kauf_whg_p90:     null,
      kauf_haus_median: house.sale_price_m2_50 ?? null,
      kauf_haus_p10:    null,
      kauf_haus_p90:    null,

      // Miete – nur Median
      miete_whg_median:  m(rentMedian),
      miete_whg_p10:     null,
      miete_whg_p90:     null,
      miete_haus_median: null,
      miete_haus_p10:    null,
      miete_haus_p90:    null,

      source:     'realadvisor',
      scraped_at: new Date().toISOString(),
      has_data:   !!(appt.sale_price_m2_50 || house.sale_price_m2_50),
    });
  }
  return rows;
}

function buildStreetRows(gemeindeSlug, gemeindePlz, streetPlaces) {
  return streetPlaces
    .map(place => {
      const s = place.street_stat;
      if (!s) return null;
      const localitySlug = s.locality?.slug_de || s.locality?.slug_en || '';
      const plz = plzFromSlug(localitySlug) || gemeindePlz;
      return {
        gemeinde_slug:      gemeindeSlug,
        strasse_slug:       s.slug,
        strasse_name:       s.route,
        strasse_name_lower: (s.route || '').toLowerCase(),
        plz,
        lat: s.lat ?? null,
        lng: s.lng ?? null,
        is_cross_locality:  s.is_cross_locality ?? false,
        kauf_median: s.median_price_per_m2              ?? null,
        kauf_p15:    s.lower_15_percentile_price_per_m2 ?? null,
        kauf_p85:    s.upper_15_percentile_price_per_m2 ?? null,
        transaction_count: s.total_count ?? null,
        source:     'realadvisor',
        scraped_at: new Date().toISOString(),
        has_data:   !!s.median_price_per_m2,
      };
    })
    .filter(Boolean);
}

// ── Persistenz ────────────────────────────────────────────────────────────────

function save(plzResults, strResults, errors) {
  fs.writeFileSync(PLZ_OUT, JSON.stringify({
    _info: 'Output von 2_scrape_plz.js – NICHT committen!',
    _hinweis: 'Enthält typ="gemeinde" (aggregiert) UND typ="locality" (PLZ-spezifisch)',
    scraped_at: new Date().toISOString(),
    total: plzResults.length,
    gemeinden: plzResults.filter(r => r.typ === 'gemeinde').length,
    localities: plzResults.filter(r => r.typ === 'locality').length,
    with_data: plzResults.filter(r => r.has_data).length,
    eintraege: plzResults,
  }, null, 2), 'utf8');

  fs.writeFileSync(STR_OUT, JSON.stringify({
    _info: 'Output von 2_scrape_plz.js – NICHT committen!',
    scraped_at: new Date().toISOString(),
    total: strResults.length,
    with_data: strResults.filter(r => r.has_data).length,
    strassen: strResults,
  }, null, 2), 'utf8');

  fs.writeFileSync(RESUME_FILE, JSON.stringify({
    saved_at: new Date().toISOString(),
    done_slugs: plzResults.filter(r => r.typ === 'gemeinde').map(r => r.slug),
    plz_results: plzResults,
    str_results: strResults,
    errors,
  }, null, 2), 'utf8');
}

// ── Hauptlogik ────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  IMMOSKOP Scraper 2/4 – PLZ + Strassen           ║');
  console.log('║  Methode: RSC-Endpoint (1 Request pro Gemeinde)  ║');
  console.log('║  Inkl. PLZ-Ortschaften (localities)              ║');
  if (KANTON_FILTER) console.log(`║  Filter: Kanton ${KANTON_FILTER.padEnd(33)}║`);
  if (RESUME_MODE)   console.log('║  Modus: RESUME                                   ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (!fs.existsSync(SLUGS_FILE)) {
    console.error('❌ data/slugs.json fehlt → zuerst node 1_harvest_slugs.js ausführen');
    process.exit(1);
  }

  let gemeinden = JSON.parse(fs.readFileSync(SLUGS_FILE, 'utf8')).gemeinden;
  if (KANTON_FILTER) gemeinden = gemeinden.filter(g => g.kanton === KANTON_FILTER);
  console.log(`📋 ${gemeinden.length} Gemeinden geladen\n`);

  let plzResults = [], strResults = [], errors = [], doneSlugs = new Set();

  if (RESUME_MODE && fs.existsSync(RESUME_FILE)) {
    const p = JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8'));
    plzResults = p.plz_results || [];
    strResults = p.str_results || [];
    errors     = p.errors      || [];
    doneSlugs  = new Set(p.done_slugs || []);
    gemeinden  = gemeinden.filter(g => !doneSlugs.has(g.slug));
    console.log(`▶ Resume: ${doneSlugs.size} fertig, ${gemeinden.length} verbleibend\n`);
  }

  const total = gemeinden.length + doneSlugs.size;
  const ts    = Date.now();

  for (let i = 0; i < gemeinden.length; i++) {
    const g   = gemeinden[i];
    const pct = Math.round((i + doneSlugs.size + 1) / total * 100);
    const eta = i > 1 ? Math.round((Date.now() - ts) / 1000 / i * (gemeinden.length - i) / 60) : '?';

    process.stdout.write(
      `[${String(i + doneSlugs.size + 1).padStart(4, '0')}/${total}] ${String(pct).padStart(3)}% ` +
      `${g.slug.slice(0, 33).padEnd(33)} `
    );

    try {
      const { status, body, finalSlug } = await fetchRsc(g.slug);

      if (status === 404) {
        console.log('⚠  404');
        errors.push({ slug: g.slug, kanton: g.kanton, error: '404' });
        plzResults.push(buildGemeindeRow(g, null, g.slug));
      } else if (status !== 200) {
        throw new Error(`HTTP ${status}`);
      } else {
        const ps         = extractPriceStats(body);
        const localities = extractLocalities(body);
        const sp         = extractStreetPlaces(body);

        const gemRow  = buildGemeindeRow(g, ps, finalSlug || g.slug);
        const locRows = buildLocalityRows(localities, g.kanton, finalSlug || g.slug);
        const strRows = buildStreetRows(finalSlug || g.slug, g.plz, sp);

        plzResults.push(gemRow);
        plzResults.push(...locRows);
        strResults.push(...strRows);

        const info = gemRow.has_data
          ? `Kauf Whg: CHF ${gemRow.kauf_whg_median?.toLocaleString('de-CH') ?? '–'}/m²` +
            `  Miete: CHF ${gemRow.miete_whg_median ?? '–'}/Mt` +
            `  PLZ: ${locRows.length}  Str: ${strRows.length}`
          : '⚠ keine Preisdaten';
        console.log(`${gemRow.has_data ? '✓' : '⚠'}  ${info}`);
      }
    } catch (err) {
      console.log(`❌  ${err.message}`);
      errors.push({ slug: g.slug, kanton: g.kanton, error: err.message });
    }

    if ((i + 1) % BATCH_SIZE === 0) {
      save(plzResults, strResults, errors);
      console.log(`\n   💾 Zwischenstand gespeichert (~${eta} Min verbleibend)\n`);
    }

    if (i < gemeinden.length - 1) await sleep(DELAY_MS);
  }

  save(plzResults, strResults, errors);
  if (fs.existsSync(RESUME_FILE)) fs.unlinkSync(RESUME_FILE);

  const gemeindeMit  = plzResults.filter(r => r.typ === 'gemeinde' && r.has_data).length;
  const localityMit  = plzResults.filter(r => r.typ === 'locality' && r.has_data).length;
  const gemeindeGes  = plzResults.filter(r => r.typ === 'gemeinde').length;
  const localityGes  = plzResults.filter(r => r.typ === 'locality').length;

  const bk = {};
  for (const r of plzResults.filter(r => r.typ === 'gemeinde')) {
    if (!bk[r.kanton]) bk[r.kanton] = { total: 0, mit_daten: 0 };
    bk[r.kanton].total++;
    if (r.has_data) bk[r.kanton].mit_daten++;
  }
  fs.writeFileSync(LOG_FILE, JSON.stringify({
    scraped_at: new Date().toISOString(),
    gemeinden:  { total: gemeindeGes, with_data: gemeindeMit },
    localities: { total: localityGes, with_data: localityMit },
    strassen:   { total: strResults.length, with_data: strResults.filter(r => r.has_data).length },
    errors,
    by_kanton: bk,
  }, null, 2), 'utf8');

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  ✓ Fertig!                                        ║');
  console.log(`║  Gemeinden:     ${String(gemeindeGes).padEnd(33)}║`);
  console.log(`║  PLZ-Ortsch.:   ${String(localityGes).padEnd(33)}║`);
  console.log(`║  Strassen:      ${String(strResults.length).padEnd(33)}║`);
  console.log(`║  Fehler:        ${String(errors.length).padEnd(33)}║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  → data/plz_prices_raw.json                      ║');
  console.log('║  → data/street_prices_raw.json                   ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Nächster Schritt:  node 4_merge_and_upload.js   ║');
  console.log('╚══════════════════════════════════════════════════╝');
}

main().catch(e => { console.error('Fataler Fehler:', e); process.exit(1); });
