// Monde « MAIN » de youtube.com : capture les réponses « youtubei/v1/browse » des playlists (passif) et sait remonter
// toute une playlist (WL = « À regarder plus tard », LL = « J'aime », et celles de l'utilisateur) par pagination.
import { parseYoutube, parseHistoryHeader, orderLists, incrementalStop, findSortBody, findAnyContinuation, allContinuations, jsonShape } from './lib/youtube.js';
import { findTranscriptParams, learnTemplate, deriveParams, parseTranscript, captionTracks, pickTrack, parseJson3, parseTimedTextXml, chunkSegments } from './lib/transcript.js';

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
// `ord` = { start, base } : la liste lue est triée par date d'ajout (récent d'abord) ; chaque vidéo reçoit une date d'ajout
// estimée « début de la lecture − rang » (le rang suffit à ordonner, la date absolue est approximative).
function handle(json, body, ord) {
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
  const vnonce = ++nonceN;
  if (r.videos.length && pid) post('videos', { videos: ord ? r.videos.map((v, i) => ({ ...v, addAt: ord.start - (ord.base + i) })) : r.videos, playlist: { id: pid, title: titles.get(pid) || '' }, runId: currentRun, nonce: vnonce });
  if (r.unparsed && !r.videos.length) post('warn', { unparsed: r.unparsed });
  return { ...r, pid, nonce: vnonce };
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

class HttpError extends Error { constructor(status, detail = '') { super(`HTTP ${status}${detail ? ' ' + detail : ''}`); this.status = status; } }

const errDetail = async (res) => { try { const j = safeJson(await res.text()); return String(j?.error?.status || j?.error?.message || '').slice(0, 60); } catch { return ''; } };

// Appel « client Android » : contexte minimal, sans cookies ni signature (ce client n'exige pas de jeton PO pour les sous-titres).
async function androidPlayer(videoId) {
  const web = cfg('INNERTUBE_CONTEXT')?.client || {};
  const res = await origFetch('/youtubei/v1/player?prettyPrint=false&key=AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w', {
    method: 'POST', credentials: 'omit',
    headers: { 'content-type': 'application/json', 'x-youtube-client-name': '3', 'x-youtube-client-version': ANDROID.clientVersion },
    body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: ANDROID.clientVersion, androidSdkVersion: 30, osName: 'Android', osVersion: '11', hl: web.hl || 'fr', gl: web.gl || 'FR' } }, videoId, contentCheckOk: true, racyCheckOk: true }),
  });
  if (!res.ok) throw new HttpError(res.status, await errDetail(res));
  return res.json();
}

async function innertube(endpoint, body, { client } = {}) {
  let context = cfg('INNERTUBE_CONTEXT');
  if (!context) throw new Error('contexte YouTube introuvable (ytcfg)');
  if (client && context) { const { clientNumber, ...c } = client; context = { ...context, client: { hl: context.client?.hl, gl: context.client?.gl, ...c } }; }
  const key = cfg('INNERTUBE_API_KEY');
  const headers = {
    'content-type': 'application/json', 'x-origin': location.origin, 'x-goog-authuser': String(cfg('SESSION_INDEX') ?? 0),
    'x-youtube-client-name': String(client ? client.clientNumber : cfg('INNERTUBE_CONTEXT_CLIENT_NAME') ?? 1), 'x-youtube-client-version': client ? client.clientVersion : cfg('INNERTUBE_CLIENT_VERSION') || context.client?.clientVersion || '',
  };
  const visitor = cfg('VISITOR_DATA'); if (visitor) headers['x-goog-visitor-id'] = visitor;
  const auth = await sapisidHash(); if (auth) headers.authorization = auth;
  const res = await origFetch(`/youtubei/v1/${endpoint}?prettyPrint=false${key ? '&key=' + encodeURIComponent(key) : ''}`, { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ context, ...body }) });
  if (!res.ok) throw new HttpError(res.status, await errDetail(res));
  return { json: await res.json(), body };
}

const browse = (body) => innertube('browse', body);
const progress = (state, extra = {}) => post('sync', { state, runId: currentRun, ...extra });

// Remonte une playlist page par page. Retourne { count, complete }.
// Une page qui échoue (réseau, 5xx) est retentée deux fois ; une limite de débit (429) remonte tout de suite.
async function browseRetry(body) {
  for (let a = 0; ; a++) {
    try { return await browse(body); } catch (e) {
      if ((e instanceof HttpError && e.status === 429) || a >= 2 || stopFlag) throw e;
      await sleep(2000 * (a + 1) ** 2);
    }
  }
}
async function syncPlaylist(pid, title, label, incremental = false, expected = 0, ordered = false) {
  const ord = { start: Date.now(), base: 0 }; // ordered : WL et J'aime sont déjà listées par date d'ajout décroissante
  let firstJson = null, sortTried = ordered, sorted = ordered, firstCont = null, sortedBy = ordered ? 'défaut' : '';
  let body = { browseId: 'VL' + pid }, count = 0, pages = 0, gotAny = false, stoppedEarly = false;
  const incState = {};
  let altTokens = 0, lastJson = null, lastPageJson = null, altQueue = [], altTries = 0;
  titles.set(pid, title || titles.get(pid) || '');
  for (let phase = 0; phase < 2; phase++) {
    while (body && !stopFlag && pages < 400) {
      let { json } = await browseRetry(body);
      lastJson = json;
      if (!firstJson) firstJson = json;
      let r = handle(json, body, sorted ? ord : undefined);
      // première page d'une playlist perso (tri « Manuel » par défaut) : on la relit triée par « Date d'ajout (plus récentes) »
      if (!sortTried && pages === 0 && r?.videos.length && !stopFlag) {
        sortTried = true;
        const sb = findSortBody(json, pid);
        if (sb) {
          try {
            if (sb.continuation && pid) contMap.set(sb.continuation, pid);
            const res = await browseRetry(sb);
            const r2 = handle(res.json, sb, { start: ord.start, base: 0 });
            if (r2?.videos.length) { firstCont = r.continuation; json = res.json; r = r2; sorted = true; sortedBy = 'date d’ajout'; ord.base = 0; count = 0; lastJson = res.json; }
            else sortedBy = 'échec : liste vide';
          } catch (e) { if (e instanceof HttpError && e.status === 429) throw e; sortedBy = 'échec : ' + e.message; }
        } else sortedBy = 'menu de tri introuvable';
      }
      if (sorted && r?.videos.length) ord.base += r.videos.length;
      // réponse vide à une requête de page suivante alors qu'il manque des vidéos : on essaie les AUTRES jetons de la page précédente
      if (r && !r.videos.length && !r.continuation && altQueue.length && expected > count + 5 && altTries < 4 && !stopFlag) {
        altTries++;
        body = { continuation: altQueue.shift() };
        await sleep(800);
        continue;
      }
      pages++;
      if (r?.videos.length) { lastPageJson = json; altQueue = allContinuations(json).filter((t) => t !== r.continuation); if (pid) for (const t of altQueue) contMap.set(t, pid); }
      if (r) { count += r.videos.length; if (r.videos.length || r.header) gotAny = true; }
      // la page n'indique pas de suite alors que la playlist en annonce nettement plus : on cherche un jeton ailleurs dans la réponse
      if (r && !r.continuation && r.videos.length && expected > count + 5 && !stopFlag) {
        const alt = findAnyContinuation(json);
        if (alt) { r.continuation = alt; if (pid) contMap.set(alt, pid); altTokens++; }
      }
      progress('running', { playlist: label, pages, count });
      // mise à jour : « À regarder plus tard » et « J'aime » listent le plus récent en premier -> on s'arrête dès qu'une page n'apporte rien de nouveau
      if (incremental && r?.videos.length && incrementalStop(await ackP(r.nonce), incState)) { stoppedEarly = true; body = null; break; }
      body = r?.continuation ? { continuation: r.continuation } : null;
      if (body) await sleep(1000 + Math.random() * 1500); // rythme « humain »
    }
    // la lecture triée s'est arrêtée trop tôt : on reprend la lecture d'origine (ordre manuel) là où la première page la laissait
    if (phase === 0 && sorted && !ordered && firstCont && !stopFlag && !body && !stoppedEarly && expected > 0 && count < expected * 0.9 && expected - count > 5) {
      sorted = false; sortedBy += ' puis ordre manuel (secours)'; body = { continuation: firstCont }; if (pid) contMap.set(firstCont, pid); continue;
    }
    break;
  }
  // « complète » seulement si on a bien lu quelque chose (une page d'erreur muette ne doit rien effacer)
  // « courte » : YouTube a cessé de donner des pages alors que la playlist annonce nettement plus de vidéos
  const short = !stopFlag && !body && !stoppedEarly && expected > 0 && count < expected * 0.9 && expected - count > 5;
  const sortDiag = !ordered && sortedBy !== 'date d’ajout' && firstJson ? JSON.stringify({ tri: sortedBy, premiere: jsonShape(firstJson, { max: 4000 }) }) : '';
  return { count, short, altTokens, sortedBy, sortDiag, shape: short ? JSON.stringify({ derniere: lastJson ? jsonShape(lastJson, { max: 800 }) : '', premiere: lastPageJson ? jsonShape(lastPageJson, { max: 5000 }) : '', essais: altTries }) : '', pages, complete: !stopFlag && gotAny && !body && !stoppedEarly && !short };
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

// ---- transcriptions ----
// 1) panneau « Transcription » de la page vidéo : « next » donne le jeton, « get_transcript » les segments
// 2) sous-titres du lecteur (« player », client web puis client Android) lus via timedtext (json3, sinon XML)
// Retourne { state: 'ok', chunks } | { state: 'none' } (aucune transcription, certain) | { state: 'error' } ; `why` = étapes (diagnostic).
// Lève HttpError sur limite de débit (429).
const ANDROID = { clientName: 'ANDROID', clientVersion: '20.10.38', clientNumber: 3, androidSdkVersion: 30, osName: 'Android', osVersion: '11' };
const rate = (e) => e instanceof HttpError && e.status === 429;

async function trackSegments(track, why, tag) {
  for (const fmt of ['json3', '']) {
    try {
      const u = track.url + (fmt && !/[?&]fmt=/.test(track.url) ? '&fmt=' + fmt : '');
      const res = await origFetch(u, { credentials: tag === 'android' ? 'omit' : 'include' });
      if (!res.ok) { why.push(`${tag}:timedtext-http-${res.status}`); continue; }
      const body = await res.text();
      if (!body) { why.push(`${tag}:timedtext-vide`); continue; }
      const segs = fmt ? parseJson3(safeJson(body)) : parseTimedTextXml(body);
      if (segs.length) return segs;
      why.push(`${tag}:timedtext-illisible`);
    } catch (e) { why.push(`${tag}:timedtext-${e.message}`); }
  }
  return [];
}

const templates = []; // [{ tpl, hits }] modèles de jeton appris (au plus 3 variantes : automatique / manuel / langue)
async function fetchTranscript(videoId) {
  const why = [];
  let segs = [], noPanel = false, noTracks = 0, tried = 0;
  // 1) voie rapide : jeton réécrit depuis un modèle appris (1 requête). Un échec ici ne conclut jamais rien.
  for (const m of [...templates].sort((a, b) => b.hits - a.hits)) {
    const p = deriveParams(m.tpl, videoId);
    if (!p) continue;
    try { segs = parseTranscript((await innertube('get_transcript', { params: p })).json); } catch (e) { if (rate(e)) throw e; }
    if (segs.length) { m.hits++; break; }
  }
  if (!segs.length) try {
    const next = await innertube('next', { videoId });
    const params = findTranscriptParams(next.json);
    if (!params) { noPanel = true; why.push('next:pas-de-panneau'); }
    else {
      const variants = [...new Set([params, /%[0-9A-Fa-f]{2}/.test(params) ? decodeURIComponent(params) : null].filter(Boolean))];
      for (const v of variants) {
        try { segs = parseTranscript((await innertube('get_transcript', { params: v })).json); } catch (e) { if (rate(e)) throw e; why.push('get_transcript:' + e.message); }
        if (segs.length) {
          const tpl = learnTemplate(v, videoId);
          if (tpl && templates.length < 3 && !templates.some((m) => m.tpl.prefix === tpl.prefix && m.tpl.suffix === tpl.suffix)) templates.push({ tpl, hits: 0 });
          break;
        }
      }
      if (!segs.length && !why.some((w) => w.startsWith('get_transcript'))) why.push('get_transcript:vide');
    }
  } catch (e) { if (rate(e)) throw e; why.push('next/get_transcript:' + e.message); }
  if (!segs.length) {
    for (const [tag, client] of [['web', undefined], ['android', ANDROID]]) {
      tried++;
      try {
        const pl = client ? await androidPlayer(videoId) : (await innertube('player', { videoId, contentCheckOk: true, racyCheckOk: true })).json;
        const tracks = captionTracks(pl);
        const st = pl?.playabilityStatus?.status;
        if (!tracks.length) { noTracks++; why.push(`${tag}:aucune-piste${st && st !== 'OK' ? '(' + st + ')' : ''}`); continue; }
        const track = pickTrack(tracks);
        segs = await trackSegments(track, why, tag);
        if (segs.length) break;
      } catch (e) { if (rate(e)) throw e; why.push(`${tag}:${e.message}`); }
    }
  }
  const chunks = chunkSegments(segs);
  if (chunks.length) return { state: 'ok', chunks, why };
  // « sans transcription » seulement si TOUTES les voies disent clairement qu'il n'y en a pas ; sinon c'est une erreur (on ne mémorise rien)
  return { state: noPanel && noTracks === tried ? 'none' : 'error', why };
}

const SPEEDS = { prudent: { conc: 1, min: 1200, max: 3000 }, normal: { conc: 3, min: 300, max: 800 }, rapide: { conc: 6, min: 100, max: 300 } };

// Plusieurs vidéos en parallèle, avec frein automatique : au moindre refus la vitesse retombe à 1 et on marque une pause.
async function runTranscripts(ids, speed = 'normal') {
  if (busy) return;
  busy = true; stopFlag = false; currentRun = String(Date.now());
  const sp = SPEEDS[speed] || SPEEDS.normal;
  let done = 0, ok = 0, none = 0, fail = 0, idx = 0, limit = sp.conc, calm = 0, errRun = 0, pauses = 0, abort = null;
  const reasons = new Map();
  let lastWhy = '';
  const t0 = Date.now();
  progress('running', { transcripts: true, done, total: ids.length, ok });
  const brake = async (why) => {
    limit = 1; calm = 0;
    if (++pauses >= 4) { abort = abort || new Error(why); return; }
    await sleep(45_000); // pause : on laisse YouTube se calmer
  };
  const worker = async (k) => {
    while (!stopFlag && !abort) {
      if (k >= limit) { await sleep(500); continue; }
      const i = idx++;
      if (i >= ids.length) return;
      const id = ids[i];
      try {
        const r = await fetchTranscript(id);
        if (r.state === 'ok') { ok++; errRun = 0; if (++calm >= 60 && limit < sp.conc) { limit++; calm = 0; } }
        else if (r.state === 'none') { none++; errRun = 0; }
        else { fail++; if (++errRun >= 6) { errRun = 0; await brake('échecs répétés'); } }
        if (r.state !== 'ok') { lastWhy = r.why.join(' | '); for (const w of r.why) reasons.set(w, (reasons.get(w) || 0) + 1); }
        if (r.state !== 'error') post('transcript', { id: 'yt:' + id, state: r.state, chunks: r.chunks });
      } catch (e) {
        fail++;
        await brake(e instanceof HttpError ? `YouTube limite les requêtes (${e.message})` : e.message);
      }
      done++;
      progress('running', { transcripts: true, done, total: ids.length, ok, fail, rate: done / Math.max(1, (Date.now() - t0) / 1000), last: ok === 0 && done >= 2 ? lastWhy : '' });
      await sleep(sp.min + Math.random() * (sp.max - sp.min));
    }
  };
  try {
    await Promise.all(Array.from({ length: sp.conc }, (_, k) => worker(k)));
    if (abort) throw abort;
    const top = [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ×${n}`).join(' ; ');
    progress(stopFlag ? 'stopped' : 'done', { transcripts: true, total: ids.length, ok, none, fail, done, reasons: top });
  } catch (e) {
    progress('error', { message: `${e.message} : arrêt de sécurité, réessaie plus tard ou en vitesse « prudente » (ce qui a été récupéré est conservé).`, transcripts: true });
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

async function runSync(mode, counts = {}, excluded = []) {
  const skip = new Set(excluded);
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
      lists = orderLists([{ id: 'WL', title: 'À regarder plus tard' }, { id: 'LL', title: 'Vidéos que j’aime' }, ...(await listUserPlaylists())], counts);
    }
    let total = 0, doneLists = 0, incomplete = 0;
    const problems = [];
    for (const l of lists) {
      if (stopFlag) break;
      progress('running', { playlist: l.title, pages: 0, count: total, lists: lists.length, listIndex: doneLists + 1 });
      if (mode !== 'current' && skip.has(l.id)) { doneLists++; continue; } // playlist décochée : ni lue, ni mise à jour
      const isNew = mode === 'new';
      const recent = l.id === 'WL' || l.id === 'LL';
      // mise à jour : une playlist perso dont le nombre de vidéos n'a pas changé est ignorée
      if (isNew && !recent && l.count > 0 && counts[l.id] === l.count) { doneLists++; continue; }
      let r;
      try { r = await syncPlaylist(l.id, l.title, l.title, isNew && recent, l.count || 0, recent); } catch (e) {
        if (e instanceof HttpError && e.status === 429) throw e; // limite de débit : on arrête tout
        r = { count: 0, complete: false, error: e.message }; // une playlist qui échoue ne bloque pas les suivantes
      }
      total += r.count; doneLists++;
      if (!r.shape && r.sortDiag) post('diag', { playlistId: l.id, title: l.title, count: r.count, expected: l.count || 0, pages: r.pages, alt: 0, shape: r.sortDiag });
      if (r.shape) post('diag', { playlistId: l.id, title: l.title, count: r.count, expected: l.count || 0, pages: r.pages, alt: r.altTokens, shape: r.shape });
      if (!r.complete) { incomplete++; if (r.error || r.short) problems.push({ title: l.title, count: r.count, expected: l.count || 0, diag: !!r.shape, why: r.error || (r.altTokens ? 'la suite renvoyée par YouTube était vide' : 'YouTube n’a pas renvoyé de page suivante') }); }
      post('sync', { state: 'playlist-done', runId: currentRun, playlistId: l.id, complete: r.complete, count: r.count });
      await sleep(500);
    }
    progress(stopFlag ? 'stopped' : 'done', { total, lists: lists.length, incomplete, problems: problems.slice(0, 8) });
  } catch (e) {
    const forbidden = e instanceof HttpError && (e.status === 401 || e.status === 403);
    progress('error', { message: forbidden ? `YouTube a refusé la requête (${e.message}) : ouvre la playlist et défile jusqu’en bas, les vidéos seront capturées au passage.` : e.message });
  } finally {
    busy = false; currentRun = null;
  }
}

// Synchro « toutes les playlists » demandée depuis une autre page : on navigue, puis on reprend.
const PENDING = 'xbs-yt-pending';
function startAll(excluded = [], counts = {}) {
  if (location.pathname !== '/feed/playlists') {
    try { sessionStorage.setItem(PENDING, 'all:' + JSON.stringify({ excluded, counts })); } catch {}
    location.assign('/feed/playlists');
    return;
  }
  runSync('all', counts, excluded);
}
window.addEventListener('load', () => {
  try {
    const pend = sessionStorage.getItem(PENDING);
    if (pend && location.pathname === '/feed/playlists') {
      sessionStorage.removeItem(PENDING);
      if (pend.startsWith('all:')) { const o = safeJson(pend.slice(4)); const ex = Array.isArray(o) ? o : o?.excluded || [], cn = Array.isArray(o) ? {} : o?.counts || {}; setTimeout(() => runSync('all', cn, ex), 1500); }
      else if (pend.startsWith('new:')) { const o = safeJson(pend.slice(4)) || {}; setTimeout(() => runSync('new', o.counts || {}, o.excluded || []), 1500); }
    }
  } catch {}
});

window.addEventListener('message', (ev) => {
  if (ev.source !== window || ev.data?.src !== TAG + '-ctl') return;
  const d = ev.data;
  if (d.type === 'vidAck') { const w = waiters.get(d.nonce); if (w) { waiters.delete(d.nonce); w(d.fresh ?? null); } }
  if (d.type === 'histAck') { const w = waiters.get(d.nonce); if (w) { waiters.delete(d.nonce); w(d.fresh ?? null); } }
  if (d.type === 'start' && d.mode === 'transcripts') runTranscripts(d.ids || [], d.speed);
  else if (d.type === 'start' && d.mode === 'history') runHistory(d.days ?? 90);
  else if (d.type === 'start' && d.mode === 'new') { if (location.pathname !== '/feed/playlists') { try { sessionStorage.setItem(PENDING, 'new:' + JSON.stringify({ counts: d.counts || {}, excluded: d.excluded || [] })); } catch {} location.assign('/feed/playlists'); } else runSync('new', d.counts || {}, d.excluded || []); }
  else if (d.type === 'start') (d.mode === 'current' ? runSync('current') : startAll(d.excluded || [], d.counts || {}));
  if (d.type === 'stop') stopFlag = true;
  if (d.type === 'ping') post('pong', { path: location.pathname, ready: !!cfg('INNERTUBE_CONTEXT'), busy });
});
console.info('[xbs] capture YouTube active');
