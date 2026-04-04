/**
 * IMMOSKOP Scraper 1/4 – Slug-Harvester
 * =======================================
 * Liest alle 26 Kantonsseiten auf RealAdvisor und sammelt
 * jeden Gemeinde-Slug mit Name, PLZ und Kanton.
 *
 * Output:  data/slugs.json   ← auf GitHub committen!
 * Dauer:   ~2–3 Minuten
 *
 * Ausführen:  node 1_harvest_slugs.js
 */

'use strict';
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const DELAY_MS   = 1200;
const OUTPUT_DIR  = path.join(__dirname, 'data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'slugs.json');

const KANTONE = [
  { kz: 'ZH', name: 'Zürich',           slug: 'kanton-zurich' },
  { kz: 'BE', name: 'Bern',             slug: 'kanton-bern' },
  { kz: 'LU', name: 'Luzern',           slug: 'kanton-luzern' },
  { kz: 'UR', name: 'Uri',              slug: 'kanton-uri' },
  { kz: 'SZ', name: 'Schwyz',           slug: 'kanton-schwyz' },
  { kz: 'OW', name: 'Obwalden',         slug: 'kanton-obwalden' },
  { kz: 'NW', name: 'Nidwalden',        slug: 'kanton-nidwalden' },
  { kz: 'GL', name: 'Glarus',           slug: 'kanton-glarus' },
  { kz: 'ZG', name: 'Zug',             slug: 'kanton-zug' },
  { kz: 'FR', name: 'Freiburg',         slug: 'kanton-freiburg' },
  { kz: 'SO', name: 'Solothurn',        slug: 'kanton-solothurn' },
  { kz: 'BS', name: 'Basel-Stadt',      slug: 'kanton-basel-stadt' },
  { kz: 'BL', name: 'Basel-Landschaft', slug: 'kanton-basel-landschaft' },
  { kz: 'SH', name: 'Schaffhausen',     slug: 'kanton-schaffhausen' },
  { kz: 'AR', name: 'Appenzell AR',     slug: 'kanton-appenzell-ausserrhoden' },
  { kz: 'AI', name: 'Appenzell IR',     slug: 'kanton-appenzell-innerrhoden' },
  { kz: 'SG', name: 'St. Gallen',       slug: 'kanton-st-gallen' },
  { kz: 'GR', name: 'Graubünden',       slug: 'kanton-graubunden' },
  { kz: 'AG', name: 'Aargau',           slug: 'kanton-aargau' },
  { kz: 'TG', name: 'Thurgau',          slug: 'kanton-thurgau' },
  { kz: 'TI', name: 'Tessin',           slug: 'kanton-tessin' },
  { kz: 'VD', name: 'Waadt',            slug: 'kanton-waadt' },
  { kz: 'VS', name: 'Wallis',           slug: 'kanton-wallis' },
  { kz: 'NE', name: 'Neuenburg',        slug: 'kanton-neuenburg' },
  { kz: 'GE', name: 'Genf',             slug: 'kanton-genf' },
  { kz: 'JU', name: 'Jura',             slug: 'kanton-jura' },
];

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

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

/**
 * Extrahiert Gemeinde-Links aus einer Kantonsseite.
 * URL-Muster: /de/immobilienpreise-pro-m2/{slug}
 * Slug-Typen: "8953-dietikon" | "stadt-zurich" | "gemeinde-aesch-zh"
 */
function extractGemeinden(html, kz) {
  const seen = new Set();
  const out  = [];
  const re   = /href="\/de\/immobilienpreise-pro-m2\/([^"/]+)"[^>]*>\s*([^<]+?)\s*</g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = m[1].trim();
    const name = m[2].trim();
    if (slug.startsWith('kanton-') || slug === '') continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const plzMatch = slug.match(/^(\d{4})-/);
    out.push({
      slug,
      name,
      plz: plzMatch ? plzMatch[1] : null,
      kanton: kz,
      url: `https://realadvisor.ch/de/immobilienpreise-pro-m2/${slug}`,
    });
  }
  return out;
}

// ── Hauptlogik ────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  IMMOSKOP Scraper 1/4 – Slug-Harvester           ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const allSlugs  = new Set();
  const gemeinden = [];
  const stats     = {};
  const errors    = [];

  for (let i = 0; i < KANTONE.length; i++) {
    const { kz, name, slug } = KANTONE[i];
    process.stdout.write(`[${String(i + 1).padStart(2, '0')}/26] ${kz} ${name.padEnd(22)}... `);

    try {
      const { status, body } = await fetchPage(
        `https://realadvisor.ch/de/immobilienpreise-pro-m2/${slug}`
      );
      if (status !== 200) throw new Error(`HTTP ${status}`);

      const found = extractGemeinden(body, kz);
      let added = 0;
      for (const g of found) {
        if (!allSlugs.has(g.slug)) { allSlugs.add(g.slug); gemeinden.push(g); added++; }
      }
      stats[kz] = { name, gefunden: found.length, neu: added };
      console.log(`✓  ${found.length} Gemeinden (${added} neu)`);
    } catch (err) {
      console.log(`❌  ${err.message}`);
      errors.push({ kz, error: err.message });
      stats[kz] = { name, error: err.message };
    }

    if (i < KANTONE.length - 1) await sleep(DELAY_MS);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
    _info: 'Output von 1_harvest_slugs.js – auf GitHub committen!',
    harvested_at: new Date().toISOString(),
    total: gemeinden.length,
    kantone: stats,
    gemeinden,
  }, null, 2), 'utf8');

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(`║  ✓ ${String(gemeinden.length).padEnd(4)} Gemeinden → data/slugs.json            ║`);
  if (errors.length) console.log(`║  ⚠  ${errors.length} Fehler – bitte Log prüfen                ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Nächster Schritt:  node 2_scrape_plz.js         ║');
  console.log('╚══════════════════════════════════════════════════╝');
}

main().catch(e => { console.error('Fataler Fehler:', e); process.exit(1); });
