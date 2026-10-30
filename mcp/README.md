# Pont MCP : interroger tes bookmarks et tes vidéos depuis un assistant IA

Ce pont permet à un assistant installé **sur ton ordinateur** (Claude Desktop, Claude Code, tout client MCP) de chercher dans tes bookmarks X, tes playlists et ton historique YouTube (transcriptions comprises), avec la recherche de l'extension : par le sens **et** par mots-clés.

```
assistant IA ──(MCP, stdio)──▶ mcp/server.mjs ◀──(WebSocket 127.0.0.1)── extension (Chrome)
                                                         │
                                                         └─ sa recherche, son index : rien n'est copié ailleurs
```

* **Lecture seule** : aucun outil n'écrit, ne supprime ni ne synchronise quoi que ce soit.
* **Local** : le serveur n'écoute que sur `127.0.0.1`. Il refuse toute connexion qui ne vient pas d'une extension Chrome (en-tête `Origin`) et exige un jeton secret.
* **Désactivé par défaut.**

## Installation (3 minutes)

Prérequis : Node 18 ou plus, le dépôt cloné (`git pull && npm run build`, extension rechargée).

1. Dans l'extension : ⚙ › **Pont MCP** → coche la case. Un jeton est généré.
2. Déclare le serveur dans ton assistant :
   * **Claude Code** : bouton « Copier la commande Claude Code » dans ⚙, puis colle-la en remplaçant `/CHEMIN/VERS` par l'emplacement du dépôt :
     `claude mcp add bookmarks -e XBS_TOKEN=<jeton> -- node /CHEMIN/VERS/Bookmarks-X-research/mcp/server.mjs`
   * **Claude Desktop** (sans écrire de JSON) : dans un terminal, dans le dossier du projet, lance
     `node mcp/setup.mjs --token <jeton>`
     (le bouton « Copier la commande Claude Desktop » de ⚙ la prépare). Le script ajoute l'entrée `bookmarks` à `claude_desktop_config.json` en gardant tout le reste, fait une copie de sauvegarde (`.bak`) et refuse de toucher à un fichier invalide. Puis **quitte complètement Claude Desktop et relance-le**. Pour retirer le serveur : `node mcp/setup.mjs --remove`.
     <details><summary>À la main</summary>

     Le fichier est déjà un objet JSON : n'ajoute que la partie `"mcpServers"` **à l'intérieur** des accolades existantes, avec une virgule entre deux entrées (et jamais après la dernière) :
     ```json
     {
       "autres_reglages": "déjà présents",
       "mcpServers": {
         "bookmarks": {
           "command": "node",
           "args": ["/CHEMIN/VERS/Bookmarks-X-research/mcp/server.mjs"],
           "env": { "XBS_TOKEN": "<jeton>" }
         }
       }
     }
     ```
     </details>
3. Le navigateur (Chrome, Comet, Brave, Edge… tout navigateur Chromium) doit être ouvert avec l'extension active. Dans ⚙ › Pont MCP, l'état passe à « ✓ connecté » quelques secondes après le lancement de l'assistant (l'extension réessaie toutes les 8 s, puis toutes les 30 s).

Autre port : `XBS_PORT=48000` côté serveur **et** même valeur dans ⚙. Plusieurs assistants peuvent être configurés en même temps (Claude Desktop et Claude Code, par exemple) : le premier serveur lancé tient le port, les suivants se raccordent à lui automatiquement.

## Outils

| Outil | Rôle |
|---|---|
| `search` | recherche hybride (sens + mots-clés) ; opérateurs `from:@compte`, `since:`, `until:`, `has:link\|media\|video\|transcript`, `source:youtube`, `playlist:"nom"`, `lang:fr`, `viewed:oui` ; options `source`, `sort` (pertinence, récent, ancien, likes, ajout), `mode`, `limit` (≤ 50), `offset` pour parcourir la suite (`next_offset`), et `brief` (liste compacte jusqu'à 200 éléments par appel, pour parcourir par exemple toutes les vidéos d'une chaîne). Pour une vidéo, renvoie le passage de transcription le plus proche avec un lien daté |
| `extract` | **lecture en masse à bas coût** : une question posée à des dizaines de vidéos (« qui est l'invité ? »). Un modèle peu cher lit des extraits ciblés de chaque transcription, l'assistant ne reçoit que les réponses, chacune avec une citation exacte et un lien daté. Voir ci-dessous |
| `get_item` | détail complet d'un tweet ou d'une vidéo |
| `get_transcript` | passages d'une vidéo proches d'une question, ou lecture continue à partir d'un instant |
| `similar` | éléments les plus proches (par le sens) d'un élément donné |
| `list_playlists` | playlists YouTube et nombre de vidéos |
| `stats` | volumes, comptes les plus enregistrés, rythme par mois |
| `journal_list`, `journal_read` | éditions du journal hebdomadaire déjà générées, lues par tranches |

Les playlists décochées dans l'extension (« ignorées ») restent exclues, comme partout ailleurs. Les opérateurs qui dépendent de l'interface (`is:`, `during:`, `jev:`…) sont ignorés, avec une note dans la réponse.

## À savoir

* **Confidentialité** : tout ce que l'assistant lit via ces outils est envoyé à son fournisseur (Anthropic pour Claude), comme n'importe quel texte que tu lui donnes. L'extension, elle, ne sort toujours rien d'elle-même. Ne l'active que si cela te convient.
* **Mémoire** : au premier appel, l'extension charge l'index (quelques secondes) ; elle le relâche après 15 minutes sans appel.
* **Recherche par le sens** : elle utilise le modèle d'embedding de l'extension. Si le modèle n'est pas prêt, la réponse le signale (`notes`) et se limite aux mots-clés.
* **« le port … est occupé »** : un autre programme (ou une ancienne copie du serveur avec un autre jeton) tient le port. Libère-le (`lsof -i :47821` sur macOS / Linux, `netstat -ano | findstr 47821` sous Windows ; une ancienne copie se ferme avec `pkill -f mcp/server.mjs`) ou change de port des deux côtés. Quitte aussi complètement Claude Desktop (pas seulement la fenêtre) avant de relancer.
* **Diagnostic dans l'extension** : ⚙ › Pont MCP affiche pourquoi la connexion échoue (aucun serveur sur le port / ancienne copie ou autre programme / jeton refusé) et se rafraîchit toutes les 4 secondes.
* **Logs du serveur** (ce que Claude Desktop en voit) : macOS `~/Library/Logs/Claude/mcp-server-bookmarks.log`, Windows `%APPDATA%\Claude\logs\mcp-server-bookmarks.log`. On doit y lire « en attente de l'extension sur 127.0.0.1:47821 » puis « extension connectée ».
* **Dépannage** : « l'extension n'est pas connectée » → Chrome ouvert ? case cochée ? même jeton et même port des deux côtés ? Les logs du serveur (stderr) sont visibles dans les journaux MCP de ton assistant.

## Lire beaucoup de vidéos sans brûler de tokens : `extract`

Faire lire 100 transcriptions à l'assistant coûte très cher. Avec `extract`, la lecture est faite **dans l'extension** par un modèle peu coûteux (via ta clé OpenRouter, déjà réglée pour le journal) ; l'assistant ne voit que le tableau des réponses.

1. **Sélection** : par `ids`, ou avec les filtres de `search` (`from:`, `since:`, `playlist:`…).
2. **Extraits, sans modèle** : l'ouverture de la vidéo (là où l'on présente l'invité) + les passages proches de la question, ≈ 1 000 tokens au lieu de 15 000 pour une heure de vidéo.
3. **Un appel peu cher par vidéo**, en parallèle ; réponse en JSON avec une citation.
4. **Vérification** : la citation doit figurer **mot pour mot** dans les extraits, sinon la réponse est écartée (compteur `rejectedCitations`). Les noms inventés passent difficilement ce filtre ; une transcription mal orthographiée reste un risque.
5. **Cache** : une même question sur une même vidéo n'est jamais payée deux fois.

Garde-fous : `estimate: true` donne le coût sans rien lire ; plafond par appel (⚙, 0,30 $ par défaut, `max_cost` pour le changer) ; au-delà, la lecture s'arrête (`stoppedByBudget`) et la suite se reprend avec `next_offset`.

### Choisir le modèle, en vérifiant qu'il est capable
⚙ › Pont MCP › **Comparer des modèles…** ouvre un banc d'essai : tu donnes quelques vidéos dont tu connais la réponse (`lien | réponse attendue`), et une liste de modèles (identifiant OpenRouter, ou quelques mots : « deepseek v4 flash » est résolu d'après le catalogue). Il affiche pour chacun la justesse, le coût par vidéo et pour 100 vidéos, la durée et les citations rejetées. Le bouton **Utiliser** enregistre le modèle et ses prix.

Points de départ à comparer (recherche faite fin octobre 2026, sources parfois contradictoires : vérifie les prix du catalogue) : DeepSeek V4.1 Flash (≈ 0,15 $ / 0,60 $ par million de tokens), GLM-5.3-Flash (≈ 0,15 $ / 0,50 $), MiMo Flash, Claude Haiku. Le moins cher qui réussit TON jeu d'essai est le bon.

Les transcriptions lues par ce modèle partent chez OpenRouter, comme pour le journal.

## Transcrire en local les vidéos sans transcription : `mcp/transcribe.mjs`

Quand l'extension n'arrive pas à récupérer une transcription (cartes « Pas de transcription » ou « à récupérer »), un outil local peut s'en charger avec **yt-dlp** puis, si besoin, la reconnaissance vocale de **Mistral**. Rien à installer côté npm.

1. **Dans l'extension** : affiche les vidéos voulues (une chaîne via « Comptes », une recherche, `has:notranscript`…), puis **⋯ › 📋 Copier les liens sans transcription (N)**. Le presse-papiers contient une vidéo par ligne : lien, durée, titre.
2. **Dans un terminal**, dossier du projet :
   ```
   brew install yt-dlp ffmpeg                       # une seule fois (macOS)
   pbpaste | node mcp/transcribe.mjs                # étape A : sous-titres YouTube (gratuit)
   pbpaste | node mcp/transcribe.mjs --audio        # + étape B : audio et Mistral pour les vidéos sans aucun sous-titre
   ```
   Autres systèmes : colle les lignes dans un fichier `liens.txt` et lance `node mcp/transcribe.mjs liens.txt`. Essayer d'abord : `--limit 3`, ou `--dry-run` pour voir l'estimation du coût sans rien appeler.
3. **Dans l'extension** : **⋯ › 📥 Importer des transcriptions…** et choisis `transcripts/results.json`. Les transcriptions sont indexées (mots et sens) comme les autres ; celles issues de la reconnaissance vocale portent la pastille « 🎙 Transcription audio ». Une vraie transcription déjà présente n'est jamais écrasée.

Options utiles : `--cookies-from-browser chrome` (navigateur connecté à YouTube : souvent nécessaire quand YouTube répond « Sign in to confirm you're not a bot »), `--budget 2` (plafond en $ pour l'audio), `--price 0.003` (prix d'une minute : vérifie la grille de Mistral), `--model voxtral-mini-latest`, `--lang fr`, `--sleep 3` (pause entre deux vidéos), `--out dossier`. `--help` les liste toutes. La clé Mistral se donne par la variable `MISTRAL_API_KEY` (jamais stockée dans l'extension).

À savoir :
* **La reprise est automatique** : relancer la même commande ne refait pas les vidéos déjà dans `results.json`. Après 3 refus anti-robot de suite, l'outil s'arrête pour ne pas faire bloquer ton IP.
* **Les sous-titres d'abord** : les sous-titres YouTube existent pour la plupart des vidéos, même quand l'extension n'a pas pu les lire ; la reconnaissance vocale (payante) n'est tentée que sans aucun sous-titre.
* **Conditions d'utilisation de YouTube** : télécharger des vidéos n'est pas prévu par ses conditions ; pour de l'audio à des fins personnelles c'est une zone grise, à ta décision. L'audio est envoyé à Mistral.
* L'outil est testé avec de faux `yt-dlp`, `ffmpeg` et serveur Mistral : le premier essai réel (YouTube, API Mistral) reste à faire sur 2 ou 3 vidéos.
