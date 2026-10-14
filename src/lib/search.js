// Recherche hybride : BM25 (mots-clés) + similarité cosinus (embeddings), fusionnées par RRF.
import { decodeEntities, isStopword } from './text.js';
export const DIM = 256;

export function normalizeText(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function tokenize(s) {
  return normalizeText(s)
    .split(/[^a-z0-9_@#+.]+/)
    .map((t) => t.replace(/^[.@#]+|[.]+$/g, ''))
    .filter((t) => t.length >= 2);
}

// Texte indexé pour un tweet (BM25 et embedding).
export function tweetText(t) {
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
  for (const part of q.split(/\s+/).filter(Boolean)) {
    const m = part.match(/^(from|has|since|until|lang):(.+)$/i);
    if (!m) { rest.push(part); continue; }
    const k = m[1].toLowerCase();
    const v = m[2].replace(/^@/, '');
    if (k === 'from') filters.from = v.toLowerCase();
    else if (k === 'has') (filters.has ??= []).push(v.toLowerCase());
    else if (k === 'since') filters.since = v;
    else if (k === 'until') filters.until = v;
    else if (k === 'lang') filters.lang = v.toLowerCase();
  }
  return { text: rest.join(' '), filters };
}

export function passesFilters(t, f) {
  if (f.from && t.handle.toLowerCase() !== f.from) return false;
  if (f.fromAny && !f.fromAny.includes(t.handle.toLowerCase())) return false;
  if (f.lang && t.lang !== f.lang) return false;
  if (f.since && (!t.createdAt || t.createdAt.slice(0, 10) < f.since)) return false;
  if (f.until && (!t.createdAt || t.createdAt.slice(0, 10) > f.until)) return false;
  for (const h of f.has ?? []) {
    if (h === 'link' && !t.links.length && !t.quoted?.links?.length) return false;
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
      if (!this.hasVec[row] || (allowed && !allowed[row])) continue;
      let s = 0;
      const o = row * this.dim;
      for (let d = 0; d < this.dim; d++) s += M[o + d] * queryVec[d];
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
  const date = (dir) => (a, b) => {
    const x = t(a).createdAt, y = t(b).createdAt;
    if (!x && !y) return 0;
    if (!x) return 1;
    if (!y) return -1;
    return x === y ? 0 : (x < y ? -dir : dir);
  };
  const by = {
    newest: date(-1), // décroissant
    oldest: date(1), // croissant
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
