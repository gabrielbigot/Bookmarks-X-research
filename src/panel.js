import { getAllTweets, getAllVectors, counts } from './lib/db.js';
import { Index, DIM, parseQuery, rrf, highlightTerms, normalizeText, contentWords } from './lib/search.js';
import { decodeEntities, semanticQuery } from './lib/text.js';
import { interpret, findAuthors } from './lib/nlq.js';

const $ = (id) => document.getElementById(id);
const embed = new URLSearchParams(location.search).has('embed');
const PAGE = 40;

const index = new Index();
let seq = 0; // numéro de la recherche en cours (évite les rendus périmés)
let shown = PAGE;
let last = { rows: [], terms: [], label: '' };
const qCache = new Map();

// ---------- chargement ----------
const sortKey = (t) => (t.sortIndex || '').padStart(24, '0');

async function load() {
  const [tweets, vecs] = await Promise.all([getAllTweets(), getAllVectors()]);
  tweets.sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : -1)); // plus récemment bookmarké d'abord
  index.build(tweets, vecs);
  updateStats();
  run();
}

function updateStats(extra = '') {
  const n = index.tweets.length, v = index.vectorCount();
  $('stats').textContent = `${n.toLocaleString('fr-FR')} bookmarks · ${v.toLocaleString('fr-FR')} indexés sémantiquement${extra} · build ${typeof __BUILD__ === 'string' ? __BUILD__ : 'dev'}`;
}

// ---------- recherche ----------
async function embedQuery(text) {
  if (qCache.has(text)) return qCache.get(text);
  const res = await chrome.runtime.sendMessage({ type: 'q:embed', text });
  if (!res || res.error) throw new Error(res?.error || 'pas de réponse');
  const v = Float32Array.from(res.vec);
  qCache.set(text, v);
  if (qCache.size > 50) qCache.delete(qCache.keys().next().value);
  return v;
}

let ignoreAuthor = false;

async function run() {
  const my = ++seq;
  const raw = $('q').value.trim();
  const parsed = parseQuery(raw);
  let { text } = parsed;
  const filters = { ...parsed.filters };
  shown = PAGE;

  // Langage naturel : « le tweet le plus vieux d'OpenAI » -> tri par date + filtre auteur.
  const nl = interpret(text);
  let sort = nl.sort;
  let authors = [];
  if (nl.author && !ignoreAuthor) {
    authors = findAuthors(index.tweets, nl.author.token);
    if (authors.length && authors.length <= 15) {
      filters.fromAny = authors.map((a) => a.handle.toLowerCase());
      text = nl.text.replace(nl.author.phrase.trim(), ' ');
    } else authors = [];
  }
  if (!authors.length) text = sort ? nl.text : text; // le tri est retiré du texte, pas l'auteur non résolu
  text = text.replace(/\s+/g, ' ').trim();
  const allowed = index.allowedMask(filters);

  const meta = { sort, authors };
  const byDate = (rows) => [...rows].sort((a, b) => {
    const x = index.tweets[a[0]].createdAt || '', y = index.tweets[b[0]].createdAt || '';
    return sort === 'oldest' ? (x < y ? -1 : 1) : (x < y ? 1 : -1);
  });

  // Aucun mot utile : on liste (récents d'abord, ou triés par date si demandé).
  if (!text || contentWords(text) === 0) {
    let rows = [];
    for (let i = 0; i < index.tweets.length; i++) if (!allowed || allowed[i]) rows.push([i, 0]);
    if (sort) rows = byDate(rows);
    rows = rows.slice(0, 2000);
    last = { rows, terms: [], label: raw ? 'Filtres appliqués' : 'Derniers bookmarks', meta };
    return render();
  }

  const terms = highlightTerms(text);
  const kw = index.bm25(text, allowed);
  last = { rows: kw, terms, label: 'Mots-clés (la recherche sémantique arrive…)', meta: { ...meta, sort: null } };
  render();

  let rows = kw, label;
  if (!index.vectorCount()) {
    label = 'Mots-clés uniquement — aucun tweet indexé sémantiquement pour l’instant';
  } else {
    try {
      const qv = await embedQuery(semanticQuery(text));
      if (my !== seq) return;
      const sem = index.vector(qv, allowed);
      // Phrase libre (≥ 3 mots utiles) : on se fie davantage au sens qu'aux mots exacts.
      const long = contentWords(text) >= 3;
      rows = rrf([sem, kw], long ? [1.5, 0.7] : [1, 1]);
      label = 'Hybride : sémantique + mots-clés';
    } catch (e) {
      if (my !== seq) return;
      label = 'Mots-clés uniquement (modèle indisponible : ' + e.message + ')';
    }
  }
  if (sort) { // « le plus vieux … » : on trie par date les 40 résultats les plus pertinents
    rows = byDate(rows.slice(0, 40));
    label += ` · ${sort === 'oldest' ? 'du plus ancien au plus récent' : 'du plus récent au plus ancien'} parmi les 40 plus pertinents`;
  }
  last = { rows, terms, label, meta };
  render();
}

function similarTo(row) {
  const t = index.tweets[row];
  if (!index.hasVec[row]) return;
  const qv = index.matrix.subarray(row * DIM, (row + 1) * DIM);
  const rows = index.vector(qv, null, 60).filter(([r]) => r !== row);
  seq++;
  shown = PAGE;
  last = { rows, terms: [], meta: {}, label: `Similaires à @${t.handle} : « ${t.text.slice(0, 60).replace(/\s+/g, ' ')}… »` };
  render();
  window.scrollTo({ top: 0 });
}

// ---------- rendu (façon X) ----------
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function hl(text, terms) {
  const safe = esc(text);
  if (!terms.length || !text) return safe;
  // On surligne sur le texte normalisé (sans accents) en conservant les positions.
  const norm = normalizeText(text);
  if (norm.length !== text.length) return safe;
  const re = new RegExp('(' + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')[a-z0-9]*', 'g');
  let out = '', pos = 0, m;
  while ((m = re.exec(norm))) {
    out += esc(text.slice(pos, m.index)) + '<mark>' + esc(text.slice(m.index, m.index + m[0].length)) + '</mark>';
    pos = m.index + m[0].length;
  }
  return out + esc(text.slice(pos));
}

const TOKEN = /(https?:\/\/[^\s]+)|(@[A-Za-z0-9_]{1,15})|(#[\p{L}\p{N}_]+)/gu;
const shortUrl = (u) => { const t = u.replace(/^https?:\/\/(www\.)?/, ''); return t.length > 30 ? t.slice(0, 29) + '…' : t; };

// Liens, @mentions, #hashtags cliquables + surlignage de la recherche.
function richText(raw, terms) {
  const text = decodeEntities(raw);
  let out = '', pos = 0, m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) {
    out += hl(text.slice(pos, m.index), terms);
    const tok = m[0];
    if (m[1]) {
      const url = tok.replace(/[.,;:!?)\]]+$/, '');
      out += `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(shortUrl(url))}</a>` + esc(tok.slice(url.length));
    } else if (m[2]) out += `<a href="https://x.com/${esc(tok.slice(1))}" target="_blank" rel="noopener">${esc(tok)}</a>`;
    else out += `<a href="https://x.com/hashtag/${encodeURIComponent(tok.slice(1))}" target="_blank" rel="noopener">${esc(tok)}</a>`;
    pos = m.index + tok.length;
  }
  return out + hl(text.slice(pos), terms);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('fr-FR', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtNum(n) {
  if (!n) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',') + ' M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace('.', ',') + ' k';
  return String(n);
}

const ICON = {
  reply: 'M1.75 10.5c0-4.14 3.36-7.5 7.5-7.5h5.5a7.5 7.5 0 0 1 0 15h-1.44L9 21.4v-3.47a7.5 7.5 0 0 1-7.25-7.43zm7.5-5.5a5.5 5.5 0 0 0-.25 11v2.7l3.7-2.7h2.3a5.5 5.5 0 0 0 0-11z',
  repost: 'M4.75 3.79l4.6 4.37-1.38 1.45-2.22-2.1V16.5c0 .55.45 1 1 1H13v2H6.75a3 3 0 0 1-3-3V7.5L1.5 9.61.12 8.16zm14.5 16.42l-4.6-4.37 1.38-1.45 2.22 2.1V7.5c0-.55-.45-1-1-1H11v-2h6.25a3 3 0 0 1 3 3v9l2.25-2.11 1.38 1.45z',
  like: 'M16.7 4C14.9 4 13.3 4.9 12 6.5 10.7 4.9 9.1 4 7.3 4 4.4 4 2 6.4 2 9.5c0 5 6.5 9.6 9.4 11.2.4.2.8.2 1.2 0C15.5 19.1 22 14.5 22 9.5 22 6.4 19.6 4 16.7 4zm-4.7 14.7C9 16.9 4 12.9 4 9.5 4 7.5 5.4 6 7.3 6c1.6 0 3 1 3.7 2.8h2c.7-1.8 2.1-2.8 3.7-2.8 1.9 0 3.3 1.5 3.3 3.5 0 3.4-5 7.4-8 9.2z',
  views: 'M8.75 21V3h2v18zM18.75 21V8.5h2V21zM13.5 21v-8h2v8zM4 21v-4h2v4z',
  bookmark: 'M4 4.5C4 3.12 5.12 2 6.5 2h11C18.88 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71zm2.5-.5a.5.5 0 0 0-.5.5v14.56l6-4.29 6 4.29V4.5a.5.5 0 0 0-.5-.5z',
};
const stat = (cls, icon, n) => `<span class="ic ${cls}"><svg viewBox="0 0 24 24"><path d="${ICON[icon]}"/></svg>${fmtNum(n)}</span>`;

function mediaHtml(media) {
  const items = media.slice(0, 4);
  if (!items.length) return '';
  const cells = items.map((m) => {
    const alt = m.alt ? `<span class="alt">ALT</span>` : '';
    if ((m.type === 'video' || m.type === 'animated_gif') && m.video) {
      const gif = m.type === 'animated_gif';
      return `<div class="m"><video ${gif ? 'autoplay loop muted' : 'controls'} playsinline preload="none" poster="${esc(m.url)}" src="${esc(m.video)}"></video></div>`;
    }
    const play = m.type === 'video' || m.type === 'animated_gif' ? '<div class="play"><i></i></div>' : '';
    const ratio = items.length === 1 && m.w && m.h ? ` style="aspect-ratio:${m.w}/${m.h}"` : '';
    return `<div class="m"${ratio}><img loading="lazy" src="${esc(m.url)}" alt="${esc(m.alt || '')}">${play}${alt}</div>`;
  });
  return `<div class="md n${items.length}">${cells.join('')}</div>`;
}

const avatarUrl = (u) => (u ? u.replace('_normal.', '_bigger.') : '');

function card([row], terms) {
  const t = index.tweets[row];
  const el = document.createElement('article');
  el.className = 'tw';
  const st = t.stats || {};
  el.innerHTML = `
    <img class="av" loading="lazy" src="${esc(avatarUrl(t.avatar))}" alt="">
    <div class="bd">
      <div class="hd">
        <a class="nm" href="https://x.com/${esc(t.handle)}" target="_blank" rel="noopener">${esc(t.name || t.handle)}</a>
        <span class="hn">@${esc(t.handle)}</span><span>·</span>
        <a href="${esc(t.url)}" target="_blank" rel="noopener">${fmtDate(t.createdAt)}</a>
      </div>
      <div class="tx">${richText(t.text, terms)}</div>
      ${mediaHtml(t.media || [])}
      ${t.quoted ? `<div class="qt" data-url="${esc(t.quoted.url || '')}">
        <div class="hd"><span class="nm">${esc(t.quoted.name || t.quoted.handle)}</span><span class="hn">@${esc(t.quoted.handle)}</span></div>
        <div class="tx">${richText(t.quoted.text, terms)}</div></div>` : ''}
      <div class="ac">
        ${stat('', 'reply', st.replies)}${stat('rp', 'repost', st.reposts)}${stat('lk', 'like', st.likes)}${stat('', 'views', st.views)}${stat('', 'bookmark', st.bookmarks)}
        ${index.hasVec[row] ? '<button class="ghost sim">≈ Similaires</button>' : ''}
      </div>
    </div>`;
  // Comme sur X : un clic sur la carte ouvre le tweet (sauf liens, vidéos, boutons).
  el.addEventListener('click', (e) => {
    if (e.target.closest('a,button,video')) return;
    const q = e.target.closest('.qt');
    window.open(q?.dataset.url || t.url, '_blank', 'noopener');
  });
  el.querySelector('.sim')?.addEventListener('click', () => similarTo(row));
  return el;
}

function render() {
  const box = $('results');
  box.replaceChildren();
  const modeEl = $('mode');
  modeEl.textContent = last.label + (last.rows.length ? ` — ${last.rows.length >= 200 ? '200+' : last.rows.length} résultats` : '');
  const au = last.meta?.authors;
  if (au?.length) {
    const b = document.createElement('button');
    b.className = 'ghost';
    b.textContent = `Auteur : ${au.slice(0, 3).map((a) => '@' + a.handle).join(', ')}${au.length > 3 ? '…' : ''} ✕ retirer`;
    b.onclick = () => { ignoreAuthor = true; run(); };
    modeEl.append(' ', b);
  }
  if (!last.rows.length) {
    box.innerHTML = `<div class="empty">${index.tweets.length ? 'Aucun résultat.' : 'Aucun bookmark capturé pour l’instant.<br>Ouvre x.com/i/bookmarks, puis clique « ⟳ Tout synchroniser ».'}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of last.rows.slice(0, shown)) frag.appendChild(card(r, last.terms));
  box.appendChild(frag);
  if (last.rows.length > shown) {
    const b = document.createElement('button');
    b.className = 'ghost moreb';
    b.textContent = 'Voir plus';
    b.onclick = () => { shown += PAGE; render(); };
    box.appendChild(b);
  }
}

// ---------- événements ----------
let timer;
$('q').addEventListener('input', () => { ignoreAuthor = false; clearTimeout(timer); timer = setTimeout(run, 120); });

$('sync').onclick = async () => {
  $('progress').textContent = 'Démarrage (un onglet X s’ouvre en arrière-plan si besoin)…';
  const res = await chrome.runtime.sendMessage({ type: 'startBackfill' });
  if (!res?.ok) $('progress').textContent = 'Impossible de démarrer : vérifie que tu es connecté à X, puis réessaie.';
};
$('stop').onclick = () => chrome.runtime.sendMessage({ type: 'stopBackfill' });

if (embed) {
  document.body.classList.add('embed');
  $('close').hidden = false;
  $('close').onclick = () => parent.postMessage({ xbs: 'close' }, '*');
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') parent.postMessage({ xbs: 'close' }, '*'); });
  window.addEventListener('message', (e) => { if (e.data?.xbs === 'focus') $('q').focus(); });
}

let reloadTimer, lastHeavy = 0;
const scheduleReload = (delay = 3000) => { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, delay); };

chrome.runtime.onMessage.addListener((m) => {
  switch (m.type) {
    case 'tweetsAdded': scheduleReload(); break;
    case 'indexProgress':
      if (Date.now() - lastHeavy > 60000) { lastHeavy = Date.now(); scheduleReload(500); }
      pollStatus();
      break;
    case 'indexDone': scheduleReload(500); pollStatus(); break;
    case 'indexError': case 'modelProgress': pollStatus(); break;
    case 'backfillProgress': {
      const running = m.state === 'running';
      $('stop').hidden = !running;
      $('sync').hidden = running;
      $('progress').textContent = { running: `Synchro : ${m.total} tweets lus`, done: `Synchro terminée (${m.total})`, stopped: 'Synchro arrêtée' }[m.state] || m.message || '';
      break;
    }
  }
});

async function pollStatus() {
  try {
    const st = await chrome.runtime.sendMessage({ type: 'q:status' });
    const el = $('index');
    el.classList.toggle('err', st?.model === 'error' || (!!st?.error && !st?.indexing));
    $('retry').hidden = !(st?.error);
    if (!st) return;
    if (st.error) el.textContent = 'Recherche sémantique indisponible : ' + st.error;
    else if (st.model === 'loading') el.textContent = `Recherche sémantique : téléchargement du modèle ${st.pct ?? 0}% (une seule fois, ~300 Mo)…`;
    else if (st.indexing) el.textContent = `Recherche sémantique : indexation ${st.done}/${st.total}${st.device ? ' (' + st.device + ')' : ''}…`;
    else if (st.model === 'ready') el.textContent = 'Recherche sémantique prête' + (st.device ? ' (' + st.device + ')' : '');
    else el.textContent = '';
  } catch {}
}
$('retry').onclick = () => { chrome.runtime.sendMessage({ type: 'q:index', force: true }); setTimeout(pollStatus, 500); };
setInterval(pollStatus, 2500);
pollStatus();

load().then(() => chrome.runtime.sendMessage({ type: 'q:index' }).catch(() => {}));
