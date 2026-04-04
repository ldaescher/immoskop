/**
 * IMMOSKOP – 1b_find_missing.js
 * ================================
 * Einmaliges Analyse-Skript: Lädt alle ~2100 Schweizer Gemeinden
 * von der OpenPLZ API, konstruiert RealAdvisor-Slugs aus den Namen,
 * dedupliziert gegen die bekannten 1241 Slugs und gibt aus,
 * welche Gemeinden noch fehlen.
 *
 * Output: data/missing_communes.json  ← zur manuellen Prüfung
 *         data/slugs_extended.json    ← erweiterte Slug-Liste (falls Treffer)
 *
 * Ausführen: node 1b_find_missing.js
 * Dauer:     ~5 Minuten (API-Calls + Validierung nur der wirklich neuen)
 */

'use strict';
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const DATA_DIR      = path.join(__dirname, 'data');
const SLUGS_FILE    = path.join(DATA_DIR, 'slugs.json');
const MISSING_FILE  = path.join(DATA_DIR, 'missing_communes.json');

const DELAY_MS     = 200;
const BATCH        = 5;   // parallele HEAD-Requests

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'immoskop/1b' },
      timeout: 15000,
    }, res => {
      // Paging-Headers auslesen
      const totalPages = parseInt(res.headers['x-total-pages'] || '1');
      const totalCount = parseInt(res.headers['x-total-count'] || '0');
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body), totalPages, totalCount });
        } catch {
          resolve({ status: res.statusCode, data: [], totalPages, totalCount });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function headRequest(url) {
  return new Promise(resolve => {
    const req = https.request(url, {
      method: 'HEAD', timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    }, res => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        // Bei Redirect: finale URL prüfen ob sie sich vom Input unterscheidet
        return resolve({ status: res.statusCode, location: res.headers.location });
      }
      resolve({ status: res.statusCode, location: null });
    });
    req.on('error', () => resolve({ status: 0, location: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, location: null }); });
    req.end();
  });
}

/**
 * Konvertiert Gemeindenamen → RealAdvisor URL-Slug.
 * Mehrere Varianten generieren weil RealAdvisor-Slugs nicht immer
 * exakt dem Namen entsprechen.
 */
function nameToSlugs(name, plz, kz) {
  const base = name
    .toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .replace(/è|é|ê|ë/g, 'e').replace(/à|â|á/g, 'a').replace(/î|ï|í/g, 'i')
    .replace(/ô|ó/g, 'o').replace(/ù|û|ú/g, 'u').replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  const candidates = [];

  // Mit PLZ-Prefix (häufigste Form bei kleineren Gemeinden)
  if (plz) candidates.push(`${plz}-${base}`);

  // Mit Kanton-Suffix (z.B. "gemeinde-aesch-zh")
  candidates.push(`gemeinde-${base}`);
  if (kz) candidates.push(`gemeinde-${base}-${kz.toLowerCase()}`);

  // Ohne Prefix
  candidates.push(`stadt-${base}`);
  candidates.push(base);

  return [...new Set(candidates)]; // Duplikate entfernen
}

// ── Schritt 1: Alle Gemeinden von OpenPLZ laden ───────────────────────────────

const KANTONE_NR = [
  { kz: 'ZH', nr: 1 }, { kz: 'BE', nr: 2 }, { kz: 'LU', nr: 3 },
  { kz: 'UR', nr: 4 }, { kz: 'SZ', nr: 5 }, { kz: 'OW', nr: 6 },
  { kz: 'NW', nr: 7 }, { kz: 'GL', nr: 8 }, { kz: 'ZG', nr: 9 },
  { kz: 'FR', nr: 10 }, { kz: 'SO', nr: 11 }, { kz: 'BS', nr: 12 },
  { kz: 'BL', nr: 13 }, { kz: 'SH', nr: 14 }, { kz: 'AR', nr: 15 },
  { kz: 'AI', nr: 16 }, { kz: 'SG', nr: 17 }, { kz: 'GR', nr: 18 },
  { kz: 'AG', nr: 19 }, { kz: 'TG', nr: 20 }, { kz: 'TI', nr: 21 },
  { kz: 'VD', nr: 22 }, { kz: 'VS', nr: 23 }, { kz: 'NE', nr: 24 },
  { kz: 'GE', nr: 25 }, { kz: 'JU', nr: 26 },
];

async function loadAllCommunes() {
  const all = [];
  console.log('── Schritt 1: Alle Gemeinden von OpenPLZ API laden ──\n');

  for (const { kz, nr } of KANTONE_NR) {
    process.stdout.write(`   ${kz} ... `);
    let page = 1;
    let kantonsTotal = 0;

    while (true) {
      try {
        const url = `https://openplzapi.org/ch/Cantons/${nr}/Communes?page=${page}&pageSize=50`;
        const { status, data, totalPages } = await fetchJson(url);

        if (status !== 200 || !Array.isArray(data) || data.length === 0) break;

        for (const c of data) {
          // Communes-Endpunkt gibt: key, name, shortName, canton, ...
          // Localities-Endpunkt gibt zusätzlich postalCode
          all.push({
            name:   c.name || c.shortName || '',
            plz:    c.postalCode || null,
            kanton: kz,
          });
          kantonsTotal++;
        }

        if (page >= totalPages || data.length < 50) break;
        page++;
        await sleep(100);
      } catch (err) {
        console.log(`Fehler: ${err.message}`);
        break;
      }
    }

    console.log(`${kantonsTotal} Gemeinden`);
    await sleep(DELAY_MS);
  }

  // Falls Communes keinen postalCode hat: Localities-Endpunkt nutzen
  const ohnePlz = all.filter(c => !c.plz);
  if (ohnePlz.length > all.length * 0.5) {
    console.log('\n   Communes hat keine PLZ → lade Localities für PLZ-Zuordnung...');
    await enrichWithLocalities(all);
  }

  return all;
}

async function enrichWithLocalities(communes) {
  // Für jede Gemeinde ohne PLZ: Localities-Endpunkt abfragen
  for (const c of communes) {
    if (c.plz) continue;
    try {
      const url = `https://openplzapi.org/ch/Localities?name=${encodeURIComponent(c.name)}&page=1&pageSize=3`;
      const { data } = await fetchJson(url);
      if (Array.isArray(data) && data.length > 0) {
        c.plz = data[0].postalCode || null;
      }
    } catch {}
    await sleep(50);
  }
}

// ── Schritt 2: Deduplizieren und fehlende finden ──────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  IMMOSKOP – 1b_find_missing.js                   ║');
  console.log('║  Fehlende Gemeinden via OpenPLZ API finden       ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (!fs.existsSync(SLUGS_FILE)) {
    console.error('❌ data/slugs.json fehlt → zuerst node 1_harvest_slugs.js');
    process.exit(1);
  }

  // Bekannte Slugs laden
  const slugsData   = JSON.parse(fs.readFileSync(SLUGS_FILE, 'utf8'));
  const knownSlugs  = new Set(slugsData.gemeinden.map(g => g.slug));
  const knownPlz    = new Set(slugsData.gemeinden.map(g => g.plz).filter(Boolean));
  console.log(`   Bekannte Slugs: ${knownSlugs.size}\n`);

  // Alle Gemeinden von OpenPLZ
  const allCommunes = await loadAllCommunes();
  console.log(`\n   Total von OpenPLZ: ${allCommunes.length} Einträge\n`);

  // ── Schritt 2: Fehlende identifizieren ───────────────────────────────────
  console.log('── Schritt 2: Fehlende identifizieren ───────────────\n');

  const fehlend = [];
  for (const c of allCommunes) {
    if (!c.name) continue;

    // Schon via PLZ bekannt?
    if (c.plz && knownPlz.has(c.plz)) continue;

    // Schon via Name-Slug bekannt? (grobe Prüfung)
    const baseSlug = c.name.toLowerCase()
      .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u')
      .replace(/è|é|ê|ë/g, 'e').replace(/à|â/g, 'a').replace(/î|ï/g, 'i')
      .replace(/ô/g, 'o').replace(/ù|û/g, 'u').replace(/ç/g, 'c')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    const bereitsGefunden = [...knownSlugs].some(s => s.includes(baseSlug));
    if (bereitsGefunden) continue;

    fehlend.push(c);
  }

  // Duplikate nach Name entfernen
  const seenNames = new Set();
  const fehlendUnique = fehlend.filter(c => {
    if (seenNames.has(c.name)) return false;
    seenNames.add(c.name);
    return true;
  });

  console.log(`   ${fehlendUnique.length} potenziell fehlende Gemeinden\n`);

  // ── Schritt 3: RealAdvisor-URLs validieren ────────────────────────────────
  console.log('── Schritt 3: RealAdvisor HEAD-Validierung ──────────\n');
  console.log('   (Nur Gemeinden testen die wirklich neu sind)\n');

  const gefunden   = [];
  const nichtGefunden = [];
  let checked = 0;

  for (let i = 0; i < fehlendUnique.length; i += BATCH) {
    const batch = fehlendUnique.slice(i, i + BATCH);

    const results = await Promise.all(batch.map(async c => {
      const slugCandidates = nameToSlugs(c.name, c.plz, c.kanton);

      for (const slug of slugCandidates) {
        const url = `https://realadvisor.ch/de/immobilienpreise-pro-m2/${slug}`;
        const { status, location } = await headRequest(url);

        // 200 = Seite existiert
        // Aber: RealAdvisor gibt auch 200 für nicht-existente Seiten (Next.js)
        // Wir prüfen zusätzlich ob kein Redirect auf eine Seite ohne Preisdaten erfolgt
        if (status === 200 && !location) {
          return { ...c, slug, url, status: 'gefunden' };
        }
        // Redirect kann auch auf eine gültige Seite zeigen
        if ((status === 301 || status === 302) && location &&
            location.includes('immobilienpreise-pro-m2') &&
            !location.endsWith('/immobilienpreise-pro-m2')) {
          const finalSlug = location.split('/immobilienpreise-pro-m2/')[1]?.split('?')[0];
          if (finalSlug && !knownSlugs.has(finalSlug)) {
            return { ...c, slug: finalSlug, url: location, status: 'redirect' };
          }
        }
      }
      return { ...c, slug: null, status: 'nicht_gefunden' };
    }));

    for (const r of results) {
      if (r.status === 'gefunden' || r.status === 'redirect') {
        gefunden.push(r);
      } else {
        nichtGefunden.push(r);
      }
    }

    checked += batch.length;
    process.stdout.write(`\r   ${checked}/${fehlendUnique.length} geprüft | ${gefunden.length} gefunden`);
    await sleep(DELAY_MS);
  }
  console.log('\n');

  // ── Output ────────────────────────────────────────────────────────────────
  const output = {
    analysiert_am: new Date().toISOString(),
    bekannte_slugs: knownSlugs.size,
    openplz_total: allCommunes.length,
    potenziell_fehlend: fehlendUnique.length,
    neu_gefunden: gefunden.length,
    nicht_gefunden: nichtGefunden.length,
    neu_gefundene_gemeinden: gefunden,
    nicht_gefundene_gemeinden: nichtGefunden.slice(0, 100), // erste 100 zur Ansicht
  };

  fs.writeFileSync(MISSING_FILE, JSON.stringify(output, null, 2), 'utf8');

  console.log('╔══════════════════════════════════════════════════╗');
  console.log(`║  Analyse abgeschlossen                            ║`);
  console.log(`║  Bekannte Slugs:        ${String(knownSlugs.size).padEnd(25)}║`);
  console.log(`║  Potenziell fehlend:    ${String(fehlendUnique.length).padEnd(25)}║`);
  console.log(`║  Neu gefunden:          ${String(gefunden.length).padEnd(25)}║`);
  console.log(`║  Nicht bei RealAdvisor: ${String(nichtGefunden.length).padEnd(25)}║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  → data/missing_communes.json                    ║');
  console.log('╚══════════════════════════════════════════════════╝');

  if (gefunden.length > 0) {
    console.log('\n   Tipp: Gefundene Gemeinden zu slugs.json hinzufügen:');
    console.log('   node -e "');
    console.log('     const s = require(\'./data/slugs.json\');');
    console.log('     const m = require(\'./data/missing_communes.json\');');
    console.log('     s.gemeinden.push(...m.neu_gefundene_gemeinden.map(g => ({');
    console.log('       slug: g.slug, name: g.name, plz: g.plz, kanton: g.kanton, url: g.url');
    console.log('     })));');
    console.log('     s.total = s.gemeinden.length;');
    console.log('     require(\'fs\').writeFileSync(\'data/slugs.json\', JSON.stringify(s, null, 2));');
    console.log('   "');
  }
}

main().catch(e => { console.error('Fataler Fehler:', e); process.exit(1); });
