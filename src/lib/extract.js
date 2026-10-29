// Extraction « en masse » : un modèle peu coûteux lit, vidéo par vidéo, quelques extraits ciblés de la transcription et répond à UNE question.
// L'assistant (cher) ne reçoit que le tableau des réponses, jamais les transcriptions. Chaque réponse doit citer la transcription mot pour mot,
// sinon elle est écartée. Module pur : l'appel au modèle et le cache arrivent par `ctx`.
import { tokenize, normalizeText } from './search.js';
import { parseJsonLoose } from './llm.js';
import { fmtTime } from './transcript.js';

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };

// Passages d'une transcription qui contiennent des mots donnés : [{ at, text }] triés par pertinence
export function bestPassages(chunks, terms, n = 3) {
  const set = new Set(terms.map((x) => normalizeText(x)));
  return (chunks || []).map((c) => {
    const toks = tokenize(c.text);
    let hits = 0;
    for (const tk of toks) if (set.has(tk) || [...set].some((q) => q.length >= 4 && tk.startsWith(q))) hits++;
    return { at: Math.floor(c.t || 0), text: c.text, score: hits / Math.sqrt(1 + toks.length) };
  }).filter((p) => p.score > 0).sort((a, b) => b.score - a.score).slice(0, n);
}

// Extraits à montrer au modèle : l'ouverture de la vidéo (là où l'on présente l'invité, le sujet…) + les passages proches de la question.
export function selectPassages(chunks, question, { chars = 3500, open = 1200 } = {}) {
  const out = [];
  let used = 0;
  for (const c of chunks || []) { if (used >= open) break; out.push({ at: Math.floor(c.t || 0), text: String(c.text).replace(/\s+/g, ' ').trim() }); used += String(c.text).length; }
  const seen = new Set(out.map((p) => p.at));
  for (const p of bestPassages(chunks, tokenize(question), 8)) {
    if (used >= chars) break;
    if (seen.has(p.at)) continue;
    seen.add(p.at); out.push({ at: p.at, text: String(p.text).replace(/\s+/g, ' ').trim() }); used += p.text.length;
  }
  return out.sort((a, b) => a.at - b.at);
}
export const passagesText = (ps) => ps.map((p) => `[${fmtTime(p.at)}] ${p.text}`).join('\n');

export function extractMessages(video, text, question) {
  return [
    { role: 'system', content: 'Tu extrais une information précise d’extraits de la transcription d’une vidéo YouTube. Réponds UNIQUEMENT d’après les extraits fournis, sans rien ajouter de ta connaissance. Réponds en JSON strict : {"answers":[{"value":"réponse courte","evidence":"citation EXACTE copiée mot pour mot des extraits (une phrase ou un morceau de phrase, sans l’horodatage)"}]}. S’il y a plusieurs réponses (par exemple plusieurs invités), une entrée chacune. Si les extraits ne contiennent pas la réponse : {"answers":[]}.' },
    { role: 'user', content: `Vidéo : « ${clip(video.text, 160)} » (${clip(video.name, 60)})\nQuestion : ${question}\n\nEXTRAITS :\n${text}` },
  ];
}

// Comparaison tolérante (casse, accents, ponctuation, espaces) : la citation doit figurer dans les extraits.
const flat = (s) => normalizeText(String(s || '')).replace(/[^a-z0-9]+/g, ' ').trim();
export function parseExtraction(raw, passages) {
  let o; try { o = parseJsonLoose(raw); } catch { return { answers: [], rejected: 0, invalid: true }; }
  const source = passages.map((p) => ({ at: p.at, f: flat(p.text) }));
  const whole = source.map((p) => p.f).join(' ');
  const answers = []; let rejected = 0;
  for (const a of Array.isArray(o?.answers) ? o.answers : []) {
    const value = clip(a?.value, 160), ev = String(a?.evidence || '');
    const frags = ev.split(/…|\.\.\./).map(flat).filter((f) => f.length >= 12);
    if (!value || !frags.length || !frags.every((f) => whole.includes(f))) { if (value) rejected++; continue; }
    const hit = source.find((p) => p.f.includes(frags[0]));
    answers.push({ value, evidence: clip(ev, 240), at: hit ? hit.at : undefined });
  }
  return { answers, rejected };
}

// ctx : { llm(messages) -> { text, cost|null }, cache: { get(key), set(key, v) }, getTranscripts(ids), model, prices: { inPerM, outPerM } }
// videos : éléments de l'index. Retourne { results, processed, cached, noTranscript, rejected, invalid, costUsd, estimatedUsd, stopped }
export async function runExtract(ctx, videos, question, { budget = 0.3, estimateOnly = false, concurrency = 4, chars = 3500 } = {}) {
  const trs = await ctx.getTranscripts(videos.filter((v) => v.trState === 'ok').map((v) => v.id));
  const key = (v) => `${v.id}|${ctx.model}|${flat(question)}|${chars}`;
  const prep = videos.map((v) => {
    const ch = trs.get(v.id);
    const passages = ch?.length ? selectPassages(ch, question, { chars }) : [{ at: 0, text: String(v.text || '') }];
    return { v, passages, text: passagesText(passages), hasTr: !!ch?.length };
  });
  const price = (p) => ((p.text.length + 700) / 3.5 * ctx.prices.inPerM + 150 * ctx.prices.outPerM) / 1e6;
  let estimatedUsd = 0, cached = 0;
  for (const p of prep) { if (ctx.cache.get(key(p.v))) cached++; else estimatedUsd += price(p); }
  const summary = { question, model: ctx.model, videos: videos.length, cached, withoutTranscript: prep.filter((p) => !p.hasTr).length, estimatedUsd: Math.round(estimatedUsd * 1e4) / 1e4 };
  if (estimateOnly) return { ...summary, estimateOnly: true };
  const results = new Array(prep.length);
  let spent = 0, next = 0, rejected = 0, invalid = 0, stopped = false, done = 0;
  const worker = async () => {
    while (next < prep.length) {
      const i = next++, p = prep[i];
      let r = ctx.cache.get(key(p.v));
      if (!r) {
        if (spent >= budget) { stopped = true; results[i] = { id: p.v.id, skipped: 'plafond de coût atteint' }; continue; }
        try {
          const res = await ctx.llm(extractMessages(p.v, p.text, question));
          spent += res.cost != null ? res.cost : price(p);
          r = parseExtraction(res.text, p.passages);
          if (!r.invalid) ctx.cache.set(key(p.v), r);
        } catch (e) { results[i] = { id: p.v.id, error: String(e.message || e).slice(0, 160) }; continue; }
      }
      rejected += r.rejected || 0; if (r.invalid) invalid++;
      done++;
      results[i] = { id: p.v.id, title: clip(p.v.text, 120), published: undefined, url: p.v.url, source: p.hasTr ? 'transcription' : 'titre seulement', answers: r.answers.map((a) => ({ ...a, link: a.at != null && p.hasTr ? `${p.v.url}${p.v.url.includes('?') ? '&' : '?'}t=${a.at}s` : undefined, at: a.at != null && p.hasTr ? fmtTime(a.at) : undefined })) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, prep.length) }, worker));
  return { ...summary, processed: done, rejectedCitations: rejected, invalidReplies: invalid, costUsd: Math.round(spent * 1e4) / 1e4, ...(stopped ? { stoppedByBudget: true } : {}), results: JSON.parse(JSON.stringify(results.filter(Boolean))) };
}
