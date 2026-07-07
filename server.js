// server.js
// Backend Express minimal. Utilise Gemini 2.5 Flash (modèle texte+vision,
// GRATUIT avec quotas) pour repérer la zone du meuble sur la photo du
// client. Contrairement à gemini-2.5-flash-image (génération d'image,
// facturation obligatoire, ~0.04$/image), ce modèle ne fait "que" de
// l'analyse d'image et reste utilisable gratuitement pour du petit volume.
//
// Le rendu final (application du revêtement) se fait ensuite côté client
// en CSS (texture + mix-blend-mode + mask-image), à partir des rectangles
// renvoyés ici — pas de génération d'image, donc pas de coût par appel.
//
// Installation :
//   npm init -y
//   npm install express cors
//   GEMINI_API_KEY=xxxxx node server.js
//
// Le front (index.html) appelle POST /api/detect-surface avec :
//   { photo: "data:image/jpeg;base64,..." }
// et reçoit : { boxes: [ { x, y, w, h }, ... ] }  (valeurs en fraction 0-1 de l'image)

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash'; // texte + vision, niveau gratuit disponible
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function parseDataUrl(dataUrl){
  const match = /^data:(.+);base64,(.+)$/.exec(dataUrl || '');
  if(!match) throw new Error('Format de data URL invalide.');
  return { mimeType: match[1], base64: match[2] };
}

// Le modèle texte renvoie du texte, potentiellement entouré de ```json.
// On nettoie et on parse, en validant strictement la forme attendue.
function extractBoxesFromText(text){
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  let parsed;
  try{ parsed = JSON.parse(cleaned); } catch(e){ throw new Error('Réponse du modèle non-JSON : ' + cleaned.slice(0,200)); }
  const rawBoxes = Array.isArray(parsed) ? parsed : parsed.boxes;
  if(!Array.isArray(rawBoxes)) throw new Error('Le JSON ne contient pas de tableau "boxes".');
  return rawBoxes
    .map(b => ({
      x: Number(b.x), y: Number(b.y), w: Number(b.w), h: Number(b.h)
    }))
    .filter(b =>
      [b.x,b.y,b.w,b.h].every(n => Number.isFinite(n) && n >= 0 && n <= 1) &&
      b.w > 0.01 && b.h > 0.01
    );
}

app.post('/api/detect-surface', async (req, res) => {
  try{
    if(!GEMINI_API_KEY){
      return res.status(500).json({ error: 'GEMINI_API_KEY non configurée côté serveur.' });
    }

    const { photo } = req.body || {};
    if(!photo){
      return res.status(400).json({ error: 'Requête invalide : champ "photo" requis.' });
    }
    const clientPhoto = parseDataUrl(photo);

    const prompt = [
      "Regarde cette photo d'un meuble (cuisine, façade, plan de travail...).",
      "Repère uniquement les grandes surfaces planes du MEUBLE lui-même",
      "(portes de placard, façades, plan de travail) — PAS les murs, le sol,",
      "le plafond, les objets posés dessus, ni l'arrière-plan.",
      "",
      "Réponds UNIQUEMENT avec un objet JSON de cette forme exacte, sans texte",
      "autour, sans balises markdown :",
      '{"boxes":[{"x":0.12,"y":0.30,"w":0.40,"h":0.35}, ...]}',
      "",
      "Où x,y sont le coin haut-gauche de chaque rectangle et w,h sa largeur",
      "et hauteur, tous exprimés en fraction de la largeur/hauteur totale de",
      "l'image (valeurs entre 0 et 1). Un rectangle par grande zone de meuble",
      "identifiée. Si aucune surface de meuble n'est identifiable, réponds",
      '{"boxes":[]}'
    ].join('\n');

    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: clientPhoto.mimeType, data: clientPhoto.base64 } }
        ]
      }],
      generationConfig: {
        responseMimeType: 'application/json'
      }
    };

    const geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify(body)
    });

    if(!geminiRes.ok){
      const errText = await geminiRes.text().catch(()=> '');
      console.error('Erreur API Gemini:', geminiRes.status, errText);
      return res.status(502).json({ error: "L'API Gemini a renvoyé une erreur.", details: errText });
    }

    const data = await geminiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n');
    if(!text){
      console.error('Réponse Gemini sans texte:', JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: "Le modèle n'a pas renvoyé de résultat exploitable." });
    }

    let boxes;
    try{
      boxes = extractBoxesFromText(text);
    } catch(parseErr){
      console.error('Échec parsing réponse Gemini:', parseErr.message);
      return res.status(502).json({ error: "Réponse du modèle illisible.", details: parseErr.message });
    }

    res.json({ boxes });

  } catch(err){
    console.error('Erreur /api/detect-surface:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// Sert le site (index.html, materials/, etc.) depuis le même dossier.
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
