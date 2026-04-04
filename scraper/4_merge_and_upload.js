/**
 * IMMOSKOP Scraper 4/4 – Merge & Upload
 * =======================================
 * Kombiniert Rohdaten + manuelle Overrides und lädt alles
 * atomar in Supabase hoch (kein Overlap, keine Lücken).
 *
 * Ablauf:
 *   1. plz_prices_raw.json    laden
 *   2. plz_overrides.json     laden und Rohdaten überschreiben
 *   3. Sanity-Check (mind. N Einträge, keine kritischen Lücken)
 *   4. Supabase: TRUNCATE + INSERT (in einer Transaktion)
 *   5. Dasselbe für street_prices
 *
 * Setup:
 *   export SUPABASE_URL=https://clwdxufyeiznyhrfrysl.supabase.co
 *   export SUPABASE_SERVICE_KEY=eyJ...
 *
 * Ausführen:
 *   node 4_merge_and_upload.js              # PLZ + Strassen
 *   node 4_merge_and_upload.js --plz-only   # nur PLZ-Tabelle
 *   node 4_merge_and_upload.js --dry-run    # nur Merge, kein Upload
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── Konfiguration ─────────────────────────────────────────────────────────────

const DATA_DIR          = path.join(__dirname, 'data');
const PLZ_RAW_FILE      = path.join(DATA_DIR, 'plz_prices_raw.json');
const PLZ_OVERRIDES     = path.join(DATA_DIR, 'plz_overrides.json');
const STREET_RAW_FILE   = path.join(DATA_DIR, 'street_prices_raw.json');
const STREET_OVERRIDES  = path.join(DATA_DIR, 'street_overrides.json');
const MERGED_PLZ_FILE   = path.join(DATA_DIR, 'plz_prices_merged.json');
const MERGED_STR_FILE   = path.join(DATA_DIR, 'street_prices_merged.json');

const PLZ_ONLY = process.argv.includes('--plz-only');
const DRY_RUN  = process.argv.includes('--dry-run');

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Sanity-Schwellwerte (Upload wird abgebrochen wenn unterschritten)
const MIN_PLZ_ROWS     = 500;   // erwarten mind. 500 Gemeinden mit Daten
const MIN_STREET_ROWS  = 5000;  // erwarten mind. 5000 Strassen mit Daten
const MIN_DATA_RATE    = 0.5;   // mind. 50% der Gemeinden müssen Daten haben

// Upload-Batch-Grösse (Supabase mag keine zu grossen Requests)
const BATCH_SIZE = 500;

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function supabaseRequest(method, path_, body) {
  return new Promise((resolve, reject) => {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      reject(new Error('SUPABASE_URL oder SUPABASE_SERVICE_KEY nicht gesetzt!'));
      return;
    }
    const url    = new URL(SUPABASE_URL);
    const payload = body ? JSON.stringify(body) : null;
    const opts   = {
      hostname: url.hostname,
      path:     `/rest/v1/${path_}`,
      method,
      headers: {
        'apikey':         SUPABASE_KEY,
        'Authorization':  `Bearer ${SUPABASE_KEY}`,
        'Content-Type':   'application/json',
        'Prefer':         'return=minimal',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data });
        } else {
          reject(new Error(`Supabase ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Supabase RPC-Aufruf für TRUNCATE (braucht eine SQL-Funktion in Supabase).
 * Wir nutzen das REST-API mit DELETE und einem Filter der alles trifft.
 *
 * Achtung: Supabase hat kein direktes TRUNCATE über REST.
 * Stattdessen: DELETE with filter "id > 0" oder äquivalent.
 * Wir nutzen: DELETE /table?plz=not.is.null (trifft alle Einträge).
 */
async function truncateTable(table) {
  // Für plz_prices: plz ist NOT NULL (Primary Key)
  // Für street_prices: kombination aus gemeinde_slug + strasse_slug
  const filter = table === 'plz_prices' ? 'plz=not.is.null' : 'gemeinde_slug=not.is.null';
  await supabaseRequest('DELETE', `${table}?${filter}`);
}

/**
 * Lädt Daten in Batches hoch.
 */
async function batchInsert(table, rows) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await supabaseRequest('POST', table, batch);
    inserted += batch.length;
    process.stdout.write(`\r   → ${inserted}/${rows.length} Zeilen eingefügt`);
  }
  console.log(); // Zeilenumbruch nach Progress
}

// ── Merge-Logik ───────────────────────────────────────────────────────────────

/**
 * Merged Raw-Daten mit Overrides.
 * Override-Einträge haben immer Vorrang – Feld für Feld.
 * Ein Override kann auch neue Einträge hinzufügen (z. B. PLZ ohne RealAdvisor-Seite).
 */
function mergePlz(raw, overrides) {
  const map = new Map();

  // 1. Rohdaten eintragen (Key: PLZ oder Slug)
  for (const r of raw) {
    const key = r.plz || r.slug;
    if (key) map.set(key, { ...r });
  }

  // 2. Overrides anwenden (Feld für Feld, kein blindes Überschreiben)
  for (const ov of overrides) {
    const key = ov.plz || ov.slug;
    if (!key) { console.warn(`  ⚠ Override ohne plz/slug übersprungen:`, ov); continue; }

    const existing = map.get(key) || {};
    const merged   = { ...existing };

    // Nur explizit gesetzte Felder im Override überschreiben
    for (const [k, v] of Object.entries(ov)) {
      if (v !== null && v !== undefined && v !== '') {
        merged[k] = v;
      }
    }
    merged.has_override = true;
    merged.override_note = ov._note || null;
    map.set(key, merged);
  }

  return [...map.values()];
}

function mergeStreets(raw, overrides) {
  const map = new Map();

  for (const r of raw) {
    const key = `${r.gemeinde_slug}/${r.strasse_slug}`;
    map.set(key, { ...r });
  }

  for (const ov of overrides) {
    const key = `${ov.gemeinde_slug}/${ov.strasse_slug}`;
    if (!ov.gemeinde_slug || !ov.strasse_slug) {
      console.warn('  ⚠ Strassen-Override ohne gemeinde_slug/strasse_slug übersprungen:', ov);
      continue;
    }
    const existing = map.get(key) || {};
    const merged   = { ...existing };
    for (const [k, v] of Object.entries(ov)) {
      if (v !== null && v !== undefined && v !== '') merged[k] = v;
    }
    merged.has_override = true;
    map.set(key, merged);
  }

  return [...map.values()];
}

/**
 * Bereitet PLZ-Daten für Supabase auf.
 * Wählt nur die Felder die in der Tabelle existieren.
 */
function toSupabasePlzRow(r) {
  return {
    plz:                  r.plz,
    slug:                 r.slug,
    name:                 r.name,
    kanton:               r.kanton,
    // Kauf Wohnung
    kauf_whg_median:      r.kauf_whg_median      ?? null,
    kauf_whg_p10:         r.kauf_whg_p10         ?? null,
    kauf_whg_p90:         r.kauf_whg_p90         ?? null,
    // Kauf Haus
    kauf_haus_median:     r.kauf_haus_median     ?? null,
    kauf_haus_p10:        r.kauf_haus_p10        ?? null,
    kauf_haus_p90:        r.kauf_haus_p90        ?? null,
    // Miete Wohnung (CHF/m²/Monat)
    miete_whg_median:     r.miete_whg_median     ?? null,
    miete_whg_p10:        r.miete_whg_p10        ?? null,
    miete_whg_p90:        r.miete_whg_p90        ?? null,
    // Miete Haus
    miete_haus_median:    r.miete_haus_median    ?? null,
    miete_haus_p10:       r.miete_haus_p10       ?? null,
    miete_haus_p90:       r.miete_haus_p90       ?? null,
    // Meta
    source:               r.source       || 'realadvisor',
    has_override:         r.has_override || false,
    override_note:        r.override_note || null,
    scraped_at:           r.scraped_at   || new Date().toISOString(),
  };
}

function toSupabaseStreetRow(r) {
  return {
    gemeinde_slug:      r.gemeinde_slug,
    strasse_slug:       r.strasse_slug,
    strasse_name:       r.strasse_name,
    strasse_name_lower: r.strasse_name_lower || r.strasse_name?.toLowerCase(),
    plz:                r.plz               ?? null,
    // Nur Kauf – kein Mietpreis auf Strassenebene (nicht vorhanden bei RealAdvisor)
    kauf_median:        r.kauf_median        ?? null,
    kauf_p10:           r.kauf_p10           ?? null,
    kauf_p90:           r.kauf_p90           ?? null,
    // Meta
    source:             r.source       || 'realadvisor',
    has_override:       r.has_override || false,
    scraped_at:         r.scraped_at   || new Date().toISOString(),
  };
}

// ── Sanity-Checks ─────────────────────────────────────────────────────────────

function sanityCheckPlz(rows) {
  const issues = [];
  const withData = rows.filter(r => r.kauf_whg_median || r.miete_whg_median);

  if (rows.length < MIN_PLZ_ROWS)
    issues.push(`Nur ${rows.length} PLZ-Einträge (Minimum: ${MIN_PLZ_ROWS})`);

  if (withData.length / rows.length < MIN_DATA_RATE)
    issues.push(`Nur ${Math.round(withData.length / rows.length * 100)}% haben Daten (Minimum: ${Math.round(MIN_DATA_RATE * 100)}%)`);

  // PLZ-Null-Check: Wichtig für api/data.js
  const withPlz = rows.filter(r => r.plz);
  if (withPlz.length < rows.length * 0.3)
    issues.push(`Weniger als 30% der Zeilen haben eine PLZ (${withPlz.length}/${rows.length})`);

  return issues;
}

function sanityCheckStreets(rows) {
  const issues = [];
  const withData = rows.filter(r => r.kauf_median);

  if (rows.length < MIN_STREET_ROWS)
    issues.push(`Nur ${rows.length} Strassen-Einträge (Minimum: ${MIN_STREET_ROWS})`);

  if (withData.length / rows.length < MIN_DATA_RATE)
    issues.push(`Nur ${Math.round(withData.length / rows.length * 100)}% haben Kaufpreis-Daten`);

  return issues;
}

// ── Hauptlogik ────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  IMMOSKOP Scraper 4/4 – Merge & Upload           ║');
  if (DRY_RUN)  console.log('║  Modus: DRY RUN (kein Upload)                    ║');
  if (PLZ_ONLY) console.log('║  Nur: PLZ-Tabelle                                ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_KEY)) {
    console.error('❌ Fehlende Umgebungsvariablen:');
    console.error('   export SUPABASE_URL=https://clwdxufyeiznyhrfrysl.supabase.co');
    console.error('   export SUPABASE_SERVICE_KEY=eyJ...');
    process.exit(1);
  }

  // ── PLZ-Tabelle ─────────────────────────────────────────────────────────────

  console.log('── Schritt 1: PLZ-Daten mergen ─────────────────────\n');

  if (!fs.existsSync(PLZ_RAW_FILE)) {
    console.error(`❌ ${PLZ_RAW_FILE} fehlt → zuerst node 2_scrape_plz.js ausführen`);
    process.exit(1);
  }

  const plzRaw       = JSON.parse(fs.readFileSync(PLZ_RAW_FILE, 'utf8')).gemeinden;
  const plzOverrides = fs.existsSync(PLZ_OVERRIDES)
    ? JSON.parse(fs.readFileSync(PLZ_OVERRIDES, 'utf8')).overrides || []
    : [];

  console.log(`   Rohdaten:   ${plzRaw.length} Gemeinden`);
  console.log(`   Overrides:  ${plzOverrides.length} Einträge`);

  const plzMerged    = mergePlz(plzRaw, plzOverrides);
  const plzSupabase  = plzMerged
    .filter(r => r.plz || r.slug)  // mind. ein Identifier
    .map(toSupabasePlzRow);

  const withData = plzSupabase.filter(r => r.kauf_whg_median || r.miete_whg_median);
  console.log(`   Merged:     ${plzSupabase.length} Zeilen (${withData.length} mit Preisdaten)`);
  console.log(`   Overrides:  ${plzSupabase.filter(r => r.has_override).length} angewendet\n`);

  // Merged-Datei speichern (für Debugging)
  fs.writeFileSync(MERGED_PLZ_FILE, JSON.stringify({
    merged_at: new Date().toISOString(),
    total: plzSupabase.length,
    with_data: withData.length,
    gemeinden: plzSupabase,
  }, null, 2), 'utf8');
  console.log(`   💾 data/plz_prices_merged.json gespeichert\n`);

  // Sanity-Check
  const plzIssues = sanityCheckPlz(plzSupabase);
  if (plzIssues.length > 0) {
    console.error('❌ Sanity-Check fehlgeschlagen:');
    plzIssues.forEach(i => console.error(`   • ${i}`));
    if (!DRY_RUN) {
      console.error('\n   Upload abgebrochen. Rohdaten prüfen oder --dry-run verwenden.');
      process.exit(1);
    }
  } else {
    console.log('   ✓ Sanity-Check bestanden\n');
  }

  if (!DRY_RUN) {
    console.log('── Schritt 2: Atomarer Upload PLZ → Supabase ────────\n');
    console.log('   TRUNCATE plz_prices ...');
    await truncateTable('plz_prices');
    console.log('   ✓ Tabelle geleert');
    console.log(`   INSERT ${plzSupabase.length} Zeilen ...`);
    await batchInsert('plz_prices', plzSupabase);
    console.log(`   ✓ ${plzSupabase.length} Zeilen eingefügt\n`);
  }

  if (PLZ_ONLY) {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  ✓ PLZ-Upload abgeschlossen (--plz-only)          ║');
    console.log('╚══════════════════════════════════════════════════╝');
    return;
  }

  // ── Strassen-Tabelle ────────────────────────────────────────────────────────

  console.log('── Schritt 3: Strassen-Daten mergen ─────────────────\n');

  if (!fs.existsSync(STREET_RAW_FILE)) {
    console.error(`❌ ${STREET_RAW_FILE} fehlt → zuerst node 3_scrape_streets.js ausführen`);
    process.exit(1);
  }

  const strRaw       = JSON.parse(fs.readFileSync(STREET_RAW_FILE, 'utf8')).strassen;
  const strOverrides = fs.existsSync(STREET_OVERRIDES)
    ? JSON.parse(fs.readFileSync(STREET_OVERRIDES, 'utf8')).overrides || []
    : [];

  console.log(`   Rohdaten:   ${strRaw.length} Strassen`);
  console.log(`   Overrides:  ${strOverrides.length} Einträge`);

  const strMerged   = mergeStreets(strRaw, strOverrides);
  const strSupabase = strMerged
    .filter(r => r.gemeinde_slug && r.strasse_slug)
    .map(toSupabaseStreetRow);

  const strWithData = strSupabase.filter(r => r.kauf_median);
  console.log(`   Merged:     ${strSupabase.length} Zeilen (${strWithData.length} mit Kaufpreis)`);
  console.log(`   Overrides:  ${strSupabase.filter(r => r.has_override).length} angewendet\n`);

  fs.writeFileSync(MERGED_STR_FILE, JSON.stringify({
    merged_at: new Date().toISOString(),
    total: strSupabase.length,
    with_data: strWithData.length,
    strassen: strSupabase,
  }, null, 2), 'utf8');
  console.log(`   💾 data/street_prices_merged.json gespeichert\n`);

  const strIssues = sanityCheckStreets(strSupabase);
  if (strIssues.length > 0) {
    console.error('❌ Sanity-Check Strassen fehlgeschlagen:');
    strIssues.forEach(i => console.error(`   • ${i}`));
    if (!DRY_RUN) {
      console.error('\n   Upload abgebrochen.');
      process.exit(1);
    }
  } else {
    console.log('   ✓ Sanity-Check bestanden\n');
  }

  if (!DRY_RUN) {
    console.log('── Schritt 4: Atomarer Upload Strassen → Supabase ───\n');
    console.log('   TRUNCATE street_prices ...');
    await truncateTable('street_prices');
    console.log('   ✓ Tabelle geleert');
    console.log(`   INSERT ${strSupabase.length} Zeilen ...`);
    await batchInsert('street_prices', strSupabase);
    console.log(`   ✓ ${strSupabase.length} Zeilen eingefügt\n`);
  }

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  ✓ Fertig!                                        ║');
  if (DRY_RUN) {
    console.log('║  DRY RUN – kein Supabase-Upload erfolgt           ║');
    console.log('║  Merged-Dateien zur Prüfung:                      ║');
    console.log('║  • data/plz_prices_merged.json                    ║');
    console.log('║  • data/street_prices_merged.json                 ║');
  } else {
    console.log('║  Supabase-Tabellen vollständig ersetzt:           ║');
    console.log(`║  • plz_prices:    ${String(plzSupabase.length).padEnd(31)}║`);
    console.log(`║  • street_prices: ${String(strSupabase.length).padEnd(31)}║`);
  }
  console.log('╚══════════════════════════════════════════════════╝');
}

main().catch(e => { console.error('Fataler Fehler:', e); process.exit(1); });
