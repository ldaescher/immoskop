export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text } = req.body;
  if (!text || text.length < 20) return res.status(400).json({ error: 'Text zu kurz' });

  const prompt = `Du bist ein Schweizer Immobilienexperte. Analysiere den folgenden Inseratstext und extrahiere strukturierte Daten.

WICHTIGE REGEL: Gib NUR Werte zurück die EXPLIZIT im Text stehen. Wenn ein Wert nicht eindeutig im Text steht, gib null zurück. NIEMALS schätzen, ableiten oder erfinden.

INSERATSTEXT:
${text.substring(0, 4000)}

Antworte NUR mit einem JSON-Objekt, ohne Markdown-Backticks, ohne Erklärungen:
{
  "adresse": "vollständige Adresse falls vorhanden, sonst null",
  "preis": Zahl in CHF (nur Zahl, kein Text), oder null,
  "preistyp": "miete" oder "kauf",
  "flaeche": Zahl in m² oder null,
  "zimmer": Zahl oder null — NUR wenn die Zimmeranzahl explizit im Text steht (z.B. "3.5 Zimmer", "4-Zimmer"). Nie aus Raumbezeichnungen ableiten.,
  "etage": Zahl oder null (0 = Erdgeschoss) — NUR wenn explizit erwähnt.,
  "baujahr_kategorie": "2020" oder "2010" oder "2000" oder "1990" oder "1980" oder "alt" oder null — NUR wenn Baujahr oder Renovation explizit erwähnt. Nie schätzen.,
  "aussenraum": "none" oder "balkon" oder "terrasse" oder "garten" oder null,
  "zustand": "neuwertig" oder "gut" oder "mittel" oder "renovationsbed" oder null,
  "befristet": true oder false,
  "befristet_details": "Details zur Befristung falls vorhanden, sonst null",
  "nebenkosten": Zahl in CHF oder null,
  "verfuegbar_ab": "Datum oder Text falls vorhanden, sonst null",
  "besonderheiten": ["Liste", "von", "Besonderheiten", "max 5"],
  "marketing_flags": ["Begriffe die kritisch zu hinterfragen sind, z.B. 'sonnig' 'ruhig' 'zentral'"],
  "zusammenfassung": "2-3 Sätze Zusammenfassung des Inserats auf Deutsch"
}`;

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
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) return res.status(500).json({ error: claudeData.error?.message || 'Claude Fehler' });

    const rawText = claudeData.content?.[0]?.text || '{}';
    // Strip markdown if present
    const clean = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    console.log('PARSE ok:', JSON.stringify(parsed).substring(0, 200));
    return res.status(200).json({ parsed, originalText: text.substring(0, 4000) });

  } catch(e) {
    console.log('PARSE error:', e.message);
    return res.status(500).json({ error: 'Parse-Fehler: ' + e.message });
  }
}
