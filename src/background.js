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
        const patterns = X_TABS.map((u) => u.replace('/*', '/i/bookmarks*'));
        let [tab] = await chrome.tabs.query({ url: patterns });
        if (!tab) {
          if (msg.type === 'stopBackfill') return sendResponse({ ok: false });
          tab = await chrome.tabs.create({ url: 'https://x.com/i/bookmarks', active: false });
          await new Promise((resolve) => {
            const onUpd = (id, info) => { if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(onUpd); resolve(); } };
            chrome.tabs.onUpdated.addListener(onUpd);
            setTimeout(resolve, 20000);
          });
        }
        // Le content script peut mettre un instant à être prêt : on réessaie.
        for (let i = 0; i < 10; i++) {
          try { await chrome.tabs.sendMessage(tab.id, { type: msg.type }); return sendResponse({ ok: true }); }
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
