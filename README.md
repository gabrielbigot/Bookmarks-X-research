# Bookmarks & Playlists – Recherche intelligente

Extension Chrome / Comet (Chromium, Manifest V3) qui ajoute une **recherche sémantique** à tes bookmarks X.
Par défaut tout est **local** : pas de serveur, pas de base de données externe, pas de clé API, coût = 0 €.
Les fonctions d'IA, l'indexation des liens et la recherche d'images sont **facultatives** et désactivées tant que tu ne les actives pas.

## YouTube : playlists, historique et transcriptions (v0.5)

Les playlists YouTube (dont **« À regarder plus tard »** et **« J'aime »**) sont une deuxième source, cherchée **avec** tes bookmarks X (« cerveau » trouve tweets et vidéos).

- **Synchroniser** : panneau › « ▶ Playlists YouTube » (ouvre un onglet YouTube en arrière-plan, le referme à la fin ; il faut être connecté à YouTube). Ou, sur YouTube, la pastille « ▶ Mes playlists » / « Cette playlist ». Une playlist ouverte à la main est aussi capturée au passage.
- **Chercher** : cartes vidéo (miniature, durée, chaîne, vues, playlists). Filtre « Source » (Tout / X / YouTube), opérateurs `source:youtube`, `playlist:"à regarder plus tard"`, `from:@chaine`.
- **Retraits** : après une synchro complète d'une playlist, une vidéo qui n'y est plus perd cette appartenance ; si elle n'est plus dans aucune playlist, elle t'est proposée à la suppression (jamais sans confirmation).
- **Indexation** : manuelle comme pour X (« ▶ Indexer »). Titre + chaîne + playlists sont indexés.
- **Limites** : tout est testé contre un faux YouTube (format `playlistVideoRenderer` **et** `lockupViewModel`) ; le format réel change souvent, un bandeau t'avertit si des vidéos deviennent illisibles. La synchro rejoue l'API interne avec ta session (`youtubei/v1/browse`, en-tête signé `SAPISIDHASH`) ; en cas de refus (HTTP 401/403), ouvre la playlist et défile : la capture passive prend le relais. Pas encore : import Google Takeout.

**Historique de visionnage** (`youtube.com/feed/history`)

- **Synchroniser** : panneau › « ▶ Historique YouTube » (onglet en arrière-plan, refermé ensuite) ou pastille « Historique » sur YouTube. Profondeur réglable dans ⚙ (30 j / 90 j / 1 an / tout, 90 j par défaut). Les synchros suivantes sont **incrémentales** : on s'arrête dès que deux pages de suite ne contiennent plus rien de nouveau.
- **Chercher** : l'historique est indexé comme les playlists (titre, chaîne, début de la description). Cartes : « Vu le … · ×N · 60 % » et barre de progression sur la miniature. Opérateurs : `viewed:yes` / `viewed:no` (ou `vu:oui|non`), `watched:aujourd'hui`, `watched:2026-10-12`, `watched:2026-10-01..2026-10-31`. Exemple utile : `viewed:no playlist:"à regarder plus tard"` = ce que tu n'as pas encore regardé.
- **Vie privée** : tout reste local. L'historique n'est **jamais envoyé** à une IA externe (Demander, Résumé, reclassement, nommage des thèmes) tant que tu ne coches pas « Autoriser l'envoi de mon historique… » dans ⚙. L'export de sauvegarde le contient : chiffre-le.
- **Statistiques YouTube** : page 📊 › onglet « YouTube ». Visionnages par jour/semaine/mois, calendrier, jours de la semaine, durée des vidéos, chaînes les plus regardées (avec temps estimé), temps regardé estimé (durée × progression ; sans progression = vue en entier), vidéos commencées sans finir, playlists, « à regarder » (nombre et durée jamais vues), « À regarder plus tard » à ressortir, plus revues, mots des titres. La période filtre l'activité ; la bibliothèque n'en dépend pas. Clic sur une barre ou un jour = recherche correspondante.
- **Transcriptions** : panneau › « ▶ Transcriptions » (onglet YouTube en arrière-plan ; plusieurs vidéos en parallèle selon la vitesse choisie dans ⚙ : prudente 1, normale 3, rapide 6 ; frein automatique et pause au moindre refus ; le jeton de transcription appris sur une vidéo est réutilisé pour les suivantes, soit 1 requête par vidéo au lieu de 2 ; toutes les vidéos concernées en un passage par défaut (réglable : 400 ou 2 000), reprise possible après un arrêt ; arrêt automatique après 3 refus consécutifs). Réglage ⚙ : vidéos de tes playlists (défaut) ou aussi l'historique. Le texte parlé est cherché **par mots** (les 20 000 premiers caractères (≈ 20 min de parole, sans mots courants) sont indexés par défaut ; réglable dans ⚙ (1 heure, ou tout au prix de plus de mémoire)) et **par sens** (jusqu'à 12 passages par vidéo (réglable : 24 ou 48), répartis sur toute la durée, vectorisés au prochain « ▶ Indexer » ; la vidéo vaut son meilleur passage). Un résultat affiche l'extrait trouvé avec son horodatage : le lien ouvre la vidéo à la seconde près. Opérateur `has:transcript`. Une vidéo sans transcription n'est redemandée qu'après 30 jours. Les transcriptions sont incluses dans l'export. Source : panneau « Transcription » de YouTube (`next` → `get_transcript`), repli sur les sous-titres du lecteur (français puis anglais, manuels avant automatiques). Elles ne sont jamais envoyées à une IA externe.
- **Limites** : les jours sont lus dans les en-têtes de YouTube (« Aujourd'hui », « Hier », « lundi », « 12 octobre » — français et anglais) ; une langue non reconnue donne des visionnages sans date. Une vidéo vue plusieurs jours garde la liste de ses jours ; un visionnage supprimé côté YouTube n'est pas retiré ici. Testé contre un faux YouTube seulement.

## Mise à jour en un clic et automatique

- **« ⟳ Tout mettre à jour »** (panneau) : récupère ce qui est nouveau — bookmarks X (mode « nouveautés ») et playlists YouTube (« À regarder plus tard » et « J'aime » en s'arrêtant dès qu'une page n'apporte rien de nouveau ; les autres playlists seulement si leur nombre de vidéos a changé) — puis lance l'indexation. L'historique et les transcriptions n'en font **pas** partie par défaut (gros retards à rattraper à part, avec leurs propres boutons) : ⚙ permet de les inclure une fois rattrapés.
- **Automatique toutes les 30 min** (⚙ › Mise à jour automatique) : X à chaque cycle, YouTube toutes les 3 h. Elle peut ouvrir un onglet X / YouTube en arrière-plan (refermé ensuite ; décochable).
- **Indexation automatique par petites tranches** (⚙) : 600 textes au plus toutes les 4 min, jamais au lancement du navigateur, calcul CPU. C'est le réglage par défaut des installations existantes depuis la v0.7 (avant : manuel) ; décocher pour revenir au manuel. Le gros retard se résorbe ainsi tout seul, sans bloquer la machine : en tranche automatique le calcul tourne à ~45 % de la durée (pauses proportionnelles) avec 2 threads au plus, et le panneau ne recharge ni ne redessine rien pendant ce temps (au plus un rechargement des vecteurs toutes les 3 min). Le bouton « Indexer » reste à pleine vitesse.

## Mes stats et détecteurs (page 📊 › « Mes stats »)

- **Stats personnalisées** : « + Ajouter une stat » compte ce que tu veux dans le temps, avec le **même filtre de période** que le reste (1 j, 7 j, 30 j, 90 j, 1 an, tout). Forme : un **nombre** (avec la variation par rapport à la période précédente), une **courbe** (par jour, semaine ou mois) ou un **classement** (auteurs/chaînes, sites cités, langues). Critère : une **requête** (même syntaxe que la recherche : mots tous requis, `from:@x`, `has:link`, `lang:fr`, `playlist:"…"`, `viewed:no`…), une **source** (X, YouTube ou tout) et/ou un **détecteur**. Aperçu en direct pendant la saisie ; un clic sur un nombre, une barre ou un jour ouvre la recherche correspondante. Modèles prêts à l'emploi, duplication, réordonnancement ; incluses dans l'export de sauvegarde.
- **Détecteurs** (sens) : tu décris un type de contenu (« annonce d'un lancement »…) avec une phrase et quelques exemples, dans n'importe quelle langue. Chaque élément reçoit un score = sa meilleure ressemblance avec les exemples (ou l'un des passages de sa transcription) ; au-dessus du **seuil** il est « retenu ». L'éditeur montre les moins sûrs des retenus et les plus proches des écartés, avec **✓ / ✗** pour corriger à la main (conservé). Calcul 100 % local, gratuit. Un détecteur est aussi un opérateur de recherche : `is:lancements`. Modèle « Lancements » fourni.
- **Dates utilisées pour la période** : date d'enregistrement (X, si fiable, sinon publication), jours de visionnage (vidéos de l'historique), sinon jour d'ajout.
- **Limites** : un détecteur n'est jamais exact à 100 % (règle le seuil avec l'aperçu) ; il demande que l'indexation soit à jour et que le modèle de recherche soit disponible la première fois (analyse des exemples). La confirmation par un modèle de décision (Jev) pour affiner les cas ambigus n'est pas encore faite.

## Ce que ça fait

| Domaine | Détail |
|---|---|
| **Capture** | `inject.js` (monde MAIN de x.com) intercepte les réponses GraphQL `Bookmarks` (fetch **et** XMLHttpRequest). Détection indépendante de l'URL (page « Historique » de X). |
| **Synchro** | « ⟳ Tout synchroniser » remonte tout l'historique (pagination par curseur, rythme humain). « ↻ Nouveautés » s'arrête dès que les pages ne contiennent plus rien de nouveau. Synchro automatique toutes les 30 min si un onglet X capturant est ouvert. |
| **Bookmarks supprimés** | Après une synchro complète, détecte ceux qui n'existent plus sur X et propose de les retirer (jamais sans confirmation). |
| **Alerte de format** | Si X change son format et que des tweets deviennent illisibles, un bandeau le signale. |
| **Recherche** | BM25 (mots-clés, sans accents, préfixes) + embeddings [EmbeddingGemma 300M](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX) (WebGPU/WASM), fusionnés par RRF. Badges « sens #3 · mots #12 » pour comprendre un classement. |
| **Équilibre** | Sélecteur : ⚖ Sens + mots (défaut) · 🌐 Sens d'abord (retrouve « brain » en cherchant « cerveau », multilingue) · 🔤 Mots exacts d'abord. Mesurable dans le banc d'essai. |
| **Langage naturel** | « le tweet le plus vieux d'OpenAI » → tri par date + filtre auteur (puce « ✕ retirer »). Opérateurs : `from:@x has:link has:media since:… until:… lang:fr saved:2026-10-12` (ou `saved:2026-10-01..2026-10-31`, date de mise en bookmark). |
| **Filtres** | Période, liens / médias / vidéos, tri (pertinence, récents, anciens, plus likés). |
| **Statistiques** | Page 📊 : bookmarks par jour/semaine/mois (+ moyenne 7 j), calendrier de l'année, croissance de la collection, jours et heures d'enregistrement, âge du tweet à l'enregistrement, types de contenu, langues, auteurs, sites, hashtags, mentions, mots, tweets les plus likés, liens en double. Un filtre de période, un jumeau « tableau » par graphique, des clics qui ouvrent la recherche correspondante. La date d'enregistrement est lue dans l'ordre de la liste de X (`sortIndex`) **et vérifiée** (cohérence avec la date de publication) ; sinon la page se rabat sur la date de publication et le dit. |
| **Thème** | Auto / sombre / clair (bouton ◐ ☾ ☀), mémorisé, sans flash au chargement. |
| **Cartes de liens** | Comme sur X : image, domaine, titre, description. Source 1 : la carte fournie par X avec le tweet (aucun accès supplémentaire). Source 2 : lecture de la page liée si « Indexer les liens » est activé. Réglage « Afficher l'image des cartes » (l'image est chargée depuis le site du lien). |
| **Confort** | Navigation clavier (`↓`, `j/k`, `Entrée`, `s`, `/`), historique, ★ recherches enregistrées, 🎲 au hasard, 📅 il y a un an, rendu façon X (médias, vidéos, citations, compteurs). |
| **Thèmes** | ☰ regroupement automatique (k-means sur les embeddings) avec libellés TF-IDF ; nommage par l'IA en option. |
| **Sauvegarde** | Export JSON (chiffrable AES-GCM par mot de passe) avec, en option, les **vecteurs** (quantifiés int8, ~4× plus petits) et les recherches enregistrées ; import, et **dossier de synchro** (iCloud / Dropbox / Drive) pour retrouver ses bookmarks sur un autre appareil. |
| **Banc d'essai** | Mesure le rappel@10 et le MRR de plusieurs réglages sur tes propres requêtes (Réglages ▸ Banc d'essai). |

## Modèles

| Rôle | Choix | Détail |
|---|---|---|
| **Recherche sémantique** | **EmbeddingGemma** (300 M, texte, 256 dim) — par défaut | q8, ~300 Mo. |
| | **EmbeddingGemma 2** (multimodal, 768 dim) | [`onnx-community/embeddinggemma-2-ONNX`](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX), q4, transformers.js ≥ 4.3.1. Texte **et images** dans le même espace : avec « Recherche dans les images », une requête en n'importe quelle langue retrouve des images. Changer de modèle ré-indexe tout ; **chaque modèle garde ses propres vecteurs**, revenir en arrière est immédiat. |
| **Modèle de décision** | **Jev** (TypeSafe) via l'API Decisions d'OpenRouter, facultatif | Il classe et note, il ne rédige pas. Utilisé pour (1) comprendre le tri / la période / le type de contenu d'une requête, (2) reclasser les 20 meilleurs résultats (une note « pertinent : oui » par tweet). Requêtes `choice` uniquement. |
| **LLM** (rédaction) | API compatible OpenAI, facultatif | Questions-réponses, résumé, nommage des thèmes. |

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

## Vitesse d'indexation

Le calcul CPU (WASM) utilise plusieurs threads (⚙ › Calcul CPU : auto = cœurs − 2, 4 au plus ; 1 pour le plus doux). Les pages de l'extension sont « cross-origin isolated » (manifest, `credentialless`) pour permettre SharedArrayBuffer ; si le moteur n'arrive pas à démarrer en multi-thread, il retombe seul sur 1 thread. Les passages de transcription de plusieurs vidéos partagent les mêmes lots. La ligne d'état indique le mode (ex. « wasm ×4 »). Le GPU (⚙ › Calcul : auto) reste l'option la plus rapide mais la plus gourmande en mémoire.

## Sécurité mémoire

Calculer des embeddings pour des dizaines de milliers de tweets est lourd. Par défaut : **indexation manuelle** (bouton « ▶ Indexer », jamais au lancement du navigateur), **calcul CPU** (plus lent, mémoire prévisible), modèle libéré toutes les ~1 000 tweets et après 10 min d'inactivité. Le GPU et l'indexation automatique sont des options (⚙ › Indexation & mémoire). Si le navigateur plante au démarrage : `open -a Comet --args --disable-extensions`.

## Limites connues

- Le format GraphQL de X est non documenté : si la capture casse, c'est `src/lib/parse.js` à ajuster (un bandeau te prévient).
- La synchro automatique reste en zone grise des CGU de X : rythme volontairement lent, arrêt sur HTTP 429.
- **Non testé hors simulation** : EmbeddingGemma 2 (téléchargement et calcul réels, y compris images), les appels réels à Jev (le format de réponse `choice → confidence / probabilities` vient d'exemples publics, vérifié ici seulement contre un faux serveur), le téléchargement/l'inférence des modèles (Hugging Face est bloqué dans l'environnement de développement), la recherche d'images CLIP, la lecture de vraies pages liées, l'accès au dossier de synchro, et toute API d'IA réelle.
- Dossiers de bookmarks de X : format GraphQL non vérifié, non implémenté.
- Jev : les types de question `score` et `noul` (format de réponse non vérifié) ne sont pas utilisés.
- L'IA locale dans le navigateur (WebGPU) n'est pas implémentée ; passer par Ollama.
