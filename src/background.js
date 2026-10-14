import { putTweets, putVideos, putHistory, putTranscript, markNoTranscript, pendingTranscriptIds, reconcilePlaylist, counts, setMeta, getMeta, getAllTweetKeys, deleteTweets } from './lib/db.js';
import { toItem, toHistoryItem } from './lib/youtube.js';
import { getSettings } from './lib/settings.js';

const PANEL_URL = chrome.runtime.getURL('panel.html');
const X_TABS = ['https://x.com/*', 'https://twitter.com/*'];
const runs = new Map(); // runId -> Set(ids vus pendant une synchro complète)
const ytRuns = new Map(); // runId -> Map(playlistId -> Set(ids de vidéos vues))
let ytAutoTab = null; // onglet YouTube ouvert par nous (fermé à la fin)
const SYNC_EVERY_MIN = 30;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Calcul local des embeddings (modèle ONNX) pour la recherche sémantique',
    });
  } catch (e) {
    if (!/single offscreen/i.test(String(e))) throw e;
  }
}

// L'offscreen n'a pas accès à chrome.storage / chrome.permissions : on lui transmet la config.
async function getConfig() {
  const s = await getSettings();
  const hasPerm = await chrome.permissions.contains({ origins: ['https://*/*', 'http://*/*'] }).catch(() => false);
  return { enrichLinks: s.enrichLinks && hasPerm, imageSearch: s.imageSearch, embedModel: s.embedModel, compute: s.compute, indexMode: s.indexMode, trPassages: s.ytTrPassages };
}

// run = demande explicite de l'utilisateur (bouton « Indexer »). En mode manuel, rien ne démarre sans elle :
// ni au lancement du navigateur, ni sur l'alarme, ni à l'arrivée de nouveaux tweets.
async function kickIndexing(run = false, force = false) {
  const s = await getSettings();
  if (!run && s.indexMode !== 'auto') return;
  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: 'off:index', run, force, config: await getConfig() }).catch(() => {});
}

const broadcast = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

async function openPanelTab() {
  const [existing] = await chrome.tabs.query({ url: PANEL_URL + '*' });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else chrome.tabs.create({ url: PANEL_URL });
}
chrome.action.onClicked.addListener(openPanelTab);

chrome.runtime.onInstalled.addListener(() => kickIndexing());
chrome.runtime.onStartup.addListener(() => kickIndexing());
chrome.alarms.create('index', { periodInMinutes: 5 });
chrome.alarms.create('autosync', { periodInMinutes: SYNC_EVERY_MIN });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'autosync') autoSync();
  else kickIndexing();
});
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.settings) kickIndexing(false); });

// ---- onglet X qui a réellement capturé la requête Bookmarks ----
async function findCaptureTab() {
  const ping = (t) => chrome.tabs.sendMessage(t.id, { type: 'ping' }).then((r) => ({ t, r }), () => null);
  const tabs = await chrome.tabs.query({ url: X_TABS });
  const rs = (await Promise.all(tabs.map(ping))).filter(Boolean);
  return { withRequest: rs.find((x) => x.r?.hasRequest)?.t || null, likely: rs.find((x) => x.r?.likely)?.t || null, ping };
}

// Synchro des nouveautés automatique, sans jamais ouvrir d'onglet de sa propre initiative.
async function autoSync() {
  const s = await getSettings();
  if (!s.autoSync) return;
  const last = (await getMeta('lastSyncAt')) || 0;
  if (Date.now() - last < (SYNC_EVERY_MIN - 2) * 60_000) return;
  const { withRequest } = await findCaptureTab();
  if (!withRequest) return;
  await setMeta('lastSyncAt', Date.now());
  chrome.tabs.sendMessage(withRequest.id, { type: 'startBackfill', mode: 'incremental' }).catch(() => {});
}

async function startOrStop(msg) {
  const { withRequest, likely, ping } = await findCaptureTab();
  let tab = withRequest || likely;
  if (!tab) {
    if (msg.type === 'stopBackfill') return { ok: false };
    tab = await chrome.tabs.create({ url: 'https://x.com/i/bookmarks', active: false });
    // On attend que X ait chargé la page et fait sa requête Bookmarks (30 s max).
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const got = await ping(tab);
      if (got?.r?.hasRequest) break;
    }
  }
  for (let i = 0; i < 10; i++) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: msg.type, mode: msg.mode });
      if (msg.type === 'startBackfill') await setMeta('lastSyncAt', Date.now());
      return { ok: true, url: tab.url };
    } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  return { ok: false, reason: 'no-content-script' };
}

// Bookmarks qui n'existent plus sur X : détectés à la fin d'une synchro complète (jamais supprimés sans confirmation).
async function detectOrphans(runId) {
  const seen = runs.get(runId);
  runs.delete(runId);
  if (!seen || !seen.size) return;
  const keys = (await getAllTweetKeys()).filter((id) => !id.startsWith('yt:')); // les vidéos YouTube ne relèvent pas de la synchro X
  const ytOrphans = ((await getMeta('orphans')) || []).filter((id) => id.startsWith('yt:'));
  const orphans = keys.filter((id) => !seen.has(id));
  const keep = orphans.length && orphans.length <= Math.max(5, keys.length * 0.3) ? orphans : [];
  await setMeta('orphans', [...keep, ...ytOrphans]);
  if (keep.length) broadcast({ type: 'orphans', count: keep.length + ytOrphans.length });
}

// ---------------- YouTube ----------------
async function ytReconcile(msg) {
  const seen = ytRuns.get(msg.runId)?.get(msg.playlistId);
  // Garde-fou : si l'état en mémoire a été perdu (redémarrage du service worker), on n'efface RIEN.
  if (!seen || !seen.size || seen.size < (msg.count || 0) * 0.9) return;
  const orphans = await reconcilePlaylist(msg.playlistId, seen);
  if (orphans.length) {
    const cur = (await getMeta('orphans')) || [];
    await setMeta('orphans', [...new Set([...cur, ...orphans])]);
    broadcast({ type: 'orphans', count: orphans.length });
  }
}

async function ytStart(mode) {
  let ids;
  if (mode === 'transcripts') {
    ids = (await pendingTranscriptIds((await getSettings()).ytTranscripts, (await getSettings()).ytTrBatch || 100000)).map((id) => id.slice(3));
    if (!ids.length) return { ok: false, reason: 'nothing-to-do' };
  }
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  const ping = (t) => chrome.tabs.sendMessage(t.id, { type: 'ytPing' }).then((r) => ({ t, r }), () => null);
  let tab = null;
  if (mode === 'current') { // la playlist affichée dans un onglet existant
    const rs = (await Promise.all(tabs.map(ping))).filter(Boolean);
    tab = rs.find((x) => x.r?.alive && x.r.path === '/playlist')?.t || null;
    if (!tab) return { ok: false, reason: 'no-playlist-tab' };
  } else {
    // « toutes les playlists » : un onglet DÉDIÉ en arrière-plan (on ne détourne jamais l'onglet où tu regardes une vidéo)
    tab = await chrome.tabs.create({ url: mode === 'history' ? 'https://www.youtube.com/feed/history' : 'https://www.youtube.com/feed/playlists', active: false });
    ytAutoTab = tab.id;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const got = await ping(tab);
      if (got?.r?.alive && got.r.ready) break;
    }
  }
  for (let i = 0; i < 10; i++) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'ytStart', mode, ids, days: mode === 'history' ? (await getSettings()).ytHistoryDays : undefined }); return { ok: true }; }
    catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  return { ok: false, reason: 'no-content-script' };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'captured': {
      if (msg.runId) {
        if (!runs.has(msg.runId)) runs.set(msg.runId, new Set());
        for (const t of msg.tweets) runs.get(msg.runId).add(t.id);
      }
      putTweets(msg.tweets).then(async (added) => {
        if (added) {
          broadcast({ type: 'tweetsAdded', added });
          await setMeta('lastCapture', Date.now());
          kickIndexing();
        }
        sendResponse({ added });
      }, () => sendResponse({ added: null }));
      return true;
    }
    case 'backfillProgress': {
      if (msg.state === 'done' && msg.complete && msg.mode === 'full' && msg.runId) detectOrphans(msg.runId);
      return false;
    }
    case 'ytCaptured': {
      const items = msg.videos.map((v) => toItem(v, msg.playlist));
      if (msg.runId && msg.playlist?.id) {
        if (!ytRuns.has(msg.runId)) ytRuns.set(msg.runId, new Map());
        const m = ytRuns.get(msg.runId);
        if (!m.has(msg.playlist.id)) m.set(msg.playlist.id, new Set());
        for (const it of items) m.get(msg.playlist.id).add(it.id);
      }
      putVideos(items).then((added) => { if (added) { broadcast({ type: 'tweetsAdded', added }); kickIndexing(); } broadcast({ type: 'tweetsUpdated' }); });
      return false;
    }
    case 'ytHistory': {
      const items = msg.videos.map((v) => toHistoryItem(v, v.day || null));
      putHistory(items).then((fresh) => {
        if (fresh) { broadcast({ type: 'tweetsAdded', added: fresh }); kickIndexing(); }
        broadcast({ type: 'tweetsUpdated' }); // des vidéos déjà connues ont pu recevoir un « vu le … »
        sendResponse({ fresh });
      }, () => sendResponse({ fresh: null }));
      return true;
    }
    case 'ytTranscript': {
      (async () => {
        if (msg.state === 'ok' && msg.chunks?.length) await putTranscript(msg.id, msg.chunks);
        else await markNoTranscript([msg.id]);
        broadcast({ type: 'tweetsUpdated' });
        if (msg.state === 'ok') kickIndexing();
      })();
      return false;
    }
    case 'ytPlaylists': {
      getMeta('ytPlaylists').then(async (cur) => {
        const map = new Map(((cur || [])).map((p) => [p.id, p]));
        for (const p of msg.playlists) map.set(p.id, { ...map.get(p.id), ...p });
        await setMeta('ytPlaylists', [...map.values()]);
      });
      return false;
    }
    case 'ytProgress': {
      if (msg.state === 'playlist-done' && msg.complete && msg.runId) ytReconcile(msg);
      if (['done', 'error', 'stopped'].includes(msg.state)) {
        if (msg.runId) setTimeout(() => ytRuns.delete(msg.runId), 60_000);
        if (ytAutoTab !== null) { const id = ytAutoTab; ytAutoTab = null; setTimeout(() => chrome.tabs.remove(id).catch(() => {}), 2500); }
      }
      return false;
    }
    case 'q:ytSync': { ytStart(msg.mode || 'all').then(sendResponse); return true; }
    case 'q:ytStop': {
      chrome.tabs.query({ url: 'https://www.youtube.com/*' }).then((tabs) => { for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'ytStop' }).catch(() => {}); sendResponse({ ok: true }); });
      return true;
    }
    case 'q:openPanel': { openPanelTab(); return false; }
    case 'parseWarning': {
      setMeta('parseWarning', { at: Date.now(), src: msg.src || 'x', unparsed: msg.unparsed, parsed: msg.parsed, ops: msg.ops });
      broadcast({ type: 'parseWarning' });
      return false;
    }
    case 'q:embed': {
      ensureOffscreen()
        .then(async () => chrome.runtime.sendMessage({ type: 'off:embedQuery', text: msg.text, kind: msg.kind, config: await getConfig() }))
        .then(sendResponse, (e) => sendResponse({ error: String(e) }));
      return true;
    }
    case 'q:index': { kickIndexing(!!(msg.run || msg.force), !!msg.force); return false; }
    case 'q:indexStop': {
      ensureOffscreen().then(() => chrome.runtime.sendMessage({ type: 'off:stop' })).then(sendResponse, (e) => sendResponse({ error: String(e) }));
      return true;
    }
    case 'q:status': {
      ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({ type: 'off:status' }))
        .then(sendResponse, (e) => sendResponse({ model: 'error', error: String(e) }));
      return true;
    }
    case 'q:free': {
      ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({ type: 'off:free' }))
        .then(sendResponse, (e) => sendResponse({ error: String(e) }));
      return true;
    }
    case 'q:counts': { counts().then(sendResponse); return true; }
    case 'startBackfill':
    case 'stopBackfill': { startOrStop(msg).then(sendResponse); return true; }
    case 'q:openBookmarks': { chrome.tabs.create({ url: 'https://x.com/i/bookmarks' }); return false; }
    case 'q:orphansDelete': {
      (async () => {
        const ids = (await getMeta('orphans')) || [];
        await deleteTweets(ids);
        await setMeta('orphans', []);
        broadcast({ type: 'tweetsRemoved', count: ids.length });
        sendResponse({ ok: true, count: ids.length });
      })();
      return true;
    }
    case 'q:orphansDismiss': { setMeta('orphans', []).then(() => sendResponse({ ok: true })); return true; }
    case 'q:clearWarning': { setMeta('parseWarning', null).then(() => sendResponse({ ok: true })); return true; }
  }
  return false;
});
