export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const {
      event_type, plz, city, canton,
      listing_type, property_kind, rooms, area_sqm, year_category,
      delta_pct, price_bracket,
      used_paste, used_report, befristet,
      has_street_data, has_bafu_noise, has_solar, noise_db,
      session_id, street_name
    } = req.body;

    // Validate event type
    if (!['analysis','report','parse'].includes(event_type)) {
      return res.status(400).json({ error: 'Invalid event_type' });
    }

    // Sanitize - ensure no PII
    const sanitized = {
      event_type,
      plz: plz ? String(plz).substring(0,4) : null,
      city: city ? String(city).substring(0,50) : null,
      canton: canton ? String(canton).substring(0,30) : null,
      listing_type: ['miete','kauf'].includes(listing_type) ? listing_type : null,
      property_kind: ['wohnung','haus'].includes(property_kind) ? property_kind : null,
      rooms: rooms ? parseFloat(rooms) : null,
      area_sqm: area_sqm ? parseInt(area_sqm) : null,
      year_category: year_category || null,
      delta_pct: delta_pct !== undefined ? Math.round(parseInt(delta_pct)) : null,
      price_bracket: price_bracket || null,
      used_paste: Boolean(used_paste),
      used_report: Boolean(used_report),
      befristet: Boolean(befristet),
      has_street_data: Boolean(has_street_data),
      has_bafu_noise: Boolean(has_bafu_noise),
      has_solar: Boolean(has_solar),
      noise_db: noise_db ? parseInt(noise_db) : null,
      session_id: session_id ? String(session_id).substring(0,36) : null,
      street_name: street_name ? String(street_name).substring(0,80).replace(/\d+/g,'').trim() : null, // Hausnummer entfernen
      price_db_eligible: Boolean(used_paste), // Nur Paste-Analysen fliessen in Preisdatenbank
    };

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    const r = await fetch(`${supabaseUrl}/rest/v1/analytics_events`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(sanitized)
    });

    if (!r.ok) {
      const err = await r.text();
      console.log('ANALYTICS insert error:', err);
      return res.status(200).json({ ok: false }); // Never fail silently for user
    }

    return res.status(200).json({ ok: true });
  } catch(e) {
    console.log('ANALYTICS error:', e.message);
    return res.status(200).json({ ok: false }); // Never break user flow
  }
}
