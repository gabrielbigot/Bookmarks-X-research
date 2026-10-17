# Journal de la semaine : les réglages de « Générer l'édition »

Cette page décrit, dans l'ordre du formulaire, ce que fait chaque case ou champ, comment il agit
vraiment, ce qu'il coûte et dans quel cas y toucher. Les valeurs « par défaut » sont celles d'une
installation neuve.

**Vue d'ensemble de la génération** (ce que fait le bouton « Générer le journal », dans l'ordre) :

1. lecture de la base et choix des éléments de la période, regroupés en **sujets** ;
2. lecture des pages liées, recherche d'extraits dans les transcriptions de vidéos, transcription par l'IA des vidéos sans sous-titres ;
3. recherche web pour les plus grands sujets ;
4. rédaction des articles, relecture automatique, reportages vidéo, brèves, éditorial ;
5. classements de modèles, usage, avis ;
6. choix des images, mise en pages (avec réduction du texte si le budget de pages est dépassé), enregistrement de l'édition.

Chaque étape qui appelle ton modèle d'IA est comptée dans le **plafond de dépense**. Le bouton
**« Estimer le coût »** exécute seulement les étapes 1 et le calcul de l'estimation : il n'appelle
aucun modèle et ne dépense rien.

---

## Période et volume

### Période
Menu : « Les 7 derniers jours », « Semaine précédente », puis jusqu'à 12 semaines en arrière, avec les dates.
- La période est une fenêtre de **7 jours consécutifs** qui se termine aujourd'hui (pour 0) ou 7 × N jours plus tôt.
- Pour les bookmarks : on utilise la **date d'enregistrement** quand elle est fiable, sinon la date de publication.
- Pour les vidéos : une vidéo compte si elle a été **regardée** ces jours-là (historique YouTube) ou **ajoutée à une playlist** ces jours-là. Les dates d'ajout issues d'une synchronisation en masse (plus de 40 vidéos à la même quinzaine de secondes) sont ignorées : seuls leurs visionnages réels datent.
- Les benchmarks et les prix de la page Classements sont toujours ceux d'aujourd'hui, même pour une semaine passée ; le catalogue (nouveaux modèles) et l'usage suivent la période.

### Ancienneté maximale
14 jours / **45 jours** / 120 jours / Aucune limite.
- Écarte des sujets les bookmarks **publiés** plus de N jours avant la fin de la période, et des reportages les vidéos publiées avant cette limite.
- Sert à éviter qu'un vieux contenu enregistré cette semaine passe pour une actualité. Une vidéo ancienne regardée cette semaine reste dans la page « À voir et à écouter ».
- Les éléments sans date de publication connue ne sont jamais écartés. Le nombre d'éléments écartés est indiqué dans le journal de génération.
- À mettre sur « Aucune limite » si tu veux garder les contenus intemporels (tutoriels, fils de fond).

### Nombre de pages visé
**30** par défaut ; 0 = pas de limite.
- Le journal essaie de tenir dans ce nombre de pages. Deux leviers, dans cet ordre :
  1. **Avant la rédaction** : le nombre de reportages et leur longueur sont limités au budget restant (ce qui baisse aussi le coût). Le journal de génération indique par exemple « Budget de 30 pages : 3 reportages de 1 150 mots au plus ».
  2. **À la mise en pages** : si l'édition dépasse encore, le texte est réduit par paliers (95 %, 91 %, 87 %). Il ne descend jamais sous environ 8,6 pt.
- Si ça ne suffit pas, un avertissement te dit de réduire les articles, les brèves ou les reportages.
- Pour garder des reportages longs, monte le budget (40 ou plus).

---

## Modèles et coût

### Modèle de rédaction
Nom d'un modèle (par exemple `z-ai/glm-5.3`). **Vide = le modèle réglé dans ⚙ › IA.**
Rédige les **grands sujets** et les **reportages** vidéo (ouverture et chaque partie). Peu de texte, mais c'est le plus visible : un modèle de bonne qualité se justifie ici.

### Modèle assistant
Même principe (vide = modèle de ⚙ › IA). Fait tout le reste : articles moyens, brèves, éditorial, recherche web, résumés de transcriptions, relecture, avis sur les modèles. Beaucoup d'appels, peu exigeants : un modèle bon marché suffit.

Si ton modèle impose un raisonnement (certains GLM, par exemple), l'extension désactive le raisonnement quand c'est possible, sinon en demande un court. Le coût réel peut alors dépasser l'estimation ; le plafond, lui, se base sur le coût réel renvoyé par OpenRouter.

### Prix entrée / Prix sortie
Dollars **par million de tokens** (0,3 et 1,2 par défaut).
- Servent **uniquement à l'estimation** et à compter la dépense quand le fournisseur ne renvoie pas le coût réel.
- Avec OpenRouter, le coût réel renvoyé par chaque réponse est utilisé, donc ces champs importent peu. Mets les prix de ton modèle assistant pour une estimation juste.

### Plafond par édition
Dollars (**1** par défaut).
- Avant chaque appel, l'extension vérifie que la dépense cumulée plus l'appel prévu reste sous le plafond.
- Au plafond : les sujets restants sont présentés en **version simplifiée** (sans rédaction par l'IA), les étapes facultatives (relecture, brèves, avis…) sont allégées ou sautées, et le journal le dit. L'édition sort quand même.
- La transcription par l'IA et la recherche web comptent dans ce plafond.

---

## Combien d'articles

Les éléments de la période sont regroupés en sujets (même tweet cité, même page citée ou sens quasi identique à quelques jours d'écart), classés par importance (nombre de tweets, audience, source primaire ou officielle), puis répartis ainsi :

### Grands sujets
**4** par défaut (0 à 8). Articles de une d'environ 700 mots, avec grande image et recherche web. **Au plus 2 par rubrique**, pour que chaque rubrique ait sa une.

### Articles
**14** par défaut (0 à 40). Articles d'environ 300 mots, 3 à 4 paragraphes, avec une image en colonne.

### Brèves
**30** par défaut (0 à 80). Une brève = 30 à 50 mots, regroupées par rubrique en 3 colonnes. Elles sont rédigées par lots de 8 en un seul appel : c'est l'étape la moins chère par sujet.

Si les trois valent 0, il n'y a rien à publier.

---

## Sources de contenu

### Lire les pages liées dans les tweets
Coché par défaut. Pour chaque grand sujet et article, l'extension lit jusqu'à **2 pages liées** par sujet pour en extraire le texte (sources [L]).
- Demande une autorisation d'accès aux sites, **une seule fois**.
- Sans autorisation, ou si une page est illisible : on se contente de la carte enregistrée avec le tweet (titre et description).
- Les pages lues sont mises en cache (300 dernières).

### Compléter les sujets avec les transcriptions de mes vidéos
Coché par défaut. Pour chaque sujet, l'extension cherche (par le sens) dans les transcriptions de **tes** vidéos des passages proches du sujet, et les ajoute au dossier de preuves avec leur horodatage (sources [V]).
- Seuil de ressemblance 0,55, jusqu'à 2 vidéos par sujet et 3 passages par vidéo.
- Seules les vidéos transcrites et actives dans les 60 jours qui précèdent la fin de la période sont consultées.
- Gratuit (recherche locale).

### Transcrire par l'IA les vidéos de la semaine sans sous-titres
**Décoché par défaut** (payant). OpenRouter uniquement.
- YouTube ne fournit pas de sous-titres aux vidéos très récentes, et refuse les requêtes directes. Cette option envoie l'**adresse YouTube** de chaque vidéo concernée à un modèle vidéo (Gemini via OpenRouter), qui la regarde et renvoie une transcription horodatée.
- Vidéos concernées : celles de la période, sans transcription, **qui seraient retenues pour un reportage** (chaînes prioritaires d'abord, puis vidéos qui correspondent aux rubriques), au plus autant que de reportages demandés, et pas plus longues que la durée maximale.
- Les vidéos qui ne viennent que de ton **historique de visionnage** ne sont envoyées que si ⚙ › IA l'autorise (sinon elles sont listées comme non envoyées). Celles qui sont dans une playlist partent normalement.
- La transcription est enregistrée comme les autres (recherche, reportages) avec la pastille 🤖 « générée par une IA, peut contenir des erreurs ».
- Le journal indique pour chaque vidéo le nombre de passages et jusqu'où ils vont (« de 0:00 à 18:20 sur 19:05 ») et alerte si la transcription s'arrête avant 70 % de la durée.
- Une heure de vidéo coûte de l'ordre de 0,2 à 0,5 $ avec Gemini 3 Flash.

#### Modèle de transcription
Identifiant d'un modèle OpenRouter qui accepte la vidéo (défaut : `google/gemini-3-flash-preview`). Un modèle « lite » coûte moins.

#### Durée maximale
Minutes (150 par défaut). Les vidéos plus longues ne sont pas transcrites par l'IA.

#### Coût estimé
Dollars **par minute de vidéo** (0,006 par défaut) : sert à l'estimation et à vérifier le plafond avant l'appel. Le coût réel renvoyé par OpenRouter est ensuite utilisé.

---

## Reportages vidéo

### Reportages vidéo
Nombre maximum de reportages (0 à 8, **2** par défaut). Un reportage est un long article tiré de la **transcription d'une vidéo** : la transcription est résumée par parties (6 à 12 points horodatés, citations exactes), puis rédigée partie par partie avec intertitres, relue partie par partie, avec en tête l'image de la vidéo, la liste des parties horodatées et « L'essentiel ».

Une vidéo est candidate si **toutes** ces conditions sont réunies :
- elle a une **transcription** (YouTube ou IA) ;
- elle a été **regardée ou ajoutée** pendant la période (voir Période) ;
- elle n'est pas plus **ancienne** que l'ancienneté maximale ;
- elle correspond à une **rubrique** cochée, ou vient d'une **chaîne prioritaire** (voir plus bas).

Ordre de choix : chaînes prioritaires, puis vidéos regardées avant les vidéos seulement ajoutées, puis avancement de visionnage, puis récence. Le **budget de pages** peut réduire ce nombre.

### Détail des reportages
- **Court** : ≈ 20 mots par minute de vidéo, de 450 à 1 400 mots (≈ 1 page).
- **Normal** : ≈ 32 mots par minute, de 600 à 2 400 mots (≈ 2 pages pour 1 h).
- **Détaillé** (défaut) : ≈ 48 mots par minute, de 800 à 3 400 mots (≈ 3 à 4 pages pour 1 h).

La longueur suit la durée de la vidéo ; le nombre de parties va de 1 à 7. Plus c'est détaillé, plus il y a d'appels (donc de coût).

### Chaînes prioritaires pour les reportages
Noms ou `@identifiants` séparés par des virgules (par exemple `Silicon Carne, @hey_initium`).
Leurs vidéos de la période passent **en premier** et échappent au filtre par rubrique. La chaîne est retrouvée par son nom ou son identifiant, même approximatif (« @siliconcarnepod » retrouve « Silicon Carne »). Si des vidéos prioritaires n'ont pas de transcription, le journal le signale (et propose de lancer « Transcriptions » ou la transcription par l'IA).

### Reportages : seulement les vidéos qui correspondent aux rubriques cochées
Coché par défaut. Une vidéo hors de toutes les rubriques cochées (détecteurs) n'est pas retenue pour un reportage, sauf chaîne prioritaire. Évite par exemple un débrief de match de foot dans un journal sur l'IA. Le nombre de vidéos écartées est indiqué. Sans détecteur, ce filtre ne fait rien.

---

## Enrichissements

### Recherche web sur les grands sujets
**Décoché par défaut** (payant). OpenRouter uniquement.
Pour les sujets les plus importants, le modèle assistant cherche sur le web (plugin web d'OpenRouter) 4 à 8 faits de contexte (chiffres, dates, réactions, concurrents).
- Seuls les faits dont l'**adresse figure parmi les pages réellement consultées** (renvoyées par le fournisseur) sont gardés : jamais d'adresse inventée. Ils entrent dans l'article comme sources [W] et apparaissent dans l'index des sources.
- Si le fournisseur ne renvoie pas les pages consultées, les résultats sont ignorés et le journal le dit.

#### Sujets recherchés
Nombre de sujets concernés (6 par défaut, 1 à 20), dans l'ordre d'importance. Deux recherches en parallèle.

#### Prix par recherche
Dollars (0,02 par défaut) : estimation du supplément facturé par recherche ; le coût réel d'OpenRouter est utilisé quand il est renvoyé.

### Page « Classements des modèles »
Coché par défaut. Gratuit, **OpenRouter uniquement**. Ajoute jusqu'à 4 pages :
- **Classements** : barres d'intelligence, de code et d'agent (Artificial Analysis, via `GET /api/v1/benchmarks`), nuage qualité / prix de sortie ; les modèles dont il a été question dans tes lectures sont en rouge ; page des nouveaux modèles du catalogue (`GET /api/v1/models`).
- **Usage et avis** : modèles les plus utilisés sur OpenRouter (tokens, part, évolution), modèles les plus commentés dans tes lectures (mentions pondérées par likes et reposts), et « Ce qu'on en dit » : résumé automatique des avis (un seul appel, quelques centimes) pour les 5 modèles les plus commentés, avec renvois aux tweets sources.
- **Qualité, prix, vitesse** : meilleur rapport intelligence / prix mixte (3 parts d'entrée pour 1 de sortie) et modèles rapides de haut niveau (débit et latence médians constatés).
Une source indisponible supprime seulement sa partie. Les scores décrivent le classement au moment de la génération.

#### Taille des classements
Top 5 / **Top 10** / Top 15 : nombre de modèles affichés dans chaque classement.

### Relecture automatique
Coché par défaut (je te conseille de le laisser coché). Un second passage compare **chaque phrase** de chaque article (et de chaque partie de reportage) au dossier de sources et **retire** les phrases que les sources ne soutiennent pas. Une citation mise en exergue doit figurer **mot pour mot** dans un tweet ou une transcription. Le nombre de phrases retirées est indiqué. Coût : un appel supplémentaire par article ou partie, avec le modèle assistant.

---

## Rubriques

Une case par **détecteur** défini dans « Mes stats ». Chaque détecteur coché devient une rubrique du journal (avec son bandeau de couleur).
- Un tweet n'apparaît que dans la **première rubrique cochée** qui le retient.
- **Aucune case cochée = toute la semaine**, en une seule rubrique « À la une ».
- Les rubriques servent aussi de filtre pour les reportages (voir plus haut).
- Un détecteur dont les exemples n'ont pas été analysés avec le modèle actuel est ignoré (message dans le journal).

---

## Boutons, journal de génération, éditions

- **Estimer le coût** : calcule le nombre de sujets, d'appels et le coût approximatif sans rien dépenser, et signale les vidéos retenues ou écartées. À utiliser avant chaque nouveau réglage important.
- **Générer le journal** : lance la génération ; la barre de progression et le journal de génération détaillent chaque étape et chaque avertissement (⚠).
- **Arrêter** : interrompt la génération en cours (ce qui a déjà été dépensé reste dépensé).
- **Éditions** : les 12 dernières éditions sont conservées. **Ouvrir** réaffiche une édition ; **Enregistrer en PDF** utilise l'impression du navigateur (A4, marges à zéro). **Supprimer** retire l'édition.

---

## Trois réglages de départ

| | Économique | Équilibré | Qualité |
|---|---|---|---|
| Modèle de rédaction | = assistant | modèle moyen | bon modèle |
| Modèle assistant | modèle bon marché | modèle bon marché | modèle moyen |
| Grands sujets / articles / brèves | 3 / 8 / 20 | 4 / 14 / 30 | 6 / 20 / 40 |
| Recherche web | non | 4 sujets | 8 sujets |
| Relecture automatique | non | oui | oui |
| Reportages (détail) | 1 (court) | 2 (normal) | 4 (détaillé) |
| Transcription par l'IA | non | non | oui |
| Plafond | 0,5 $ | 1 $ | 3 $ |
| Pages visées | 20 | 30 | 40 |

Ce sont des points de départ : regarde le coût estimé et le coût réel affiché en fin de génération, puis ajuste.

## Messages fréquents du journal de génération

| Message | Signification |
|---|---|
| « N vidéo(s) de vos chaînes prioritaires … sans transcription » | Pas de reportage possible pour ces vidéos : lancer « Transcriptions » dans le panneau ou cocher la transcription par l'IA. |
| « N vidéo(s) … écartée(s) des reportages : hors des rubriques cochées » | Le filtre par rubrique a écarté ces vidéos. |
| « Écartés car publiés avant le … » | L'ancienneté maximale a écarté des bookmarks ou des vidéos. |
| « Budget de N pages : … » | Le nombre ou la longueur des reportages a été limité pour tenir dans les pages visées. |
| « Texte réduit à N % … » | Le texte a été réduit pour tenir dans le nombre de pages. |
| « Plafond atteint … » | Le plafond de dépense a été atteint : fin d'édition en version simplifiée. |
| « ⚠ Le fournisseur n'a pas renvoyé les pages consultées » | La recherche web est ignorée : OpenRouter ne confirme pas les adresses. |
| « API IA : réponse vide (limite de sortie atteinte …) » | Un modèle à raisonnement a consommé sa limite de sortie avant de répondre. |
