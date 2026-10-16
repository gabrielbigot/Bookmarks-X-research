import { syncSummary } from './lib/youtube.js';
// Monde isolé de youtube.com : relaie vers l'extension et affiche une petite pastille de synchronisation.
const TAG = 'xbs-yt';
const send = (msg) => { try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch {} };
const ctl = (type, extra = {}) => window.postMessage({ src: TAG + '-ctl', type, ...extra }, '*');
let statusEl, host, lastPong = 0, ready = false, lastPath = '';

window.addEventListener('message', (ev) => {
  if (ev.source !== window || ev.data?.src !== TAG) return;
  const d = ev.data;
  if (d.type === 'videos') chrome.runtime.sendMessage({ type: 'ytCaptured', videos: d.videos, playlist: d.playlist, runId: d.runId }).then((r) => ctl('vidAck', { nonce: d.nonce, fresh: r?.fresh ?? null }), () => ctl('vidAck', { nonce: d.nonce, fresh: null }));
  else if (d.type === 'history') chrome.runtime.sendMessage({ type: 'ytHistory', videos: d.videos, runId: d.runId }).then((r) => ctl('histAck', { nonce: d.nonce, fresh: r?.fresh ?? null }), () => ctl('histAck', { nonce: d.nonce, fresh: null }));
  else if (d.type === 'transcript') send({ type: 'ytTranscript', id: d.id, state: d.state, chunks: d.chunks });
  else if (d.type === 'playlists') send({ type: 'ytPlaylists', playlists: d.playlists });
  else if (d.type === 'sync') { send({ ...d, type: 'ytProgress' }); showStatus(d); }
  else if (d.type === 'diag') send({ type: 'ytDiag', item: { playlistId: d.playlistId, title: d.title, count: d.count, expected: d.expected, pages: d.pages, alt: d.alt, shape: d.shape } });
  else if (d.type === 'warn') send({ type: 'parseWarning', src: 'youtube', unparsed: d.unparsed, parsed: 0, ops: [] });
  else if (d.type === 'error') console.warn('[xbs-yt]', d.message);
  else if (d.type === 'pong') { lastPong = Date.now(); ready = d.ready; lastPath = d.path; }
});

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === 'ytStart') ctl('start', { mode: msg.mode, days: msg.days, ids: msg.ids, speed: msg.speed, counts: msg.counts, excluded: msg.excluded });
  if (msg.type === 'ytStop') ctl('stop');
  if (msg.type === 'ytPing') { ctl('ping'); setTimeout(() => sendResponse({ ready, path: lastPath, alive: Date.now() - lastPong < 1500 }), 250); return true; }
});

function showStatus(d) {
  if (!statusEl) return;
  const t = {
    running: d.transcripts ? `Transcriptions : ${d.done}/${d.total} (${d.ok} récupérées${d.last ? ' ; ' + d.last : ''})…` : d.history ? `Historique : ${d.count ?? 0} visionnages lus${d.day ? ` (jusqu’au ${d.day})` : ''}…` : `${d.playlist ? d.playlist + ' — ' : ''}${d.count ?? 0} vidéos${d.lists ? ` (${d.listIndex}/${d.lists} playlists)` : ''}…`,
    done: d.transcripts ? `Transcriptions terminées : ${d.ok} récupérées, ${d.none} sans transcription${d.fail ? `, ${d.fail} en échec` : ''}${d.reasons ? ' — ' + d.reasons : ''}` : d.history ? `Historique terminé : ${d.total} lus` : `Terminé : ${syncSummary(d)}`,
    stopped: 'Synchro arrêtée', error: '⚠ ' + (d.message || 'erreur'),
  }[d.state];
  if (t) statusEl.textContent = t;
}

function build() {
  host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;left:16px;bottom:16px;';
  const sh = host.attachShadow({ mode: 'closed' });
  sh.innerHTML = `<style>
    .pill{display:flex;gap:6px;align-items:center;font:13px system-ui,sans-serif;background:#0f0f0f;color:#fff;border:1px solid #303030;border-radius:999px;padding:6px 8px;box-shadow:0 4px 18px #0006}
    button{all:unset;cursor:pointer;padding:5px 10px;border-radius:999px;background:#ff0033;color:#fff;font-weight:600}
    button.sec{background:#303030}button:hover{filter:brightness(1.15)}.st{opacity:.8;max-width:300px;padding:0 6px}
  </style><div class="pill"><button id="all" title="Remonte WL, J'aime et toutes tes playlists">▶ Mes playlists</button><button id="cur" class="sec" title="Synchronise la playlist affichée">Cette playlist</button><button id="open" class="sec" title="Ouvrir la recherche">🔎</button><button id="hist" class="sec" title="Remonte ton historique de visionnage">Historique</button><span class="st" id="st"></span></div>`;
  statusEl = sh.getElementById('st');
  sh.getElementById('all').onclick = () => { statusEl.textContent = 'Démarrage…'; ctl('start', { mode: 'all' }); };
  sh.getElementById('cur').onclick = () => { statusEl.textContent = 'Démarrage…'; ctl('start', { mode: 'current' }); };
  sh.getElementById('hist').onclick = () => { statusEl.textContent = 'Démarrage…'; chrome.storage.local.get('settings').then((x) => ctl('start', { mode: 'history', days: x.settings?.ytHistoryDays ?? 90 })); };
  sh.getElementById('open').onclick = () => send({ type: 'q:openPanel' });
  document.documentElement.appendChild(host);
}

// Pastille uniquement sur les pages de playlists / bibliothèque (YouTube est une SPA : on surveille l'URL).
const relevant = () => location.pathname === '/playlist' || location.pathname.startsWith('/feed/');
setInterval(() => {
  if (relevant()) { if (!host) build(); else if (!host.isConnected) document.documentElement.appendChild(host); host.style.display = ''; }
  else if (host) host.style.display = 'none';
}, 800);
