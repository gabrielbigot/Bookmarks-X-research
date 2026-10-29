// Recherche hybride : BM25 (mots-clés) + similarité cosinus (embeddings), fusionnées par RRF.
import { decodeEntities, isStopword } from './text.js';
import { savedAtOf, dayKey, snowflakeMs } from './time.js';
import { videoPubMs } from './ytdate.js';
import { videoText, isVideoItem } from './youtube.js';
export const DIM = 256;

export function normalizeText(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export const TR_INDEX_CHARS = 20000; // défaut ; réglable (⚙)
export function tokenize(s) {
  return normalizeText(s)
    .split(/[^a-z0-9_@#+.]+/)
    .map((t) => t.replace(/^[.@#]+|[.]+$/g, ''))
    .filter((t) => t.length >= 2);
}

// Texte indexé pour un tweet (BM25 et embedding).
export function tweetText(t) {
  if (isVideoItem(t)) return videoText(t); // vidéo YouTube : titre + chaîne + playlists
  let s = `${t.name} (@${t.handle}) : ${decodeEntities(t.text)}`;
  if (t.quoted) s += `\nCite @${t.quoted.handle} : ${decodeEntities(t.quoted.text)}`;
  const alts = (t.media || []).map((m) => m.alt).filter(Boolean);
  if (alts.length) s += `\n${alts.join(' ')}`;
  if (t.linkText) s += `\nLiens : ${t.linkText}`;
  return s;
}

// Opérateurs : from:@x  has:link  has:media  since:2026-01-01  until:2026-06-30  lang:fr
export function parseQuery(q) {
  const filters = {};
  const rest = [];
  // valeurs entre guillemets : playlist:"à regarder plus tard" -> un seul mot pour le découpage
  const protectedQ = q.replace(/(\w+):"([^"]*)"/g, (_, k, v) => `${k}:${v.replace(/\s+/g, '\u2423')}`);
  for (const part of protectedQ.split(/\s+/).filter(Boolean)) {
    const m = part.replace(/\u2423/g, ' ').match(/^(from|has|since|until|lang|saved|source|playlist|viewed|vu|watched|is|during|quoted|cite|dedupe|group|primary|official|jev):(.+)$/i);
    if (!m) { rest.push(part.replace(/\u2423/g, ' ')); continue; }
    const k = m[1].toLowerCase();
    const v = m[2].replace(/^@/, '');
    if (k === 'from') filters.from = v.toLowerCase();
    else if (k === 'has') (filters.has ??= []).push(v.toLowerCase());
    else if (k === 'since') filters.since = v;
    else if (k === 'until') filters.until = v;
    else if (k === 'lang') filters.lang = v.toLowerCase();
    else if (k === 'source') filters.source = /^(yt|youtube|video|videos|vidéo|vidéos)$/i.test(v) ? 'youtube' : /^(x|twitter|tweet|tweets)$/i.test(v) ? 'x' : undefined;
    else if (k === 'playlist') filters.playlist = v.toLowerCase();
    else if (k === 'during') { // période d'une stat (jour d'enregistrement, de visionnage ou d'ajout selon l'élément) : résolu par l'appelant
      const [a, b] = v.split('..');
      if (/^\d{4}-\d{2}-\d{2}$/.test(a)) filters.during = { from: a, to: /^\d{4}-\d{2}-\d{2}$/.test(b || '') ? b : a };
    }
    else if (k === 'quoted' || k === 'cite') filters.quoted = /^(yes|oui|true|1)$/i.test(v) ? true : /^(no|non|false|0)$/i.test(v) ? false : undefined; // quoted:no = sans citation
    else if (k === 'dedupe' || k === 'group') { // dedupe:oui | non | 0.92,7 (ressemblance minimale, fenêtre en jours)
      if (/^(no|non|false|0|off)$/i.test(v)) filters.dedupe = false;
      else {
        const [a, b] = v.split(',');
        const sim = Number(a), days = Number(b);
        filters.dedupe = { sim: sim >= 0.5 && sim <= 1 ? sim : 0.92, days: days >= 1 && days <= 60 ? Math.round(days) : 7 };
      }
    }
    else if (k === 'primary') filters.primary = /^(yes|oui|true|1)$/i.test(v) ? true : /^(no|non|false|0)$/i.test(v) ? false : undefined; // comptes déclarés « sources primaires »
    else if (k === 'official') filters.official = /^(yes|oui|true|1)$/i.test(v) ? true : /^(no|non|false|0)$/i.test(v) ? false : undefined; // annonces officielles jugées par Jev
    else if (k === 'jev') filters.jev = v; // condition Jev d'une stat (clé), résolue par l'appelant en filters.jevIds
    else if (k === 'is') (filters.is ??= []).push(v.toLowerCase()); // détecteur(s) : plusieurs is: = ET ; is:a,b = OU ; résolu par l'appelant en filters.isIds
    else if (k === 'viewed' || k === 'vu') filters.viewed = /^(yes|oui|true|1|y|o)$/i.test(v) ? true : /^(no|non|false|0|n)$/i.test(v) ? false : undefined;
    else if (k === 'watched') {
      const [a, b] = v.split('..');
      const d = (x) => x === 'today' || x === "aujourd'hui" ? dayKey(Date.now()) : x === 'yesterday' || x === 'hier' ? dayKey(Date.now() - 864e5) : x;
      if (/^\d{4}-\d{2}-\d{2}$/.test(d(a))) filters.watched = { from: d(a), to: /^\d{4}-\d{2}-\d{2}$/.test(d(b || '')) ? d(b) : d(a) };
    }
    else if (k === 'saved') { // saved:2026-10-12  ou  saved:2026-10-01..2026-10-31 (date de mise en bookmark)
      const [a, b] = v.split('..');
      if (/^\d{4}-\d{2}-\d{2}$/.test(a)) filters.saved = { from: a, to: /^\d{4}-\d{2}-\d{2}$/.test(b || '') ? b : a };
    }
  }
  return { text: rest.join(' '), filters };
}

// Compte / chaîne : « @siliconcarnepod », « Silicon Carne » ou « silicon-carne » désignent la même chaîne. On compare des clés sans accents,
// sans emoji ni ponctuation ; égalité, ou inclusion dans un sens ou l'autre quand le plus court a au moins 5 caractères.
export const acctKey = (s) => normalizeText(String(s || '')).replace(/[^a-z0-9]+/g, '');
export function matchAccount(t, token) {
  const k = acctKey(String(token).replace(/^@/, ''));
  if (k.length < 3) return false;
  const cands = [acctKey(t.handle), acctKey(t.name), String(t.channelId || '').toLowerCase()].filter(Boolean);
  return cands.some((c) => c === k || (c.length >= 5 && k.length >= 5 && (c.includes(k) || k.includes(c))));
}

export function passesFilters(t, f) {
  const isVideo = isVideoItem(t);
  if (f.source && (f.source === 'youtube') !== isVideo) return false;
  if (f.isIds && !f.isIds.has(t.id)) return false;
  if (f.primary !== undefined && f.primarySet && (!isVideo && f.primarySet.has(String(t.handle || '').toLowerCase())) !== f.primary) return false;
  if (f.official !== undefined && f.officialIds && (!isVideo && f.officialIds.has(t.id)) !== f.official) return false;
  if (f.jevIds && !isVideo && !f.jevIds.has(t.id)) return false;
  if (f.quoted !== undefined && (!isVideo && !!t.quoted) !== f.quoted) return false;
  if (f.viewed !== undefined) { if (!isVideo) return false; if (!!(t.watched || []).length !== f.viewed) return false; }
  if (f.watched) { if (!(t.watched || []).some((d) => d >= f.watched.from && d <= f.watched.to)) return false; }
  if (f.playlist) { const w = normalizeText(f.playlist); if (!(t.playlists || []).some((p) => normalizeText(p.title || '').includes(w) || p.id.toLowerCase() === f.playlist)) return false; }
  if (f.from && (isVideo ? !matchAccount(t, f.from) : t.handle.toLowerCase() !== f.from)) return false;
  if (f.fromAny && !f.fromAny.includes(t.handle.toLowerCase()) && !(isVideo && f.fromTokens?.some((k) => matchAccount(t, k)))) return false;
  if (f.lang && t.lang !== f.lang) return false;
  if (f.since && (!t.createdAt || t.createdAt.slice(0, 10) < f.since)) return false;
  if (f.until && (!t.createdAt || t.createdAt.slice(0, 10) > f.until)) return false;
  if (f.saved) {
    const ms = savedAtOf(t);
    if (ms === null) return false;
    const d = dayKey(ms);
    if (d < f.saved.from || d > f.saved.to) return false;
  }
  for (const h of f.has ?? []) {
    if (h === 'link' && !t.links.length && !t.quoted?.links?.length) return false;
    if (h === 'transcript' && t.trState !== 'ok') return false;
    if (h === 'notranscript' && (!isVideo || t.trState === 'ok' || t.unavailable)) return false; // vidéos dont la transcription manque (absente chez YouTube ou pas encore récupérée)
    if (h === 'media' && !t.media.length) return false;
    if (h === 'image' && !t.media.some((m) => m.type === 'photo')) return false;
    if (h === 'video' && !t.media.some((m) => m.type === 'video' || m.type === 'animated_gif')) return false;
  }
  return true;
}

export const sortKey = (t) => (t.sortIndex || '').padStart(24, '0');

export class Index {
  constructor(dim = DIM) {
    this.dim = dim;
    this.reset();
  }

  // Change la dimension des vecteurs (changement de modèle) : l'index est vidé.
  setDim(dim) {
    this.dim = dim;
    this.reset();
  }

  reset() {
    this.tweets = []; // docs, ordre d'insertion = lignes
    this.rowById = new Map();
    this.postings = new Map(); // terme -> [[row, tf], ...]
    this.docLen = [];
    this.totalLen = 0;
    this.cap = 0;
    this.matrix = new Float32Array(0); // cap * dim
    this.hasVec = new Uint8Array(0);
    this.trChars = this.trChars || 0; // profondeur d'indexation des transcriptions (caractères) ; 0 = défaut
    this.chunkVecs = new Map(); // ligne -> { vecs (k × dim), k } : passages de transcription
    this.vocab = null; // tableau trié, pour les préfixes
    this._recent = null;
  }

  get avgLen() {
    return this.tweets.length ? this.totalLen / this.tweets.length : 0;
  }

  _grow(n) {
    if (n <= this.cap) return;
    const cap = Math.max(n, Math.ceil(this.cap * 1.5), 1024);
    const m = new Float32Array(cap * this.dim);
    m.set(this.matrix.subarray(0, this.tweets.length * this.dim));
    const h = new Uint8Array(cap);
    h.set(this.hasVec.subarray(0, this.tweets.length));
    this.matrix = m;
    this.hasVec = h;
    this.cap = cap;
  }

  // Ajoute des tweets (les ids déjà connus sont ignorés). Incrémental : pas de reconstruction.
  add(tweets, vectorsById) {
    const fresh = tweets.filter((t) => !this.rowById.has(t.id));
    this._grow(this.tweets.length + fresh.length);
    for (const t of fresh) {
      const row = this.tweets.length;
      this.tweets.push(t);
      this.rowById.set(t.id, row);
      const tf = new Map();
      const toks = tokenize(tweetText(t) + ' ' + (t.links || []).join(' '));
      // transcription : sans mots courants, bornée (mémoire de l'index : des milliers de vidéos × des milliers de mots)
      if (t.transcript) for (const w of tokenize(t.transcript.slice(0, this.trChars || TR_INDEX_CHARS))) if (w.length >= 3 && !isStopword(w)) toks.push(w);
      delete t.transcript; // le texte n'est gardé nulle part en mémoire : seuls les index le sont (les extraits relisent la base)
      for (const tok of toks) tf.set(tok, (tf.get(tok) || 0) + 1);
      this.docLen[row] = toks.length;
      this.totalLen += toks.length;
      for (const [tok, c] of tf) {
        let p = this.postings.get(tok);
        if (!p) this.postings.set(tok, (p = []));
        p.push([row, c]);
      }
      const v = vectorsById?.get(t.id);
      if (v && v.length === this.dim) {
        this.matrix.set(v, row * this.dim);
        this.hasVec[row] = 1;
      }
    }
    if (fresh.length) { this.vocab = null; this._recent = null; }
    return fresh.length;
  }

  setVector(id, vec) {
    const row = this.rowById.get(id);
    if (row === undefined || !vec || vec.length !== this.dim) return false;
    this.matrix.set(vec, row * this.dim);
    this.hasVec[row] = 1;
    return true;
  }

  setChunkVecs(id, vecs, k) {
    const row = this.rowById.get(id);
    if (row === undefined || !vecs || k <= 0 || vecs.length !== k * this.dim) return false;
    this.chunkVecs.set(row, { vecs, k });
    return true;
  }

  build(tweets, vectorsById) {
    this.reset();
    this.add(tweets, vectorsById);
  }

  // Lignes triées par date de mise en bookmark (plus récent d'abord).
  recentRows() {
    if (!this._recent) {
      const rows = this.tweets.map((_, i) => i);
      rows.sort((a, b) => (sortKey(this.tweets[a]) < sortKey(this.tweets[b]) ? 1 : -1));
      this._recent = rows;
    }
    return this._recent;
  }

  vectorCount() {
    let c = 0;
    for (let i = 0; i < this.tweets.length; i++) c += this.hasVec[i];
    return c;
  }

  _expand(tok) {
    // Les termes ≥ 4 caractères matchent aussi par préfixe ("agent" -> "agents", "agentic").
    if (tok.length < 4) return [tok];
    if (!this.vocab) this.vocab = [...this.postings.keys()].sort();
    const out = [];
    let lo = 0, hi = this.vocab.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.vocab[mid] < tok) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < this.vocab.length && this.vocab[i].startsWith(tok) && out.length < 20; i++) out.push(this.vocab[i]);
    return out.length ? out : [tok];
  }

  bm25(text, allowed, limit = 200) {
    const all = tokenize(text);
    // Une phrase libre contient des mots vides ("je cherche des tweets…") qui polluent les mots-clés.
    const kept = all.filter((t) => !isStopword(t));
    const toks = kept.length ? kept : all;
    if (!toks.length) return [];
    const N = this.tweets.length;
    const k1 = 1.4, b = 0.75;
    const scores = new Map();
    for (const q of toks) {
      for (const term of this._expand(q)) {
        const p = this.postings.get(term);
        if (!p) continue;
        const w = term === q ? 1 : 0.6;
        const idf = Math.log(1 + (N - p.length + 0.5) / (p.length + 0.5));
        for (const [row, tf] of p) {
          if (allowed && !allowed[row]) continue;
          const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + (b * this.docLen[row]) / (this.avgLen || 1)));
          scores.set(row, (scores.get(row) || 0) + w * idf * norm);
        }
      }
    }
    return [...scores].sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  vector(queryVec, allowed, limit = 200) {
    const n = this.tweets.length;
    const out = [];
    const M = this.matrix;
    for (let row = 0; row < n; row++) {
      if (allowed && !allowed[row]) continue;
      const ch = this.chunkVecs.get(row);
      if (!this.hasVec[row] && !ch) continue;
      let s = -Infinity;
      if (this.hasVec[row]) {
        s = 0;
        const o = row * this.dim;
        for (let d = 0; d < this.dim; d++) s += M[o + d] * queryVec[d];
      }
      if (ch) { // une vidéo vaut son meilleur passage (titre/description ou transcription)
        for (let c = 0; c < ch.k; c++) {
          let x = 0;
          const o = c * this.dim;
          for (let d = 0; d < this.dim; d++) x += ch.vecs[o + d] * queryVec[d];
          if (x > s) s = x;
        }
      }
      out.push([row, s]);
    }
    out.sort((a, b) => b[1] - a[1]);
    return out.slice(0, limit);
  }

  allowedMask(filters) {
    if (!filters || !Object.keys(filters).length) return null;
    const m = new Uint8Array(this.tweets.length);
    for (let i = 0; i < m.length; i++) m[i] = passesFilters(this.tweets[i], filters) ? 1 : 0;
    return m;
  }
}

// Reciprocal Rank Fusion. lists = [[ [row, score], ... ], ...]
export function rrf(lists, weights = [], k = 60) {
  const acc = new Map();
  lists.forEach((list, li) => {
    const w = weights[li] ?? 1;
    list.forEach(([row], rank) => acc.set(row, (acc.get(row) || 0) + w / (k + rank + 1)));
  });
  return [...acc].sort((a, b) => b[1] - a[1]);
}

export function highlightTerms(text) {
  return [...new Set(tokenize(text))].filter((t) => t.length >= 3);
}

// Nombre de mots "utiles" : sert à pondérer le sémantique face aux mots-clés.
export function contentWords(text) {
  return tokenize(text).filter((t) => !isStopword(t)).length;
}

// Trie des lignes [row, score] par date de publication / likes. Les tweets sans date passent toujours en dernier.
export function sortRows(rows, tweets, how) {
  const t = (r) => tweets[r[0]];
  // clé de date : publication (tweet : createdAt ; vidéo : date estimée) ou ajout (vidéo : première capture ; tweet : ordre du bookmark)
  const key = (x, added) => {
    if (isVideoItem(x)) return added ? x.addedAt || null : videoPubMs(x);
    if (added) return x.sortIndex ? snowflakeMs(x.sortIndex) : null;
    return x.createdAt ? Date.parse(x.createdAt) : null;
  };
  const date = (dir, added) => (a, b) => {
    const x = key(t(a), added), y = key(t(b), added);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (x !== y) return (x - y) * dir;
    const sa = BigInt(t(a).sortIndex || 0), sb = BigInt(t(b).sortIndex || 0); // même instant : ordre de la playlist
    return sa === sb ? 0 : (sa < sb ? -dir : dir);
  };
  const by = {
    newest: date(-1), // publication, décroissant
    oldest: date(1),
    addednew: date(-1, true), // ajout, décroissant
    addedold: date(1, true),
    likes: (a, b) => (t(b).stats?.likes || 0) - (t(a).stats?.likes || 0),
  }[how];
  return by ? [...rows].sort(by) : rows;
}

// Lot de résultats à trier quand l'utilisateur demande « le plus ancien / le plus récent… ».
// Requête courte et précise (« openai ») avec beaucoup de correspondances de mots : on trie TOUTES ces correspondances.
// Sinon : les `size` résultats les mieux classés par la fusion sens + mots-clés.
export function selectPool(fused, kwRows, { words, size = 1500 } = {}) {
  if (words <= 3 && kwRows.length >= 30) {
    const kw = new Set(kwRows.map(([row]) => row));
    return { pool: fused.filter(([row]) => kw.has(row)), kind: 'contenant les mots de la requête' };
  }
  return { pool: fused.slice(0, size), kind: 'les plus pertinents' };
}
