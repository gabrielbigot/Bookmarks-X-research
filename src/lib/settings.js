// Réglages utilisateur (chrome.storage.local). La clé d'API reste sur cet appareil, en clair.
export const DEFAULTS = {
  llm: { baseUrl: '', apiKey: '', model: '' }, // API compatible OpenAI (OpenRouter, Ollama local, OpenAI, Cloudflare…)
  aiIntent: false, // comprendre les requêtes avec l'IA
  aiRerank: false, // reclasser les meilleurs résultats avec l'IA
  enrichLinks: false, // indexer le titre/description des pages liées
  imageSearch: false, // recherche d'images (CLIP, expérimental)
  embedModel: 'gemma1', // 'gemma1' (300 M, texte) | 'gemma2' (multimodal)
  decision: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13', apiKey: '' }, // modèle de décision (Jev)
  decisionIntent: false, // tri / période / type compris par le modèle de décision
  decisionRerank: false, // reclassement par le modèle de décision
  compute: 'cpu', // 'cpu' = WASM (plus lent, mémoire prévisible, par défaut) | 'auto' = GPU si possible (rapide, mais gourmand : à activer en connaissance de cause)
  indexMode: 'manual', // 'manual' : l'indexation ne démarre que sur clic (« Indexer ») | 'auto' : au démarrage et à chaque nouveau tweet
  settingsVersion: 3,
  linkImages: true, // afficher l'image des cartes de liens (charge l'image depuis le site : désactive pour ne contacter personne)
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
  return { ...DEFAULTS, ...settings, llm: { ...DEFAULTS.llm, ...settings?.llm }, decision: { ...DEFAULTS.decision, ...settings?.decision } };
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch, llm: { ...cur.llm, ...patch.llm }, decision: { ...cur.decision, ...patch.decision } };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export const llmReady = (s) => !!(s.llm.baseUrl && s.llm.model);

export const decisionReady = (s) => !!(s.decision.url && s.decision.model && s.decision.apiKey);
