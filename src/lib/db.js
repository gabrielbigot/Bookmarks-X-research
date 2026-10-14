// Stockage local (IndexedDB) : tweets, vecteurs, méta. Partagé par background, offscreen et panneau.
const DB_NAME = 'xbs';
const VERSION = 3;

import { MODELS } from './models.js';
import { mergeVideo, isVideoItem } from './youtube.js';

// Chaque modèle a son propre magasin de vecteurs : changer de modèle n'écrase jamais les vecteurs de l'autre.
const VSTORES = ['vectors', 'vectors_gemma2'];
export const vstore = (modelId) => (modelId === MODELS.gemma2.id ? 'vectors_gemma2' : 'vectors');

let _db;
export function openDb() {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['tweets', 'vectors', 'vectors_gemma2', 'meta', 'imgvecs']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _db;
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

// Retourne le nombre de tweets réellement nouveaux.
export async function putTweets(tweets) {
  if (!tweets.length) return 0;
  const db = await openDb();
  const tx = db.transaction('tweets', 'readwrite');
  const store = tx.objectStore('tweets');
  let added = 0;
  await Promise.all(tweets.map(async (t) => {
    const old = await wrap(store.get(t.id));
    if (!old) added++;
    store.put({ ...old, ...t, capturedAt: old?.capturedAt ?? Date.now() });
  }));
  await done(tx);
  return added;
}

export async function getAllTweets() {
  const db = await openDb();
  return wrap(db.transaction('tweets').objectStore('tweets').getAll());
}

export async function getTweets(ids) {
  const db = await openDb();
  const store = db.transaction('tweets').objectStore('tweets');
  return (await Promise.all(ids.map((id) => wrap(store.get(id))))).filter(Boolean);
}

// model : si fourni, seuls les vecteurs calculés avec ce modèle sont retournés.
export async function getAllVectors(model) {
  const db = await openDb();
  const rows = await wrap(db.transaction(vstore(model)).objectStore(vstore(model)).getAll());
  return new Map(rows.filter((r) => !model || r.model === model).map((r) => [r.id, r.vec]));
}

export async function putVectors(items, model) {
  const db = await openDb();
  const st = vstore(model);
  const tx = db.transaction(st, 'readwrite');
  for (const { id, vec } of items) tx.objectStore(st).put({ id, vec, model });
  await done(tx);
}

// Tweets sans vecteur pour `model`. Chaque modèle a son propre magasin : on ne lit que les clés (pas les vecteurs,
// qui pèsent des dizaines de Mo à copier à chaque passage).
export async function pendingIds(model) {
  const db = await openDb();
  const [t, v] = await Promise.all([
    wrap(db.transaction('tweets').objectStore('tweets').getAllKeys()),
    wrap(db.transaction(vstore(model)).objectStore(vstore(model)).getAllKeys()),
  ]);
  const have = new Set(v);
  return t.filter((id) => !have.has(id));
}

export async function counts(model) {
  const db = await openDb();
  const [tweets, vectors] = await Promise.all([
    wrap(db.transaction('tweets').objectStore('tweets').count()),
    wrap(db.transaction(vstore(model)).objectStore(vstore(model)).count()),
  ]);
  return { tweets, vectors };
}

export async function getMeta(key) {
  const db = await openDb();
  return (await wrap(db.transaction('meta').objectStore('meta').get(key)))?.value;
}
export async function setMeta(key, value) {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await done(tx);
}

// Vide les vecteurs d'un modèle (ou de tous si `model` est omis).
export async function clearVectors(model) {
  const db = await openDb();
  const stores = model ? [vstore(model)] : VSTORES;
  const tx = db.transaction(stores, 'readwrite');
  for (const st of stores) tx.objectStore(st).clear();
  await done(tx);
}

export async function getAllTweetKeys() {
  const db = await openDb();
  return wrap(db.transaction('tweets').objectStore('tweets').getAllKeys());
}
export async function getAllVectorKeys(model) {
  const db = await openDb();
  return wrap(db.transaction(vstore(model)).objectStore(vstore(model)).getAllKeys());
}
export async function getVectors(ids, model) {
  const db = await openDb();
  const store = db.transaction(vstore(model)).objectStore(vstore(model));
  const rows = await Promise.all(ids.map((id) => wrap(store.get(id))));
  return new Map(rows.filter((r) => r && (!model || r.model === model)).map((r) => [r.id, r.vec]));
}

// Fusionne `patch` dans un tweet existant (enrichissement des liens, etc.).
export async function updateTweet(id, patch) {
  const db = await openDb();
  const tx = db.transaction('tweets', 'readwrite');
  const store = tx.objectStore('tweets');
  const old = await wrap(store.get(id));
  if (old) store.put({ ...old, ...patch });
  await done(tx);
}

// Supprime les vecteurs (le tweet sera ré-embeddé par la boucle d'indexation).
export async function invalidateVectors(ids) {
  if (!ids.length) return;
  const db = await openDb();
  const tx = db.transaction(VSTORES, 'readwrite');
  for (const id of ids) for (const st of VSTORES) tx.objectStore(st).delete(id);
  await done(tx);
}

export async function deleteTweets(ids) {
  if (!ids.length) return;
  const db = await openDb();
  const stores = ['tweets', ...VSTORES, 'imgvecs'];
  const tx = db.transaction(stores, 'readwrite');
  for (const id of ids) for (const st of stores) tx.objectStore(st).delete(id);
  await done(tx);
}

// model : 'clip' ou 'gemma2' (les images n'ont de sens que dans l'espace de leur modèle).
export async function putImgVectors(items, model) {
  const db = await openDb();
  const tx = db.transaction('imgvecs', 'readwrite');
  for (const { id, vec } of items) tx.objectStore('imgvecs').put({ id, vec, model });
  await done(tx);
}
export async function getAllImgVectors(model) {
  const db = await openDb();
  const rows = await wrap(db.transaction('imgvecs').objectStore('imgvecs').getAll());
  return rows.filter((r) => !model || (r.model || 'clip') === model);
}
export async function getAllImgKeys(model) {
  return (await getAllImgVectors(model)).map((r) => r.id);
}

// Parcourt les tweets avec un curseur et retourne les ids pour lesquels predicate(tweet) est vrai.
export async function scanTweets(predicate) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction('tweets').objectStore('tweets').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve(out);
      if (predicate(c.value)) out.push(c.key);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// Vidéos YouTube : fusion avec l'existant (appartenance aux playlists = union). Retourne le nombre de nouvelles vidéos.
export async function putVideos(items) {
  if (!items.length) return 0;
  const db = await openDb();
  const tx = db.transaction('tweets', 'readwrite');
  const store = tx.objectStore('tweets');
  let added = 0;
  await Promise.all(items.map(async (it) => {
    const old = await wrap(store.get(it.id));
    if (!old) added++;
    store.put({ ...mergeVideo(old, it), capturedAt: old?.capturedAt ?? Date.now() });
  }));
  await done(tx);
  return added;
}

// Historique : retourne le nombre de NOUVEAUX couples (vidéo, jour) — sert à arrêter une synchro incrémentale.
export async function putHistory(items) {
  if (!items.length) return 0;
  const db = await openDb();
  const tx = db.transaction('tweets', 'readwrite');
  const store = tx.objectStore('tweets');
  let fresh = 0;
  await Promise.all(items.map(async (it) => {
    const old = await wrap(store.get(it.id));
    if (it.watched?.length ? !(old?.watched || []).includes(it.watched[0]) : !old) fresh++;
    store.put({ ...mergeVideo(old, it), capturedAt: old?.capturedAt ?? Date.now() });
  }));
  await done(tx);
  return fresh;
}

// Après une synchro COMPLÈTE d'une playlist : retire l'appartenance des vidéos qui n'y sont plus.
// Retourne les ids des vidéos qui ne sont plus dans AUCUNE playlist (à proposer à la suppression).
export async function reconcilePlaylist(playlistId, seenIds) {
  const stale = await scanTweets((t) => isVideoItem(t) && (t.playlists || []).some((p) => p.id === playlistId) && !seenIds.has(t.id));
  const orphans = [];
  for (const id of stale) {
    const db = await openDb();
    const tx = db.transaction('tweets', 'readwrite');
    const store = tx.objectStore('tweets');
    const t = await wrap(store.get(id));
    if (t) {
      t.playlists = (t.playlists || []).filter((p) => p.id !== playlistId);
      store.put(t);
      if (!t.playlists.length && !(t.watched || []).length) orphans.push(id);
    }
    await done(tx);
  }
  return orphans;
}
