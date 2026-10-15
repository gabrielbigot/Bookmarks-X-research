// Stats personnalisées du tableau de bord : une requête (syntaxe de la recherche) ou un « détecteur » (sens), comptés dans le temps.
// Fonctions pures : testées sans navigateur.
import { dayKey } from './time.js';
import { parseQuery, passesFilters, normalizeText, tokenize, tweetText } from './search.js';
import { isStopword, decodeEntities } from './text.js';
import { isVideoItem } from './youtube.js';
import { count, top, seriesFrom, eachDay } from './stats.js';

const DAY = 86_400_000;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const slugOf = (name) => normalizeText(name || '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'detecteur';

// ---- requêtes : opérateurs + mots (tous les mots doivent apparaître, début de mot, sans accents ni casse) ----
export function compileQuery(q, source = 'all') {
  const { text, filters } = parseQuery(q || '');
  if (source === 'x' || source === 'youtube') filters.source = source;
  const words = tokenize(text).filter((t) => !isStopword(t));
  return { filters, res: words.map((w) => new RegExp('(?:^|[^a-z0-9])' + escRe(w))), empty: !words.length && !Object.keys(filters).length };
}
const normCache = new WeakMap();
const normOf = (t) => {
  let n = normCache.get(t);
  if (n === undefined) { n = normalizeText(tweetText(t) + ' ' + (t.links || []).join(' ')); normCache.set(t, n); }
  return n;
};
export function matchItem(t, cq) {
  if (!passesFilters(t, cq.filters)) return false;
  if (!cq.res.length) return true;
  const n = normOf(t);
  return cq.res.every((r) => r.test(n));
}

// ---- jours d'un élément (pour la période) ----
// tweet : jour d'enregistrement si fiable, sinon de publication ; vidéo : jours de visionnage, sinon jour d'ajout.
export function eventDays(t, sv) {
  if (isVideoItem(t)) {
    if ((t.watched || []).length) return t.watched;
    const ms = t.addedAt || t.capturedAt;
    return ms ? [dayKey(ms)] : [];
  }
  const ms = sv?.valid ? sv.at(t) : t.createdAt ? Date.parse(t.createdAt) : null;
  return ms != null && Number.isFinite(ms) ? [dayKey(ms)] : [];
}

// ---- détecteurs (sens) : score = meilleure similarité entre les exemples et le vecteur de l'élément (ou l'un de ses passages) ----
export function detectorScores(vecMap, chunkMap, protos) {
  const out = new Map();
  if (!protos?.length) return out;
  const dot = (a, ao, b) => { let s = 0; for (let d = 0; d < b.length; d++) s += a[ao + d] * b[d]; return s; };
  for (const [id, v] of vecMap) {
    let best = -1;
    for (const p of protos) if (p.length === v.length) { const s = dot(v, 0, p); if (s > best) best = s; }
    out.set(id, best);
  }
  for (const [id, { vecs, k }] of chunkMap || []) {
    for (const p of protos) for (let c = 0; c < k; c++) { const s = dot(vecs, c * p.length, p); if (s > (out.get(id) ?? -1)) out.set(id, s); }
  }
  return out;
}
// Éléments retenus : score ≥ seuil, plus ceux que tu as validés (✓), moins ceux que tu as écartés (✗).
export function detectorSet(scores, det) {
  const set = new Set();
  for (const [id, s] of scores) if (s >= det.threshold) set.add(id);
  for (const id of det.pos || []) set.add(id);
  for (const id of det.neg || []) set.delete(id);
  return set;
}
// Pour régler le seuil : les moins sûrs retenus et les plus proches écartés (hors validations manuelles).
export function detectorMargin(scores, det, n = 8) {
  const fixed = new Set([...(det.pos || []), ...(det.neg || [])]);
  const rows = [...scores].filter(([id]) => !fixed.has(id));
  const above = rows.filter(([, s]) => s >= det.threshold).sort((a, b) => a[1] - b[1]).slice(0, n);
  const below = rows.filter(([, s]) => s < det.threshold).sort((a, b) => b[1] - a[1]).slice(0, n);
  return { above, below };
}

// ---- évaluation d'une stat ----
// w : { kind: 'number'|'series'|'top', q, det, source, by, ... } ; ctx : { sv, now, rangeDays, detSets: Map(id -> Set) }
export function evalWidget(items, w, ctx) {
  const now = ctx.now ?? Date.now();
  const cq = compileQuery(w.q, w.source);
  const detSet = w.det ? ctx.detSets?.get(w.det) : null;
  const todayKey = dayKey(now);
  const R = ctx.rangeDays;
  const fromKey = R ? dayKey(now - (R - 1) * DAY) : null;
  const prevFrom = R ? dayKey(now - (2 * R - 1) * DAY) : null;
  const inRange = (d) => (!fromKey || d >= fromKey) && d <= todayKey;
  const inPrev = (d) => R && d >= prevFrom && d < fromKey;
  const perDay = new Map(), matched = [];
  let n = 0, prev = 0, noDate = 0;
  for (const t of items) {
    if (w.det && !detSet?.has(t.id)) continue;
    if (!matchItem(t, cq)) continue;
    const days = eventDays(t, ctx.sv);
    if (!days.length) { noDate++; if (!R) { n++; matched.push({ t, day: '' }); } continue; }
    let hit = null, p = false;
    for (const d of days) {
      if (inRange(d)) { count(perDay, d); if (!hit || d > hit) hit = d; }
      if (inPrev(d)) p = true;
    }
    if (hit) { n++; matched.push({ t, day: hit }); }
    if (p) prev++;
  }
  matched.sort((a, b) => (a.day < b.day ? 1 : -1));
  const keys = [...perDay.keys()].sort();
  const startKey = fromKey || keys[0] || todayKey;
  const out = { n, prev: R ? prev : null, noDate, matched, startKey, endKey: todayKey };
  if (w.kind === 'series') out.series = seriesFrom(perDay, startKey, todayKey);
  if (w.kind === 'top') {
    const groups = new Map(), names = new Map();
    for (const { t } of matched) {
      const keysOf = w.by === 'site' ? [...new Set((t.links || []).map((l) => { try { return new URL(l).hostname.replace(/^www\./, ''); } catch { return ''; } }).filter((h) => h && !/^(x\.com|twitter\.com|t\.co)$/.test(h)))]
        : w.by === 'lang' ? (t.lang ? [t.lang] : []) : [t.handle];
      for (const k of keysOf) { count(groups, k); if (!names.has(k)) names.set(k, t.name || k); }
    }
    out.top = top(groups, 15).map(([k, c]) => ({ key: k, label: w.by === 'author' || !w.by ? (names.get(k) && names.get(k) !== k ? `${names.get(k)} (@${k})` : '@' + k) : k, n: c }));
  }
  return out;
}

export const textOf = (t) => decodeEntities(isVideoItem(t) ? t.text : t.text || '').replace(/\s+/g, ' ').slice(0, 160);
export { eachDay };
