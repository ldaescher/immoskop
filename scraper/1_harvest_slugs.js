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

// ── PLZ-Ergänzung ─────────────────────────────────────────────────────────────

/**
 * RealAdvisor zeigt pro Kantonsseite max. 75 Gemeinden (nach Einwohnerzahl).
 * Für alle weiteren Gemeinden bauen wir PLZ-basierte URLs und prüfen ob
 * eine Seite existiert: /de/immobilienpreise-pro-m2/{plz}-{name-slug}
 *
 * Wir nutzen die offizielle Schweizer PLZ-Liste (Post) als Basis.
 * Da wir sie nicht laden können, generieren wir alle PLZ 1000–9999
 * und prüfen einen HEAD-Request – aber das wären 9000 Requests.
 *
 * Besserer Ansatz: RealAdvisor hat eine Sitemap. Wir lesen sie aus.
 */
async function fetchAdditionalFromSitemap(allSlugs) {
  const zusaetzlich = [];
  console.log('\n── Schritt 2: Sitemap nach fehlenden Gemeinden durchsuchen ──\n');

  // RealAdvisor Sitemap für Preisseiten
  const sitemapUrls = [
    'https://realadvisor.ch/sitemap-price-de.xml',
    'https://realadvisor.ch/sitemap_index.xml',
    'https://realadvisor.ch/sitemap.xml',
  ];

  for (const sitemapUrl of sitemapUrls) {
    process.stdout.write(`   Versuche ${sitemapUrl} ... `);
    try {
      const { status, body } = await fetchPage(sitemapUrl);
      if (status !== 200) { console.log(`HTTP ${status}`); continue; }

      // Alle /de/immobilienpreise-pro-m2/{slug} URLs aus Sitemap extrahieren
      const re = /https:\/\/realadvisor\.ch\/de\/immobilienpreise-pro-m2\/([^<\s/"]+)/g;
      let m;
      let gefunden = 0;
      while ((m = re.exec(body)) !== null) {
        const slug = m[1].trim();
        if (slug.startsWith('kanton-') || slug === '') continue;
        // Keine Strassen-Slugs (enthalten /)
        if (slug.includes('/')) continue;
        if (allSlugs.has(slug)) continue;

        allSlugs.add(slug);
        const plzMatch = slug.match(/^(\d{4})-/);
        // Kanton aus PLZ schätzen (grob)
        const plz = plzMatch ? plzMatch[1] : null;
        zusaetzlich.push({
          slug,
          name: slug.replace(/^\d{4}-/, '').replace(/-/g, ' '),
          plz,
          kanton: plz ? kantFromPlz(plz) : 'XX',
          url: `https://realadvisor.ch/de/immobilienpreise-pro-m2/${slug}`,
          source: 'sitemap',
        });
        gefunden++;
      }
      console.log(`✓  ${gefunden} neue Slugs`);
      if (gefunden > 0) break; // Sitemap gefunden und ausgelesen
    } catch (err) {
      console.log(`❌  ${err.message}`);
    }
    await sleep(500);
  }

  return zusaetzlich;
}

/**
 * Grobe Kanton-Zuordnung aus PLZ-Prefix.
 * Nicht perfekt, aber ausreichend als Metadaten.
 */
function kantFromPlz(plz) {
  const p = parseInt(plz);
  if (p >= 1000 && p <= 1999) return 'VD/GE/NE';
  if (p >= 2000 && p <= 2999) return 'NE/BE/JU';
  if (p >= 3000 && p <= 3999) return 'BE/VS';
  if (p >= 4000 && p <= 4999) return 'BS/BL/SO/AG';
  if (p >= 5000 && p <= 5999) return 'AG';
  if (p >= 6000 && p <= 6999) return 'LU/NW/OW/UR/ZG/TI';
  if (p >= 7000 && p <= 7999) return 'GR';
  if (p >= 8000 && p <= 8999) return 'ZH/SH/TG/SG/GL';
  if (p >= 9000 && p <= 9999) return 'SG/AR/AI/TG';
  return 'XX';
}

// ── Hauptlogik ────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  IMMOSKOP Scraper 1/4 – Slug-Harvester           ║');
  console.log('║  Schritt 1: Kantonsseiten (Top 75 pro Kanton)    ║');
  console.log('║  Schritt 2: Sitemap (alle restlichen Gemeinden)  ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const allSlugs  = new Set();
  const gemeinden = [];
  const stats     = {};
  const errors    = [];

  // ── Schritt 1: Kantonsseiten ──
  console.log('── Schritt 1: Kantonsseiten ─────────────────────────\n');
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

  // ── Schritt 2: Sitemap ──
  const sitemapGemeinden = await fetchAdditionalFromSitemap(allSlugs);
  gemeinden.push(...sitemapGemeinden);

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
    _info: 'Output von 1_harvest_slugs.js – auf GitHub committen!',
    harvested_at: new Date().toISOString(),
    total: gemeinden.length,
    from_kantonsseiten: gemeinden.length - sitemapGemeinden.length,
    from_sitemap: sitemapGemeinden.length,
    kantone: stats,
    gemeinden,
  }, null, 2), 'utf8');

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(`║  ✓ ${String(gemeinden.length).padEnd(4)} Gemeinden → data/slugs.json            ║`);
  console.log(`║    davon ${String(gemeinden.length - sitemapGemeinden.length).padEnd(4)} aus Kantonsseiten                  ║`);
  console.log(`║    davon ${String(sitemapGemeinden.length).padEnd(4)} aus Sitemap                       ║`);
  if (errors.length) console.log(`║  ⚠  ${errors.length} Kantone mit Fehler                        ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Nächster Schritt:  node 2_scrape_plz.js         ║');
  console.log('╚══════════════════════════════════════════════════╝');
}

main().catch(e => { console.error('Fataler Fehler:', e); process.exit(1); });
