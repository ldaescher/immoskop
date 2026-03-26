// Vercel Cron Job: runs weekly (Sunday 2am)
// Scrapes Homegate.ch search pages for rental listings per PLZ
// Stores median CHF/m2 per PLZ in Supabase

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const PLZ_LIST = [
  // Zürich Stadt
  '8001','8002','8003','8004','8005','8006','8008','8032','8037','8038','8044','8045','8046','8047','8048','8049','8050','8051','8052','8053','8055','8057',
  // Zürich Agglomeration
  '8102','8103','8105','8106','8108','8112','8113','8116','8117','8121','8122','8123','8124','8125','8126','8132','8133','8134','8142','8143','8152','8153','8154','8155','8156','8157','8158','8162','8163','8172','8173','8174','8175','8180','8181','8182','8184','8185',
  // Seegemeinden
  '8700','8702','8703','8704','8706','8707','8708','8712','8713','8714','8716','8717','8718','8724','8725','8800','8802','8803','8804','8805','8806','8807','8808','8810','8813','8815','8816','8820','8824','8825','8832','8833','8834','8835','8836','8840','8841','8842','8843','8844','8845','8846','8847','8848','8849','8852','8853','8854','8855','8856','8857','8858','8862','8863','8864','8865','8866','8867','8868',
  // Winterthur
  '8400','8401','8402','8403','8404','8405','8406','8407','8408','8409','8410','8411','8412','8413',
  // Bern
  '3000','3004','3005','3006','3007','3008','3010','3011','3012','3013','3014','3015','3018','3019','3020','3027','3028',
  // Basel
  '4001','4002','4003','4004','4005','4010','4012','4013','4018','4019','4020','4021','4022','4023','4024','4025','4030','4031','4032','4033','4034','4035','4036','4037','4038','4039','4040','4041','4042','4043','4044','4045','4046','4047','4048','4049','4050','4051','4052','4053','4054','4055','4056','4057','4058','4059',
  // Lausanne
  '1000','1003','1004','1005','1006','1007','1008','1009','1010','1011','1012','1013','1014','1015',
  // Genf
  '1200','1201','1202','1203','1204','1205','1206','1207','1208','1209','1210','1211','1212','1213','1214','1215','1216','1217','1218','1219','1220','1221','1222','1223','1224','1225','1226','1227','1228',
  // Luzern
  '6002','6003','6004','6005','6006','6010','6012','6013','6014','6015','6016','6017',
  // St. Gallen
  '9000','9006','9007','9008','9010','9011','9012','9013','9014','9015','9016',
];

async function scrapeHomegate(plz) {
  try {
    // Homegate search URL for rentals by PLZ
    const url = `https://www.homegate.ch/mieten/immobilien/plz-${plz}/trefferliste?ep=1`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-CH,de;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(12000)
    });

    if (!res.ok) return null;
    const html = await res.text();

    // Extract __INITIAL_STATE__ JSON from script tag
    const match = html.match(/__INITIAL_STATE__\s*=\s*({[\s\S]+?});\s*(?:window|<\/script>)/);
    if (!match) {
      // Try alternative JSON extraction
      const match2 = html.match(/<script[^>]+>\s*window\.__INITIAL_STATE__\s*=\s*([\s\S]+?)\s*<\/script>/);
      if (!match2) return null;
    }

    const jsonStr = (match || [])[1];
    if (!jsonStr) return null;

    const data = JSON.parse(jsonStr);

    // Navigate to listings in Homegate's state structure
    const listings =
      data?.resultList?.listItems ||
      data?.listing?.listItems ||
      data?.listings?.listItems ||
      data?.search?.results ||
      [];

    if (!Array.isArray(listings) || listings.length === 0) return null;

    const pricesPerSqm = [];
    const prices = [];

    listings.forEach(item => {
      const listing = item?.listing || item;
      const rent = listing?.prices?.rent?.gross ||
                   listing?.prices?.rent?.net ||
                   listing?.rent ||
                   listing?.price;
      const area = listing?.characteristics?.livingSpace ||
                   listing?.livingSpace ||
                   listing?.usableSpace;

      if (rent && area && area > 20 && area < 400 && rent > 500 && rent < 25000) {
        pricesPerSqm.push(rent / area);
        prices.push(rent);
      }
    });

    if (pricesPerSqm.length < 2) return null;

    pricesPerSqm.sort((a, b) => a - b);
    prices.sort((a, b) => a - b);

    const median = arr => arr[Math.floor(arr.length / 2)];
    const avg = arr => Math.round(arr.reduce((s, v) => s + v, 0) / arr.length * 10) / 10;

    return {
      plz,
      median_price_sqm: Math.round(median(pricesPerSqm) * 10) / 10,
      avg_price_sqm: avg(pricesPerSqm),
      median_rent: Math.round(median(prices)),
      count: listings.length,
      source: 'homegate',
      scraped_at: new Date().toISOString()
    };
  } catch(e) {
    console.log(`PLZ ${plz} error: ${e.message}`);
    return null;
  }
}

async function upsertSupabase(records) {
  if (!SUPABASE_URL || !SUPABASE_KEY || records.length === 0) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/plz_prices`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(records)
    });
    return res.ok;
  } catch(e) {
    console.log('Supabase error:', e.message);
    return false;
  }
}

export default async function handler(req, res) {
  const isAuthorized =
    req.headers.authorization === `Bearer ${process.env.CRON_SECRET}` ||
    req.headers['x-vercel-cron'] === '1';

  if (!isAuthorized && process.env.NODE_ENV === 'production') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = [];
  const errors = [];
  let batch = [];

  console.log(`Starting Homegate scrape for ${PLZ_LIST.length} PLZ...`);

  for (let i = 0; i < PLZ_LIST.length; i += 3) {
    const chunk = PLZ_LIST.slice(i, i + 3);
    const chunkResults = await Promise.all(chunk.map(scrapeHomegate));

    chunkResults.forEach((r, idx) => {
      if (r) {
        results.push(r);
        batch.push(r);
        console.log(`✓ PLZ ${chunk[idx]}: CHF ${r.median_price_sqm}/m² median (${r.count} listings)`);
      } else {
        errors.push(chunk[idx]);
      }
    });

    // Save to Supabase every 15 records
    if (batch.length >= 15) {
      await upsertSupabase(batch);
      batch = [];
    }

    // Polite delay between batches
    await new Promise(r => setTimeout(r, 800));
  }

  // Save remaining
  if (batch.length > 0) {
    await upsertSupabase(batch);
  }

  console.log(`Done: ${results.length} PLZ scraped, ${errors.length} failed`);

  return res.status(200).json({
    success: true,
    scraped: results.length,
    failed: errors.length,
    sample: results.slice(0, 10)
  });
}
