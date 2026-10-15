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
// « a | b | c » : l'un OU l'autre (liant plus fort que l'espace : « lancement robot | humanoid » = lancement ET (robot OU humanoid)).
// Seuls des mots simples se combinent ainsi (pas d'opérateur `clé:valeur` dans une chaîne de « | »).
export function splitOr(q) {
  const pieces = (q || '').replace(/([^\s|:])\|(?=[^\s|:])/g, '$1 | ').split(/\s+/).filter(Boolean); // « a|b » = « a | b »
  const plain = [], groups = [];
  for (let i = 0; i < pieces.length; i++) {
    if (pieces[i] === '|') continue;
    const chain = [pieces[i]];
    if (!pieces[i].includes(':')) {
      while (pieces[i + 1] === '|' && pieces[i + 2] !== undefined && pieces[i + 2] !== '|' && !pieces[i + 2].includes(':')) { chain.push(pieces[i + 2]); i += 2; }
    }
    if (chain.length > 1) groups.push(chain); else plain.push(chain[0]);
  }
  return { plain: plain.join(' '), groups };
}
export function compileQuery(q, source = 'all') {
  const { plain, groups } = splitOr(q);
  const { text, filters } = parseQuery(plain);
  if (source === 'x' || source === 'youtube') filters.source = source;
  const words = tokenize(text).filter((t) => !isStopword(t));
  const res = words.map((w) => new RegExp('(?:^|[^a-z0-9])' + escRe(w)));
  for (const g of groups) {
    const alts = g.flatMap((x) => tokenize(x)).filter(Boolean);
    if (alts.length) res.push(new RegExp('(?:^|[^a-z0-9])(?:' + alts.map(escRe).join('|') + ')'));
  }
  return { filters, res, empty: !res.length && !Object.keys(filters).length };
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
// Les verdicts de Jev dépendent de la description : si elle change, ils ne valent plus.
export const verdictKey = (det) => (det.desc || '').trim().toLowerCase();
export const CONFIRM_BAND = 0.08;
const bandOf = (det) => det.confirm?.band ?? CONFIRM_BAND;

// Éléments retenus : score ≥ seuil, plus ceux que tu as validés (✓), moins ceux que tu as écartés (✗).
// Avec la confirmation (det.confirm.on) : au-dessus de seuil + marge = retenu ; en dessous de seuil − marge = écarté ;
// dans la marge (cas ambigu) = verdict de Jev (≥ 50 % : retenu) ; sans verdict encore, le seuil seul décide.
// verdicts : { id: pourcentage « oui » }
export function detectorSet(scores, det, verdicts = {}, learned = null) {
  const set = new Set();
  const on = !!det.confirm?.on, band = bandOf(det);
  for (const [id, s] of scores) {
    if (!on) { if (s >= det.threshold) set.add(id); continue; }
    if (s >= det.threshold + band) set.add(id);
    else if (s >= det.threshold - band) { const v = verdicts[id]; if (v === undefined || v < 0 ? s >= det.threshold : v >= 50) set.add(id); } // v < 0 : texte refusé par l'API, le seuil décide
  }
  // apprentissage : les éléments très semblables à un de tes ✓ (ou ✗) suivent ton choix, avant les choix explicites
  if (learned && det.learn?.on !== false) for (const [id, l] of learned) { if (l > 0) set.add(id); else set.delete(id); }
  for (const id of det.pos || []) set.add(id);
  for (const id of det.neg || []) set.delete(id);
  return set;
}

// Propagation de tes corrections : chaque élément dont le vecteur ressemble à celui d'un ✓ (ou d'un ✗) à `sim` ou plus
// prend l'étiquette du plus proche (+1 retenu / −1 écarté). Les éléments étiquetés à la main sont exclus ; au plus `cap` corrections récentes.
export const LEARN_SIM = 0.88;
export function learnedLabels(vecMap, pos, neg, sim = LEARN_SIM, cap = 200) {
  const out = new Map();
  const P = (pos || []).slice(-cap).map((id) => vecMap.get(id)).filter(Boolean);
  const N = (neg || []).slice(-cap).map((id) => vecMap.get(id)).filter(Boolean);
  if (!P.length && !N.length) return out;
  const fixed = new Set([...(pos || []), ...(neg || [])]);
  const best = (v, list) => { let b = -1; for (const q of list) if (q.length === v.length) { let d = 0; for (let k = 0; k < v.length; k++) d += v[k] * q[k]; if (d > b) b = d; } return b; };
  for (const [id, v] of vecMap) {
    if (fixed.has(id)) continue;
    const bp = P.length ? best(v, P) : -1, bn = N.length ? best(v, N) : -1;
    if (Math.max(bp, bn) >= sim) out.set(id, bp >= bn ? 1 : -1);
  }
  return out;
}
// Cas ambigus pas encore jugés, les plus incertains d'abord (hors validations manuelles).
export function ambiguousIds(scores, det, verdicts = {}) {
  const fixed = new Set([...(det.pos || []), ...(det.neg || [])]);
  const band = bandOf(det);
  const rows = [];
  for (const [id, s] of scores) if (!fixed.has(id) && verdicts[id] === undefined && Math.abs(s - det.threshold) <= band) rows.push([id, Math.abs(s - det.threshold)]);
  return rows.sort((a, b) => a[1] - b[1]).map(([id]) => id);
}
// Aide au réglage : répartition des scores et seuil suggéré (on garde environ 2 % des éléments, au moins `min`).
// Les similarités réelles sont souvent bien plus basses qu'on ne l'imagine (0,3–0,5 pour une vraie correspondance).
export function scoreStats(scores) {
  const v = [...scores.values()].filter((x) => Number.isFinite(x)).sort((a, b) => b - a);
  const at = (f) => (v.length ? v[Math.min(v.length - 1, Math.floor(v.length * f))] : 0);
  return { n: v.length, max: v[0] ?? 0, p98: at(0.02), p90: at(0.1), median: at(0.5) };
}
export function suggestThreshold(scores, { frac = 0.02, min = 20 } = {}) {
  const v = [...scores.values()].filter((x) => Number.isFinite(x)).sort((a, b) => b - a);
  if (!v.length) return null;
  const k = Math.min(v.length, Math.max(min, Math.ceil(v.length * frac)));
  const threshold = Math.floor(v[k - 1] * 100) / 100;
  return { threshold, count: v.filter((x) => x >= threshold).length };
}
// Pour régler le seuil : les moins sûrs retenus et les plus proches écartés (hors validations manuelles).
export function detectorMargin(scores, det, n = 8, verdicts = {}, learned = null) {
  const fixed = new Set([...(det.pos || []), ...(det.neg || [])]);
  const kept = detectorSet(scores, det, verdicts, learned); // décision FINALE (seuil, zone ambiguë, verdicts de Jev)
  const rows = [...scores].filter(([id]) => !fixed.has(id));
  const above = rows.filter(([id]) => kept.has(id)).sort((a, b) => a[1] - b[1]).slice(0, n);
  const below = rows.filter(([id]) => !kept.has(id)).sort((a, b) => b[1] - a[1]).slice(0, n);
  return { above, below };
}

// ---- regroupement : plusieurs tweets sur le même sujet = un seul ----
const EXT_SKIP = /^(x\.com|twitter\.com|t\.co|pic\.twitter\.com|mobile\.twitter\.com)$/;
// pages citées (hors X, hors simple page d'accueil), sans paramètres de suivi
export function linkKeys(t) {
  const out = new Set();
  for (const l of [...(t.links || []), ...(t.quoted?.links || [])]) {
    try {
      const u = new URL(l);
      const h = u.hostname.replace(/^www\./, '').toLowerCase();
      const path = u.pathname.replace(/\/$/, '');
      if (!EXT_SKIP.test(h) && path) out.add(h + path);
    } catch { /* lien illisible */ }
  }
  return out;
}
const dayMs = (d) => Date.parse(d + 'T12:00:00Z');

// Union de candidats ([{ t, days }]) par : même tweet cité (ou citation d'un tweet déjà présent), même page citée,
// vecteurs quasi identiques (≥ sim) à moins de `days` jours. Retourne { groups: [[indices]], limited }.
export function clusterCandidates(cand, { sim = 0.92, days = 7, vecs = null, maxVec = 4000 } = {}) {
  const parent = cand.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  const byKey = new Map();
  const link = (key, i) => { if (byKey.has(key)) union(byKey.get(key), i); else byKey.set(key, i); };
  const idIdx = new Map(cand.map((c, i) => [c.t.id, i]));
  cand.forEach((c, i) => {
    const q = c.t.quoted?.id;
    if (q) { link('q:' + q, i); if (idIdx.has(q)) union(idIdx.get(q), i); } // même tweet cité, ou l'original est lui-même dans la liste
    for (const k of linkKeys(c.t)) link('l:' + k, i);
  });
  let limited = false;
  if (vecs && sim) {
    const dated = cand.map((c, i) => ({ i, ms: c.days.length ? dayMs([...c.days].sort()[0]) : null, v: vecs.get(c.t.id) })).filter((x) => x.ms != null && x.v);
    if (dated.length > maxVec) limited = true;
    else {
      dated.sort((a, b) => a.ms - b.ms);
      const win = days * DAY;
      for (let a = 0; a < dated.length; a++) {
        for (let b = a + 1; b < dated.length && dated[b].ms - dated[a].ms <= win; b++) {
          if (find(dated[a].i) === find(dated[b].i)) continue;
          const u = dated[a].v, v = dated[b].v;
          if (u.length !== v.length) continue;
          let d = 0;
          for (let k = 0; k < u.length; k++) d += u[k] * v[k];
          if (d >= sim) union(dated[a].i, dated[b].i);
        }
      }
    }
  }
  const groups = new Map();
  cand.forEach((_, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  return { groups: [...groups.values()], limited };
}

// ---- évaluation d'une stat ----
// w : { kind: 'number'|'series'|'top', q, dets, detMode, source, by, noQuotes, dedupe: { on, sim, days } }
// ctx : { sv, now, rangeDays, detSets: Map(id -> Set), vecs: Map(id -> Float32Array) (regroupement par le sens) }
export function evalWidget(items, w, ctx) {
  const now = ctx.now ?? Date.now();
  const cq = compileQuery(w.q, w.source);
  // détecteurs : plusieurs possibles, combinés par ET (tous) ou OU (au moins un) ; w.det = ancien format (un seul)
  const dets = w.dets?.length ? w.dets : w.det ? [w.det] : [];
  const sets = dets.map((id) => ctx.detSets?.get(id) || new Set());
  const inDets = (id) => !sets.length || (w.detMode === 'or' ? sets.some((st) => st.has(id)) : sets.every((st) => st.has(id)));
  const todayKey = dayKey(now);
  const R = ctx.rangeDays;
  const fromKey = R ? dayKey(now - (R - 1) * DAY) : null;
  const prevFrom = R ? dayKey(now - (2 * R - 1) * DAY) : null;
  const inRange = (d) => (!fromKey || d >= fromKey) && d <= todayKey;
  const inPrev = (d) => R && d >= prevFrom && d < fromKey;

  // 1) éléments qui correspondent
  const cand = [];
  for (const t of items) {
    if (!inDets(t.id)) continue;
    if (w.noQuotes && !isVideoItem(t) && t.quoted) continue; // « ignorer les tweets qui citent un autre tweet »
    if (!matchItem(t, cq)) continue;
    cand.push({ t, days: eventDays(t, ctx.sv) });
  }
  // 2) unités comptées : un tweet, ou un groupe de tweets sur le même sujet (daté de son PREMIER enregistrement :
  //    un sujet n'est jamais compté deux fois d'une période à l'autre)
  const dd = w.dedupe?.on ? w.dedupe : null;
  let units, limited = false;
  if (dd) {
    const cl = clusterCandidates(cand, { sim: dd.sim ?? 0.92, days: dd.days ?? 7, vecs: ctx.vecs });
    limited = cl.limited;
    units = cl.groups.map((idx) => {
      const members = idx.map((k) => cand[k]);
      const all = members.flatMap((m) => m.days).sort();
      const rep = members.slice().sort((a, b) => ((a.days.slice().sort()[0] || '9') < (b.days.slice().sort()[0] || '9') ? -1 : 1))[0];
      return { rep: rep.t, days: all.length ? [all[0]] : [], members: members.map((m) => m.t) };
    });
  } else units = cand.map((c) => ({ rep: c.t, days: c.days, members: [c.t] }));

  const perDay = new Map(), matched = [];
  let n = 0, prev = 0, noDate = 0, tweets = 0;
  for (const u of units) {
    if (!u.days.length) { noDate++; if (!R) { n++; tweets += u.members.length; matched.push({ t: u.rep, day: '', members: u.members }); } continue; }
    let hit = null, p = false;
    for (const d of u.days) {
      if (inRange(d)) { count(perDay, d); if (!hit || d > hit) hit = d; }
      if (inPrev(d)) p = true;
    }
    if (hit) { n++; tweets += u.members.length; matched.push({ t: u.rep, day: hit, members: u.members }); }
    if (p) prev++;
  }
  matched.sort((a, b) => (a.day < b.day ? 1 : -1));
  const keys = [...perDay.keys()].sort();
  const startKey = fromKey || keys[0] || todayKey;
  const out = { n, prev: R ? prev : null, noDate, matched, startKey, endKey: todayKey, tweets, grouped: !!dd, limited };
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

export const detsOf = (w) => (w.dets?.length ? w.dets : w.det ? [w.det] : []);
