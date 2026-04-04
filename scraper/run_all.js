/**
 * IMMOSKOP – run_all.js (Master-Scraper)
 * ========================================
 * Führt alle Scraper-Schritte in der richtigen Reihenfolge aus.
 * Verwendet die bewährten Einzelskripte als Module.
 *
 * Ablauf:
 *   1. 1_harvest_slugs.js   → data/slugs.json (Kantonsseiten)
 *   2. 1b_find_missing.js   → data/missing_communes.json (OpenPLZ-Ergänzung)
 *   3. Merge missing → slugs.json (~2109 Gemeinden)
 *   4. 2_scrape_plz.js      → data/plz_prices_raw.json + street_prices_raw.json
 *   5. 4_merge_and_upload.js → Supabase (atomar)
 *
 * Hinweis: Skript 3 (3_scrape_streets.js) ist obsolet –
 * Skript 2 scrapt Gemeinden UND Strassen in einem RSC-Request.
 *
 * Setup:
 *   export SUPABASE_URL=https://clwdxufyeiznyhrfrysl.supabase.co
 *   export SUPABASE_SERVICE_KEY=eyJ...
 *
 * Ausführen:
 *   node run_all.js                # Vollständiger Lauf
 *   node run_all.js --skip-harvest # Slugs nicht neu harvesten (slugs.json vorhanden)
 *   node run_all.js --skip-scrape  # Scraping überspringen (Rohdaten vorhanden)
 *   node run_all.js --dry-run      # Alles ausser Supabase-Upload
 *
 * Dauer: ~2 Stunden total
 *   Schritt 1+2+3: ~15 Min
 *   Schritt 4:     ~90 Min
 *   Schritt 5:     ~5 Min
 */

'use strict';
const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

const DATA_DIR    = path.join(__dirname, 'data');
const SLUGS_FILE  = path.join(DATA_DIR, 'slugs.json');
const MISSING_FILE = path.join(DATA_DIR, 'missing_communes.json');

const SKIP_HARVEST = process.argv.includes('--skip-harvest');
const SKIP_SCRAPE  = process.argv.includes('--skip-scrape');
const DRY_RUN      = process.argv.includes('--dry-run');

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] ${msg}`);
}

function runScript(script, args = []) {
  return new Promise((resolve, reject) => {
    log(`Starte: node ${script} ${args.join(' ')}`);
    const child = spawn('node', [script, ...args], {
      cwd: __dirname,
      stdio: 'inherit', // Output direkt durchleiten
    });
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${script} beendet mit Code ${code}`));
    });
    child.on('error', reject);
  });
}

// ── Schritt 3: Missing Communes mergen ────────────────────────────────────────

function mergeMissingIntoSlugs() {
  if (!fs.existsSync(MISSING_FILE)) {
    log('⚠ missing_communes.json nicht gefunden – überspringe Merge');
    return;
  }

  const slugsData  = JSON.parse(fs.readFileSync(SLUGS_FILE, 'utf8'));
  const missingData = JSON.parse(fs.readFileSync(MISSING_FILE, 'utf8'));
  const neuGefunden = missingData.neu_gefundene_gemeinden || [];

  if (neuGefunden.length === 0) {
    log('ℹ Keine neuen Gemeinden zum Mergen');
    return;
  }

  const vorher = slugsData.gemeinden.length;
  slugsData.gemeinden.push(...neuGefunden.map(g => ({
    slug: g.slug, name: g.name, plz: g.plz, kanton: g.kanton, url: g.url
  })));
  slugsData.total = slugsData.gemeinden.length;
  slugsData.von_plz_validierung = neuGefunden.length;

  fs.writeFileSync(SLUGS_FILE, JSON.stringify(slugsData, null, 2), 'utf8');
  log(`✓ Merge: ${vorher} + ${neuGefunden.length} = ${slugsData.total} Gemeinden`);
}

// ── Hauptlogik ────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  IMMOSKOP Master-Scraper – run_all.js                ║');
  console.log('║  Vollständiger Scrape + Supabase-Upload              ║');
  if (SKIP_HARVEST) console.log('║  --skip-harvest: Slug-Harvesting übersprungen        ║');
  if (SKIP_SCRAPE)  console.log('║  --skip-scrape:  Scraping übersprungen               ║');
  if (DRY_RUN)      console.log('║  --dry-run:      Kein Supabase-Upload                ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  if (!DRY_RUN && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)) {
    console.error('❌ Fehlende Umgebungsvariablen:');
    console.error('   export SUPABASE_URL=https://clwdxufyeiznyhrfrysl.supabase.co');
    console.error('   export SUPABASE_SERVICE_KEY=eyJ...');
    process.exit(1);
  }

  const startTs = Date.now();

  try {
    // ── Schritt 1: Kantonsseiten harvesten ─────────────────────────────────
    if (!SKIP_HARVEST) {
      log('══ Schritt 1/5: Kantonsseiten harvesten ══');
      await runScript('1_harvest_slugs.js');
      log('✓ Schritt 1 abgeschlossen\n');
    } else {
      log('⏭ Schritt 1 übersprungen (--skip-harvest)\n');
    }

    // ── Schritt 2: Fehlende Gemeinden via OpenPLZ finden ───────────────────
    if (!SKIP_HARVEST) {
      log('══ Schritt 2/5: Fehlende Gemeinden (OpenPLZ) ══');
      await runScript('1b_find_missing.js');
      log('✓ Schritt 2 abgeschlossen\n');
    } else {
      log('⏭ Schritt 2 übersprungen (--skip-harvest)\n');
    }

    // ── Schritt 3: Missing Communes in slugs.json mergen ───────────────────
    if (!SKIP_HARVEST) {
      log('══ Schritt 3/5: Missing Communes mergen ══');
      mergeMissingIntoSlugs();
      log('✓ Schritt 3 abgeschlossen\n');
    } else {
      log('⏭ Schritt 3 übersprungen (--skip-harvest)\n');
    }

    // ── Schritt 4: PLZ + Strassen scrapen ──────────────────────────────────
    if (!SKIP_SCRAPE) {
      log('══ Schritt 4/5: PLZ + Strassen scrapen (~90 Min) ══');
      await runScript('2_scrape_plz.js');
      log('✓ Schritt 4 abgeschlossen\n');
    } else {
      log('⏭ Schritt 4 übersprungen (--skip-scrape)\n');
    }

    // ── Schritt 5: Merge + Supabase-Upload ─────────────────────────────────
    log('══ Schritt 5/5: Merge + Supabase-Upload ══');
    const uploadArgs = DRY_RUN ? ['--dry-run'] : [];
    await runScript('4_merge_and_upload.js', uploadArgs);
    log('✓ Schritt 5 abgeschlossen\n');

    // ── Abschluss ───────────────────────────────────────────────────────────
    const elapsed = Math.round((Date.now() - startTs) / 60000);
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║  ✓ Master-Scraper abgeschlossen!                     ║');
    console.log(`║  Gesamtdauer: ${String(elapsed + ' Minuten').padEnd(38)}║`);
    if (DRY_RUN) {
      console.log('║  DRY RUN – kein Supabase-Upload erfolgt              ║');
    } else {
      console.log('║  Supabase wurde vollständig aktualisiert             ║');
    }
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log('║  Nächster Schritt:                                    ║');
    console.log('║  slugs.json auf GitHub committen:                    ║');
    console.log('║  git add data/slugs.json                             ║');
    console.log('║  git commit -m "Update slugs.json"                   ║');
    console.log('║  git push                                            ║');
    console.log('╚══════════════════════════════════════════════════════╝');

  } catch (err) {
    console.error(`\n❌ Fehler in Master-Scraper: ${err.message}`);
    console.error('   Tipp: Einzelnen Schritt mit --resume neu starten');
    console.error('   z.B.: node 2_scrape_plz.js --resume');
    process.exit(1);
  }
}

main();
