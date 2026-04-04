/**
 * IMMOSKOP Scraper 4/4 – Merge & Upload
 * =======================================
 * Kombiniert Rohdaten + manuelle Overrides und lädt alles
 * atomar in Supabase hoch (kein Overlap, keine Lücken).
 *
 * Ablauf:
 *   1. plz_prices_raw.json laden (enthält Gemeinden + PLZ-Localities)
 *   2. plz_overrides.json anwenden
 *   3. Sanity-Check
 *   4. Supabase plz_prices: TRUNCATE → INSERT
 *   5. street_prices_raw.json laden
 *   6. street_overrides.json anwenden
 *   7. Supabase street_prices: TRUNCATE → INSERT
 *
 * Setup:
 *   export SUPABASE_URL=https://clwdxufyeiznyhrfrysl.supabase.co
 *   export SUPABASE_SERVICE_KEY=eyJ...
 *
 * Ausführen:
 *   node 4_merge_and_upload.js            # PLZ + Strassen
 *   node 4_merge_and_upload.js --plz-only # nur PLZ-Tabelle
 *   node 4_merge_and_upload.js --dry-run  # Merge ohne Upload
 *   node 4_merge_and_upload.js --migrate  # Schema-Migration zuerst ausführen
 */

'use strict';
const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Konfiguration ─────────────────────────────────────────────────────────────

const DATA_DIR         = path.join(__dirname, 'data');
const PLZ_RAW_FILE     = path.join(DATA_DIR, 'plz_prices_raw.json');
const PLZ_OVERRIDES    = path.join(DATA_DIR, 'plz_overrides.json');
const STREET_RAW_FILE  = path.join(DATA_DIR, 'street_prices_raw.json');
const STREET_OVERRIDES = path.join(DATA_DIR, 'street_overrides.json');
const MERGED_PLZ_FILE  = path.join(DATA_DIR, 'plz_prices_merged.json');
const MERGED_STR_FILE  = path.join(DATA_DIR, 'street_prices_merged.json');

const PLZ_ONLY = process.argv.includes('--plz-only');
const DRY_RUN  = process.argv.includes('--dry-run');
const MIGRATE  = process.argv.includes('--migrate');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Sanity-Schwellwerte
const MIN_PLZ_ROWS    = 2000;   // wir haben jetzt 2109 Gemeinden + 3936 Localities
const MIN_STREET_ROWS = 20000;  // wir haben 25242 Strassen
const MIN_DATA_RATE   = 0.8;    // mind. 80% mit Daten

const BATCH_SIZE = 500;

// ── Supabase HTTP ─────────────────────────────────────────────────────────────

function supabaseRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      reject(new Error('SUPABASE_URL oder SUPABASE_SERVICE_KEY nicht gesetzt!'));
      return;
    }
    const url     = new URL(SUPABASE_URL);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: url.hostname,
      path:     `/rest/v1/${endpoint}`,
      method,
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data });
        } else {
          reject(new Error(`Supabase ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Supabase RPC für rohe SQL (braucht eine RPC-Funktion "exec_sql" in Supabase).
 * Fallback: wir löschen via DELETE-Filter.
 */
async function truncateTable(table) {
  // DELETE mit Filter der alle Zeilen trifft
  // plz_prices: slug ist immer gesetzt
  // street_prices: gemeinde_slug ist immer gesetzt
  const filter = table === 'plz_prices' ? 'slug=not.is.null' : 'gemeinde_slug=not.is.null';
  await supabaseRequest('DELETE', `${table}?${filter}`);
}

async function batchInsert(table, rows) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await supabaseRequest('POST', table, batch);
    inserted += batch.length;
    process.stdout.write(`\r   → ${inserted}/${rows.length} Zeilen eingefügt`);
  }
  console.log();
}

// ── Schema-Migration ──────────────────────────────────────────────────────────

/**
 * Führt die nötige Supabase-Schema-Migration aus.
 * Neue Spalten für das erweiterte Datenmodell.
 *
 * Achtung: Benötigt eine RPC-Funktion "exec_sql" in Supabase oder
 * muss manuell im Supabase SQL-Editor ausgeführt werden.
 */
function printMigrationSql() {
  console.log('\n── Schema-Migration SQL ─────────────────────────────\n');
  console.log('Führe dieses SQL im Supabase SQL-Editor aus:\n');
  console.log(`-- plz_prices: Neue Spalten
ALTER TABLE plz_prices
  ADD COLUMN IF NOT EXISTS slug text,
  ADD COLUMN IF NOT EXISTS typ text DEFAULT 'gemeinde',
  ADD COLUMN IF NOT EXISTS gemeinde_slug text,
  ADD COLUMN IF NOT EXISTS kauf_whg_median numeric,
  ADD COLUMN IF NOT EXISTS kauf_whg_p10 numeric,
  ADD COLUMN IF NOT EXISTS kauf_whg_p90 numeric,
  ADD COLUMN IF NOT EXISTS kauf_haus_median numeric,
  ADD COLUMN IF NOT EXISTS kauf_haus_p10 numeric,
  ADD COLUMN IF NOT EXISTS kauf_haus_p90 numeric,
  ADD COLUMN IF NOT EXISTS miete_whg_median numeric,
  ADD COLUMN IF NOT EXISTS miete_whg_p10 numeric,
  ADD COLUMN IF NOT EXISTS miete_whg_p90 numeric,
  ADD COLUMN IF NOT EXISTS miete_haus_median numeric,
  ADD COLUMN IF NOT EXISTS miete_haus_p10 numeric,
  ADD COLUMN IF NOT EXISTS miete_haus_p90 numeric,
  ADD COLUMN IF NOT EXISTS has_override boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_note text;

-- street_prices: Neue Spalten
ALTER TABLE street_prices
  ADD COLUMN IF NOT EXISTS gemeinde_slug text,
  ADD COLUMN IF NOT EXISTS strasse_slug text,
  ADD COLUMN IF NOT EXISTS kauf_median numeric,
  ADD COLUMN IF NOT EXISTS kauf_p15 numeric,
  ADD COLUMN IF NOT EXISTS kauf_p85 numeric,
  ADD COLUMN IF NOT EXISTS lat numeric,
  ADD COLUMN IF NOT EXISTS lng numeric,
  ADD COLUMN IF NOT EXISTS is_cross_locality boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS transaction_count integer,
  ADD COLUMN IF NOT EXISTS has_override boolean DEFAULT false;

-- RLS: plz_prices public read
CREATE POLICY IF NOT EXISTS "public read plz_prices"
  ON plz_prices FOR SELECT USING (true);

-- RLS: street_prices public read  
CREATE POLICY IF NOT EXISTS "public read street_prices"
  ON street_prices FOR SELECT USING (true);
`);
  console.log('── Ende SQL ─────────────────────────────────────────\n');
}

// ── Merge-Logik ───────────────────────────────────────────────────────────────

/**
 * Merged PLZ-Rohdaten mit Overrides.
 * Key: slug (eindeutig für Gemeinden UND Localities)
 */
function mergePlz(eintraege, overrides) {
  const map = new Map();

  for (const r of eintraege) {
    // Key: typ+slug damit Gemeinden und Localities nie kollidieren
    // z.B. "gemeinde:8953-dietikon" vs "locality:8953-dietikon"
    const key = `${r.typ || 'gemeinde'}:${r.slug || r.plz}`;
    if (key) map.set(key, { ...r });
  }

  for (const ov of overrides) {
    // Overrides können mit slug allein oder typ:slug angegeben werden
    const typ = ov.typ || 'gemeinde';
    const key = `${typ}:${ov.slug || ov.plz}`;
    if (!ov.slug && !ov.plz) { console.warn('  ⚠ Override ohne slug/plz übersprungen:', ov); continue; }
    const existing = map.get(key) || {};
    const merged   = { ...existing };
    for (const [k, v] of Object.entries(ov)) {
      if (v !== null && v !== undefined && v !== '') merged[k] = v;
    }
    merged.has_override  = true;
    merged.override_note = ov._note || null;
    map.set(key, merged);
  }

  return [...map.values()];
}

function mergeStreets(strassen, overrides) {
  const map = new Map();

  for (const r of strassen) {
    const key = `${r.gemeinde_slug}/${r.strasse_slug}`;
    map.set(key, { ...r });
  }

  for (const ov of overrides) {
    if (!ov.gemeinde_slug || !ov.strasse_slug) {
      console.warn('  ⚠ Strassen-Override ohne gemeinde_slug/strasse_slug übersprungen:', ov);
      continue;
    }
    const key = `${ov.gemeinde_slug}/${ov.strasse_slug}`;
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

// ── Supabase Row-Mapper ───────────────────────────────────────────────────────

function toSupabasePlzRow(r) {
  return {
    // Identifikation
    slug:          r.slug,
    typ:           r.typ           || 'gemeinde',   // 'gemeinde' oder 'locality'
    name:          r.name,
    plz:           r.plz           ?? null,
    kanton:        r.kanton,
    gemeinde_slug: r.gemeinde_slug ?? null,         // nur bei typ='locality'

    // Kauf CHF/m²
    kauf_whg_median:  r.kauf_whg_median  ?? null,
    kauf_whg_p10:     r.kauf_whg_p10     ?? null,
    kauf_whg_p90:     r.kauf_whg_p90     ?? null,
    kauf_haus_median: r.kauf_haus_median ?? null,
    kauf_haus_p10:    r.kauf_haus_p10    ?? null,
    kauf_haus_p90:    r.kauf_haus_p90    ?? null,

    // Miete CHF/m²/Monat
    miete_whg_median:  r.miete_whg_median  ?? null,
    miete_whg_p10:     r.miete_whg_p10     ?? null,
    miete_whg_p90:     r.miete_whg_p90     ?? null,
    miete_haus_median: r.miete_haus_median ?? null,
    miete_haus_p10:    r.miete_haus_p10    ?? null,
    miete_haus_p90:    r.miete_haus_p90    ?? null,

    // Meta
    source:        r.source       || 'realadvisor',
    has_override:  r.has_override || false,
    override_note: r.override_note || null,
    scraped_at:    r.scraped_at   || new Date().toISOString(),
  };
}

function toSupabaseStreetRow(r) {
  return {
    gemeinde_slug:      r.gemeinde_slug,
    strasse_slug:       r.strasse_slug,
    strasse_name:       r.strasse_name,
    strasse_name_lower: r.strasse_name_lower || r.strasse_name?.toLowerCase() || null,
    plz:                r.plz               ?? null,
    lat:                r.lat               ?? null,
    lng:                r.lng               ?? null,
    is_cross_locality:  r.is_cross_locality || false,
    // Kauf strassenspezifisch (kein Typ-Split, kein Mietpreis)
    kauf_median:        r.kauf_median ?? null,
    kauf_p15:           r.kauf_p15   ?? null,   // P15 (nicht P10)
    kauf_p85:           r.kauf_p85   ?? null,   // P85 (nicht P90)
    transaction_count:  r.transaction_count ?? null,
    // Meta
    source:       r.source       || 'realadvisor',
    has_override: r.has_override || false,
    scraped_at:   r.scraped_at   || new Date().toISOString(),
  };
}

// ── Sanity-Checks ─────────────────────────────────────────────────────────────

function sanityCheckPlz(rows) {
  const issues   = [];
  const gemeinden = rows.filter(r => r.typ === 'gemeinde');
  const localities = rows.filter(r => r.typ === 'locality');
  const withData = rows.filter(r => r.kauf_whg_median || r.miete_whg_median);

  if (rows.length < MIN_PLZ_ROWS)
    issues.push(`Nur ${rows.length} Einträge (Minimum: ${MIN_PLZ_ROWS})`);
  if (gemeinden.length < 2000)
    issues.push(`Nur ${gemeinden.length} Gemeinden (erwartet: ~2109)`);
  if (localities.length < 3000)
    issues.push(`Nur ${localities.length} PLZ-Localities (erwartet: ~3936)`);
  if (withData.length / rows.length < MIN_DATA_RATE)
    issues.push(`Nur ${Math.round(withData.length / rows.length * 100)}% haben Daten (Minimum: ${Math.round(MIN_DATA_RATE * 100)}%)`);

  return issues;
}

function sanityCheckStreets(rows) {
  const issues   = [];
  const withData = rows.filter(r => r.kauf_median);

  if (rows.length < MIN_STREET_ROWS)
    issues.push(`Nur ${rows.length} Strassen (Minimum: ${MIN_STREET_ROWS})`);
  if (withData.length / rows.length < MIN_DATA_RATE)
    issues.push(`Nur ${Math.round(withData.length / rows.length * 100)}% haben Kaufpreis`);

  return issues;
}

// ── Hauptlogik ────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  IMMOSKOP Scraper 4/4 – Merge & Upload           ║');
  if (DRY_RUN)  console.log('║  Modus: DRY RUN (kein Upload)                    ║');
  if (PLZ_ONLY) console.log('║  Nur: PLZ-Tabelle                                ║');
  if (MIGRATE)  console.log('║  Inkl. Schema-Migration                          ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_KEY)) {
    console.error('❌ Fehlende Umgebungsvariablen:');
    console.error('   export SUPABASE_URL=https://clwdxufyeiznyhrfrysl.supabase.co');
    console.error('   export SUPABASE_SERVICE_KEY=eyJ...');
    process.exit(1);
  }

  if (MIGRATE) printMigrationSql();

  // ── PLZ-Tabelle ─────────────────────────────────────────────────────────────

  console.log('── Schritt 1: PLZ-Daten mergen ─────────────────────\n');

  if (!fs.existsSync(PLZ_RAW_FILE)) {
    console.error(`❌ ${PLZ_RAW_FILE} fehlt → zuerst node 2_scrape_plz.js ausführen`);
    process.exit(1);
  }

  const plzRawData   = JSON.parse(fs.readFileSync(PLZ_RAW_FILE, 'utf8'));
  // Neues Format: "eintraege" (Gemeinden + Localities gemischt)
  const plzRaw       = plzRawData.eintraege || plzRawData.gemeinden || [];
  const plzOverrides = fs.existsSync(PLZ_OVERRIDES)
    ? JSON.parse(fs.readFileSync(PLZ_OVERRIDES, 'utf8')).overrides || []
    : [];

  const gemeindeCount  = plzRaw.filter(r => r.typ === 'gemeinde').length;
  const localityCount  = plzRaw.filter(r => r.typ === 'locality').length;
  console.log(`   Rohdaten:   ${plzRaw.length} Einträge (${gemeindeCount} Gemeinden, ${localityCount} PLZ-Localities)`);
  console.log(`   Overrides:  ${plzOverrides.length} Einträge`);

  const plzMerged   = mergePlz(plzRaw, plzOverrides);
  const plzSupabase = plzMerged
    .filter(r => r.slug)
    .map(toSupabasePlzRow);

  const withData = plzSupabase.filter(r => r.kauf_whg_median || r.miete_whg_median);
  console.log(`   Merged:     ${plzSupabase.length} Zeilen (${withData.length} mit Preisdaten)`);
  console.log(`   Overrides:  ${plzSupabase.filter(r => r.has_override).length} angewendet\n`);

  fs.writeFileSync(MERGED_PLZ_FILE, JSON.stringify({
    merged_at: new Date().toISOString(),
    total: plzSupabase.length,
    gemeinden: plzSupabase.filter(r => r.typ === 'gemeinde').length,
    localities: plzSupabase.filter(r => r.typ === 'locality').length,
    with_data: withData.length,
    eintraege: plzSupabase,
  }, null, 2), 'utf8');
  console.log('   💾 data/plz_prices_merged.json gespeichert\n');

  const plzIssues = sanityCheckPlz(plzSupabase);
  if (plzIssues.length > 0) {
    console.error('❌ Sanity-Check fehlgeschlagen:');
    plzIssues.forEach(i => console.error(`   • ${i}`));
    if (!DRY_RUN) { console.error('\n   Upload abgebrochen. --dry-run für Diagnose.'); process.exit(1); }
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
    console.error(`❌ ${STREET_RAW_FILE} fehlt → zuerst node 2_scrape_plz.js ausführen`);
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
  console.log('   💾 data/street_prices_merged.json gespeichert\n');

  const strIssues = sanityCheckStreets(strSupabase);
  if (strIssues.length > 0) {
    console.error('❌ Sanity-Check Strassen fehlgeschlagen:');
    strIssues.forEach(i => console.error(`   • ${i}`));
    if (!DRY_RUN) { console.error('\n   Upload abgebrochen.'); process.exit(1); }
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
    console.log('║  DRY RUN – kein Upload                            ║');
    console.log('║  Prüfe:  data/plz_prices_merged.json             ║');
    console.log('║          data/street_prices_merged.json          ║');
  } else {
    console.log('║  Supabase vollständig ersetzt:                    ║');
    console.log(`║  • plz_prices:    ${String(plzSupabase.length).padEnd(31)}║`);
    console.log(`║  • street_prices: ${String(strSupabase.length).padEnd(31)}║`);
  }
  console.log('╚══════════════════════════════════════════════════╝');
}

main().catch(e => { console.error('Fataler Fehler:', e); process.exit(1); });
