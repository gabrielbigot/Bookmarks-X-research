// Stockage local (IndexedDB) : tweets, vecteurs, méta. Partagé par background, offscreen et panneau.
const DB_NAME = 'xbs';
const VERSION = 4;

import { MODELS } from './models.js';
import { mergeVideo, isVideoItem, videoOff, playlistFate, transcriptOrder } from './youtube.js';

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
      for (const name of ['tweets', 'vectors', 'vectors_gemma2', 'meta', 'imgvecs', 'transcripts', 'chunkvecs']) {
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

import { markBulkAdded } from './ytdate.js';
export async function getAllTweets() {
  const db = await openDb();
  return markBulkAdded(await wrap(db.transaction('tweets').objectStore('tweets').getAll()));
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
  const off = new Set(await scanTweets((x) => x.off)); // vidéos de playlists décochées : pas d'indexation
  return t.filter((id) => !have.has(id) && !off.has(id));
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
  const tx = db.transaction([...stores, 'chunkvecs'], 'readwrite');
  for (const st of stores) tx.objectStore(st).clear();
  tx.objectStore('chunkvecs').clear(); // les vecteurs de passages se recalculent avec les autres
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
  const stores = ['tweets', ...VSTORES, 'imgvecs', 'transcripts'];
  const tx = db.transaction([...stores, 'chunkvecs'], 'readwrite');
  for (const id of ids) {
    for (const st of stores) tx.objectStore(st).delete(id);
    for (const m of Object.values(MODELS)) tx.objectStore('chunkvecs').delete(id + '@' + m.id);
  }
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

// Parcourt tous les tweets avec un curseur, sans les accumuler en mémoire (fn reçoit chaque élément).
export async function eachTweet(fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('tweets').objectStore('tweets').openCursor();
    req.onsuccess = () => { const c = req.result; if (!c) return resolve(); fn(c.value); c.continue(); };
    req.onerror = () => reject(req.error);
  });
}

// Vidéos YouTube : fusion avec l'existant (appartenance aux playlists = union). Retourne le nombre de nouvelles vidéos.
export async function putVideos(items, excluded) {
  if (!items.length) return 0;
  const db = await openDb();
  const tx = db.transaction('tweets', 'readwrite');
  const store = tx.objectStore('tweets');
  let added = 0;
  await Promise.all(items.map(async (it) => {
    const old = await wrap(store.get(it.id));
    if (!old) added++;
    const m = mergeVideo(old, it);
    store.put({ ...m, off: videoOff(m, excluded), capturedAt: old?.capturedAt ?? Date.now() });
  }));
  await done(tx);
  return added;
}

// Historique : retourne le nombre de NOUVEAUX couples (vidéo, jour) — sert à arrêter une synchro incrémentale.
export async function putHistory(items, excluded) {
  if (!items.length) return 0;
  const db = await openDb();
  const tx = db.transaction('tweets', 'readwrite');
  const store = tx.objectStore('tweets');
  let fresh = 0;
  await Promise.all(items.map(async (it) => {
    const old = await wrap(store.get(it.id));
    if (it.watched?.length ? !(old?.watched || []).includes(it.watched[0]) : !old) fresh++;
    const m = mergeVideo(old, it);
    store.put({ ...m, off: videoOff(m, excluded), capturedAt: old?.capturedAt ?? Date.now() });
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

// ---------- transcriptions YouTube ----------
export const TR_VERSION = 2; // les « sans transcription » mémorisés par une version antérieure du lecteur sont ré-essayés
const TR_RETRY = 30 * 86_400_000; // une vidéo « sans transcription » est ré-essayée au bout de 30 jours

// chunks : [{ t, text }]. Marque aussi la vidéo (trState) pour que les listes n'aient pas à lire le texte.
export async function putTranscript(id, chunks, extra = {}) {
  const db = await openDb();
  const tx = db.transaction(['transcripts', 'tweets'], 'readwrite');
  tx.objectStore('transcripts').put({ id, chunks, at: Date.now(), ...extra });
  const old = await wrap(tx.objectStore('tweets').get(id));
  if (old) tx.objectStore('tweets').put({ ...old, trState: 'ok', trAt: Date.now(), trChars: chunks.reduce((n, c) => n + c.text.length, 0), ...(extra.trSource ? { trSource: extra.trSource } : { trSource: undefined }), ...(typeof extra.trCost === 'number' ? { trCost: extra.trCost } : { trCost: undefined }) });
  await done(tx);
}
export async function markNoTranscript(ids) {
  const db = await openDb();
  const tx = db.transaction('tweets', 'readwrite');
  const st = tx.objectStore('tweets');
  await Promise.all(ids.map(async (id) => { const old = await wrap(st.get(id)); if (old && old.trState !== 'ok') st.put({ ...old, trState: 'none', trAt: Date.now(), trV: TR_VERSION }); }));
  await done(tx);
}
export async function getTranscripts(ids) {
  const db = await openDb();
  const st = db.transaction('transcripts').objectStore('transcripts');
  return new Map((await Promise.all(ids.map((id) => wrap(st.get(id))))).filter(Boolean).map((r) => [r.id, r.chunks]));
}
export async function getAllTranscriptRows() {
  const db = await openDb();
  return wrap(db.transaction('transcripts').objectStore('transcripts').getAll());
}
export async function putTranscriptRows(rows) {
  const db = await openDb();
  const tx = db.transaction(['transcripts', 'tweets'], 'readwrite');
  for (const r of rows) {
    if (!r?.id || !Array.isArray(r.chunks)) continue;
    tx.objectStore('transcripts').put({ id: r.id, chunks: r.chunks, at: r.at || Date.now(), lang: r.lang });
    const old = await wrap(tx.objectStore('tweets').get(r.id));
    if (old) tx.objectStore('tweets').put({ ...old, trState: 'ok', trAt: r.at || Date.now(), trChars: r.chunks.reduce((n, c) => n + c.text.length, 0) });
  }
  await done(tx);
}

// Vidéos à transcrire. scope : 'playlists' (dans au moins une playlist) | 'all' (+ historique).
// Les plus récentes d'abord (voir transcriptOrder), jusqu'à la plus ancienne.
export async function pendingTranscriptIds(scope = 'playlists', limit = 400, now = Date.now()) {
  const cand = [];
  await eachTweet((t) => {
    if (isVideoItem(t) && !t.off && !t.unavailable && (scope === 'all' || (t.playlists || []).length > 0)
      && (!t.trState || (t.trState === 'none' && (t.trV !== TR_VERSION || now - (t.trAt || 0) > TR_RETRY)))) cand.push({ id: t.id, playlists: (t.playlists || []).map((p) => ({ pos: p.pos })), lastWatched: t.lastWatched || '', addedAt: t.addedAt || 0 });
  });
  return transcriptOrder(cand).slice(0, limit);
}

// Vecteurs des passages (par modèle) : une ligne par vidéo { id: 'yt:x@modelId', vid, model, k, vecs (k × dim, concaténés) }.
export async function putChunkVecs(items, model) {
  const db = await openDb();
  const tx = db.transaction('chunkvecs', 'readwrite');
  for (const { id, vecs, k } of items) tx.objectStore('chunkvecs').put({ id: id + '@' + model, vid: id, model, k, vecs });
  await done(tx);
}
export async function getAllChunkVecs(model) {
  const db = await openDb();
  const rows = await wrap(db.transaction('chunkvecs').objectStore('chunkvecs').getAll());
  return new Map(rows.filter((r) => r.model === model).map((r) => [r.vid, { vecs: r.vecs, k: r.k }]));
}
export async function getChunkVecKeys(model) {
  const db = await openDb();
  const keys = await wrap(db.transaction('chunkvecs').objectStore('chunkvecs').getAllKeys());
  return new Set(keys.filter((k) => k.endsWith('@' + model)).map((k) => k.slice(0, -model.length - 1)));
}
// Vidéos avec transcription mais sans vecteurs de passages pour ce modèle.
export async function pendingChunkIds(model) {
  const have = await getChunkVecKeys(model);
  const trIds = await scanTweets((t) => t.trState === 'ok' && !t.off);
  return trIds.filter((id) => !have.has(id));
}

// Nombre de vidéos connues par playlist (curseur : rien n'est gardé en mémoire).
export async function playlistCounts() {
  const db = await openDb();
  const out = {};
  await new Promise((res, rej) => {
    const req = db.transaction('tweets').objectStore('tweets').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return res();
      const v = c.value;
      if (typeof v.id === 'string' && v.id.startsWith('yt:')) for (const p of v.playlists || []) out[p.id] = (out[p.id] || 0) + 1;
      c.continue();
    };
    req.onerror = () => rej(req.error);
  });
  return out;
}

export async function getChunkVecsFor(ids, model) {
  const db = await openDb();
  const st = db.transaction('chunkvecs').objectStore('chunkvecs');
  const rows = await Promise.all(ids.map((id) => wrap(st.get(id + '@' + model))));
  return new Map(rows.filter(Boolean).map((r) => [r.vid, { vecs: r.vecs, k: r.k }]));
}

// Recalcule le drapeau `off` de toutes les vidéos selon les playlists décochées. Retourne le nombre de vidéos modifiées.
export async function applyYtSelection(excludedIds) {
  const ex = new Set(excludedIds || []);
  const db = await openDb();
  let changed = 0;
  const ids = await scanTweets((t) => isVideoItem(t) && !!t.off !== videoOff(t, ex));
  for (let i = 0; i < ids.length; i += 500) {
    const tx = db.transaction('tweets', 'readwrite');
    const st = tx.objectStore('tweets');
    await Promise.all(ids.slice(i, i + 500).map(async (id) => { const t = await wrap(st.get(id)); if (t) { st.put({ ...t, off: videoOff(t, ex) }); changed++; } }));
    await done(tx);
  }
  return changed;
}

// Playlists connues : { id, title, n } (n = vidéos en base), complétées par les playlists découvertes (méta) et WL / LL.
export async function playlistCatalog() {
  const db = await openDb();
  const map = new Map([['WL', { id: 'WL', title: 'À regarder plus tard', n: 0 }], ['LL', { id: 'LL', title: 'Vidéos que j’aime', n: 0 }]]);
  for (const p of (await getMeta('ytPlaylists')) || []) map.set(p.id, { ...map.get(p.id), id: p.id, title: p.title || map.get(p.id)?.title || p.id, n: map.get(p.id)?.n || 0, listed: p.count || 0 });
  await new Promise((res, rej) => {
    const req = db.transaction('tweets').objectStore('tweets').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return res();
      const v = c.value;
      if (typeof v.id === 'string' && v.id.startsWith('yt:')) for (const p of v.playlists || []) { const cur = map.get(p.id) || { id: p.id, title: p.title || p.id, n: 0 }; cur.n++; if (p.title && (!cur.title || cur.title === cur.id)) cur.title = p.title; map.set(p.id, cur); }
      c.continue();
    };
    req.onerror = () => rej(req.error);
  });
  return [...map.values()].sort((a, b) => (a.id === 'WL' ? -1 : b.id === 'WL' ? 1 : a.id === 'LL' ? -1 : b.id === 'LL' ? 1 : a.title.localeCompare(b.title)));
}

// ---------- suppression des données d'une playlist ----------
async function scanPlan(pid, alsoWatched) {
  const db = await openDb();
  const plan = { del: [], detach: [], watchedKept: 0, otherKept: 0 };
  await new Promise((res, rej) => {
    const req = db.transaction('tweets').objectStore('tweets').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return res();
      const t = c.value;
      if (typeof t.id === 'string' && t.id.startsWith('yt:')) {
        const f = playlistFate(t, pid, alsoWatched);
        if (f === 'delete') plan.del.push(t.id);
        else if (f === 'detach') { plan.detach.push(t.id); if ((t.watched || []).length && (t.playlists || []).every((p) => p.id === pid)) plan.watchedKept++; else plan.otherKept++; }
      }
      c.continue();
    };
    req.onerror = () => rej(req.error);
  });
  return plan;
}
// Aperçu (rien n'est modifié) : combien de vidéos seraient supprimées / conservées.
export async function planPlaylistDeletion(pid, alsoWatched = false) {
  const p = await scanPlan(pid, alsoWatched);
  return { total: p.del.length + p.detach.length, toDelete: p.del.length, watchedKept: p.watchedKept, otherKept: p.otherKept };
}
// Supprime les vidéos propres à la playlist (avec vecteurs, transcriptions, vecteurs de passages, verdicts) ; les autres perdent seulement l'appartenance.
export async function deletePlaylistData(pid, { alsoWatched = false, onProgress } = {}) {
  const plan = await scanPlan(pid, alsoWatched);
  const db = await openDb();
  for (let i = 0; i < plan.detach.length; i += 500) {
    const tx = db.transaction('tweets', 'readwrite');
    const st = tx.objectStore('tweets');
    await Promise.all(plan.detach.slice(i, i + 500).map(async (id) => {
      const t = await wrap(st.get(id));
      if (t) st.put({ ...t, playlists: (t.playlists || []).filter((p) => p.id !== pid) });
    }));
    await done(tx);
  }
  let deleted = 0;
  for (let i = 0; i < plan.del.length; i += 500) {
    await deleteTweets(plan.del.slice(i, i + 500));
    deleted += Math.min(500, plan.del.length - i);
    onProgress?.(deleted, plan.del.length);
  }
  // ménage : files d'attente et verdicts qui référençaient ces vidéos
  const gone = new Set(plan.del);
  if (gone.size) {
    const orph = (await getMeta('orphans')) || [];
    if (orph.some((id) => gone.has(id))) await setMeta('orphans', orph.filter((id) => !gone.has(id)));
    const vds = (await getMeta('detVerdicts')) || {};
    let touched = false;
    for (const d of Object.values(vds)) for (const id of Object.keys(d.v || {})) if (gone.has(id)) { delete d.v[id]; touched = true; }
    if (touched) await setMeta('detVerdicts', vds);
  }
  return { deleted: plan.del.length, detached: plan.detach.length };
}
