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

export class Index {
  constructor() {
    this.tweets = []; // docs, ordre = lignes
    this.rowById = new Map();
    this.postings = new Map(); // terme -> [[row, tf], ...]
    this.docLen = [];
    this.avgLen = 0;
    this.matrix = new Float32Array(0); // n * DIM
    this.hasVec = new Uint8Array(0);
    this.vocab = null; // tableau trié, pour les préfixes
  }

  build(tweets, vectorsById) {
    this.tweets = tweets;
    const n = tweets.length;
    this.rowById = new Map();
    this.postings = new Map();
    this.docLen = new Array(n);
    this.matrix = new Float32Array(n * DIM);
    this.hasVec = new Uint8Array(n);
    let total = 0;
    for (let row = 0; row < n; row++) {
      const t = tweets[row];
      this.rowById.set(t.id, row);
      const tf = new Map();
      const toks = tokenize(tweetText(t) + ' ' + (t.links || []).join(' '));
      for (const tok of toks) tf.set(tok, (tf.get(tok) || 0) + 1);
      this.docLen[row] = toks.length;
      total += toks.length;
      for (const [tok, c] of tf) {
        let p = this.postings.get(tok);
        if (!p) this.postings.set(tok, (p = []));
        p.push([row, c]);
      }
      const v = vectorsById?.get(t.id);
      if (v && v.length === DIM) {
        this.matrix.set(v, row * DIM);
        this.hasVec[row] = 1;
      }
    }
    this.avgLen = n ? total / n : 0;
    this.vocab = null;
  }

  vectorCount() {
    let c = 0;
    for (const x of this.hasVec) c += x;
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
      const o = row * DIM;
      for (let d = 0; d < DIM; d++) s += M[o + d] * queryVec[d];
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
