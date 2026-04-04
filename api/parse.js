export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text } = req.body;
  if (!text || text.length < 20) return res.status(400).json({ error: 'Text zu kurz' });

  const prompt = `Du bist ein Datenextraktions-Tool. Deine einzige Aufgabe ist es, explizit genannte Fakten aus einem Inseratstext zu extrahieren.

ABSOLUTE REGEL: Gib AUSSCHLIESSLICH Werte zurück, die WÖRTLICH im Text stehen. Bei jedem Feld: Wenn du nicht sicher bist, gib null zurück.

PREIS — KRITISCH:
- NUR wenn eine konkrete Zahl als Preis, Miete, Kaufpreis, Mietzins vorkommt → Zahl zurückgeben
- Bei "Preis auf Anfrage", "POA", "prix sur demande", "Preis nach Vereinbarung", "auf Anfrage" → null zurückgeben
- Im Zweifel: null

ZIMMER — KRITISCH:
- NUR wenn eine Zahl mit dem Wort "Zimmer", "Zi.", "Zi", "pièces", "rooms" vorkommt
- Beispiele die ZÄHLEN: "3.5 Zimmer", "4-Zimmer-Wohnung", "4 Zi.", "3½ Zimmer", "2.5 rooms", "2.5-room apartment", "Rooms: 2.5", "No. of rooms: 2.5"
- Beispiele die NICHT zählen: "Wohnzimmer", "Schlafzimmer", "Küche", "living room", "bedroom" → diese sind Raumnamen, KEINE Zimmeranzahl
- Im Zweifel: null

AUSSENRAUM — KRITISCH:
- NUR wenn Balkon, Loggia, Terrasse, Sitzplatz oder Garten explizit erwähnt wird
- Merkmale wie "rollstuhlgängig", "Lift", "modern" → kein Aussenraum
- Kein Aussenraum erwähnt → null (nicht "none"!)
- Im Zweifel: null

PARKPLATZ — KRITISCH:
- 0: explizit kein Parkplatz / kein PP inbegriffen
- 1: ein Aussenparkplatz / Aussenabstellplatz / PP im Freien
- 2: ein Tiefgaragenplatz / Einstellhalle / Garagenplatz
- 3: zwei oder mehr Tiefgaragenplätze
- null: nicht erwähnt (am häufigsten!)
- Im Zweifel: null

PREIS-ADJUSTMENT — KRITISCH:
- NUR für klare, wertrelevante Merkmale die WÖRTLICH im Text stehen
- Positive Faktoren (+): Seesicht, Bergsicht, Alpenblick (+3-8%), Minergie/LEED (+3-5%), Dachterrasse (+3-5%), Concierge/Portier (+2-3%), Lift in kleinem Haus (+1-2%), neuwertige Küche/Bad (+2-4%)
- Negative Faktoren (-): Hanglage mit schwierigem Zugang (-2-5%), sehr dunkle Lage/Nordhang (-3-5%), Durchgangszimmer (-2-3%)
- Kombinationen: mehrere Faktoren addieren, Maximum ±15%
- Marketing-Begriffe wie "sonnig", "ruhig", "zentral" → KEIN Adjustment (nicht verifizierbar)
- Im Zweifel: null (kein Adjustment)

BAUJAHR — KRITISCH:
- NUR wenn eine Jahreszahl explizit als Baujahr, Erstellungsjahr oder Renovationsjahr vorkommt
- Beispiele die ZÄHLEN: "Baujahr 1998", "erbaut 2005", "renoviert 2018", "Neubau 2023", "Year built: 2024", "Built in 2020", "Construction year: 2019"
- Beispiele die NICHT zählen: Beschreibungen wie "modern", "zeitgemäss", "gepflegt" → null
- Im Zweifel: null

INSERATSTEXT:
${text.substring(0, 4000)}

Antworte NUR mit einem JSON-Objekt, ohne Markdown-Backticks, ohne Erklärungen:
{
  "adresse": "Adresse falls vorhanden. Auch nur PLZ + Ort (z.B. '8001 Zürich') oder nur Ortsname (z.B. 'Küsnacht') zurückgeben wenn keine Strasse bekannt. Nur null wenn überhaupt kein Ortshinweis vorhanden.",
  "preis": Zahl in CHF (nur Zahl, kein Text), oder null,
  "preistyp": "miete" oder "kauf",
  "flaeche": Zahl in m² oder null,
  "zimmer": Zahl oder null,
  "etage": Zahl oder null (0 = Erdgeschoss),
  "baujahr_kategorie": "2020" oder "2010" oder "2000" oder "1990" oder "1980" oder "alt" oder null,
  "aussenraum": "none" wenn explizit kein Aussenraum erwähnt, "balkon" NUR wenn Balkon/Loggia wörtlich steht, "terrasse" NUR wenn Terrasse wörtlich steht, "garten" NUR wenn Garten/Sitzplatz wörtlich steht, null wenn unklar oder nicht erwähnt,
  "zustand": "neuwertig" oder "gut" oder "mittel" oder "renovationsbed" oder null,
  "befristet": true oder false,
  "befristet_details": "Details zur Befristung falls vorhanden, sonst null",
  "nebenkosten": Zahl in CHF oder null,
  "verfuegbar_ab": "Datum oder Text falls vorhanden, sonst null",
  "besonderheiten": ["Liste", "von", "Besonderheiten", "max 5"],
  "marketing_flags": ["Begriffe die kritisch zu hinterfragen sind, z.B. 'sonnig' 'ruhig' 'zentral'"],
  "parkplatz": 0 wenn kein Parkplatz, 1 wenn ein Aussenparkplatz, 2 wenn ein Tiefgaragenplatz, 3 wenn zwei oder mehr Tiefgaragenplätze, oder null wenn nicht erwähnt,
  "preis_adjustment": Zahl zwischen -0.15 und +0.15 (Preiskorrektur als Dezimalanteil, z.B. +0.05 für 5% Aufschlag wegen Seesicht), oder null wenn keine klaren Qualitätsmerkmale vorhanden,
  "preis_adjustment_grund": "Kurze Begründung des Adjustments, z.B. 'Seesicht + Minergie-Standard', oder null",
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
