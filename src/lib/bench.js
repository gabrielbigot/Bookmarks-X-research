// Classements de modèles (page « Classements » du journal) : indices Artificial Analysis relayés par OpenRouter (GET /api/v1/benchmarks)
// et nouveaux modèles du catalogue (GET /api/v1/models, champ `created`). Lecture tolérante : le format exact peut évoluer.
import { dayKey } from './time.js';

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

// Modèles cités dans les lectures de la semaine : le nom (sans parenthèses, sans ponctuation) figure dans le texte.
export function citedModels(rows, text) {
  const t = modelKey(text);
  return new Set(rows.filter((r) => { const k = modelKey(r.name); return k.length >= 4 && t.includes(k); }).map((r) => r.slug || r.name));
}

// Lignes à tracer pour un indice : les meilleures + les modèles cités (au plus `max`), triées par score décroissant.
export function pickRows(rows, field, cited, { top = 8, max = 13 } = {}) {
  const have = rows.filter((r) => r[field] != null).sort((a, b) => b[field] - a[field]);
  const chosen = new Map(have.slice(0, top).map((r) => [r.slug || r.name, r]));
  for (const r of have) if (cited.has(r.slug || r.name) && chosen.size < max) chosen.set(r.slug || r.name, r);
  return [...chosen.values()].sort((a, b) => b[field] - a[field]);
}
