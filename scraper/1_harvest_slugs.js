/**
 * IMMOSKOP Scraper 1/4 – Slug-Harvester
 * =======================================
 * Zwei-Stufen-Ansatz:
 *
 * Stufe 1: Kantonsseiten → Top-75 Gemeinden pro Kanton (direkte Links)
 * Stufe 2: OpenPLZ API  → alle CH-Gemeinden mit PLZ + Namen
 *          → RealAdvisor-URL konstruieren und per HEAD-Request validieren
 *
 * Output:  data/slugs.json   ← auf GitHub committen!
 * Dauer:   ~15–25 Minuten (Stufe 2 validiert ~2000 PLZ)
 *
 * Ausführen:  node 1_harvest_slugs.js
 */

'use strict';
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const DELAY_MS_STUFE1 = 800;
const DELAY_MS_STUFE2 = 300;  // kürzer, weil HEAD-Requests schneller
const BATCH_PARALLEL  = 5;    // parallele HEAD-Requests
const OUTPUT_DIR      = path.join(__dirname, 'data');
const OUTPUT_FILE     = path.join(OUTPUT_DIR, 'slugs.json');

const KANTONE = [
  { kz: 'ZH', name: 'Zürich',           slug: 'kanton-zurich',                kantonsNr: 1 },
  { kz: 'BE', name: 'Bern',             slug: 'kanton-bern',                  kantonsNr: 2 },
  { kz: 'LU', name: 'Luzern',           slug: 'kanton-luzern',                kantonsNr: 3 },
  { kz: 'UR', name: 'Uri',              slug: 'kanton-uri',                   kantonsNr: 4 },
  { kz: 'SZ', name: 'Schwyz',           slug: 'kanton-schwyz',                kantonsNr: 5 },
  { kz: 'OW', name: 'Obwalden',         slug: 'kanton-obwalden',              kantonsNr: 6 },
  { kz: 'NW', name: 'Nidwalden',        slug: 'kanton-nidwalden',             kantonsNr: 7 },
  { kz: 'GL', name: 'Glarus',           slug: 'kanton-glarus',                kantonsNr: 8 },
  { kz: 'ZG', name: 'Zug',             slug: 'kanton-zug',                   kantonsNr: 9 },
  { kz: 'FR', name: 'Freiburg',         slug: 'kanton-freiburg',              kantonsNr: 10 },
  { kz: 'SO', name: 'Solothurn',        slug: 'kanton-solothurn',             kantonsNr: 11 },
  { kz: 'BS', name: 'Basel-Stadt',      slug: 'kanton-basel-stadt',           kantonsNr: 12 },
  { kz: 'BL', name: 'Basel-Landschaft', slug: 'kanton-basel-landschaft',      kantonsNr: 13 },
  { kz: 'SH', name: 'Schaffhausen',     slug: 'kanton-schaffhausen',          kantonsNr: 14 },
  { kz: 'AR', name: 'Appenzell AR',     slug: 'kanton-appenzell-ausserrhoden',kantonsNr: 15 },
  { kz: 'AI', name: 'Appenzell IR',     slug: 'kanton-appenzell-innerrhoden', kantonsNr: 16 },
  { kz: 'SG', name: 'St. Gallen',       slug: 'kanton-st-gallen',             kantonsNr: 17 },
  { kz: 'GR', name: 'Graubünden',       slug: 'kanton-graubunden',            kantonsNr: 18 },
  { kz: 'AG', name: 'Aargau',           slug: 'kanton-aargau',                kantonsNr: 19 },
  { kz: 'TG', name: 'Thurgau',          slug: 'kanton-thurgau',               kantonsNr: 20 },
  { kz: 'TI', name: 'Tessin',           slug: 'kanton-tessin',                kantonsNr: 21 },
  { kz: 'VD', name: 'Waadt',            slug: 'kanton-waadt',                 kantonsNr: 22 },
  { kz: 'VS', name: 'Wallis',           slug: 'kanton-wallis',                kantonsNr: 23 },
  { kz: 'NE', name: 'Neuenburg',        slug: 'kanton-neuenburg',             kantonsNr: 24 },
  { kz: 'GE', name: 'Genf',             slug: 'kanton-genf',                  kantonsNr: 25 },
  { kz: 'JU', name: 'Jura',             slug: 'kanton-jura',                  kantonsNr: 26 },
];

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'immoskop-scraper/1.0' },
      timeout: 15000,
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: null, raw: body }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function headRequest(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    }, res => {
      // Bei Redirect: Ziel-URL prüfen
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return headRequest(res.headers.location).then(resolve);
      }
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
  });
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html', 'Accept-Language': 'de-CH,de;q=0.9',
      },
      timeout: 20000,
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return fetchHtml(res.headers.location).then(resolve).catch(reject);
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

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
    out.push({ slug, name, plz: plzMatch ? plzMatch[1] : null, kanton: kz,
      url: `https://realadvisor.ch/de/immobilienpreise-pro-m2/${slug}` });
  }
  return out;
}

/**
 * Konvertiert Namen in RealAdvisor-Slug.
 * Beispiele:
 *   "Wohlen b. Bern"  → "wohlen-b-bern"
 *   "Münchenbuchsee"  → "munchenbuchsee"  (Umlaut → ASCII)
 *   "La Chaux-de-Fonds" → "la-chaux-de-fonds"
 */
function nameToSlug(name) {
  return name
    .toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .replace(/è|é|ê|ë/g, 'e').replace(/à|â|á/g, 'a').replace(/î|ï|í/g, 'i')
    .replace(/ô|ó/g, 'o').replace(/ù|û|ú/g, 'u').replace(/ç/g, 'c')
    .replace(/ñ/g, 'n').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Stufe 2: OpenPLZ API ──────────────────────────────────────────────────────

/**
 * Lädt alle Schweizer Gemeinden von der OpenPLZ API.
 * API-Doku: https://openplzapi.org/de/switzerland/
 * Endpunkt: GET /ch/Cantons/{nr}/Communes?page=1&pageSize=50
 */
async function fetchAllGemeindenFromOpenPlz() {
  const alleGemeinden = [];
  console.log('   Lade alle CH-Gemeinden von OpenPLZ API...');

  for (const kanton of KANTONE) {
    let page = 1;
    let total = null;

    while (true) {
      const url = `https://openplzapi.org/ch/Cantons/${kanton.kantonsNr}/Communes?page=${page}&pageSize=50`;
      try {
        const { status, data } = await fetchJson(url);
        if (status !== 200 || !Array.isArray(data)) break;
        if (data.length === 0) break;

        for (const g of data) {
          // OpenPLZ gibt: { name, postalCode, ... }
          // Eine Gemeinde kann mehrere PLZ haben – wir nehmen die erste
          alleGemeinden.push({
            name: g.name || g.shortName || '',
            plz: g.postalCode || g.zipCode || '',
            kanton: kanton.kz,
          });
        }

        if (data.length < 50) break; // letzte Seite
        page++;
        await sleep(100);
      } catch {
        break;
      }
    }
  }

  // Alternativ: Direkter PLZ-Endpunkt falls Gemeinden-Endpunkt kein postalCode hat
  if (alleGemeinden.every(g => !g.plz)) {
    console.log('   Versuche PLZ-Endpunkt...');
    alleGemeinden.length = 0;

    for (let plz = 1000; plz <= 9999; plz += 50) {
      // Batch-Abfrage: alle PLZ von X bis X+49
      // OpenPLZ: GET /ch/Localities?postalCode={plz}
      for (let p = plz; p < plz + 50 && p <= 9999; p++) {
        const url = `https://openplzapi.org/ch/Localities?postalCode=${p}&page=1&pageSize=5`;
        try {
          const { status, data } = await fetchJson(url);
          if (status === 200 && Array.isArray(data) && data.length > 0) {
            for (const loc of data) {
              alleGemeinden.push({
                name: loc.name || '',
                plz: String(p),
                kanton: loc.canton?.shortName || '',
              });
            }
          }
        } catch {}
      }
      await sleep(100);
    }
  }

  console.log(`   → ${alleGemeinden.length} Einträge von OpenPLZ geladen`);
  return alleGemeinden;
}

/**
 * Für jede Gemeinde aus OpenPLZ die noch nicht in allSlugs ist:
 * URL konstruieren und per HEAD-Request validieren.
 */
async function validateGemeinden(gemeinden, allSlugs) {
  const zusaetzlich = [];

  // Nur PLZ/Namen testen die wir noch nicht haben
  const zutesten = gemeinden.filter(g => {
    if (!g.plz || !g.name) return false;
    // Schon via Kantonsseite gefunden?
    return ![...allSlugs].some(s => s.startsWith(g.plz + '-'));
  });

  // Duplikate nach PLZ entfernen (nehme erste pro PLZ)
  const seenPlz = new Set();
  const unique  = zutesten.filter(g => {
    if (seenPlz.has(g.plz)) return false;
    seenPlz.add(g.plz);
    return true;
  });

  console.log(`   ${unique.length} PLZ zu validieren...`);

  let checked = 0;
  let found   = 0;

  for (let i = 0; i < unique.length; i += BATCH_PARALLEL) {
    const batch = unique.slice(i, i + BATCH_PARALLEL);

    const results = await Promise.all(batch.map(async g => {
      const nameSlug = nameToSlug(g.name);
      const slug1    = `${g.plz}-${nameSlug}`;
      const url1     = `https://realadvisor.ch/de/immobilienpreise-pro-m2/${slug1}`;

      const status = await headRequest(url1);
      if (status === 200) {
        return { slug: slug1, name: g.name, plz: g.plz, kanton: g.kanton, url: url1 };
      }
      return null;
    }));

    for (const r of results) {
      if (r && !allSlugs.has(r.slug)) {
        allSlugs.add(r.slug);
        zusaetzlich.push(r);
        found++;
      }
    }

    checked += batch.length;
    process.stdout.write(`\r   ${checked}/${unique.length} geprüft, ${found} neu gefunden  `);
    await sleep(DELAY_MS_STUFE2);
  }
  console.log(); // Zeilenumbruch
  return zusaetzlich;
}

// ── Hauptlogik ────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  IMMOSKOP Scraper 1/4 – Slug-Harvester           ║');
  console.log('║  Stufe 1: RealAdvisor Kantonsseiten (Top-75)     ║');
  console.log('║  Stufe 2: OpenPLZ API + Validierung (alle übr.)  ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const allSlugs  = new Set();
  const gemeinden = [];
  const stats     = {};
  const errors    = [];

  // ── Stufe 1 ───────────────────────────────────────────────────────────────
  console.log('── Stufe 1: RealAdvisor Kantonsseiten ───────────────\n');

  for (let i = 0; i < KANTONE.length; i++) {
    const { kz, name, slug } = KANTONE[i];
    process.stdout.write(`[${String(i + 1).padStart(2, '0')}/26] ${kz} ${name.padEnd(22)}... `);

    try {
      const { status, body } = await fetchHtml(
        `https://realadvisor.ch/de/immobilienpreise-pro-m2/${slug}`
      );
      if (status !== 200) throw new Error(`HTTP ${status}`);
      const found = extractGemeinden(body, kz);
      let added = 0;
      for (const g of found) {
        if (!allSlugs.has(g.slug)) { allSlugs.add(g.slug); gemeinden.push(g); added++; }
      }
      stats[kz] = { name, gefunden: found.length };
      console.log(`✓  ${found.length} Gemeinden`);
    } catch (err) {
      console.log(`❌  ${err.message}`);
      errors.push({ kz, error: err.message });
      stats[kz] = { name, error: err.message };
    }
    if (i < KANTONE.length - 1) await sleep(DELAY_MS_STUFE1);
  }

  const nachStufe1 = gemeinden.length;
  console.log(`\n   → ${nachStufe1} Gemeinden nach Stufe 1\n`);

  // ── Stufe 2 ───────────────────────────────────────────────────────────────
  console.log('── Stufe 2: OpenPLZ API + Validierung ───────────────\n');

  const openPlzGemeinden = await fetchAllGemeindenFromOpenPlz();
  const zusaetzlich      = await validateGemeinden(openPlzGemeinden, allSlugs);
  gemeinden.push(...zusaetzlich);

  console.log(`   → ${zusaetzlich.length} zusätzliche Gemeinden gefunden\n`);

  // ── Output ────────────────────────────────────────────────────────────────
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
    _info: 'Output von 1_harvest_slugs.js – auf GitHub committen!',
    harvested_at: new Date().toISOString(),
    total: gemeinden.length,
    von_kantonsseiten: nachStufe1,
    von_plz_validierung: zusaetzlich.length,
    kantone: stats,
    gemeinden,
  }, null, 2), 'utf8');

  console.log('╔══════════════════════════════════════════════════╗');
  console.log(`║  ✓ ${String(gemeinden.length).padEnd(4)} Gemeinden → data/slugs.json            ║`);
  console.log(`║    ${String(nachStufe1).padEnd(4)} aus Kantonsseiten                       ║`);
  console.log(`║    ${String(zusaetzlich.length).padEnd(4)} via PLZ-Validierung                    ║`);
  if (errors.length) console.log(`║  ⚠  ${errors.length} Kantone mit Fehler                        ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Nächster Schritt:  node 2_scrape_plz.js         ║');
  console.log('╚══════════════════════════════════════════════════╝');
}

main().catch(e => { console.error('Fataler Fehler:', e); process.exit(1); });
