// Exécuté dans le monde "MAIN" de x.com : intercepte les réponses GraphQL des bookmarks
// et sait rejouer la dernière requête pour remonter tout l'historique (pagination par curseur).
import { parseBookmarksResponse } from './lib/parse.js';

const TAG = 'xbs';
const BOOKMARKS_RE = /\/graphql\/[^/]+\/Bookmarks(\?|$)/;
let lastReq = null; // { url, headers }
let lastCursor = null;
let backfill = { running: false, stop: false };

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
    const { tweets, cursorBottom } = parseBookmarksResponse(json);
    lastCursor = cursorBottom;
    if (tweets.length) post('tweets', { tweets });
    return { count: tweets.length, cursor: cursorBottom };
  } catch (e) {
    post('error', { message: 'parse: ' + e.message });
    return { count: 0, cursor: null };
  }
}

const origFetch = window.fetch;
window.fetch = async function (input, init) {
  const res = await origFetch.apply(this, arguments);
  try {
    const url = typeof input === 'string' ? input : input?.url;
    if (url && BOOKMARKS_RE.test(url)) {
      lastReq = { url, headers: { ...headersToObject(input instanceof Request ? input.headers : null), ...headersToObject(init?.headers) } };
      res.clone().json().then(handle).catch(() => {});
    }
  } catch {}
  return res;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runBackfill() {
  if (backfill.running) return;
  if (!lastReq) {
    post('backfill', { state: 'need-page', message: 'Ouvre la page Bookmarks de X, puis relance la synchro.' });
    return;
  }
  backfill = { running: true, stop: false };
  let cursor = lastCursor;
  let pages = 0, total = 0, empty = 0;
  post('backfill', { state: 'running', pages, total });
  try {
    while (cursor && !backfill.stop && pages < 2000) {
      const u = new URL(lastReq.url, location.origin);
      const vars = JSON.parse(u.searchParams.get('variables') || '{}');
      vars.cursor = cursor;
      u.searchParams.set('variables', JSON.stringify(vars));
      const res = await origFetch(u.toString(), { headers: lastReq.headers, credentials: 'include' });
      if (res.status === 429) {
        post('backfill', { state: 'rate-limited', pages, total, message: 'X limite le débit. Réessaie dans ~15 min.' });
        return;
      }
      if (!res.ok) {
        post('backfill', { state: 'error', pages, total, message: `HTTP ${res.status}` });
        return;
      }
      const { count, cursor: next } = handle(await res.json());
      pages++;
      total += count;
      empty = count === 0 ? empty + 1 : 0;
      post('backfill', { state: 'running', pages, total });
      if (!next || next === cursor || empty >= 2) break;
      cursor = next;
      await sleep(1500 + Math.random() * 2000); // rythme "humain"
    }
    post('backfill', { state: backfill.stop ? 'stopped' : 'done', pages, total });
  } catch (e) {
    post('backfill', { state: 'error', pages, total, message: e.message });
  } finally {
    backfill.running = false;
  }
}

window.addEventListener('message', (ev) => {
  if (ev.source !== window || ev.data?.src !== TAG + '-ctl') return;
  if (ev.data.type === 'start') runBackfill();
  if (ev.data.type === 'stop') backfill.stop = true;
  if (ev.data.type === 'status') post('status', { hasRequest: !!lastReq, running: backfill.running });
});
