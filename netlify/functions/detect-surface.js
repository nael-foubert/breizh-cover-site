// netlify/functions/detect-surface.js
const GEMINI_MODEL = 'gemini-3.1-flash-lite'; // On reste bien sur le modèle gratuit
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function parseDataUrl(dataUrl){
  const match = /^data:(.+);base64,(.+)$/.exec(dataUrl || '');
  if(!match) throw new Error('Format de data URL invalide.');
  return { mimeType: match[1], base64: match[2] };
}

function extractBoxesFromText(text){
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  let parsed;
  try{ parsed = JSON.parse(cleaned); } catch(e){ throw new Error('Réponse du modèle non-JSON : ' + cleaned.slice(0,200)); }
  const rawBoxes = Array.isArray(parsed) ? parsed : parsed.boxes;
  if(!Array.isArray(rawBoxes)) throw new Error('Le JSON ne contient pas de tableau "boxes".');
  
  return rawBoxes
    .map(b => {
      let x = Number(b.x);
      let y = Number(b.y);
      let w = Number(b.w);
      let h = Number(b.h);

      // Convertit l'échelle 0-1000 de l'IA en pourcentages 0-1 pour le index.html
      if (x > 1 || y > 1 || w > 1 || h > 1) {
        x = x / 1000;
        y = y / 1000;
        w = w / 1000;
        h = h / 1000;
      }
      return { x, y, w, h };
    })
    .filter(b =>
      [b.x, b.y, b.w, b.h].every(n => Number.isFinite(n) && n >= 0 && n <= 1) &&
      b.w > 0.005 && b.h > 0.005
    );
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if(event.httpMethod === 'OPTIONS'){
    return { statusCode: 204, headers: cors, body: '' };
  }
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Méthode non autorisée.' }) };
  }

  try{
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if(!GEMINI_API_KEY){
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'GEMINI_API_KEY non configurée.' }) };
    }

    const { photo } = JSON.parse(event.body || '{}');
    if(!photo){
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Champ "photo" requis.' }) };
    }
    const clientPhoto = parseDataUrl(photo);

    const prompt = [
      "Tu es un système de vision par ordinateur de haute précision spécialisé dans le mobilier de cuisine.",
      "",
      "CONSIGNE IMPÉRATIVE DE SÉPARATION (RÈGLE D'OR) :",
      "Il est strictement interdit de regrouper une rangée de placards dans un seul rectangle.",
      "Regarde les fines lignes de joint verticales et horizontales. Découpe l'image en autant de rectangles individuels qu'il y a de portes uniques.",
      "",
      "MÉTHODE OBLIGATOIRE (Étape par Étape) :",
      "1. Dans le champ 'analyse_textuelle', liste précisément à voix haute ce que tu t'apprêtes à détourer (Ex: 'Je vois la colonne de gauche divisée en 3 portes, la rangée du haut avec 6 portes verticales distinctes, et la rangée du bas avec 5 portes').",
      "2. Dans le champ 'nombre_total_de_portes', indique le nombre exact trouvé.",
      "3. Dans le tableau 'boxes', génère un rectangle UNIQUE pour CHAQUE porte listée précédemment.",
      "",
      "EXCLUSIONS STRICTES :",
      "- EXCLUS le plan de travail, la crédence, l'évier, le robinet, les murs, le sol.",
      "- EXCLUS la grande niche ouverte centrale en bois brun.",
      "- EXCLUS intégralement le four et le micro-ondes (colonne de droite).",
      "",
      "SYSTÈME DE COORDONNÉES ENTIÈRES (Échelle 0 à 1000) :",
      "Imagine que l'image fait 1000x1000 unités.",
      "- x, y : position du coin haut-gauche (0 à 1000)",
      "- w, h : largeur et hauteur du rectangle (0 à 1000)",
      "Toutes les valeurs DOIVENT être des NOMBRES ENTIERS (INTEGER) compris entre 0 et 1000."
    ].join('\n');

    const body = {
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: clientPhoto.mimeType, data: clientPhoto.base64 } }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1, // Bloque la créativité
        responseMimeType: 'application/json',
        responseSchema: {
          type: "OBJECT",
          properties: {
            analyse_textuelle: { type: "STRING" }, // Force l'IA à réfléchir d'abord
            nombre_total_de_portes: { type: "INTEGER" },
            boxes: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  x: { type: "INTEGER" },
                  y: { type: "INTEGER" },
                  w: { type: "INTEGER" },
                  h: { type: "INTEGER" }
                },
                required: ["x", "y", "w", "h"]
              }
            }
          },
          required: ["analyse_textuelle", "nombre_total_de_portes", "boxes"]
        }
      }
    };

    const geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify(body)
    });

    if(!geminiRes.ok){
      const errText = await geminiRes.text().catch(()=> '');
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Erreur API Gemini.", details: errText }) };
    }

    const data = await geminiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n');
    if(!text){
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Pas de résultat." }) };
    }

    let boxes;
    try{
      boxes = extractBoxesFromText(text);
    } catch(parseErr){
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Réponse illisible.', details: parseErr.message }) };
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ boxes }) };

  } catch(err){
    console.error('Erreur detect-surface:', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Erreur interne.' }) };
  }
};
