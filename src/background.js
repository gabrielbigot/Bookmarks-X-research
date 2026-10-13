import { putTweets, counts, setMeta } from './lib/db.js';

const PANEL_URL = chrome.runtime.getURL('panel.html');
const X_TABS = ['https://x.com/*', 'https://twitter.com/*'];

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

async function kickIndexing() {
  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: 'off:index' }).catch(() => {});
}

chrome.action.onClicked.addListener(async () => {
  const [existing] = await chrome.tabs.query({ url: PANEL_URL + '*' });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else chrome.tabs.create({ url: PANEL_URL });
});

chrome.runtime.onInstalled.addListener(() => kickIndexing());
chrome.runtime.onStartup.addListener(() => kickIndexing());
chrome.alarms?.create?.('index', { periodInMinutes: 5 });
chrome.alarms?.onAlarm.addListener(() => kickIndexing());

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'captured': {
      putTweets(msg.tweets).then(async (added) => {
        if (added) {
          chrome.runtime.sendMessage({ type: 'tweetsAdded', added }).catch(() => {});
          await setMeta('lastCapture', Date.now());
          kickIndexing();
        }
      });
      return false;
    }
    case 'q:embed': {
      ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({ type: 'off:embedQuery', text: msg.text }))
        .then(sendResponse, (e) => sendResponse({ error: String(e) }));
      return true;
    }
    case 'q:index': { kickIndexing(); return false; }
    case 'q:counts': { counts().then(sendResponse); return true; }
    case 'startBackfill':
    case 'stopBackfill': {
      (async () => {
        const ping = (t) => chrome.tabs.sendMessage(t.id, { type: 'ping' }).then((r) => ({ t, r }), () => null);
        const find = async () => {
          const tabs = await chrome.tabs.query({ url: X_TABS });
          const rs = (await Promise.all(tabs.map(ping))).filter(Boolean);
          return rs.find((x) => x.r?.hasRequest)?.t || rs.find((x) => x.r?.likely)?.t || null;
        };
        let tab = await find();
        if (!tab) {
          if (msg.type === 'stopBackfill') return sendResponse({ ok: false });
          tab = await chrome.tabs.create({ url: 'https://x.com/i/bookmarks', active: false });
          // On attend que X ait chargé la page et fait sa requête Bookmarks (30 s max).
          for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            const got = await ping(tab);
            if (got?.r?.hasRequest) break;
          }
        }
        for (let i = 0; i < 10; i++) {
          try { await chrome.tabs.sendMessage(tab.id, { type: msg.type }); return sendResponse({ ok: true, url: tab.url }); }
          catch { await new Promise((r) => setTimeout(r, 1000)); }
        }
        sendResponse({ ok: false, reason: 'no-content-script' });
      })();
      return true;
    }
    case 'q:openBookmarks': {
      chrome.tabs.create({ url: 'https://x.com/i/bookmarks' });
      return false;
    }
  }
  return false;
});
