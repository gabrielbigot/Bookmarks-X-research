import { getAllTweets, getMeta, setMeta, putTweets, putVectors, getAllVectors, clearVectors, getAllImgVectors, getAllTranscriptRows, putTranscriptRows, getTranscripts, getAllChunkVecs, applyYtSelection, playlistCatalog } from './lib/db.js';
import { bestChunk, fmtTime } from './lib/transcript.js';
import { detectorScores, detectorSet, slugOf, verdictKey } from './lib/widgets.js';
import { Index, parseQuery, rrf, highlightTerms, normalizeText, contentWords, sortRows as sortRowsBy, selectPool } from './lib/search.js';
import { decodeEntities, semanticQuery } from './lib/text.js';
import { interpret, findAuthors } from './lib/nlq.js';
import { refresh, fullLoad } from './lib/store.js';
import { getSettings, setSettings, llmReady, decisionReady } from './lib/settings.js';
import { MODELS, modelOf } from './lib/models.js';
import { jevIntent, jevRerank, decide, PERIOD_DAYS } from './lib/jev.js';
import { chat, parseJsonLoose, askMessages, digestMessages, intentMessages, rerankMessages, themeNamesMessages, renderMd } from './lib/llm.js';
import { kmeans, labelClusters } from './lib/cluster.js';
import { bindThemeButton } from './lib/theme.js';
import { isVideoItem } from './lib/youtube.js';
import { encode, decodeFull, packVectors, unpackVectors } from './lib/backup.js';
import { score as evalScore, summarize } from './lib/evalbench.js';

const $ = (id) => document.getElementById(id);
const embed = new URLSearchParams(location.search).has('embed');
const PAGE = 40;

const index = new Index();
let activeModel = 'gemma1';
// Applique le modèle choisi dans les réglages : dimension de l'index, caches. Retourne true si quelque chose a changé.
function applyModel() {
  const m = modelOf(settings.embedModel);
  if (activeModel === m.key && index.dim === m.dim) return false;
  activeModel = m.key;
  index.setDim(m.dim);
  imgIndex = null;
  qCache.clear();
  return true;
}
let seq = 0; // numéro de la recherche en cours (évite les rendus périmés)
let shown = PAGE;
let last = { rows: [], terms: [], label: '', meta: {} };
let settings;
const qCache = new Map();
const state = { range: 'all', types: new Set(), sort: 'relevance', ignoreAuthor: false, themeMask: null, themeLabel: '', imageMode: false };
let imgIndex = null; // { ids, matrix }

// ---------- chargement ----------
async function load(full = false) {
  const mid = modelOf(settings.embedModel).id;
  if (full || !index.tweets.length) await fullLoad(index, mid);
  else await refresh(index, mid);
  updateStats();
}

function updateStats() {
  const n = index.tweets.length, v = index.vectorCount();
  const nv = index.tweets.reduce((c, t) => c + (isVideoItem(t) ? 1 : 0), 0);
  $('stats').textContent = `${(n - nv).toLocaleString('fr-FR')} bookmarks${nv ? ` · ${nv.toLocaleString('fr-FR')} vidéos YouTube` : ''} · ${v.toLocaleString('fr-FR')} indexés sémantiquement (${modelOf(settings.embedModel).label.split(' (')[0]}) · build ${typeof __BUILD__ === 'string' ? __BUILD__ : 'dev'}`;
}

// ---------- recherche ----------
async function embedQuery(text, kind, expectDim) {
  const key = `${activeModel}|${kind || 't'}|${text}`;
  if (qCache.has(key)) return qCache.get(key);
  const res = await chrome.runtime.sendMessage({ type: 'q:embed', text, kind });
  if (!res || res.error) throw new Error(res?.error || 'pas de réponse');
  const v = Float32Array.from(res.vec);
  if (v.length !== (expectDim || index.dim)) throw new Error('le modèle a changé entre-temps, réessaie dans un instant');
  qCache.set(key, v);
  if (qCache.size > 80) qCache.delete(qCache.keys().next().value);
  return v;
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// Filtres venant de la barre d'outils (période, types).
function toolbarFilters() {
  const f = {};
  if (state.range !== 'all') f.since = isoDay(Date.now() - Number(state.range) * 86_400_000);
  if (state.types.size) f.has = [...state.types];
  if (view.source && view.source !== 'all') f.source = view.source;
  return f;
}

function mergeFilters(a, b) {
  const out = { ...a, ...b };
  if (a.has || b.has) out.has = [...new Set([...(a.has || []), ...(b.has || [])])];
  if (a.since && b.since) out.since = a.since > b.since ? a.since : b.since;
  return out;
}

function maskFor(filters) {
  let m = index.allowedMask(filters);
  if (state.themeMask) {
    if (!m) m = state.themeMask;
    else { m = Uint8Array.from(m); for (let i = 0; i < m.length; i++) m[i] &= state.themeMask[i] || 0; }
  }
  return m;
}

// Équilibre mots exacts ↔ sens. En « sens d'abord », l'ordre sémantique domine et les mots exacts ne font que
// remonter légèrement un résultat : c'est ce qui permet de retrouver « brain » en cherchant « cerveau ».
const BLEND = { semantic: [10, 0.1], keywords: [0.6, 1.5] };
const weightsFor = (long) => BLEND[view.blend] || (long ? [1.5, 0.7] : [1, 1]);

// Recherche hybride sans rendu (utilisée par l'interface et par le banc d'essai).
async function coreSearch(text, allowed, { mode = 'hybrid', weights, limit = 200 } = {}) {
  const kw = index.bm25(text, allowed, limit);
  if (mode === 'kw') return { rows: kw, kw, sem: [] };
  const qv = await embedQuery(semanticQuery(text));
  const sem = index.vector(qv, allowed, limit);
  if (mode === 'sem') return { rows: sem, kw, sem };
  const long = contentWords(text) >= 3; // phrase libre : on se fie davantage au sens qu'aux mots exacts
  return { rows: rrf([sem, kw], weights || weightsFor(long)), kw, sem };
}

const sortRows = (rows, how) => sortRowsBy(rows, index.tweets, how);

const intentCache = new Map();
function fromIntent(it) {
  return {
    text: (it.topic || '').trim(),
    sort: it.sort === 'oldest' || it.sort === 'newest' ? it.sort : null,
    authorTokens: (it.authors || []).map((a) => String(a).replace(/^@/, '')).filter(Boolean),
    since: /^\d{4}-\d{2}-\d{2}$/.test(it.since || '') ? it.since : null,
    until: /^\d{4}-\d{2}-\d{2}$/.test(it.until || '') ? it.until : null,
    has: (it.has || []).filter((h) => ['link', 'media', 'video'].includes(h)),
  };
}

// is:nom : détecteur personnel (créé dans 📊 › Mes stats). Ensemble calculé à la demande, mis en cache.
const detCache = new Map();
async function resolveIs(filters) {
  if (!filters.is) return;
  const dets = (await getMeta('dashDetectors')) || [];
  const det = dets.find((d) => slugOf(d.name) === filters.is);
  if (!det) { filters.isIds = new Set(); return; } // détecteur inconnu : aucun résultat
  const mid = modelOf(settings.embedModel).id;
  const vds = (await getMeta('detVerdicts')) || {};
  const vd = vds[det.id]?.key === verdictKey(det) ? vds[det.id].v : {};
  const key = `${det.id}|${mid}|${det.protoKey}|${det.threshold}|${det.pos?.length}|${det.neg?.length}|${det.confirm?.on}|${det.confirm?.band}|${Object.keys(vd).length}`;
  if (!detCache.has(key)) {
    const protos = (det.protos?.[mid] || []).map((a) => Float32Array.from(a));
    if (!protos.length) { filters.isIds = new Set(); return; }
    detCache.set(key, detectorSet(detectorScores(await getAllVectors(mid), await getAllChunkVecs(mid), protos), det, vd));
  }
  filters.isIds = detCache.get(key);
}

async function run(opts = {}) {
  const my = ++seq;
  const raw = $('q').value.trim();
  $('save').hidden = !raw;
  const parsed = parseQuery(raw);
  let text = parsed.text;
  let filters = mergeFilters(parsed.filters, toolbarFilters());
  await resolveIs(filters);
  if (my !== seq) return;
  shown = PAGE;

  // Compréhension de la requête : IA (si demandée) sinon règles (« le plus vieux d'OpenAI »).
  let sort, authors = [], aiUsed = false, jevUsed = false;
  if (opts.intent) {
    const it = fromIntent(opts.intent);
    aiUsed = true;
    sort = it.sort;
    text = it.text;
    filters = mergeFilters(filters, { since: it.since || undefined, until: it.until || undefined, has: it.has.length ? it.has : undefined });
    if (!state.ignoreAuthor) for (const tok of it.authorTokens) authors.push(...findAuthors(index.tweets, tok));
  } else {
    const nl = interpret(text);
    sort = nl.sort;
    text = nl.text;
    if (nl.author && !state.ignoreAuthor) {
      const found = findAuthors(index.tweets, nl.author.token);
      if (found.length && found.length <= 15) {
        authors = found;
        text = nl.text.replace(nl.author.phrase.trim(), ' ');
      }
    }
    if (!authors.length) text = nl.sort ? nl.text : parsed.text;
  }
  if (opts.jev) { // modèle de décision : tri / période / type de contenu
    jevUsed = true;
    sort = sort || opts.jev.sort;
    if (opts.jev.period) filters = mergeFilters(filters, { since: isoDay(Date.now() - PERIOD_DAYS[opts.jev.period] * 86_400_000) });
    if (opts.jev.kind) filters = mergeFilters(filters, { has: [opts.jev.kind] });
  }
  authors = [...new Map(authors.map((a) => [a.handle.toLowerCase(), a])).values()];
  if (authors.length && authors.length <= 15) filters.fromAny = authors.map((a) => a.handle.toLowerCase());
  else authors = [];
  text = text.replace(/\s+/g, ' ').trim();
  const allowed = maskFor(filters);
  const userSort = state.sort !== 'relevance' ? state.sort : null;
  const meta = { authors, ai: aiUsed };
  const tag = aiUsed ? ' · compris par l’IA' : jevUsed ? ' · compris par Jev' : '';

  // Aucun mot utile : on liste (récemment bookmarkés d'abord, ou triés si demandé).
  if (!text || contentWords(text) === 0) {
    let rows = [];
    for (const i of index.recentRows()) if (!allowed || allowed[i]) rows.push([i, 0]);
    const how = userSort || sort;
    if (how) rows = sortRows(rows, how);
    last = { rows: rows.slice(0, 2000), terms: [], label: (raw || state.themeMask ? 'Filtres appliqués' : 'Derniers bookmarks') + tag, meta };
    return render();
  }

  // Recherche dans les images (CLIP).
  if (state.imageMode) {
    try {
      const imgs = await loadImgIndex();
      const qv = await embedQuery(text, 'image', imgs.dim);
      if (my !== seq) return;
      const sc = [];
      for (let i = 0; i < imgs.ids.length; i++) {
        const row = index.rowById.get(imgs.ids[i]);
        if (row === undefined || (allowed && !allowed[row])) continue;
        let s = 0;
        for (let d = 0; d < imgs.dim; d++) s += imgs.matrix[i * imgs.dim + d] * qv[d];
        sc.push([row, s]);
      }
      sc.sort((a, b) => b[1] - a[1]);
      last = { rows: sc.slice(0, 200), terms: [], label: `Images (${imgs.model === 'gemma2' ? 'EmbeddingGemma 2' : 'CLIP, requêtes en anglais'}) — ${imgs.ids.length} images indexées`, meta };
    } catch (e) {
      last = { rows: [], terms: [], label: 'Recherche d’images indisponible : ' + e.message, meta };
    }
    return render();
  }

  const terms = highlightTerms(text);
  last = { rows: index.bm25(text, allowed), terms, label: 'Mots-clés (la recherche sémantique arrive…)' + tag, meta };
  render();

  let rows = last.rows, label, why = new Map(), kwAll = last.rows;
  const wide = !!(userSort || sort); // tri demandé : il faut regarder toutes les correspondances, pas seulement les 200 meilleures
  if (!index.vectorCount()) {
    label = 'Mots-clés uniquement — aucun tweet indexé sémantiquement pour l’instant';
  } else {
    try {
      const r = await coreSearch(text, allowed, { limit: wide ? 5000 : 200 });
      if (my !== seq) return;
      rows = r.rows;
      kwAll = r.kw;
      label = 'Hybride : sémantique + mots-clés';
      const sr = new Map(r.sem.map(([row], i) => [row, i + 1])), kr = new Map(r.kw.map(([row], i) => [row, i + 1]));
      for (const [row] of rows.slice(0, 120)) why.set(row, `sens ${sr.has(row) ? '#' + sr.get(row) : '–'} · mots ${kr.has(row) ? '#' + kr.get(row) : '–'}`);
    } catch (e) {
      if (my !== seq) return;
      label = 'Mots-clés uniquement (modèle indisponible : ' + e.message + ')';
    }
  }

  // Reclassement des 20 meilleurs : Jev (modèle de décision) en priorité, sinon un LLM (facultatif).
  const histInTop = !settings.aiHistory && rows.slice(0, 20).some(([r]) => !sendable(index.tweets[r])); // pas d'envoi de l'historique à une IA externe
  if (histInTop) label += ' · reclassement IA ignoré (historique protégé)';
  else if (settings.decisionRerank && decisionReady(settings) && rows.length > 1) {
    try {
      const top = rows.slice(0, 20);
      const sc = await jevRerank(settings.decision, text, top.map(([r]) => decodeEntities(index.tweets[r].text)));
      if (my !== seq) return;
      const reranked = top.map((r, i) => [r, sc[i], i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]).map(([r]) => r);
      rows = [...reranked, ...rows.slice(20)];
      label += ' · reclassé par Jev';
    } catch (e) {
      label += ' · reclassement Jev impossible (' + e.message + ')';
    }
  } else if (settings.aiRerank && llmReady(settings) && rows.length > 1) {
    try {
      const top = rows.slice(0, 20);
      const out = parseJsonLoose(await chat(settings.llm, rerankMessages(text, top.map(([r]) => index.tweets[r])), { json: true }));
      if (my !== seq) return;
      const sc = out.scores;
      if (Array.isArray(sc) && sc.length === top.length) {
        const reranked = top.map((r, i) => [r, Number(sc[i]) || 0, i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]).map(([r]) => r);
        rows = [...reranked, ...rows.slice(20)];
        label += ' · reclassé par l’IA';
      }
    } catch (e) {
      label += ' · reclassement IA impossible (' + e.message + ')';
    }
  }

  const how = userSort || sort;
  if (how) { // « le plus vieux … » : on trie par date l'ensemble des correspondances (pas seulement les 200 premières)
    const { pool, kind } = selectPool(rows, kwAll, { words: contentWords(text) });
    rows = sortRows(pool, how);
    label += ` · ${{ oldest: 'du plus ancien au plus récent', newest: 'du plus récent au plus ancien', likes: 'les plus likés d’abord' }[how]} parmi ${pool.length.toLocaleString('fr-FR')} résultats (${kind})`;
  }
  last = { rows, terms, label: label + tag, meta, why };
  render();

  // Compréhension de la requête : on affiche d'abord le résultat des règles, puis on affine (Jev en priorité, sinon un LLM).
  const jevIntentOn = settings.decisionIntent && decisionReady(settings);
  if (!opts.intent && !opts.jev && jevIntentOn && parsed.text.split(/\s+/).length >= 3) {
    try {
      let ji = intentCache.get('jev|' + parsed.text);
      if (!ji) { ji = await jevIntent(settings.decision, parsed.text); intentCache.set('jev|' + parsed.text, ji); }
      if (my === seq && (ji.sort || ji.period || ji.kind)) run({ jev: ji });
    } catch { /* on garde le résultat des règles */ }
  } else if (!opts.intent && !opts.jev && !jevIntentOn && settings.aiIntent && llmReady(settings) && parsed.text.split(/\s+/).length >= 4) {
    try {
      let it = intentCache.get(parsed.text);
      if (!it) {
        it = parseJsonLoose(await chat(settings.llm, intentMessages(parsed.text, isoDay(Date.now())), { json: true }));
        intentCache.set(parsed.text, it);
      }
      if (my === seq) run({ intent: it });
    } catch { /* on garde le résultat des règles */ }
  }
}

function similarTo(row) {
  const t = index.tweets[row];
  if (!index.hasVec[row]) return;
  const qv = index.matrix.subarray(row * index.dim, (row + 1) * index.dim);
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

// Carte de lien façon X : celle fournie par X avec le tweet, sinon celle lue sur la page liée.
function cardOfTweet(t) {
  if ((t.media || []).length) return null; // comme sur X : médias OU carte
  const c = t.xcard || (t.cards || []).find((x) => x.title || x.image);
  return c && c.url && (c.title || c.image) ? c : null;
}
function linkCardHtml(c) {
  let host = '';
  try { host = new URL(c.url).hostname.replace(/^www\./, ''); } catch {}
  const img = c.image && settings.linkImages ? `<img class="lc-img" loading="lazy" referrerpolicy="no-referrer" src="${esc(c.image)}" alt="">` : '';
  return `<a class="lc" href="${esc(c.url)}" target="_blank" rel="noopener">${img}<div class="lc-b">
    <div class="lc-site">${esc(host || c.site || '')}</div>
    ${c.title ? `<div class="lc-t">${esc(c.title)}</div>` : ''}
    ${c.description ? `<div class="lc-d">${esc(c.description)}</div>` : ''}</div></a>`;
}

const avatarUrl = (u) => (u ? u.replace('_normal.', '_bigger.') : '');

// ---------- carte d'une vidéo YouTube ----------
function videoCard([row], terms, pos) {
  const t = index.tweets[row];
  const el = document.createElement('article');
  el.className = 'tw yt' + (t.unavailable ? ' gone' : '');
  el.tabIndex = 0;
  el.dataset.row = row;
  if (pos < 12) el.id = 't-' + (pos + 1);
  const meta = [t.viewsText, t.publishedText].filter(Boolean).join(' · ');
  const pls = (t.playlists || []).filter((p) => p.title).slice(0, 4);
  const wd = t.watched || [];
  const seen = wd.length ? `<div class="yt-w" title="${esc(wd.join(', '))}">Vu le ${esc(wd[wd.length - 1])}${wd.length > 1 ? ` · ×${wd.length}` : ''}${t.progress ? ` · ${t.progress} %` : ''}</div>` : '';
  el.innerHTML = `
    <div class="yt-thumb">${t.thumb ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(t.thumb)}" alt="">` : ''}${t.durationText ? `<span class="dur">${esc(t.durationText)}</span>` : ''}${t.progress ? `<span class="prog"><i style="width:${Math.min(100, t.progress)}%"></i></span>` : ''}</div>
    <div class="yt-b">
      <div class="yt-t"><span class="ytmark">▶</span>${hl(decodeEntities(t.text), terms)}${t.unavailable ? '<span class="yt-na">indisponible</span>' : ''}${t.trState === 'ok' ? '<span class="yt-tr" title="Transcription disponible (cherchée dans le texte parlé)">🗒</span>' : ''}</div>
      <div class="yt-m"><a href="#" data-q="${esc('from:@' + t.handle)}" title="Voir les vidéos de cette chaîne">${esc(t.name || t.handle)}</a>${meta ? ' · ' + esc(meta) : ''}</div>
      ${seen}
      ${pls.length ? `<div class="yt-pl">${pls.map((p) => `<button class="chip-pl" type="button" data-q="${esc(`playlist:"${p.title}"`)}" title="Voir cette playlist">${esc(p.title)}</button>`).join('')}</div>` : ''}
      <div class="ac"><a href="${esc(t.url)}" target="_blank" rel="noopener" style="color:var(--acc);text-decoration:none">Ouvrir sur YouTube ↗</a>
        ${index.hasVec[row] ? '<button class="ghost sim">≈ Similaires</button>' : ''}${last.why?.get(row) ? `<span class="why">${esc(last.why.get(row))}</span>` : ''}</div>
    </div>`;
  if (t.trState === 'ok' && terms?.length) { // extrait de transcription : le texte est relu dans la base (jamais gardé en mémoire)
    getTranscripts([t.id]).then((m) => {
      const bc = bestChunk(m.get(t.id), terms.filter((x) => x.length >= 3), normalizeText);
      if (!bc || !el.isConnected) return;
      const d = document.createElement('div');
      d.className = 'yt-sn';
      d.innerHTML = `<a href="${esc(t.url + '&t=' + bc.t + 's')}" target="_blank" rel="noopener" title="Ouvrir la vidéo à ce passage">▶ ${fmtTime(bc.t)}</a> … ${hl(bc.text.slice(0, 260), terms)} …`;
      el.querySelector('.yt-m')?.after(d);
    }).catch(() => {});
  }
  el.querySelector('img')?.addEventListener('error', (e) => e.target.remove(), { once: true });
  el.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); $('q').value = b.dataset.q; state.ignoreAuthor = false; run(); window.scrollTo({ top: 0 }); }));
  el.addEventListener('click', (e) => { if (!e.target.closest('a,button')) window.open(t.url, '_blank', 'noopener'); });
  el.querySelector('.sim')?.addEventListener('click', () => similarTo(row));
  return el;
}

function card([row], terms, pos) {
  if (isVideoItem(index.tweets[row])) return videoCard([row], terms, pos);
  const t = index.tweets[row];
  const el = document.createElement('article');
  el.className = 'tw';
  el.tabIndex = 0;
  el.dataset.row = row;
  if (pos < 12) el.id = 't-' + (pos + 1);
  const st = t.stats || {};
  const lc = cardOfTweet(t);
  // Comme sur X : le lien de la carte n'est pas répété à la fin du texte.
  const body = lc ? decodeEntities(t.text).replace(new RegExp(lc.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$'), '').trimEnd() : t.text;
  el.innerHTML = `
    <img class="av" loading="lazy" src="${esc(avatarUrl(t.avatar))}" alt="">
    <div class="bd">
      <div class="hd">
        <a class="nm" href="https://x.com/${esc(t.handle)}" target="_blank" rel="noopener">${esc(t.name || t.handle)}</a>
        <span class="hn">@${esc(t.handle)}</span><span>·</span>
        <a href="${esc(t.url)}" target="_blank" rel="noopener">${fmtDate(t.createdAt)}</a>
      </div>
      <div class="tx">${richText(body, terms)}</div>
      ${mediaHtml(t.media || [])}
      ${lc ? linkCardHtml(lc) : ''}
      ${t.quoted ? `<div class="qt" data-url="${esc(t.quoted.url || '')}">
        <div class="hd"><span class="nm">${esc(t.quoted.name || t.quoted.handle)}</span><span class="hn">@${esc(t.quoted.handle)}</span></div>
        <div class="tx">${richText(t.quoted.text, terms)}</div></div>` : ''}
      <div class="ac">
        ${stat('', 'reply', st.replies)}${stat('rp', 'repost', st.reposts)}${stat('lk', 'like', st.likes)}${stat('', 'views', st.views)}${stat('', 'bookmark', st.bookmarks)}
        ${index.hasVec[row] ? '<button class="ghost sim">≈ Similaires</button>' : ''}
        ${last.why?.get(row) ? `<span class="why" title="Rang dans la recherche sémantique / par mots-clés">${esc(last.why.get(row))}</span>` : ''}
      </div>
    </div>`;
  // Comme sur X : un clic sur la carte ouvre le tweet (sauf liens, vidéos, boutons).
  el.querySelectorAll('.lc-img').forEach((img) => img.addEventListener('error', () => img.remove(), { once: true })); // image injoignable : la carte reste, sans image
  if (decodeEntities(t.text).length > 380) { // texte long : replié par défaut, comme sur X (« Afficher plus »)
    const more = Object.assign(document.createElement('button'), { className: 'more-t', textContent: 'Afficher plus' });
    more.onclick = () => { const open = el.classList.toggle('open'); more.textContent = open ? 'Afficher moins' : 'Afficher plus'; };
    el.querySelector('.tx').after(more);
  }
  el.addEventListener('click', (e) => {
    if (e.target.closest('a,button,video')) return;
    const q = e.target.closest('.qt');
    window.open(q?.dataset.url || t.url, '_blank', 'noopener');
  });
  el.querySelector('.sim')?.addEventListener('click', () => similarTo(row));
  return el;
}


let io = null;
function renderCards(from, to) {
  const frag = document.createDocumentFragment();
  last.rows.slice(from, to).forEach((r, i) => frag.appendChild(card(r, last.terms, from + i)));
  $('results').appendChild(frag);
}
// Défilement infini : une sentinelle en bas de liste charge la suite avant d'être visible.
function mountSentinel() {
  io?.disconnect();
  $('results').querySelector('.sentinel')?.remove();
  if (last.rows.length <= shown) return;
  const sentinel = Object.assign(document.createElement('div'), { className: 'sentinel' });
  $('results').appendChild(sentinel);
  io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    const from = shown;
    shown += PAGE;
    sentinel.remove();
    renderCards(from, shown);
    mountSentinel();
  }, { rootMargin: '800px' });
  io.observe(sentinel);
}

function render() {
  const box = $('results');
  io?.disconnect();
  box.replaceChildren();
  const modeEl = $('mode');
  modeEl.textContent = last.label + (last.rows.length ? ` — ${last.rows.length >= 200 ? '200+' : last.rows.length} résultats` : '');
  const au = last.meta?.authors;
  if (au?.length) {
    const b = document.createElement('button');
    b.className = 'ghost';
    b.textContent = `Auteur : ${au.slice(0, 3).map((a) => '@' + a.handle).join(', ')}${au.length > 3 ? '…' : ''} ✕ retirer`;
    b.onclick = () => { state.ignoreAuthor = true; run(); };
    modeEl.append(' ', b);
  }
  if (state.themeMask) {
    const b = document.createElement('button');
    b.className = 'ghost';
    b.textContent = `Thème : ${state.themeLabel} ✕`;
    b.onclick = () => { state.themeMask = null; run(); };
    modeEl.append(' ', b);
  }
  $('ask').hidden = !llmReady(settings) || !$('q').value.trim();
  if (!last.rows.length) {
    box.innerHTML = `<div class="empty">${index.tweets.length ? 'Aucun résultat.' : 'Aucun bookmark capturé pour l’instant.<br>Ouvre x.com/i/bookmarks, puis clique « ⟳ Tout synchroniser ».'}</div>`;
    return;
  }
  renderCards(0, shown);
  mountSentinel();
}

// ---------- affichage : liste / grille, bandeau replié ----------
bindThemeButton($('theme'));
const VKEY = 'xbs.view';
const view = (() => { try { return { mode: 'list', cols: 3, folded: false, blend: 'balanced', source: 'all', ...JSON.parse(localStorage.getItem(VKEY) || '{}') }; } catch { return { mode: 'list', cols: 3, folded: false, blend: 'balanced', source: 'all' }; } })();
if (embed) view.mode = 'list';
const saveView = () => { try { localStorage.setItem(VKEY, JSON.stringify(view)); } catch {} };
function applyView() {
  document.body.classList.toggle('grid', view.mode === 'grid');
  document.body.classList.toggle('compact', view.folded);
  $('fold').title = view.folded ? 'Déplier les filtres (Alt+F)' : 'Replier les filtres (Alt+F)';
  $('view').value = view.mode === 'grid' ? String(view.cols) : 'list';
  $('blend').value = view.blend;
  $('source').value = view.source;
  // colonnes réellement affichées : pas plus que ce que la largeur permet (~320 px minimum par carte)
  const eff = view.mode === 'grid' ? Math.max(1, Math.min(view.cols, Math.floor(document.body.clientWidth / 320))) : 1;
  document.documentElement.style.setProperty('--cols', eff);
}
$('view').onchange = (e) => {
  if (e.target.value === 'list') view.mode = 'list';
  else { view.mode = 'grid'; view.cols = Number(e.target.value); }
  saveView(); applyView();
};
$('source').onchange = (e) => { view.source = e.target.value; saveView(); run(); };
$('blend').onchange = (e) => { view.blend = e.target.value; saveView(); run(); };
$('fold').onclick = () => { view.folded = !view.folded; saveView(); applyView(); };
window.addEventListener('resize', applyView);
document.addEventListener('keydown', (e) => { if (e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('fold').click(); } });
applyView();

// ---------- barre d'outils ----------
let timer;
$('q').addEventListener('input', () => { state.ignoreAuthor = false; clearTimeout(timer); timer = setTimeout(run, 120); });
$('range').onchange = (e) => { state.range = e.target.value; run(); };
$('sort').onchange = (e) => { state.sort = e.target.value; run(); };
document.querySelectorAll('.chip[data-type]').forEach((b) => {
  b.onclick = () => {
    const t = b.dataset.type;
    state.types.has(t) ? state.types.delete(t) : state.types.add(t);
    b.classList.toggle('on', state.types.has(t));
    run();
  };
});
$('imgmode').onclick = () => { state.imageMode = !state.imageMode; $('imgmode').classList.toggle('on', state.imageMode); run(); };

// ---------- historique & recherches enregistrées ----------
const HKEY = 'xbs.history';
function history() { try { return JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch { return []; } }
function pushHistory(q) {
  q = q.trim();
  if (q.length < 3) return;
  try { localStorage.setItem(HKEY, JSON.stringify([q, ...history().filter((x) => x !== q)].slice(0, 30))); } catch {}
  renderHistory();
}
function renderHistory() { $('hist').replaceChildren(...history().map((q) => Object.assign(document.createElement('option'), { value: q }))); }
$('q').addEventListener('change', () => pushHistory($('q').value));

let saved = [];
function renderSaved() {
  const box = $('saved');
  box.replaceChildren(...saved.map((q, i) => {
    const el = document.createElement('span');
    el.className = 's';
    el.textContent = '★ ' + q;
    el.onclick = () => { $('q').value = q; state.ignoreAuthor = false; run(); };
    const x = document.createElement('i');
    x.textContent = '✕';
    x.title = 'Supprimer';
    x.onclick = async (e) => { e.stopPropagation(); saved.splice(i, 1); await setMeta('saved', saved); renderSaved(); };
    el.append(x);
    return el;
  }));
}
$('save').onclick = async () => {
  const q = $('q').value.trim();
  if (!q || saved.includes(q)) return;
  saved.push(q);
  await setMeta('saved', saved);
  renderSaved();
};

// ---------- clavier ----------
document.addEventListener('keydown', (e) => {
  const inInput = e.target.matches?.('input, textarea, select');
  if (e.key === '/' && !inInput) { e.preventDefault(); $('q').focus(); return; }
  if (e.key === 'Enter' && e.ctrlKey && e.target === $('q')) { $('ask').click(); return; }
  const cards = () => [...document.querySelectorAll('.tw')];
  if (e.target === $('q') && e.key === 'ArrowDown') { e.preventDefault(); cards()[0]?.focus(); return; }
  const cur = e.target.closest?.('.tw');
  if (!cur || inInput) return;
  const move = (d) => { const cs = cards(); const n = cs[cs.indexOf(cur) + d]; if (n) { e.preventDefault(); n.focus(); n.scrollIntoView({ block: 'center' }); } };
  if (e.key === 'j' || e.key === 'ArrowDown') move(1);
  else if (e.key === 'k' || e.key === 'ArrowUp') move(-1);
  else if (e.key === 'Enter' || e.key === 'o') window.open(index.tweets[cur.dataset.row].url, '_blank', 'noopener');
  else if (e.key === 's') cur.querySelector('.sim')?.click();
  else if (e.key === 'Escape') $('q').focus();
});

// ---------- bandeaux (format de X changé, bookmarks supprimés) ----------
async function renderBanners() {
  const box = $('banners');
  box.replaceChildren();
  const add = (cls, html, actions) => {
    const el = document.createElement('div');
    el.className = 'bn ' + cls;
    el.innerHTML = html;
    for (const [label, fn] of actions) {
      const b = document.createElement('button');
      b.className = 'ghost';
      b.textContent = label;
      b.onclick = fn;
      el.append(b);
    }
    box.append(el);
  };
  const w = await getMeta('parseWarning');
  if (w) add('err', w.src === 'youtube' ? `⚠ YouTube a peut-être changé son format : des vidéos sont illisibles. Si les nouvelles vidéos n’apparaissent plus, le lecteur (<code>youtube.js</code>) doit être mis à jour.` : `⚠ X a peut-être changé son format : ${w.unparsed} tweet(s) illisible(s). Si les nouveaux bookmarks n’apparaissent plus, le lecteur (<code>parse.js</code>) doit être mis à jour.`, [['Ignorer', async () => { await chrome.runtime.sendMessage({ type: 'q:clearWarning' }); renderBanners(); }]]);
  const orphans = (await getMeta('orphans')) || [];
  if (orphans.length) add('', `🗑 ${orphans.length} bookmark(s) n’existent plus (retirés de X, ou sortis de toutes tes playlists YouTube).`, [
    ['Les retirer d’ici', async () => { await chrome.runtime.sendMessage({ type: 'q:orphansDelete' }); }],
    ['Les garder', async () => { await chrome.runtime.sendMessage({ type: 'q:orphansDismiss' }); renderBanners(); }],
  ]);
}

// ---------- redécouverte ----------
function showRows(rows, label) {
  seq++; shown = PAGE;
  last = { rows: rows.map((r) => [r, 0]), terms: [], meta: {}, label };
  $('answer').replaceChildren();
  render();
  window.scrollTo({ top: 0 });
}
$('rand').onclick = () => {
  const old = index.tweets.map((t, i) => [t, i]).filter(([t]) => t.createdAt && Date.parse(t.createdAt) < Date.now() - 30 * 86_400_000).map(([, i]) => i);
  const pool = old.length >= 8 ? old : index.tweets.map((_, i) => i);
  const pick = [];
  for (let n = 0; n < Math.min(8, pool.length); n++) pick.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  showRows(pick, '🎲 Bookmarks au hasard (cliquer à nouveau pour en tirer d’autres)');
};
$('yearago').onclick = () => {
  const center = Date.now() - 365 * 86_400_000;
  for (const win of [21, 60, 120]) {
    const rows = index.tweets.map((t, i) => [t, i]).filter(([t]) => t.createdAt && Math.abs(Date.parse(t.createdAt) - center) <= win * 86_400_000).map(([, i]) => i);
    if (rows.length) return showRows(rows.slice(0, 60), `📅 Il y a un an (± ${win} jours)`);
  }
  showRows([], '📅 Rien de sauvegardé autour de la même date l’an dernier');
};

// ---------- thèmes automatiques ----------
let themes = null;
async function showThemes() {
  const withVec = [];
  for (let i = 0; i < index.tweets.length; i++) if (index.hasVec[i]) withVec.push(i);
  if (withVec.length < 30) return showRows([], '☰ Pas assez de bookmarks indexés pour former des thèmes (30 minimum)');
  $('mode').textContent = 'Calcul des thèmes…';
  await new Promise((r) => setTimeout(r, 30));
  if (!themes || themes.n !== withVec.length) {
    const k = Math.max(6, Math.min(30, Math.round(Math.sqrt(withVec.length / 2))));
    const { assign } = kmeans(index.matrix, withVec, k, { dim: index.dim });
    const labels = labelClusters(index.tweets, withVec, assign, k, 3);
    themes = { n: withVec.length, rows: withVec, assign, labels, names: null, k };
  }
  renderThemes();
}
function renderThemes() {
  seq++;
  $('answer').replaceChildren();
  const box = $('results');
  box.replaceChildren();
  $('mode').textContent = `☰ ${themes.k} thèmes détectés automatiquement`;
  const wrap = document.createElement('div');
  wrap.className = 'themes';
  if (llmReady(settings)) {
    const b = document.createElement('button');
    b.className = 'ghost';
    b.textContent = themes.names ? '✨ Renommer avec l’IA' : '✨ Nommer les thèmes avec l’IA';
    b.onclick = nameThemesWithAI;
    wrap.append(b);
  }
  const groups = Array.from({ length: themes.k }, () => []);
  themes.rows.forEach((row, i) => groups[themes.assign[i]].push(row));
  groups.map((rows, c) => ({ rows, c })).filter((g) => g.rows.length).sort((a, b) => b.rows.length - a.rows.length).forEach(({ rows, c }) => {
    const el = document.createElement('div');
    el.className = 'th';
    const name = themes.names?.[c] || themes.labels[c].join(' · ') || `Thème ${c + 1}`;
    const authors = [...new Set(rows.slice(0, 40).map((r) => '@' + index.tweets[r].handle))].slice(0, 3).join(', ');
    el.innerHTML = `<b>${esc(name)}</b><span>${rows.length} tweets · ${esc(authors)}</span>`;
    el.onclick = () => {
      const mask = new Uint8Array(index.tweets.length);
      for (const r of rows) mask[r] = 1;
      state.themeMask = mask;
      state.themeLabel = name;
      $('q').value = '';
      run();
    };
    wrap.append(el);
  });
  box.append(wrap);
}
async function nameThemesWithAI() {
  $('mode').textContent = 'Nommage des thèmes par l’IA…';
  const groups = Array.from({ length: themes.k }, () => []);
  themes.rows.forEach((row, i) => groups[themes.assign[i]].push(row));
  const payload = groups.map((rows, c) => ({ terms: themes.labels[c], samples: rows.filter((r) => sendable(index.tweets[r])).slice(0, 5).map((r) => decodeEntities(index.tweets[r].text).replace(/\s+/g, ' ').slice(0, 140)) }));
  try {
    const out = parseJsonLoose(await chat(settings.llm, themeNamesMessages(payload), { json: true }));
    if (Array.isArray(out.names)) themes.names = out.names;
  } catch (e) { $('mode').textContent = 'Nommage impossible : ' + e.message; return; }
  renderThemes();
}
$('themes').onclick = showThemes;

// ---------- IA : questions-réponses et résumé ----------
function showAnswer(html, sourcesNote) {
  const box = $('answer');
  box.innerHTML = `<div class="ans"><div class="ah"><span>Réponse de l’IA — vérifie toujours les sources${sourcesNote ? ' · ' + sourcesNote : ''}</span><button class="ghost" id="ans-x">✕</button></div>${html}</div>`;
  $('ans-x').onclick = () => box.replaceChildren();
  box.querySelectorAll('a.cite').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const el = document.getElementById('t-' + a.dataset.n);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }));
}
const etaText = (sec) => (sec >= 5400 ? `${Math.round(sec / 3600)} h` : `${Math.max(1, Math.round(sec / 60))} min`);
// Vie privée : l'historique de visionnage ne part vers une IA externe que si tu l'as autorisé.
const sendable = (t) => settings.aiHistory || !isVideoItem(t) || !(t.watched || []).length || (t.playlists || []).length > 0;
async function ask() {
  if (!llmReady(settings)) return openSettings();
  const question = $('q').value.trim();
  if (!question) return;
  showAnswer('<p>Réflexion…</p>');
  await run();
  const src = last.rows.slice(0, 12).map(([r]) => index.tweets[r]).filter(sendable);
  if (!src.length) return showAnswer('<p>Aucun tweet trouvé pour répondre.</p>');
  try {
    const out = await chat(settings.llm, askMessages(question, src));
    showAnswer(renderMd(out, src.length), `${src.length} tweets utilisés`);
  } catch (e) { showAnswer(`<p>⚠ ${esc(e.message)}</p>`); }
}
$('ask').onclick = ask;
$('digest').onclick = async () => {
  if (!llmReady(settings)) return openSettings();
  const week = Date.now() - 7 * 86_400_000;
  let rows = index.tweets.map((t, i) => [t, i]).filter(([t]) => t.createdAt && Date.parse(t.createdAt) >= week).map(([, i]) => i);
  let label = 'les 7 derniers jours';
  if (rows.length < 5) { rows = index.recentRows().filter((r) => sendable(index.tweets[r])).slice(0, 30); label = 'tes 30 derniers bookmarks'; }
  rows = rows.filter((r) => sendable(index.tweets[r])).sort((a, b) => (index.tweets[b].stats?.likes || 0) - (index.tweets[a].stats?.likes || 0)).slice(0, 40);
  showRows(rows, `📰 Résumé : ${label}`);
  showAnswer('<p>Rédaction du résumé…</p>');
  try {
    const out = await chat(settings.llm, digestMessages(label, rows.map((r) => index.tweets[r])));
    showAnswer(renderMd(out, Math.min(12, rows.length)), `${rows.length} tweets`);
  } catch (e) { showAnswer(`<p>⚠ ${esc(e.message)}</p>`); }
};

// ---------- index d'images ----------
async function loadImgIndex() {
  const tag = modelOf(settings.embedModel).imageModel;
  const rows = (await getAllImgVectors(tag)).filter((r) => r.vec?.length > 0);
  if (!rows.length) throw new Error('aucune image indexée pour l’instant (activée dans les réglages ?)');
  const dim = rows[0].vec.length;
  const good = rows.filter((r) => r.vec.length === dim);
  const matrix = new Float32Array(good.length * dim);
  good.forEach((r, i) => matrix.set(r.vec, i * dim));
  imgIndex = { ids: good.map((r) => r.id), matrix, dim, model: tag };
  return imgIndex;
}

// ---------- synchro ----------
const startSync = async (mode) => {
  $('progress').textContent = 'Démarrage (un onglet X s’ouvre en arrière-plan si besoin)…';
  const res = await chrome.runtime.sendMessage({ type: 'startBackfill', mode });
  if (!res?.ok) $('progress').textContent = 'Impossible de démarrer : vérifie que tu es connecté à X, puis réessaie.';
};
$('sync').onclick = () => startSync('full');
$('news').onclick = () => startSync('incremental');
$('stop').onclick = () => { chrome.runtime.sendMessage({ type: 'stopBackfill' }); chrome.runtime.sendMessage({ type: 'q:ytStop' }); chrome.runtime.sendMessage({ type: 'q:updateStop' }); };
$('yt-sync').onclick = async () => {
  $('progress').textContent = 'YouTube : ouverture d’un onglet en arrière-plan…';
  const res = await chrome.runtime.sendMessage({ type: 'q:ytSync', mode: 'all' });
  if (!res?.ok) $('progress').textContent = 'YouTube : impossible de démarrer (' + (res?.reason || 'erreur') + '). Vérifie que tu es connecté à YouTube.';
};

$('yt-hist').onclick = async () => {
  $('progress').textContent = 'YouTube : ouverture de l’historique en arrière-plan…';
  const res = await chrome.runtime.sendMessage({ type: 'q:ytSync', mode: 'history' });
  if (!res?.ok) $('progress').textContent = 'YouTube : impossible de démarrer (' + (res?.reason || 'erreur') + '). Vérifie que tu es connecté à YouTube.';
};

let updatingUi = false; // une mise à jour globale pilote déjà les boutons (les sous-étapes ne doivent pas les rebasculer)
$('update-all').onclick = async () => {
  updatingUi = true;
  $('progress').textContent = 'Mise à jour…';
  $('update-all').hidden = true; $('stop').hidden = false;
  const res = await chrome.runtime.sendMessage({ type: 'q:updateAll' });
  if (res && !res.ok && res.reason === 'busy') $('progress').textContent = 'Une mise à jour est déjà en cours.';
};
$('yt-tr').onclick = async () => {
  $('progress').textContent = 'YouTube : préparation des transcriptions…';
  const res = await chrome.runtime.sendMessage({ type: 'q:ytSync', mode: 'transcripts' });
  if (res?.reason === 'nothing-to-do') $('progress').textContent = 'YouTube : toutes les vidéos concernées ont déjà leur transcription (ou n’en ont pas).';
  else if (!res?.ok) $('progress').textContent = 'YouTube : impossible de démarrer (' + (res?.reason || 'erreur') + '). Vérifie que tu es connecté à YouTube.';
};

if (embed) {
  document.body.classList.add('embed');
  $('close').hidden = false;
  $('close').onclick = () => parent.postMessage({ xbs: 'close' }, '*');
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('settings').open) parent.postMessage({ xbs: 'close' }, '*'); });
  window.addEventListener('message', (e) => { if (e.data?.xbs === 'focus') $('q').focus(); });
}

// ---------- playlists YouTube prises en compte ----------
async function renderYtPlaylists() {
  const box = $('ytpl-list');
  const cat = await playlistCatalog();
  const ex = new Set(settings.ytExcluded);
  box.replaceChildren(...(cat.length ? cat : []).map((p) => {
    const l = document.createElement('label');
    l.className = 'chk';
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !ex.has(p.id) });
    cb.dataset.id = p.id;
    const sp = document.createElement('span');
    sp.textContent = `${p.title} `;
    const n = document.createElement('span');
    n.className = 'hint'; n.textContent = `(${p.n} vidéo${p.n > 1 ? 's' : ''}${p.listed && p.listed > p.n ? ` sur ${p.listed}` : ''})`;
    sp.append(n);
    l.append(cb, sp);
    return l;
  }));
  if (!cat.length) box.textContent = 'Aucune playlist connue : lance « ▶ Playlists YouTube ».';
}
async function setYtExcluded(ids) {
  settings = await setSettings({ ytExcluded: ids });
  const changed = await applyYtSelection(ids);
  if (changed) { await load(true); run(); }
  renderYtPlaylists();
}
$('ytpl-list').addEventListener('change', async (e) => {
  const cb = e.target.closest('input[data-id]');
  if (!cb) return;
  const ex = new Set(settings.ytExcluded);
  if (cb.checked) ex.delete(cb.dataset.id); else ex.add(cb.dataset.id);
  await setYtExcluded([...ex]);
});
$('ytpl-all').onclick = () => setYtExcluded([]);
$('ytpl-none').onclick = async () => setYtExcluded((await playlistCatalog()).map((p) => p.id));

// ---------- réglages ----------
const dlg = $('settings');
async function openSettings() {
  settings = await getSettings();
  $('llm-url').value = settings.llm.baseUrl;
  $('llm-model').value = settings.llm.model;
  $('llm-key').value = settings.llm.apiKey;
  $('ai-intent').checked = settings.aiIntent;
  $('ai-rerank').checked = settings.aiRerank;
  $('opt-links').checked = settings.enrichLinks;
  $('opt-images').checked = settings.imageSearch;
  $('opt-auto').checked = settings.autoSync;
  $('yt-days').value = String(settings.ytHistoryDays);
  renderYtPlaylists();
  $('yt-trscope').value = settings.ytTranscripts;
  $('yt-trbatch').value = String(settings.ytTrBatch);
  $('yt-trspeed').value = settings.ytTrSpeed;
  $('yt-trwords').value = String(settings.ytTrWords);
  $('yt-trpass').value = String(settings.ytTrPassages);
  $('ai-history').checked = settings.aiHistory;
  $('compute').value = settings.compute;
  $('threads').value = settings.threads;
  $('opt-autoindex').checked = settings.indexMode !== 'manual';
  $('opt-tabs').checked = settings.autoTabs;
  $('upd-hist').checked = settings.updHistory;
  $('upd-tr').checked = settings.updTranscripts;
  pollStatus();
  $('opt-linkimg').checked = settings.linkImages;
  $('embed-model').replaceChildren(...Object.values(MODELS).map((m) => Object.assign(document.createElement('option'), { value: m.key, textContent: m.label, selected: m.key === settings.embedModel })));
  $('dec-url').value = settings.decision.url;
  $('dec-model').value = settings.decision.model;
  $('dec-key').value = settings.decision.apiKey;
  $('dec-intent').checked = settings.decisionIntent;
  $('dec-rerank').checked = settings.decisionRerank;
  const h = await getMeta('syncDir');
  setDirUi(h);
  dlg.showModal();
}
$('gear').onclick = openSettings;

function applySettingsUi() {
  $('digest').hidden = !llmReady(settings);
  $('imgmode').hidden = !settings.imageSearch;
  if (!settings.imageSearch && state.imageMode) { state.imageMode = false; $('imgmode').classList.remove('on'); }
  $('ask').hidden = !llmReady(settings) || !$('q').value.trim();
}

const PRESETS = { openrouter: 'https://openrouter.ai/api/v1', ollama: 'http://localhost:11434/v1', openai: 'https://api.openai.com/v1' };
document.querySelectorAll('[data-preset]').forEach((b) => {
  b.onclick = () => {
    $('llm-url').value = PRESETS[b.dataset.preset];
    if (b.dataset.preset === 'ollama') $('llm-msg').textContent = 'Ollama : lance-le avec OLLAMA_ORIGINS="chrome-extension://*" ollama serve, puis indique le nom d’un modèle installé (ollama list).';
  };
});

$('llm-test').onclick = async () => {
  const llm = { baseUrl: $('llm-url').value.trim(), model: $('llm-model').value.trim(), apiKey: $('llm-key').value.trim() };
  const msg = $('llm-msg');
  msg.textContent = 'Test en cours…';
  try {
    if (!llm.baseUrl || !llm.model) throw new Error('URL et modèle requis.');
    const origin = new URL(llm.baseUrl).origin;
    const ok = (await chrome.permissions.contains({ origins: [origin + '/*'] })) || (await chrome.permissions.request({ origins: [origin + '/*'] }));
    if (!ok) throw new Error('Accès refusé à ' + origin);
    settings = await setSettings({ llm, aiIntent: $('ai-intent').checked, aiRerank: $('ai-rerank').checked });
    const out = await chat(llm, [{ role: 'user', content: 'Réponds uniquement : ok' }]);
    msg.textContent = '✓ Connecté. Réponse du modèle : ' + out.slice(0, 40);
    applySettingsUi();
  } catch (e) { msg.textContent = '⚠ ' + e.message; }
};
for (const id of ['ai-intent', 'ai-rerank']) {
  $(id).onchange = async () => { settings = await setSettings({ aiIntent: $('ai-intent').checked, aiRerank: $('ai-rerank').checked }); };
}
$('embed-model').onchange = async (e) => {
  const key = e.target.value, m = MODELS[key];
  if (key === settings.embedModel) return;
  if (!confirm(`Passer à « ${m.label} » ?\n\nTous les tweets vont être ré-indexés avec ce modèle (long, en arrière-plan). La recherche par mots-clés reste disponible pendant ce temps.`)) {
    e.target.value = settings.embedModel;
    return;
  }
  settings = await setSettings({ embedModel: key }); // storage.onChanged recharge l'index à la bonne dimension
  $('embed-msg').textContent = `Modèle changé : ${m.label}. Ré-indexation lancée.`;
  chrome.runtime.sendMessage({ type: 'q:index', force: true });
};

$('dec-test').onclick = async () => {
  const decision = { url: $('dec-url').value.trim(), model: $('dec-model').value.trim(), apiKey: $('dec-key').value.trim() };
  const msg = $('dec-msg');
  msg.textContent = 'Test en cours…';
  try {
    if (!decision.url || !decision.model || !decision.apiKey) throw new Error('URL, modèle et clé requis.');
    const origin = new URL(decision.url).origin;
    const ok = (await chrome.permissions.contains({ origins: [origin + '/*'] })) || (await chrome.permissions.request({ origins: [origin + '/*'] }));
    if (!ok) throw new Error('Accès refusé à ' + origin);
    settings = await setSettings({ decision, decisionIntent: $('dec-intent').checked, decisionRerank: $('dec-rerank').checked });
    const a = await decide(decision, 'Bonjour !', { salutation: { type: 'choice', instructions: 'Ce message est-il une salutation ?', criteria: { oui: 'C’est une salutation', non: 'Ce n’est pas une salutation' } } });
    const r = a.salutation;
    msg.textContent = `✓ Connecté. Réponse : « ${r?.choice} » (confiance ${Number(r?.confidence ?? 0).toFixed(2)})`;
  } catch (e) { msg.textContent = '⚠ ' + e.message; }
};
for (const id of ['dec-intent', 'dec-rerank']) {
  $(id).onchange = async () => { settings = await setSettings({ decisionIntent: $('dec-intent').checked, decisionRerank: $('dec-rerank').checked }); };
}
$('opt-links').onchange = async (e) => {
  if (e.target.checked && !(await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] }))) e.target.checked = false;
  settings = await setSettings({ enrichLinks: e.target.checked });
};
$('opt-images').onchange = async (e) => { settings = await setSettings({ imageSearch: e.target.checked }); applySettingsUi(); };
const runIndex = () => { chrome.runtime.sendMessage({ type: 'q:index', run: true }); setTimeout(pollStatus, 600); };
const stopIndex = async () => { await chrome.runtime.sendMessage({ type: 'q:indexStop' }); setTimeout(pollStatus, 400); };
$('idx-run').onclick = runIndex;
$('idx-pause').onclick = stopIndex;
$('threads').onchange = async (e) => { settings = await setSettings({ threads: e.target.value }); };
$('opt-autoindex').onchange = async (e) => { settings = await setSettings({ indexMode: e.target.checked ? 'soft' : 'manual' }); };
$('upd-hist').onchange = async (e) => { settings = await setSettings({ updHistory: e.target.checked }); };
$('upd-tr').onchange = async (e) => { settings = await setSettings({ updTranscripts: e.target.checked }); };
$('opt-tabs').onchange = async (e) => { settings = await setSettings({ autoTabs: e.target.checked }); };
$('mem-free').onclick = async () => {
  $('mem-info').textContent = 'Libération…';
  await chrome.runtime.sendMessage({ type: 'q:free' });
  setTimeout(pollStatus, 400);
};
$('compute').onchange = async (e) => { settings = await setSettings({ compute: e.target.value }); };
$('opt-linkimg').onchange = async (e) => { settings = await setSettings({ linkImages: e.target.checked }); render(); };
$('yt-trspeed').onchange = async (e) => { settings = await setSettings({ ytTrSpeed: e.target.value }); };
$('yt-trbatch').onchange = async (e) => { settings = await setSettings({ ytTrBatch: +e.target.value }); };
$('yt-trwords').onchange = async (e) => { settings = await setSettings({ ytTrWords: +e.target.value }); index.trChars = settings.ytTrWords; await load(true); run(); };
$('yt-trpass').onchange = async (e) => { settings = await setSettings({ ytTrPassages: +e.target.value }) };
$('yt-trscope').onchange = async (e) => { settings = await setSettings({ ytTranscripts: e.target.value }); };
$('yt-days').onchange = async (e) => { settings = await setSettings({ ytHistoryDays: +e.target.value }); };
$('ai-history').onchange = async (e) => { settings = await setSettings({ aiHistory: e.target.checked }); };
$('opt-auto').onchange = async (e) => { settings = await setSettings({ autoSync: e.target.checked }); };
$('reindex').onclick = async () => {
  if (!confirm('Recalculer tous les vecteurs ? (quelques minutes, en arrière-plan)')) return;
  await clearVectors(modelOf(settings.embedModel).id);
  await load(true);
  chrome.runtime.sendMessage({ type: 'q:index', force: true });
  $('bk-msg').textContent = 'Réindexation lancée.';
};

// ---------- sauvegarde / dossier de synchro ----------
const download = (bytes, name) => {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([bytes])), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
// Construit le fichier de sauvegarde : tweets + recherches enregistrées (+ vecteurs du modèle courant si demandé).
async function buildBackup(pass) {
  const tweets = await getAllTweets();
  const extra = { saved };
  const dash = { widgets: (await getMeta('dashWidgets')) || [], detectors: (await getMeta('dashDetectors')) || [], verdicts: (await getMeta('detVerdicts')) || {} };
  if (dash.widgets.length || dash.detectors.length) extra.dash = dash;
  const trs = await getAllTranscriptRows();
  if (trs.length) extra.transcripts = trs.map((r) => ({ id: r.id, chunks: r.chunks, at: r.at, lang: r.lang }));
  let nVec = 0;
  if ($('bk-vecs').checked) {
    const m = modelOf(settings.embedModel);
    const vecs = await getAllVectors(m.id);
    const entries = [...vecs].map(([id, vec]) => ({ id, vec }));
    extra.vectors = packVectors(m.id, m.dim, entries);
    nVec = extra.vectors.ids.length;
  }
  return { bytes: await encode(tweets, pass || undefined, extra), count: tweets.length, nVec };
}

// Restaure : tweets, recherches enregistrées, vecteurs (rangés sous leur propre modèle, utilisables si le modèle correspond).
async function restoreBackup(bytes, pass) {
  const { tweets, saved: sv, vectors, transcripts, dash } = await decodeFull(bytes, pass);
  let added = 0;
  for (let i = 0; i < tweets.length; i += 1000) added += await putTweets(tweets.slice(i, i + 1000));
  let nVec = 0;
  if (vectors) {
    const entries = unpackVectors(vectors);
    for (let i = 0; i < entries.length; i += 2000) await putVectors(entries.slice(i, i + 2000), vectors.model);
    nVec = entries.length;
  }
  await applyYtSelection(settings.ytExcluded); // les vidéos importées respectent les playlists décochées
  if (dash) {
    const merge = (cur, inc) => { const m = new Map((cur || []).map((x) => [x.id, x])); for (const x of inc || []) if (x?.id && !m.has(x.id)) m.set(x.id, x); return [...m.values()]; };
    await setMeta('dashWidgets', merge(await getMeta('dashWidgets'), dash.widgets));
    await setMeta('dashDetectors', merge(await getMeta('dashDetectors'), dash.detectors));
    const cur = (await getMeta('detVerdicts')) || {};
    for (const [id, vd] of Object.entries(dash.verdicts || {})) cur[id] = cur[id]?.key === vd.key ? { key: vd.key, v: { ...vd.v, ...cur[id].v } } : cur[id] || vd; // les verdicts déjà payés ne sont jamais écrasés
    await setMeta('detVerdicts', cur);
  }
  if (transcripts?.length) for (let i = 0; i < transcripts.length; i += 100) await putTranscriptRows(transcripts.slice(i, i + 100));
  const merged = [...new Set([...saved, ...sv])];
  if (merged.length !== saved.length) { saved = merged; await setMeta('saved', saved); renderSaved(); }
  await load(true);
  run();
  chrome.runtime.sendMessage({ type: 'q:index' });
  return { count: tweets.length, added, nVec };
}
const bkMsg = (t) => { $('bk-msg').textContent = t; };

$('bk-export').onclick = async () => {
  const pass = $('bk-pass').value;
  bkMsg('Préparation de l’export…');
  try {
    const { bytes, count, nVec } = await buildBackup(pass);
    download(bytes, `x-bookmarks-${isoDay(Date.now())}.${pass ? 'xbsbak' : 'json'}`);
    bkMsg(`${count} bookmarks${nVec ? ` + ${nVec} vecteurs` : ''} exportés${pass ? ' (chiffrés)' : ''}.`);
  } catch (err) { bkMsg('⚠ ' + err.message); }
};
$('bk-import').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const r = await restoreBackup(new Uint8Array(await f.arrayBuffer()), $('bk-pass').value);
    bkMsg(`${r.count} bookmarks lus, ${r.added} nouveaux${r.nVec ? `, ${r.nVec} vecteurs restaurés` : ''}.`);
  } catch (err) { bkMsg('⚠ ' + err.message); }
};

let dirHandle = null;
function setDirUi(h) {
  dirHandle = h || null;
  $('bk-save').disabled = $('bk-load').disabled = !dirHandle;
  if (dirHandle) bkMsg(`Dossier de synchro : ${dirHandle.name}`);
}
const dirFile = () => `x-bookmarks-backup.${$('bk-pass').value ? 'xbsbak' : 'json'}`;
async function dirPermission() {
  if ((await dirHandle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await dirHandle.requestPermission({ mode: 'readwrite' })) === 'granted';
}
$('bk-dir').onclick = async () => {
  if (!window.showDirectoryPicker) return bkMsg('⚠ Ce navigateur ne permet pas de choisir un dossier.');
  try {
    const h = await window.showDirectoryPicker({ mode: 'readwrite' });
    await setMeta('syncDir', h);
    setDirUi(h);
  } catch { /* annulé */ }
};
$('bk-save').onclick = async () => {
  try {
    if (!(await dirPermission())) return bkMsg('⚠ Accès au dossier refusé.');
    const { bytes, count, nVec } = await buildBackup($('bk-pass').value);
    const w = await (await dirHandle.getFileHandle(dirFile(), { create: true })).createWritable();
    await w.write(bytes);
    await w.close();
    bkMsg(`${count} bookmarks${nVec ? ` + ${nVec} vecteurs` : ''} sauvegardés dans ${dirHandle.name}/${dirFile()}`);
  } catch (err) { bkMsg('⚠ ' + err.message); }
};
$('bk-load').onclick = async () => {
  try {
    if (!(await dirPermission())) return bkMsg('⚠ Accès au dossier refusé.');
    let file;
    for (const ext of $('bk-pass').value ? ['xbsbak', 'json'] : ['json', 'xbsbak']) {
      try { file = await (await dirHandle.getFileHandle(`x-bookmarks-backup.${ext}`)).getFile(); break; } catch {}
    }
    if (!file) return bkMsg('⚠ Aucune sauvegarde trouvée dans ce dossier.');
    const r = await restoreBackup(new Uint8Array(await file.arrayBuffer()), $('bk-pass').value);
    bkMsg(`${r.count} bookmarks lus depuis ${file.name}, ${r.added} nouveaux${r.nVec ? `, ${r.nVec} vecteurs restaurés` : ''}.`);
  } catch (err) { bkMsg('⚠ ' + err.message); }
};

// ---------- banc d'essai ----------
$('bench-in').value = '[\n  {"q": "mémoire des agents", "expect": ["long-term memory", "@karpathy"]}\n]';
$('bench-run').onclick = async () => {
  const out = $('bench-out');
  let cases;
  try { cases = JSON.parse($('bench-in').value); if (!Array.isArray(cases)) throw new Error(); } catch { out.textContent = '⚠ JSON invalide.'; return; }
  const hasVec = index.vectorCount() > 0;
  const configs = [
    { name: 'Mots-clés seuls', mode: 'kw' },
    ...(hasVec ? [
      { name: 'Sémantique seul', mode: 'sem' },
      { name: 'Hybride 1 : 1', mode: 'hybrid', weights: [1, 1] },
      { name: 'Hybride 1,5 : 0,7 (défaut phrases)', mode: 'hybrid', weights: [1.5, 0.7] },
      { name: 'Hybride 0,7 : 1,5', mode: 'hybrid', weights: [0.7, 1.5] },
      { name: 'Sens d’abord (10 : 0,1) — réglage « 🌐 Sens d’abord »', mode: 'hybrid', weights: BLEND.semantic },
    ] : []),
  ];
  out.textContent = 'Calcul…';
  const rows = [];
  for (const cfg of configs) {
    const scores = [];
    for (const c of cases) {
      try {
        const r = await coreSearch(c.q, null, cfg);
        scores.push(evalScore(r.rows.map(([row]) => index.tweets[row]), c.expect || []));
      } catch { scores.push({ hit10: 0, rr: 0, firstRank: null }); }
    }
    const s = summarize(scores);
    rows.push(`<tr><td>${esc(cfg.name)}</td><td>${(s.recall10 * 100).toFixed(0)} %</td><td>${s.mrr.toFixed(3)}</td></tr>`);
  }
  out.innerHTML = `<table><tr><th>Configuration (${cases.length} requêtes)</th><th>Rappel@10</th><th>MRR</th></tr>${rows.join('')}</table>` +
    (hasVec ? '' : '<p class="hint">Aucun vecteur : seuls les mots-clés sont évalués.</p>');
};

// ---------- état du modèle / de l'indexation ----------
let pollT = 0;
function pollStatusSoon() { if (pollT) return; pollT = setTimeout(() => { pollT = 0; pollStatus(); }, 2500); } // au plus un relevé d'état toutes les 2,5 s
async function pollStatus() {
  try {
    const st = await chrome.runtime.sendMessage({ type: 'q:status' });
    const el = $('index');
    el.classList.toggle('err', st?.model === 'error' || (!!st?.error && !st?.indexing));
    $('retry').hidden = !(st?.error);
    if (!st) return;
    const parts = [];
    if (st.error) parts.push('Recherche sémantique indisponible : ' + st.error);
    else if (st.model === 'loading') parts.push(`Recherche sémantique : téléchargement du modèle ${st.pct ?? 0}% (une seule fois, ~300 Mo)…`);
    else if (st.indexing) parts.push(`Recherche sémantique : indexation ${st.done}/${st.total}${st.device ? ' (' + st.device + (st.threads > 1 ? ' ×' + st.threads : '') + ')' : ''}…`);
    else if (st.model === 'ready') parts.push('Recherche sémantique prête' + (st.device ? ' (' + st.device + (st.threads > 1 ? ' ×' + st.threads : '') + (st.dtype ? ', ' + st.dtype : '') + ')' : ''));
    else if (st.asleep && !st.paused) parts.push('Recherche sémantique prête (modèle en veille : rechargé à la prochaine recherche)');
    if (st.enrich?.active) parts.push(`liens : ${st.enrich.done}/${st.enrich.total}`);
    if (st.images?.active) parts.push(`images : ${st.images.done}/${st.images.total}`);
    if (st.images?.error) parts.push('images : ' + st.images.error);
    el.textContent = parts.join(' · ');
    const pending = index.tweets.length - index.vectorCount();
    const btn = $('idx-now');
    btn.hidden = !(st.indexing || pending > 0);
    btn.textContent = st.indexing ? '■ Arrêter l’indexation' : `▶ Indexer ${pending.toLocaleString('fr-FR')} tweets`;
    btn.onclick = st.indexing ? stopIndex : runIndex;
    const mine = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
    $('mem-info').textContent = `Tas JS : panneau ${mine ?? '?'} Mo · moteur de calcul ${st.memMB ?? '?'} Mo · état ${st.asleep ? 'en veille' : st.indexing ? 'indexation en cours' : 'actif'} · recyclages du modèle : ${st.recycles ?? 0}. (La mémoire GPU n'est pas mesurable ici : vois le Gestionnaire de tâches du navigateur.)`;
  } catch {}
}
$('retry').onclick = () => { chrome.runtime.sendMessage({ type: 'q:index', force: true }); setTimeout(pollStatus, 500); };
setInterval(pollStatus, 2500);

// ---------- messages de l'extension ----------
let reloadTimer, lastHeavy = 0, needFull = false;
// Les synchros YouTube modifient des vidéos déjà connues en rafale : au plus un rechargement complet par `gap` (pas un par page).
let updTimer = null, lastUpdLoad = 0;
function scheduleUpdatedReload() {
  if (updTimer) return;
  let gap = 20000;
  try { gap = Number(localStorage.getItem('xbs.reloadGap')) || gap; } catch {}
  updTimer = setTimeout(() => { updTimer = null; lastUpdLoad = Date.now(); scheduleReload(0, true); }, Math.max(1500, lastUpdLoad + gap - Date.now()));
}
let needRender = false;
function scheduleReload(delay = 3000, full = false, render = true) {
  needFull ||= full;
  needRender ||= render;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    const f = needFull, r = needRender; needFull = needRender = false;
    await load(f);
    if (r && !$('q').value.trim() && !$('answer').firstChild) run(); // la liste « derniers bookmarks » se met à jour ; une recherche en cours n'est jamais perturbée
  }, delay);
}

chrome.runtime.onMessage.addListener((m) => {
  switch (m.type) {
    case 'tweetsAdded': scheduleReload(); break;
    case 'tweetsUpdated': scheduleUpdatedReload(); break;
    case 'tweetsEnriched': scheduleReload(500, true); pollStatus(); break;
    case 'tweetsRemoved': scheduleReload(200, true); renderBanners(); break;
    case 'orphans': case 'parseWarning': renderBanners(); break;
    case 'indexProgress':
      // pendant l'indexation : on recharge rarement (les vecteurs seuls) et sans redessiner la liste, pour ne pas faire ramer le panneau
      if (Date.now() - lastHeavy > 180000) { lastHeavy = Date.now(); scheduleReload(500, false, false); }
      pollStatusSoon();
      break;
    case 'indexDone': scheduleReload(500); pollStatus(); break;
    case 'indexError': case 'modelProgress': case 'enrichProgress': case 'imageProgress': pollStatus(); break;
    case 'updateProgress': {
      const end = m.step === 'end';
      updatingUi = !end;
      $('update-all').hidden = !end; $('stop').hidden = end;
      if (!end) { $('progress').textContent = m.label; break; }
      const r = m.report || {}, bits = [];
      if (r.x != null) bits.push(`X : ${r.x === 'impossible' ? 'impossible' : r.x + ' lus'}`);
      if (r.playlists != null) bits.push(`playlists : ${r.playlists}`);
      if (r.history != null) bits.push(`historique : ${r.history}`);
      if (r.transcripts != null) bits.push(`transcriptions : ${r.transcripts}`);
      $('progress').textContent = m.label + (bits.length ? ' — ' + bits.join(' · ') : '');
      scheduleReload(1000, true);
      break;
    }
    case 'ytProgress': {
      if (m.state === 'playlist-done') break;
      const running = m.state === 'running';
      if (!updatingUi) $('stop').hidden = !running;
      $('yt-sync').hidden = $('yt-hist').hidden = $('yt-tr').hidden = running;
      $('progress').textContent = { running: m.transcripts ? `YouTube : transcriptions ${m.done}/${m.total}${m.total - m.done > 30 ? ` · reste ≈ ${etaText((m.total - m.done) / (m.rate || 0.4))}` : ''} (${m.ok} récupérées${m.last ? ` ; dernier échec : ${m.last}` : ''})…` : m.history ? `YouTube : historique — ${m.count ?? 0} visionnages lus${m.day ? ` (jusqu’au ${m.day})` : ''}…` : `YouTube : ${m.playlist ? m.playlist + ' — ' : ''}${m.count ?? 0} vidéos${m.lists ? ` (${m.listIndex}/${m.lists} playlists)` : ''}…`,
        done: m.transcripts ? `YouTube : transcriptions terminées — ${m.ok} récupérées, ${m.none} sans transcription${m.fail ? `, ${m.fail} en échec` : ''}${m.reasons ? ' — ' + m.reasons : ''}` : m.history ? `YouTube : historique terminé — ${m.total} visionnages lus, ${m.fresh ?? 0} nouveaux` : `YouTube : terminé — ${m.total} vidéos dans ${m.lists} playlists${m.incomplete ? ` (${m.incomplete} incomplète(s))` : ''}`, stopped: 'YouTube : arrêté' }[m.state] || ('YouTube : ' + (m.message || m.state));
      break;
    }
    case 'backfillProgress': {
      const running = m.state === 'running';
      if (!updatingUi) $('stop').hidden = !running;
      $('sync').hidden = $('news').hidden = running;
      const kind = m.mode === 'incremental' ? 'Nouveautés' : 'Synchro';
      $('progress').textContent = { running: `${kind} : ${m.total} tweets lus`, done: `${kind} terminée (${m.total} lus)`, stopped: `${kind} arrêtée` }[m.state] || m.message || '';
      break;
    }
  }
});
chrome.storage.onChanged.addListener(async (ch, area) => {
  if (area === 'local' && ch.settings) {
    const prevImg = settings.linkImages;
    settings = await getSettings();
    applySettingsUi();
    if (prevImg !== settings.linkImages) render();
    if (applyModel()) { await load(true); run(); pollStatus(); }
  }
});

// ---------- démarrage ----------
(async () => {
  settings = await getSettings();
  index.trChars = settings.ytTrWords;
  applyModel();
  saved = (await getMeta('saved')) || [];
  renderSaved();
  renderHistory();
  applySettingsUi();
  const initialQ = new URLSearchParams(location.search).get('q'); // lien depuis la page de statistiques
  if (initialQ) $('q').value = initialQ;
  await load(true);
  run();
  renderBanners();
  pollStatus();
})();
