// Exécuté dans le monde "MAIN" de x.com : intercepte les réponses GraphQL des bookmarks
// et sait rejouer la dernière requête pour remonter l'historique (pagination par curseur).
import { parseBookmarksResponse } from './lib/parse.js';

const TAG = 'xbs';
const BOOKMARKS_RE = /\/graphql\/[^/]+\/Bookmarks(\?|$)/;
let lastReq = null; // { url, headers }
let lastCursor = null;
let backfill = { running: false, stop: false };
let currentRun = null;
let nonceSeq = 0;
const acks = new Map(); // nonce -> resolve

const post = (type, data = {}) => window.postMessage({ src: TAG, type, ...data }, '*');

function headersToObject(h) {
  const out = {};
  if (!h) return out;
  if (h instanceof Headers) h.forEach((v, k) => (out[k] = v));
  else if (Array.isArray(h)) h.forEach(([k, v]) => (out[k] = v));
  else Object.assign(out, h);
  return out;
}

function handle(json) {
  try {
    const { tweets, cursorBottom, unparsed } = parseBookmarksResponse(json);
    lastCursor = cursorBottom;
    const nonce = ++nonceSeq;
    if (tweets.length) post('tweets', { tweets, nonce, runId: currentRun });
    if (unparsed && unparsed >= tweets.length) post('warn', { unparsed, parsed: tweets.length, ops: [...seenOps] });
    return { count: tweets.length, cursor: cursorBottom, nonce };
  } catch (e) {
    post('error', { message: 'parse: ' + e.message });
    return { count: 0, cursor: null, nonce: 0 };
  }
}

const origFetch = window.fetch;
const note = (url, headers) => { lastReq = { url, headers }; };
const seenOps = new Set(); // diagnostic : opérations GraphQL vues passer
const spy = (url) => { const m = /\/graphql\/[^/]+\/(\w+)/.exec(url || ''); if (m && seenOps.size < 40) seenOps.add(m[1]); };

// X utilise fetch OU XMLHttpRequest selon les versions : on intercepte les deux.
window.fetch = async function (input, init) {
  const res = await origFetch.apply(this, arguments);
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    spy(url);
    if (url && BOOKMARKS_RE.test(url)) {
      note(url, { ...headersToObject(input instanceof Request ? input.headers : null), ...headersToObject(init?.headers) });
      res.clone().json().then(handle).catch(() => {});
    }
  } catch {}
  return res;
};

const XHR = XMLHttpRequest.prototype;
const xOpen = XHR.open, xSet = XHR.setRequestHeader, xSend = XHR.send;
XHR.open = function (method, url) {
  this.__xbs = { url: String(url), headers: {} };
  return xOpen.apply(this, arguments);
};
XHR.setRequestHeader = function (k, v) {
  if (this.__xbs) this.__xbs.headers[k] = v;
  return xSet.apply(this, arguments);
};
XHR.send = function () {
  const info = this.__xbs;
  if (info) spy(info.url);
  if (info && BOOKMARKS_RE.test(info.url)) {
    this.addEventListener('load', () => {
      try {
        note(new URL(info.url, location.origin).href, info.headers);
        const json = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
        handle(json);
      } catch {}
    });
  }
  return xSend.apply(this, arguments);
};
console.info('[xbs] interception fetch + XHR active');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitAck = (nonce) => new Promise((resolve) => {
  if (!nonce) return resolve({ added: null });
  const t = setTimeout(() => { acks.delete(nonce); resolve({ added: null }); }, 6000);
  acks.set(nonce, (a) => { clearTimeout(t); resolve(a); });
});

// mode : 'full' (tout l'historique) ou 'incremental' (s'arrête dès que les pages ne contiennent plus rien de nouveau).
async function runBackfill(mode = 'full') {
  if (backfill.running) return;
  backfill = { running: true, stop: false };
  const base = { mode };
  post('backfill', { ...base, state: 'running', pages: 0, total: 0, message: 'En attente du chargement de la page…' });
  for (let i = 0; i < 50 && !lastReq && !backfill.stop; i++) await sleep(500); // X doit avoir fait sa 1re requête
  if (!lastReq) {
    backfill.running = false;
    post('backfill', { ...base, state: 'need-page', message: 'Aucune requête Bookmarks vue (connecté à X ? page /i/bookmarks ?). Opérations vues : ' + ([...seenOps].join(', ') || 'aucune') });
    return;
  }
  currentRun = `${Date.now()}`;
  const runId = currentRun;
  // On repart toujours du HAUT de la liste (sans curseur) : les nouveautés y sont, et une synchro complète
  // doit voir chaque bookmark pour pouvoir détecter ceux qui ont disparu.
  let cursor = null;
  let first = true;
  let pages = 0, total = 0, empty = 0, stale = 0, complete = false;
  post('backfill', { ...base, runId, state: 'running', pages, total });
  try {
    while ((first || cursor) && !backfill.stop && pages < 2000) {
      const u = new URL(lastReq.url, location.origin);
      const vars = JSON.parse(u.searchParams.get('variables') || '{}');
      if (cursor) vars.cursor = cursor; else delete vars.cursor;
      first = false;
      u.searchParams.set('variables', JSON.stringify(vars));
      const res = await origFetch(u.toString(), { headers: lastReq.headers, credentials: 'include' });
      if (res.status === 429) {
        post('backfill', { ...base, runId, state: 'rate-limited', pages, total, message: 'X limite le débit. Réessaie dans ~15 min.' });
        return;
      }
      if (!res.ok) {
        post('backfill', { ...base, runId, state: 'error', pages, total, message: `HTTP ${res.status}` });
        return;
      }
      const { count, cursor: next, nonce } = handle(await res.json());
      pages++;
      total += count;
      empty = count === 0 ? empty + 1 : 0;
      if (mode === 'incremental' && count) {
        const { added } = await waitAck(nonce); // combien de tweets étaient réellement nouveaux ?
        stale = added === 0 ? stale + 1 : 0;
      }
      post('backfill', { ...base, runId, state: 'running', pages, total });
      if (!next || next === cursor || empty >= 2) { complete = true; break; }
      if (mode === 'incremental' && stale >= 2) { complete = true; break; }
      cursor = next;
      await sleep(1500 + Math.random() * 2000); // rythme "humain"
    }
    post('backfill', { ...base, runId, state: backfill.stop ? 'stopped' : 'done', complete: complete && !backfill.stop, pages, total });
  } catch (e) {
    post('backfill', { ...base, runId, state: 'error', pages, total, message: e.message });
  } finally {
    backfill.running = false;
    currentRun = null;
  }
}

window.addEventListener('message', (ev) => {
  if (ev.source !== window || ev.data?.src !== TAG + '-ctl') return;
  const d = ev.data;
  if (d.type === 'start') runBackfill(d.mode === 'incremental' ? 'incremental' : 'full');
  if (d.type === 'stop') backfill.stop = true;
  if (d.type === 'status') post('status', { hasRequest: !!lastReq, running: backfill.running });
  if (d.type === 'ack') acks.get(d.nonce)?.({ added: d.added });
});
