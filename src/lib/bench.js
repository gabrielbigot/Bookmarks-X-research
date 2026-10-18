// Classements de modèles (page « Classements » du journal) : indices Artificial Analysis relayés par OpenRouter (GET /api/v1/benchmarks)
// et nouveaux modèles du catalogue (GET /api/v1/models, champ `created`). Lecture tolérante : le format exact peut évoluer.
import { dayKey } from './time.js';
import { parseJsonLoose } from './llm.js';

const num = (x) => { if (x === null || x === undefined || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; };
export const modelKey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, '');
const perMillion = (v) => (v == null ? null : v < 0.01 ? v * 1e6 : v); // les prix OpenRouter sont par token, ceux d'Artificial Analysis par million
function priceOf(p) {
  if (!p || typeof p !== 'object') return { priceIn: null, priceOut: null };
  const find = (re) => { for (const [k, v] of Object.entries(p)) if (re.test(k) && num(v) != null) return num(v); return null; };
  return { priceIn: perMillion(find(/input|prompt/i)), priceOut: perMillion(find(/output|completion/i)) };
}
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// -> { rows: [{ slug, name, intelligence, coding, agentic, priceIn, priceOut }], meta }
export function parseBenchmarks(json) {
  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  const best = new Map();
  for (const r of list) {
    const slug = r.model_permaslug || r.slug || r.model || '';
    const name = cleanName(r.display_name || r.name || slug);
    const row = { slug, name, intelligence: num(r.intelligence_index ?? r.scores?.intelligence_index), coding: num(r.coding_index ?? r.scores?.coding_index), agentic: num(r.agentic_index ?? r.scores?.agentic_index), ...priceOf(r.pricing) };
    if (!name || (row.intelligence == null && row.coding == null && row.agentic == null)) continue;
    const k = modelKey(name) || slug;
    const old = best.get(k);
    if (!old || (row.intelligence ?? -1) > (old.intelligence ?? -1)) best.set(k, row); // plusieurs variantes d'un même modèle : la meilleure
  }
  return { rows: [...best.values()], meta: json?.meta || {} };
}

// Modèles ajoutés au catalogue pendant la période : [{ id, name, day, ctx, priceIn, priceOut }]
export function newModels(json, win, limit = 12) {
  const out = [];
  for (const m of Array.isArray(json?.data) ? json.data : []) {
    let c = num(m.created);
    if (c == null) continue;
    if (c < 1e12) c *= 1000;
    const day = dayKey(c);
    if (day < win.from || day > win.to) continue;
    out.push({ id: m.id, name: cleanName(m.name || m.id), day, ctx: num(m.context_length), ...priceOf(m.pricing) });
  }
  return out.sort((a, b) => b.day.localeCompare(a.day)).slice(0, limit);
}

// Texte normalisé pour la recherche de noms : minuscules, sans accents ni ponctuation (le point reste entre deux chiffres : « 5.5 »).
const normText = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/(?<!\d)\.|\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// « opus 5 » ne doit pas se retrouver dans « opus 5.5 » : le nom doit finir là où finit le mot (ni lettre, ni chiffre, ni « .chiffre »).
const patternOf = (words) => new RegExp('(?:^| )' + normText(words).split(' ').filter(Boolean).map(escRe).join(' ?') + '(?![a-z0-9]|\\.\\d)');
export function aliasPatterns(name) {
  const clean0 = String(name || '').replace(/\([^)]*\)/g, ' ').replace(/^[^:]+:\s*/, '').trim();
  const out = [];
  if (modelKey(clean0).length >= 4) out.push(patternOf(clean0));
  const words = clean0.split(/\s+/);
  if (words.length >= 2 && VENDORS.has(words[0].toLowerCase())) { const rest = words.slice(1).join(' '); if (modelKey(rest).length >= 5) out.push(patternOf(rest)); }
  return out;
}
// Modèles cités dans les lectures de la semaine : le nom (sans parenthèses) figure dans le texte, en mot entier.
export function citedModels(rows, text) {
  const t = normText(text);
  return new Set(rows.filter((r) => aliasPatterns(r.name).some((re) => re.test(t))).map((r) => r.slug || r.name));
}

// Lignes à tracer pour un indice : les meilleures + les modèles cités (au plus `max`), triées par score décroissant.
export function pickRows(rows, field, cited, { top = 8, max = 13 } = {}) {
  const have = rows.filter((r) => r[field] != null).sort((a, b) => b[field] - a[field]);
  const chosen = new Map(have.slice(0, top).map((r) => [r.slug || r.name, r]));
  for (const r of have) if (cited.has(r.slug || r.name) && chosen.size < max) chosen.set(r.slug || r.name, r);
  return [...chosen.values()].sort((a, b) => b[field] - a[field]);
}

// ---------- usage (OpenRouter rankings-daily) ----------
// json : { data: [{ date, model_permaslug, total_tokens }] } -> { cur: Map(slug -> jetons), prev: Map, totalCur, totalPrev } ; période courante = win, précédente = win.prevFrom..prevTo
export function parseRankings(json, win) {
  const cur = new Map(), prev = new Map();
  let totalCur = 0, totalPrev = 0;
  for (const r of Array.isArray(json?.data) ? json.data : []) {
    const slug = r.model_permaslug || r.model || r.slug, t = num(r.total_tokens), d = String(r.date || '').slice(0, 10);
    if (!slug || t == null || !d) continue;
    const other = /^other$/i.test(String(slug));
    if (d >= win.from && d <= win.to) { if (!other) cur.set(slug, (cur.get(slug) || 0) + t); totalCur += t; }
    else if (d >= win.prevFrom && d <= win.prevTo) { if (!other) prev.set(slug, (prev.get(slug) || 0) + t); totalPrev += t; }
  }
  return { cur, prev, totalCur, totalPrev };
}
// Meilleurs d'usage : [{ slug, tokens, share, change }] (change = variation en % par rapport à la période précédente, null si absente)
export function topUsage(rk, limit = 10) {
  return [...rk.cur].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([slug, tokens]) => {
    const p = rk.prev.get(slug);
    return { slug, tokens, share: rk.totalCur ? tokens / rk.totalCur : 0, change: p ? (tokens - p) / p : null };
  });
}
// Nom lisible d'un identifiant (catalogue, sinon identifiant mis en forme)
export function prettySlug(slug, catalog = new Map()) {
  const hit = catalog.get(slug) || catalog.get(String(slug).replace(/-\d{8}$/, '')) || catalog.get(String(slug).replace(/:.*$/, ''));
  const tidy = (x) => x.replace(/[\s-]\d{8}(?=:|$)/, '').replace(/:\s*free$/i, ' (gratuit)').trim();
  if (hit) return tidy(hit.replace(/^[^:]+:\s*/, ''));
  return tidy(String(slug).split('/').pop().replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
}

// ---------- rapport qualité / prix / vitesse ----------
// Prix « mixte » : 3 parts d'entrée pour 1 de sortie (usage courant). Efficacité = indice d'intelligence par dollar et par million de tokens.
export function valueRows(rows) {
  return rows.filter((r) => r.intelligence != null && r.priceIn != null && r.priceOut != null).map((r) => {
    const blended = (3 * r.priceIn + r.priceOut) / 4;
    return { ...r, blended, perDollar: blended > 0 ? r.intelligence / blended : null };
  });
}
export function bestValue(rows, limit = 8, { minIntelligence = 0 } = {}) {
  const v = valueRows(rows).filter((r) => r.perDollar != null && r.intelligence >= minIntelligence);
  const floor = Math.max(...v.map((r) => r.intelligence), 0) * 0.6; // un modèle gratuit mais faible n'est pas « le meilleur rapport »
  return v.filter((r) => r.intelligence >= Math.max(minIntelligence, floor)).sort((a, b) => b.perDollar - a.perDollar).slice(0, limit);
}
// Vitesse constatée d'un modèle (réponse de GET /models/{id}/endpoints) : meilleure médiane de débit (jetons/s) et meilleure latence (s).
export function parseEndpoints(json) {
  const eps = Array.isArray(json?.data?.endpoints) ? json.data.endpoints : Array.isArray(json?.endpoints) ? json.endpoints : [];
  const p50 = (o) => (o && typeof o === 'object' ? num(o.p50 ?? o.median ?? o.avg) : num(o));
  let tps = null, lat = null;
  for (const e of eps) {
    const t = p50(e.throughput_last_30m ?? e.throughput), l = p50(e.latency_last_30m ?? e.latency);
    if (t != null && (tps == null || t > tps)) tps = t;
    if (l != null && l > 0 && (lat == null || l < lat)) lat = l > 100 ? l / 1000 : l; // millisecondes -> secondes
  }
  return tps == null && lat == null ? null : { tps, lat };
}

// ---------- ce qu'on en dit : mentions dans les lectures de la semaine ----------
const VENDORS = new Set(['claude', 'google', 'openai', 'anthropic', 'meta', 'nvidia', 'xai', 'microsoft']);
// Clés de recherche d'un nom de modèle : complète, et sans préfixe de marque (« Claude Opus 5.5 » -> « opus55 »)
export function aliasKeys(name) {
  const clean0 = String(name || '').replace(/\([^)]*\)/g, ' ').replace(/^[^:]+:\s*/, '');
  const full = modelKey(clean0), out = new Set(full.length >= 4 ? [full] : []);
  const words = clean0.trim().split(/\s+/);
  if (words.length >= 2 && VENDORS.has(words[0].toLowerCase())) { const k = modelKey(words.slice(1).join(' ')); if (k.length >= 5) out.add(k); }
  return [...out];
}
// models : [{ key, name }] ; tweets : [{ id, text, stats }] ; -> Map(name -> { n, score, ids: [id] }) (n = éléments qui en parlent, score pondéré par l'audience)
export function countMentions(models, tweets) {
  const prepared = tweets.map((t) => ({ t, k: normText(t.text) }));
  const out = new Map();
  for (const m of models) {
    const keys = aliasPatterns(m.name);
    if (!keys.length) continue;
    let n = 0, score = 0; const ids = [];
    for (const { t, k } of prepared) {
      if (!keys.some((re) => re.test(k))) continue;
      n++; score += 1 + Math.log10(1 + (t.stats?.likes || 0) + 2 * (t.stats?.reposts || 0)); ids.push(t.id);
    }
    if (n) out.set(m.name, { n, score, ids });
  }
  return out;
}
// Nom sans les variantes entre parenthèses (« Claude Opus 5.5 (Max, Default Fallback) » -> « Claude Opus 5.5 ») ni « :free »
export const familyName = (name) => String(name || '').replace(/\s*\([^)]*\)/g, '').replace(/:\s*free$/i, '').replace(/\s+/g, ' ').trim();
// Les variantes d'un même modèle (Max, High, Reasoning…) parlent des mêmes tweets : elles sont regroupées en une seule ligne.
export function topMentions(map, limit = 10) {
  const fam = new Map();
  for (const [name, v] of map) {
    const k = modelKey(name), cur = fam.get(k);
    if (!cur) fam.set(k, { name: familyName(name) || name, n: v.n, score: v.score, ids: [...v.ids] });
    else { cur.n = Math.max(cur.n, v.n); cur.score = Math.max(cur.score, v.score); for (const id of v.ids) if (!cur.ids.includes(id)) cur.ids.push(id); }
  }
  return [...fam.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// Avis : extraits (au plus 5 par modèle) -> messages pour le modèle de langue, et lecture de sa réponse.
// groups : [{ name, extracts: [{ id: 'T1', handle, text }] }]
export function opinionMessages(groups) {
  const body = groups.map((g) => `MODÈLE ${g.name} :\n${g.extracts.map((e) => `[${e.id}] @${e.handle} : ${String(e.text).replace(/\s+/g, ' ').slice(0, 320)}`).join('\n')}`).join('\n\n');
  return [
    { role: 'system', content: 'Tu es journaliste pour un journal hebdomadaire sur l’IA. Pour chaque modèle, résume ce que les gens en disent, UNIQUEMENT d’après les extraits fournis : points forts, faiblesses, ton général. N’ajoute aucun fait, chiffre ou nom absent des extraits. Cite les extraits avec leur identifiant entre crochets, par exemple [T3]. Réponds uniquement en JSON : {"models": [{"model": "nom exact du modèle", "verdict": "positif" | "mitigé" | "négatif" | "neutre", "summary": "une ou deux phrases en français avec [T1]"}]}.' },
    { role: 'user', content: body },
  ];
}
export function parseOpinions(text, validIds) {
  const o = parseJsonLoose(text);
  const ok = new Set(['positif', 'mitigé', 'négatif', 'neutre']);
  const NO_INFO = /aucun(e)? (extrait|message|tweet|texte|avis|information)|(ne|n[’']) ?(mentionn|parl)\w* (pas|directement)|impossible de (dégager|tirer|conclure)|pas (assez )?d[’']informations?/i;
  const seen = new Set();
  return (Array.isArray(o.models) ? o.models : []).map((m) => ({
    model: String(m?.model || '').trim(),
    verdict: ok.has(String(m?.verdict || '').toLowerCase()) ? String(m.verdict).toLowerCase() : 'neutre',
    summary: String(m?.summary || '').replace(/\[((?:T\d+)(?:\s*[,;]\s*T\d+)*)\]/g, (x, ids) => { const keep = ids.split(/\s*[,;]\s*/).filter((i) => validIds.has(i)); return keep.length ? `[${keep.join(',')}]` : ''; }).replace(/\s{2,}/g, ' ').trim(),
  })).filter((m) => m.model && m.summary.length > 15 && !NO_INFO.test(m.summary) && !seen.has(modelKey(m.model)) && seen.add(modelKey(m.model)));
}
