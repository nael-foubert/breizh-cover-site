// netlify/functions/detect-surface.js
// Version Netlify Functions (serverless) de l'endpoint /api/detect-surface.
// Remplace server.js pour un déploiement sur Netlify : ce fichier est
// automatiquement exposé par Netlify à l'URL /.netlify/functions/detect-surface
// (voir netlify.toml pour la redirection vers /api/detect-surface).
//
// Configuration nécessaire sur Netlify :
//   Site settings → Environment variables → ajouter GEMINI_API_KEY
// (jamais dans le code, jamais commité sur GitHub).

const GEMINI_MODEL = 'gemini-3.1-flash-lite'; // texte + vision, niveau gratuit
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
    .map(b => ({ x: Number(b.x), y: Number(b.y), w: Number(b.w), h: Number(b.h) }))
    .filter(b =>
      [b.x,b.y,b.w,b.h].every(n => Number.isFinite(n) && n >= 0 && n <= 1) &&
      b.w > 0.01 && b.h > 0.01
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
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'GEMINI_API_KEY non configurée (Site settings → Environment variables sur Netlify).' }) };
    }

    const { photo } = JSON.parse(event.body || '{}');
    if(!photo){
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Requête invalide : champ "photo" requis.' }) };
    }
    const clientPhoto = parseDataUrl(photo);

    const prompt = [
      const prompt = `
Tu es un expert en détection d'objets. 
Analyse l'image et trouve toutes les surfaces planes des meubles (placards, tiroirs). Exclut absolument les apparareils électroménagers, les murs, les sols, les objets
Renvoie EXACTEMENT un objet JSON comme ceci, sans aucune explication avant ou après :
{
  "boxes": [
    {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}
  ]
}
Si tu ne trouves rien, renvoie {"boxes": []}.
`;
    ].join('\n');

    const body = {
  contents: [
    {
      parts: [
        { 
          text: prompt // Ton texte d'instruction pour l'IA (ex: "Détecte les meubles et renvoie les coordonnées")
        },
        { 
          inline_data: { 
            mime_type: clientPhoto.mimeType, // Le type MIME de l'image (ex: "image/jpeg")
            data: clientPhoto.base64       // L'image convertie en Base64
          } 
        }
      ]
    }
  ],
  generationConfig: { 
    // On force l'API à répondre en JSON
    responseMimeType: 'application/json',
    
    // LA MODIFICATION : On impose la structure exacte du JSON attendu
    responseSchema: {
      type: "OBJECT",
      properties: {
        boxes: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              x: { type: "NUMBER" },
              y: { type: "NUMBER" },
              w: { type: "NUMBER" }, // Largeur (width)
              h: { type: "NUMBER" }  // Hauteur (height)
            },
            // On rend ces champs obligatoires pour être sûr que l'IA ne les oublie pas
            required: ["x", "y", "w", "h"]
          }
        }
      },
      required: ["boxes"]
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
      console.error('Erreur API Gemini:', geminiRes.status, errText);
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "L'API Gemini a renvoyé une erreur.", details: errText }) };
    }

    const data = await geminiRes.json();
console.log("Réponse brute de Gemini reçue !");
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n');
    if(!text){
      console.error('Réponse Gemini sans texte:', JSON.stringify(data).slice(0, 500));
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Le modèle n'a pas renvoyé de résultat exploitable." }) };
    }

    let boxes;
    try{
      boxes = extractBoxesFromText(text);
    } catch(parseErr){
      console.error('Échec parsing réponse Gemini:', parseErr.message);
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Réponse du modèle illisible.', details: parseErr.message }) };
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ boxes }) };

  } catch(err){
    console.error('Erreur detect-surface:', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Erreur interne du serveur.' }) };
  }
};
