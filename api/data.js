export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { address, rooms, area, price, type, year, floor, outdoor, condition } = req.body;
  const isKauf = type === 'kauf';

  // ── 1. GEOCODE ──────────────────────────────────────────────────
  let lat, lon, label, plz, lv03y, lv03x;
  try {
    const geoUrl = `https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=${encodeURIComponent(address)}&type=locations&limit=1&origins=address`;
    const geoRes = await fetch(geoUrl);
    const geoData = await geoRes.json();
    if (geoData.results?.length) {
      const attrs = geoData.results[0].attrs;
      label = attrs.label.replace(/<[^>]+>/g, '');
      lv03y = attrs.y;
      lv03x = attrs.x;
      const y_ = (lv03y - 600000) / 1000000;
      const x_ = (lv03x - 200000) / 1000000;
      const lonDeg = 2.6779094 + 4.728982*y_ + 0.791484*y_*x_ + 0.1306*y_*x_*x_ - 0.0436*y_*y_*y_;
      const latDeg = 16.9023892 + 3.238272*x_ - 0.270978*y_*y_ - 0.002528*x_*x_ - 0.0447*y_*y_*x_ - 0.0140*x_*x_*x_;
      lat = latDeg * 100/36;
      lon = lonDeg * 100/36;
      const plzMatch = label.match(/\b(\d{4})\b/);
      plz = plzMatch ? plzMatch[1] : '8000';
      console.log('GEO ok:', label, '| lat:', lat.toFixed(4), 'lon:', lon.toFixed(4), '| plz:', plz);
    }
  } catch(e) { console.log('GEO error:', e.message); label = address; plz = '8000'; }

  if (!lat) return res.status(400).json({ error: 'Adresse konnte nicht geocodiert werden.' });

  // ── 2. PREISDATEN AUS SUPABASE ──────────────────────────────────
  let priceData = null;
  let streetData = null;
  let streetPercentile = null;

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    // Gemeinde-Preise via PLZ
    const priceRes = await fetch(
      `${supabaseUrl}/rest/v1/plz_prices?plz=eq.${plz}&limit=1`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );
    const priceRows = await priceRes.json();
    if (priceRows?.length) {
      priceData = priceRows[0];
      console.log('PRICE ok:', JSON.stringify(priceData));
    }

    // Strassen-Preise (falls Tabelle existiert)
    // Strassenname aus Adresse extrahieren
    const streetMatch = address.match(/^([^0-9,]+)/);
    const streetName = streetMatch ? streetMatch[1].trim().toLowerCase() : null;

    if (streetName) {
      const streetRes = await fetch(
        `${supabaseUrl}/rest/v1/street_prices?plz=eq.${plz}&street_name_lower=ilike.*${encodeURIComponent(streetName)}*&limit=1`,
        { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
      );
      if (streetRes.ok) {
        const streetRows = await streetRes.json();
        if (streetRows?.length) {
          streetData = streetRows[0];
          console.log('STREET ok:', JSON.stringify(streetData));
        }
      }
    }
  } catch(e) { console.log('SUPABASE error:', e.message); }

  // ── 3. PREISBERECHNUNG ──────────────────────────────────────────
  // Supabase-Daten verwenden falls vorhanden, sonst Fallback auf statisches Modell
  let refRentPerSqm = null;    // CHF/m²/Monat (Median)
  let refRentP10 = null;
  let refRentP90 = null;
  let refSalePerSqm = null;    // CHF/m² Kaufpreis (Median)
  let refSaleP10 = null;
  let refSaleP90 = null;
  let priceSource = 'Modell';

  if (priceData) {
    refRentPerSqm = priceData.median_price_sqm;
    refRentP10 = priceData.rent_p10;
    refRentP90 = priceData.rent_p90;
    refSalePerSqm = priceData.median_sale_price_sqm;
    refSaleP10 = priceData.sale_p10;
    refSaleP90 = priceData.sale_p90;
    priceSource = 'RealAdvisor';

    // Strassen-Perzentile berechnen falls Strassendaten vorhanden
    if (streetData && refSalePerSqm && refSaleP10 && refSaleP90) {
      const streetSale = streetData.median_sale_price_sqm;
      // Lineare Interpolation: wo liegt die Strasse in der Gemeinde-Range?
      // P10 = 10. Perzentile, Median = 50., P90 = 90.
      let pct;
      if (streetSale <= refSaleP10) {
        pct = 10 * (streetSale / refSaleP10);
      } else if (streetSale <= refSalePerSqm) {
        pct = 10 + 40 * ((streetSale - refSaleP10) / (refSalePerSqm - refSaleP10));
      } else if (streetSale <= refSaleP90) {
        pct = 50 + 40 * ((streetSale - refSalePerSqm) / (refSaleP90 - refSalePerSqm));
      } else {
        pct = 90 + 10 * Math.min((streetSale - refSaleP90) / refSaleP90, 1);
      }
      streetPercentile = Math.round(pct);

      // Mietpreis-Schätzung auf Basis der Strassen-Perzentile
      if (refRentP10 && refRentP90) {
        let estimatedRent;
        if (streetPercentile <= 10) {
          estimatedRent = refRentP10 * (streetPercentile / 10);
        } else if (streetPercentile <= 50) {
          estimatedRent = refRentP10 + (refRentPerSqm - refRentP10) * ((streetPercentile - 10) / 40);
        } else if (streetPercentile <= 90) {
          estimatedRent = refRentPerSqm + (refRentP90 - refRentPerSqm) * ((streetPercentile - 50) / 40);
        } else {
          estimatedRent = refRentP90;
        }
        // Strassen-spezifischen Mietpreis als Referenz verwenden
        refRentPerSqm = Math.round(estimatedRent * 10) / 10;
        priceSource = 'RealAdvisor (strassengenau)';
      }
    }
  } else {
    // Fallback: statisches Modell
    const BASE_QM = {'80':22.5,'81':21,'82':19.5,'83':17.5,'84':18,'85':20,'86':18.5,'87':17,'88':19,'89':16.5,'30':17,'31':16.5,'40':18.5,'41':17.8,'10':23,'12':25,'60':18,'70':15,'71':14.5,'72':14,'73':13.5,'default':17};
    const prefix = plz.substring(0,2);
    refRentPerSqm = BASE_QM[prefix] || BASE_QM['default'];
    priceSource = 'Modell (keine Supabase-Daten für diese PLZ)';
  }

  // Erwarteter Preis berechnen
  const YEAR_F = {'2020':1.18,'2010':1.07,'2000':1,'1990':0.92,'1980':0.85,'alt':0.77};
  const OUTDOOR_F = {'none':0.95,'balkon':1.0,'terrasse':1.05,'garten':1.10};
  const outdoorFactor = OUTDOOR_F[outdoor] || 1.0;
  // Zustand/Renovation
  const CONDITION_F = {'neuwertig':1.08,'gut':1.0,'mittel':0.92,'renovationsbed':0.82};
  const conditionFactor = CONDITION_F[condition] || 1.0;
  const CONDITION_LABEL = {'neuwertig':'Neuwertig/kürzl. renoviert','gut':'Guter Zustand','mittel':'Normaler Unterhalt','renovationsbed':'Renovationsbedürftig'};
  const yearFactor = YEAR_F[year] || 1;
  // EG = -5%, 1.OG = Basis (0%), höher = +1.5% pro Etage
  const floorNum = parseInt(floor) || 0;
  const floorFactor = floorNum === 0 ? 0.95 : 1 + (floorNum - 1) * 0.015;

  let expected, refPerSqmUsed;
  if (isKauf && refSalePerSqm) {
    refPerSqmUsed = refSalePerSqm;
    expected = Math.round(refSalePerSqm * area * yearFactor * floorFactor * outdoorFactor * conditionFactor);
  } else if (!isKauf && refRentPerSqm) {
    refPerSqmUsed = refRentPerSqm;
    expected = Math.round(refRentPerSqm * area * yearFactor * floorFactor * outdoorFactor * conditionFactor);
  } else {
    // Letzter Fallback
    refPerSqmUsed = 17;
    expected = isKauf ? Math.round(17 * area * 220 * outdoorFactor * conditionFactor) : Math.round(17 * area * outdoorFactor * conditionFactor);
  }

  const delta = Math.round((price - expected) / expected * 100);
  const pricePerQm = (price / area).toFixed(1);

  // Preis-Range für den Report
  let priceRangeText = '';
  if (!isKauf && refRentP10 && refRentP90) {
    const low = Math.round(refRentP10 * area * yearFactor * floorFactor);
    const high = Math.round(refRentP90 * area * yearFactor * floorFactor);
    priceRangeText = `Marktübliche Range (P10–P90): CHF ${low.toLocaleString('de-CH')}–${high.toLocaleString('de-CH')}/Mt.`;
  } else if (isKauf && refSaleP10 && refSaleP90) {
    const low = Math.round(refSaleP10 * area * yearFactor * floorFactor);
    const high = Math.round(refSaleP90 * area * yearFactor * floorFactor);
    priceRangeText = `Marktübliche Range (P10–P90): CHF ${low.toLocaleString('de-CH')}–${high.toLocaleString('de-CH')}`;
  }

  console.log('PRICE CALC → source:', priceSource, '| ref/m²:', refPerSqmUsed, '| expected:', expected, '| delta:', delta+'%');
  if (streetData) console.log('STREET → name:', streetData.street_name, '| sale/m²:', streetData.median_sale_price_sqm, '| percentile:', streetPercentile);

  // ── 4+5+6. OVERPASS + SOLAR PARALLEL ──────────────────────────
  let noiseDay = null, noiseSource = 'Schatznug';
  let oevDist = null, oevName = null, oevCount = 0;
  let amenitySummary = '';
  let solarKwh = null;

  const [overpassResult, solarResult] = await Promise.allSettled([
    // OVERPASS
    (async () => {
      const query = `[out:json][timeout:15];(
        way["highway"~"motorway|trunk|primary|secondary|tertiary|residential|living_street"](around:150,${lat},${lon});
        node["public_transport"="stop_position"](around:800,${lat},${lon});
        node["highway"="bus_stop"](around:800,${lat},${lon});
        node["railway"="tram_stop"](around:800,${lat},${lon});
        node["railway"="station"](around:800,${lat},${lon});
        node["amenity"="school"](around:800,${lat},${lon});
        node["amenity"="kindergarten"](around:800,${lat},${lon});
        node["shop"="supermarket"](around:800,${lat},${lon});
        node["amenity"="restaurant"](around:600,${lat},${lon});
        node["amenity"="cafe"](around:600,${lat},${lon});
        node["leisure"="park"](around:800,${lat},${lon});
        node["amenity"="pharmacy"](around:800,${lat},${lon});
      );out body;`;
      const r = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(14000),
        headers: { 'Accept': 'application/json' }
      });
      const text = await r.text();
      if (!text.startsWith('{')) throw new Error('Overpass non-JSON: ' + text.substring(0,50));
      return JSON.parse(text);
    })(),
    // SOLAR
    (async () => {
      const solarUrl = `https://api3.geo.admin.ch/rest/services/api/MapServer/identify?geometry=${lon},${lat}&geometryType=esriGeometryPoint&layers=all:ch.bfe.solarenergie-eignung-fassaden&mapExtent=${lon-0.01},${lat-0.01},${lon+0.01},${lat+0.01}&imageDisplay=100,100,96&tolerance=50&returnGeometry=false&sr=4326`;
      const solarRes = await fetch(solarUrl, { signal: AbortSignal.timeout(6000) });
      return await solarRes.json();
    })()
  ]);

  // Process Overpass result
  if (overpassResult.status === 'fulfilled') {
    try {
      const elements = overpassResult.value.elements || [];
      console.log('OVERPASS total elements:', elements.length);
      const ROAD_DB = {'motorway':75,'trunk':72,'primary':65,'secondary':60,'tertiary':55,'residential':48,'unclassified':50,'living_street':42};
      const OEV_TAGS = ['stop_position','bus_stop','tram_stop','station'];
      const groups = { Schulen:[], Einkauf:[], Gastro:[], Parks:[], Gesundheit:[] };
      let maxDb = 38, minOevDist = Infinity, nearestOev = null;
      elements.forEach(el => {
        const hw = el.tags?.highway;
        const amenity = el.tags?.amenity || el.tags?.shop || el.tags?.leisure;
        if (el.type === 'way' && hw && ROAD_DB[hw]) {
          if (ROAD_DB[hw] > maxDb) maxDb = ROAD_DB[hw];
        }
        if (el.type === 'node' && el.lat && (el.tags?.public_transport === 'stop_position' || el.tags?.highway === 'bus_stop' || el.tags?.railway === 'tram_stop' || el.tags?.railway === 'station')) {
          oevCount++;
          const dLat=(el.lat-lat)*Math.PI/180, dLon=(el.lon-lon)*Math.PI/180;
          const a=Math.sin(dLat/2)**2+Math.cos(lat*Math.PI/180)*Math.cos(el.lat*Math.PI/180)*Math.sin(dLon/2)**2;
          const dist=6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
          if (dist < minOevDist) { minOevDist=dist; nearestOev=el; }
        }
        if (el.type === 'node' && el.lat && amenity) {
          const name = el.tags?.name || amenity;
          const dLat=(el.lat-lat)*Math.PI/180, dLon=(el.lon-lon)*Math.PI/180;
          const a=Math.sin(dLat/2)**2+Math.cos(lat*Math.PI/180)*Math.cos(el.lat*Math.PI/180)*Math.sin(dLon/2)**2;
          const dist=Math.round(6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)));
          if (['school','kindergarten'].includes(amenity) && groups.Schulen.length<3) groups.Schulen.push(`${name} ${dist}m`);
          if (amenity==='supermarket' && groups.Einkauf.length<3) groups.Einkauf.push(`${name} ${dist}m`);
          if (['restaurant','cafe'].includes(amenity) && groups.Gastro.length<3) groups.Gastro.push(`${name} ${dist}m`);
          if (amenity==='park' && groups.Parks.length<2) groups.Parks.push(`${name} ${dist}m`);
          if (amenity==='pharmacy' && groups.Gesundheit.length<2) groups.Gesundheit.push(`${name} ${dist}m`);
        }
      });
      noiseDay = maxDb;
      noiseSource = 'OSM Strassenkategorie';
      if (minOevDist < Infinity) { oevDist=Math.round(minOevDist); oevName=nearestOev?.tags?.name||'Haltestelle'; }
      amenitySummary = Object.entries(groups).filter(([,v])=>v.length).map(([k,v])=>`${k}: ${v.join(', ')}`).join('\n');
      console.log('NOISE:', noiseDay, '| OEV:', oevDist, oevName, '| AMENITIES:', amenitySummary.length);
    } catch(e) { console.log('OVERPASS process error:', e.message); }
  } else { console.log('OVERPASS error:', overpassResult.reason?.message); }

  // Process Solar result
  if (solarResult.status === 'fulfilled') {
    try {
      const results = solarResult.value.results || [];
      console.log('SOLAR results:', results.length);
      if (results.length) {
        const props = results[0].attributes || {};
        const val = props.gstrahlung || props.stromertrag || props.klasse || props.eignung || props.value || null;
        solarKwh = val ? parseFloat(val) : null;
      }
    } catch(e) { console.log('SOLAR process error:', e.message); }
  } else { console.log('SOLAR error:', solarResult.reason?.message); }

  // ── 7. CRIME ────────────────────────────────────────────────────
  const CRIME = {
    'zürich':{hzahl:98,label:'Zürich'},'zuerich':{hzahl:98,label:'Zürich'},
    'bern':{hzahl:72,label:'Bern'},'basel':{hzahl:85,label:'Basel'},
    'genf':{hzahl:110,label:'Genf'},'winterthur':{hzahl:62,label:'Winterthur'},
    'luzern':{hzahl:58,label:'Luzern'},'lausanne':{hzahl:95,label:'Lausanne'},
    'kilchberg':{hzahl:18,label:'Kilchberg'},'küsnacht':{hzahl:16,label:'Küsnacht'},
    'thalwil':{hzahl:22,label:'Thalwil'},'zollikon':{hzahl:20,label:'Zollikon'},
    'uster':{hzahl:45,label:'Uster'},'laax':{hzahl:12,label:'Laax'},
    'davos':{hzahl:35,label:'Davos'},'st. gallen':{hzahl:54,label:'St. Gallen'},
  };
  const labelLower = (label||'').toLowerCase();
  let crime = {hzahl:38,label:'diese Gemeinde'};
  for (const [key,val] of Object.entries(CRIME)) {
    if (labelLower.includes(key)) { crime = val; break; }
  }

  // ── 8. STEUERFUSS ───────────────────────────────────────────────
  const TAXES = {'kilchberg':72,'küsnacht':73,'zollikon':78,'herrliberg':75,'thalwil':80,'rüschlikon':73,'zürich':119,'winterthur':122,'bern':116,'basel':96,'luzern':107,'laax':98,'davos':95};
  let steuerfuss = null;
  for (const [key,val] of Object.entries(TAXES)) {
    if (labelLower.includes(key)) { steuerfuss = val; break; }
  }

  console.log('SUMMARY → noise:', noiseDay, '| solar:', solarKwh, '| oev:', oevDist, '| crime:', crime.hzahl, '| tax:', steuerfuss, '| delta:', delta+'%');

  // ── 9. PROMPT ───────────────────────────────────────────────────
  const streetInfo = streetData
    ? `Strassendaten (${streetData.street_name}): Kaufpreis CHF ${streetData.median_sale_price_sqm?.toLocaleString('de-CH')}/m² · ${streetPercentile}. Perzentile in der Gemeinde (${streetPercentile < 33 ? 'günstiges' : streetPercentile < 66 ? 'mittleres' : 'gehobenes'} Segment)`
    : 'Strassendaten: nicht verfügbar';

  const prompt = `Du bist ein unabhängiger Schweizer Immobilienexperte. Erstelle einen vollständigen Analysebericht auf Deutsch. Sei direkt, konkret, ehrlich — kein Marketing.

INSERAT:
Adresse: ${label}
Typ: ${isKauf?'Kaufobjekt':'Mietwohnung'} | ${rooms} Zimmer | ${area} m² | Etage ${floor} | Baujahr ${year}
Zustand: ${CONDITION_LABEL[condition]||'–'} | Aussenraum: ${{none:'Kein Aussenraum',balkon:'Balkon',terrasse:'Terrasse',garten:'Garten/Sitzplatz'}[outdoor]||'–'}
Preis: CHF ${parseInt(price).toLocaleString('de-CH')}${isKauf?'':'/Mt.'} (CHF ${pricePerQm}/m²)

MARKTDATEN (Quelle: ${priceSource}):
Referenzpreis: CHF ${expected.toLocaleString('de-CH')}${isKauf?'':'/Mt.'} → Abweichung: ${delta>0?'+':''}${delta}%
${priceRangeText}
${streetInfo}
${isKauf && refRentPerSqm ? `Mietrendite-Hinweis: marktübliche Miete ca. CHF ${Math.round(refRentPerSqm * area * yearFactor * floorFactor).toLocaleString('de-CH')}/Mt. (${(refRentPerSqm * 12 / (refSalePerSqm||1) * 100).toFixed(1)}% Bruttorendite auf Kaufpreis)` : ''}

BEHÖRDEN-DATEN:
Lärm (${noiseSource}): ${noiseDay ? `${noiseDay} dB (geschätzt aus Strassenkategorie)` : 'nicht verfügbar'}
Besonnung (swisstopo BFE): ${solarKwh?`${Math.round(solarKwh)} kWh/Jahr`:'nicht verfügbar'}
ÖV: ${oevDist?`${oevDist}m zur Haltestelle ${oevName} · ${oevCount} Haltestellen im 800m-Radius`:'nicht verfügbar'}
Sicherheit (PKS): ${crime.hzahl} Delikte/1000 Einw. in ${crime.label}${steuerfuss?`\nSteuerfuss: ${steuerfuss}%`:''}

UMGEBUNG (OSM 800m):
${amenitySummary||'keine Daten verfügbar'}

---

## Preiseinschätzung
Bewerte konkret: fair / überteuert / günstig. Nenne fairen Richtwert in CHF. Erkläre die ${delta>0?'+':''}${delta}% Abweichung.${priceRangeText ? ` Zeige wo der Preis in der Marktrange liegt.` : ''}

## Was für dieses Angebot spricht
3–5 konkrete Vorteile basierend auf den Daten.

## Was kritisch zu prüfen ist
3–5 ehrliche Punkte — Risiken, fehlende Infos, Besichtigungshinweise.

## Lagequalität
Bewerte Lärm, Besonnung, ÖV und Umgebung mit den konkreten Messwerten.
${steuerfuss?`\n## Steuerlicher Vorteil\nBerechne konkret: was spart eine Person mit CHF 120'000 Jahreseinkommen durch Steuerfuss ${steuerfuss}% gegenüber Zürich-Stadt (119%)?`:''}

## Besichtigungs-Checkliste
8–10 spezifische Punkte für genau dieses Objekt.

## Fazit
3 Sätze: Gesamtbewertung, konkrete Empfehlung, Verhandlungshinweis falls relevant.`;

  // ── 10. RETURN META (no Claude) ────────────────────────────────
  return res.status(200).json({
    meta: {
      noiseDay, solarKwh, oevDist, oevName, oevCount, amenitySummary,
      crime, steuerfuss, delta, expected, priceRangeText, priceSource,
      outdoor, outdoorFactor, condition, conditionFactor,
      streetData: streetData ? { name: streetData.street_name, salePerSqm: streetData.median_sale_price_sqm, percentile: streetPercentile } : null,
      lat: lat?.toFixed(4), lon: lon?.toFixed(4)
    }
  });
}
