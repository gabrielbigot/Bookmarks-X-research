// Garde l'index en mémoire synchronisé avec IndexedDB, sans tout reconstruire à chaque ajout.
import { getAllTweets, getAllVectors, getAllTweetKeys, getAllVectorKeys, getTweets, getVectors } from './db.js';
import { DIM } from './search.js';

const CHUNK = 500;

export async function fullLoad(index) {
  const [tweets, vecs] = await Promise.all([getAllTweets(), getAllVectors()]);
  index.build(tweets, vecs);
  return { added: tweets.length, full: true };
}

// Retourne { added, vectors, full }. Repasse en chargement complet si des tweets ont disparu.
export async function refresh(index) {
  const keys = await getAllTweetKeys();
  const keySet = new Set(keys);
  if (index.tweets.length > keys.length || index.tweets.some((t) => !keySet.has(t.id))) return fullLoad(index);

  const missing = keys.filter((id) => !index.rowById.has(id));
  let added = 0;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const ids = missing.slice(i, i + CHUNK);
    const [tweets, vecs] = await Promise.all([getTweets(ids), getVectors(ids)]);
    added += index.add(tweets, vecs);
  }
  // Vecteurs arrivés depuis pour des tweets déjà chargés.
  const vkeys = await getAllVectorKeys();
  const need = vkeys.filter((id) => {
    const r = index.rowById.get(id);
    return r !== undefined && !index.hasVec[r];
  });
  let vectors = 0;
  for (let i = 0; i < need.length; i += CHUNK) {
    const vecs = await getVectors(need.slice(i, i + CHUNK));
    for (const [id, v] of vecs) if (v.length === DIM && index.setVector(id, v)) vectors++;
  }
  return { added, vectors, full: false };
}
