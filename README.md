# X Bookmarks – Recherche intelligente

Extension Chrome / Comet (Chromium, Manifest V3) qui ajoute une **recherche sémantique** à tes bookmarks X.
Par défaut tout est **local** : pas de serveur, pas de base de données externe, pas de clé API, coût = 0 €.
Les fonctions d'IA, l'indexation des liens et la recherche d'images sont **facultatives** et désactivées tant que tu ne les actives pas.

## Ce que ça fait

| Domaine | Détail |
|---|---|
| **Capture** | `inject.js` (monde MAIN de x.com) intercepte les réponses GraphQL `Bookmarks` (fetch **et** XMLHttpRequest). Détection indépendante de l'URL (page « Historique » de X). |
| **Synchro** | « ⟳ Tout synchroniser » remonte tout l'historique (pagination par curseur, rythme humain). « ↻ Nouveautés » s'arrête dès que les pages ne contiennent plus rien de nouveau. Synchro automatique toutes les 30 min si un onglet X capturant est ouvert. |
| **Bookmarks supprimés** | Après une synchro complète, détecte ceux qui n'existent plus sur X et propose de les retirer (jamais sans confirmation). |
| **Alerte de format** | Si X change son format et que des tweets deviennent illisibles, un bandeau le signale. |
| **Recherche** | BM25 (mots-clés, sans accents, préfixes) + embeddings [EmbeddingGemma 300M](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX) (WebGPU/WASM), fusionnés par RRF. Badges « sens #3 · mots #12 » pour comprendre un classement. |
| **Langage naturel** | « le tweet le plus vieux d'OpenAI » → tri par date + filtre auteur (puce « ✕ retirer »). Opérateurs : `from:@x has:link has:media since:… until:… lang:fr`. |
| **Filtres** | Période, liens / médias / vidéos, tri (pertinence, récents, anciens, plus likés). |
| **Confort** | Navigation clavier (`↓`, `j/k`, `Entrée`, `s`, `/`), historique, ★ recherches enregistrées, 🎲 au hasard, 📅 il y a un an, rendu façon X (médias, vidéos, citations, compteurs). |
| **Thèmes** | ☰ regroupement automatique (k-means sur les embeddings) avec libellés TF-IDF ; nommage par l'IA en option. |
| **Sauvegarde** | Export JSON (chiffrable AES-GCM par mot de passe), import, et **dossier de synchro** (iCloud / Dropbox / Drive) pour retrouver ses bookmarks sur un autre appareil. |
| **Banc d'essai** | Mesure le rappel@10 et le MRR de plusieurs réglages sur tes propres requêtes (Réglages ▸ Banc d'essai). |

## Fonctions facultatives (Réglages ⚙)

- **IA** (API compatible OpenAI : OpenRouter, **Ollama en local**, OpenAI, Cloudflare Workers AI…) : *Demander* (réponse sourcée avec citations cliquables), *Résumé* de la semaine, compréhension des requêtes, reclassement des 20 meilleurs résultats. Ollama : `OLLAMA_ORIGINS="chrome-extension://*" ollama serve`. La clé d'API reste en clair dans `chrome.storage.local` de cet appareil.
- **Indexer les liens** : lit titre + description des pages liées (sans cookies, jamais le réseau local) et les ajoute à l'index. Demande l'accès aux sites.
- **Recherche d'images** (expérimental) : CLIP (~150 Mo) sur la première image de chaque tweet ; requêtes en anglais.

## Installer

```bash
npm install --ignore-scripts
npm run build          # produit dist/
```

`chrome://extensions` (ou `comet://extensions`) → mode développeur → « Charger l'extension non empaquetée » → dossier `dist/`.
Puis ouvre `x.com/i/bookmarks` et clique « ⟳ Tout synchroniser ».
Mise à jour : `git pull && npm run build` **à la racine du projet** (pas dans `dist/`), puis recharge l'extension.

## Tests

```bash
npm test                                         # parser, recherche, index, clustering, chiffrement, liens, IA…
npm run build && xvfb-run -a node test/e2e.mjs   # Chromium réel, x.com et fournisseur d'IA simulés
```

## Limites connues

- Le format GraphQL de X est non documenté : si la capture casse, c'est `src/lib/parse.js` à ajuster (un bandeau te prévient).
- La synchro automatique reste en zone grise des CGU de X : rythme volontairement lent, arrêt sur HTTP 429.
- **Non testé hors simulation** : le téléchargement/l'inférence des modèles (Hugging Face est bloqué dans l'environnement de développement), la recherche d'images CLIP, la lecture de vraies pages liées, l'accès au dossier de synchro, et toute API d'IA réelle.
- Dossiers de bookmarks de X (formats GraphQL non vérifiés) et adaptateur spécifique « Jev » (contrat d'API non vérifié) : non implémentés ; une API compatible OpenAI suffit pour les usages ci-dessus.
- L'IA locale dans le navigateur (WebGPU) n'est pas implémentée ; passer par Ollama.
