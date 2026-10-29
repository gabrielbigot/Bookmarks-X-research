// Pont MCP : met l'index de l'extension à disposition d'un client MCP (Claude Desktop, Claude Code…) qui tourne sur la même machine.
// L'extension se connecte (WebSocket, 127.0.0.1 uniquement) au petit serveur `mcp/server.mjs` que le client MCP a lancé ; le serveur lui
// transmet les appels d'outils, l'extension répond avec sa propre recherche. Rien n'est copié ailleurs. Lecture seule. Désactivé par défaut.
import { Index } from './lib/search.js';
import { fullLoad, refresh } from './lib/store.js';
import { getSettings } from './lib/settings.js';
import { modelOf } from './lib/models.js';
import { getMeta, getTranscripts, playlistCatalog } from './lib/db.js';
import { markBulkAdded } from './lib/ytdate.js';
import { createTools } from './lib/mcp.js';

const ALARM = 'xbs-mcp';
const IDLE_DROP_MS = 15 * 60_000; // l'index en mémoire est relâché après 15 min sans appel
const REFRESH_EVERY_MS = 20_000;

export function startBridge({ embed }) {
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

  const tools = createTools({
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
    try {
      const sock = new WebSocket(`ws://127.0.0.1:${s.port || 47821}/xbs`);
      sock.onopen = () => { ws = sock; connecting = false; sock.send(JSON.stringify({ type: 'hello', token: s.token, build: __BUILD__ })); pingTimer = setInterval(() => { try { sock.send('{"type":"ping"}'); } catch { /* fermée */ } }, 20_000); };
      sock.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m.id !== undefined && m.method) onRequest(m); };
      const closed = () => { clearInterval(pingTimer); if (ws === sock) ws = null; connecting = false; scheduleRetry(); };
      sock.onclose = closed;
      sock.onerror = () => { connecting = false; };
    } catch { connecting = false; scheduleRetry(); }
  }
  function disconnect() { clearInterval(pingTimer); clearTimeout(retryTimer); try { ws?.close(); } catch { /* déjà fermée */ } ws = null; connecting = false; index = null; indexModel = ''; }
  function scheduleRetry() { clearTimeout(retryTimer); retryTimer = setTimeout(connect, 8000); }

  chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) connect(); });
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.settings) { const o = ch.settings.oldValue?.mcp, n = ch.settings.newValue?.mcp; if (JSON.stringify(o) !== JSON.stringify(n)) { disconnect(); connect(); } } });
  connect();
  return { status: () => ({ connected: !!ws, indexed: index ? index.tweets.length : 0 }) };
}
