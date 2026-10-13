// Stockage local (IndexedDB) : tweets, vecteurs, méta. Partagé par background, offscreen et panneau.
const DB_NAME = 'xbs';
const VERSION = 1;

let _db;
export function openDb() {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('tweets', { keyPath: 'id' });
      db.createObjectStore('vectors', { keyPath: 'id' });
      db.createObjectStore('meta', { keyPath: 'key' });
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

export async function getAllVectors() {
  const db = await openDb();
  const rows = await wrap(db.transaction('vectors').objectStore('vectors').getAll());
  return new Map(rows.map((r) => [r.id, r.vec]));
}

export async function putVectors(items, model) {
  const db = await openDb();
  const tx = db.transaction('vectors', 'readwrite');
  for (const { id, vec } of items) tx.objectStore('vectors').put({ id, vec, model });
  await done(tx);
}

export async function pendingIds() {
  const db = await openDb();
  const [t, v] = await Promise.all([
    wrap(db.transaction('tweets').objectStore('tweets').getAllKeys()),
    wrap(db.transaction('vectors').objectStore('vectors').getAllKeys()),
  ]);
  const have = new Set(v);
  return t.filter((id) => !have.has(id));
}

export async function counts() {
  const db = await openDb();
  const [tweets, vectors] = await Promise.all([
    wrap(db.transaction('tweets').objectStore('tweets').count()),
    wrap(db.transaction('vectors').objectStore('vectors').count()),
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

export async function clearVectors() {
  const db = await openDb();
  const tx = db.transaction('vectors', 'readwrite');
  tx.objectStore('vectors').clear();
  await done(tx);
}
