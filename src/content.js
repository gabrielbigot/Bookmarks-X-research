// Monde isolé : relaie les tweets capturés vers l'extension, et affiche un bouton + overlay de recherche
// directement sur la page Bookmarks de X.
const TAG = 'xbs';
const isBookmarksPage = () => location.pathname.startsWith('/i/bookmarks');
const send = (msg) => { try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch {} };

window.addEventListener('message', (ev) => {
  if (ev.source !== window || ev.data?.src !== TAG) return;
  const d = ev.data;
  if (d.type === 'tweets') send({ type: 'captured', tweets: d.tweets });
  else if (d.type === 'backfill') { send({ ...d, type: 'backfillProgress' }); setStatus(d); }
  else if (d.type === 'error') console.warn('[xbs]', d.message);
});

const ctl = (type) => window.postMessage({ src: TAG + '-ctl', type }, '*');

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'startBackfill') ctl('start');
  if (msg.type === 'stopBackfill') ctl('stop');
});

// ---------- UI sur la page ----------
let host, shadow, pill, statusEl, overlay;

function setStatus(d) {
  if (!statusEl) return;
  const labels = {
    running: `Synchro… ${d.total} tweets (${d.pages} pages)`,
    done: `Synchro terminée (${d.total} tweets lus)`,
    stopped: 'Synchro arrêtée',
    'rate-limited': d.message,
    'need-page': d.message,
    error: 'Erreur : ' + d.message,
  };
  statusEl.textContent = labels[d.state] || '';
}

function buildUi() {
  host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;left:16px;bottom:16px;';
  shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      .pill{display:flex;gap:6px;align-items:center;font:13px system-ui,sans-serif;background:#0f1419;color:#fff;border:1px solid #2f3336;border-radius:999px;padding:6px 8px;box-shadow:0 4px 18px #0006}
      button{all:unset;cursor:pointer;padding:5px 10px;border-radius:999px;background:#1d9bf0;color:#fff;font-weight:600}
      button.sec{background:#2f3336}
      button:hover{filter:brightness(1.15)}
      .st{opacity:.75;max-width:260px;padding:0 6px}
      .ov{position:fixed;inset:0;background:#000a;display:none;align-items:flex-start;justify-content:center;padding-top:4vh}
      .ov.on{display:flex}
      iframe{width:min(860px,94vw);height:88vh;border:1px solid #2f3336;border-radius:16px;background:#fff}
    </style>
    <div class="pill">
      <button id="open" title="Alt+K">🔎 Recherche intelligente</button>
      <button id="sync" class="sec" title="Remonte tout l'historique en arrière-plan">⟳ Tout synchroniser</button>
      <span class="st" id="st"></span>
    </div>
    <div class="ov" id="ov"></div>`;
  statusEl = shadow.getElementById('st');
  overlay = shadow.getElementById('ov');
  shadow.getElementById('open').onclick = toggleOverlay;
  shadow.getElementById('sync').onclick = () => { statusEl.textContent = 'Démarrage…'; ctl('start'); };
  overlay.onclick = (e) => { if (e.target === overlay) toggleOverlay(false); };
  document.documentElement.appendChild(host);
}

function toggleOverlay(force) {
  const on = typeof force === 'boolean' ? force : !overlay.classList.contains('on');
  overlay.classList.toggle('on', on);
  if (on) {
    overlay.innerHTML = `<iframe src="${chrome.runtime.getURL('panel.html')}?embed=1" allow="clipboard-write"></iframe>`;
    overlay.querySelector('iframe').addEventListener('load', () => overlay.querySelector('iframe').contentWindow?.postMessage({ xbs: 'focus' }, '*'));
  } else overlay.innerHTML = '';
}

window.addEventListener('keydown', (e) => {
  if (!isBookmarksPage()) return;
  if (e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); toggleOverlay(); }
  if (e.key === 'Escape' && overlay?.classList.contains('on')) toggleOverlay(false);
}, true);
window.addEventListener('message', (e) => { if (e.data?.xbs === 'close') toggleOverlay(false); });

function sync() {
  if (isBookmarksPage()) {
    if (!host) buildUi();
    else if (!host.isConnected) document.documentElement.appendChild(host);
    host.style.display = '';
  } else if (host) {
    host.style.display = 'none';
    toggleOverlay(false);
  }
}
setInterval(sync, 800); // x.com est une SPA : l'URL change sans rechargement
sync();
