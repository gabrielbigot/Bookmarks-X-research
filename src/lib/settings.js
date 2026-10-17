// Réglages utilisateur (chrome.storage.local). La clé d'API reste sur cet appareil, en clair.
export const DEFAULTS = {
  llm: { baseUrl: '', apiKey: '', model: '' }, // API compatible OpenAI (OpenRouter, Ollama local, OpenAI, Cloudflare…)
  aiIntent: false, // comprendre les requêtes avec l'IA
  aiRerank: false, // reclasser les meilleurs résultats avec l'IA
  enrichLinks: false, // indexer le titre/description des pages liées
  imageSearch: false, // recherche d'images (CLIP, expérimental)
  embedModel: 'gemma1', // 'gemma1' (300 M, texte) | 'gemma2' (multimodal)
  decision: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13', apiKey: '', priceInPerM: 0.042 }, // priceInPerM : $ par million de tokens d'entrée (estimation du coût) // modèle de décision (Jev)
  journal: { writerModel: '', assistModel: '', budget: 1, priceInPerM: 0.3, priceOutPerM: 1.2, sections: null, readLinks: true, useTranscripts: true, reportages: 2, maxAge: 45, benchmarks: true, benchTop: 10, aiTranscribe: false, aiTrModel: 'google/gemini-3-flash-preview', aiTrPerMin: 0.006, aiTrMaxMin: 150, reportTopicOnly: true, maxPages: 30, priority: '', reportDepth: 'detailed', search: false, searchTop: 6, searchPrice: 0.02, verify: true, leads: 4, articles: 14, briefs: 30 }, // journal hebdomadaire : modèles (vide = modèle de l'IA), plafond en $, prix indicatifs par million de tokens, rubriques = détecteurs (null = tous)
  autoJev: { on: false, dailyCap: 0.1 }, // jugement automatique des nouveaux éléments par Jev (désactivé ; plafond en $ par jour)
  decisionIntent: false, // tri / période / type compris par le modèle de décision
  decisionRerank: false, // reclassement par le modèle de décision
  compute: 'cpu', // 'cpu' = WASM (plus lent, mémoire prévisible, par défaut) | 'auto' = GPU si possible (rapide, mais gourmand : à activer en connaissance de cause)
  indexMode: 'manual', // 'manual' : sur clic (« Indexer ») | 'soft' : automatique par petites tranches, jamais au lancement | 'auto' : tout, au démarrage et à chaque nouveau tweet (déconseillé)
  settingsVersion: 4,
  ytExcluded: [], // playlists YouTube que le système ignore (synchro, recherche, stats, indexation, transcriptions). Vide = toutes
  updHistory: false, // « Tout mettre à jour » inclut l'historique YouTube (désactivé : gros retard à rattraper à part)
  updTranscripts: false, // … et les transcriptions des nouvelles vidéos (au plus 50 en automatique, 300 au clic)
  autoTabs: true, // la mise à jour automatique peut ouvrir un onglet X / YouTube en arrière-plan (refermé ensuite)
  linkImages: true, // afficher l'image des cartes de liens (charge l'image depuis le site : désactive pour ne contacter personne)
  ytHistoryDays: 90, // profondeur de la synchro de l'historique YouTube (0 = tout)
  ytTranscripts: 'playlists', // vidéos dont on récupère la transcription : 'playlists' | 'all' (+ historique)
  threads: 'auto', // calcul CPU : 'auto' (cœurs − 2, max 4) | '1' | '2' | '6'
  ytTrSpeed: 'normal', // récupération des transcriptions : 'prudent' (1 à la fois) | 'normal' (3) | 'rapide' (6)
  ytTrPage: true, // transcriptions : si la voie directe échoue, ouvrir la page de la vidéo et lire les sous-titres chargés par le lecteur
  ytTrPageMax: 40, // vidéos par passage par la page vidéo
  ytTrBatch: 0, // vidéos par passage de récupération des transcriptions (0 = toutes ; reprise possible après un arrêt)
  ytTrWords: 20000, // profondeur d'indexation par mots d'une transcription, en caractères (20 000 ≈ 20 min de parole)
  ytTrPassages: 12, // passages vectorisés par vidéo (recherche par sens)
  aiHistory: false, // autoriser l'envoi de l'historique de visionnage à une IA externe
  autoSync: true, // récupérer les nouveautés tout seul quand un onglet X est ouvert
};

export async function getSettings() {
  let { settings } = await chrome.storage.local.get('settings');
  // Migration de sécurité (une fois) : le calcul GPU automatique et l'indexation au démarrage pouvaient saturer la mémoire.
  if (settings && (settings.settingsVersion || 0) < 3) {
    settings = { ...settings, compute: 'cpu', indexMode: 'manual', settingsVersion: 3 };
    delete settings.indexPaused;
    await chrome.storage.local.set({ settings });
  }
  // v4 : l'indexation manuelle devient « automatique par tranches » (mémoire bornée, jamais au lancement) ; modifiable dans ⚙
  if (settings && settings.settingsVersion < 4) {
    settings = { ...settings, indexMode: settings.indexMode === 'manual' ? 'soft' : settings.indexMode, settingsVersion: 4 };
    await chrome.storage.local.set({ settings });
  }
  return { ...DEFAULTS, ...settings, llm: { ...DEFAULTS.llm, ...settings?.llm }, decision: { ...DEFAULTS.decision, ...settings?.decision }, autoJev: { ...DEFAULTS.autoJev, ...settings?.autoJev }, journal: { ...DEFAULTS.journal, ...settings?.journal } };
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch, llm: { ...cur.llm, ...patch.llm }, decision: { ...cur.decision, ...patch.decision }, autoJev: { ...cur.autoJev, ...patch.autoJev }, journal: { ...cur.journal, ...patch.journal } };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export const llmReady = (s) => !!(s.llm.baseUrl && s.llm.model);

export const decisionReady = (s) => !!(s.decision.url && s.decision.model && s.decision.apiKey);
