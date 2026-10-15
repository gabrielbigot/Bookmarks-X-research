// Jugement automatique par Jev des NOUVEAUX éléments, avec exactement les réglages de chaque détecteur et de chaque stat :
//  - détecteurs utilisés par au moins une stat ET réglés « faire confirmer par Jev » : les cas ambigus (zone ± du détecteur) pas encore jugés ;
//  - stats « annonces officielles » : les tweets qui passent leurs filtres (requête, détecteurs, citations, sources primaires) pas encore jugés.
// Plafond de dépenses par jour (estimation : la sortie de Jev est gratuite, l'entrée est facturée au million de tokens).
import * as db from './db.js';
import { modelOf } from './models.js';
import { dayKey } from './time.js';
import { decodeEntities } from './text.js';
import { isVideoItem } from './youtube.js';
import { jevJudge, estimateJudgeCost } from './jev.js';
import { decisionReady } from './settings.js';
import { detsOf, detectorScores, detectorSet, learnedLabels, LEARN_SIM, ambiguousIds, verdictKey, compileQuery, matchItem, judgeText, handleKey, OFFICIAL_DESC } from './widgets.js';

// même texte envoyé à Jev que dans l'éditeur de détecteur
export const detJudgeText = (t) => ({ id: t.id, text: isVideoItem(t) ? `${t.text} — ${t.name}${t.desc ? ' — ' + t.desc : ''}` : `${t.name} (@${t.handle}) : ${decodeEntities(t.text)}${t.quoted ? ' | cite : ' + decodeEntities(t.quoted.text) : ''}` });

export const usedDetectorIds = (widgets) => {
  const ids = new Set();
  for (const w of widgets) { detsOf(w).forEach((d) => ids.add(d)); (w.more || []).forEach((m) => (m.dets || []).forEach((d) => ids.add(d))); }
  return ids;
};

// io : accès aux données (remplaçable dans les tests)
export async function runAutoJev(settings, { io = db, onProgress, signal, now = Date.now() } = {}) {
  const aj = settings.autoJev;
  if (!aj?.on) return { skipped: 'off' };
  if (!decisionReady(settings)) return { skipped: 'nokey' };
  const today = dayKey(now);
  let spend = (await io.getMeta('jevSpend')) || {};
  if (spend.day !== today) spend = { day: today, dollars: 0, count: 0 };
  const price = settings.decision.priceInPerM;
  let remaining = (Number(aj.dailyCap) || 0) - spend.dollars;
  const result = { judged: 0, dollars: 0, capReached: false, error: '', detectors: 0, official: 0 };
  if (remaining <= 0.0002) return { ...result, skipped: 'cap', capReached: true, spentToday: spend.dollars };

  const widgets = (await io.getMeta('dashWidgets')) || [];
  const detectors = (await io.getMeta('dashDetectors')) || [];
  const used = usedDetectorIds(widgets);
  const mid = modelOf(settings.embedModel).id;
  const sendable = (t) => settings.aiHistory || !isVideoItem(t) || !(t.watched || []).length || (t.playlists || []).length > 0;

  // fusionne les verdicts dans la base (la page de stats peut en écrire en même temps : on ne perd jamais rien)
  const saveDet = async (det, batch) => {
    const all = (await io.getMeta('detVerdicts')) || {};
    const key = verdictKey(det);
    if (all[det.id]?.key !== key) all[det.id] = { key, v: {} };
    for (const [id, p] of batch) all[det.id].v[id] = p;
    await io.setMeta('detVerdicts', all);
  };
  const saveOff = async (batch) => {
    const cur = await io.getMeta('officialVerdicts');
    const store = cur?.v === OFFICIAL_DESC ? cur : { v: OFFICIAL_DESC, m: {} };
    for (const [id, p] of batch) store.m[id] = p;
    await io.setMeta('officialVerdicts', store);
  };
  const run = async (desc, items, save) => {
    if (!items.length || remaining <= 0.0002 || signal?.aborted) return;
    // on s'arrête à l'argent disponible : les éléments les plus proches du seuil / les plus récents d'abord
    const costOf = new Map(), picked = [];
    let sum = 0;
    for (const it of items) {
      const c = estimateJudgeCost(desc, [it.text], price).dollars;
      if (sum + c > remaining) { result.capReached = true; break; }
      sum += c; costOf.set(it.id, c); picked.push(it);
    }
    if (!picked.length) return;
    const r = await jevJudge(settings.decision, desc, picked, { signal, onBatch: async (b) => {
      await save(b);
      let c = 0; for (const id of b.keys()) c += costOf.get(id) || 0;
      spend.dollars += c; spend.count += b.size; remaining -= c; result.dollars += c; result.judged += b.size;
      await io.setMeta('jevSpend', spend);
      onProgress?.({ judged: result.judged, dollars: result.dollars });
    } });
    if (r.error) result.error = r.error;
  };

  try {
    // 1) détecteurs avec confirmation Jev
    const confirmDets = detectors.filter((d) => used.has(d.id) && d.confirm?.on && d.desc && (d.protos?.[mid] || []).length);
    if (confirmDets.length) {
      const vecs = await io.getAllVectors(mid), chunks = await io.getAllChunkVecs(mid);
      for (const det of confirmDets) {
        const scores = detectorScores(vecs, chunks, det.protos[mid].map((a) => Float32Array.from(a)));
        const all = (await io.getMeta('detVerdicts')) || {};
        const vd = all[det.id]?.key === verdictKey(det) ? all[det.id].v : {};
        const ids = ambiguousIds(scores, det, vd);
        if (!ids.length) continue;
        const items = [];
        for (let i = 0; i < ids.length && items.length < 4000; i += 200) for (const t of await io.getTweets(ids.slice(i, i + 200))) if (!t.off && sendable(t)) items.push(detJudgeText(t));
        const before = result.judged;
        await run(det.desc, items, (b) => saveDet(det, b));
        result.detectors += result.judged - before;
        if (remaining <= 0.0002) break;
      }
    }
    // 2) stats « annonces officielles »
    const offWidgets = widgets.filter((w) => w.officialOnly && (w.kind === 'number' || w.kind === 'series' || w.kind === 'top' || w.kind === 'heat' || w.kind === 'trend'));
    if (offWidgets.length && remaining > 0.0002) {
      const [vecs, chunks, allV, primary, offCur] = [await io.getAllVectors(mid), await io.getAllChunkVecs(mid), (await io.getMeta('detVerdicts')) || {}, new Set(((await io.getMeta('primarySources')) || []).map(handleKey)), await io.getMeta('officialVerdicts')];
      const judged = offCur?.v === OFFICIAL_DESC ? offCur.m : {};
      const detSet = new Map();
      const setOf = (id) => {
        if (detSet.has(id)) return detSet.get(id);
        const det = detectors.find((d) => d.id === id);
        let st = new Set();
        if (det && (det.protos?.[mid] || []).length) {
          const sc = detectorScores(vecs, chunks, det.protos[mid].map((a) => Float32Array.from(a)));
          const vd = allV[det.id]?.key === verdictKey(det) ? allV[det.id].v : {};
          const learned = det.learn?.on === false ? null : learnedLabels(vecs, det.pos, det.neg, det.learn?.sim ?? LEARN_SIM);
          st = detectorSet(sc, det, vd, learned);
        }
        detSet.set(id, st); return st;
      };
      const tests = offWidgets.map((w) => {
        const dets = detsOf(w), cq = compileQuery(w.q, w.source), sets = dets.map(setOf);
        return (t) => !isVideoItem(t) && !t.off && !(w.noQuotes && t.quoted) && (!w.primaryOnly || primary.has(handleKey(t.handle)))
          && (!sets.length || (w.detMode === 'or' ? sets.some((s) => s.has(t.id)) : sets.every((s) => s.has(t.id)))) && matchItem(t, cq);
      });
      const cand = new Map();
      await io.eachTweet((t) => { if (!(t.id in judged) && !cand.has(t.id) && tests.some((f) => f(t))) cand.set(t.id, { id: t.id, text: judgeText(t).text, at: t.createdAt || '' }); });
      const items = [...cand.values()].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 4000);
      const before = result.judged;
      await run(OFFICIAL_DESC, items, saveOff);
      result.official += result.judged - before;
    }
  } catch (e) { result.error = String(e?.message || e); }
  result.spentToday = spend.dollars;
  return result;
}
