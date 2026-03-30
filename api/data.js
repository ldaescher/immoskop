export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { address, rooms, area, price, type, year, floor, outdoor, condition, propertyKind } = req.body;
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

  let expected, refPerSqmUsed;
  if (isKauf && refSalePerSqm) {
    refPerSqmUsed = refSalePerSqm;
    expected = Math.round(refSalePerSqm * area * yearFactor * floorFactor * outdoorFactor * conditionFactor * propertyFactor);
  } else if (!isKauf && refRentPerSqm && refRentPerSqm < 500) {
    // Sanity check: rent per m²/month should be between 5 and 500 CHF
    refPerSqmUsed = refRentPerSqm;
    expected = Math.round(refRentPerSqm * area * yearFactor * floorFactor * outdoorFactor * conditionFactor * propertyFactor);
  } else if (!isKauf && !refRentPerSqm && refSalePerSqm) {
    // Estimate rent from sale price (gross yield ~4-5% for CH)
    const estRentPerSqm = Math.round(refSalePerSqm * 0.045 / 12 * 10) / 10;
    refPerSqmUsed = estRentPerSqm;
    expected = Math.round(estRentPerSqm * area * yearFactor * floorFactor * outdoorFactor * conditionFactor * propertyFactor);
    priceSource = priceSource + ' (Miete aus Kaufpreis geschätzt, 4.5% Bruttorendite)';
  } else {
    // Last fallback
    refPerSqmUsed = 17;
    expected = isKauf ? Math.round(8000 * area * outdoorFactor * conditionFactor) : Math.round(17 * area * outdoorFactor * conditionFactor);
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
    'genf':{hzahl:110,label:'Genf'},'geneve':{hzahl:110,label:'Genf'},'geneva':{hzahl:110,label:'Genf'},'genève':{hzahl:110,label:'Genf'},
    'winterthur':{hzahl:62,label:'Winterthur'},
    'luzern':{hzahl:58,label:'Luzern'},'lucerne':{hzahl:58,label:'Luzern'},
    'lausanne':{hzahl:95,label:'Lausanne'},
    'lugano':{hzahl:65,label:'Lugano'},
    'locarno':{hzahl:48,label:'Locarno'},
    'bellinzona':{hzahl:42,label:'Bellinzona'},
    'sion':{hzahl:52,label:'Sion'},'sitten':{hzahl:52,label:'Sion'},
    'freiburg':{hzahl:55,label:'Freiburg'},'fribourg':{hzahl:55,label:'Fribourg'},
    'biel':{hzahl:68,label:'Biel'},'bienne':{hzahl:68,label:'Biel/Bienne'},
    'neuchatel':{hzahl:72,label:'Neuchâtel'},'neuenburg':{hzahl:72,label:'Neuchâtel'},
    'kilchberg':{hzahl:18,label:'Kilchberg'},'küsnacht':{hzahl:16,label:'Küsnacht'},
    'thalwil':{hzahl:22,label:'Thalwil'},'zollikon':{hzahl:20,label:'Zollikon'},
    'uster':{hzahl:45,label:'Uster'},'laax':{hzahl:12,label:'Laax'},
    'davos':{hzahl:35,label:'Davos'},'st. gallen':{hzahl:54,label:'St. Gallen'},
  };
  // Normalize: remove accents for multilingual lookup
  const labelLower = (label||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // For tax/crime lookup: use only commune part (after PLZ), not street name
  // e.g. "Kilchbergstrasse 1 8038 Zürich" -> commune = "zürich"
  const plzMatch2 = labelLower.match(/\b\d{4}\b\s+(.+)$/);
  const communeLower = plzMatch2 ? plzMatch2[1].trim() : labelLower;
  console.log('COMMUNE for lookup:', communeLower);
  let crime = {hzahl:38,label:'diese Gemeinde'};
  for (const [key,val] of Object.entries(CRIME)) {
    if (communeLower.includes(key)) { crime = val; break; }
  }

  // ── 8. STEUERFUSS ───────────────────────────────────────────────
  const ZURICH_QUARTERS = ['wollishofen','leimbach','enge','langstrasse','hard','sihlfeld','friesenberg','albisrieden','altstetten','wipkingen','höngg','oberstrass','unterstrass','seebach','affoltern','oerlikon','schwamendingen','witikon','riesbach','fluntern','hottingen','hirslanden','aussersihl','escher wyss'];
  const TAXES = {
    'kilchberg':72,'küsnacht':73,'zollikon':78,'herrliberg':75,'thalwil':80,'rüschlikon':73,'adliswil':84,
    'zürich':119,'zurich':119,'winterthur':122,
    'bern':116,'berne':116,'köniz':116,
    'basel':96,'bale':96,'riehen':92,
    'genf':45,'geneve':45,'geneva':45,'genève':45,
    'lausanne':79,'pully':70,'lutry':68,'morges':74,
    'luzern':107,'lucerne':107,'kriens':107,
    'lugano':72,'locarno':78,'bellinzona':82,
    'sion':122,'sitten':122,'martigny':125,
    'freiburg':93,'fribourg':93,
    'biel':107,'bienne':107,
    'neuchatel':115,'neuenburg':115,
    'st. gallen':116,'st.gallen':116,
    'zug':82,'baar':82,'cham':84,
    'aarau':106,'baden':100,'wettingen':103,
    'laax':98,'davos':95,'st. moritz':85,'klosters':90,
    'verbier':90,'zermatt':85,'crans':95,
    'schaffhausen':113,'frauenfeld':106,
    'solothurn':110,'olten':110,'zofingen':106,
    'thun':108,'spiez':108,'interlaken':104,
    'chur':117,'arosa':90,'arlesheim':68,
  };
  const isZurichQuarter = ZURICH_QUARTERS.some(q => communeLower.includes(q));
  if (isZurichQuarter) steuerfuss = 119;
  let steuerfuss = null;
  if (!isZurichQuarter) {
    for (const [key,val] of Object.entries(TAXES)) {
      if (communeLower.includes(key)) { steuerfuss = val; break; }
    }
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
      lat: lat?.toFixed(4), lon: lon?.toFixed(4), geoAccuracy
    }
  });
}
