export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { address, rooms, area, price, type, year, floor, outdoor, condition, insertText, parsedInsert, propertyKind, reportDate, extraInfo, lang,
    expectedFromData, deltaFromData, priceSourceFromData, autobahnName, autobahnRichtungen, autobahnDist, autobahnFahrzeit } = req.body;
  const isKauf = type === 'kauf';

  // ── 1. GEOCODE ──────────────────────────────────────────────────
  let lat, lon, label, plz, lv03y, lv03x, geoAccuracy = 'adresse';
  try {
    // Try 1: exact address search
    const geoUrl = `https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=${encodeURIComponent(address)}&type=locations&limit=1&origins=address`;
    const geoRes = await fetch(geoUrl);
    const geoData = await geoRes.json();
    if (geoData.results?.length) {
      const attrs = geoData.results[0].attrs;
      label = attrs.label.replace(/<[^>]+>/g, '');
      lv03y = attrs.y; lv03x = attrs.x;
    } else {
      // Try 2: commune/locality search (no street)
      console.log('GEO: no address result, trying locality...');
      const geoUrl2 = `https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=${encodeURIComponent(address)}&type=locations&limit=1&origins=gg25,zipcode`;
      const geoRes2 = await fetch(geoUrl2);
      const geoData2 = await geoRes2.json();
      if (geoData2.results?.length) {
        const attrs = geoData2.results[0].attrs;
        label = attrs.label.replace(/<[^>]+>/g, '');
        lv03y = attrs.y; lv03x = attrs.x;
        geoAccuracy = 'gemeinde';
        console.log('GEO fallback to locality:', label);
      }
    }
    if (lv03y) {
      const y_ = (lv03y - 600000) / 1000000;
      const x_ = (lv03x - 200000) / 1000000;
      const lonDeg = 2.6779094 + 4.728982*y_ + 0.791484*y_*x_ + 0.1306*y_*x_*x_ - 0.0436*y_*y_*y_;
      const latDeg = 16.9023892 + 3.238272*x_ - 0.270978*y_*y_ - 0.002528*x_*x_ - 0.0447*y_*y_*x_ - 0.0140*x_*x_*x_;
      lat = latDeg * 100/36;
      lon = lonDeg * 100/36;
      const plzMatch = label.match(/\b(\d{4})\b/);
      plz = plzMatch ? plzMatch[1] : '8000';
      console.log('GEO ok:', label, '| lat:', lat.toFixed(4), 'lon:', lon.toFixed(4), '| plz:', plz, '| accuracy:', geoAccuracy);
    }
  } catch(e) { console.log('GEO error:', e.message); label = address; plz = '8000'; }

  if (!lat) return res.status(400).json({ error: 'Adresse konnte nicht gefunden werden. Bitte Gemeinde oder PLZ eingeben.' });

  // ── 2. PREISDATEN AUS SUPABASE ──────────────────────────────────
  let priceData = null;
  let streetData = null;
  let streetPercentile = null;
  let taxBurdenData = null;

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
    refRentPerSqm = priceData.miete_whg_median ?? priceData.miete_haus_median ?? priceData.median_price_sqm;
    refRentP10 = priceData.rent_p10;
    refRentP90 = priceData.rent_p90;
    refSalePerSqm = priceData.kauf_whg_median ?? priceData.kauf_haus_median ?? priceData.median_sale_price_sqm;
    refSaleP10 = priceData.sale_p10;
    refSaleP90 = priceData.sale_p90;
    priceSource = 'RealAdvisor';

    // Strassen-Perzentile berechnen falls Strassendaten vorhanden
    if (streetData && refSalePerSqm && refSaleP10 && refSaleP90) {
      const streetSale = streetData.kauf_median ?? streetData.median_sale_price_sqm;
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
  // Haus vs. Wohnung: national sind Wohnungen leicht teurer pro m² (RealAdvisor CH: Wohnung 8315, Haus 7710)
  // Städtisch: EFH hat Seltenheitswert → leichter Aufschlag
  // Ländlich: kein Aufschlag, manchmal Abschlag
  const urbanPlz = ['10','12','80','81','82','83','84','85','30','31','40','41','60','61','62','63','64','65','66','67','68','69','70','71','72','38','39'];
  const isUrban = urbanPlz.some(p => (plz||'').startsWith(p));
  const propertyFactor = (propertyKind === 'haus') ? (isUrban ? 1.05 : 1.0) : 1.0;
  // Baujahr: strukturelles Alter (Haustechnik, Energiestandard, Grundriss)
  const YEAR_F = {'2020':1.08,'2010':1.04,'2000':1.0,'1990':0.96,'1980':0.92,'alt':0.88};
  const yearCat = year || '2000';

  // Zustand: Renovationsstand — bei Neubauten (ab 2010) keine Wirkung, da immer neuwertig
  const isNeubau = (yearCat === '2020' || yearCat === '2010');
  const CONDITION_F = {'neuwertig':1.08,'gut':1.0,'mittel':0.92,'renovationsbed':0.82};
  const conditionFactor = isNeubau ? 1.0 : (CONDITION_F[condition] || 1.0);

  // Aussenraum: nur für Wohnungen relevant — EFH hat immer Garten/Aussenbereich
  const isHaus = (propertyKind === 'haus');
  const OUTDOOR_F_WOHNUNG = {'none':0.92,'balkon':1.0,'terrasse':1.05,'garten':1.08};
  const outdoorFactor = isHaus ? 1.0 : (OUTDOOR_F_WOHNUNG[outdoor] || 1.0);
  const CONDITION_LABEL = {'neuwertig':'Neuwertig/kürzl. renoviert','gut':'Guter Zustand','mittel':'Normaler Unterhalt','renovationsbed':'Renovationsbedürftig'};
  const conditionNote = isNeubau ? ' (Neubau — Zustandsfaktor nicht angewendet)' : '';
  const yearFactor = YEAR_F[yearCat] || 1.0;
  // EG = -5%, 1.OG = Basis (0%), höher = +1.5% pro Etage
  const floorNum = parseInt(floor) || 0;
  const floorFactor = floorNum === 0 ? 0.95 : 1 + (floorNum - 1) * 0.015;

  // Preisberechnung: Werte von api/data.js übernehmen falls vorhanden (konsistenz!)
  // Fallback: eigene Berechnung (falls Report direkt aufgerufen wird)
  let expected, refPerSqmUsed;
  if (expectedFromData && deltaFromData !== undefined) {
    expected = expectedFromData;
    refPerSqmUsed = isKauf ? refSalePerSqm : refRentPerSqm; // für Log
    if (priceSourceFromData) priceSource = priceSourceFromData;
    console.log('REPORT: using expected from data.js:', expected, '| ref/m²:', refPerSqmUsed);
  } else {
    if (isKauf && refSalePerSqm) {
      refPerSqmUsed = refSalePerSqm;
      expected = Math.round(refSalePerSqm * area * yearFactor * floorFactor * outdoorFactor * conditionFactor * propertyFactor);
    } else if (!isKauf && refRentPerSqm && refRentPerSqm < 500) {
      refPerSqmUsed = refRentPerSqm;
      expected = Math.round(refRentPerSqm * area * yearFactor * floorFactor * outdoorFactor * conditionFactor * propertyFactor);
    } else if (!isKauf && !refRentPerSqm && refSalePerSqm) {
      const estRentPerSqm = Math.round(refSalePerSqm * 0.045 / 12 * 10) / 10;
      refPerSqmUsed = estRentPerSqm;
      expected = Math.round(estRentPerSqm * area * yearFactor * floorFactor * outdoorFactor * conditionFactor * propertyFactor);
      priceSource = priceSource + ' (Miete aus Kaufpreis geschätzt, 4.5% Bruttorendite)';
    } else {
      refPerSqmUsed = 17;
      expected = isKauf ? Math.round(8000 * area * outdoorFactor * conditionFactor) : Math.round(17 * area * outdoorFactor * conditionFactor);
    }
  }

  const delta = (deltaFromData !== undefined && deltaFromData !== null) ? deltaFromData : Math.round((price - expected) / expected * 100);
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

  // ── 4+5+6. GEOAPIFY + SOLAR PARALLEL ──────────────────────────
  let noiseDay = null, noiseSource = 'OSM Strassenkategorie';
  let oevDist = null, oevName = null, oevCount = 0;
  let amenitySummary = '';
  let solarKwh = null;

  const GEOAPIFY_KEY = process.env.GEOAPIFY_API_KEY || '';

  const [placesResult, solarResult] = await Promise.allSettled([
    // GEOAPIFY Places (OEV + Amenities)
    (async () => {
      if (!GEOAPIFY_KEY) throw new Error('No GEOAPIFY_API_KEY');
      const oevUrl = `https://api.geoapify.com/v2/places?categories=public_transport&filter=circle:${lon},${lat},800&limit=50&apiKey=${GEOAPIFY_KEY}`;
      const amenUrl = `https://api.geoapify.com/v2/places?categories=education,commercial.supermarket,catering.restaurant,catering.cafe,leisure.park,healthcare.pharmacy&filter=circle:${lon},${lat},1500&limit=50&apiKey=${GEOAPIFY_KEY}`;
      console.log('GEOAPIFY amenUrl:', amenUrl.replace(GEOAPIFY_KEY, 'KEY'));
      const [oevRes, amenRes] = await Promise.all([
        fetch(oevUrl, { signal: AbortSignal.timeout(8000) }).then(r => r.json()).catch(e => ({ features: [] })),
        fetch(amenUrl, { signal: AbortSignal.timeout(8000) }).then(r => r.json()).catch(e => ({ features: [] }))
      ]);
      return { oev: oevRes, amen: amenRes };
    })(),
    // SOLAR + NOISE WMS (geo.admin.ch LV95)
    (async () => {
      const lat_ = (lat * 3600 - 169028.66) / 10000;
      const lon_ = (lon * 3600 - 26782.5) / 10000;
      const lv95E = Math.round(2600072.37 + 211455.93*lon_ - 10938.51*lon_*lat_ - 0.36*lon_*lat_*lat_ - 44.54*lon_*lon_*lon_);
      const lv95N = Math.round(1200147.07 + 308807.95*lat_ + 3745.25*lon_*lon_ + 76.63*lat_*lat_ - 194.56*lon_*lon_*lat_ + 119.79*lat_*lat_*lat_);
      const lv95Extent = `${lv95E-500},${lv95N-500},${lv95E+500},${lv95N+500}`;
      const solarUrl = `https://api3.geo.admin.ch/rest/services/all/MapServer/identify?geometry=${lv95E},${lv95N}&geometryType=esriGeometryPoint&layers=all:ch.bfe.solarenergie-eignung-daecher&mapExtent=${lv95Extent}&imageDisplay=100,100,96&tolerance=5&returnGeometry=false&sr=2056`;
      // BAFU Lärm via WMS GetMap - tiny 11x11px image, center pixel = our location
      const noiseDelta = 100; // 100m radius
      const noiseBbox = `${lv95E-noiseDelta},${lv95N-noiseDelta},${lv95E+noiseDelta},${lv95N+noiseDelta}`;
      const noiseWmsUrl = `https://wms.geo.admin.ch/?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ch.bafu.laerm-strassenlaerm_tag&CRS=EPSG:2056&BBOX=${noiseBbox}&WIDTH=11&HEIGHT=11&FORMAT=image/png&STYLES=`;
      const [solarRes, noiseRes] = await Promise.all([
        fetch(solarUrl, { signal: AbortSignal.timeout(8000) }).then(r => r.json()),
        fetch(noiseWmsUrl, { signal: AbortSignal.timeout(8000) }).then(r => r.arrayBuffer())
      ]);
      return { solar: solarRes, noisePixels: noiseRes, lv95E, lv95N };
    })()
  ]);

  // Process Geoapify result
  if (placesResult.status === 'fulfilled' && placesResult.value) {
    try {
      const placesValue = placesResult.value;
      const oevFeatures = (placesValue?.oev?.features) || [];
      const amenFeatures = (placesValue?.amen?.features) || [];
      console.log('GEOAPIFY OEV:', oevFeatures.length, '| AMEN:', amenFeatures.length);
      if (amenFeatures.length > 0) {
        console.log('AMEN sample props:', JSON.stringify(amenFeatures[0].properties).substring(0,300));
      } else {
        console.log('AMEN response keys:', Object.keys(amenRes||{}), 'total:', amenRes?.features?.length);
      }
      if (amenFeatures.length > 0) {
        console.log('AMEN sample:', JSON.stringify(amenFeatures[0].properties?.categories).substring(0,100));
      }

      // OEV
      oevCount = oevFeatures.length;
      if (oevFeatures.length > 0) {
        let minDist = Infinity;
        oevFeatures.forEach(f => {
          try {
            const coords2 = f.geometry?.coordinates || [0,0];
            const flon2 = coords2[0], flat2 = coords2[1];
            if (!flat2 || !flon2) return;
            const dLat=(flat2-lat)*Math.PI/180, dLon=(flon2-lon)*Math.PI/180;
            const a=Math.sin(dLat/2)**2+Math.cos(lat*Math.PI/180)*Math.cos(flat2*Math.PI/180)*Math.sin(dLon/2)**2;
            const dist=6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
            if (dist < minDist) {
              minDist=dist;
              oevName = f.properties?.name || f.properties?.address_line1 || f.properties?.datasource?.raw?.name || 'Haltestelle';
            }
          } catch(err) {}
        });
        if (minDist < Infinity) { oevDist = Math.round(minDist); oevCount = oevFeatures.length; }
      }

      // Amenities
      const groups = { Schulen:[], Einkauf:[], Gastro:[], Parks:[], Gesundheit:[] };
      if (amenFeatures.length > 0) console.log('AMEN sample:', JSON.stringify(amenFeatures[0].properties).substring(0,200));
      amenFeatures.forEach(f => {
        const cats = f.properties?.categories || [];
        const name = f.properties?.name || f.properties?.street || 'unbekannt';
        const [flon, flat] = f.geometry.coordinates;
        const dLat=(flat-lat)*Math.PI/180, dLon=(flon-lon)*Math.PI/180;
        const a=Math.sin(dLat/2)**2+Math.cos(lat*Math.PI/180)*Math.cos(flat*Math.PI/180)*Math.sin(dLon/2)**2;
        const dist=Math.round(6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)));
        const catStr = cats.join(',');
        if ((catStr.includes('education')) && groups.Schulen.length<3) groups.Schulen.push(`${name} ${dist}m`);
        if ((catStr.includes('supermarket') || catStr.includes('grocery')) && groups.Einkauf.length<3) groups.Einkauf.push(`${name} ${dist}m`);
        if ((catStr.includes('catering.restaurant') || catStr.includes('catering.cafe')) && groups.Gastro.length<3) groups.Gastro.push(`${name} ${dist}m`);
        if ((catStr.includes('park') || catStr.includes('natural')) && groups.Parks.length<2) groups.Parks.push(`${name} ${dist}m`);
        if (catStr.includes('healthcare') && groups.Gesundheit.length<2) groups.Gesundheit.push(`${name} ${dist}m`);
      });
      amenitySummary = Object.entries(groups).filter(([,v])=>v.length).map(([k,v])=>`${k}: ${v.join(', ')}`).join('\n');
      // Noise: BAFU will set the value if available, otherwise stays null
      console.log('NOISE:', noiseDay, '| OEV:', oevDist, oevName, '| AMENITIES:', amenitySummary.length);
    } catch(e) { console.log('GEOAPIFY process error:', e.message); }
  } else {
    console.log('GEOAPIFY failed:', placesResult.reason?.message || 'no key');
    // Fallback: qualitative noise from address context
    noiseDay = null;
  }

  // Process Solar + BAFU Noise result
  if (solarResult.status === 'fulfilled' && solarResult.value) {
    try {
      const val = solarResult.value;
      // Handle both old format (direct json) and new format {solar, noisePixels, lv95E, lv95N}
      const solarData = val.solar || val;
      const noisePixels = val.noisePixels || null;
      const lv95E = val.lv95E || null;
      const lv95N = val.lv95N || null;

      // Solar
      const results = solarData?.results || [];
      console.log('SOLAR results:', results.length);
      if (results.length) {
        const props = results[0].attributes || results[0].properties || {};
        const klasse = props.klasse;
        const gstrahlung = props.gstrahlung;
        solarKwh = klasse ? [null,600,750,900,1050,1200][klasse] : (gstrahlung ? gstrahlung/10 : null);
        console.log('SOLAR field picked:', {klasse, gstrahlung, val: solarKwh});
      }

      // BAFU Noise via PNG pixel color decoding
      if (noisePixels && lv95E && lv95N) {
        try {
          const buf = Buffer.from(noisePixels);
          const isPng = buf.length > 8 && buf[0]===137 && buf[1]===80;
          console.log('BAFU NOISE PNG received, size:', buf.length, 'isPng:', isPng);
          if (isPng) {
            // Decode PNG: find IDAT chunk, decompress, read center pixel
            // PNG structure: 8-byte signature, then chunks (4-len, 4-type, data, 4-crc)
            let pos = 8; // skip signature
            let ihdrWidth=11, ihdrHeight=11, bitDepth=8, colorType=2;
            let idatData = Buffer.alloc(0);

            while (pos < buf.length - 8) {
              const chunkLen = buf.readUInt32BE(pos);
              const chunkType = buf.slice(pos+4, pos+8).toString('ascii');
              if (chunkType === 'IHDR') {
                ihdrWidth = buf.readUInt32BE(pos+8);
                ihdrHeight = buf.readUInt32BE(pos+12);
                bitDepth = buf[pos+16];
                colorType = buf[pos+17];
              } else if (chunkType === 'IDAT') {
                idatData = Buffer.concat([idatData, buf.slice(pos+8, pos+8+chunkLen)]);
              } else if (chunkType === 'IEND') break;
              pos += 12 + chunkLen;
            }

            if (idatData.length > 0) {
              const zlib = await import('zlib');
              const raw = await new Promise((res, rej) => zlib.inflate(idatData, (err, d) => err ? rej(err) : res(d)));
              // PNG scanlines: each row has 1 filter byte + width*channels bytes
              const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 1;
              const bytesPerRow = 1 + ihdrWidth * channels;
              const centerRow = Math.floor(ihdrHeight / 2);
              const centerCol = Math.floor(ihdrWidth / 2);
              const rowStart = centerRow * bytesPerRow + 1; // +1 skip filter byte
              const pixelStart = rowStart + centerCol * channels;
              const r = raw[pixelStart];
              const g = raw[pixelStart+1];
              const b = raw[pixelStart+2];
              const a = channels === 4 ? raw[pixelStart+3] : 255;
              console.log('BAFU NOISE center pixel RGBA:', r, g, b, a);

              // Map BAFU color to dB using HSV hue (more robust than RGB thresholds)
              // Alpha-blend with white background first
              const ra = Math.round((r * a + 255 * (255-a)) / 255);
              const ga = Math.round((g * a + 255 * (255-a)) / 255);
              const ba = Math.round((b * a + 255 * (255-a)) / 255);

              // Transparent/near-white = no road noise data
              if (a < 30 || (ra > 240 && ga > 240 && ba > 240)) {
                noiseDay = 35;
                noiseSource = 'BAFU (ruhige Lage)';
                console.log('BAFU NOISE: no data = quiet location');
              } else {
                // HSV hue classification
                const maxC = Math.max(ra,ga,ba)/255, minC = Math.min(ra,ga,ba)/255;
                const delta = maxC - minC;
                let hue = 0;
                if (delta > 0.05) {
                  if (maxC === ra/255) hue = 60 * (((ga-ba)/255/delta) % 6);
                  else if (maxC === ga/255) hue = 60 * ((ba-ra)/255/delta + 2);
                  else hue = 60 * ((ra-ga)/255/delta + 4);
                  if (hue < 0) hue += 360;
                }
                const sat = maxC > 0 ? delta/maxC : 0;

                console.log('BAFU NOISE HSV hue:', Math.round(hue), 'sat:', sat.toFixed(2), 'alpha:', a);

                if (sat < 0.15) {
                  // Greyscale = no meaningful data, use OSM fallback
                  console.log('BAFU NOISE: low saturation, OSM fallback');
                } else if (hue >= 80 && hue <= 160) {
                  // Green: < 55 dB
                  noiseDay = 50; noiseSource = 'BAFU Strassenlaerm';
                } else if (hue >= 50 && hue < 80) {
                  // Yellow-green: 55-60 dB
                  noiseDay = 57; noiseSource = 'BAFU Strassenlaerm';
                } else if (hue >= 25 && hue < 50) {
                  // Orange: 60-65 dB (our test case: hue=40)
                  noiseDay = 62; noiseSource = 'BAFU Strassenlaerm';
                } else if ((hue >= 0 && hue < 25) || hue >= 345) {
                  // Red: 65-70 dB
                  noiseDay = 67; noiseSource = 'BAFU Strassenlaerm';
                } else if (hue >= 270 && hue < 345) {
                  // Purple/dark: > 70 dB
                  noiseDay = 73; noiseSource = 'BAFU Strassenlaerm';
                } else {
                  console.log('BAFU NOISE: unclassified hue', Math.round(hue), '- OSM fallback');
                }
                if (noiseDay && noiseSource === 'BAFU Strassenlaerm') {
                  console.log('BAFU NOISE:', noiseDay, 'dB from hue:', Math.round(hue));
                }
              }
              if (noiseDay && noiseSource === 'BAFU Strassenlaerm') {
                console.log('BAFU NOISE dB:', noiseDay, 'from color RGB:', r, g, b);
              }
            }
          }
        } catch(noiseErr) {
          console.log('BAFU NOISE parse error:', noiseErr.message);
        }
      }
    } catch(e) { console.log('SOLAR/NOISE process error:', e.message); }
  } else { console.log('SOLAR error:', solarResult.reason?.message); }

  // ── 7. CRIME ────────────────────────────────────────────────────
  const CRIME = {
    'zürich':{hzahl:98,label:'Zürich'},'zuerich':{hzahl:98,label:'Zürich'},'zurich':{hzahl:98,label:'Zürich'},
    'bern':{hzahl:72,label:'Bern'},'berne':{hzahl:72,label:'Bern'},
    'basel':{hzahl:85,label:'Basel'},'bale':{hzahl:85,label:'Basel'},
    'genf':{hzahl:110,label:'Genf'},'geneve':{hzahl:110,label:'Genf'},'geneva':{hzahl:110,label:'Genf'},
    'winterthur':{hzahl:62,label:'Winterthur'},
    'luzern':{hzahl:58,label:'Luzern'},'lucerne':{hzahl:58,label:'Luzern'},
    'lausanne':{hzahl:95,label:'Lausanne'},'lugano':{hzahl:65,label:'Lugano'},
    'locarno':{hzahl:48,label:'Locarno'},'bellinzona':{hzahl:42,label:'Bellinzona'},
    'sion':{hzahl:52,label:'Sion'},'sitten':{hzahl:52,label:'Sion'},
    'freiburg':{hzahl:55,label:'Freiburg'},'fribourg':{hzahl:55,label:'Fribourg'},
    'biel':{hzahl:68,label:'Biel'},'bienne':{hzahl:68,label:'Biel/Bienne'},
    'neuchatel':{hzahl:72,label:'Neuchâtel'},'neuenburg':{hzahl:72,label:'Neuchâtel'},
    'kilchberg':{hzahl:18,label:'Kilchberg'},'küsnacht':{hzahl:16,label:'Küsnacht'},
    'thalwil':{hzahl:22,label:'Thalwil'},'zollikon':{hzahl:20,label:'Zollikon'},
    'uster':{hzahl:45,label:'Uster'},'laax':{hzahl:12,label:'Laax'},
    'davos':{hzahl:35,label:'Davos'},'st. gallen':{hzahl:54,label:'St. Gallen'},
  };
  const labelLower = (label||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const plzMatch2 = labelLower.match(/\b\d{4}\b\s+(.+)$/);
  const communeLower = plzMatch2 ? plzMatch2[1].trim() : labelLower;
  console.log('COMMUNE for lookup:', communeLower);
  let crime = {hzahl:38,label:'diese Gemeinde'};
  for (const [key,val] of Object.entries(CRIME)) {
    if (communeLower.includes(key)) { crime = val; break; }
  }

  // Steuerfuss-Lookup: ZH komplett (160 Gemeinden, Stand 2026)

  // ── 8. STEUERFUSS (ESTV 2025 — 2122 Gemeinden, ledig, CHF 150k Brutto, ohne Kirche) ──
  // Quelle: ESTV „Gesamtsteuerbelastung des Bruttoarbeitseinkommens", 2025
  // Enthält: Bundes- + Kantons- + Gemeindesteuer (ohne Kirchensteuer)
  // Format: 'gemeinde_lower': [total_chf, total_pct, canton, bfs_nr]
  const ESTV_BURDEN = {
  'aadorf':[25554,17.04,'TG',4551],
  'aarau':[24845,16.56,'AG',4001],
  'aarberg':[31686,21.12,'BE',301],
  'aarburg':[26761,17.84,'AG',4271],
  'aarwangen':[30671,20.45,'BE',321],
  'abtwil':[26474,17.65,'AG',4221],
  'aclens':[29910,19.94,'VD',5621],
  'acquarossa':[28877,19.25,'TI',5048],
  'adelboden':[33041,22.03,'BE',561],
  'adligenswil':[24674,16.45,'LU',1051],
  'adliswil':[22798,15.2,'ZH',131],
  'aedermannsdorf':[31321,20.88,'SO',2421],
  'aefligen':[32815,21.88,'BE',401],
  'aegerten':[31912,21.27,'BE',731],
  'aesch':[23834,15.89,'LU',1021],
  'aesch (bl)':[31139,20.76,'BL',2761],
  'aeschi (so)':[31088,20.73,'SO',2511],
  'aeschi bei spiez':[31912,21.27,'BE',562],
  'aeugst am albis':[21732,14.49,'ZH',1],
  'affeltrangen':[25243,16.83,'TG',4711],
  'affoltern am albis':[24573,16.38,'ZH',2],
  'affoltern im emmental':[32307,21.54,'BE',951],
  'agarn':[33186,22.12,'VS',6101],
  'agiez':[31810,21.21,'VD',5742],
  'agno':[27288,18.19,'TI',5141],
  'aigle':[30622,20.41,'VD',5401],
  'aire-la-ville':[30715,20.48,'GE',6601],
  'airolo':[27899,18.6,'TI',5061],
  'alberswil':[25235,16.82,'LU',1121],
  'albinen':[33501,22.33,'VS',6102],
  'albula/alvra':[26318,17.55,'GR',3542],
  'alchenstorf':[31686,21.12,'BE',402],
  'allaman':[30504,20.34,'VD',5851],
  'alle':[32220,21.48,'JU',6771],
  'allmendingen':[28865,19.24,'BE',630],
  'allschwil':[31474,20.98,'BL',2762],
  'alpnach':[22341,14.89,'OW',1401],
  'alpthal':[16849,11.23,'SZ',1361],
  'altbüron':[27195,18.13,'LU',1122],
  'altdorf (ur)':[20795,13.86,'UR',1201],
  'altendorf':[14815,9.88,'SZ',1341],
  'altikon':[23863,15.91,'ZH',211],
  'altishofen':[24114,16.08,'LU',1123],
  'altnau':[24698,16.47,'TG',4641],
  'alto malcantone':[28266,18.84,'TI',5237],
  'altstätten':[25632,17.09,'SG',3251],
  'amden':[25243,16.83,'SG',3311],
  'amlikon-bissegg':[25865,17.24,'TG',4881],
  'ammerswil':[26090,17.39,'AG',4191],
  'amriswil':[25787,17.19,'TG',4461],
  'amsoldingen':[32251,21.5,'BE',921],
  'andeer':[25226,16.82,'GR',3701],
  'andelfingen':[24129,16.09,'ZH',291],
  'andermatt':[21118,14.08,'UR',1202],
  'andwil':[26216,17.48,'SG',3441],
  'anières':[28017,18.68,'GE',6602],
  'anniviers':[32915,21.94,'VS',6252],
  'anwil':[31809,21.21,'BL',2841],
  'appenzell':[19755,13.17,'AI',3101],
  'aranno':[28510,19.01,'TI',5143],
  'arbaz':[32915,21.94,'VS',6261],
  'arbedo-castione':[28388,18.93,'TI',5001],
  'arboldswil':[31641,21.09,'BL',2881],
  'arbon':[27265,18.18,'TG',4401],
  'arch':[31686,21.12,'BE',381],
  'ardon':[32598,21.73,'VS',6021],
  'arisdorf':[31641,21.09,'BL',2821],
  'aristau':[25612,17.07,'AG',4222],
  'arlesheim':[29632,19.75,'BL',2763],
  'arnex-sur-nyon':[30860,20.57,'VD',5701],
  'arnex-sur-orbe':[31216,20.81,'VD',5743],
  'arni':[31630,21.09,'BE',602],
  'arni (ag)':[23600,15.73,'AG',4061],
  'arogno':[28877,19.25,'TI',5144],
  'arosa':[25226,16.82,'GR',3921],
  'arth':[15812,10.54,'SZ',1362],
  'arzier-le muids':[30385,20.26,'VD',5702],
  'ascona':[26432,17.62,'TI',5091],
  'assens':[31098,20.73,'VD',5511],
  'astano':[28877,19.25,'TI',5146],
  'attalens':[30566,20.38,'FR',2321],
  'attinghausen':[20957,13.97,'UR',1203],
  'attiswil':[31066,20.71,'BE',971],
  'au':[24271,16.18,'SG',3231],
  'aubonne':[30860,20.57,'VD',5422],
  'auenstein':[24558,16.37,'AG',4091],
  'augst':[30637,20.42,'BL',2822],
  'ausserberg':[33691,22.46,'VS',6191],
  'auswil':[31686,21.12,'BE',322],
  'autigny':[32249,21.5,'FR',2173],
  'auw':[25803,17.2,'AG',4223],
  'avegno gordevio':[28877,19.25,'TI',5324],
  'avenches':[30504,20.34,'VD',5451],
  'avers':[27411,18.27,'GR',3681],
  'avry':[29190,19.46,'FR',2174],
  'avully':[30857,20.57,'GE',6603],
  'avusy':[30715,20.48,'GE',6604],
  'ayent':[32953,21.97,'VS',6082],
  'baar':[13165,8.78,'ZG',1701],
  'bachenbülach':[23153,15.44,'ZH',51],
  'bachs':[25106,16.74,'ZH',81],
  'bad ragaz':[24174,16.12,'SG',3291],
  'baden':[24462,16.31,'AG',4021],
  'balerna':[26432,17.62,'TI',5242],
  'balgach':[21160,14.11,'SG',3232],
  'ballaigues':[30504,20.34,'VD',5744],
  'ballens':[31454,20.97,'VD',5423],
  'ballwil':[22154,14.77,'LU',1023],
  'balm bei günsberg':[28783,19.19,'SO',2541],
  'balsthal':[31670,21.11,'SO',2422],
  'baltschieder':[31544,21.03,'VS',6281],
  'bannwil':[31969,21.31,'BE',323],
  'bardonnex':[29721,19.81,'GE',6605],
  'bargen':[32194,21.46,'BE',302],
  'bargen (sh)':[24867,16.58,'SH',2931],
  'bas-intyamon':[31254,20.84,'FR',2162],
  'basadingen-schlattingen':[24621,16.41,'TG',4536],
  'basel':[27406,18.27,'BS',2701],
  'basse-allaine':[32753,21.84,'JU',6807],
  'basse-vendline':[31420,20.95,'JU',6812],
  'bassersdorf':[23863,15.91,'ZH',52],
  'bassins':[31394,20.93,'VD',5703],
  'baulmes':[31870,21.25,'VD',5745],
  'bauma':[24395,16.26,'ZH',297],
  'bavois':[31335,20.89,'VD',5746],
  'beatenberg':[32985,21.99,'BE',571],
  'beckenried':[19743,13.16,'NW',1501],
  'bedano':[26799,17.87,'TI',5148],
  'bedigliora':[28877,19.25,'TI',5149],
  'bedretto':[24598,16.4,'TI',5063],
  'beggingen':[26506,17.67,'SH',2951],
  'begnins':[30207,20.14,'VD',5704],
  'beinwil (freiamt)':[25037,16.69,'AG',4224],
  'beinwil (so)':[31690,21.13,'SO',2612],
  'beinwil am see':[25420,16.95,'AG',4131],
  'belfaux':[31371,20.91,'FR',2175],
  'bellach':[31670,21.11,'SO',2542],
  'bellevue':[29153,19.44,'GE',6606],
  'bellikon':[24175,16.12,'AG',4022],
  'bellinzona':[28632,19.09,'TI',5002],
  'bellmund':[29147,19.43,'BE',732],
  'bellwald':[32865,21.91,'VS',6052],
  'belmont-broye':[30493,20.33,'FR',2053],
  'belmont-sur-lausanne':[31335,20.89,'VD',5581],
  'belmont-sur-yverdon':[31098,20.73,'VD',5902],
  'belp':[29711,19.81,'BE',861],
  'belprahon':[32702,21.8,'BE',681],
  'benken':[26605,17.74,'SG',3312],
  'bennwil':[32479,21.65,'BL',2882],
  'bercher':[32166,21.44,'VD',5512],
  'berg':[27188,18.13,'SG',3211],
  'berg (tg)':[24154,16.1,'TG',4891],
  'berg am irchel':[22442,14.96,'ZH',23],
  'bergdietikon':[23696,15.8,'AG',4023],
  'bergün filisur':[26318,17.55,'GR',3544],
  'berikon':[24175,16.12,'AG',4062],
  'beringen':[23664,15.78,'SH',2932],
  'berken':[28018,18.68,'BE',972],
  'berlingen':[23532,15.69,'TG',4801],
  'bern':[30501,20.33,'BE',351],
  'berneck':[24174,16.12,'SG',3233],
  'bernex':[30431,20.29,'GE',6607],
  'berolle':[31751,21.17,'VD',5424],
  'beromünster':[24114,16.08,'LU',1081],
  'besenbüren':[26474,17.65,'AG',4226],
  'bettenhausen':[30558,20.37,'BE',973],
  'bettens':[31098,20.73,'VD',5471],
  'bettingen':[24608,16.41,'BS',2702],
  'bettlach':[28657,19.1,'SO',2543],
  'bettmeralp':[32644,21.76,'VS',6205],
  'bettwiesen':[24854,16.57,'TG',4716],
  'bettwil':[25420,16.95,'AG',4227],
  'bever':[23042,15.36,'GR',3781],
  'bex':[31216,20.81,'VD',5402],
  'biasca':[28877,19.25,'TI',5281],
  'biberist':[31670,21.11,'SO',2513],
  'biberstein':[24750,16.5,'AG',4002],
  'bichelsee-balterswil':[25165,16.78,'TG',4721],
  'biel-benken':[29465,19.64,'BL',2764],
  'biel/bienne':[31009,20.67,'BE',371],
  'biezwil':[31690,21.13,'SO',2445],
  'biglen':[32533,21.69,'BE',603],
  'billens-hennens':[32981,21.99,'FR',2063],
  'binn':[31956,21.3,'VS',6054],
  'binningen':[29967,19.98,'BL',2765],
  'bioggio':[25210,16.81,'TI',5151],
  'bioley-magnoux':[31335,20.89,'VD',5903],
  'birmensdorf':[23685,15.79,'ZH',242],
  'birmenstorf (ag)':[25037,16.69,'AG',4024],
  'birr':[26857,17.9,'AG',4092],
  'birrhard':[26090,17.39,'AG',4093],
  'birrwil':[24750,16.5,'AG',4132],
  'birsfelden':[32144,21.43,'BL',2766],
  'birwinken':[25321,16.88,'TG',4901],
  'bischofszell':[25787,17.19,'TG',4471],
  'bissone':[25699,17.13,'TI',5154],
  'bister':[29125,19.42,'VS',6172],
  'bitsch':[29125,19.42,'VS',6173],
  'bière':[30979,20.65,'VD',5425],
  'blatten':[34887,23.26,'VS',6192],
  'blauen':[31725,21.15,'BL',2781],
  'bleienbach':[29993,20.0,'BE',324],
  'blenio':[28266,18.84,'TI',5049],
  'blonay - saint-légier':[30801,20.53,'VD',5892],
  'blumenstein':[31686,21.12,'BE',922],
  'bodio':[28877,19.25,'TI',5064],
  'bofflens':[30979,20.65,'VD',5747],
  'bogis-bossey':[31098,20.73,'VD',5705],
  'bois-d\'amont':[31517,21.01,'FR',2238],
  'bolken':[34025,22.68,'SO',2514],
  'bolligen':[30840,20.56,'BE',352],
  'boltigen':[32533,21.69,'BE',791],
  'bonaduz':[24571,16.38,'GR',3721],
  'boncourt':[28487,18.99,'JU',6774],
  'boningen':[31680,21.12,'SO',2571],
  'boniswil':[25707,17.14,'AG',4192],
  'bonstetten':[23419,15.61,'ZH',3],
  'bonvillars':[30741,20.49,'VD',5551],
  'boppelsen':[22087,14.72,'ZH',82],
  'borex':[29554,19.7,'VD',5706],
  'bosco/gurin':[29488,19.66,'TI',5304],
  'bossonnens':[32249,21.5,'FR',2323],
  'boswil':[25324,16.88,'AG',4228],
  'bottens':[31394,20.93,'VD',5514],
  'bottenwil':[27048,18.03,'AG',4273],
  'botterens':[31517,21.01,'FR',2123],
  'bottighofen':[20887,13.92,'TG',4643],
  'bottmingen':[29800,19.87,'BL',2767],
  'boudry':[33871,22.58,'NE',6404],
  'bougy-villars':[30147,20.1,'VD',5426],
  'boulens':[31276,20.85,'VD',5661],
  'bourg-en-lavaux':[30207,20.14,'VD',5613],
  'bourg-saint-pierre':[29125,19.42,'VS',6032],
  'bournens':[30504,20.34,'VD',5472],
  'bourrignon':[32220,21.48,'JU',6703],
  'boussens':[30385,20.26,'VD',5473],
  'bovernier':[31956,21.3,'VS',6131],
  'bowil':[32194,21.46,'BE',605],
  'boécourt':[30887,20.59,'JU',6702],
  'braunau':[24932,16.62,'TG',4723],
  'bregaglia':[25226,16.82,'GR',3792],
  'breggia':[28877,19.25,'TI',5269],
  'breil/brigels':[25226,16.82,'GR',3981],
  'breitenbach':[30325,20.22,'SO',2613],
  'bremblens':[30860,20.57,'VD',5622],
  'bremgarten (ag)':[25612,17.07,'AG',4063],
  'bremgarten bei bern':[30219,20.15,'BE',353],
  'brenzikofen':[32307,21.54,'BE',606],
  'bretigny-sur-morrens':[31810,21.21,'VD',5515],
  'bretonnières':[30989,20.66,'VD',5748],
  'bretzwil':[31474,20.98,'BL',2883],
  'brienz':[31686,21.12,'BE',573],
  'brienzwiler':[31066,20.71,'BE',574],
  'brig-glis':[29125,19.42,'VS',6002],
  'brione sopra minusio':[26799,17.87,'TI',5096],
  'brislach':[31307,20.87,'BL',2782],
  'brissago':[27654,18.44,'TI',5097],
  'brittnau':[26569,17.71,'AG',4274],
  'broc':[32542,21.69,'FR',2124],
  'brot-plamboz':[34923,23.28,'NE',6433],
  'brugg':[24941,16.63,'AG',4095],
  'brunegg':[25707,17.14,'AG',4193],
  'brusino arsizio':[27654,18.44,'TI',5160],
  'brusio':[24680,16.45,'GR',3551],
  'brügg':[31348,20.9,'BE',733],
  'brünisried':[32103,21.4,'FR',2292],
  'brüttelen':[32533,21.69,'BE',491],
  'brütten':[21288,14.19,'ZH',213],
  'bubendorf':[31809,21.21,'BL',2823],
  'bubikon':[24218,16.15,'ZH',112],
  'buch (sh)':[24211,16.14,'SH',2961],
  'buch am irchel':[23153,15.44,'ZH',24],
  'buchberg':[20166,13.44,'SH',2933],
  'buchegg':[29926,19.95,'SO',2465],
  'buchholterberg':[31969,21.31,'BE',923],
  'buchillon':[28960,19.31,'VD',5623],
  'buchrain':[24674,16.45,'LU',1052],
  'buchs':[26702,17.8,'SG',3271],
  'buchs (ag)':[26952,17.97,'AG',4003],
  'buckten':[32479,21.65,'BL',2843],
  'bulle':[29951,19.97,'FR',2125],
  'bullet':[31335,20.89,'VD',5552],
  'buochs':[20996,14.0,'NW',1502],
  'bure':[32220,21.48,'JU',6778],
  'burg im leimental':[33148,22.1,'BL',2783],
  'burgdorf':[31009,20.67,'BE',404],
  'burgistein':[32815,21.88,'BE',863],
  'bursinel':[30147,20.1,'VD',5852],
  'bursins':[31216,20.81,'VD',5853],
  'burtigny':[31691,21.13,'VD',5854],
  'buseno':[26318,17.55,'GR',3804],
  'bussigny':[30207,20.14,'VD',5624],
  'bussnang':[25009,16.67,'TG',4921],
  'busswil bei melchnau':[30840,20.56,'BE',325],
  'bussy-sur-moudon':[32117,21.41,'VD',5663],
  'buttisholz':[24394,16.26,'LU',1083],
  'buttwil':[25420,16.95,'AG',4230],
  'buus':[31474,20.98,'BL',2844],
  'bäretswil':[23153,15.44,'ZH',111],
  'bäriswil':[31066,20.71,'BE',403],
  'bärschwil':[31690,21.13,'SO',2611],
  'bätterkinden':[31969,21.31,'BE',533],
  'bättwil':[31341,20.89,'SO',2471],
  'böckten':[31641,21.09,'BL',2842],
  'bönigen':[32533,21.69,'BE',572],
  'bösingen':[30200,20.13,'FR',2295],
  'böttstein':[25899,17.27,'AG',4303],
  'bözberg':[24845,16.56,'AG',4124],
  'böztal':[26569,17.71,'AG',4185],
  'büetigen':[30558,20.37,'BE',382],
  'bühl':[30558,20.37,'BE',734],
  'bühler':[25808,17.21,'AR',3021],
  'bülach':[23863,15.91,'ZH',53],
  'bünzen':[26186,17.46,'AG',4229],
  'bürchen':[33476,22.32,'VS',6193],
  'büren (so)':[31670,21.11,'SO',2472],
  'büren an der aare':[31066,20.71,'BE',383],
  'bürglen (tg)':[25243,16.83,'TG',4911],
  'bürglen (ur)':[20554,13.7,'UR',1205],
  'büron':[24394,16.26,'LU',1082],
  'büsserach':[30042,20.03,'SO',2614],
  'bütschwil-ganterschwil':[26799,17.87,'SG',3395],
  'büttenhardt':[23008,15.34,'SH',2914],
  'büttikon':[24845,16.56,'AG',4064],
  'cademario':[28877,19.25,'TI',5161],
  'cadempino':[25821,17.21,'TI',5162],
  'cadenazzo':[28021,18.68,'TI',5003],
  'calanca':[26318,17.55,'GR',3837],
  'cama':[23369,15.58,'GR',3831],
  'campo (vallemaggia)':[25210,16.81,'TI',5307],
  'canobbio':[26799,17.87,'TI',5167],
  'capriasca':[28754,19.17,'TI',5226],
  'carouge (ge)':[29295,19.53,'GE',6608],
  'cartigny':[29579,19.72,'GE',6609],
  'caslano':[27654,18.44,'TI',5171],
  'castaneda':[25226,16.82,'GR',3805],
  'castel san pietro':[25210,16.81,'TI',5249],
  'cazis':[27957,18.64,'GR',3661],
  'celerina/schlarigna':[20857,13.9,'GR',3782],
  'centovalli':[28877,19.25,'TI',5397],
  'cerentino':[29488,19.66,'TI',5309],
  'cevio':[28754,19.17,'TI',5310],
  'chalais':[33476,22.32,'VS',6232],
  'cham':[13349,8.9,'ZG',1702],
  'chamblon':[30622,20.41,'VD',5904],
  'chamoson':[32991,21.99,'VS',6022],
  'champagne':[30504,20.34,'VD',5553],
  'champoz':[31404,20.94,'BE',683],
  'champtauroz':[31929,21.29,'VD',5812],
  'champvent':[31098,20.73,'VD',5905],
  'champéry':[34175,22.78,'VS',6151],
  'chancy':[30857,20.57,'GE',6611],
  'chardonne':[30860,20.57,'VD',5882],
  'chavannes-de-bogis':[29672,19.78,'VD',5707],
  'chavannes-des-bois':[30622,20.41,'VD',5708],
  'chavannes-le-chêne':[31701,21.13,'VD',5907],
  'chavannes-le-veyron':[31929,21.29,'VD',5475],
  'chavannes-près-renens':[31988,21.33,'VD',5627],
  'chavannes-sur-moudon':[31098,20.73,'VD',5665],
  'chavornay':[31157,20.77,'VD',5749],
  'cheseaux-noréaz':[30741,20.49,'VD',5909],
  'cheseaux-sur-lausanne':[31454,20.97,'VD',5582],
  'chessel':[30504,20.34,'VD',5403],
  'chevilly':[31098,20.73,'VD',5476],
  'chevroux':[30919,20.61,'VD',5813],
  'chexbres':[30801,20.53,'VD',5601],
  'cheyres-châbles':[29321,19.55,'FR',2055],
  'chiasso':[28021,18.68,'TI',5250],
  'chigny':[30147,20.1,'VD',5628],
  'chippis':[32354,21.57,'VS',6235],
  'choulex':[29295,19.53,'GE',6614],
  'chur':[25008,16.67,'GR',3901],
  'churwalden':[25226,16.82,'GR',3911],
  'château-d\'oex':[32463,21.64,'VD',5841],
  'châtel-saint-denis':[31312,20.87,'FR',2325],
  'châtel-sur-montsalvens':[30712,20.47,'FR',2128],
  'châtillon (fr)':[28589,19.06,'FR',2008],
  'châtillon (ju)':[30887,20.59,'JU',6704],
  'châtonnaye':[31517,21.01,'FR',2068],
  'chénens':[32498,21.67,'FR',2177],
  'chéserex':[29791,19.86,'VD',5709],
  'chêne-bougeries':[28159,18.77,'GE',6612],
  'chêne-bourg':[30147,20.1,'GE',6613],
  'chêne-pâquier':[31691,21.13,'VD',5908],
  'clarmont':[31335,20.89,'VD',5629],
  'clos du doubs':[31687,21.12,'JU',6808],
  'coeuve':[32753,21.84,'JU',6781],
  'coinsins':[28603,19.07,'VD',5710],
  'coldrerio':[27043,18.03,'TI',5251],
  'collex-bossy':[30147,20.1,'GE',6615],
  'collina d\'oro':[24598,16.4,'TI',5236],
  'collombey-muraz':[31874,21.25,'VS',6152],
  'collonge-bellerive':[27591,18.39,'GE',6616],
  'collonges':[30677,20.45,'VS',6211],
  'cologny':[27165,18.11,'GE',6617],
  'comano':[26432,17.62,'TI',5176],
  'commugny':[29554,19.7,'VD',5711],
  'concise':[30979,20.65,'VD',5554],
  'confignon':[30147,20.1,'GE',6618],
  'conters im prättigau':[21949,14.63,'GR',3881],
  'conthey':[31664,21.11,'VS',6023],
  'coppet':[29554,19.7,'VD',5712],
  'corbeyrier':[31573,21.05,'VD',5404],
  'corbières':[29834,19.89,'FR',2129],
  'corcelles':[32759,21.84,'BE',687],
  'corcelles-le-jorat':[31691,21.13,'VD',5785],
  'corcelles-près-concise':[30979,20.65,'VD',5555],
  'corcelles-près-payerne':[30504,20.34,'VD',5816],
  'corgémont':[31912,21.27,'BE',431],
  'corminboeuf':[30053,20.04,'FR',2183],
  'cormoret':[33323,22.22,'BE',432],
  'cornaux':[34773,23.18,'NE',6451],
  'cornol':[31153,20.77,'JU',6782],
  'corseaux':[30801,20.53,'VD',5883],
  'corsier (ge)':[27875,18.58,'GE',6619],
  'corsier-sur-vevey':[30444,20.3,'VD',5884],
  'cortaillod':[33571,22.38,'NE',6408],
  'cortébert':[33041,22.03,'BE',433],
  'cossonay':[30622,20.41,'VD',5477],
  'cottens (fr)':[30785,20.52,'FR',2186],
  'courchapoix':[31687,21.12,'JU',6706],
  'courchavon':[30353,20.24,'JU',6783],
  'courgenay':[31153,20.77,'JU',6784],
  'courgevaux':[30200,20.13,'FR',2250],
  'courrendlin':[32220,21.48,'JU',6708],
  'courroux':[31687,21.12,'JU',6709],
  'court':[32759,21.84,'BE',690],
  'courtedoux':[31953,21.3,'JU',6785],
  'courtelary':[33888,22.59,'BE',434],
  'courtepin':[30785,20.52,'FR',2254],
  'courtételle':[29020,19.35,'JU',6710],
  'crans (vd)':[29791,19.86,'VD',5713],
  'crans-montana':[30658,20.44,'VS',6253],
  'crassier':[30504,20.34,'VD',5714],
  'cressier (fr)':[29029,19.35,'FR',2257],
  'cressier (ne)':[35224,23.48,'NE',6452],
  'crissier':[30326,20.22,'VD',5583],
  'cronay':[31701,21.13,'VD',5910],
  'croy':[31573,21.05,'VD',5752],
  'crémines':[32759,21.84,'BE',691],
  'crésuz':[28882,19.25,'FR',2130],
  'cuarnens':[31810,21.21,'VD',5479],
  'cuarny':[31939,21.29,'VD',5911],
  'cudrefin':[29791,19.86,'VD',5456],
  'cugnasco-gerra':[28266,18.84,'TI',5138],
  'cugy (fr)':[31517,21.01,'FR',2011],
  'cugy (vd)':[31810,21.21,'VD',5516],
  'cureglia':[26432,17.62,'TI',5180],
  'curio':[28877,19.25,'TI',5181],
  'curtilles':[31454,20.97,'VD',5669],
  'céligny':[28301,18.87,'GE',6610],
  'dachsen':[23596,15.73,'ZH',25],
  'dagmersellen':[23274,15.52,'LU',1125],
  'daillens':[30622,20.41,'VD',5480],
  'dallenwil':[21755,14.5,'NW',1503],
  'dalpe':[25821,17.21,'TI',5071],
  'damphreux-lugnez':[31687,21.12,'JU',6811],
  'dardagny':[30431,20.29,'GE',6620],
  'davos':[25772,17.18,'GR',3851],
  'degersheim':[28938,19.29,'SG',3401],
  'deisswil bei münchenbuchsee':[26833,17.89,'BE',535],
  'deitingen':[31321,20.88,'SO',2516],
  'delley-portalban':[26379,17.59,'FR',2051],
  'delémont':[30353,20.24,'JU',6711],
  'denens':[30504,20.34,'VD',5631],
  'denges':[30147,20.1,'VD',5632],
  'densbüren':[26857,17.9,'AG',4004],
  'derendingen':[32068,21.38,'SO',2517],
  'develier':[30620,20.41,'JU',6712],
  'diegten':[31139,20.76,'BL',2884],
  'dielsdorf':[23064,15.38,'ZH',86],
  'diemtigen':[31969,21.31,'BE',762],
  'diepflingen':[32646,21.76,'BL',2845],
  'diepoldsau':[23493,15.66,'SG',3234],
  'dierikon':[24114,16.08,'LU',1053],
  'diessbach bei büren':[31969,21.31,'BE',385],
  'diessenhofen':[24387,16.26,'TG',4545],
  'dietikon':[24484,16.32,'ZH',243],
  'dietlikon':[23064,15.38,'ZH',54],
  'dietwil':[25612,17.07,'AG',4231],
  'dinhard':[21732,14.49,'ZH',216],
  'dintikon':[25037,16.69,'AG',4194],
  'disentis/mustér':[26209,17.47,'GR',3982],
  'dittingen':[32479,21.65,'BL',2784],
  'dizy':[31691,21.13,'VD',5481],
  'domat/ems':[24680,16.45,'GR',3722],
  'domleschg':[27411,18.27,'GR',3673],
  'dompierre (vd)':[32058,21.37,'VD',5671],
  'donneloye':[31454,20.97,'VD',5913],
  'doppleschwand':[26635,17.76,'LU',1001],
  'dorf':[22975,15.32,'ZH',26],
  'dornach':[27369,18.25,'SO',2473],
  'dorénaz':[31748,21.17,'VS',6212],
  'dottikon':[24462,16.31,'AG',4065],
  'dotzigen':[32251,21.5,'BE',386],
  'dozwil':[23221,15.48,'TG',4406],
  'drei höfe':[31341,20.89,'SO',2535],
  'duggingen':[30804,20.54,'BL',2785],
  'duillier':[30622,20.41,'VD',5715],
  'dulliken':[30972,20.65,'SO',2573],
  'dully':[29079,19.39,'VD',5855],
  'dägerlen':[23153,15.44,'ZH',214],
  'dällikon':[23241,15.49,'ZH',84],
  'däniken':[26459,17.64,'SO',2572],
  'dänikon':[24395,16.26,'ZH',85],
  'därligen':[32251,21.5,'BE',575],
  'därstetten':[30840,20.56,'BE',761],
  'dättlikon':[23863,15.91,'ZH',215],
  'démoret':[32058,21.37,'VD',5912],
  'dörflingen':[23336,15.56,'SH',2915],
  'döttingen':[25899,17.27,'AG',4304],
  'dübendorf':[22265,14.84,'ZH',191],
  'düdingen':[31078,20.72,'FR',2293],
  'dürnten':[23774,15.85,'ZH',113],
  'dürrenroth':[32477,21.65,'BE',952],
  'dürrenäsch':[26952,17.97,'AG',4134],
  'ebikon':[25235,16.82,'LU',1054],
  'ebnat-kappel':[28744,19.16,'SG',3352],
  'echallens':[31394,20.93,'VD',5518],
  'echandens':[29969,19.98,'VD',5633],
  'echarlens':[29321,19.55,'FR',2131],
  'echichens':[30622,20.41,'VD',5634],
  'eclépens':[28247,18.83,'VD',5482],
  'ecublens (vd)':[30207,20.14,'VD',5635],
  'ederswiler':[31953,21.3,'JU',6713],
  'egerkingen':[30178,20.12,'SO',2401],
  'egg':[22709,15.14,'ZH',192],
  'eggenwil':[25803,17.2,'AG',4066],
  'eggerberg':[33790,22.53,'VS',6004],
  'eggersriet':[26896,17.93,'SG',3212],
  'eggiwil':[31969,21.31,'BE',901],
  'eglisau':[23774,15.85,'ZH',55],
  'egliswil':[25707,17.14,'AG',4195],
  'egnach':[25165,16.78,'TG',4411],
  'egolzwil':[24955,16.64,'LU',1127],
  'ehrendingen':[26474,17.65,'AG',4049],
  'eich':[20474,13.65,'LU',1084],
  'eichberg':[25341,16.89,'SG',3252],
  'eiken':[26282,17.52,'AG',4161],
  'einsiedeln':[17679,11.79,'SZ',1301],
  'eischoll':[33476,22.32,'VS',6194],
  'eisten':[29125,19.42,'VS',6282],
  'elgg':[24484,16.32,'ZH',294],
  'ellikon an der thur':[24129,16.09,'ZH',218],
  'elsau':[24129,16.09,'ZH',219],
  'embd':[32953,21.97,'VS',6283],
  'embrach':[23863,15.91,'ZH',56],
  'emmen':[25795,17.2,'LU',1024],
  'emmetten':[21161,14.11,'NW',1504],
  'endingen':[26282,17.52,'AG',4305],
  'engelberg':[22127,14.75,'OW',1402],
  'ennetbaden':[24462,16.31,'AG',4026],
  'ennetbürgen':[18787,12.52,'NW',1505],
  'ennetmoos':[20436,13.62,'NW',1506],
  'entlebuch':[25515,17.01,'LU',1002],
  'epalinges':[30444,20.3,'VD',5584],
  'ependes (vd)':[31523,21.02,'VD',5914],
  'eppenberg-wöschnau':[28667,19.11,'SO',2574],
  'epsach':[31404,20.94,'BE',735],
  'eptingen':[32646,21.76,'BL',2885],
  'ergisch':[29125,19.42,'VS',6104],
  'eriswil':[31912,21.27,'BE',953],
  'eriz':[31856,21.24,'BE',924],
  'erlach':[30276,20.18,'BE',492],
  'erlen':[25009,16.67,'TG',4476],
  'erlenbach':[20490,13.66,'ZH',151],
  'erlenbach im simmental':[31066,20.71,'BE',763],
  'erlinsbach (ag)':[24175,16.12,'AG',4005],
  'erlinsbach (so)':[28996,19.33,'SO',2503],
  'ermatingen':[21743,14.5,'TG',4646],
  'ermensee':[24674,16.45,'LU',1025],
  'ernen':[30717,20.48,'VS',6056],
  'erschwil':[32038,21.36,'SO',2615],
  'ersigen':[31404,20.94,'BE',405],
  'erstfeld':[21440,14.29,'UR',1206],
  'eschenbach':[26605,17.74,'SG',3342],
  'eschenz':[24543,16.36,'TG',4806],
  'eschert':[32759,21.84,'BE',692],
  'eschlikon':[24698,16.47,'TG',4724],
  'escholzmatt-marbach':[24955,16.64,'LU',1010],
  'essertines-sur-rolle':[30682,20.45,'VD',5856],
  'essertines-sur-yverdon':[31335,20.89,'VD',5520],
  'estavayer':[31371,20.91,'FR',2054],
  'etagnières':[31454,20.97,'VD',5521],
  'etoy':[29910,19.94,'VD',5636],
  'ettingen':[31976,21.32,'BL',2768],
  'ettiswil':[25795,17.2,'LU',1128],
  'etziken':[32251,21.5,'SO',2518],
  'evilard':[30388,20.26,'BE',372],
  'evionnaz':[32192,21.46,'VS',6213],
  'evolène':[33071,22.05,'VS',6083],
  'eysins':[29851,19.9,'VD',5716],
  'fahrni':[31856,21.24,'BE',925],
  'fahrwangen':[26952,17.97,'AG',4196],
  'fahy':[32487,21.66,'JU',6789],
  'faido':[28754,19.17,'TI',5072],
  'falera':[22496,15.0,'GR',3572],
  'faoug':[30504,20.34,'VD',5458],
  'farnern':[31912,21.27,'BE',975],
  'fehraltorf':[23596,15.73,'ZH',172],
  'fehren':[32271,21.51,'SO',2616],
  'felben-wellhausen':[24932,16.62,'TG',4561],
  'feldbrunnen-st. niklaus':[25296,16.86,'SO',2544],
  'felsberg':[26318,17.55,'GR',3731],
  'ferden':[34393,22.93,'VS',6195],
  'ferenbalm':[31686,21.12,'BE',662],
  'ferpicloz':[27126,18.08,'FR',2194],
  'ferrera':[23042,15.36,'GR',3713],
  'ferreyres':[31810,21.21,'VD',5483],
  'feuerthalen':[23863,15.91,'ZH',27],
  'feusisberg':[12865,8.58,'SZ',1321],
  'fey':[31691,21.13,'VD',5522],
  'fideris':[26318,17.55,'GR',3861],
  'fiesch':[31254,20.84,'VS',6057],
  'fieschertal':[30247,20.16,'VS',6058],
  'fiez':[30989,20.66,'VD',5556],
  'finhaut':[29125,19.42,'VS',6214],
  'finsterhennen':[31969,21.31,'BE',493],
  'fischbach':[26075,17.38,'LU',1129],
  'fischbach-göslikon':[26090,17.39,'AG',4067],
  'fischenthal':[24573,16.38,'ZH',114],
  'fischingen':[25554,17.04,'TG',4726],
  'fisibach':[26665,17.78,'AG',4306],
  'fislisbach':[26090,17.39,'AG',4027],
  'flaach':[23241,15.49,'ZH',28],
  'flawil':[27285,18.19,'SG',3402],
  'flerden':[28503,19.0,'GR',3662],
  'flims':[21949,14.63,'GR',3732],
  'flumenthal':[31720,21.15,'SO',2545],
  'flums':[27383,18.26,'SG',3292],
  'flurlingen':[23596,15.73,'ZH',29],
  'fläsch':[23042,15.36,'GR',3951],
  'flüelen':[20634,13.76,'UR',1207],
  'flühli':[26075,17.38,'LU',1004],
  'fontaines-sur-grandson':[31345,20.9,'VD',5557],
  'fontenais':[32753,21.84,'JU',6790],
  'forel (lavaux)':[30979,20.65,'VD',5604],
  'forst-längenbühl':[31404,20.94,'BE',948],
  'founex':[29554,19.7,'VD',5717],
  'fraubrunnen':[31686,21.12,'BE',538],
  'frauenfeld':[24698,16.47,'TG',4566],
  'frauenkappelen':[30840,20.56,'BE',663],
  'freienbach':[12449,8.3,'SZ',1322],
  'freienstein-teufen':[22531,15.02,'ZH',57],
  'freienwil':[26569,17.71,'AG',4028],
  'freimettigen':[31969,21.31,'BE',607],
  'frenkendorf':[31307,20.87,'BL',2824],
  'fribourg':[30785,20.52,'FR',2196],
  'frick':[25420,16.95,'AG',4163],
  'froideville':[31335,20.89,'VD',5523],
  'frutigen':[32251,21.5,'BE',563],
  'fräschels':[30053,20.04,'FR',2258],
  'fulenbach':[29926,19.95,'SO',2575],
  'full-reuenthal':[27336,18.22,'AG',4307],
  'fully':[32112,21.41,'VS',6133],
  'furna':[28503,19.0,'GR',3862],
  'fällanden':[22531,15.02,'ZH',193],
  'féchy':[30385,20.26,'VD',5427],
  'fétigny':[31664,21.11,'FR',2016],
  'füllinsdorf':[31809,21.21,'BL',2825],
  'fürstenau':[27411,18.27,'GR',3633],
  'gachnang':[23765,15.84,'TG',4571],
  'gais':[24768,16.51,'AR',3022],
  'gaiserwald':[25243,16.83,'SG',3442],
  'galgenen':[16476,10.98,'SZ',1342],
  'gals':[29655,19.77,'BE',494],
  'gambarogno':[27654,18.44,'TI',5398],
  'gampel-bratsch':[33286,22.19,'VS',6118],
  'gampelen':[29655,19.77,'BE',495],
  'gams':[26410,17.61,'SG',3272],
  'gansingen':[27144,18.1,'AG',4164],
  'gebenstorf':[25707,17.14,'AG',4029],
  'gelterkinden':[31641,21.09,'BL',2846],
  'geltwil':[20440,13.63,'AG',4232],
  'gempen':[30740,20.49,'SO',2474],
  'genolier':[28960,19.31,'VD',5718],
  'genthod':[27165,18.11,'GE',6622],
  'genève':[30075,20.05,'GE',6621],
  'gerlafingen':[31720,21.15,'SO',2519],
  'geroldswil':[23685,15.79,'ZH',244],
  'gersau':[15812,10.54,'SZ',1311],
  'gerzensee':[30501,20.33,'BE',866],
  'geuensee':[25235,16.82,'LU',1085],
  'gibloux':[31078,20.72,'FR',2236],
  'giebenach':[30972,20.65,'BL',2826],
  'giez':[30860,20.57,'VD',5559],
  'giffers':[31649,21.1,'FR',2294],
  'gilly':[30207,20.14,'VD',5857],
  'gimel':[31454,20.97,'VD',5428],
  'gingins':[29910,19.94,'VD',5719],
  'giornico':[28877,19.25,'TI',5073],
  'gipf-oberfrick':[24941,16.63,'AG',4165],
  'gisikon':[22714,15.14,'LU',1055],
  'giswil':[22341,14.89,'OW',1403],
  'givisiez':[29321,19.55,'FR',2197],
  'givrins':[30741,20.49,'VD',5720],
  'gland':[30029,20.02,'VD',5721],
  'glarus':[23833,15.89,'GL',1632],
  'glarus nord':[24971,16.65,'GL',1630],
  'glarus süd':[24971,16.65,'GL',1631],
  'glattfelden':[24395,16.26,'ZH',58],
  'gletterens':[29160,19.44,'FR',2022],
  'goldach':[24466,16.31,'SG',3213],
  'gollion':[31573,21.05,'VD',5484],
  'gommiswald':[25243,16.83,'SG',3341],
  'goms':[30247,20.16,'VS',6077],
  'gondiswil':[32194,21.46,'BE',326],
  'gonten':[21984,14.66,'AI',3102],
  'gontenschwil':[26857,17.9,'AG',4135],
  'gordola':[27777,18.52,'TI',5108],
  'gossau':[26507,17.67,'SG',3443],
  'gottlieben':[23532,15.69,'TG',4651],
  'goumoëns':[31751,21.17,'VD',5541],
  'graben':[31969,21.31,'BE',976],
  'grabs':[24952,16.63,'SG',3273],
  'grancia':[26432,17.62,'TI',5186],
  'grancy':[31098,20.73,'VD',5485],
  'grandcour':[31345,20.9,'VD',5817],
  'grandevent':[31216,20.81,'VD',5560],
  'grandfontaine':[32220,21.48,'JU',6792],
  'grandson':[30979,20.65,'VD',5561],
  'grandval':[31630,21.09,'BE',694],
  'grandvillard':[30785,20.52,'FR',2134],
  'granges (veveyse)':[31371,20.91,'FR',2328],
  'granges-paccot':[28999,19.33,'FR',2198],
  'grangettes':[31517,21.01,'FR',2079],
  'gravesano':[25821,17.21,'TI',5187],
  'greifensee':[22265,14.84,'ZH',194],
  'grellingen':[32144,21.43,'BL',2786],
  'grenchen':[30546,20.36,'SO',2546],
  'greng':[23759,15.84,'FR',2261],
  'grengiols':[30112,20.07,'VS',6177],
  'grens':[30147,20.1,'VD',5722],
  'greppen':[24114,16.08,'LU',1056],
  'gretzenbach':[30876,20.58,'SO',2576],
  'grimisuat':[32196,21.46,'VS',6263],
  'grindel':[32301,21.53,'SO',2617],
  'grindelwald':[31348,20.9,'BE',576],
  'grolley-ponthaux':[30785,20.52,'FR',2239],
  'grono':[25226,16.82,'GR',3832],
  'grossaffoltern':[31348,20.9,'BE',303],
  'grossdietwil':[26635,17.76,'LU',1131],
  'grosshöchstetten':[30953,20.64,'BE',608],
  'grosswangen':[24114,16.08,'LU',1086],
  'grub (ar)':[26698,17.8,'AR',3031],
  'gruyères':[30785,20.52,'FR',2135],
  'gryon':[31513,21.01,'VD',5405],
  'grächen':[34904,23.27,'VS',6285],
  'gränichen':[26282,17.52,'AG',4006],
  'grône':[32991,21.99,'VS',6238],
  'grüningen':[24040,16.03,'ZH',116],
  'grüsch':[26100,17.4,'GR',3961],
  'gsteig':[29147,19.43,'BE',841],
  'gsteigwiler':[32702,21.8,'BE',577],
  'guggisberg':[32477,21.65,'BE',852],
  'gunzgen':[30275,20.18,'SO',2578],
  'gurbrü':[32533,21.69,'BE',665],
  'gurmels':[30785,20.52,'FR',2262],
  'gurtnellen':[22004,14.67,'UR',1209],
  'gurzelen':[32138,21.43,'BE',867],
  'guttannen':[31122,20.75,'BE',782],
  'guttet-feschel':[33426,22.28,'VS',6117],
  'gy':[30147,20.1,'GE',6624],
  'gächlingen':[26288,17.53,'SH',2901],
  'göschenen':[21843,14.56,'UR',1208],
  'gündlischwand':[33097,22.06,'BE',578],
  'günsberg':[31108,20.74,'SO',2547],
  'güttingen':[24232,16.15,'TG',4656],
  'habkern':[32251,21.5,'BE',579],
  'habsburg':[23505,15.67,'AG',4099],
  'hagenbuch':[24662,16.44,'ZH',220],
  'hagneck':[30276,20.18,'BE',736],
  'hallau':[25960,17.31,'SH',2971],
  'hallwil':[27719,18.48,'AG',4197],
  'halten':[31108,20.74,'SO',2520],
  'hasle':[26635,17.76,'LU',1005],
  'hasle bei burgdorf':[31912,21.27,'BE',406],
  'hasliberg':[33662,22.44,'BE',783],
  'hauenstein-ifenthal':[31670,21.11,'SO',2491],
  'hauptwil-gottshaus':[24776,16.52,'TG',4486],
  'hausen (ag)':[26186,17.46,'AG',4100],
  'hausen am albis':[23685,15.79,'ZH',4],
  'haut-intyamon':[33274,22.18,'FR',2121],
  'haute-ajoie':[31687,21.12,'JU',6809],
  'haute-sorne':[31420,20.95,'JU',6729],
  'hautemorges':[30860,20.57,'VD',5656],
  'hauterive (fr)':[29907,19.94,'FR',2233],
  'hauteville':[30449,20.3,'FR',2137],
  'hedingen':[22620,15.08,'ZH',5],
  'hefenhofen':[26021,17.35,'TG',4416],
  'heiden':[25808,17.21,'AR',3032],
  'heiligenschwendi':[32477,21.65,'BE',927],
  'heimberg':[30840,20.56,'BE',928],
  'heimenhausen':[30558,20.37,'BE',977],
  'heimiswil':[32194,21.46,'BE',407],
  'heitenried':[30493,20.33,'FR',2296],
  'hellikon':[27144,18.1,'AG',4251],
  'hellsau':[31969,21.31,'BE',408],
  'hemishofen':[23445,15.63,'SH',2962],
  'hemmiken':[32981,21.99,'BL',2848],
  'hendschiken':[27623,18.42,'AG',4198],
  'henggart':[22886,15.26,'ZH',31],
  'henniez':[30979,20.65,'VD',5819],
  'herbetswil':[32165,21.44,'SO',2424],
  'herbligen':[32533,21.69,'BE',610],
  'herdern':[24854,16.57,'TG',4811],
  'hergiswil (nw)':[18259,12.17,'NW',1507],
  'hergiswil bei willisau':[24955,16.64,'LU',1132],
  'herisau':[26995,18.0,'AR',3001],
  'hermance':[29579,19.72,'GE',6625],
  'hermenches':[31523,21.02,'VD',5673],
  'hermrigen':[31969,21.31,'BE',737],
  'herrliberg':[20401,13.6,'ZH',152],
  'hersberg':[31641,21.09,'BL',2827],
  'herznach-ueken':[26186,17.46,'AG',4186],
  'herzogenbuchsee':[31122,20.75,'BE',979],
  'hettlingen':[22354,14.9,'ZH',221],
  'hildisrieden':[22154,14.77,'LU',1088],
  'hilterfingen':[30558,20.37,'BE',929],
  'himmelried':[31563,21.04,'SO',2618],
  'hindelbank':[30783,20.52,'BE',409],
  'hinwil':[24307,16.2,'ZH',117],
  'hirschthal':[25229,16.82,'AG',4007],
  'hittnau':[23774,15.85,'ZH',173],
  'hitzkirch':[23834,15.89,'LU',1030],
  'hochdorf':[24394,16.26,'LU',1031],
  'hochfelden':[24040,16.03,'ZH',59],
  'hochwald':[30623,20.42,'SO',2475],
  'hofstetten bei brienz':[31404,20.94,'BE',580],
  'hofstetten-flüh':[30275,20.18,'SO',2476],
  'hohenrain':[25515,17.01,'LU',1032],
  'hohentannen':[24621,16.41,'TG',4495],
  'holderbank (ag)':[25037,16.69,'AG',4199],
  'holderbank (so)':[32503,21.67,'SO',2425],
  'holziken':[25803,17.2,'AG',4136],
  'homberg':[32194,21.46,'BE',931],
  'hombrechtikon':[23774,15.85,'ZH',153],
  'homburg':[25398,16.93,'TG',4816],
  'horgen':[21732,14.49,'ZH',295],
  'horn':[21198,14.13,'TG',4421],
  'horrenbach-buchen':[31404,20.94,'BE',932],
  'horriwil':[31108,20.74,'SO',2523],
  'horw':[21874,14.58,'LU',1058],
  'hospental':[20795,13.86,'UR',1210],
  'hubersdorf':[31932,21.29,'SO',2548],
  'hundwil':[27589,18.39,'AR',3002],
  'hunzenschwil':[25420,16.95,'AG',4200],
  'huttwil':[31348,20.9,'BE',954],
  'häfelfingen':[31976,21.32,'BL',2847],
  'hägendorf':[30042,20.03,'SO',2579],
  'häggenschwil':[26410,17.61,'SG',3201],
  'hägglingen':[26569,17.71,'AG',4068],
  'härkingen':[27495,18.33,'SO',2402],
  'häutligen':[29993,20.0,'BE',609],
  'hérémence':[29125,19.42,'VS',6084],
  'höchstetten':[31686,21.12,'BE',410],
  'hölstein':[32311,21.54,'BL',2886],
  'höri':[23508,15.67,'ZH',60],
  'hünenberg':[13349,8.9,'ZG',1703],
  'hüniken':[31680,21.12,'SO',2524],
  'hüntwangen':[23330,15.55,'ZH',61],
  'hüttikon':[23774,15.85,'ZH',87],
  'hüttlingen':[25554,17.04,'TG',4590],
  'hüttwilen':[24154,16.1,'TG',4821],
  'icogne':[31170,20.78,'VS',6239],
  'iffwil':[29711,19.81,'BE',541],
  'ilanz/glion':[26318,17.55,'GR',3619],
  'illgau':[17887,11.92,'SZ',1363],
  'illnau-effretikon':[23774,15.85,'ZH',296],
  'inden':[31462,20.97,'VS',6109],
  'ingenbohl':[16642,11.09,'SZ',1364],
  'inkwil':[31686,21.12,'BE',980],
  'innerthal':[15853,10.57,'SZ',1343],
  'innertkirchen':[30840,20.56,'BE',784],
  'ins':[31009,20.67,'BE',496],
  'interlaken':[31799,21.2,'BE',581],
  'inwil':[23274,15.52,'LU',1033],
  'ipsach':[30783,20.52,'BE',739],
  'iseltwald':[32251,21.5,'BE',582],
  'isenthal':[22567,15.04,'UR',1211],
  'islisberg':[25037,16.69,'AG',4084],
  'isone':[28510,19.01,'TI',5009],
  'isérables':[34259,22.84,'VS',6134],
  'itingen':[32311,21.54,'BL',2849],
  'ittigen':[28752,19.17,'BE',362],
  'jaberg':[30219,20.15,'BE',868],
  'jaun':[33713,22.48,'FR',2138],
  'jegenstorf':[30445,20.3,'BE',540],
  'jenaz':[25772,17.18,'GR',3863],
  'jenins':[25554,17.04,'GR',3952],
  'jens':[32533,21.69,'BE',738],
  'jonen':[23600,15.73,'AG',4071],
  'jongny':[31038,20.69,'VD',5885],
  'jonschwil':[27091,18.06,'SG',3405],
  'jorat-menthue':[31157,20.77,'VD',5804],
  'jorat-mézières':[31216,20.81,'VD',5806],
  'jouxtens-mézery':[29791,19.86,'VD',5585],
  'juriens':[32166,21.44,'VD',5754],
  'jussy':[29437,19.62,'GE',6626],
  'kaiseraugst':[21398,14.27,'AG',4252],
  'kaisten':[25420,16.95,'AG',4169],
  'kallern':[25420,16.95,'AG',4233],
  'kallnach':[29993,20.0,'BE',304],
  'kaltbrunn':[25535,17.02,'SG',3313],
  'kammersrohr':[24715,16.48,'SO',2549],
  'kandergrund':[32251,21.5,'BE',564],
  'kandersteg':[31969,21.31,'BE',565],
  'kappel (so)':[31321,20.88,'SO',2580],
  'kappel am albis':[22798,15.2,'ZH',6],
  'kappelen':[30840,20.56,'BE',305],
  'kaufdorf':[32420,21.61,'BE',869],
  'kehrsatz':[31066,20.71,'BE',870],
  'kemmental':[25243,16.83,'TG',4666],
  'kernenried':[30276,20.18,'BE',411],
  'kerns':[22020,14.68,'OW',1404],
  'kerzers':[30639,20.43,'FR',2265],
  'kesswil':[23687,15.79,'TG',4426],
  'kestenholz':[30740,20.49,'SO',2403],
  'kienberg':[32155,21.44,'SO',2492],
  'kiesen':[30501,20.33,'BE',611],
  'kilchberg':[20134,13.42,'ZH',135],
  'kilchberg (bl)':[32479,21.65,'BL',2851],
  'killwangen':[25707,17.14,'AG',4030],
  'kippel':[34887,23.26,'VS',6197],
  'kirchberg':[26896,17.93,'SG',3392],
  'kirchdorf':[30332,20.22,'BE',872],
  'kirchleerau':[27431,18.29,'AG',4275],
  'kirchlindach':[30558,20.37,'BE',354],
  'kleinandelfingen':[24040,16.03,'ZH',33],
  'kleinbösingen':[30053,20.04,'FR',2266],
  'kleinlützel':[32150,21.43,'SO',2619],
  'klingnau':[26569,17.71,'AG',4309],
  'klosters':[23915,15.94,'GR',3871],
  'kloten':[22620,15.08,'ZH',62],
  'knonau':[24040,16.03,'ZH',7],
  'knutwil':[26355,17.57,'LU',1089],
  'koblenz':[26952,17.97,'AG',4310],
  'konolfingen':[30783,20.52,'BE',612],
  'koppigen':[31122,20.75,'BE',413],
  'kradolf-schönenberg':[25009,16.67,'TG',4501],
  'krattigen':[31686,21.12,'BE',566],
  'krauchthal':[31912,21.27,'BE',414],
  'kreuzlingen':[24076,16.05,'TG',4671],
  'kriechenwil':[31912,21.27,'BE',666],
  'kriegstetten':[30992,20.66,'SO',2525],
  'kriens':[24394,16.26,'LU',1059],
  'känerkinden':[32311,21.54,'BL',2850],
  'kölliken':[26569,17.71,'AG',4276],
  'köniz':[30727,20.48,'BE',355],
  'küblis':[27411,18.27,'GR',3882],
  'künten':[25612,17.07,'AG',4031],
  'küsnacht':[20223,13.48,'ZH',154],
  'küssnacht (sz)':[15812,10.54,'SZ',1331],
  'küttigen':[25229,16.82,'AG',4008],
  'l\'abbaye':[31810,21.21,'VD',5871],
  'l\'abergement':[32295,21.53,'VD',5741],
  'l\'isle':[31691,21.13,'VD',5486],
  'la baroche':[31687,21.12,'JU',6810],
  'la brillaz':[31517,21.01,'FR',2234],
  'la brévine':[34923,23.28,'NE',6432],
  'la chaux (cossonay)':[31810,21.21,'VD',5474],
  'la chaux-de-fonds':[34923,23.28,'NE',6421],
  'la chaux-du-milieu':[34923,23.28,'NE',6435],
  'la côte-aux-fées':[34923,23.28,'NE',6504],
  'la ferrière':[32759,21.84,'BE',435],
  'la grande béroche':[33120,22.08,'NE',6417],
  'la neuveville':[31122,20.75,'BE',723],
  'la praz':[32641,21.76,'VD',5758],
  'la punt chamues-ch':[20748,13.83,'GR',3785],
  'la rippe':[30326,20.22,'VD',5726],
  'la roche':[31517,21.01,'FR',2149],
  'la sagne':[34923,23.28,'NE',6423],
  'la sarraz':[31098,20.73,'VD',5498],
  'la sonnaz':[30200,20.13,'FR',2235],
  'la tour-de-peilz':[30385,20.26,'VD',5889],
  'la verrerie':[31225,20.82,'FR',2338],
  'laax':[19765,13.18,'GR',3575],
  'lachen':[15230,10.15,'SZ',1344],
  'laconnex':[29863,19.91,'GE',6627],
  'lajoux (ju)':[31953,21.3,'JU',6750],
  'lalden':[31872,21.25,'VS',6286],
  'lamone':[27654,18.44,'TI',5189],
  'lampenberg':[32144,21.43,'BL',2887],
  'lancy':[30289,20.19,'GE',6628],
  'landiswil':[32251,21.5,'BE',613],
  'landquart':[25772,17.18,'GR',3955],
  'langenbruck':[31139,20.76,'BL',2888],
  'langendorf':[30992,20.66,'SO',2550],
  'langenthal':[29937,19.96,'BE',329],
  'langnau am albis':[23153,15.44,'ZH',136],
  'langnau im emmental':[32759,21.84,'BE',902],
  'langrickenbach':[25243,16.83,'TG',4681],
  'lantsch/lenz':[23588,15.73,'GR',3513],
  'laténa':[33871,22.58,'NE',6513],
  'lauenen':[31404,20.94,'BE',842],
  'lauerz':[17887,11.92,'SZ',1365],
  'laufen':[31641,21.09,'BL',2787],
  'laufen-uhwiesen':[22975,15.32,'ZH',34],
  'laufenburg':[25995,17.33,'AG',4170],
  'laupen':[31630,21.09,'BE',667],
  'laupersdorf':[31786,21.19,'SO',2426],
  'lauperswil':[32251,21.5,'BE',903],
  'lausanne':[32107,21.4,'VD',5586],
  'lausen':[30972,20.65,'BL',2828],
  'lauterbrunnen':[32194,21.46,'BE',584],
  'lauwil':[31809,21.21,'BL',2889],
  'lavertezzo':[29488,19.66,'TI',5112],
  'lavey-morcles':[31276,20.85,'VD',5406],
  'lavigny':[31454,20.97,'VD',5637],
  'lavizzara':[28877,19.25,'TI',5323],
  'lax':[33791,22.53,'VS',6061],
  'le bémont (ju)':[30620,20.41,'JU',6741],
  'le cerneux-péquignot':[34923,23.28,'NE',6434],
  'le chenit':[29732,19.82,'VD',5872],
  'le châtelard':[32249,21.5,'FR',2067],
  'le flon':[32806,21.87,'FR',2337],
  'le grand-saconnex':[29863,19.91,'GE',6623],
  'le landeron':[33571,22.38,'NE',6455],
  'le lieu':[31098,20.73,'VD',5873],
  'le locle':[34022,22.68,'NE',6436],
  'le mont-sur-lausanne':[31335,20.89,'VD',5587],
  'le mouret':[31444,20.96,'FR',2220],
  'le noirmont':[29287,19.52,'JU',6754],
  'le pâquier (fr)':[30785,20.52,'FR',2145],
  'le vaud':[30979,20.65,'VD',5731],
  'leibstadt':[25420,16.95,'AG',4311],
  'leimbach (ag)':[27336,18.22,'AG',4137],
  'leissigen':[32533,21.69,'BE',585],
  'lengnau':[30219,20.15,'BE',387],
  'lengnau (ag)':[25516,17.01,'AG',4312],
  'lengwil':[23843,15.9,'TG',4683],
  'lenk':[31912,21.27,'BE',792],
  'lens':[29636,19.76,'VS',6240],
  'lenzburg':[25707,17.14,'AG',4201],
  'les bois':[31153,20.77,'JU',6742],
  'les breuleux':[27153,18.1,'JU',6743],
  'les clées':[32295,21.53,'VD',5750],
  'les enfers':[31153,20.77,'JU',6745],
  'les genevez (ju)':[31153,20.77,'JU',6748],
  'les montets':[30405,20.27,'FR',2050],
  'les planchettes':[35374,23.58,'NE',6422],
  'les ponts-de-martel':[34923,23.28,'NE',6437],
  'les verrières':[35524,23.68,'NE',6511],
  'leuggern':[25899,17.27,'AG',4313],
  'leuk':[33043,22.03,'VS',6110],
  'leukerbad':[34946,23.3,'VS',6111],
  'leutwil':[27240,18.16,'AG',4138],
  'leuzigen':[31912,21.27,'BE',388],
  'leysin':[32048,21.37,'VD',5407],
  'leytron':[32354,21.57,'VS',6135],
  'lichtensteig':[27771,18.51,'SG',3374],
  'liddes':[32991,21.99,'VS',6033],
  'liedertswil':[30972,20.65,'BL',2890],
  'liesberg':[31976,21.32,'BL',2788],
  'liestal':[32646,21.76,'BL',2829],
  'ligerz':[31291,20.86,'BE',740],
  'lignerolle':[32117,21.41,'VD',5755],
  'lignières':[35224,23.48,'NE',6456],
  'lindau':[23153,15.44,'ZH',176],
  'linden':[31969,21.31,'BE',614],
  'linescio':[25210,16.81,'TI',5315],
  'locarno':[28266,18.84,'TI',5113],
  'lohn (sh)':[24429,16.29,'SH',2917],
  'lohn-ammannsegg':[28773,19.18,'SO',2526],
  'lommis':[24387,16.26,'TG',4741],
  'lommiswil':[31902,21.27,'SO',2551],
  'lonay':[29316,19.54,'VD',5638],
  'longirod':[31988,21.33,'VD',5429],
  'losone':[28266,18.84,'TI',5115],
  'lostallo':[24134,16.09,'GR',3821],
  'lostorf':[30275,20.18,'SO',2493],
  'lotzwil':[31404,20.94,'BE',331],
  'lovatens':[31691,21.13,'VD',5674],
  'loveresse':[32759,21.84,'BE',696],
  'lucens':[31038,20.69,'VD',5675],
  'lufingen':[21910,14.61,'ZH',63],
  'lugano':[26676,17.78,'TI',5192],
  'luins':[29732,19.82,'VD',5858],
  'lully (fr)':[30785,20.52,'FR',2025],
  'lully (vd)':[29672,19.78,'VD',5639],
  'lumino':[28266,18.84,'TI',5010],
  'lumnezia':[25226,16.82,'GR',3618],
  'lungern':[23197,15.46,'OW',1405],
  'lupfig':[26186,17.46,'AG',4104],
  'lupsingen':[31474,20.98,'BL',2830],
  'lussery-villars':[31691,21.13,'VD',5487],
  'lussy-sur-morges':[30088,20.06,'VD',5640],
  'luterbach':[31447,20.96,'SO',2527],
  'luthern':[27195,18.13,'LU',1135],
  'lutry':[29197,19.46,'VD',5606],
  'lutzenberg':[25214,16.81,'AR',3033],
  'luzein':[24680,16.45,'GR',3891],
  'luzern':[22434,14.96,'LU',1061],
  'lyss':[30840,20.56,'BE',306],
  'lyssach':[29655,19.77,'BE',415],
  'läufelfingen':[32512,21.67,'BL',2852],
  'löhningen':[23883,15.92,'SH',2903],
  'lüscherz':[30276,20.18,'BE',497],
  'lüsslingen-nennigkofen':[31690,21.13,'SO',2464],
  'lüterkofen-ichertswil':[29946,19.96,'SO',2455],
  'lütisburg':[29327,19.55,'SG',3393],
  'lütschental':[30276,20.18,'BE',586],
  'lützelflüh':[31630,21.09,'BE',955],
  'madiswil':[31122,20.75,'BE',332],
  'madulain':[24680,16.45,'GR',3783],
  'magden':[24750,16.5,'AG',4253],
  'maggia':[28266,18.84,'TI',5317],
  'magliaso':[26432,17.62,'TI',5193],
  'maienfeld':[22823,15.22,'GR',3953],
  'maisprach':[31139,20.76,'BL',2853],
  'malans':[23588,15.73,'GR',3954],
  'malters':[24674,16.45,'LU',1062],
  'mammern':[24309,16.21,'TG',4826],
  'mandach':[26857,17.9,'AG',4105],
  'manno':[25210,16.81,'TI',5194],
  'maracon':[31632,21.09,'VD',5790],
  'marbach':[25146,16.76,'SG',3253],
  'marchissy':[31988,21.33,'VD',5430],
  'marly':[32103,21.4,'FR',2206],
  'marsens':[30053,20.04,'FR',2140],
  'marthalen':[23241,15.49,'ZH',35],
  'martigny':[30490,20.33,'VS',6136],
  'martigny-combe':[30600,20.4,'VS',6137],
  'maschwanden':[25194,16.8,'ZH',8],
  'masein':[28503,19.0,'GR',3663],
  'massagno':[25821,17.21,'TI',5196],
  'massongex':[31468,20.98,'VS',6215],
  'massonnens':[32425,21.62,'FR',2086],
  'mathod':[31345,20.9,'VD',5919],
  'matran':[28589,19.06,'FR',2208],
  'matten bei interlaken':[32420,21.61,'BE',587],
  'mattstetten':[30163,20.11,'BE',543],
  'matzendorf':[32271,21.51,'SO',2427],
  'matzingen':[25243,16.83,'TG',4591],
  'mauborget':[31108,20.74,'VD',5562],
  'mauensee':[24394,16.26,'LU',1091],
  'maur':[21288,14.19,'ZH',195],
  'mauraz':[31691,21.13,'VD',5488],
  'medel (lucmagn)':[23042,15.36,'GR',3983],
  'meggen':[18793,12.53,'LU',1063],
  'meienried':[27454,18.3,'BE',389],
  'meierskappel':[24674,16.45,'LU',1064],
  'meikirch':[30501,20.33,'BE',307],
  'meilen':[20756,13.84,'ZH',156],
  'meinier':[29579,19.72,'GE',6629],
  'meinisberg':[32815,21.88,'BE',390],
  'meiringen':[31969,21.31,'BE',785],
  'meisterschwanden':[21398,14.27,'AG',4202],
  'melchnau':[31630,21.09,'BE',333],
  'melide':[25210,16.81,'TI',5198],
  'mellikon':[27814,18.54,'AG',4314],
  'mellingen':[26186,17.46,'AG',4033],
  'mels':[27383,18.26,'SG',3293],
  'meltingen':[31457,20.97,'SO',2620],
  'mendrisio':[26676,17.78,'TI',5254],
  'menziken':[26952,17.97,'AG',4139],
  'menzingen':[13655,9.1,'ZG',1704],
  'menznau':[24674,16.45,'LU',1136],
  'merenschwand':[24845,16.56,'AG',4234],
  'mergoscia':[29488,19.66,'TI',5117],
  'merishausen':[25741,17.16,'SH',2936],
  'mervelier':[32220,21.48,'JU',6715],
  'merzligen':[29993,20.0,'BE',741],
  'mesocco':[24898,16.6,'GR',3822],
  'messen':[30275,20.18,'SO',2457],
  'mettauertal':[26090,17.39,'AG',4184],
  'mettembert':[31953,21.3,'JU',6716],
  'mettmenstetten':[22442,14.96,'ZH',9],
  'metzerlen-mariastein':[31563,21.04,'SO',2477],
  'mex (vd)':[29851,19.9,'VD',5489],
  'meyriez':[26730,17.82,'FR',2271],
  'meyrin':[29579,19.72,'GE',6630],
  'mezzovico-vira':[24598,16.4,'TI',5199],
  'mies':[29197,19.46,'VD',5723],
  'miglieglia':[28877,19.25,'TI',5200],
  'milvignes':[33120,22.08,'NE',6416],
  'minusio':[27288,18.19,'TI',5118],
  'mirchel':[31912,21.27,'BE',615],
  'misery-courtion':[31956,21.3,'FR',2272],
  'missy':[30989,20.66,'VD',5821],
  'moiry':[31810,21.21,'VD',5490],
  'mollens (vd)':[31573,21.05,'VD',5431],
  'molondin':[32414,21.61,'VD',5921],
  'mont-la-ville':[31810,21.21,'VD',5491],
  'mont-noble':[33984,22.66,'VS',6090],
  'mont-sur-rolle':[30147,20.1,'VD',5859],
  'mont-tramelan':[33323,22.22,'BE',437],
  'mont-vully':[27565,18.38,'FR',2284],
  'montagny (fr)':[31312,20.87,'FR',2029],
  'montagny-près-yverdon':[30444,20.3,'VD',5922],
  'montanaire':[31098,20.73,'VD',5693],
  'montcherand':[31335,20.89,'VD',5756],
  'monteceneri':[28510,19.01,'TI',5238],
  'montfaucon':[31953,21.3,'JU',6751],
  'monthey':[31394,20.93,'VS',6153],
  'montilliez':[31394,20.93,'VD',5540],
  'montpreveyres':[31632,21.09,'VD',5792],
  'montreux':[30504,20.34,'VD',5886],
  'montricher':[30385,20.26,'VD',5492],
  'moosleerau':[27431,18.29,'AG',4277],
  'moosseedorf':[29598,19.73,'BE',544],
  'morbio inferiore':[27288,18.19,'TI',5257],
  'morcote':[27043,18.03,'TI',5203],
  'morges':[30741,20.49,'VD',5642],
  'morlon':[31415,20.94,'FR',2143],
  'morrens (vd)':[31573,21.05,'VD',5527],
  'morschach':[17057,11.37,'SZ',1366],
  'mosnang':[27771,18.51,'SG',3394],
  'moudon':[31404,20.94,'VD',5678],
  'moutier':[32759,21.84,'BE',700],
  'moutier (simulation provisoire)':[32487,21.66,'JU',6831],
  'movelier':[32220,21.48,'JU',6718],
  'muhen':[26378,17.59,'AG',4009],
  'mumpf':[27048,18.03,'AG',4255],
  'muntelier':[27565,18.38,'FR',2274],
  'muntogna da schons':[26318,17.55,'GR',3715],
  'muolen':[26507,17.67,'SG',3202],
  'muotathal':[16019,10.68,'SZ',1367],
  'muralto':[26432,17.62,'TI',5120],
  'murgenthal':[26665,17.78,'AG',4279],
  'muri (ag)':[25420,16.95,'AG',4236],
  'muri bei bern':[28244,18.83,'BE',356],
  'muriaux':[28753,19.17,'JU',6753],
  'murten':[28150,18.77,'FR',2275],
  'mutrux':[32291,21.53,'VD',5563],
  'muttenz':[31139,20.76,'BL',2770],
  'muzzano':[26432,17.62,'TI',5205],
  'mägenwil':[26474,17.65,'AG',4032],
  'männedorf':[21821,14.55,'ZH',155],
  'märstetten':[25243,16.83,'TG',4941],
  'ménières':[31971,21.31,'FR',2027],
  'mézières (fr)':[31517,21.01,'FR',2087],
  'möhlin':[26378,17.59,'AG',4254],
  'mönchaltorf':[23330,15.55,'ZH',196],
  'mönthal':[26665,17.78,'AG',4106],
  'mörel-filet':[31937,21.29,'VS',6203],
  'mörigen':[28865,19.24,'BE',742],
  'möriken-wildegg':[24654,16.44,'AG',4203],
  'mörschwil':[22035,14.69,'SG',3214],
  'mühlau':[26857,17.9,'AG',4235],
  'mühleberg':[29711,19.81,'BE',668],
  'müllheim':[24387,16.26,'TG',4831],
  'mülligen':[26090,17.39,'AG',4107],
  'mümliswil-ramiswil':[31700,21.13,'SO',2428],
  'münchenbuchsee':[31066,20.71,'BE',546],
  'münchenstein':[31809,21.21,'BL',2769],
  'münchenwiler':[30276,20.18,'BE',669],
  'münchwilen (ag)':[26474,17.65,'AG',4172],
  'münchwilen (tg)':[25243,16.83,'TG',4746],
  'münsingen':[30727,20.48,'BE',616],
  'münsterlingen':[23143,15.43,'TG',4691],
  'müntschemier':[31912,21.27,'BE',498],
  'naters':[30147,20.1,'VS',6007],
  'nebikon':[23834,15.89,'LU',1137],
  'neckertal':[26896,17.93,'SG',3396],
  'neerach':[20578,13.72,'ZH',88],
  'neftenbach':[22798,15.2,'ZH',223],
  'neggio':[28266,18.84,'TI',5206],
  'nendaz':[33043,22.03,'VS',6024],
  'nenzlingen':[32227,21.48,'BL',2789],
  'nesslau':[26313,17.54,'SG',3360],
  'neuchâtel':[33420,22.28,'NE',6458],
  'neuendorf':[30876,20.58,'SO',2404],
  'neuenegg':[30219,20.15,'BE',670],
  'neuenhof':[26378,17.59,'AG',4034],
  'neuenkirch':[24114,16.08,'LU',1093],
  'neuhausen am rheinfall':[22790,15.19,'SH',2937],
  'neuheim':[14023,9.35,'ZG',1705],
  'neunforn':[23143,15.43,'TG',4601],
  'neunkirch':[24539,16.36,'SH',2904],
  'neyruz (fr)':[30932,20.62,'FR',2211],
  'nidau':[31404,20.94,'BE',743],
  'niederbipp':[31122,20.75,'BE',981],
  'niederbuchsiten':[29597,19.73,'SO',2405],
  'niederbüren':[26507,17.67,'SG',3422],
  'niederdorf':[32479,21.65,'BL',2891],
  'niedergesteln':[31956,21.3,'VS',6198],
  'niederglatt':[23153,15.44,'ZH',89],
  'niedergösgen':[29345,19.56,'SO',2495],
  'niederhasli':[23685,15.79,'ZH',90],
  'niederhelfenschwil':[25341,16.89,'SG',3423],
  'niederhünigen':[31404,20.94,'BE',617],
  'niederlenz':[26857,17.9,'AG',4204],
  'niedermuhlern':[31912,21.27,'BE',877],
  'niederried bei interlaken':[32759,21.84,'BE',588],
  'niederrohrdorf':[24941,16.63,'AG',4035],
  'niederweningen':[22798,15.2,'ZH',91],
  'niederwil (ag)':[25516,17.01,'AG',4072],
  'niederönz':[31122,20.75,'BE',982],
  'noble-contrée':[30490,20.33,'VS',6254],
  'nods':[31066,20.71,'BE',724],
  'nottwil':[24114,16.08,'LU',1094],
  'novaggio':[28877,19.25,'TI',5207],
  'novalles':[31810,21.21,'VD',5564],
  'novazzano':[25210,16.81,'TI',5260],
  'noville':[31691,21.13,'VD',5408],
  'nuglar-st. pantaleon':[31806,21.2,'SO',2478],
  'nunningen':[31593,21.06,'SO',2621],
  'nusshof':[32144,21.43,'BL',2854],
  'nuvilly':[31942,21.29,'FR',2035],
  'nyon':[30029,20.02,'VD',5724],
  'nürensdorf':[21732,14.49,'ZH',64],
  'oberbalm':[31686,21.12,'BE',357],
  'oberbipp':[30783,20.52,'BE',983],
  'oberbuchsiten':[29597,19.73,'SO',2406],
  'oberburg':[32420,21.61,'BE',418],
  'oberbüren':[24952,16.63,'SG',3424],
  'oberdiessbach':[31066,20.71,'BE',619],
  'oberdorf (bl)':[32646,21.76,'BL',2892],
  'oberdorf (nw)':[20436,13.62,'NW',1508],
  'oberdorf (so)':[31088,20.73,'SO',2553],
  'oberegg':[23632,15.75,'AI',3111],
  'oberembrach':[24573,16.38,'ZH',65],
  'oberems':[29125,19.42,'VS',6112],
  'oberengstringen':[23419,15.61,'ZH',245],
  'oberentfelden':[26474,17.65,'AG',4010],
  'obergerlafingen':[29946,19.96,'SO',2528],
  'oberglatt':[24129,16.09,'ZH',92],
  'obergoms':[30147,20.1,'VS',6076],
  'obergösgen':[31321,20.88,'SO',2497],
  'oberhallau':[26506,17.67,'SH',2972],
  'oberhof':[27623,18.42,'AG',4173],
  'oberhofen am thunersee':[30501,20.33,'BE',934],
  'oberhünigen':[32420,21.61,'BE',629],
  'oberiberg':[14981,9.99,'SZ',1368],
  'oberkirch':[22434,14.96,'LU',1095],
  'oberkulm':[27048,18.03,'AG',4140],
  'oberlangenegg':[32815,21.88,'BE',935],
  'oberlunkhofen':[22738,15.16,'AG',4073],
  'obermumpf':[27336,18.22,'AG',4256],
  'oberried am brienzersee':[32759,21.84,'BE',589],
  'oberrieden':[21200,14.13,'ZH',137],
  'oberriet':[24466,16.31,'SG',3254],
  'oberrohrdorf':[23792,15.86,'AG',4037],
  'oberrüti':[27048,18.03,'AG',4237],
  'obersaxen mundaun':[25772,17.18,'GR',3988],
  'obersiggenthal':[26186,17.46,'AG',4038],
  'oberthal':[32364,21.58,'BE',620],
  'oberuzwil':[26605,17.74,'SG',3407],
  'oberweningen':[22265,14.84,'ZH',93],
  'oberwil (bl)':[30135,20.09,'BL',2771],
  'oberwil bei büren':[32364,21.58,'BE',391],
  'oberwil im simmental':[31066,20.71,'BE',766],
  'oberwil-lieli':[20248,13.5,'AG',4074],
  'oberägeri':[13349,8.9,'ZG',1706],
  'obfelden':[24307,16.2,'ZH',10],
  'ochlenberg':[30840,20.56,'BE',985],
  'oekingen':[31341,20.89,'SO',2529],
  'oensingen':[30042,20.03,'SO',2407],
  'oeschenbach':[33097,22.06,'BE',335],
  'oeschgen':[26569,17.71,'AG',4175],
  'oetwil am see':[24040,16.03,'ZH',157],
  'oetwil an der limmat':[23241,15.49,'ZH',246],
  'oftringen':[26474,17.65,'AG',4280],
  'ogens':[32048,21.37,'VD',5680],
  'ollon':[30860,20.57,'VD',5409],
  'olsberg':[24462,16.31,'AG',4257],
  'olten':[29743,19.83,'SO',2581],
  'oltingen':[32479,21.65,'BL',2855],
  'onex':[30786,20.52,'GE',6631],
  'onnens (vd)':[30504,20.34,'VD',5565],
  'onsernone':[28877,19.25,'TI',5136],
  'opfikon':[22087,14.72,'ZH',66],
  'oppens':[32166,21.44,'VD',5923],
  'oppligen':[30276,20.18,'BE',622],
  'orbe':[31751,21.17,'VD',5757],
  'orges':[31573,21.05,'VD',5924],
  'origlio':[25821,17.21,'TI',5208],
  'ormalingen':[31641,21.09,'BL',2856],
  'ormont-dessous':[31929,21.29,'VD',5410],
  'ormont-dessus':[31810,21.21,'VD',5411],
  'orny':[31454,20.97,'VD',5493],
  'oron':[30979,20.65,'VD',5805],
  'orpund':[32251,21.5,'BE',744],
  'orselina':[27288,18.19,'TI',5121],
  'orsières':[32227,21.48,'VS',6034],
  'orvin':[32420,21.61,'BE',438],
  'orzens':[32176,21.45,'VD',5925],
  'ossingen':[22531,15.02,'ZH',37],
  'ostermundigen':[31348,20.9,'BE',363],
  'otelfingen':[23685,15.79,'ZH',94],
  'othmarsingen':[25612,17.07,'AG',4205],
  'ottenbach':[23952,15.97,'ZH',11],
  'oulens-sous-echallens':[31216,20.81,'VD',5529],
  'pailly':[31810,21.21,'VD',5530],
  'paradiso':[24354,16.24,'TI',5210],
  'paudex':[30682,20.45,'VD',5588],
  'payerne':[31098,20.73,'VD',5822],
  'penthalaz':[31394,20.93,'VD',5495],
  'penthaz':[31038,20.69,'VD',5496],
  'penthéréaz':[31573,21.05,'VD',5531],
  'perly-certoux':[29721,19.81,'GE',6632],
  'perrefitte':[33097,22.06,'BE',701],
  'perroy':[29969,19.98,'VD',5860],
  'personico':[28266,18.84,'TI',5076],
  'petit-val':[31912,21.27,'BE',716],
  'pfaffnau':[26075,17.38,'LU',1139],
  'pfeffingen':[29297,19.53,'BL',2772],
  'pfungen':[24129,16.09,'ZH',224],
  'pfyn':[25787,17.19,'TG',4841],
  'pfäfers':[28744,19.16,'SG',3294],
  'pfäffikon':[23508,15.67,'ZH',177],
  'pierrafortscha':[30493,20.33,'FR',2216],
  'pieterlen':[31686,21.12,'BE',392],
  'plaffeien':[32542,21.69,'FR',2299],
  'plan-les-ouates':[28585,19.06,'GE',6633],
  'plasselb':[32981,21.99,'FR',2300],
  'plateau de diesse':[32251,21.5,'BE',726],
  'pleigne':[31420,20.95,'JU',6719],
  'pohlern':[31517,21.01,'BE',936],
  'poliez-pittet':[31454,20.97,'VD',5533],
  'pollegio':[28877,19.25,'TI',5077],
  'pompaples':[30622,20.41,'VD',5497],
  'pomy':[31216,20.81,'VD',5926],
  'pont-en-ogoz':[30053,20.04,'FR',2122],
  'pont-la-ville':[30053,20.04,'FR',2147],
  'ponte capriasca':[27654,18.44,'TI',5212],
  'pontresina':[23588,15.73,'GR',3784],
  'porrentruy':[31153,20.77,'JU',6800],
  'port':[31348,20.9,'BE',745],
  'port-valais':[30353,20.24,'VS',6154],
  'porza':[24109,16.07,'TI',5214],
  'poschiavo':[25226,16.82,'GR',3561],
  'prangins':[29316,19.54,'VD',5725],
  'prato (leventina)':[28266,18.84,'TI',5078],
  'pratteln':[31558,21.04,'BL',2831],
  'pregny-chambésy':[28159,18.77,'GE',6634],
  'premier':[32226,21.48,'VD',5759],
  'presinge':[29295,19.53,'GE',6635],
  'prez':[30785,20.52,'FR',2237],
  'prilly':[31394,20.93,'VD',5589],
  'provence':[32414,21.61,'VD',5566],
  'préverenges':[30504,20.34,'VD',5643],
  'prévondavaux':[32293,21.53,'FR',2038],
  'prévonloup':[31394,20.93,'VD',5683],
  'puidoux':[30919,20.61,'VD',5607],
  'pully':[30029,20.02,'VD',5590],
  'puplinge':[30573,20.38,'GE',6636],
  'pura':[27899,18.6,'TI',5216],
  'péry-la heutte':[30558,20.37,'BE',450],
  'quarten':[25146,16.76,'SG',3295],
  'quinto':[28266,18.84,'TI',5079],
  'radelfingen':[31348,20.9,'BE',309],
  'rafz':[23774,15.85,'ZH',67],
  'rain':[22714,15.14,'LU',1037],
  'ramlinsburg':[30469,20.31,'BL',2832],
  'ramsen':[24101,16.07,'SH',2963],
  'rances':[31870,21.25,'VD',5760],
  'randa':[30147,20.1,'VS',6287],
  'raperswilen':[26176,17.45,'TG',4846],
  'rapperswil':[31291,20.86,'BE',310],
  'rapperswil-jona':[22424,14.95,'SG',3340],
  'raron':[31583,21.06,'VS',6199],
  'realp':[20554,13.7,'UR',1212],
  'rebstein':[25730,17.15,'SG',3255],
  'rebévelier':[33097,22.06,'BE',715],
  'recherswil':[31088,20.73,'SO',2530],
  'rechthalten':[31664,21.11,'FR',2301],
  'reconvilier':[32928,21.95,'BE',703],
  'regensberg':[23508,15.67,'ZH',95],
  'regensdorf':[24129,16.09,'ZH',96],
  'rehetobel':[27292,18.19,'AR',3034],
  'reichenbach im kandertal':[31799,21.2,'BE',567],
  'reichenburg':[17513,11.68,'SZ',1345],
  'reiden':[26075,17.38,'LU',1140],
  'reigoldswil':[32813,21.88,'BL',2893],
  'reinach (ag)':[26665,17.78,'AG',4141],
  'reinach (bl)':[30888,20.59,'BL',2773],
  'reisiswil':[31912,21.27,'BE',336],
  'reitnau':[27336,18.22,'AG',4281],
  'remaufens':[31956,21.3,'FR',2333],
  'remetschwil':[24462,16.31,'AG',4039],
  'remigen':[25037,16.69,'AG',4110],
  'renan':[33323,22.22,'BE',441],
  'renens (vd)':[31929,21.29,'VD',5591],
  'rennaz':[30622,20.41,'VD',5412],
  'reute (ar)':[25214,16.81,'AR',3035],
  'reutigen':[31686,21.12,'BE',767],
  'rheinau':[23685,15.79,'ZH',38],
  'rheineck':[26216,17.48,'SG',3235],
  'rheinfelden':[24271,16.18,'AG',4258],
  'rheinwald':[26318,17.55,'GR',3714],
  'rhäzüns':[28503,19.0,'GR',3723],
  'riaz':[29761,19.84,'FR',2148],
  'richterswil':[22531,15.02,'ZH',138],
  'rickenbach':[22154,14.77,'LU',1097],
  'rickenbach (bl)':[32144,21.43,'BL',2857],
  'rickenbach (so)':[29345,19.56,'SO',2582],
  'rickenbach (tg)':[24932,16.62,'TG',4751],
  'riddes':[32637,21.76,'VS',6139],
  'ried bei kerzers':[29687,19.79,'FR',2276],
  'ried-brig':[30600,20.4,'VS',6008],
  'riederalp':[32553,21.7,'VS',6181],
  'riedholz':[30507,20.34,'SO',2554],
  'riehen':[25167,16.78,'BS',2703],
  'riemenstalden':[15396,10.26,'SZ',1369],
  'rifferswil':[24573,16.38,'ZH',12],
  'riggisberg':[31969,21.31,'BE',879],
  'ringgenberg':[31969,21.31,'BE',590],
  'riniken':[27048,18.03,'AG',4111],
  'risch':[13410,8.94,'ZG',1707],
  'riva san vitale':[27043,18.03,'TI',5263],
  'rivaz':[30147,20.1,'VD',5609],
  'riviera':[28877,19.25,'TI',5287],
  'roche (vd)':[30682,20.45,'VD',5413],
  'rochefort':[33721,22.48,'NE',6413],
  'roches':[32759,21.84,'BE',704],
  'rodersdorf':[31670,21.11,'SO',2479],
  'roggenburg':[32144,21.43,'BL',2790],
  'roggliswil':[25515,17.01,'LU',1142],
  'roggwil':[30896,20.6,'BE',337],
  'roggwil (tg)':[24698,16.47,'TG',4431],
  'rohrbach':[29429,19.62,'BE',338],
  'rohrbachgraben':[32759,21.84,'BE',339],
  'rolle':[29851,19.9,'VD',5861],
  'romainmôtier-envy':[32404,21.6,'VD',5761],
  'romanel-sur-lausanne':[31157,20.77,'VD',5592],
  'romanel-sur-morges':[29435,19.62,'VD',5645],
  'romanshorn':[26176,17.45,'TG',4436],
  'romont':[30840,20.56,'BE',442],
  'romont (fr)':[32249,21.5,'FR',2096],
  'romoos':[26075,17.38,'LU',1007],
  'ronco sopra ascona':[26432,17.62,'TI',5125],
  'rongellen':[18673,12.45,'GR',3711],
  'root':[22154,14.77,'LU',1065],
  'ropraz':[31988,21.33,'VD',5798],
  'rorbas':[22886,15.26,'ZH',68],
  'rorschach':[27771,18.51,'SG',3215],
  'rorschacherberg':[24952,16.63,'SG',3216],
  'rossa':[23806,15.87,'GR',3808],
  'rossemaison':[30887,20.59,'JU',6721],
  'rossenges':[30504,20.34,'VD',5684],
  'rossinière':[32404,21.6,'VD',5842],
  'rothenbrunnen':[24134,16.09,'GR',3637],
  'rothenburg':[22994,15.33,'LU',1040],
  'rothenfluh':[32144,21.43,'BL',2858],
  'rothenthurm':[16227,10.82,'SZ',1370],
  'rothrist':[26186,17.46,'AG',4282],
  'rottenschwil':[25133,16.76,'AG',4238],
  'rougemont':[32166,21.44,'VD',5843],
  'roveredo':[26865,17.91,'GR',3834],
  'rovray':[31454,20.97,'VD',5928],
  'rubigen':[29937,19.96,'BE',623],
  'rudolfstetten-friedlisberg':[25133,16.76,'AG',4075],
  'rue':[30346,20.23,'FR',2097],
  'rueyres':[31454,20.97,'VD',5534],
  'rumendingen':[27454,18.3,'BE',421],
  'rumisberg':[32477,21.65,'BE',987],
  'rupperswil':[25133,16.76,'AG',4206],
  'russikon':[23774,15.85,'ZH',178],
  'russin':[29153,19.44,'GE',6637],
  'ruswil':[24955,16.64,'LU',1098],
  'römerswil':[25235,16.82,'LU',1039],
  'röschenz':[31474,20.98,'BL',2791],
  'röthenbach im emmental':[33097,22.06,'BE',904],
  'rüderswil':[31630,21.09,'BE',905],
  'rüdlingen':[21915,14.61,'SH',2938],
  'rüdtligen-alchenflüh':[29993,20.0,'BE',420],
  'rüeggisberg':[32251,21.5,'BE',880],
  'rüegsau':[31912,21.27,'BE',956],
  'rüfenach':[26952,17.97,'AG',4112],
  'rümlang':[23419,15.61,'ZH',97],
  'rümlingen':[32311,21.54,'BL',2859],
  'rünenberg':[32144,21.43,'BL',2860],
  'rüschegg':[31630,21.09,'BE',853],
  'rüschlikon':[20401,13.6,'ZH',139],
  'rüthi':[25827,17.22,'SG',3256],
  'rüti':[24307,16.2,'ZH',118],
  'rüti bei büren':[32251,21.5,'BE',393],
  'rüti bei lyssach':[31912,21.27,'BE',422],
  'rütschelen':[30840,20.56,'BE',340],
  'rüttenen':[30876,20.58,'SO',2555],
  's-chanf':[22496,15.0,'GR',3788],
  'saanen':[28018,18.68,'BE',843],
  'saas-almagell':[32687,21.79,'VS',6288],
  'saas-balen':[30988,20.66,'VS',6289],
  'saas-fee':[32504,21.67,'VS',6290],
  'saas-grund':[33790,22.53,'VS',6291],
  'sachseln':[22020,14.68,'OW',1406],
  'safenwil':[26665,17.78,'AG',4283],
  'safiental':[26865,17.91,'GR',3672],
  'safnern':[29711,19.81,'BE',746],
  'sagogn':[24134,16.09,'GR',3581],
  'saicourt':[32815,21.88,'BE',706],
  'saignelégier':[32487,21.66,'JU',6757],
  'saillon':[32354,21.57,'VS',6140],
  'saint-aubin (fr)':[30785,20.52,'FR',2041],
  'saint-barthélemy (vd)':[31691,21.13,'VD',5535],
  'saint-brais':[32220,21.48,'JU',6758],
  'saint-cergue':[30622,20.41,'VD',5727],
  'saint-george':[31038,20.69,'VD',5434],
  'saint-gingolph':[34362,22.91,'VS',6155],
  'saint-imier':[31686,21.12,'BE',443],
  'saint-livres':[30979,20.65,'VD',5435],
  'saint-léonard':[31872,21.25,'VS',6246],
  'saint-martin (fr)':[31810,21.21,'FR',2335],
  'saint-martin (vs)':[33893,22.6,'VS',6087],
  'saint-maurice':[32196,21.46,'VS',6217],
  'saint-oyens':[31929,21.29,'VD',5436],
  'saint-prex':[29791,19.86,'VD',5646],
  'saint-saphorin (lavaux)':[31573,21.05,'VD',5610],
  'saint-sulpice (vd)':[29316,19.54,'VD',5648],
  'sainte-croix':[31098,20.73,'VD',5568],
  'salenstein':[22443,14.96,'TG',4851],
  'salgesch':[32644,21.76,'VS',6113],
  'salmsach':[24932,16.62,'TG',4441],
  'salvan':[30763,20.51,'VS',6218],
  'samedan':[23588,15.73,'GR',3786],
  'samnaun':[26318,17.55,'GR',3752],
  'san vittore':[23588,15.73,'GR',3835],
  'sant\'antonino':[25821,17.21,'TI',5017],
  'santa maria in calanca':[26318,17.55,'GR',3810],
  'sargans':[27771,18.51,'SG',3296],
  'sarmenstorf':[25707,17.14,'AG',4076],
  'sarnen':[20224,13.48,'OW',1407],
  'satigny':[29153,19.44,'GE',6638],
  'sattel':[16227,10.82,'SZ',1371],
  'saubraz':[32285,21.52,'VD',5437],
  'sauge':[32533,21.69,'BE',449],
  'saulcy':[31953,21.3,'JU',6722],
  'saules':[32759,21.84,'BE',707],
  'savigny':[30979,20.65,'VD',5611],
  'savièse':[31412,20.94,'VS',6265],
  'savosa':[26432,17.62,'TI',5221],
  'saxeten':[31348,20.9,'BE',591],
  'saxon':[31544,21.03,'VS',6141],
  'schaffhausen':[23118,15.41,'SH',2939],
  'schafisheim':[25133,16.76,'AG',4207],
  'schangnau':[33662,22.44,'BE',906],
  'scharans':[25226,16.82,'GR',3638],
  'schattdorf':[20473,13.65,'UR',1213],
  'schattenhalb':[32759,21.84,'BE',786],
  'schelten':[34226,22.82,'BE',708],
  'schenkon':[19913,13.28,'LU',1099],
  'scheuren':[31856,21.24,'BE',747],
  'schiers':[27301,18.2,'GR',3962],
  'schinznach':[26186,17.46,'AG',4125],
  'schlatt':[24839,16.56,'ZH',226],
  'schlatt (tg)':[24465,16.31,'TG',4546],
  'schlatt-haslen':[22760,15.17,'AI',3104],
  'schleinikon':[23330,15.55,'ZH',98],
  'schleitheim':[26288,17.53,'SH',2952],
  'schlierbach':[22994,15.33,'LU',1100],
  'schlieren':[23596,15.73,'ZH',247],
  'schlossrued':[27144,18.1,'AG',4142],
  'schluein':[20857,13.9,'GR',3582],
  'schmerikon':[26216,17.48,'SG',3338],
  'schmiedrued':[27144,18.1,'AG',4143],
  'schmitten':[26318,17.55,'GR',3514],
  'schmitten (fr)':[30346,20.23,'FR',2305],
  'schneisingen':[26665,17.78,'AG',4318],
  'schnottwil':[31563,21.04,'SO',2461],
  'schongau':[25515,17.01,'LU',1041],
  'schupfart':[26186,17.46,'AG',4259],
  'schwaderloch':[27431,18.29,'AG',4176],
  'schwadernau':[32251,21.5,'BE',748],
  'schwanden bei brienz':[31686,21.12,'BE',592],
  'schwarzenberg':[25515,17.01,'LU',1066],
  'schwarzenburg':[32307,21.54,'BE',855],
  'schwarzhäusern':[30840,20.56,'BE',341],
  'schwellbrunn':[27292,18.19,'AR',3004],
  'schwende-rüte':[22178,14.79,'AI',3112],
  'schwerzenbach':[22975,15.32,'ZH',197],
  'schwyz':[17057,11.37,'SZ',1372],
  'schänis':[27383,18.26,'SG',3315],
  'schöfflisdorf':[22531,15.02,'ZH',99],
  'schöftland':[25516,17.01,'AG',4144],
  'schönenbuch':[30469,20.31,'BL',2774],
  'schönengrund':[27292,18.19,'AR',3003],
  'schönenwerd':[30527,20.35,'SO',2583],
  'schönholzerswilen':[25243,16.83,'TG',4756],
  'schötz':[25515,17.01,'LU',1143],
  'schübelbach':[18343,12.23,'SZ',1346],
  'schüpfen':[31630,21.09,'BE',311],
  'schüpfheim':[26075,17.38,'LU',1008],
  'scuol':[26318,17.55,'GR',3762],
  'seeberg':[31686,21.12,'BE',988],
  'seedorf':[31630,21.09,'BE',312],
  'seedorf (ur)':[20393,13.6,'UR',1214],
  'seegräben':[23596,15.73,'ZH',119],
  'seehof':[31630,21.09,'BE',709],
  'seelisberg':[22004,14.67,'UR',1215],
  'seengen':[22547,15.03,'AG',4208],
  'seewen':[31670,21.11,'SO',2480],
  'seewis im prättigau':[26865,17.91,'GR',3972],
  'seftigen':[31630,21.09,'BE',883],
  'seltisberg':[31641,21.09,'BL',2833],
  'selzach':[29703,19.8,'SO',2556],
  'sembrancher':[31999,21.33,'VS',6035],
  'sempach':[23274,15.52,'LU',1102],
  'semsales':[31225,20.82,'FR',2336],
  'senarclens':[30919,20.61,'VD',5499],
  'sennwald':[22035,14.69,'SG',3274],
  'seon':[25995,17.33,'AG',4209],
  'sergey':[31810,21.21,'VD',5762],
  'serravalle':[28632,19.09,'TI',5050],
  'servion':[30979,20.65,'VD',5799],
  'seuzach':[22620,15.08,'ZH',227],
  'sevelen':[26702,17.8,'SG',3275],
  'siblingen':[25195,16.8,'SH',2953],
  'sierre':[31748,21.17,'VS',6248],
  'siglistorf':[27240,18.16,'AG',4319],
  'signau':[32759,21.84,'BE',907],
  'signy-avenex':[29672,19.78,'VD',5728],
  'sigriswil':[31179,20.79,'BE',938],
  'silenen':[21601,14.4,'UR',1216],
  'sils im domleschg':[27411,18.27,'GR',3640],
  'sils im engadin/segl':[23042,15.36,'GR',3789],
  'silvaplana':[21403,14.27,'GR',3790],
  'simplon':[29125,19.42,'VS',6009],
  'sins':[25037,16.69,'AG',4239],
  'sion':[30147,20.1,'VS',6266],
  'sirnach':[24543,16.36,'TG',4761],
  'siselen':[31969,21.31,'BE',499],
  'sisikon':[22487,14.99,'UR',1217],
  'sissach':[31307,20.87,'BL',2861],
  'sisseln':[23313,15.54,'AG',4177],
  'siviriez':[31956,21.3,'FR',2099],
  'soazza':[21949,14.63,'GR',3823],
  'solothurn':[29597,19.73,'SO',2601],
  'sommeri':[25165,16.78,'TG',4446],
  'sonceboz-sombeval':[31517,21.01,'BE',444],
  'sonvilier':[33492,22.33,'BE',445],
  'soral':[29863,19.91,'GE',6639],
  'sorengo':[25210,16.81,'TI',5225],
  'sorens':[29761,19.84,'FR',2153],
  'sorvilier':[31969,21.31,'BE',711],
  'soubey':[32220,21.48,'JU',6759],
  'soyhières':[31687,21.12,'JU',6724],
  'speicher':[25511,17.01,'AR',3023],
  'spiez':[31122,20.75,'BE',768],
  'spiringen':[22004,14.67,'UR',1218],
  'spreitenbach':[25229,16.82,'AG',4040],
  'st. gallen':[28646,19.1,'SG',3203],
  'st. margrethen':[25827,17.22,'SG',3236],
  'st. moritz':[21403,14.27,'GR',3787],
  'st. niklaus':[31791,21.19,'VS',6292],
  'st. silvester':[32981,21.99,'FR',2303],
  'st. stephan':[32194,21.46,'BE',793],
  'st. ursen':[30053,20.04,'FR',2304],
  'stabio':[25210,16.81,'TI',5266],
  'stadel':[23774,15.85,'ZH',100],
  'staffelbach':[27048,18.03,'AG',4284],
  'stalden (vs)':[30317,20.21,'VS',6293],
  'staldenried':[30147,20.1,'VS',6294],
  'stallikon':[22886,15.26,'ZH',13],
  'stammheim':[23863,15.91,'ZH',292],
  'stans':[21590,14.39,'NW',1509],
  'stansstad':[20007,13.34,'NW',1510],
  'starrkirch-wil':[29946,19.96,'SO',2584],
  'staufen':[23983,15.99,'AG',4210],
  'steckborn':[22909,15.27,'TG',4864],
  'steffisburg':[30953,20.64,'BE',939],
  'steg-hohtenn':[31956,21.3,'VS',6204],
  'stein (ag)':[24079,16.05,'AG',4260],
  'stein (ar)':[25808,17.21,'AR',3005],
  'stein am rhein':[24101,16.07,'SH',2964],
  'steinach':[27091,18.06,'SG',3217],
  'steinen':[17887,11.92,'SZ',1373],
  'steinerberg':[16227,10.82,'SZ',1374],
  'steinhausen':[13349,8.9,'ZG',1708],
  'steinmaur':[23330,15.55,'ZH',101],
  'stetten (ag)':[25707,17.14,'AG',4041],
  'stetten (sh)':[20385,13.59,'SH',2919],
  'stettfurt':[25009,16.67,'TG',4606],
  'stettlen':[30671,20.45,'BE',358],
  'stocken-höfen':[31912,21.27,'BE',770],
  'strengelbach':[25516,17.01,'AG',4285],
  'studen':[31517,21.01,'BE',749],
  'stäfa':[20667,13.78,'ZH',158],
  'stüsslingen':[31670,21.11,'SO',2499],
  'subingen':[32038,21.36,'SO',2532],
  'suchy':[31098,20.73,'VD',5929],
  'sufers':[23588,15.73,'GR',3695],
  'suhr':[26378,17.59,'AG',4012],
  'sulgen':[24621,16.41,'TG',4506],
  'sullens':[30385,20.26,'VD',5501],
  'sumiswald':[31912,21.27,'BE',957],
  'sumvitg':[26865,17.91,'GR',3985],
  'surpierre':[32059,21.37,'FR',2044],
  'sursee':[24114,16.08,'LU',1103],
  'surses':[25226,16.82,'GR',3543],
  'suscévaz':[31345,20.9,'VD',5930],
  'sutz-lattrigen':[31404,20.94,'BE',750],
  'syens':[30504,20.34,'VD',5688],
  'sâles':[31664,21.11,'FR',2152],
  'sévaz':[26394,17.6,'FR',2043],
  'tafers':[30053,20.04,'FR',2306],
  'tamins':[26318,17.55,'GR',3733],
  'tannay':[29969,19.98,'VD',5729],
  'tartegnin':[32166,21.44,'VD',5862],
  'tavannes':[32646,21.76,'BE',713],
  'tecknau':[31809,21.21,'BL',2862],
  'tegerfelden':[25899,17.27,'AG',4320],
  'tenero-contra':[28632,19.09,'TI',5131],
  'tenniken':[31809,21.21,'BL',2863],
  'tentlingen':[31664,21.11,'FR',2307],
  'termen':[31170,20.78,'VS',6010],
  'terre di pedemonte':[27654,18.44,'TI',5396],
  'teufen (ar)':[22541,15.03,'AR',3024],
  'teufenthal (ag)':[27336,18.22,'AG',4145],
  'teuffenthal':[31969,21.31,'BE',940],
  'thal':[23882,15.92,'SG',3237],
  'thalheim (ag)':[26090,17.39,'AG',4117],
  'thalheim an der thur':[23952,15.97,'ZH',39],
  'thalwil':[20667,13.78,'ZH',141],
  'thayngen':[23773,15.85,'SH',2920],
  'therwil':[30469,20.31,'BL',2775],
  'thierachern':[32025,21.35,'BE',941],
  'thun':[31179,20.79,'BE',942],
  'thundorf':[25554,17.04,'TG',4611],
  'thunstetten':[31404,20.94,'BE',342],
  'thurnen':[32251,21.5,'BE',889],
  'thusis':[27957,18.64,'GR',3668],
  'thônex':[29863,19.91,'GE',6640],
  'thörigen':[31686,21.12,'BE',989],
  'thürnen':[31139,20.76,'BL',2864],
  'titterten':[32646,21.76,'BL',2894],
  'tobel-tägerschen':[25632,17.09,'TG',4776],
  'toffen':[30840,20.56,'BE',884],
  'tolochenaz':[30385,20.26,'VD',5649],
  'torny':[31517,21.01,'FR',2115],
  'torricella-taverne':[27654,18.44,'TI',5227],
  'trachselwald':[32420,21.61,'BE',958],
  'tramelan':[32759,21.84,'BE',446],
  'trasadingen':[25960,17.31,'SH',2973],
  'treiten':[29711,19.81,'BE',500],
  'tresa':[27654,18.44,'TI',5239],
  'trey':[32058,21.37,'VD',5827],
  'treycovagnes':[31454,20.97,'VD',5931],
  'treytorrens (payerne)':[32463,21.64,'VD',5828],
  'treyvaux':[30785,20.52,'FR',2226],
  'triengen':[24394,16.26,'LU',1104],
  'trient':[29125,19.42,'VS',6142],
  'trimbach':[31720,21.15,'SO',2500],
  'trimmis':[24680,16.45,'GR',3945],
  'trin':[25772,17.18,'GR',3734],
  'trogen':[28183,18.79,'AR',3025],
  'troinex':[29295,19.53,'GE',6641],
  'troistorrents':[31544,21.03,'VS',6156],
  'trub':[32194,21.46,'BE',908],
  'trubschachen':[33041,22.03,'BE',909],
  'trun':[25772,17.18,'GR',3987],
  'truttikon':[23241,15.49,'ZH',41],
  'trélex':[29375,19.58,'VD',5730],
  'trüllikon':[23508,15.67,'ZH',40],
  'tschappina':[26318,17.55,'GR',3669],
  'tschugg':[30783,20.52,'BE',501],
  'tuggen':[16434,10.96,'SZ',1347],
  'tujetsch':[25772,17.18,'GR',3986],
  'turbenthal':[24573,16.38,'ZH',228],
  'turtmann-unterems':[31544,21.03,'VS',6119],
  'twann-tüscherz':[31122,20.75,'BE',756],
  'tägerig':[27623,18.42,'AG',4077],
  'tägerwilen':[22676,15.12,'TG',4696],
  'täsch':[31999,21.33,'VS',6295],
  'täuffelen':[30783,20.52,'BE',751],
  'tévenon':[31276,20.85,'VD',5571],
  'törbel':[33215,22.14,'VS',6296],
  'tübach':[22910,15.27,'SG',3218],
  'udligenswil':[23834,15.89,'LU',1067],
  'ueberstorf':[31810,21.21,'FR',2308],
  'uebeschi':[32533,21.69,'BE',943],
  'uerkheim':[27431,18.29,'AG',4286],
  'uesslingen-buch':[24543,16.36,'TG',4616],
  'uetendorf':[30163,20.11,'BE',944],
  'uetikon am see':[21200,14.13,'ZH',159],
  'uezwil':[25803,17.2,'AG',4078],
  'ufhusen':[26075,17.38,'LU',1145],
  'uitikon':[20667,13.78,'ZH',248],
  'ulmiz':[31517,21.01,'FR',2278],
  'unterbäch':[32553,21.7,'VS',6201],
  'untereggen':[26799,17.87,'SG',3219],
  'unterengstringen':[22798,15.2,'ZH',249],
  'unterentfelden':[26474,17.65,'AG',4013],
  'unteriberg':[16227,10.82,'SZ',1375],
  'unterkulm':[26665,17.78,'AG',4146],
  'unterlangenegg':[32251,21.5,'BE',945],
  'unterlunkhofen':[22738,15.16,'AG',4079],
  'unterramsern':[29365,19.58,'SO',2463],
  'unterschächen':[21520,14.35,'UR',1219],
  'unterseen':[31404,20.94,'BE',593],
  'untersiggenthal':[25707,17.14,'AG',4044],
  'untervaz':[24680,16.45,'GR',3946],
  'unterägeri':[13349,8.9,'ZG',1709],
  'urdorf':[23952,15.97,'ZH',250],
  'urmein':[23042,15.36,'GR',3670],
  'urnäsch':[27292,18.19,'AR',3006],
  'ursenbach':[31686,21.12,'BE',344],
  'ursins':[31701,21.13,'VD',5932],
  'ursy':[30346,20.23,'FR',2102],
  'urtenen-schönbühl':[30276,20.18,'BE',551],
  'uster':[23685,15.79,'ZH',198],
  'uttigen':[31009,20.67,'BE',885],
  'uttwil':[22598,15.07,'TG',4451],
  'utzenstorf':[31517,21.01,'BE',552],
  'uznach':[25924,17.28,'SG',3339],
  'uzwil':[27091,18.06,'SG',3408],
  'vacallo':[27532,18.35,'TI',5268],
  'val de bagnes':[29125,19.42,'VS',6037],
  'val mara':[27043,18.03,'TI',5240],
  'val müstair':[28503,19.0,'GR',3847],
  'val terbi':[31953,21.3,'JU',6730],
  'val-d\'illiez':[33286,22.19,'VS',6157],
  'val-de-charmey':[32220,21.48,'FR',2163],
  'val-de-ruz':[33571,22.38,'NE',6487],
  'val-de-travers':[35073,23.38,'NE',6512],
  'valbirse':[33097,22.06,'BE',717],
  'valbroye':[31157,20.77,'VD',5831],
  'valeyres-sous-montagny':[31157,20.77,'VD',5933],
  'valeyres-sous-rances':[31226,20.82,'VD',5763],
  'valeyres-sous-ursins':[31939,21.29,'VD',5934],
  'vallon':[31225,20.82,'FR',2045],
  'vallorbe':[31098,20.73,'VD',5764],
  'vals':[25772,17.18,'GR',3603],
  'valsot':[25772,17.18,'GR',3764],
  'vandoeuvres':[27449,18.3,'GE',6642],
  'varen':[31956,21.3,'VS',6116],
  'vaulion':[32404,21.6,'VD',5765],
  'vaulruz':[30639,20.43,'FR',2155],
  'vaux-sur-morges':[29435,19.62,'VD',5650],
  'vaz/obervaz':[23042,15.36,'GR',3506],
  'vechigen':[30501,20.33,'BE',359],
  'veltheim (ag)':[25707,17.14,'AG',4120],
  'vendlincourt':[32487,21.66,'JU',6806],
  'vernate':[27043,18.03,'TI',5230],
  'vernayaz':[31544,21.03,'VS',6219],
  'vernier':[30715,20.48,'GE',6643],
  'versoix':[30076,20.05,'GE',6644],
  'verzasca':[29488,19.66,'TI',5399],
  'vevey':[31632,21.09,'VD',5890],
  'vex':[32598,21.73,'VS',6089],
  'veyrier':[28869,19.25,'GE',6645],
  'veysonnaz':[32991,21.99,'VS',6267],
  'veytaux':[30504,20.34,'VD',5891],
  'vezia':[27654,18.44,'TI',5231],
  'vich':[30266,20.18,'VD',5732],
  'vico morcote':[25210,16.81,'TI',5233],
  'villars-epeney':[30860,20.57,'VD',5935],
  'villars-le-comte':[30870,20.58,'VD',5690],
  'villars-le-terroir':[31820,21.21,'VD',5537],
  'villars-sainte-croix':[29969,19.98,'VD',5651],
  'villars-sous-yens':[31573,21.05,'VD',5652],
  'villars-sur-glâne':[28428,18.95,'FR',2228],
  'villarsel-sur-marly':[32249,21.5,'FR',2230],
  'villarzel':[31691,21.13,'VD',5830],
  'villaz':[31517,21.01,'FR',2117],
  'villeneuve (vd)':[30682,20.45,'VD',5414],
  'villeret':[31912,21.27,'BE',448],
  'villigen':[23983,15.99,'AG',4121],
  'villmergen':[25420,16.95,'AG',4080],
  'villnachern':[27144,18.1,'AG',4122],
  'villorsonnens':[30785,20.52,'FR',2114],
  'vilters-wangs':[26896,17.93,'SG',3297],
  'vinelz':[31348,20.9,'BE',502],
  'vinzel':[30504,20.34,'VD',5863],
  'vionnaz':[30988,20.66,'VS',6158],
  'visp':[30490,20.33,'VS',6297],
  'visperterminen':[33338,22.23,'VS',6298],
  'vitznau':[21594,14.4,'LU',1068],
  'volken':[23596,15.73,'ZH',43],
  'volketswil':[22709,15.14,'ZH',199],
  'vordemwald':[26952,17.97,'AG',4287],
  'vorderthal':[16891,11.26,'SZ',1348],
  'vouvry':[32412,21.61,'VS',6159],
  'vuadens':[31195,20.8,'FR',2160],
  'vuarrens':[31513,21.01,'VD',5539],
  'vucherens':[31691,21.13,'VD',5692],
  'vufflens-la-ville':[30741,20.49,'VD',5503],
  'vufflens-le-château':[29969,19.98,'VD',5653],
  'vugelles-la mothe':[31098,20.73,'VD',5937],
  'vuisternens-devant-romont':[32015,21.34,'FR',2113],
  'vuiteboeuf':[31701,21.13,'VD',5766],
  'vulliens':[31573,21.05,'VD',5803],
  'vullierens':[31810,21.21,'VD',5654],
  'vully-les-lacs':[30741,20.49,'VD',5464],
  'vérossaz':[33186,22.12,'VS',6220],
  'vétroz':[31132,20.75,'VS',6025],
  'wachseldorn':[32194,21.46,'BE',946],
  'wagenhausen':[25243,16.83,'TG',4871],
  'wahlen':[31809,21.21,'BL',2792],
  'walchwil':[13288,8.86,'ZG',1710],
  'wald':[30783,20.52,'BE',888],
  'wald (ar)':[26995,18.0,'AR',3036],
  'waldenburg':[33818,22.55,'BL',2895],
  'waldkirch':[27091,18.06,'SG',3444],
  'waldstatt':[25808,17.21,'AR',3007],
  'walenstadt':[25924,17.28,'SG',3298],
  'walkringen':[32364,21.58,'BE',626],
  'wallbach':[24750,16.5,'AG',4261],
  'wallisellen':[21999,14.67,'ZH',69],
  'walliswil bei niederbipp':[26889,17.93,'BE',990],
  'walliswil bei wangen':[30276,20.18,'BE',991],
  'walperswil':[31122,20.75,'BE',754],
  'waltenschwil':[25803,17.2,'AG',4240],
  'walterswil':[32307,21.54,'BE',959],
  'walterswil (so)':[31680,21.12,'SO',2585],
  'walzenhausen':[24323,16.22,'AR',3037],
  'wangen (sz)':[17513,11.68,'SZ',1349],
  'wangen an der aare':[31009,20.67,'BE',992],
  'wangen bei olten':[30972,20.65,'SO',2586],
  'wangen-brüttisellen':[22709,15.14,'ZH',200],
  'wartau':[29327,19.55,'SG',3276],
  'warth-weiningen':[20498,13.67,'TG',4621],
  'wassen':[21843,14.56,'UR',1220],
  'wasterkingen':[24040,16.03,'ZH',70],
  'wattenwil':[32759,21.84,'BE',886],
  'wattwil':[27771,18.51,'SG',3379],
  'wauwil':[25235,16.82,'LU',1146],
  'weesen':[26410,17.61,'SG',3316],
  'wegenstetten':[26952,17.97,'AG',4262],
  'weggis':[21314,14.21,'LU',1069],
  'weiach':[22265,14.84,'ZH',102],
  'weinfelden':[24465,16.31,'TG',4946],
  'weiningen':[23241,15.49,'ZH',251],
  'weisslingen':[24040,16.03,'ZH',180],
  'welschenrohr-gänsbrunnen':[31583,21.06,'SO',2430],
  'wengi':[32251,21.5,'BE',394],
  'wenslingen':[31474,20.98,'BL',2865],
  'werthenstein':[25795,17.2,'LU',1009],
  'wettingen':[24750,16.5,'AG',4045],
  'wettswil am albis':[21821,14.55,'ZH',14],
  'wetzikon':[24307,16.2,'ZH',121],
  'wichtrach':[31066,20.71,'BE',632],
  'widen':[22834,15.22,'AG',4081],
  'widnau':[22618,15.08,'SG',3238],
  'wiedlisbach':[32082,21.39,'BE',995],
  'wiesendangen':[21555,14.37,'ZH',298],
  'wiggiswil':[29711,19.81,'BE',553],
  'wigoltingen':[25865,17.24,'TG',4951],
  'wikon':[26635,17.76,'LU',1147],
  'wil':[26410,17.61,'SG',3427],
  'wila':[24839,16.56,'ZH',181],
  'wilchingen':[25960,17.31,'SH',2974],
  'wildberg':[25017,16.68,'ZH',182],
  'wilderswil':[31348,20.9,'BE',594],
  'wildhaus-alt st. johann':[26702,17.8,'SG',3359],
  'wilen (tg)':[24154,16.1,'TG',4786],
  'wiler (lötschen)':[34597,23.06,'VS',6202],
  'wiler bei utzenstorf':[31404,20.94,'BE',554],
  'wileroltigen':[30840,20.56,'BE',671],
  'wiliberg':[26090,17.39,'AG',4288],
  'willadingen':[30783,20.52,'BE',423],
  'willisau':[25515,17.01,'LU',1151],
  'wimmis':[30671,20.45,'BE',769],
  'windisch':[26665,17.78,'AG',4123],
  'winkel':[20490,13.66,'ZH',72],
  'wintersingen':[31139,20.76,'BL',2866],
  'winterthur':[24839,16.56,'ZH',230],
  'winznau':[31217,20.81,'SO',2501],
  'wisen (so)':[31700,21.13,'SO',2502],
  'wittenbach':[27188,18.13,'SG',3204],
  'witterswil':[29936,19.96,'SO',2481],
  'wittinsburg':[32311,21.54,'BL',2867],
  'wittnau':[27048,18.03,'AG',4181],
  'wohlen (ag)':[26761,17.84,'AG',4082],
  'wohlen bei bern':[30501,20.33,'BE',360],
  'wohlenschwil':[26761,17.84,'AG',4046],
  'wolfenschiessen':[22084,14.72,'NW',1511],
  'wolfhalden':[26104,17.4,'AR',3038],
  'wolfwil':[30740,20.49,'SO',2408],
  'wolhusen':[26635,17.76,'LU',1107],
  'wollerau':[12657,8.44,'SZ',1323],
  'worb':[31404,20.94,'BE',627],
  'worben':[31404,20.94,'BE',755],
  'wuppenau':[24854,16.57,'TG',4791],
  'wynau':[31969,21.31,'BE',345],
  'wynigen':[31686,21.12,'BE',424],
  'wyssachen':[32533,21.69,'BE',960],
  'wädenswil':[22886,15.26,'ZH',293],
  'wäldi':[25321,16.88,'TG',4701],
  'wängi':[24387,16.26,'TG',4781],
  'wölflinswil':[27623,18.42,'AG',4182],
  'wünnewil-flamatt':[31078,20.72,'FR',2309],
  'würenlingen':[25229,16.82,'AG',4047],
  'würenlos':[24941,16.63,'AG',4048],
  'yens':[31098,20.73,'VD',5655],
  'yverdon-les-bains':[31691,21.13,'VD',5938],
  'yvonand':[31454,20.97,'VD',5939],
  'yvorne':[31276,20.85,'VD',5415],
  'zeglingen':[32479,21.65,'BL',2868],
  'zeihen':[26569,17.71,'AG',4183],
  'zeiningen':[26378,17.59,'AG',4263],
  'zell':[24394,16.26,'LU',1150],
  'zeneggen':[33286,22.19,'VS',6299],
  'zermatt':[29125,19.42,'VS',6300],
  'zernez':[24571,16.38,'GR',3746],
  'zetzwil':[26952,17.97,'AG',4147],
  'ziefen':[32311,21.54,'BL',2834],
  'zielebach':[30276,20.18,'BE',556],
  'zihlschlacht-sitterdorf':[25554,17.04,'TG',4511],
  'zillis-reischen':[23042,15.36,'GR',3712],
  'zizers':[24134,16.09,'GR',3947],
  'zofingen':[25133,16.76,'AG',4289],
  'zollikofen':[29711,19.81,'BE',361],
  'zollikon':[20490,13.66,'ZH',161],
  'zuchwil':[30876,20.58,'SO',2534],
  'zufikon':[23217,15.48,'AG',4083],
  'zug':[13233,8.82,'ZG',1711],
  'zullwil':[33327,22.22,'SO',2622],
  'zumikon':[20401,13.6,'ZH',160],
  'zunzgen':[31139,20.76,'BL',2869],
  'zuoz':[22496,15.0,'GR',3791],
  'zurzach':[26665,17.78,'AG',4324],
  'zuzgen':[26665,17.78,'AG',4264],
  'zuzwil':[22716,15.14,'SG',3426],
  'zweisimmen':[31969,21.31,'BE',794],
  'zwingen':[31641,21.09,'BL',2793],
  'zwischbergen':[29125,19.42,'VS',6011],
  'zäziwil':[32477,21.65,'BE',628],
  'zürich':[24307,16.2,'ZH',261]
};

  // Sorted CHF values for national percentile calculation
  const ESTV_CHF_SORTED = [12449, 12657, 12865, 13165, 13233, 13288, 13349, 13349, 13349, 13349, 13349, 13410, 13655, 14023, 14815, 14981, 15230, 15396, 15812, 15812, 15812, 15853, 16019, 16227, 16227, 16227, 16227, 16434, 16476, 16642, 16849, 16891, 17057, 17057, 17513, 17513, 17679, 17887, 17887, 17887, 18259, 18343, 18673, 18787, 18793, 19743, 19755, 19765, 19913, 20007, 20134, 20166, 20223, 20224, 20248, 20385, 20393, 20401, 20401, 20401, 20436, 20436, 20440, 20473, 20474, 20490, 20490, 20490, 20498, 20554, 20554, 20578, 20634, 20667, 20667, 20667, 20748, 20756, 20795, 20795, 20857, 20857, 20887, 20957, 20996, 21118, 21160, 21161, 21198, 21200, 21200, 21288, 21288, 21314, 21398, 21398, 21403, 21403, 21440, 21520, 21555, 21590, 21594, 21594, 21601, 21732, 21732, 21732, 21732, 21743, 21755, 21821, 21821, 21821, 21843, 21843, 21874, 21910, 21915, 21949, 21949, 21949, 21984, 21999, 22004, 22004, 22004, 22020, 22020, 22035, 22035, 22084, 22087, 22087, 22127, 22154, 22154, 22154, 22154, 22178, 22265, 22265, 22265, 22265, 22341, 22341, 22354, 22424, 22434, 22434, 22442, 22442, 22443, 22487, 22496, 22496, 22496, 22531, 22531, 22531, 22531, 22531, 22531, 22541, 22547, 22567, 22598, 22618, 22620, 22620, 22620, 22676, 22709, 22709, 22709, 22714, 22714, 22716, 22738, 22738, 22760, 22790, 22798, 22798, 22798, 22798, 22798, 22823, 22834, 22886, 22886, 22886, 22886, 22909, 22910, 22975, 22975, 22975, 22994, 22994, 23008, 23042, 23042, 23042, 23042, 23042, 23042, 23042, 23042, 23064, 23064, 23064, 23118, 23143, 23143, 23153, 23153, 23153, 23153, 23153, 23153, 23153, 23197, 23217, 23221, 23241, 23241, 23241, 23241, 23241, 23241, 23274, 23274, 23274, 23313, 23330, 23330, 23330, 23330, 23330, 23336, 23369, 23419, 23419, 23419, 23445, 23493, 23505, 23508, 23508, 23508, 23508, 23508, 23532, 23532, 23588, 23588, 23588, 23588, 23588, 23588, 23596, 23596, 23596, 23596, 23596, 23596, 23600, 23600, 23632, 23664, 23685, 23685, 23685, 23685, 23685, 23685, 23685, 23687, 23696, 23759, 23765, 23773, 23774, 23774, 23774, 23774, 23774, 23774, 23774, 23774, 23774, 23792, 23806, 23833, 23834, 23834, 23834, 23834, 23843, 23863, 23863, 23863, 23863, 23863, 23863, 23863, 23882, 23883, 23915, 23952, 23952, 23952, 23983, 23983, 24040, 24040, 24040, 24040, 24040, 24040, 24040, 24076, 24079, 24101, 24101, 24109, 24114, 24114, 24114, 24114, 24114, 24114, 24114, 24114, 24129, 24129, 24129, 24129, 24129, 24129, 24129, 24134, 24134, 24134, 24134, 24154, 24154, 24154, 24174, 24174, 24175, 24175, 24175, 24211, 24218, 24218, 24232, 24271, 24271, 24307, 24307, 24307, 24307, 24307, 24309, 24323, 24354, 24387, 24387, 24387, 24387, 24394, 24394, 24394, 24394, 24394, 24394, 24394, 24395, 24395, 24395, 24429, 24462, 24462, 24462, 24462, 24462, 24465, 24465, 24466, 24466, 24484, 24484, 24539, 24543, 24543, 24543, 24558, 24571, 24571, 24573, 24573, 24573, 24573, 24573, 24573, 24598, 24598, 24598, 24608, 24621, 24621, 24621, 24654, 24662, 24674, 24674, 24674, 24674, 24674, 24674, 24680, 24680, 24680, 24680, 24680, 24680, 24698, 24698, 24698, 24698, 24715, 24750, 24750, 24750, 24750, 24750, 24768, 24776, 24839, 24839, 24839, 24845, 24845, 24845, 24845, 24854, 24854, 24854, 24867, 24898, 24932, 24932, 24932, 24932, 24941, 24941, 24941, 24941, 24952, 24952, 24952, 24955, 24955, 24955, 24955, 24971, 24971, 25008, 25009, 25009, 25009, 25009, 25017, 25037, 25037, 25037, 25037, 25037, 25037, 25037, 25106, 25133, 25133, 25133, 25133, 25133, 25146, 25146, 25165, 25165, 25165, 25167, 25194, 25195, 25210, 25210, 25210, 25210, 25210, 25210, 25210, 25210, 25210, 25210, 25214, 25214, 25226, 25226, 25226, 25226, 25226, 25226, 25226, 25226, 25226, 25226, 25226, 25229, 25229, 25229, 25229, 25235, 25235, 25235, 25235, 25235, 25243, 25243, 25243, 25243, 25243, 25243, 25243, 25243, 25243, 25243, 25243, 25243, 25296, 25321, 25321, 25324, 25341, 25341, 25398, 25420, 25420, 25420, 25420, 25420, 25420, 25420, 25420, 25420, 25420, 25511, 25515, 25515, 25515, 25515, 25515, 25515, 25515, 25516, 25516, 25516, 25516, 25535, 25554, 25554, 25554, 25554, 25554, 25554, 25612, 25612, 25612, 25612, 25612, 25632, 25632, 25699, 25707, 25707, 25707, 25707, 25707, 25707, 25707, 25707, 25707, 25707, 25730, 25741, 25772, 25772, 25772, 25772, 25772, 25772, 25772, 25772, 25772, 25787, 25787, 25787, 25795, 25795, 25795, 25803, 25803, 25803, 25803, 25803, 25808, 25808, 25808, 25808, 25821, 25821, 25821, 25821, 25821, 25821, 25827, 25827, 25865, 25865, 25899, 25899, 25899, 25899, 25924, 25924, 25960, 25960, 25960, 25995, 25995, 26021, 26075, 26075, 26075, 26075, 26075, 26075, 26075, 26090, 26090, 26090, 26090, 26090, 26090, 26090, 26090, 26100, 26104, 26176, 26176, 26186, 26186, 26186, 26186, 26186, 26186, 26186, 26186, 26186, 26209, 26216, 26216, 26216, 26282, 26282, 26282, 26288, 26288, 26313, 26318, 26318, 26318, 26318, 26318, 26318, 26318, 26318, 26318, 26318, 26318, 26318, 26318, 26318, 26318, 26355, 26378, 26378, 26378, 26378, 26378, 26379, 26394, 26410, 26410, 26410, 26410, 26432, 26432, 26432, 26432, 26432, 26432, 26432, 26432, 26432, 26432, 26459, 26474, 26474, 26474, 26474, 26474, 26474, 26474, 26474, 26506, 26506, 26507, 26507, 26507, 26569, 26569, 26569, 26569, 26569, 26569, 26569, 26569, 26605, 26605, 26605, 26635, 26635, 26635, 26635, 26635, 26665, 26665, 26665, 26665, 26665, 26665, 26665, 26665, 26665, 26665, 26676, 26676, 26698, 26702, 26702, 26702, 26730, 26761, 26761, 26761, 26799, 26799, 26799, 26799, 26799, 26833, 26857, 26857, 26857, 26857, 26857, 26857, 26865, 26865, 26865, 26865, 26889, 26896, 26896, 26896, 26896, 26952, 26952, 26952, 26952, 26952, 26952, 26952, 26952, 26952, 26995, 26995, 27043, 27043, 27043, 27043, 27043, 27048, 27048, 27048, 27048, 27048, 27048, 27048, 27091, 27091, 27091, 27091, 27126, 27144, 27144, 27144, 27144, 27144, 27153, 27165, 27165, 27188, 27188, 27195, 27195, 27240, 27240, 27265, 27285, 27288, 27288, 27288, 27288, 27292, 27292, 27292, 27292, 27301, 27336, 27336, 27336, 27336, 27336, 27369, 27383, 27383, 27383, 27406, 27411, 27411, 27411, 27411, 27411, 27431, 27431, 27431, 27431, 27449, 27454, 27454, 27495, 27532, 27565, 27565, 27589, 27591, 27623, 27623, 27623, 27623, 27654, 27654, 27654, 27654, 27654, 27654, 27654, 27654, 27654, 27654, 27719, 27771, 27771, 27771, 27771, 27771, 27777, 27814, 27875, 27899, 27899, 27957, 27957, 28017, 28018, 28018, 28021, 28021, 28150, 28159, 28159, 28183, 28244, 28247, 28266, 28266, 28266, 28266, 28266, 28266, 28266, 28266, 28266, 28266, 28266, 28301, 28388, 28428, 28487, 28503, 28503, 28503, 28503, 28503, 28510, 28510, 28510, 28585, 28589, 28589, 28603, 28632, 28632, 28632, 28646, 28657, 28667, 28744, 28744, 28752, 28753, 28754, 28754, 28754, 28773, 28783, 28865, 28865, 28869, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28882, 28938, 28960, 28960, 28996, 28999, 29020, 29029, 29079, 29125, 29125, 29125, 29125, 29125, 29125, 29125, 29125, 29125, 29125, 29125, 29125, 29125, 29125, 29147, 29147, 29153, 29153, 29153, 29160, 29190, 29197, 29197, 29287, 29295, 29295, 29295, 29295, 29297, 29316, 29316, 29316, 29321, 29321, 29321, 29327, 29327, 29345, 29345, 29365, 29375, 29429, 29435, 29435, 29437, 29465, 29488, 29488, 29488, 29488, 29488, 29554, 29554, 29554, 29554, 29579, 29579, 29579, 29579, 29597, 29597, 29597, 29598, 29632, 29636, 29655, 29655, 29655, 29672, 29672, 29672, 29687, 29703, 29711, 29711, 29711, 29711, 29711, 29711, 29711, 29721, 29721, 29732, 29732, 29743, 29761, 29761, 29791, 29791, 29791, 29791, 29791, 29800, 29834, 29851, 29851, 29851, 29863, 29863, 29863, 29863, 29907, 29910, 29910, 29910, 29926, 29926, 29936, 29937, 29937, 29946, 29946, 29946, 29951, 29967, 29969, 29969, 29969, 29969, 29969, 29993, 29993, 29993, 29993, 29993, 30029, 30029, 30029, 30042, 30042, 30042, 30053, 30053, 30053, 30053, 30053, 30053, 30053, 30053, 30075, 30076, 30088, 30112, 30135, 30147, 30147, 30147, 30147, 30147, 30147, 30147, 30147, 30147, 30147, 30147, 30147, 30147, 30147, 30147, 30147, 30163, 30163, 30178, 30200, 30200, 30200, 30207, 30207, 30207, 30207, 30207, 30219, 30219, 30219, 30219, 30247, 30247, 30266, 30275, 30275, 30275, 30275, 30276, 30276, 30276, 30276, 30276, 30276, 30276, 30276, 30276, 30276, 30289, 30317, 30325, 30326, 30326, 30332, 30346, 30346, 30346, 30353, 30353, 30353, 30385, 30385, 30385, 30385, 30385, 30385, 30385, 30388, 30405, 30431, 30431, 30444, 30444, 30444, 30445, 30449, 30469, 30469, 30469, 30490, 30490, 30490, 30493, 30493, 30493, 30501, 30501, 30501, 30501, 30501, 30501, 30501, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30507, 30527, 30546, 30558, 30558, 30558, 30558, 30558, 30558, 30558, 30566, 30573, 30600, 30600, 30620, 30620, 30622, 30622, 30622, 30622, 30622, 30622, 30622, 30622, 30622, 30622, 30623, 30637, 30639, 30639, 30658, 30671, 30671, 30671, 30677, 30682, 30682, 30682, 30682, 30712, 30715, 30715, 30715, 30717, 30727, 30727, 30740, 30740, 30740, 30741, 30741, 30741, 30741, 30741, 30741, 30763, 30783, 30783, 30783, 30783, 30783, 30783, 30783, 30783, 30783, 30785, 30785, 30785, 30785, 30785, 30785, 30785, 30785, 30785, 30785, 30785, 30785, 30785, 30786, 30801, 30801, 30801, 30804, 30840, 30840, 30840, 30840, 30840, 30840, 30840, 30840, 30840, 30840, 30840, 30840, 30840, 30840, 30857, 30857, 30860, 30860, 30860, 30860, 30860, 30860, 30860, 30860, 30870, 30876, 30876, 30876, 30876, 30887, 30887, 30887, 30888, 30896, 30919, 30919, 30919, 30932, 30953, 30953, 30972, 30972, 30972, 30972, 30972, 30979, 30979, 30979, 30979, 30979, 30979, 30979, 30979, 30979, 30979, 30979, 30979, 30988, 30988, 30989, 30989, 30989, 30992, 30992, 31009, 31009, 31009, 31009, 31009, 31038, 31038, 31038, 31038, 31066, 31066, 31066, 31066, 31066, 31066, 31066, 31066, 31066, 31066, 31066, 31066, 31078, 31078, 31078, 31088, 31088, 31088, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31108, 31108, 31108, 31108, 31122, 31122, 31122, 31122, 31122, 31122, 31122, 31122, 31122, 31122, 31132, 31139, 31139, 31139, 31139, 31139, 31139, 31139, 31139, 31153, 31153, 31153, 31153, 31153, 31153, 31157, 31157, 31157, 31157, 31157, 31170, 31170, 31179, 31179, 31195, 31216, 31216, 31216, 31216, 31216, 31216, 31216, 31217, 31225, 31225, 31225, 31226, 31254, 31254, 31276, 31276, 31276, 31276, 31291, 31291, 31307, 31307, 31307, 31312, 31312, 31321, 31321, 31321, 31321, 31335, 31335, 31335, 31335, 31335, 31335, 31335, 31335, 31335, 31341, 31341, 31341, 31345, 31345, 31345, 31345, 31348, 31348, 31348, 31348, 31348, 31348, 31348, 31348, 31348, 31348, 31371, 31371, 31371, 31394, 31394, 31394, 31394, 31394, 31394, 31394, 31394, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31412, 31415, 31420, 31420, 31420, 31444, 31447, 31454, 31454, 31454, 31454, 31454, 31454, 31454, 31454, 31454, 31454, 31454, 31454, 31454, 31457, 31462, 31468, 31474, 31474, 31474, 31474, 31474, 31474, 31513, 31513, 31517, 31517, 31517, 31517, 31517, 31517, 31517, 31517, 31517, 31517, 31517, 31517, 31517, 31517, 31517, 31523, 31523, 31544, 31544, 31544, 31544, 31544, 31558, 31563, 31563, 31563, 31573, 31573, 31573, 31573, 31573, 31573, 31573, 31573, 31573, 31573, 31583, 31583, 31593, 31630, 31630, 31630, 31630, 31630, 31630, 31630, 31630, 31630, 31630, 31630, 31632, 31632, 31632, 31641, 31641, 31641, 31641, 31641, 31641, 31641, 31641, 31641, 31649, 31664, 31664, 31664, 31664, 31664, 31670, 31670, 31670, 31670, 31670, 31670, 31670, 31670, 31680, 31680, 31680, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31687, 31687, 31687, 31687, 31687, 31687, 31687, 31690, 31690, 31690, 31690, 31691, 31691, 31691, 31691, 31691, 31691, 31691, 31691, 31691, 31691, 31691, 31691, 31691, 31691, 31700, 31700, 31701, 31701, 31701, 31701, 31720, 31720, 31720, 31725, 31748, 31748, 31751, 31751, 31751, 31786, 31791, 31799, 31799, 31806, 31809, 31809, 31809, 31809, 31809, 31809, 31809, 31809, 31810, 31810, 31810, 31810, 31810, 31810, 31810, 31810, 31810, 31810, 31810, 31810, 31810, 31810, 31810, 31810, 31820, 31856, 31856, 31856, 31870, 31870, 31872, 31872, 31874, 31902, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31929, 31929, 31929, 31929, 31929, 31932, 31937, 31939, 31939, 31942, 31953, 31953, 31953, 31953, 31953, 31953, 31953, 31956, 31956, 31956, 31956, 31956, 31956, 31956, 31956, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31971, 31976, 31976, 31976, 31988, 31988, 31988, 31988, 31999, 31999, 32015, 32025, 32038, 32038, 32048, 32048, 32058, 32058, 32058, 32059, 32068, 32082, 32103, 32103, 32107, 32112, 32117, 32117, 32138, 32144, 32144, 32144, 32144, 32144, 32144, 32144, 32144, 32150, 32155, 32165, 32166, 32166, 32166, 32166, 32166, 32176, 32192, 32194, 32194, 32194, 32194, 32194, 32194, 32194, 32194, 32194, 32196, 32196, 32220, 32220, 32220, 32220, 32220, 32220, 32220, 32220, 32220, 32220, 32226, 32227, 32227, 32249, 32249, 32249, 32249, 32249, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32271, 32271, 32285, 32291, 32293, 32295, 32295, 32301, 32307, 32307, 32307, 32307, 32311, 32311, 32311, 32311, 32311, 32311, 32354, 32354, 32354, 32364, 32364, 32364, 32404, 32404, 32404, 32412, 32414, 32414, 32420, 32420, 32420, 32420, 32420, 32420, 32425, 32463, 32463, 32477, 32477, 32477, 32477, 32477, 32479, 32479, 32479, 32479, 32479, 32479, 32479, 32487, 32487, 32487, 32487, 32498, 32503, 32504, 32512, 32533, 32533, 32533, 32533, 32533, 32533, 32533, 32533, 32533, 32533, 32533, 32542, 32542, 32553, 32553, 32598, 32598, 32637, 32641, 32644, 32644, 32646, 32646, 32646, 32646, 32646, 32646, 32687, 32702, 32702, 32753, 32753, 32753, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32806, 32813, 32815, 32815, 32815, 32815, 32815, 32865, 32915, 32915, 32928, 32953, 32953, 32981, 32981, 32981, 32981, 32985, 32991, 32991, 32991, 32991, 33041, 33041, 33041, 33043, 33043, 33071, 33097, 33097, 33097, 33097, 33097, 33097, 33120, 33120, 33148, 33186, 33186, 33215, 33274, 33286, 33286, 33286, 33323, 33323, 33323, 33327, 33338, 33420, 33426, 33476, 33476, 33476, 33492, 33501, 33571, 33571, 33571, 33662, 33662, 33691, 33713, 33721, 33790, 33790, 33791, 33818, 33871, 33871, 33888, 33893, 33984, 34022, 34025, 34175, 34226, 34259, 34362, 34393, 34597, 34773, 34887, 34887, 34904, 34923, 34923, 34923, 34923, 34923, 34923, 34923, 34923, 34946, 35073, 35224, 35224, 35374, 35524];

  // Per-canton sorted CHF for cantonal percentile
  const ESTV_CANTON_CHF = {"ZH": [20134, 20223, 20401, 20401, 20401, 20490, 20490, 20490, 20578, 20667, 20667, 20667, 20756, 21200, 21200, 21288, 21288, 21555, 21732, 21732, 21732, 21732, 21821, 21821, 21821, 21910, 21999, 22087, 22087, 22265, 22265, 22265, 22265, 22354, 22442, 22442, 22531, 22531, 22531, 22531, 22531, 22531, 22620, 22620, 22620, 22709, 22709, 22709, 22798, 22798, 22798, 22798, 22798, 22886, 22886, 22886, 22886, 22975, 22975, 22975, 23064, 23064, 23064, 23153, 23153, 23153, 23153, 23153, 23153, 23153, 23241, 23241, 23241, 23241, 23241, 23241, 23330, 23330, 23330, 23330, 23330, 23419, 23419, 23419, 23508, 23508, 23508, 23508, 23508, 23596, 23596, 23596, 23596, 23596, 23596, 23685, 23685, 23685, 23685, 23685, 23685, 23685, 23774, 23774, 23774, 23774, 23774, 23774, 23774, 23774, 23774, 23863, 23863, 23863, 23863, 23863, 23863, 23863, 23952, 23952, 23952, 24040, 24040, 24040, 24040, 24040, 24040, 24040, 24129, 24129, 24129, 24129, 24129, 24129, 24129, 24218, 24218, 24307, 24307, 24307, 24307, 24307, 24395, 24395, 24395, 24484, 24484, 24573, 24573, 24573, 24573, 24573, 24573, 24662, 24839, 24839, 24839, 25017, 25106, 25194], "BE": [26833, 26889, 27454, 27454, 28018, 28018, 28244, 28752, 28865, 28865, 29147, 29147, 29429, 29598, 29655, 29655, 29655, 29711, 29711, 29711, 29711, 29711, 29711, 29711, 29937, 29937, 29993, 29993, 29993, 29993, 29993, 30163, 30163, 30219, 30219, 30219, 30219, 30276, 30276, 30276, 30276, 30276, 30276, 30276, 30276, 30276, 30276, 30332, 30388, 30445, 30501, 30501, 30501, 30501, 30501, 30501, 30501, 30558, 30558, 30558, 30558, 30558, 30558, 30558, 30671, 30671, 30671, 30727, 30727, 30783, 30783, 30783, 30783, 30783, 30783, 30783, 30783, 30783, 30840, 30840, 30840, 30840, 30840, 30840, 30840, 30840, 30840, 30840, 30840, 30840, 30840, 30840, 30896, 30953, 30953, 31009, 31009, 31009, 31009, 31009, 31066, 31066, 31066, 31066, 31066, 31066, 31066, 31066, 31066, 31066, 31066, 31066, 31122, 31122, 31122, 31122, 31122, 31122, 31122, 31122, 31122, 31122, 31179, 31179, 31291, 31291, 31348, 31348, 31348, 31348, 31348, 31348, 31348, 31348, 31348, 31348, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31404, 31517, 31517, 31517, 31517, 31630, 31630, 31630, 31630, 31630, 31630, 31630, 31630, 31630, 31630, 31630, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31686, 31799, 31799, 31856, 31856, 31856, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31912, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 31969, 32025, 32082, 32138, 32194, 32194, 32194, 32194, 32194, 32194, 32194, 32194, 32194, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32251, 32307, 32307, 32307, 32307, 32364, 32364, 32364, 32420, 32420, 32420, 32420, 32420, 32420, 32477, 32477, 32477, 32477, 32477, 32533, 32533, 32533, 32533, 32533, 32533, 32533, 32533, 32533, 32533, 32533, 32646, 32702, 32702, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32759, 32815, 32815, 32815, 32815, 32815, 32928, 32985, 33041, 33041, 33041, 33097, 33097, 33097, 33097, 33097, 33097, 33323, 33323, 33323, 33492, 33662, 33662, 33888, 34226], "LU": [18793, 19913, 20474, 21314, 21594, 21594, 21874, 22154, 22154, 22154, 22154, 22434, 22434, 22714, 22714, 22994, 22994, 23274, 23274, 23274, 23834, 23834, 23834, 23834, 24114, 24114, 24114, 24114, 24114, 24114, 24114, 24114, 24394, 24394, 24394, 24394, 24394, 24394, 24394, 24674, 24674, 24674, 24674, 24674, 24674, 24955, 24955, 24955, 24955, 25235, 25235, 25235, 25235, 25235, 25515, 25515, 25515, 25515, 25515, 25515, 25515, 25795, 25795, 25795, 26075, 26075, 26075, 26075, 26075, 26075, 26075, 26355, 26635, 26635, 26635, 26635, 26635, 27195, 27195], "UR": [20393, 20473, 20554, 20554, 20634, 20795, 20795, 20957, 21118, 21440, 21520, 21601, 21843, 21843, 22004, 22004, 22004, 22487, 22567], "SZ": [12449, 12657, 12865, 14815, 14981, 15230, 15396, 15812, 15812, 15812, 15853, 16019, 16227, 16227, 16227, 16227, 16434, 16476, 16642, 16849, 16891, 17057, 17057, 17513, 17513, 17679, 17887, 17887, 17887, 18343], "OW": [20224, 22020, 22020, 22127, 22341, 22341, 23197], "NW": [18259, 18787, 19743, 20007, 20436, 20436, 20996, 21161, 21590, 21755, 22084], "GL": [23833, 24971, 24971], "ZG": [13165, 13233, 13288, 13349, 13349, 13349, 13349, 13349, 13410, 13655, 14023], "FR": [23759, 26379, 26394, 26730, 27126, 27565, 27565, 28150, 28428, 28589, 28589, 28882, 28999, 29029, 29160, 29190, 29321, 29321, 29321, 29687, 29761, 29761, 29834, 29907, 29951, 30053, 30053, 30053, 30053, 30053, 30053, 30053, 30053, 30200, 30200, 30200, 30346, 30346, 30346, 30405, 30449, 30493, 30493, 30493, 30566, 30639, 30639, 30712, 30785, 30785, 30785, 30785, 30785, 30785, 30785, 30785, 30785, 30785, 30785, 30785, 30785, 30932, 31078, 31078, 31078, 31195, 31225, 31225, 31225, 31254, 31312, 31312, 31371, 31371, 31371, 31415, 31444, 31517, 31517, 31517, 31517, 31517, 31517, 31517, 31517, 31517, 31517, 31517, 31649, 31664, 31664, 31664, 31664, 31810, 31810, 31942, 31956, 31956, 31956, 31971, 32015, 32059, 32103, 32103, 32220, 32249, 32249, 32249, 32249, 32249, 32293, 32425, 32498, 32542, 32542, 32806, 32981, 32981, 32981, 33274, 33713], "SO": [24715, 25296, 26459, 27369, 27495, 28657, 28667, 28773, 28783, 28996, 29345, 29345, 29365, 29597, 29597, 29597, 29703, 29743, 29926, 29926, 29936, 29946, 29946, 29946, 30042, 30042, 30042, 30178, 30275, 30275, 30275, 30275, 30325, 30507, 30527, 30546, 30623, 30740, 30740, 30740, 30876, 30876, 30876, 30876, 30972, 30972, 30992, 30992, 31088, 31088, 31088, 31108, 31108, 31108, 31217, 31321, 31321, 31321, 31321, 31341, 31341, 31341, 31447, 31457, 31563, 31563, 31563, 31583, 31593, 31670, 31670, 31670, 31670, 31670, 31670, 31670, 31670, 31680, 31680, 31680, 31690, 31690, 31690, 31690, 31700, 31700, 31720, 31720, 31720, 31786, 31806, 31902, 31932, 32038, 32038, 32068, 32150, 32155, 32165, 32251, 32271, 32271, 32301, 32503, 33327, 34025], "BS": [24608, 25167, 27406], "BL": [29297, 29465, 29632, 29800, 29967, 30135, 30469, 30469, 30469, 30637, 30804, 30888, 30972, 30972, 30972, 31139, 31139, 31139, 31139, 31139, 31139, 31139, 31139, 31307, 31307, 31307, 31474, 31474, 31474, 31474, 31474, 31474, 31558, 31641, 31641, 31641, 31641, 31641, 31641, 31641, 31641, 31641, 31725, 31809, 31809, 31809, 31809, 31809, 31809, 31809, 31809, 31976, 31976, 31976, 32144, 32144, 32144, 32144, 32144, 32144, 32144, 32144, 32227, 32311, 32311, 32311, 32311, 32311, 32311, 32479, 32479, 32479, 32479, 32479, 32479, 32479, 32512, 32646, 32646, 32646, 32646, 32646, 32813, 32981, 33148, 33818], "SH": [20166, 20385, 21915, 22790, 23008, 23118, 23336, 23445, 23664, 23773, 23883, 24101, 24101, 24211, 24429, 24539, 24867, 25195, 25741, 25960, 25960, 25960, 26288, 26288, 26506, 26506], "AR": [22541, 24323, 24768, 25214, 25214, 25511, 25808, 25808, 25808, 25808, 26104, 26698, 26995, 26995, 27292, 27292, 27292, 27292, 27589, 28183], "AI": [19755, 21984, 22178, 22760, 23632], "SG": [21160, 22035, 22035, 22424, 22618, 22716, 22910, 23493, 23882, 24174, 24174, 24271, 24466, 24466, 24952, 24952, 24952, 25146, 25146, 25243, 25243, 25243, 25341, 25341, 25535, 25632, 25730, 25827, 25827, 25924, 25924, 26216, 26216, 26216, 26313, 26410, 26410, 26410, 26410, 26507, 26507, 26507, 26605, 26605, 26605, 26702, 26702, 26702, 26799, 26799, 26896, 26896, 26896, 26896, 27091, 27091, 27091, 27091, 27188, 27188, 27285, 27383, 27383, 27383, 27771, 27771, 27771, 27771, 27771, 28646, 28744, 28744, 28938, 29327, 29327], "GR": [18673, 19765, 20748, 20857, 20857, 21403, 21403, 21949, 21949, 21949, 22496, 22496, 22496, 22823, 23042, 23042, 23042, 23042, 23042, 23042, 23042, 23042, 23369, 23588, 23588, 23588, 23588, 23588, 23588, 23806, 23915, 24134, 24134, 24134, 24134, 24571, 24571, 24680, 24680, 24680, 24680, 24680, 24680, 24898, 25008, 25226, 25226, 25226, 25226, 25226, 25226, 25226, 25226, 25226, 25226, 25226, 25554, 25772, 25772, 25772, 25772, 25772, 25772, 25772, 25772, 25772, 26100, 26209, 26318, 26318, 26318, 26318, 26318, 26318, 26318, 26318, 26318, 26318, 26318, 26318, 26318, 26318, 26318, 26865, 26865, 26865, 26865, 27301, 27411, 27411, 27411, 27411, 27411, 27957, 27957, 28503, 28503, 28503, 28503, 28503], "AG": [20248, 20440, 21398, 21398, 22547, 22738, 22738, 22834, 23217, 23313, 23505, 23600, 23600, 23696, 23792, 23983, 23983, 24079, 24175, 24175, 24175, 24271, 24462, 24462, 24462, 24462, 24462, 24558, 24654, 24750, 24750, 24750, 24750, 24750, 24845, 24845, 24845, 24845, 24941, 24941, 24941, 24941, 25037, 25037, 25037, 25037, 25037, 25037, 25037, 25133, 25133, 25133, 25133, 25133, 25229, 25229, 25229, 25229, 25324, 25420, 25420, 25420, 25420, 25420, 25420, 25420, 25420, 25420, 25420, 25516, 25516, 25516, 25516, 25612, 25612, 25612, 25612, 25612, 25707, 25707, 25707, 25707, 25707, 25707, 25707, 25707, 25707, 25707, 25803, 25803, 25803, 25803, 25803, 25899, 25899, 25899, 25899, 25995, 25995, 26090, 26090, 26090, 26090, 26090, 26090, 26090, 26090, 26186, 26186, 26186, 26186, 26186, 26186, 26186, 26186, 26186, 26282, 26282, 26282, 26378, 26378, 26378, 26378, 26378, 26474, 26474, 26474, 26474, 26474, 26474, 26474, 26474, 26569, 26569, 26569, 26569, 26569, 26569, 26569, 26569, 26665, 26665, 26665, 26665, 26665, 26665, 26665, 26665, 26665, 26665, 26761, 26761, 26761, 26857, 26857, 26857, 26857, 26857, 26857, 26952, 26952, 26952, 26952, 26952, 26952, 26952, 26952, 26952, 27048, 27048, 27048, 27048, 27048, 27048, 27048, 27144, 27144, 27144, 27144, 27144, 27240, 27240, 27336, 27336, 27336, 27336, 27336, 27431, 27431, 27431, 27431, 27623, 27623, 27623, 27623, 27719, 27814], "TG": [20498, 20887, 21198, 21743, 22443, 22598, 22676, 22909, 23143, 23143, 23221, 23532, 23532, 23687, 23765, 23843, 24076, 24154, 24154, 24154, 24232, 24309, 24387, 24387, 24387, 24387, 24465, 24465, 24543, 24543, 24543, 24621, 24621, 24621, 24698, 24698, 24698, 24698, 24776, 24854, 24854, 24854, 24932, 24932, 24932, 24932, 25009, 25009, 25009, 25009, 25165, 25165, 25165, 25243, 25243, 25243, 25243, 25243, 25243, 25243, 25243, 25243, 25321, 25321, 25398, 25554, 25554, 25554, 25554, 25554, 25632, 25787, 25787, 25787, 25865, 25865, 26021, 26176, 26176, 27265], "TI": [24109, 24354, 24598, 24598, 24598, 25210, 25210, 25210, 25210, 25210, 25210, 25210, 25210, 25210, 25210, 25699, 25821, 25821, 25821, 25821, 25821, 25821, 26432, 26432, 26432, 26432, 26432, 26432, 26432, 26432, 26432, 26432, 26676, 26676, 26799, 26799, 26799, 27043, 27043, 27043, 27043, 27043, 27288, 27288, 27288, 27288, 27532, 27654, 27654, 27654, 27654, 27654, 27654, 27654, 27654, 27654, 27654, 27777, 27899, 27899, 28021, 28021, 28266, 28266, 28266, 28266, 28266, 28266, 28266, 28266, 28266, 28266, 28266, 28388, 28510, 28510, 28510, 28632, 28632, 28632, 28754, 28754, 28754, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 28877, 29488, 29488, 29488, 29488, 29488], "VD": [28247, 28603, 28960, 28960, 29079, 29197, 29197, 29316, 29316, 29316, 29375, 29435, 29435, 29554, 29554, 29554, 29554, 29672, 29672, 29672, 29732, 29732, 29791, 29791, 29791, 29791, 29791, 29851, 29851, 29851, 29910, 29910, 29910, 29969, 29969, 29969, 29969, 29969, 30029, 30029, 30029, 30088, 30147, 30147, 30147, 30147, 30147, 30147, 30147, 30207, 30207, 30207, 30207, 30207, 30266, 30326, 30326, 30385, 30385, 30385, 30385, 30385, 30385, 30385, 30444, 30444, 30444, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30504, 30622, 30622, 30622, 30622, 30622, 30622, 30622, 30622, 30622, 30622, 30682, 30682, 30682, 30682, 30741, 30741, 30741, 30741, 30741, 30741, 30801, 30801, 30801, 30860, 30860, 30860, 30860, 30860, 30860, 30860, 30860, 30870, 30919, 30919, 30919, 30979, 30979, 30979, 30979, 30979, 30979, 30979, 30979, 30979, 30979, 30979, 30979, 30989, 30989, 30989, 31038, 31038, 31038, 31038, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31098, 31108, 31157, 31157, 31157, 31157, 31157, 31216, 31216, 31216, 31216, 31216, 31216, 31216, 31226, 31276, 31276, 31276, 31276, 31335, 31335, 31335, 31335, 31335, 31335, 31335, 31335, 31335, 31345, 31345, 31345, 31345, 31394, 31394, 31394, 31394, 31394, 31394, 31394, 31404, 31454, 31454, 31454, 31454, 31454, 31454, 31454, 31454, 31454, 31454, 31454, 31454, 31454, 31513, 31513, 31523, 31523, 31573, 31573, 31573, 31573, 31573, 31573, 31573, 31573, 31573, 31573, 31632, 31632, 31632, 31691, 31691, 31691, 31691, 31691, 31691, 31691, 31691, 31691, 31691, 31691, 31691, 31691, 31691, 31701, 31701, 31701, 31701, 31751, 31751, 31751, 31810, 31810, 31810, 31810, 31810, 31810, 31810, 31810, 31810, 31810, 31810, 31810, 31810, 31810, 31820, 31870, 31870, 31929, 31929, 31929, 31929, 31929, 31939, 31939, 31988, 31988, 31988, 31988, 32048, 32048, 32058, 32058, 32058, 32107, 32117, 32117, 32166, 32166, 32166, 32166, 32166, 32176, 32226, 32285, 32291, 32295, 32295, 32404, 32404, 32404, 32414, 32414, 32463, 32463, 32641], "VS": [29125, 29125, 29125, 29125, 29125, 29125, 29125, 29125, 29125, 29125, 29125, 29125, 29125, 29125, 29636, 30112, 30147, 30147, 30147, 30147, 30147, 30247, 30247, 30317, 30353, 30490, 30490, 30490, 30600, 30600, 30658, 30677, 30717, 30763, 30988, 30988, 31132, 31170, 31170, 31254, 31394, 31412, 31462, 31468, 31544, 31544, 31544, 31544, 31544, 31583, 31664, 31748, 31748, 31791, 31872, 31872, 31874, 31937, 31956, 31956, 31956, 31956, 31956, 31999, 31999, 32112, 32192, 32196, 32196, 32227, 32354, 32354, 32354, 32412, 32504, 32553, 32553, 32598, 32598, 32637, 32644, 32644, 32687, 32865, 32915, 32915, 32953, 32953, 32991, 32991, 32991, 32991, 33043, 33043, 33071, 33186, 33186, 33215, 33286, 33286, 33286, 33338, 33426, 33476, 33476, 33476, 33501, 33691, 33790, 33790, 33791, 33893, 33984, 34175, 34259, 34362, 34393, 34597, 34887, 34887, 34904, 34946], "NE": [33120, 33120, 33420, 33571, 33571, 33571, 33721, 33871, 33871, 34022, 34773, 34923, 34923, 34923, 34923, 34923, 34923, 34923, 34923, 35073, 35224, 35224, 35374, 35524], "GE": [27165, 27165, 27449, 27591, 27875, 28017, 28159, 28159, 28301, 28585, 28869, 29153, 29153, 29153, 29295, 29295, 29295, 29295, 29437, 29579, 29579, 29579, 29579, 29721, 29721, 29863, 29863, 29863, 29863, 30075, 30076, 30147, 30147, 30147, 30147, 30289, 30431, 30431, 30573, 30715, 30715, 30715, 30786, 30857, 30857], "JU": [27153, 28487, 28753, 29020, 29287, 30353, 30353, 30620, 30620, 30887, 30887, 30887, 31153, 31153, 31153, 31153, 31153, 31153, 31420, 31420, 31420, 31687, 31687, 31687, 31687, 31687, 31687, 31687, 31953, 31953, 31953, 31953, 31953, 31953, 31953, 32220, 32220, 32220, 32220, 32220, 32220, 32220, 32220, 32220, 32487, 32487, 32487, 32487, 32753, 32753, 32753]};

  function estvBurdenLookup(comm) {
    const norm = comm.replace(/\./g,'').replace(/-/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
    if (ESTV_BURDEN[norm]) return ESTV_BURDEN[norm];
    // Strip trailing canton abbreviation: "laax gr" -> "laax", "zürich zh" -> "zürich"
    const noKt = norm.replace(/ [a-z]{2}$/, '').trim();
    if (noKt !== norm && ESTV_BURDEN[noKt]) return ESTV_BURDEN[noKt];
    // Without parenthetical suffix: "aesch (zh)" -> "aesch"
    const noParen = norm.replace(/ \([a-z]+\)$/, '').trim();
    if (noParen !== norm && ESTV_BURDEN[noParen]) return ESTV_BURDEN[noParen];
    // Fuzzy first-word match (min 3 chars)
    const first = norm.split(' ')[0];
    if (first.length >= 3) {
      const match = Object.entries(ESTV_BURDEN).find(([k]) => k === first || k.startsWith(first + ' '));
      if (match) return match[1];
    }
    return null;
  }

  function estvNatPct(chf) {
    const n = ESTV_CHF_SORTED.length;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo+hi+1)>>1; ESTV_CHF_SORTED[mid] <= chf ? lo=mid : hi=mid-1; }
    return Math.round((lo+1) / n * 100);
  }

  function estvKtPct(chf, canton) {
    const arr = ESTV_CANTON_CHF[canton];
    if (!arr || !arr.length) return 50;
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const mid = (lo+hi+1)>>1; arr[mid] <= chf ? lo=mid : hi=mid-1; }
    return Math.round((lo+1) / arr.length * 100);
  }

  const estvResult = estvBurdenLookup(communeLower);
  let steuerfuss    = null;  // signal: non-null = tax data available
  let taxBurdenCHF  = null;  // total CHF (Bund+Kt+Gem)
  let taxBurdenPct  = null;  // effective % of gross income
  let estvKanton    = null;
  let estvBfsnr     = null;
  let estvNatPctVal = null;
  let estvKtPctVal  = null;
  let taxBurdenSource = null;

  if (estvResult) {
    taxBurdenCHF    = estvResult[0];
    taxBurdenPct    = estvResult[1];
    estvKanton      = estvResult[2];
    estvBfsnr       = estvResult[3];
    estvNatPctVal   = estvNatPct(taxBurdenCHF);
    estvKtPctVal    = estvKtPct(taxBurdenCHF, estvKanton);
    steuerfuss      = taxBurdenCHF;
    taxBurdenSource = 'estv_2025';
  }
  console.log('SUMMARY → noise:', noiseDay, '| solar:', solarKwh, '| oev:', oevDist, '| crime:', crime.hzahl, '| tax:', steuerfuss, '(nat:', estvNatPctVal, 'kt:', estvKtPctVal, ')| delta:', delta+'%');

  // ── 9. PROMPT ───────────────────────────────────────────────────
  const streetInfo = streetData
    ? `Strassendaten (${streetData.street_name}): Kaufpreis CHF ${streetData.median_sale_price_sqm?.toLocaleString('de-CH')}/m² · ${streetPercentile}. Perzentile in der Gemeinde (${streetPercentile < 33 ? 'günstiges' : streetPercentile < 66 ? 'mittleres' : 'gehobenes'} Segment)`
    : 'Strassendaten: nicht verfügbar';

  // Befristung check
  const befristet = parsedInsert?.befristet || false;
  const befristetDetails = parsedInsert?.befristet_details || null;
  const besonderheiten = parsedInsert?.besonderheiten || [];
  const marketingFlags = parsedInsert?.marketing_flags || [];
  const inseratZusammenfassung = parsedInsert?.zusammenfassung || null;

  // Language support
  const reportLang = ['en','fr'].includes(lang) ? lang : 'de';
  const langInstruction = {
    de: 'Erstelle den Bericht vollständig auf Deutsch.',
    en: 'Write the entire report in English. Use British English.',
    fr: 'Rédige l\'intégralité du rapport en français.'
  }[reportLang];

  const langSections = {
    de: {
      priceSection: '## Preiseinschätzung',
      prosSection: '## Was für dieses Angebot spricht',
      insertSection: '## Inserat-Analyse',
      criticalSection: '## Was kritisch zu prüfen ist',
      locationSection: '## Lagequalität',
      taxSection: '## Steuerlicher Vorteil',
      checklistSection: '## Besichtigungs-Checkliste',
      conclusionSection: '## Fazit',
    },
    en: {
      priceSection: '## Price assessment',
      prosSection: '## What speaks for this listing',
      insertSection: '## Listing analysis',
      criticalSection: '## What to scrutinise',
      locationSection: '## Location quality',
      taxSection: '## Tax advantage',
      checklistSection: '## Viewing checklist',
      conclusionSection: '## Summary',
    },
    fr: {
      priceSection: '## Évaluation du prix',
      prosSection: '## Points positifs',
      insertSection: "## Analyse de l'annonce",
      criticalSection: '## Points à vérifier',
      locationSection: '## Qualité de situation',
      taxSection: '## Avantage fiscal',
      checklistSection: '## Liste de contrôle visite',
      conclusionSection: '## Conclusion',
    }
  };
  const s = langSections[reportLang];

  const today = reportDate || new Date().toLocaleDateString('de-CH', {day:'2-digit',month:'long',year:'numeric'});
  const prompt = `${langInstruction}

Du bist ein unabhängiger Schweizer Immobilienexperte. Erstelle einen vollständigen Analysebericht. Sei direkt, konkret, ehrlich — kein Marketing.
Heutiges Datum: ${today}.

WICHTIGE REGELN — ABSOLUT VERBINDLICH:
- ZIMMERANZAHL: Verwende ausschliesslich ${rooms} Zimmer. Diese Zahl ist fix und final. Ignoriere jede andere Zahl im Inseratstext vollständig — auch wenn du eine andere Zahl siehst, schreibe sie nicht.${parsedInsert?.zimmer && Math.abs(parseFloat(parsedInsert.zimmer) - parseFloat(rooms)) >= 0.5 ? `\n- ZIMMER-WIDERSPRUCH BESTÄTIGT: Das Inserat nennt explizit ${parsedInsert.zimmer} Zimmer, das Formular zeigt ${rooms}. Weise einmal darauf hin: "Zimmeranzahl-Widerspruch: Formular ${rooms} Zi. / Inserat ${parsedInsert.zimmer} Zi. — bitte klären."` : ''}
- BAUJAHR: Verwende ausschliesslich die Baujahrkategorie "${year}" aus dem Formular. Erwähne KEIN anderes Baujahr und mache KEINEN Vergleich mit dem Inseratstext. Zahlen im Inseratstext die wie Jahreszahlen aussehen können Referenznummern, Preise oder andere Werte sein — ignoriere sie vollständig für das Baujahr.
- UNVOLLSTÄNDIGER TEXT: Wenn der Inseratstext abrupt endet oder unvollständig wirkt, schreibe NUR: "Hinweis: Der eingegebene Inseratstext scheint unvollständig. Bitte überprüfen und allenfalls neu einfügen." Kommentiere NICHT die Qualität oder Professionalität des Inserats aufgrund eines abrupten Textendes.
- HALLUZINATIONSVERBOT: Erfinde KEINE Fakten, Ausstattungsmerkmale, Lagedetails oder Eigenschaften die nicht in den Daten oder im Inseratstext stehen. "Nicht verfügbar" ist besser als eine Erfindung.
- KONTROLLFRAGE vor jedem Satz: "Steht das explizit in den Daten oder im Inseratstext?" — wenn nein, nicht schreiben.

INSERAT:
Adresse: ${label}${geoAccuracy === 'gemeinde' ? ' (NUR GEMEINDE BEKANNT)' : ''}
Typ: ${isKauf?(propertyKind==='haus'?'Kaufhaus/EFH':'Kaufwohnung'):(propertyKind==='haus'?'Miethaus/EFH':'Mietwohnung')} | ${rooms} Zimmer | ${area} m² | ${propertyKind !== 'haus' ? 'Etage '+floor+' | ' : ''}Baujahr ${year}
Tourismusregion: ${['7031','7032','7033','3920','3906','7050','3823','3818','7260','7500','7504','7505'].includes(String(plz)) ? 'JA — Ferienort/Tourismusgemeinde. Wichtig: Bei Kauf unterscheiden ob Erstwohnung (günstiger, eingeschränkte Nutzung) oder Zweitwohnung (teurer, freier vermietbar). Bei bewirtschafteter Zweitwohnung: Rendite-Kalkulation relevant, Eigentümer hat eingeschränkte Eigennutzung. Lex Koller und Zweitwohnungsgesetz beachten.' : 'Nein'}
Zustand: ${CONDITION_LABEL[condition]||'–'}${conditionNote} | Aussenraum: ${isHaus ? 'EFH (Aussenraum inbegriffen)' : {none:'Kein Aussenraum',balkon:'Balkon',terrasse:'Terrasse',garten:'Garten/Sitzplatz'}[outdoor]||'–'}
Preis: CHF ${parseInt(price).toLocaleString('de-CH')}${isKauf?'':'/Mt.'} (CHF ${pricePerQm}/m²)${extraInfo ? `
Zusätzliche Infos: ${extraInfo}` : ''}

${insertText ? `INSERATSTEXT:
${insertText.substring(0, 4000)}

${befristet ? '*** BEFRISTETER MIETVERTRAG: ' + (befristetDetails || '') + ' ***' : ''}
${marketingFlags.length ? 'Marketing-Begriffe: ' + marketingFlags.join(', ') : ''}
` : ''}MARKTDATEN (Quelle: ${priceSource}):
Referenzpreis: CHF ${expected.toLocaleString('de-CH')}${isKauf?'':'/Mt.'} → Abweichung: ${delta>0?'+':''}${delta}%
${priceRangeText}
${streetInfo}

BEHÖRDEN-DATEN:
Lärm (${noiseSource}): ${noiseDay ? noiseDay+' dB' : 'nicht verfügbar'}
Besonnung: ${solarKwh?Math.round(solarKwh)+' kWh/Jahr':'nicht verfügbar'}
ÖV: ${oevDist?oevDist+'m → '+oevName+' ('+oevCount+' Haltestellen/800m)':'nicht verfügbar'}
Autoanbindung: ${autobahnName ? autobahnName+(autobahnFahrzeit?' · '+autobahnFahrzeit+' Min zur Ausfahrt':'')+' ('+Math.round((autobahnDist||0)/100)/10+' km)'+(autobahnRichtungen?' Richtung '+autobahnRichtungen.join(' ↔ '):'') : 'keine Autobahn in 15km'}
Sicherheit: ${crime.hzahl} Delikte/1000 Einw. in ${crime.label}${steuerfuss?`
Steuerfuss: ${steuerfuss}%`:''}
Marktlage: Leerwohnungsziffer ${req.body.lwz||'unbekannt'}% → ${(req.body.lwz||1.08)<0.5?'extrem angespannt – kaum Verhandlungsspielraum':(req.body.lwz||1.08)<1.0?'angespannt – wenig Spielraum':(req.body.lwz||1.08)>2.0?'entspannt – Verhandlung möglich':'normal'}

UMGEBUNG: ${amenitySummary||'keine Daten'}

---

${befristet ? `## !! BEFRISTETER MIETVERTRAG !!
${befristetDetails || ''}. Erkläre die Konsequenzen für den Mieter.

` : ''}${s.priceSection}
Bewerte: fair / überteuert / günstig. ${delta>0?'+':''}${delta}% Abweichung erklären.

${s.prosSection}
3–5 konkrete Vorteile.

${s.insertSection}
${insertText ? 'Analysiere den Inseratstext kritisch.' : 'Kein Inseratstext vorhanden.'}

${s.criticalSection}
3–5 Risiken und Hinweise.

${s.locationSection}
Lärm, Besonnung, ÖV mit Messwerten.
${taxBurdenCHF ? (() => {
    const np = estvNatPctVal || 50;
    const cp = estvKtPctVal || 50;
    const taxLabel = np <= 5  ? 'ausgesprochen tief ★★★★★' :
                    np <= 20  ? 'tief ★★★★' :
                    np <= 45  ? 'moderat ★★★' :
                    np <= 65  ? 'durchschnittlich ★★★' :
                    np <= 80  ? 'leicht überdurchschnittlich ★★' : 'hoch ★';
    // Avoid contradiction: only use ONE national ranking statement
    const natRankText = np <= 10
      ? `unter den ${np}% günstigsten Gemeinden der Schweiz`
      : np <= 50
      ? `günstiger als ${100-np}% aller Schweizer Gemeinden`
      : np <= 90
      ? `teurer als ${np-50}% der Schweizer Gemeinden`
      : `unter den teuersten ${100-np}% der Schweizer Gemeinden`;
    const ktLabel = cp <= 15  ? `eine der günstigsten Gemeinden im Kanton ${estvKanton}` :
                    cp >= 85  ? `eine der teuersten Gemeinden im Kanton ${estvKanton}` :
                    `mittleres Niveau im Kanton ${estvKanton}`;
    if (taxBurdenCHF) {
      return `
${s.taxSection}
Geschätzte Einkommenssteuer: CHF ${taxBurdenCHF.toLocaleString('de-CH')}/Jahr${taxBurdenPct ? ` (${taxBurdenPct}% effektiv)` : ''} — ${taxLabel}.
Kantonsvergleich: ${ktLabel} (${cp}. Perzentile im Kanton ${estvKanton}).
Schweizweit: ${natRankText} (${np}. Perzentile).
Profil: ledig, CHF 150'000 Bruttoeinkommen, ohne Kirchensteuer.`;
    } else {
      return `
${s.taxSection}
Steuerfuss-Ranking: ${taxBurdenPct}%% (Kanton + Gemeinde) — ${taxLabel}.
Kantonsvergleich: ${ktLabel} (${cp}. Perzentile).
Nationaler Vergleich: günstiger als ${100-np}% aller Schweizer Gemeinden (${np}. Perzentile).
Hinweis: CHF-Wert wird berechnet sobald Daten vollständig geladen. Für genaue Berechnung: estv.admin.ch. Quelle: ESTV 2025.`;
    }
  })() : ''}

${s.checklistSection}
${isKauf ? `Erstelle eine Kauf-spezifische Checkliste mit 10–12 Punkten. Fokus auf:
UNTERLAGEN die zwingend bezogen werden müssen:
- Grundbuchauszug (aktuell, alle Lasten und Dienstbarkeiten prüfen)
- Amtliche Schätzung (falls vorhanden, Vergleich mit Kaufpreis)
- Bei Stockwerkeigentum: Begründungsakt, Reglement der STWEG, Protokolle der letzten 3 GV, Erneuerungsfonds-Auszug
- GVG-Police (Gebäudeversicherung) und Prämien
- Zonenplan und Baubewilligung (ev. bestehende Baurechte)
- Beizug eines Notars und unabhängigen Schätzers empfehlen

BAULICHER ZUSTAND:
- Unabhängige Baufachperson beiziehen
- Heizung, Elektrik, Leitungen: Alter und Zustand
- Feuchtigkeitsschäden, Schimmel, Risse
- Energieetikett und GEAK-Ausweis

FINANZIELLES:
- Tragbarkeitsrechnung (Hypothek max. 33% des Bruttoeinkommens)
- Amortisationsplan (indirekte Amortisation via Säule 3a)
- Nebenkosten: Grundstückgewinnsteuer, Handänderungssteuer, Notarkosten
- Unterhalts- und Erneuerungsrücklage einkalkulieren
${['7031','7032','7033','3920','3906','7050','3823','3818','7260','7500','7504','7505'].includes(String(plz)) ? `
TOURISMUSGEMEINDE — zusätzliche Punkte:
- Erstwohnung oder Zweitwohnung? (Zweitwohnungsgesetz: max. 20% Zweitwohnungen pro Gemeinde)
- Bei Zweitwohnung: Vermietungspflicht? Renditeerwartung realistisch prüfen
- Bei bewirtschafteter Wohnung: Bewirtschaftungsvertrag und Konditionen genau prüfen
- Lex Koller: Ausländische Käufer brauchen Bewilligung für Zweitwohnungen
- Stockwerkeigentum in Ferienresort: Hausordnung, Belegungsregeln, Verwaltungsgebühren` : ''}` 
: `Erstelle eine Miet-spezifische Checkliste mit 8–10 Punkten:
- Lärmprobe zu verschiedenen Tageszeiten (Verkehr, Nachbarn, Gewerbe)
- Mobilfunk- und Internetempfang vor Ort testen
- Heizungsart, Energieklasse und Nebenkosten der letzten 2 Jahre erfragen
- Fensterverglasung, Dämmung und Zugluft prüfen
- Zustand von Küche, Bädern, Böden und Steckdosen
- Vermieter/Hausverwaltung googeln, Bewertungen suchen
- Kellerabteil, Veloraum, Parkplatz: Zustand und Kosten klären
- Mietvertrag auf Sonderbedingungen, Kündigungsfristen prüfen
- Übergabeprotokoll sorgfältig ausfüllen
- Bei Befristung: Verlängerungsbedingungen schriftlich klären`}

${s.conclusionSection}
3 Sätze: Gesamtbewertung, Empfehlung, Verhandlungshinweis.`;

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
      meta: {
        noiseDay, solarKwh, oevDist, oevName, oevCount, amenitySummary, crime, steuerfuss,
        condition, conditionFactor, delta, expected, priceRangeText, priceSource,
        outdoor, outdoorFactor, befristet, befristetDetails,
        streetData: streetData ? { name: streetData.street_name, salePerSqm: streetData.median_sale_price_sqm, percentile: streetPercentile } : null,
        lat: lat?.toFixed(4), lon: lon?.toFixed(4), geoAccuracy
      }
    });
  } catch(err) {
    return res.status(500).json({error:'Server-Fehler: '+err.message});
  }
}