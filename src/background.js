import { putTweets, counts, setMeta, getMeta, getAllTweetKeys, deleteTweets } from './lib/db.js';
import { getSettings } from './lib/settings.js';

const PANEL_URL = chrome.runtime.getURL('panel.html');
const X_TABS = ['https://x.com/*', 'https://twitter.com/*'];
const runs = new Map(); // runId -> Set(ids vus pendant une synchro complète)
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
async function kickIndexing(force = false) {
  await ensureOffscreen();
  const s = await getSettings();
  const hasPerm = await chrome.permissions.contains({ origins: ['https://*/*', 'http://*/*'] }).catch(() => false);
  chrome.runtime.sendMessage({
    type: 'off:index',
    force,
    config: { enrichLinks: s.enrichLinks && hasPerm, imageSearch: s.imageSearch, embedModel: s.embedModel },
  }).catch(() => {});
}

const broadcast = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

chrome.action.onClicked.addListener(async () => {
  const [existing] = await chrome.tabs.query({ url: PANEL_URL + '*' });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else chrome.tabs.create({ url: PANEL_URL });
});

chrome.runtime.onInstalled.addListener(() => kickIndexing());
chrome.runtime.onStartup.addListener(() => kickIndexing());
chrome.alarms.create('index', { periodInMinutes: 5 });
chrome.alarms.create('autosync', { periodInMinutes: SYNC_EVERY_MIN });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'autosync') autoSync();
  else kickIndexing();
});
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.settings) kickIndexing(true); });

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
  const keys = await getAllTweetKeys();
  const orphans = keys.filter((id) => !seen.has(id));
  if (orphans.length && orphans.length <= Math.max(5, keys.length * 0.3)) {
    await setMeta('orphans', orphans);
    broadcast({ type: 'orphans', count: orphans.length });
  } else await setMeta('orphans', []);
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
    case 'parseWarning': {
      setMeta('parseWarning', { at: Date.now(), unparsed: msg.unparsed, parsed: msg.parsed, ops: msg.ops });
      broadcast({ type: 'parseWarning' });
      return false;
    }
    case 'q:embed': {
      ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({ type: 'off:embedQuery', text: msg.text, kind: msg.kind }))
        .then(sendResponse, (e) => sendResponse({ error: String(e) }));
      return true;
    }
    case 'q:index': { kickIndexing(!!msg.force); return false; }
    case 'q:status': {
      ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({ type: 'off:status' }))
        .then(sendResponse, (e) => sendResponse({ model: 'error', error: String(e) }));
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
