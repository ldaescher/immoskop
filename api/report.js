export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { address, rooms, area, price, type, year, floor } = req.body;
  const isKauf = type === 'kauf';

  // ── 1. GEOCODE ──────────────────────────────────────────────────
  let lat, lon, label, plz, lv95e, lv95n;
  try {
    const geoUrl = `https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=${encodeURIComponent(address)}&type=locations&limit=1&origins=address`;
    const geoRes = await fetch(geoUrl);
    const geoData = await geoRes.json();
    if (geoData.results?.length) {
      const attrs = geoData.results[0].attrs;
      label = attrs.label.replace(/<[^>]+>/g, '');
      // swisstopo: attrs.y = Easting (LV95 ~2.6M), attrs.x = Northing (LV95 ~1.2M)
      lv95e = attrs.y;
      lv95n = attrs.x;
      const E = (lv95e - 2600000) / 1000000;
      const N = (lv95n - 1200000) / 1000000;
      const lonDeg = 2.6779094 + 4.728982*E + 0.791484*E*N + 0.1306*E*N*N - 0.0436*E*E*E;
      const latDeg = 16.9023892 + 3.238272*N - 0.270978*E*E - 0.002528*N*N - 0.0447*E*E*N - 0.0140*N*N*N;
      lat = latDeg * 100/36;
      lon = lonDeg * 100/36;
      const plzMatch = label.match(/\b(\d{4})\b/);
      plz = plzMatch ? plzMatch[1] : '8000';
      console.log('GEO ok:', label, '| lv95e:', lv95e, 'lv95n:', lv95n, '| lat:', lat.toFixed(4), 'lon:', lon.toFixed(4));
    }
  } catch(e) { console.log('GEO error:', e.message); label = address; plz = '8000'; }

  if (!lat) return res.status(400).json({ error: 'Adresse konnte nicht geocodiert werden.' });

  // ── 2. NOISE via geo.admin.ch identify REST API ─────────────────
  let noiseDay = null;
  try {
    // Use the identify endpoint with LV95 coordinates
    const noiseUrl = `https://api3.geo.admin.ch/rest/services/api/MapServer/identify?geometry=${lv95e},${lv95n}&geometryType=esriGeometryPoint&layers=all:ch.bafu.laerm-strassenlarm_tag&mapExtent=${lv95e-100},${lv95n-100},${lv95e+100},${lv95n+100}&imageDisplay=100,100,96&tolerance=10&returnGeometry=false&sr=2056`;
    console.log('NOISE url:', noiseUrl);
    const noiseRes = await fetch(noiseUrl, { signal: AbortSignal.timeout(6000) });
    const noiseText = await noiseRes.text();
    console.log('NOISE response (first 300):', noiseText.substring(0, 300));
    const noiseData = JSON.parse(noiseText);
    const results = noiseData.results || [];
    console.log('NOISE results count:', results.length);
    if (results.length) {
      const props = results[0].attributes || results[0].properties || {};
      console.log('NOISE props keys:', Object.keys(props), 'values:', JSON.stringify(props).substring(0, 200));
      const val = props.db_tag || props.laeq_tag || props.klasse || props.value || props.KLASSE || props.db || null;
      noiseDay = val ? parseFloat(val) : null;
      console.log('NOISE value extracted:', noiseDay);
    }
  } catch(e) { console.log('NOISE error:', e.message); }

  // ── 3. SOLAR via geo.admin.ch identify REST API ─────────────────
  let solarKwh = null;
  try {
    const solarUrl = `https://api3.geo.admin.ch/rest/services/api/MapServer/identify?geometry=${lv95e},${lv95n}&geometryType=esriGeometryPoint&layers=all:ch.bfe.solarenergie-eignung-fassaden&mapExtent=${lv95e-100},${lv95n-100},${lv95e+100},${lv95n+100}&imageDisplay=100,100,96&tolerance=10&returnGeometry=false&sr=2056`;
    console.log('SOLAR url:', solarUrl);
    const solarRes = await fetch(solarUrl, { signal: AbortSignal.timeout(6000) });
    const solarText = await solarRes.text();
    console.log('SOLAR response (first 300):', solarText.substring(0, 300));
    const solarData = JSON.parse(solarText);
    const results = solarData.results || [];
    console.log('SOLAR results count:', results.length);
    if (results.length) {
      const props = results[0].attributes || results[0].properties || {};
      console.log('SOLAR props keys:', Object.keys(props), 'values:', JSON.stringify(props).substring(0, 200));
      const val = props.gstrahlung || props.stromertrag || props.eignung || props.klasse || props.value || null;
      solarKwh = val ? parseFloat(val) : null;
    }
  } catch(e) { console.log('SOLAR error:', e.message); }

  // ── 4. OEV via Overpass ─────────────────────────────────────────
  let oevDist = null, oevName = null, oevCount = 0;
  try {
    const query = `[out:json][timeout:8];(node["public_transport"="stop_position"](around:600,${lat},${lon});node["highway"="bus_stop"](around:600,${lat},${lon});node["railway"="tram_stop"](around:600,${lat},${lon});node["railway"="station"](around:600,${lat},${lon}););out body;`;
    const oevRes = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(8000) });
    const oevData = await oevRes.json();
    const elements = oevData.elements || [];
    oevCount = elements.length;
    console.log('OEV elements:', oevCount);
    if (elements.length) {
      let minDist = Infinity, nearest = null;
      elements.forEach(el => {
        const dLat = (el.lat - lat) * Math.PI/180;
        const dLon = (el.lon - lon) * Math.PI/180;
        const a = Math.sin(dLat/2)**2 + Math.cos(lat*Math.PI/180)*Math.cos(el.lat*Math.PI/180)*Math.sin(dLon/2)**2;
        const dist = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        if (dist < minDist) { minDist = dist; nearest = el; }
      });
      oevDist = Math.round(minDist);
      oevName = nearest?.tags?.name || 'Haltestelle';
      console.log('OEV nearest:', oevDist, 'm', oevName);
    }
  } catch(e) { console.log('OEV error:', e.message); }

  // ── 5. AMENITIES via Overpass ───────────────────────────────────
  let amenitySummary = '';
  try {
    const query = `[out:json][timeout:10];(node["amenity"="school"](around:800,${lat},${lon});node["amenity"="kindergarten"](around:800,${lat},${lon});node["shop"="supermarket"](around:800,${lat},${lon});node["amenity"="restaurant"](around:500,${lat},${lon});node["amenity"="cafe"](around:500,${lat},${lon});node["leisure"="park"](around:800,${lat},${lon});node["amenity"="pharmacy"](around:800,${lat},${lon}););out body;`;
    const amenRes = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(10000) });
    const amenData = await amenRes.json();
    const elements = amenData.elements || [];
    console.log('AMENITIES elements:', elements.length);
    const groups = { Schulen: [], Einkauf: [], Gastro: [], Parks: [], Gesundheit: [] };
    elements.forEach(el => {
      const t = el.tags?.amenity || el.tags?.shop || el.tags?.leisure;
      const name = el.tags?.name || t;
      const dLat = (el.lat - lat) * Math.PI/180;
      const dLon = (el.lon - lon) * Math.PI/180;
      const a = Math.sin(dLat/2)**2 + Math.cos(lat*Math.PI/180)*Math.cos(el.lat*Math.PI/180)*Math.sin(dLon/2)**2;
      const dist = Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
      if (['school','kindergarten'].includes(t) && groups.Schulen.length < 3) groups.Schulen.push(`${name} ${dist}m`);
      if (['supermarket'].includes(t) && groups.Einkauf.length < 3) groups.Einkauf.push(`${name} ${dist}m`);
      if (['restaurant','cafe'].includes(t) && groups.Gastro.length < 3) groups.Gastro.push(`${name} ${dist}m`);
      if (['park'].includes(t) && groups.Parks.length < 2) groups.Parks.push(`${name} ${dist}m`);
      if (['pharmacy'].includes(t) && groups.Gesundheit.length < 2) groups.Gesundheit.push(`${name} ${dist}m`);
    });
    amenitySummary = Object.entries(groups).filter(([,v]) => v.length).map(([k,v]) => `${k}: ${v.join(', ')}`).join('\n');
  } catch(e) { console.log('AMENITIES error:', e.message); }

  // ── 6. CRIME ────────────────────────────────────────────────────
  const CRIME = {
    'zürich':{hzahl:98,label:'Zürich'},'zuerich':{hzahl:98,label:'Zürich'},
    'bern':{hzahl:72,label:'Bern'},'basel':{hzahl:85,label:'Basel'},
    'genf':{hzahl:110,label:'Genf'},'winterthur':{hzahl:62,label:'Winterthur'},
    'luzern':{hzahl:58,label:'Luzern'},'lausanne':{hzahl:95,label:'Lausanne'},
    'kilchberg':{hzahl:18,label:'Kilchberg'},'küsnacht':{hzahl:16,label:'Küsnacht'},
    'thalwil':{hzahl:22,label:'Thalwil'},'zollikon':{hzahl:20,label:'Zollikon'},
    'uster':{hzahl:45,label:'Uster'},'laax':{hzahl:12,label:'Laax'},
  };
  const labelLower = (label||'').toLowerCase();
  let crime = {hzahl:38,label:'diese Gemeinde'};
  for (const [key,val] of Object.entries(CRIME)) {
    if (labelLower.includes(key)) { crime = val; break; }
  }

  // ── 7. PRICE ────────────────────────────────────────────────────
  const BASE_QM = {'80':22.5,'81':21,'82':19.5,'83':17.5,'84':18,'85':20,'86':18.5,'87':17,'88':19,'89':16.5,'30':17,'31':16.5,'40':18.5,'41':17.8,'10':23,'12':25,'60':18,'70':15,'71':14.5,'default':17};
  const YEAR_F = {'2020':1.18,'2010':1.07,'2000':1,'1990':0.92,'1980':0.85,'alt':0.77};
  const prefix = plz.substring(0,2);
  const baseQm = (BASE_QM[prefix]||BASE_QM['default']) * (YEAR_F[year]||1) * (1+(parseInt(floor)||0)*0.015);
  const expected = isKauf ? Math.round(baseQm*area*220) : Math.round(baseQm*area);
  const delta = Math.round((price-expected)/expected*100);
  const pricePerQm = (price/area).toFixed(1);

  // ── 8. STEUERFUSS ───────────────────────────────────────────────
  const TAXES = {'kilchberg':72,'küsnacht':73,'zollikon':78,'herrliberg':75,'thalwil':80,'rüschlikon':73,'zürich':119,'winterthur':122,'bern':116,'basel':96,'luzern':107,'laax':100};
  let steuerfuss = null;
  for (const [key,val] of Object.entries(TAXES)) {
    if (labelLower.includes(key)) { steuerfuss = val; break; }
  }

  console.log('SUMMARY → noise:', noiseDay, 'solar:', solarKwh, 'oev:', oevDist, 'amenities:', amenitySummary.length, 'crime:', crime.hzahl, 'tax:', steuerfuss, 'delta:', delta+'%');

  // ── 9. PROMPT ───────────────────────────────────────────────────
  const prompt = `Du bist ein unabhängiger Schweizer Immobilienexperte. Erstelle einen vollständigen Analysebericht auf Deutsch. Sei direkt, konkret, ehrlich — kein Marketing.

INSERAT:
Adresse: ${label}
Typ: ${isKauf?'Kaufobjekt':'Mietwohnung'} | ${rooms} Zimmer | ${area} m² | Etage ${floor} | Baujahr ${year}
Preis: CHF ${parseInt(price).toLocaleString('de-CH')}${isKauf?'':'/Mt.'} (CHF ${pricePerQm}/m²)
Marktmodell-Referenz: CHF ${expected.toLocaleString('de-CH')}${isKauf?'':'/Mt.'} → Abweichung: ${delta>0?'+':''}${delta}%

BEHÖRDEN-DATEN:
Lärm (BAFU): ${noiseDay?`${noiseDay} dB Tagesmittel`:'nicht verfügbar'}
Besonnung (swisstopo BFE): ${solarKwh?`${Math.round(solarKwh)} kWh/Jahr`:'nicht verfügbar'}
ÖV: ${oevDist?`${oevDist}m zur Haltestelle ${oevName} · ${oevCount} Haltestellen im 600m-Radius`:'nicht verfügbar'}
Sicherheit (PKS): ${crime.hzahl} Delikte/1000 Einw. in ${crime.label}${steuerfuss?`\nSteuerfuss: ${steuerfuss}%`:''}

UMGEBUNG (OSM 800m):
${amenitySummary||'keine Daten verfügbar'}

---

## Preiseinschätzung
Bewerte konkret: fair / überteuert / günstig. Nenne fairen Richtwert in CHF. Erkläre die ${delta>0?'+':''}${delta}% Abweichung mit Argumenten.

## Was für dieses Angebot spricht
3–5 konkrete Vorteile basierend auf den verfügbaren Daten.

## Was kritisch zu prüfen ist
3–5 ehrliche Punkte — Risiken, fehlende Informationen, was bei der Besichtigung zu prüfen ist.

## Lagequalität
Bewerte Lärm, Besonnung, ÖV und Umgebung mit den konkreten Messwerten. Interpretiere die Zahlen verständlich für Laien.
${steuerfuss?`\n## Steuerlicher Vorteil\nBerechne konkret: was spart eine Person mit CHF 120'000 Jahreseinkommen durch den Steuerfuss von ${steuerfuss}% gegenüber Zürich-Stadt (119%)?`:''}

## Besichtigungs-Checkliste
8–10 spezifische Punkte für genau dieses Objekt — nicht generisch.

## Fazit
3 Sätze: Gesamtbewertung, konkrete Empfehlung, Verhandlungshinweis falls relevant.`;

  // ── 10. CLAUDE ──────────────────────────────────────────────────
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{role:'user',content:prompt}]
      })
    });
    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) return res.status(500).json({error: claudeData.error?.message||'Claude API Fehler'});
    return res.status(200).json({
      report: claudeData.content?.[0]?.text||'',
      meta: {noiseDay, solarKwh, oevDist, oevName, amenitySummary, crime, steuerfuss, delta, expected}
    });
  } catch(err) {
    return res.status(500).json({error:'Server-Fehler: '+err.message});
  }
}
