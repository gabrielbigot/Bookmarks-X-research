// Garde l'index en mémoire synchronisé avec IndexedDB, sans tout reconstruire à chaque ajout.
import { getAllTweets, getAllVectors, getAllTweetKeys, getAllVectorKeys, getTweets, getVectors, getTranscripts, getAllChunkVecs } from './db.js';
import { chunksText } from './transcript.js';

const CHUNK = 500;

// Transcriptions : texte (pour les mots-clés) et passages datés (pour les extraits), en mémoire seulement.
async function attachTranscripts(tweets) {
  const ids = tweets.filter((t) => t.trState === 'ok').map((t) => t.id);
  if (!ids.length) return;
  const trs = await getTranscripts(ids);
  for (const t of tweets) { const c = trs.get(t.id); if (c) t.transcript = chunksText(c, 1_000_000); } // transitoire : consommé (puis supprimé) par Index.add
}
async function attachChunkVecs(index, model) {
  const all = await getAllChunkVecs(model);
  for (const [id, { vecs, k }] of all) index.setChunkVecs(id, vecs, k);
}

export async function fullLoad(index, model) {
  const [tweets, vecs] = await Promise.all([getAllTweets(), getAllVectors(model)]);
  await attachTranscripts(tweets);
  index.build(tweets, vecs);
  await attachChunkVecs(index, model);
  return { added: tweets.length, full: true };
}

// Retourne { added, vectors, full }. Repasse en chargement complet si des tweets ont disparu.
export async function refresh(index, model) {
  const keys = await getAllTweetKeys();
  const keySet = new Set(keys);
  if (index.tweets.length > keys.length || index.tweets.some((t) => !keySet.has(t.id))) return fullLoad(index, model);

  const missing = keys.filter((id) => !index.rowById.has(id));
  let added = 0;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const ids = missing.slice(i, i + CHUNK);
    const [tweets, vecs] = await Promise.all([getTweets(ids), getVectors(ids, model)]);
    await attachTranscripts(tweets);
    added += index.add(tweets, vecs);
  }
  // Vecteurs arrivés depuis pour des tweets déjà chargés.
  const vkeys = await getAllVectorKeys(model);
  const need = vkeys.filter((id) => {
    const r = index.rowById.get(id);
    return r !== undefined && !index.hasVec[r];
  });
  let vectors = 0;
  for (let i = 0; i < need.length; i += CHUNK) {
    const vecs = await getVectors(need.slice(i, i + CHUNK), model);
    for (const [id, v] of vecs) if (index.setVector(id, v)) vectors++;
  }
  // Vecteurs de passages arrivés depuis.
  const chunks = await getAllChunkVecs(model);
  for (const [id, { vecs, k }] of chunks) { const r = index.rowById.get(id); if (r !== undefined && !index.chunkVecs.has(r)) { index.setChunkVecs(id, vecs, k); vectors++; } }
  return { added, vectors, full: false };
}
