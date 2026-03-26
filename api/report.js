export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { address, rooms, area, price, type, year, floor, noise, oev, solar, crime, amenities } = req.body;

  const isKauf = type === 'kauf';
  const pricePerQm = (price / area).toFixed(1);

  const prompt = `Du bist ein unabhängiger Schweizer Immobilienexperte. Analysiere dieses Inserat objektiv und erstelle einen vollständigen Bericht auf Deutsch.

INSERAT-DATEN:
- Adresse: ${address}
- Typ: ${isKauf ? 'Kaufobjekt' : 'Mietwohnung'}
- Zimmer: ${rooms}
- Fläche: ${area} m²
- ${isKauf ? 'Kaufpreis' : 'Monatlicher Mietzins'}: CHF ${parseInt(price).toLocaleString('de-CH')}${isKauf ? '' : '/Mt.'}
- Preis pro m²: CHF ${pricePerQm}${isKauf ? '' : '/Mt.'}
- Baujahr: ${year}
- Etage: ${floor}

LAGE-DATEN (aus Schweizer Behörden-APIs):
- Lärmpegel: ${noise ? `${noise.day} dB Tagesmittel (BAFU)` : 'Keine Daten verfügbar'}
- Nächste ÖV-Haltestelle: ${oev ? `${oev.dist}m (${oev.name})` : 'Keine Daten'}
- Besonnung Fassade: ${solar ? `${Math.round(solar.kwh)} kWh/Jahr (swisstopo)` : 'Keine Daten'}
- Sicherheit: ${crime ? `${crime.hzahl} Straftaten/1000 Einw. in ${crime.label} (PKS)` : 'Keine Daten'}

UMGEBUNG (OpenStreetMap, 800m Radius):
${amenities ? Object.entries(amenities).map(([k, v]) => `- ${k}: ${v.items.map(i => `${i.name} (${i.dist}m)`).join(', ') || 'Keine'}`).join('\n') : 'Keine Daten verfügbar'}

Erstelle einen strukturierten Bericht mit folgenden Abschnitten:

## Preiseinschätzung
Bewerte ob der Preis fair, überteuert oder günstig ist. Nenne einen konkreten Richtwert in CHF basierend auf Lage, Grösse und aktuellen Schweizer Marktdaten. Erkläre die Abweichung.

## Was für dieses Angebot spricht
3-5 konkrete Vorteile basierend auf den Daten.

## Was kritisch zu prüfen ist
3-5 konkrete Punkte die bei der Besichtigung oder im Mietvertrag geprüft werden müssen. Sei ehrlich auch wenn etwas negativ ist.

## Lagequalität
Bewerte Lärm, Besonnung, ÖV-Anbindung und Umgebung konkret. Verweise auf die Messwerte.

## Steuerlicher Hinweis
Falls die Gemeinde einen bemerkenswert tiefen oder hohen Steuerfuss hat, erwähne das mit konkreten Zahlen.

## Checkliste für die Besichtigung
8-10 spezifische Punkte zugeschnitten auf dieses Inserat – nicht generisch.

## Fazit
2-3 Sätze: Ist das ein gutes Angebot? Handlungsempfehlung.

Schreib präzise, ehrlich und ohne Marketing-Sprache. Verwende CHF-Beträge und konkrete Zahlen wo immer möglich.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || 'API Fehler' });
    }

    const text = data.content?.[0]?.text || '';
    return res.status(200).json({ report: text });

  } catch (err) {
    return res.status(500).json({ error: 'Server-Fehler: ' + err.message });
  }
}
