// Pont MCP : met l'index de l'extension à disposition d'un client MCP (Claude Desktop, Claude Code…) qui tourne sur la même machine.
// L'extension se connecte (WebSocket, 127.0.0.1 uniquement) au petit serveur `mcp/server.mjs` que le client MCP a lancé ; le serveur lui
// transmet les appels d'outils, l'extension répond avec sa propre recherche. Rien n'est copié ailleurs. Lecture seule. Désactivé par défaut.
import { Index } from './lib/search.js';
import { fullLoad, refresh } from './lib/store.js';
import { getSettings } from './lib/settings.js';
import { modelOf } from './lib/models.js';
import { getMeta, setMeta, getTranscripts, playlistCatalog } from './lib/db.js';
import { chatFull } from './lib/llm.js';
import { resolveModel, perMillion } from './lib/extract.js';
import { markBulkAdded } from './lib/ytdate.js';
import { createTools } from './lib/mcp.js';

const ALARM = 'xbs-mcp';
const IDLE_DROP_MS = 15 * 60_000; // l'index en mémoire est relâché après 15 min sans appel
const REFRESH_EVERY_MS = 20_000;

export function startBridge({ embed }) {
  let diag = { at: 0, opened: false, probe: '' };
  let ws = null, connecting = false, pingTimer = null, retryTimer = null, index = null, indexModel = '', loading = null, lastRefresh = 0, dropTimer = null;

  async function getIndex() {
    clearTimeout(dropTimer);
    dropTimer = setTimeout(() => { index = null; indexModel = ''; }, IDLE_DROP_MS);
    if (loading) return loading;
    const s = await getSettings();
    const m = modelOf(s.embedModel);
    loading = (async () => {
      if (!index || indexModel !== m.id) { index = new Index(m.dim); indexModel = m.id; await fullLoad(index, m.id); }
      else if (Date.now() - lastRefresh > REFRESH_EVERY_MS) await refresh(index, m.id);
      lastRefresh = Date.now();
      markBulkAdded(index.tweets);
      return index;
    })();
    try { return await loading; } finally { loading = null; }
  }

  // réponses d'extraction déjà payées : jamais relues deux fois (4000 entrées au plus)
  let xcache = null, xTimer = null;
  const cacheOf = async () => {
    if (!xcache) xcache = new Map(Object.entries((await getMeta('mcpExtract')) || {}));
    return { get: (k) => xcache.get(k), set: (k, v) => { xcache.delete(k); xcache.set(k, v); if (xcache.size > 4000) xcache.delete(xcache.keys().next().value); clearTimeout(xTimer); xTimer = setTimeout(() => setMeta('mcpExtract', Object.fromEntries(xcache)).catch(() => {}), 2000); } };
  };
  let catalog = null, catalogAt = 0;
  const catalogOf = async (llm) => {
    if (!catalog || Date.now() - catalogAt > 3600_000) { const r = await fetch(new URL(llm.baseUrl).origin + '/api/v1/models'); if (!r.ok) throw new Error('catalogue OpenRouter indisponible (HTTP ' + r.status + ')'); catalog = (await r.json()).data || []; catalogAt = Date.now(); }
    return catalog;
  };
  const tools = createTools({
    extractCfg: async () => {
      const s = await getSettings();
      if (!s.llm.baseUrl || !s.llm.apiKey) throw new Error('aucune IA configurée dans l’extension (⚙ › IA) : nécessaire pour la lecture en masse');
      let model = s.mcp.extractModel || s.journal.assistModel || s.llm.model, prices = { inPerM: s.mcp.priceIn ?? 0.2, outPerM: s.mcp.priceOut ?? 0.6 };
      if (!model) throw new Error('aucun modèle d’extraction : renseigne-le dans ⚙ › Pont MCP');
      if (/openrouter\.ai/i.test(s.llm.baseUrl) && !model.includes('/')) { // nom approximatif (« deepseek v4.1 flash ») : résolu d'après le catalogue, avec ses prix réels
        const hit = resolveModel(await catalogOf(s.llm), model);
        if (!hit) throw new Error(`modèle « ${model} » introuvable dans le catalogue OpenRouter : indique son identifiant exact (ex. deepseek/deepseek-v4-flash) ou choisis-le avec « Comparer des modèles… »`);
        model = hit.id;
        prices = { inPerM: perMillion(hit.pricing?.prompt) ?? prices.inPerM, outPerM: perMillion(hit.pricing?.completion) ?? prices.outPerM };
      }
      return { model, budget: s.mcp.extractBudget || 0.3, prices, cache: await cacheOf(),
        llm: async (messages) => { const r = await chatFull(s.llm, messages, { model, maxTokens: 500, temperature: 0, noThink: true }); return { text: r.text, cost: r.usage.cost }; } };
    },
    getIndex,
    embed: async (text) => { const r = await embed(text); if (!r || r.error) throw new Error(r?.error || 'pas de réponse du modèle'); return Float32Array.from(r.vec); },
    getTranscripts: async (ids) => (ids.length ? getTranscripts(ids) : new Map()),
    playlists: playlistCatalog,
    journals: async () => (await getMeta('journalIndex')) || [],
    journal: (id) => getMeta('journal:' + id),
  });

  async function onRequest(msg) {
    const reply = (o) => { try { ws?.send(JSON.stringify({ id: msg.id, ...o })); } catch { /* connexion fermée */ } };
    try {
      const fn = tools[msg.method];
      if (typeof fn !== 'function' || msg.method.startsWith('_')) throw new Error('outil inconnu : ' + msg.method);
      reply({ result: await fn(msg.params || {}) });
    } catch (e) { reply({ error: String(e?.message || e) }); }
  }

  async function connect() {
    const s = (await getSettings()).mcp;
    if (!s?.on || !s.token) { chrome.alarms.clear(ALARM); return disconnect(); }
    chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); // rouvre la connexion si le service worker s'est endormi
    if (ws || connecting) return;
    connecting = true;
    diag = { at: Date.now(), opened: false, probe: '' };
    try {
      const sock = new WebSocket(`ws://127.0.0.1:${s.port || 47821}/xbs`);
      sock.onopen = () => { diag.opened = true; ws = sock; connecting = false; sock.send(JSON.stringify({ type: 'hello', token: s.token, build: __BUILD__ })); pingTimer = setInterval(() => { try { sock.send('{"type":"ping"}'); } catch { /* fermée */ } }, 20_000); };
      sock.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m.id !== undefined && m.method) onRequest(m); };
      const closed = () => { clearInterval(pingTimer); if (ws === sock) ws = null; connecting = false; probe(s.port || 47821); scheduleRetry(); };
      sock.onclose = closed;
      sock.onerror = () => { connecting = false; };
    } catch { connecting = false; scheduleRetry(); }
  }
  // Pourquoi la connexion échoue : notre serveur répond-il (/health), un autre programme, ou rien ?
  async function probe(port) {
    const url = `http://127.0.0.1:${port}/health`;
    try { await fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(2000) }); } catch (e) { diag.probe = e?.name === 'TimeoutError' ? 'other' : 'none'; return; } // rien ne répond
    try { diag.probe = (await (await fetch(url, { signal: AbortSignal.timeout(2000) })).json())?.app === 'xbs-mcp' ? 'ours' : 'other'; } catch { diag.probe = 'other'; } // quelque chose répond : notre serveur ?
  }
  function disconnect() { clearInterval(pingTimer); clearTimeout(retryTimer); try { ws?.close(); } catch { /* déjà fermée */ } ws = null; connecting = false; index = null; indexModel = ''; }
  function scheduleRetry() { clearTimeout(retryTimer); retryTimer = setTimeout(connect, 8000); }

  chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) connect(); });
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.settings) { const o = ch.settings.oldValue?.mcp, n = ch.settings.newValue?.mcp; if (o?.on !== n?.on || o?.port !== n?.port || o?.token !== n?.token) { disconnect(); connect(); } } });
  connect();
  return { status: () => ({ connected: !!ws, indexed: index ? index.tweets.length : 0, diag: { ...diag, ageSec: diag.at ? Math.round((Date.now() - diag.at) / 1000) : null } }) };
}
