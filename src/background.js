import { putTweets, putVideos, putHistory, putTranscript, markNoTranscript, pendingTranscriptIds, reconcilePlaylist, playlistCounts, counts, setMeta, getMeta, getAllTweetKeys, deleteTweets } from './lib/db.js';
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
  return { enrichLinks: s.enrichLinks && hasPerm, imageSearch: s.imageSearch, embedModel: s.embedModel, compute: s.compute, indexMode: s.indexMode, trPassages: s.ytTrPassages, threads: s.threads };
}

// run = demande explicite de l'utilisateur (bouton « Indexer »). En mode manuel, rien ne démarre sans elle :
// ni au lancement du navigateur, ni sur l'alarme, ni à l'arrivée de nouveaux tweets.
// indexMode « soft » : indexation automatique par petites tranches (au plus une toutes les 4 min, jamais au lancement du navigateur).
const SOFT_LIMIT = 600; // textes par tranche
let lastSoft = 0;
async function kickIndexing(run = false, force = false) {
  const s = await getSettings();
  let limit;
  if (!run && s.indexMode === 'soft') {
    if (Date.now() - lastSoft < 4 * 60_000) return;
    lastSoft = Date.now(); run = true; limit = SOFT_LIMIT;
  } else if (!run && s.indexMode !== 'auto') return;
  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: 'off:index', run, force, limit, config: await getConfig() }).catch(() => {});
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

chrome.runtime.onInstalled.addListener(async () => { if ((await getSettings()).indexMode === 'auto') kickIndexing(); });
chrome.runtime.onStartup.addListener(async () => { if ((await getSettings()).indexMode === 'auto') kickIndexing(); }); // « soft » : pas d'indexation au lancement
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

// ---------------- « Tout mettre à jour » : X, playlists, historique, transcriptions, puis indexation ----------------
const waiters = [];
const waitMsg = (match, timeoutMs) => new Promise((resolve) => {
  const w = { match, resolve };
  waiters.push(w);
  setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); resolve(null); } }, timeoutMs);
});
const settle = (msg) => { for (let k = waiters.length - 1; k >= 0; k--) if (waiters[k].match(msg)) { const [w] = waiters.splice(k, 1); w.resolve(msg); } };

let updating = false, updateStop = false;
const YT_AUTO_EVERY = 3 * 3600_000; // en automatique, YouTube au plus toutes les 3 h (X : à chaque cycle)
const updProgress = (step, label, extra = {}) => broadcast({ type: 'updateProgress', step, label, ...extra });

async function updateAll({ manual }) {
  if (updating) return { ok: false, reason: 'busy' };
  const s = await getSettings();
  updating = true; updateStop = false;
  const report = { x: null, playlists: null, history: null, transcripts: null };
  try {
    // 1) X : nouveaux bookmarks
    updProgress('x', 'X : nouveaux bookmarks…');
    const { withRequest, likely } = await findCaptureTab();
    if (manual || withRequest || likely || s.autoTabs) {
      const wait = waitMsg((m) => m.type === 'backfillProgress' && ['done', 'stopped', 'error'].includes(m.state), 20 * 60_000);
      const res = await startOrStop({ type: 'startBackfill', mode: 'incremental' });
      if (res.ok) { const m = await wait; report.x = m?.state === 'done' ? m.total : null; } else if (manual) report.x = 'impossible';
      if (res.ok) await setMeta('lastSyncAt', Date.now());
    }
    if (updateStop) return finishUpdate(report, 'stopped');

    // 2) YouTube : playlists, historique, transcriptions (en automatique : au plus toutes les 3 h)
    const lastYt = (await getMeta('lastYtAutoAt')) || 0;
    if (manual || Date.now() - lastYt > YT_AUTO_EVERY) {
      if (!manual && !s.autoTabs) return finishUpdate(report, 'done');
      // historique et transcriptions : à part (gros retards à rattraper), sauf si tu les inclus dans ⚙
      const steps = [
        ['playlists', 'YouTube : nouvelles vidéos des playlists…', 'new'],
        ...(s.updHistory ? [['history', 'YouTube : historique…', 'history']] : []),
        ...(s.updTranscripts ? [['transcripts', 'YouTube : transcriptions des nouvelles vidéos…', 'transcripts']] : []),
      ];
      for (const [key, label, mode] of steps) {
        if (updateStop) return finishUpdate(report, 'stopped');
        updProgress(key, label);
        const wait = waitMsg((m) => m.type === 'ytProgress' && ['done', 'error', 'stopped'].includes(m.state) && !!m.history === (mode === 'history') && !!m.transcripts === (mode === 'transcripts'), 3 * 3600_000);
        const res = await ytStart(mode, { limit: manual ? 300 : 50 });
        if (!res.ok) { if (res.reason !== 'nothing-to-do') report[key] = 'impossible'; continue; }
        const m = await wait;
        report[key] = m?.state === 'done' ? (m.total ?? m.ok ?? 0) : m?.state === 'error' ? 'erreur' : null;
      }
      await setMeta('lastYtAutoAt', Date.now());
    }
    // 3) indexation
    if (s.indexMode === 'soft' || s.indexMode === 'auto' || manual) {
      updProgress('index', 'Indexation…');
      await ensureOffscreen();
      chrome.runtime.sendMessage({ type: 'off:index', run: true, limit: s.indexMode === 'auto' && !manual ? undefined : (manual ? 2000 : SOFT_LIMIT), config: await getConfig() }).catch(() => {});
      lastSoft = Date.now();
    }
    return finishUpdate(report, 'done');
  } catch (e) {
    return finishUpdate(report, 'error', String(e?.message || e));
  }
}
function finishUpdate(report, state, message) {
  updating = false;
  setMeta('lastUpdateAt', Date.now());
  updProgress('end', state === 'done' ? 'Mise à jour terminée' : state === 'stopped' ? 'Mise à jour arrêtée' : 'Mise à jour : ' + (message || 'erreur'), { state, report });
  return { ok: state !== 'error', state, report };
}

// Mise à jour automatique toutes les 30 min (X d'abord ; YouTube, transcriptions et indexation ensuite).
async function autoSync() {
  const s = await getSettings();
  if (!s.autoSync) return;
  const last = (await getMeta('lastUpdateAt')) || 0;
  if (Date.now() - last < (SYNC_EVERY_MIN - 2) * 60_000) return;
  updateAll({ manual: false });
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

async function ytStart(mode, opts = {}) {
  let ids, counts;
  if (mode === 'new') counts = await playlistCounts();
  if (mode === 'transcripts') {
    ids = (await pendingTranscriptIds((await getSettings()).ytTranscripts, opts.limit || (await getSettings()).ytTrBatch || 100000)).map((id) => id.slice(3));
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
    try { await chrome.tabs.sendMessage(tab.id, { type: 'ytStart', mode, ids, counts, speed: mode === 'transcripts' ? (await getSettings()).ytTrSpeed : undefined, days: mode === 'history' ? (await getSettings()).ytHistoryDays : undefined }); return { ok: true }; }
    catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  return { ok: false, reason: 'no-content-script' };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'backfillProgress' || msg?.type === 'ytProgress') settle(msg);
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
      putVideos(items).then((added) => { if (added) { broadcast({ type: 'tweetsAdded', added }); kickIndexing(); } broadcast({ type: 'tweetsUpdated' }); sendResponse({ fresh: added }); }, () => sendResponse({ fresh: null }));
      return true;
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
    case 'q:updateAll': { updateAll({ manual: true }).then(sendResponse); return true; }
    case 'q:updateStop': {
      updateStop = true;
      chrome.tabs.query({ url: ['https://www.youtube.com/*', ...X_TABS] }).then((tabs) => { for (const t of tabs) { chrome.tabs.sendMessage(t.id, { type: 'ytStop' }).catch(() => {}); chrome.tabs.sendMessage(t.id, { type: 'stopBackfill' }).catch(() => {}); } sendResponse({ ok: true }); });
      return true;
    }
    case 'q:updateStatus': { sendResponse({ updating }); return false; }
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
