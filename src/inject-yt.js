// Monde « MAIN » de youtube.com : capture les réponses « youtubei/v1/browse » des playlists (passif) et sait remonter
// toute une playlist (WL = « À regarder plus tard », LL = « J'aime », et celles de l'utilisateur) par pagination.
import { parseYoutube, parseHistoryHeader } from './lib/youtube.js';

const TAG = 'xbs-yt';
const BROWSE_RE = /\/youtubei\/v1\/browse(\?|$)/;
const post = (type, data = {}) => window.postMessage({ src: TAG, type, ...data }, '*');
const origFetch = window.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const contMap = new Map(); // jeton de pagination -> id de playlist (les suites n'indiquent pas la playlist)
const titles = new Map(); // id de playlist -> titre
let currentRun = null, busy = false, stopFlag = false;
const histConts = new Set(); // jetons de pagination de l'historique
const waiters = new Map(); // nonce -> résolution de l'accusé de réception (nombre de nouveaux visionnages)
let nonceN = 0;
let listCont = null; // pagination de la liste des playlists (/feed/playlists)
const known = new Map(); // playlists découvertes (id -> {id,title,count})
const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const listParam = () => new URLSearchParams(location.search).get('list');

// Interprète une réponse. `body` = corps de la requête (browseId / continuation) ou null.
function handle(json, body) {
  let r;
  const hist = body?.browseId === 'FEhistory' || (body?.continuation && histConts.has(body.continuation)) || (!body && location.pathname === '/feed/history');
  if (hist) return handleHistory(json);
  try { r = parseYoutube(json); } catch (e) { post('error', { message: 'lecture : ' + e.message }); return null; }
  let pid = null;
  const bid = body?.browseId;
  if (typeof bid === 'string' && bid.startsWith('VL')) pid = bid.slice(2);
  else if (body?.continuation && contMap.has(body.continuation)) pid = contMap.get(body.continuation);
  else if (!body?.continuation && location.pathname === '/playlist') pid = listParam();
  if (r.header?.id) pid = pid || r.header.id;
  if (pid && r.header?.title) titles.set(pid, r.header.title);
  if (r.continuation) { if (pid) contMap.set(r.continuation, pid); else if (r.playlists.length) listCont = r.continuation; }
  if (r.playlists.length) {
    for (const p of r.playlists) known.set(p.id, { ...known.get(p.id), ...p });
    post('playlists', { playlists: r.playlists });
  }
  // On ne garde les vidéos QUE dans le contexte d'une playlist connue (jamais les recommandations de l'accueil).
  if (r.videos.length && pid) post('videos', { videos: r.videos, playlist: { id: pid, title: titles.get(pid) || '' }, runId: currentRun });
  if (r.unparsed && !r.videos.length) post('warn', { unparsed: r.unparsed });
  return { ...r, pid };
}

// Historique : vidéos groupées par jour. Chaque capture reçoit un accusé du service worker (nombre de nouveaux couples vidéo/jour).
function handleHistory(json) {
  let r;
  try { r = parseYoutube(json, { history: true }); } catch (e) { post('error', { message: 'lecture historique : ' + e.message }); return null; }
  if (r.continuation) histConts.add(r.continuation);
  const days = new Map();
  const videos = r.videos.map((v) => { if (!days.has(v.label)) days.set(v.label, parseHistoryHeader(v.label)); return { ...v, day: days.get(v.label) }; });
  const nonce = ++nonceN;
  if (videos.length) post('history', { videos, runId: currentRun, nonce });
  if (r.unparsed && !videos.length) post('warn', { unparsed: r.unparsed });
  const known = videos.map((v) => v.day).filter(Boolean).sort();
  return { ...r, videos, hist: true, nonce, oldestDay: known[0] || null, unknownDays: videos.some((v) => !v.day) };
}
const ackP = (nonce) => new Promise((res) => { waiters.set(nonce, res); setTimeout(() => { if (waiters.delete(nonce)) res(null); }, 20000); });

// ---- interception passive ----
window.fetch = function (input, init) {
  let bodyP = null;
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (url && BROWSE_RE.test(url)) {
      if (typeof init?.body === 'string') bodyP = Promise.resolve(init.body);
      else if (input instanceof Request) bodyP = input.clone().text().catch(() => null); // avant que fetch ne consomme le corps
    }
  } catch {}
  const resP = origFetch.apply(this, arguments);
  if (bodyP) resP.then((res) => { res.clone().json().then(async (j) => handle(j, safeJson(await bodyP))).catch(() => {}); }).catch(() => {});
  return resP;
};

// Données de la page chargée directement (ytInitialData) : première page d'une playlist / de la liste des playlists.
let lastInitial = null;
function readInitial() {
  const d = window.ytInitialData;
  if (!d || d === lastInitial) return;
  lastInitial = d;
  const pid = location.pathname === '/playlist' ? listParam() : null;
  handle(d, pid ? { browseId: 'VL' + pid } : null);
}
for (const ev of ['DOMContentLoaded', 'load', 'yt-navigate-finish']) window.addEventListener(ev, () => setTimeout(readInitial, 300));
document.readyState !== 'loading' && setTimeout(readInitial, 300);

// ---- appels « browse » à nous (synchronisation) ----
const cfg = (k) => { try { return window.ytcfg?.get?.(k) ?? window.ytcfg?.data_?.[k]; } catch { return undefined; } };

async function sapisidHash() {
  const m = /(?:^|;\s*)(?:__Secure-3PAPISID|SAPISID)=([^;]+)/.exec(document.cookie);
  if (!m) return null;
  const ts = Math.floor(Date.now() / 1000);
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${ts} ${m[1]} ${location.origin}`));
  return `SAPISIDHASH ${ts}_${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

class HttpError extends Error { constructor(status) { super(`HTTP ${status}`); this.status = status; } }

async function browse(body) {
  const context = cfg('INNERTUBE_CONTEXT');
  if (!context) throw new Error('contexte YouTube introuvable (ytcfg)');
  const key = cfg('INNERTUBE_API_KEY');
  const headers = {
    'content-type': 'application/json', 'x-origin': location.origin, 'x-goog-authuser': String(cfg('SESSION_INDEX') ?? 0),
    'x-youtube-client-name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') ?? 1), 'x-youtube-client-version': cfg('INNERTUBE_CLIENT_VERSION') || context.client?.clientVersion || '',
  };
  const visitor = cfg('VISITOR_DATA'); if (visitor) headers['x-goog-visitor-id'] = visitor;
  const auth = await sapisidHash(); if (auth) headers.authorization = auth;
  const res = await origFetch(`/youtubei/v1/browse?prettyPrint=false${key ? '&key=' + encodeURIComponent(key) : ''}`, { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ context, ...body }) });
  if (!res.ok) throw new HttpError(res.status);
  return { json: await res.json(), body };
}

const progress = (state, extra = {}) => post('sync', { state, runId: currentRun, ...extra });

// Remonte une playlist page par page. Retourne { count, complete }.
async function syncPlaylist(pid, title, label) {
  let body = { browseId: 'VL' + pid }, count = 0, pages = 0, gotAny = false;
  titles.set(pid, title || titles.get(pid) || '');
  while (body && !stopFlag && pages < 400) {
    const { json } = await browse(body);
    const r = handle(json, body);
    pages++;
    if (r) { count += r.videos.length; if (r.videos.length || r.header) gotAny = true; }
    progress('running', { playlist: label, pages, count });
    body = r?.continuation ? { continuation: r.continuation } : null;
    if (body) await sleep(1000 + Math.random() * 1500); // rythme « humain »
  }
  // « complète » seulement si on a bien lu quelque chose (une page d'erreur muette ne doit rien effacer)
  return { count, complete: !stopFlag && gotAny && !body };
}

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// Remonte l'historique jusqu'à `days` jours (0 = tout) ; s'arrête si 2 pages de suite n'apportent rien de nouveau.
async function runHistory(days) {
  if (busy) return;
  busy = true; stopFlag = false; currentRun = String(Date.now());
  const cutoff = days > 0 ? ymd(new Date(Date.now() - days * 864e5)) : null;
  let body = { browseId: 'FEhistory' }, pages = 0, count = 0, fresh = 0, idle = 0, day = null, gotAny = false;
  progress('running', { history: true, pages: 0, count: 0 });
  try {
    while (body && !stopFlag && pages < 600) {
      const { json } = await browse(body);
      const r = handle(json, body);
      pages++;
      if (!r) break;
      count += r.videos.length; if (r.videos.length) gotAny = true;
      if (r.oldestDay) day = r.oldestDay;
      const n = r.videos.length ? await ackP(r.nonce) : 0;
      if (n === null) idle = 0; else { fresh += n; idle = n === 0 ? idle + 1 : 0; }
      progress('running', { history: true, pages, count, day });
      if (idle >= 2) break; // on a rejoint ce qu'on connaissait déjà
      if (cutoff && r.oldestDay && r.oldestDay < cutoff) break;
      body = r.continuation ? { continuation: r.continuation } : null;
      if (body) await sleep(1000 + Math.random() * 1500);
    }
    if (!gotAny && !stopFlag) progress('error', { message: 'Historique vide ou illisible (historique de visionnage désactivé sur ton compte YouTube ?).' });
    else progress(stopFlag ? 'stopped' : 'done', { history: true, total: count, fresh });
  } catch (e) {
    const forbidden = e instanceof HttpError && (e.status === 401 || e.status === 403);
    progress('error', { message: forbidden ? `YouTube a refusé la requête (${e.message}) : ouvre youtube.com/feed/history et défile, les vidéos seront capturées au passage.` : e.message });
  } finally {
    busy = false; currentRun = null;
  }
}

async function listUserPlaylists() {
  // Les playlists de l'utilisateur sont lues sur /feed/playlists (données initiales + pagination).
  readInitial();
  let cont = listCont, guard = 0;
  while (cont && !stopFlag && guard++ < 50) {
    const { json, body } = await browse({ continuation: cont });
    const r = handle(json, body);
    cont = r?.continuation || null;
    await sleep(800 + Math.random() * 800);
  }
  return [...known.values()].filter((p) => p.id && p.id !== 'WL' && p.id !== 'LL');
}

async function runSync(mode) {
  if (busy) return;
  busy = true; stopFlag = false; currentRun = String(Date.now());
  progress('running', { message: 'Préparation…', pages: 0, count: 0 });
  try {
    let lists = [];
    if (mode === 'current') {
      const pid = location.pathname === '/playlist' ? listParam() : null;
      if (!pid) { progress('error', { message: 'Ouvre d’abord une playlist (page « /playlist »).' }); return; }
      lists = [{ id: pid, title: titles.get(pid) || document.title.replace(/ - YouTube$/, '') }];
    } else {
      lists = [{ id: 'WL', title: 'À regarder plus tard' }, { id: 'LL', title: 'Vidéos que j’aime' }, ...(await listUserPlaylists())];
    }
    let total = 0, doneLists = 0, incomplete = 0;
    for (const l of lists) {
      if (stopFlag) break;
      progress('running', { playlist: l.title, pages: 0, count: total, lists: lists.length, listIndex: doneLists + 1 });
      const r = await syncPlaylist(l.id, l.title, l.title);
      total += r.count; doneLists++;
      if (!r.complete) incomplete++;
      post('sync', { state: 'playlist-done', runId: currentRun, playlistId: l.id, complete: r.complete, count: r.count });
      await sleep(500);
    }
    progress(stopFlag ? 'stopped' : 'done', { total, lists: lists.length, incomplete });
  } catch (e) {
    const forbidden = e instanceof HttpError && (e.status === 401 || e.status === 403);
    progress('error', { message: forbidden ? `YouTube a refusé la requête (${e.message}) : ouvre la playlist et défile jusqu’en bas, les vidéos seront capturées au passage.` : e.message });
  } finally {
    busy = false; currentRun = null;
  }
}

// Synchro « toutes les playlists » demandée depuis une autre page : on navigue, puis on reprend.
const PENDING = 'xbs-yt-pending';
function startAll() {
  if (location.pathname !== '/feed/playlists') {
    try { sessionStorage.setItem(PENDING, 'all'); } catch {}
    location.assign('/feed/playlists');
    return;
  }
  runSync('all');
}
window.addEventListener('load', () => {
  try { if (sessionStorage.getItem(PENDING) === 'all' && location.pathname === '/feed/playlists') { sessionStorage.removeItem(PENDING); setTimeout(() => runSync('all'), 1500); } } catch {}
});

window.addEventListener('message', (ev) => {
  if (ev.source !== window || ev.data?.src !== TAG + '-ctl') return;
  const d = ev.data;
  if (d.type === 'histAck') { const w = waiters.get(d.nonce); if (w) { waiters.delete(d.nonce); w(d.fresh ?? null); } }
  if (d.type === 'start' && d.mode === 'history') runHistory(d.days ?? 90);
  else if (d.type === 'start') (d.mode === 'current' ? runSync('current') : startAll());
  if (d.type === 'stop') stopFlag = true;
  if (d.type === 'ping') post('pong', { path: location.pathname, ready: !!cfg('INNERTUBE_CONTEXT'), busy });
});
console.info('[xbs] capture YouTube active');
