# X Bookmarks – Recherche intelligente

Extension Chrome / Comet (Chromium, Manifest V3) qui ajoute une **recherche sémantique** à tes bookmarks X.
Tout est **local** : pas de serveur, pas de base de données externe, pas de clé API, coût = 0 €.

## Comment ça marche

| Étape | Détail |
|---|---|
| **Capture** | `inject.js` (monde MAIN de x.com) intercepte les réponses GraphQL `Bookmarks` que X charge déjà quand tu scrolles. |
| **Synchro complète** | Le bouton « ⟳ Tout synchroniser » rejoue la dernière requête de X avec le curseur suivant (1,5–3,5 s entre deux pages). Plus besoin de scroller des heures. |
| **Stockage** | IndexedDB (tweets texte + métadonnées + URLs d'images ; jamais de vidéo). Vecteur de 256 dims ≈ 1 Ko / bookmark. |
| **Embeddings** | [EmbeddingGemma 300M](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX) quantifié q8 (~300 Mo, téléchargé une fois) via transformers.js, WebGPU sinon WASM, dans un document offscreen. |
| **Recherche** | BM25 (mots-clés, sans accents, préfixes) + cosinus, fusionnés par RRF. Opérateurs : `from:@x has:link has:media since:2026-01-01 until:… lang:fr`. Bouton « ≈ Similaires ». |
| **UI** | Overlay directement sur `x.com/i/bookmarks` (bouton ou **Alt+K**) + page plein écran (clic sur l'icône ou **Alt+Maj+B**). |

## Installer

```bash
npm install --ignore-scripts
npm run build          # produit dist/
```

`chrome://extensions` (ou `comet://extensions`) → mode développeur → « Charger l'extension non empaquetée » → dossier `dist/`.
Puis ouvre `x.com/i/bookmarks` et clique « ⟳ Tout synchroniser ».

## Tests

```bash
npm test                                   # parser + moteur de recherche
npm run build && xvfb-run -a node test/e2e.mjs   # Chromium réel, x.com simulé
```

## Limites connues

- Le format GraphQL de X est non documenté : si la capture casse, c'est `src/lib/parse.js` à ajuster.
- La synchro automatique reste en zone grise des CGU de X : rythme volontairement lent, arrêt sur HTTP 429.
- Le chargement du modèle d'embedding n'a pas pu être testé dans l'environnement de dev (accès à Hugging Face bloqué) : voir `src/offscreen.js` (`MODEL_ID`, `DTYPE`).
- Pas de synchro multi-appareils (l'index vit dans le navigateur).
