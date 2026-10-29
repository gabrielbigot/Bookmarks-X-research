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
3. Chrome doit être ouvert avec l'extension active. Dans ⚙ › Pont MCP, l'état passe à « ✓ connecté » quelques secondes après le lancement de l'assistant (l'extension réessaie toutes les 8 s, puis toutes les 30 s).

Autre port : `XBS_PORT=48000` côté serveur **et** même valeur dans ⚙. **Un seul assistant à la fois** : un deuxième serveur MCP lancé en parallèle ne pourrait pas utiliser le même port (il le signale dans ses logs).

## Outils

| Outil | Rôle |
|---|---|
| `search` | recherche hybride (sens + mots-clés) ; opérateurs `from:@compte`, `since:`, `until:`, `has:link\|media\|video\|transcript`, `source:youtube`, `playlist:"nom"`, `lang:fr`, `viewed:oui` ; options `source`, `sort` (pertinence, récent, ancien, likes, ajout), `mode`, `limit` (≤ 50). Pour une vidéo, renvoie le passage de transcription le plus proche avec un lien daté |
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
* **Dépannage** : « l'extension n'est pas connectée » → Chrome ouvert ? case cochée ? même jeton et même port des deux côtés ? Les logs du serveur (stderr) sont visibles dans les journaux MCP de ton assistant.
