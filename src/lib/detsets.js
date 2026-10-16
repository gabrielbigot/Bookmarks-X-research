// Éléments retenus par un détecteur (mêmes règles que les stats : seuil, confirmation Jev, ✓/✗ appris).
import { detectorScores, detectorSet, learnedLabels, LEARN_SIM, verdictKey } from './widgets.js';

export function detectorSetFor(det, { mid, vecs, chunks, verdicts = {} }) {
  const protos = (det.protos?.[mid] || []).map((a) => Float32Array.from(a));
  if (!protos.length) return null; // exemples pas encore analysés avec ce modèle
  const sc = detectorScores(vecs, chunks, protos);
  const vd = verdicts[det.id]?.key === verdictKey(det) ? verdicts[det.id].v : {};
  const learned = det.learn?.on === false ? null : learnedLabels(vecs, det.pos, det.neg, det.learn?.sim ?? LEARN_SIM);
  return detectorSet(sc, det, vd, learned);
}
