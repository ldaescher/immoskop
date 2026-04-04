/**
 * IMMOSKOP Scraper 1/4 – Slug-Harvester
 * =======================================
 * Zwei-Stufen-Ansatz:
 *
 * Stufe 1: Kantonsseiten → Top-75 Gemeinden pro Kanton (nach Einwohnerzahl)
 * Stufe 2: Offizielle CH-PLZ-Liste (Post) → alle restlichen PLZ als URLs
 *          generieren und gegen RealAdvisor validieren
 *
 * Output:  data/slugs.json   ← auf GitHub committen!
 * Dauer:   ~5–10 Minuten (Stufe 2 macht HEAD-Requests pro PLZ-Batch)
 *
 * Ausführen:  node 1_harvest_slugs.js
 */

'use strict';
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const DELAY_MS    = 800;
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

function fetchPage(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'de-CH,de;q=0.9',
      },
      timeout: 15000,
    }, res => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return fetchPage(res.headers.location, method).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body, url }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
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

/**
 * Konvertiert einen Gemeindenamen in einen URL-Slug.
 * Beispiel: "Wohlen b. Bern" → "wohlen-b-bern"
 */
function nameToSlug(name) {
  return name
    .toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .replace(/è|é|ê/g, 'e').replace(/à|â/g, 'a').replace(/î|ï/g, 'i')
    .replace(/ô/g, 'o').replace(/ù|û/g, 'u').replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Stufe 2: Offizielle Schweizer PLZ-Liste von der Post laden.
 * URL: opendata.swiss – PLZ-Verzeichnis der Schweizerischen Post
 * Format: CSV mit PLZ, Gemeindename, Kanton
 */
async function fetchPlzListe() {
  console.log('   Lade offizielle CH-PLZ-Liste (Post/opendata.swiss)...');

  // Offizielle PLZ-Liste der Post (CSV, öffentlich verfügbar)
  const urls = [
    'https://swisspost.opendatasoft.com/api/explore/v2.1/catalog/datasets/plz_verzeichnis_v2/exports/csv?lang=de&timezone=Europe%2FZurich&use_labels=true&delimiter=%3B',
    'https://raw.githubusercontent.com/tammojan/swiss-post-codes/main/swiss_post_codes.csv',
  ];

  for (const url of urls) {
    try {
      const { status, body } = await fetchPage(url);
      if (status === 200 && body.length > 1000) {
        console.log(`   ✓ PLZ-Liste geladen (${Math.round(body.length/1024)} KB)`);
        return parsePlzCsv(body);
      }
    } catch {}
  }

  // Fallback: Wir generieren PLZ 1000–9999 mit leerem Namen
  // (Skript 2 wird dann die Namen aus den Seiten lesen)
  console.log('   ⚠ PLZ-Liste nicht ladbar – generiere PLZ 1000–9999 ohne Namen');
  const plzList = [];
  for (let plz = 1000; plz <= 9999; plz++) {
    plzList.push({ plz: String(plz), name: '', kanton: '' });
  }
  return plzList;
}

function parsePlzCsv(csv) {
  const lines  = csv.split('\n').slice(1); // Header überspringen
  const result = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    // Verschiedene CSV-Formate versuchen (;-getrennt oder ,-getrennt)
    const parts = line.includes(';') ? line.split(';') : line.split(',');
    // PLZ ist meist in Spalte 0 oder 1
    const plz  = (parts[0] || parts[1] || '').replace(/"/g, '').trim();
    const name = (parts[1] || parts[2] || '').replace(/"/g, '').trim();
    const kz   = (parts[3] || parts[4] || '').replace(/"/g, '').trim().toUpperCase();
    if (plz.match(/^\d{4}$/)) {
      result.push({ plz, name, kanton: kz });
    }
  }
  return result;
}

/**
 * Stufe 2: Für jede PLZ aus der offiziellen Liste, die noch nicht in
 * allSlugs ist, eine RealAdvisor-URL konstruieren und per HEAD-Request
 * prüfen ob sie existiert.
 *
 * Wir testen in Batches mit je 10 parallelen Requests.
 */
async function validatePlzUrls(plzListe, allSlugs) {
  const BATCH = 5;  // parallele Requests (schonend)
  const zusaetzlich = [];
  const zutesten = plzListe.filter(p => {
    // Überspringe PLZ die bereits via Kantonsseite gefunden wurden
    if (!p.plz) return false;
    // Prüfe ob wir schon einen Slug mit dieser PLZ haben
    return ![...allSlugs].some(s => s.startsWith(p.plz + '-'));
  });

  console.log(`\n   ${zutesten.length} PLZ zu validieren (in Batches von ${BATCH})...`);

  let checked = 0;
  let found   = 0;

  for (let i = 0; i < zutesten.length; i += BATCH) {
    const batch = zutesten.slice(i, i + BATCH);

    const results = await Promise.all(batch.map(async (p) => {
      // URL-Kandidaten: "{plz}-{name-slug}" und "{plz}-{name-slug}" Variationen
      const candidates = [];
      if (p.name) {
        candidates.push(`${p.plz}-${nameToSlug(p.name)}`);
      }
      // Generischer Fallback: nur PLZ (RealAdvisor akzeptiert auch das manchmal)
      candidates.push(p.plz);

      for (const slug of candidates) {
        const url = `https://realadvisor.ch/de/immobilienpreise-pro-m2/${slug}`;
        try {
          const { status } = await fetchPage(url, 'HEAD');
          if (status === 200) {
            return { slug, plz: p.plz, name: p.name, kanton: p.kanton, url };
          }
        } catch {}
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
    if (checked % 100 === 0 || i + BATCH >= zutesten.length) {
      process.stdout.write(`\r   ${checked}/${zutesten.length} geprüft, ${found} neu gefunden`);
    }

    await sleep(300); // kurze Pause zwischen Batches
  }
  console.log(); // Zeilenumbruch
  return zusaetzlich;
}

// ── Hauptlogik ────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  IMMOSKOP Scraper 1/4 – Slug-Harvester           ║');
  console.log('║  Stufe 1: Kantonsseiten (Top-75 pro Kanton)      ║');
  console.log('║  Stufe 2: PLZ-Validierung (alle restlichen)      ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const allSlugs  = new Set();
  const gemeinden = [];
  const stats     = {};
  const errors    = [];

  // ── Stufe 1: Kantonsseiten ────────────────────────────────────────────────
  console.log('── Stufe 1: Kantonsseiten ───────────────────────────\n');

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
      console.log(`✓  ${found.length} Gemeinden`);
    } catch (err) {
      console.log(`❌  ${err.message}`);
      errors.push({ kz, error: err.message });
      stats[kz] = { name, error: err.message };
    }

    if (i < KANTONE.length - 1) await sleep(DELAY_MS);
  }

  const nachStufe1 = gemeinden.length;
  console.log(`\n   → ${nachStufe1} Gemeinden nach Stufe 1\n`);

  // ── Stufe 2: PLZ-Validierung ──────────────────────────────────────────────
  console.log('── Stufe 2: PLZ-Validierung ─────────────────────────\n');

  const plzListe     = await fetchPlzListe();
  const zusaetzlich  = await validatePlzUrls(plzListe, allSlugs);
  gemeinden.push(...zusaetzlich);

  console.log(`   → ${zusaetzlich.length} zusätzliche Gemeinden via PLZ-Validierung\n`);

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
  console.log(`║    ${String(zusaetzlich.length).padEnd(4)} aus PLZ-Validierung                    ║`);
  if (errors.length) console.log(`║  ⚠  ${errors.length} Kantone mit Fehler                        ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Nächster Schritt:  node 2_scrape_plz.js         ║');
  console.log('╚══════════════════════════════════════════════════╝');
}

main().catch(e => { console.error('Fataler Fehler:', e); process.exit(1); });
