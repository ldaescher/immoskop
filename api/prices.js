// Returns current market price reference for a given PLZ
// Used by report.js to get accurate price benchmarks

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Fallback prices per PLZ prefix (CHF/m²/month) - used when no Flatfox data available
// Based on current market observations, not BFS averages
const FALLBACK_BY_PREFIX = {
  // Zürich Stadt
  '80': 28, '81': 26,
  // Zürich See (linkes Ufer)
  '88': 30,
  // Winterthur
  '84': 22,
  // Bern
  '30': 21, '31': 20,
  // Basel
  '40': 23, '41': 22,
  // Lausanne
  '10': 27,
  // Genf
  '12': 32, '13': 29,
  // Luzern
  '60': 22,
  // St. Gallen
  '90': 18,
  // Default
  'default': 20
};

export default async function handler(req, res) {
  const { plz, rooms, area, year } = req.query;

  if (!plz) return res.status(400).json({ error: 'PLZ required' });

  let priceData = null;

  // 1. Try exact PLZ from Supabase
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/plz_prices?plz=eq.${plz}&order=scraped_at.desc&limit=1`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }
    );
    const data = await r.json();
    if (data?.length > 0) {
      priceData = data[0];
    }
  } catch(e) {}

  // 2. Try nearby PLZ (same first 3 digits)
  if (!priceData && SUPABASE_URL) {
    try {
      const prefix3 = plz.substring(0, 3);
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/plz_prices?plz=like.${prefix3}*&order=scraped_at.desc&limit=5`,
        {
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
          }
        }
      );
      const data = await r.json();
      if (data?.length > 0) {
        // Average of nearby PLZ
        const avgSqm = data.reduce((s, d) => s + d.median_price_sqm, 0) / data.length;
        priceData = { ...data[0], median_price_sqm: Math.round(avgSqm * 10) / 10, source: 'nearby_plz' };
      }
    } catch(e) {}
  }

  // 3. Fallback to static table
  if (!priceData) {
    const prefix = plz.substring(0, 2);
    const fallbackSqm = FALLBACK_BY_PREFIX[prefix] || FALLBACK_BY_PREFIX['default'];
    priceData = {
      plz,
      median_price_sqm: fallbackSqm,
      source: 'fallback_static',
      scraped_at: null
    };
  }

  // Apply year correction
  const YEAR_FACTOR = { '2020': 1.12, '2010': 1.05, '2000': 1.0, '1990': 0.93, '1980': 0.87, 'alt': 0.80 };
  const yearFactor = YEAR_FACTOR[year] || 1.0;

  // Apply floor correction (slight premium per floor)
  const floorNum = parseInt(req.query.floor) || 0;
  const floorFactor = 1 + floorNum * 0.015;

  const adjustedSqm = Math.round(priceData.median_price_sqm * yearFactor * floorFactor * 10) / 10;
  const areaNum = parseInt(area) || 75;
  const expectedMonthly = Math.round(adjustedSqm * areaNum);

  return res.status(200).json({
    plz,
    base_price_sqm: priceData.median_price_sqm,
    adjusted_price_sqm: adjustedSqm,
    expected_monthly: expectedMonthly,
    source: priceData.source || 'flatfox',
    data_age_days: priceData.scraped_at
      ? Math.round((Date.now() - new Date(priceData.scraped_at)) / 86400000)
      : null,
    count: priceData.count || null
  });
}
