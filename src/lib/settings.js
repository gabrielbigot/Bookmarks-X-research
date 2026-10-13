// Réglages utilisateur (chrome.storage.local). La clé d'API reste sur cet appareil, en clair.
export const DEFAULTS = {
  llm: { baseUrl: '', apiKey: '', model: '' }, // API compatible OpenAI (OpenRouter, Ollama local, OpenAI, Cloudflare…)
  aiIntent: false, // comprendre les requêtes avec l'IA
  aiRerank: false, // reclasser les meilleurs résultats avec l'IA
  enrichLinks: false, // indexer le titre/description des pages liées
  imageSearch: false, // recherche d'images (CLIP, expérimental)
  autoSync: true, // récupérer les nouveautés tout seul quand un onglet X est ouvert
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...settings, llm: { ...DEFAULTS.llm, ...settings?.llm } };
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch, llm: { ...cur.llm, ...patch.llm } };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export const llmReady = (s) => !!(s.llm.baseUrl && s.llm.model);
