// Outils exposés à un client MCP (Claude Desktop, Claude Code…) : lecture seule dans l'index de l'extension.
// Module pur : l'index, l'embedding et la base arrivent par `ctx` (voir bridge.js), ce qui permet de le tester sans navigateur.
import { parseQuery, rrf, contentWords, sortRows, tokenize, normalizeText } from './search.js';
import { isVideoItem } from './youtube.js';
import { semanticQuery, decodeEntities } from './text.js';
import { videoPubMs } from './ytdate.js';
import { snowflakeMs, dayKey } from './time.js';
import { fmtTime } from './transcript.js';
import { bestPassages, runExtract } from './extract.js';

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const day = (ms) => (ms != null && Number.isFinite(ms) ? dayKey(ms) : null);
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };

// Vue compacte d'un élément (tweet ou vidéo) : ce qu'un modèle a besoin de lire, sans les champs internes.
export function itemView(t, { full = false } = {}) {
  const video = isVideoItem(t);
  const out = {
    id: t.id,
    kind: video ? 'youtube' : 'x',
    author: video ? t.name || t.handle : `${t.name || ''} (@${t.handle})`.trim(),
    published: video ? day(videoPubMs(t)) : t.createdAt ? t.createdAt.slice(0, 10) : null,
    saved: video ? day(t.addedAt) : t.sortIndex ? day(snowflakeMs(t.sortIndex)) : null,
    url: t.url,
    text: clip(t.text, full ? 6000 : 600),
  };
  if (video) {
    out.duration = t.durationText || undefined;
    out.playlists = (t.playlists || []).map((p) => p.title || p.id);
    if ((t.watched || []).length) out.watched = t.watched.slice(-5);
    out.hasTranscript = t.trState === 'ok';
  } else {
    const s = t.stats || {};
    out.stats = { likes: s.likes || 0, reposts: s.reposts || 0, views: s.views || undefined };
    if (t.links?.length) out.links = t.links.slice(0, 5);
    if (t.quoted?.text) out.quoted = { author: t.quoted.handle ? '@' + t.quoted.handle : undefined, text: clip(t.quoted.text, full ? 2000 : 240) };
    if (t.media?.length) out.media = [...new Set(t.media.map((m) => m.type))];
  }
  return JSON.parse(JSON.stringify(out)); // sans les clés vides
}

export { bestPassages };

export const htmlToText = (html) => decodeEntities(String(html || '')
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<section[^>]*class="page[^"]*"[^>]*>/gi, '\n\n=== nouvelle page ===\n')
  .replace(/<\/(p|h[1-6]|div|li|tr|figcaption|blockquote)>|<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// ctx : { getIndex(): Promise<Index>, embed(text): Promise<Float32Array>, getTranscripts(ids): Promise<Map>, playlists(): Promise<[]>,
//         journals(): Promise<[]>, journal(id): Promise<{html}|null> }
export function createTools(ctx) {
  const rowOf = async (id) => { const index = await ctx.getIndex(); const row = index.rowById.get(String(id)); if (row === undefined) throw new Error(`élément inconnu : ${id}`); return { index, row, t: index.tweets[row] }; };

  // sélection d'éléments (filtres + texte) : partagée par search et extract
  async function pick(a) {
    const index = await ctx.getIndex();
    const parsed = parseQuery(String(a.query || ''));
    const filters = { ...parsed.filters };
    const notes = [];
    for (const k of ['is', 'during', 'jev', 'official', 'primary', 'dedupe']) if (filters[k] !== undefined) { delete filters[k]; notes.push(`opérateur « ${k}: » non disponible via MCP : ignoré`); }
    if (a.source === 'x' || a.source === 'youtube') filters.source = a.source;
    if (/^\d{4}-\d{2}-\d{2}$/.test(a.since || '')) filters.since = a.since;
    if (/^\d{4}-\d{2}-\d{2}$/.test(a.until || '')) filters.until = a.until;
    if (a.from) filters.from = String(a.from).replace(/^@/, '').toLowerCase();
    const text = parsed.text.trim();
    const mask = index.allowedMask(filters);
    let rows, mode = a.mode === 'keywords' || a.mode === 'semantic' ? a.mode : 'hybrid', sort = ['newest', 'oldest', 'likes', 'added'].includes(a.sort) ? a.sort : 'relevance';
    if (!text) { // pas de mots : liste filtrée, la plus récemment ajoutée d'abord
      rows = index.tweets.map((_, i) => [i, 0]).filter(([i]) => !mask || mask[i]);
      if (sort === 'relevance') sort = 'added';
      mode = 'filtre';
    } else {
      const kw = index.bm25(text, mask, 200);
      let sem = [];
      if (mode !== 'keywords') {
        try {
          const qv = await ctx.embed(semanticQuery(text));
          if (qv.length !== index.dim) throw new Error('dimension des vecteurs différente (modèle changé ?)');
          sem = index.vector(qv, mask, 200);
          if (!sem.length) notes.push('aucun élément indexé sémantiquement : résultats par mots-clés seulement');
        } catch (e) { notes.push(`recherche par le sens indisponible (${e.message}) : mots-clés seulement`); mode = 'keywords'; }
      }
      rows = mode === 'keywords' ? kw : mode === 'semantic' ? sem : rrf([sem, kw], contentWords(text) >= 3 ? [1.5, 0.7] : [1, 1]);
    }
    const total = rows.length;
    if (sort !== 'relevance') rows = sortRows(rows.slice(0, 1500), index.tweets, sort === 'added' ? 'addednew' : sort);
    return { index, rows, total, text, mode, notes };
  }

  async function search(a) {
    const brief = !!a.brief, limit = num(a.limit, brief ? 100 : 10, 1, brief ? 200 : 50), offset = num(a.offset, 0, 0, 100000);
    const { index, rows, total, text, mode, notes } = await pick(a);
    const top = rows.slice(offset, offset + limit);
    const terms = text ? tokenize(text) : [];
    const trs = terms.length && !brief ? await ctx.getTranscripts(top.map(([r]) => index.tweets[r]).filter((t) => t.trState === 'ok').map((t) => t.id)) : new Map();
    const results = top.map(([r]) => {
      const t = index.tweets[r];
      if (brief) { const v = itemView(t); return { id: v.id, title: clip(t.text, 140), published: v.published, duration: v.duration, hasTranscript: v.hasTranscript, author: isVideoItem(t) ? undefined : v.author }; }
      const v = itemView(t), ch = trs.get(t.id);
      if (ch) { const p = bestPassages(ch, terms, 1)[0]; if (p) v.passage = { at: fmtTime(p.at), seconds: p.at, text: clip(p.text, 400), link: `${t.url}${t.url.includes('?') ? '&' : '?'}t=${p.at}s` }; }
      return v;
    });
    return { mode, matches: total, offset, shown: results.length, ...(offset + results.length < Math.min(total, 1500) ? { next_offset: offset + results.length } : {}), ...(notes.length ? { notes } : {}), results };
  }

  return {
    search,

    // Lecture en masse par un modèle peu coûteux (réglé dans ⚙ › Pont MCP) : seules les réponses reviennent à l'assistant.
    async extract(a) {
      const question = String(a.question || '').trim();
      if (!question) throw new Error('question requise');
      let vids, next;
      if (Array.isArray(a.ids) && a.ids.length) {
        const index = await ctx.getIndex();
        vids = a.ids.slice(0, 300).map((id) => index.tweets[index.rowById.get(String(id))]).filter((v) => v && isVideoItem(v));
      } else {
        const p = await pick({ ...a, source: 'youtube', query: a.query || '' });
        const limit = num(a.limit, 60, 1, 300), offset = num(a.offset, 0, 0, 100000);
        vids = p.rows.slice(offset, offset + limit).map(([r]) => p.index.tweets[r]).filter(isVideoItem);
        if (offset + limit < Math.min(p.total, 1500)) next = offset + limit;
      }
      if (!vids.length) return { videos: 0, note: 'aucune vidéo ne correspond à la sélection' };
      const cfg = await ctx.extractCfg();
      const budget = Math.min(5, Math.max(0.01, Number(a.max_cost) || cfg.budget));
      const r = await runExtract({ llm: cfg.llm, cache: cfg.cache, getTranscripts: ctx.getTranscripts, model: cfg.model, prices: cfg.prices }, vids, question, { budget, estimateOnly: !!a.estimate });
      if (r.results) { const byId = new Map(vids.map((v) => [v.id, v])); for (const x of r.results) x.published = itemView(byId.get(x.id) || {}).published; }
      return { ...r, ...(next !== undefined ? { next_offset: next } : {}), budgetUsd: budget };
    },

    async get_item({ id }) { const { t } = await rowOf(id); return itemView(t, { full: true }); },

    async get_transcript({ id, query, from_seconds, max_chars }) {
      const { t } = await rowOf(id);
      if (!isVideoItem(t)) throw new Error('cet élément n’est pas une vidéo');
      const ch = (await ctx.getTranscripts([t.id])).get(t.id);
      if (!ch?.length) return { id: t.id, title: t.text, hasTranscript: false, note: 'pas de transcription pour cette vidéo' };
      if (query) return { id: t.id, title: t.text, passages: bestPassages(ch, tokenize(String(query)), 6).sort((x, y) => x.at - y.at).map((p) => ({ at: fmtTime(p.at), seconds: p.at, text: clip(p.text, 800) })) };
      const from = num(from_seconds, 0, 0, 1e7), cap = num(max_chars, 6000, 500, 20000);
      let out = '', last = from, more = false;
      for (const c of ch) {
        if ((c.t || 0) < from) continue;
        const line = `[${fmtTime(Math.floor(c.t || 0))}] ${String(c.text).replace(/\s+/g, ' ').trim()}\n`;
        if (out.length + line.length > cap) { more = true; break; }
        out += line; last = c.t || 0;
      }
      return { id: t.id, title: t.text, duration: t.durationText, text: out.trim(), ...(more ? { next_from_seconds: Math.floor(last) + 1 } : {}) };
    },

    async similar({ id, limit, source }) {
      const { index, row } = await rowOf(id);
      if (!index.hasVec[row]) throw new Error('cet élément n’est pas encore indexé sémantiquement');
      const mask = source === 'x' || source === 'youtube' ? index.allowedMask({ source }) : null;
      const q = index.matrix.subarray(row * index.dim, (row + 1) * index.dim);
      const rows = index.vector(q, mask, num(limit, 10, 1, 30) + 1).filter(([r]) => r !== row).slice(0, num(limit, 10, 1, 30));
      return { results: rows.map(([r, s]) => ({ similarity: Math.round(s * 1000) / 1000, ...itemView(index.tweets[r]) })) };
    },

    async list_playlists() { return { playlists: (await ctx.playlists()).map((p) => ({ id: p.id, title: p.title, videos: p.n })) }; },

    async stats() {
      const index = await ctx.getIndex();
      let videos = 0, tr = 0, watched = 0;
      const authors = new Map(), months = new Map();
      for (const t of index.tweets) {
        const v = isVideoItem(t);
        if (v) { videos++; if (t.trState === 'ok') tr++; if ((t.watched || []).length) watched++; }
        const k = v ? t.name : '@' + t.handle;
        authors.set(k, (authors.get(k) || 0) + 1);
        const ms = v ? t.addedAt : t.sortIndex ? snowflakeMs(t.sortIndex) : null;
        const d = day(ms);
        if (d) months.set(d.slice(0, 7), (months.get(d.slice(0, 7)) || 0) + 1);
      }
      return { items: index.tweets.length, tweets: index.tweets.length - videos, videos, videosWithTranscript: tr, videosWatched: watched, indexedSemantically: index.vectorCount(),
        topAuthors: [...authors].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, n]) => ({ name, n })),
        savedPerMonth: [...months].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12).map(([month, n]) => ({ month, n })) };
    },

    async journal_list() { return { editions: (await ctx.journals()).map((e) => ({ id: e.id, week: e.label, pages: e.pages, subjects: e.subjects, generated: new Date(e.at).toISOString().slice(0, 10) })) }; },

    async journal_read({ id, offset, max_chars }) {
      const ed = await ctx.journal(String(id));
      if (!ed?.html) throw new Error('édition inconnue : voir journal_list');
      const text = htmlToText(ed.html), from = num(offset, 0, 0, 1e8), cap = num(max_chars, 12000, 1000, 40000);
      return { id, length: text.length, offset: from, text: text.slice(from, from + cap), ...(from + cap < text.length ? { next_offset: from + cap } : {}) };
    },
  };
}

export { TOOL_DEFS } from './mcp-defs.js';
