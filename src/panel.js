import { getAllTweets, getAllVectors, counts } from './lib/db.js';
import { Index, DIM, parseQuery, rrf, highlightTerms, normalizeText } from './lib/search.js';

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
  $('stats').textContent = `${n.toLocaleString('fr-FR')} bookmarks · ${v.toLocaleString('fr-FR')} indexés sémantiquement${extra}`;
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

async function run() {
  const my = ++seq;
  const raw = $('q').value.trim();
  const { text, filters } = parseQuery(raw);
  const allowed = index.allowedMask(filters);
  shown = PAGE;

  if (!text) { // pas de texte : récents (avec filtres éventuels)
    const rows = [];
    for (let i = 0; i < index.tweets.length && rows.length < 2000; i++) if (!allowed || allowed[i]) rows.push([i, 0]);
    last = { rows, terms: [], label: raw ? 'Filtres appliqués' : 'Derniers bookmarks' };
    return render();
  }

  const terms = highlightTerms(text);
  const kw = index.bm25(text, allowed);
  last = { rows: kw, terms, label: 'Mots-clés (la recherche sémantique arrive…)' };
  render();

  if (!index.vectorCount()) {
    last.label = 'Mots-clés uniquement — aucun tweet indexé sémantiquement pour l’instant';
    return render();
  }
  try {
    const qv = await embedQuery(text);
    if (my !== seq) return;
    const sem = index.vector(qv, allowed);
    last = { rows: rrf([sem, kw]), terms, label: 'Hybride : sémantique + mots-clés' };
  } catch (e) {
    if (my !== seq) return;
    last.label = 'Mots-clés uniquement (modèle indisponible : ' + e.message + ')';
  }
  render();
}

function similarTo(row) {
  const t = index.tweets[row];
  if (!index.hasVec[row]) return;
  const qv = index.matrix.subarray(row * DIM, (row + 1) * DIM);
  const rows = index.vector(qv, null, 60).filter(([r]) => r !== row);
  seq++;
  shown = PAGE;
  last = { rows, terms: [], label: `Similaires à @${t.handle} : « ${t.text.slice(0, 60).replace(/\s+/g, ' ')}… »` };
  render();
  window.scrollTo({ top: 0 });
}

// ---------- rendu ----------
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function hl(text, terms) {
  const safe = esc(text);
  if (!terms.length) return safe;
  // On surligne sur le texte normalisé (sans accents) en conservant les positions.
  const norm = normalizeText(text);
  if (norm.length !== text.length) return safe; // cas rare (ligatures) : pas de surlignage
  const re = new RegExp('(' + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')[a-z0-9]*', 'g');
  let out = '', pos = 0, m;
  while ((m = re.exec(norm))) {
    out += esc(text.slice(pos, m.index)) + '<mark>' + esc(text.slice(m.index, m.index + m[0].length)) + '</mark>';
    pos = m.index + m[0].length;
  }
  return out + esc(text.slice(pos));
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function card([row], terms) {
  const t = index.tweets[row];
  const el = document.createElement('article');
  el.className = 'card';
  const media = (t.media || []).slice(0, 4).map((m) => `<img loading="lazy" src="${esc(m.url)}" alt="${esc(m.alt || '')}">`).join('');
  el.innerHTML = `
    <div class="head">
      ${t.avatar ? `<img loading="lazy" src="${esc(t.avatar)}" alt="">` : '<img alt="">'}
      <span><b>${esc(t.name || t.handle)}</b> @${esc(t.handle)} · ${fmtDate(t.createdAt)}</span>
    </div>
    <div class="text">${hl(t.text, terms)}</div>
    ${t.quoted ? `<div class="quote"><b>@${esc(t.quoted.handle)}</b> ${hl(t.quoted.text, terms)}</div>` : ''}
    ${media ? `<div class="media">${media}</div>` : ''}
    <div class="foot">
      <a href="${esc(t.url)}" target="_blank" rel="noopener">Ouvrir sur X ↗</a>
      ${index.hasVec[row] ? '<button class="ghost sim">≈ Similaires</button>' : ''}
      <span>♥ ${t.stats?.likes ?? 0}</span>
    </div>`;
  el.querySelector('.sim')?.addEventListener('click', () => similarTo(row));
  return el;
}

function render() {
  const box = $('results');
  box.replaceChildren();
  $('mode').textContent = last.label + (last.rows.length ? ` — ${last.rows.length >= 200 ? '200+' : last.rows.length} résultats` : '');
  if (!last.rows.length) {
    box.innerHTML = `<div class="empty">${index.tweets.length ? 'Aucun résultat.' : 'Aucun bookmark capturé pour l’instant.<br>Ouvre x.com/i/bookmarks, puis clique « ⟳ Tout synchroniser ».'}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of last.rows.slice(0, shown)) frag.appendChild(card(r, last.terms));
  box.appendChild(frag);
  if (last.rows.length > shown) {
    const b = document.createElement('button');
    b.className = 'ghost more';
    b.textContent = 'Voir plus';
    b.onclick = () => { shown += PAGE; render(); };
    box.appendChild(b);
  }
}

// ---------- événements ----------
let timer;
$('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });

$('sync').onclick = async () => {
  const res = await chrome.runtime.sendMessage({ type: 'startBackfill' });
  if (!res?.ok) {
    $('progress').textContent = 'Ouvre d’abord x.com/i/bookmarks (une page s’ouvre), puis reclique.';
    chrome.runtime.sendMessage({ type: 'q:openBookmarks' });
  }
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
      $('progress').textContent = `Indexation ${m.done}/${m.total}…`;
      if (Date.now() - lastHeavy > 60000) { lastHeavy = Date.now(); scheduleReload(500); }
      break;
    case 'indexDone': $('progress').textContent = ''; scheduleReload(500); break;
    case 'indexError': $('progress').textContent = 'Erreur d’indexation : ' + m.message; break;
    case 'modelProgress':
      $('progress').textContent = m.ready ? 'Modèle prêt' : `Téléchargement du modèle… ${m.pct ?? ''}%`;
      break;
    case 'backfillProgress': {
      const running = m.state === 'running';
      $('stop').hidden = !running;
      $('sync').hidden = running;
      $('progress').textContent = { running: `Synchro : ${m.total} tweets lus`, done: `Synchro terminée (${m.total})`, stopped: 'Synchro arrêtée' }[m.state] || m.message || '';
      break;
    }
  }
});

load().then(() => chrome.runtime.sendMessage({ type: 'q:index' }).catch(() => {}));
