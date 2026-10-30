// Document hors-écran : héberge les modèles (transformers.js + ONNX Runtime Web) et les boucles de fond :
// enrichissement des liens, indexation sémantique, embeddings d'images. Tout tourne en local ;
// seuls le premier téléchargement des modèles et la lecture des pages liées (si activée) sortent.
// NB : un document offscreen n'a accès qu'à chrome.runtime -> la config arrive par message.
import { AutoModel, AutoTokenizer, AutoProcessor, CLIPVisionModelWithProjection, CLIPTextModelWithProjection, RawImage, pipeline, load_image, env } from '@huggingface/transformers';
import { resetDb, isClosingError, pendingIds, getTweets, putVectors, setMeta, scanTweets, updateTweet, putImgVectors, getAllImgKeys, pendingChunkIds, getTranscripts, putChunkVecs } from './lib/db.js';
import { sampleChunks } from './lib/transcript.js';
import { tweetText } from './lib/search.js';
import { modelOf } from './lib/models.js';
import { fetchMeta, isPublicUrl, linkTextOf, cardFromMeta } from './lib/links.js';

const BATCH = 8;

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/');
env.backends.onnx.wasm.numThreads = 1; // relevé plus bas si la page est « cross-origin isolated » (voir threadsWanted)

let config = { enrichLinks: false, imageSearch: false, embedModel: 'gemma1', compute: 'cpu', indexMode: 'manual' };
let stopRequested = false; // arrêt demandé par l'utilisateur (non persistant)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cur = () => modelOf(config.embedModel);

// État interrogeable par le panneau (les messages envoyés avant son ouverture seraient perdus).
const status = {
  modelKey: 'gemma1',
  asleep: false, recycles: 0, dtype: '',
  model: 'idle', pct: 0, device: '', indexing: false, done: 0, total: 0, error: '',
  enrich: { active: false, done: 0, total: 0 },
  images: { active: false, done: 0, total: 0, error: '' },
};
const emit = (msg) => {
  if (msg.type === 'modelProgress') { status.model = msg.ready ? 'ready' : 'loading'; if (msg.pct != null) status.pct = msg.pct; }
  if (msg.type === 'modelDevice') status.device = msg.device;
  if (msg.type === 'indexProgress') { status.indexing = true; status.done = msg.done; status.total = msg.total; }
  if (msg.type === 'indexDone') { status.indexing = false; status.error = ''; }
  if (msg.type === 'indexError') { status.indexing = false; status.model = status.model === 'ready' ? 'ready' : 'error'; status.error = msg.message; }
  chrome.runtime.sendMessage(msg).catch(() => {});
};

// ---------------- embeddings de texte ----------------
const loaded = new Map(); // clé de modèle -> promesse { kind, ... }
const progressCb = (p) => {
  if (p.status === 'progress') emit({ type: 'modelProgress', file: p.file, pct: Math.round(p.progress) });
  if (p.status === 'ready') emit({ type: 'modelProgress', pct: 100, ready: true });
};
const devices = () => (config.compute !== 'cpu' && navigator.gpu ? ['webgpu', 'wasm'] : ['wasm']);

// Essaie WebGPU puis WASM.
async function withDevice(load) {
  const tries = devices();
  for (const device of tries) {
    try {
      const r = await load(device);
      emit({ type: 'modelDevice', device });
      return r;
    } catch (e) {
      console.warn('[xbs] device', device, 'a échoué', e);
      if (device === tries.at(-1)) throw e;
    }
  }
}

async function loadGemma1(m) {
  const tokenizer = await AutoTokenizer.from_pretrained(m.id, { progress_callback: progressCb });
  const model = await withDeviceAndDtype({ dtype: m.dtype }, (device, dtype) => AutoModel.from_pretrained(m.id, { dtype, device, progress_callback: progressCb }));
  return { kind: 'gemma1', tokenizer, model };
}

// Précisions à essayer, de la plus légère à la plus lourde. « q4 » n'est pas géré par le CPU (WASM) :
// ERROR_CODE 9, « Could not find an implementation for GatherBlockQuantized » -> on passe à q8, puis fp32.
// Calcul CPU multi-threads : exige SharedArrayBuffer (page isolée, cf. manifest). Au moindre souci on retombe sur 1 thread.
const threadsWanted = () => {
  if (!self.crossOriginIsolated) return 1;
  const hw = navigator.hardwareConcurrency || 4;
  const t = config.threads === 'auto' && budget !== Infinity ? Math.min(2, Math.max(1, hw - 2)) : config.threads === '1' ? 1 : config.threads === '2' ? 2 : config.threads === '6' ? 6 : Math.min(4, Math.max(1, hw - 2));
  return Math.max(1, Math.min(t, hw));
};
const dtypesFor = (device, preferred) => (device === 'webgpu' ? [preferred, 'q8', 'fp32'] : ['q8', 'fp32']);

// Essaie chaque appareil (GPU puis CPU) × chaque précision, jusqu'à ce qu'une combinaison fonctionne.
async function withDeviceAndDtype(m, load) {
  let lastErr;
  for (const device of devices()) {
    for (const dtype of dtypesFor(device, m.dtype)) {
      const threads = device === 'wasm' ? threadsWanted() : 1;
      for (const th of threads > 1 ? [threads, 1] : [1]) {
        try {
          if (device === 'wasm') env.backends.onnx.wasm.numThreads = th;
          const r = await load(device, dtype);
          status.device = device; status.dtype = dtype; status.threads = th;
          emit({ type: 'modelDevice', device });
          return r;
        } catch (e) {
          lastErr = e;
          console.warn(`[xbs] ${device}/${dtype} ×${th} a échoué`, e);
        }
      }
    }
  }
  throw lastErr;
}

// EmbeddingGemma 2 (transformers.js ≥ 4.3.1) : texte seul = pipeline feature-extraction (seul l'encodeur texte est chargé).
async function loadGemma2(m) {
  const extractor = await withDeviceAndDtype(m, (device, dtype) => pipeline('feature-extraction', m.id, { device, dtype, progress_callback: progressCb }));
  return { kind: 'gemma2', extractor };
}

// ---- hygiène mémoire : les moteurs ONNX gardent des tampons (surtout en WebGPU) qui ne redescendent pas tout seuls ----
const RECYCLE_EVERY = 120; // lots de 8 tweets (~1000 tweets) : on libère puis recharge le modèle (depuis le cache, quelques secondes)
const IDLE_MS = 10 * 60_000; // modèle libéré après 10 min sans usage ; rechargé à la demande
let batchesSinceLoad = 0, idleTimer;

async function disposeModels() {
  const pending = [...loaded.values(), g2Multi, clipPromise].filter(Boolean);
  loaded.clear(); g2Multi = undefined; clipPromise = undefined;
  for (const p of pending) {
    try {
      const m = await p;
      for (const part of [m.model, m.extractor, m.vision, m.text]) await part?.dispose?.();
    } catch { /* déjà libéré ou jamais chargé */ }
  }
  batchesSinceLoad = 0;
  status.model = 'idle';
  status.asleep = true;
  status.pct = 0;
}
const touch = () => {
  status.asleep = false;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!processing) disposeModels(); }, IDLE_MS);
};

function loadModel() {
  touch();
  const m = cur();
  if (!loaded.has(m.key)) {
    loaded.set(m.key, (m.key === 'gemma2' ? loadGemma2(m) : loadGemma1(m))
      .then((r) => { emit({ type: 'modelProgress', pct: 100, ready: true }); return r; })
      .catch((e) => { loaded.delete(m.key); throw e; }));
  }
  return loaded.get(m.key);
}

function l2(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

async function embed(texts) {
  const m = cur();
  const loadedModel = await loadModel();
  if (loadedModel.kind === 'gemma2') {
    const out = await loadedModel.extractor(texts, { pooling: 'mean', normalize: true });
    const dim = out.dims.at(-1);
    const res = texts.map((_, i) => l2(Float32Array.from(out.data.subarray(i * dim, (i + 1) * dim))));
    out.dispose?.();
    return res;
  }
  const { tokenizer, model } = loadedModel;
  // Forme d'entrée FIXE (8 × 128) : le moteur ne recompile / ne met pas en cache une forme par longueur de lot.
  const inputs = tokenizer(texts, { padding: 'max_length', truncation: true, max_length: 128 });
  const out = await model(inputs);
  let t = out.sentence_embedding;
  let dim, data;
  if (t) {
    dim = t.dims.at(-1);
    data = t.data;
  } else {
    // Repli : mean pooling sur last_hidden_state.
    const h = out.last_hidden_state;
    const [b, s, d] = h.dims;
    const mask = inputs.attention_mask.data;
    data = new Float32Array(b * d);
    for (let i = 0; i < b; i++) {
      let cnt = 0;
      for (let j = 0; j < s; j++) {
        if (Number(mask[i * s + j])) { cnt++; for (let k = 0; k < d; k++) data[i * d + k] += h.data[(i * s + j) * d + k]; }
      }
      for (let k = 0; k < d; k++) data[i * d + k] /= cnt || 1;
    }
    dim = d;
  }
  // Matryoshka : on tronque à m.dim dimensions puis on renormalise.
  const res = texts.map((_, i) => l2(Float32Array.from(data.subarray(i * dim, i * dim + m.dim)))); // copie : indépendante des tampons du moteur
  for (const tensor of Object.values(out)) tensor?.dispose?.(); // libère les sorties (tampons GPU)
  return res;
}

const docPrompt = (t) => `title: none | text: ${t}`;
const queryPrompt = (q) => `task: search result | query: ${q}`;

// Indexe tous les tweets sans vecteur (pour le modèle courant), sauf ceux de `exclude` (en attente d'enrichissement des liens).
const gentle = () => budget !== Infinity; // tranche automatique en arrière-plan : on laisse du temps de calcul au navigateur
const pace = async (t0) => { const dt = performance.now() - t0; await sleep(gentle() ? Math.min(1500, Math.max(60, dt * 1.2)) : config.compute === 'cpu' ? 20 : 0); };
let budget = Infinity; // textes encore autorisés pour ce passage (indexation par tranches)
async function indexLoop(exclude = new Set()) {
  const m = cur();
  for (;;) {
    if (budget <= 0) break;
    const ids = (await pendingIds(m.id)).filter((id) => !exclude.has(id)).slice(0, budget === Infinity ? undefined : budget);
    if (!ids.length) break;
    let done = 0;
    const total = ids.length;
    emit({ type: 'indexProgress', done, total });
    for (let i = 0; i < ids.length; i += BATCH) {
      if (cur().key !== m.key || stopRequested) return; // modèle changé / pause : on s'arrête (la boucle sera relancée)
      const tweets = await getTweets(ids.slice(i, i + BATCH));
      const tB = performance.now();
      const vecs = await embed(tweets.map((t) => docPrompt(tweetText(t))));
      if (cur().key !== m.key) return;
      await putVectors(tweets.map((t, k) => ({ id: t.id, vec: vecs[k] })), m.id);
      done += tweets.length;
      budget -= tweets.length;
      if ((i / BATCH) % 4 === 0) emit({ type: 'indexProgress', done, total });
      if (++batchesSinceLoad >= RECYCLE_EVERY) { await disposeModels(); status.recycles++; }
      await pace(tB); // laisse respirer la machine (et le navigateur)
    }
  }
}

// Passages de transcription : au plus 12 par vidéo, embeddings rangés par vidéo (la recherche prend le meilleur passage).
async function chunkLoop() {
  const m = cur();
  const ids = (await pendingChunkIds(m.id)).slice(0, budget === Infinity ? undefined : Math.max(0, Math.ceil(budget / 6)));
  if (!ids.length) return;
  let done = 0;
  emit({ type: 'indexProgress', done, total: ids.length, label: 'transcriptions' });
  // Les passages de plusieurs vidéos partagent les mêmes lots (pas de lot à moitié vide) ; une vidéo est enregistrée dès que tous ses passages sont calculés.
  const pend = new Map(); // id -> { out, left, k }
  let queue = []; // [{ id, i, text }]
  const flush = async (all) => {
    while (queue.length >= BATCH || (all && queue.length)) {
      const part = queue.splice(0, BATCH);
      const tB = performance.now();
      const vecs = await embed(part.map((c) => docPrompt(c.text)));
      if (cur().key !== m.key) return false;
      part.forEach((c, k) => { const p = pend.get(c.id); p.out.set(vecs[k], c.i * m.dim); p.left--; });
      const finished = [...pend].filter(([, p]) => p.left === 0);
      if (finished.length) {
        await putChunkVecs(finished.map(([id, p]) => ({ id, vecs: p.out, k: p.k })), m.id);
        for (const [id] of finished) pend.delete(id);
        done += finished.length;
        emit({ type: 'indexProgress', done, total: ids.length, label: 'transcriptions' });
      }
      if (++batchesSinceLoad >= RECYCLE_EVERY) { await disposeModels(); status.recycles++; }
      await pace(tB);
      if (stopRequested) return false;
    }
    return true;
  };
  for (const id of ids) {
    if (cur().key !== m.key || stopRequested) return;
    const chunks = sampleChunks((await getTranscripts([id])).get(id) || [], config.trPassages || 12);
    if (!chunks.length) { await putChunkVecs([{ id, vecs: new Float32Array(0), k: 0 }], m.id); done++; continue; }
    pend.set(id, { out: new Float32Array(chunks.length * m.dim), left: chunks.length, k: chunks.length });
    chunks.forEach((c, i) => queue.push({ id, i, text: c.text }));
    if (!(await flush(false))) return;
  }
  await flush(true);
}

// ---------------- enrichissement des liens ----------------
// cardsV : version du format des cartes (2 = avec image/site) — les tweets enrichis avant sont relus une fois.
const CARDS_V = 2;
const needsLinks = (t) => (!t.linksTriedAt || (t.cardsV || 0) < CARDS_V) && [...(t.links || []), ...(t.quoted?.links || [])].some(isPublicUrl);

async function enrichIds(ids) {
  status.enrich = { active: true, done: 0, total: ids.length };
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const [t] = await getTweets([id]);
      if (!t) continue;
      const urls = [...new Set([...(t.links || []), ...(t.quoted?.links || [])].filter(isPublicUrl))].slice(0, 3);
      const metas = [];
      for (const u of urls) metas.push(await fetchMeta(u));
      const cards = urls.map((u, k) => cardFromMeta(u, metas[k])).filter(Boolean); // url = lien d'origine (celui du tweet)
      await updateTweet(id, { linkText: linkTextOf(metas), cards, cardsV: CARDS_V, linksTriedAt: Date.now() });
      status.enrich.done++;
      if (status.enrich.done % 10 === 0) emit({ type: 'enrichProgress', ...status.enrich });
      await new Promise((r) => setTimeout(r, 120)); // politesse envers les sites
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  status.enrich.active = false;
  emit({ type: 'tweetsEnriched', count: ids.length });
}

// ---------------- recherche d'images ----------------
// Gemma 1 : CLIP (expérimental, anglais). Gemma 2 : les images sont dans le même espace que le texte (multimodal).
let clipPromise;
const CLIP_ID = 'Xenova/clip-vit-base-patch32';
function loadClip() {
  clipPromise ??= (async () => {
    const processor = await AutoProcessor.from_pretrained(CLIP_ID);
    const vision = await CLIPVisionModelWithProjection.from_pretrained(CLIP_ID, { dtype: 'q8' });
    const tokenizer = await AutoTokenizer.from_pretrained(CLIP_ID);
    const text = await CLIPTextModelWithProjection.from_pretrained(CLIP_ID, { dtype: 'q8' });
    return { processor, vision, tokenizer, text };
  })().catch((e) => { clipPromise = undefined; throw e; });
  return clipPromise;
}
let g2Multi;
function loadGemma2Multi() {
  const m = modelOf('gemma2');
  g2Multi ??= (async () => {
    const processor = await AutoProcessor.from_pretrained(m.id, { progress_callback: progressCb });
    const model = await withDeviceAndDtype(m, (device, dtype) => AutoModel.from_pretrained(m.id, { device, dtype, progress_callback: progressCb }));
    return { processor, model };
  })().catch((e) => { g2Multi = undefined; throw e; });
  return g2Multi;
}

const imgUrl = (url) => url + (url.includes('?') ? '&' : '?') + 'name=small';

async function embedImage(url) {
  if (cur().imageModel === 'gemma2') {
    const { processor, model } = await loadGemma2Multi();
    const image = await load_image(imgUrl(url));
    const out = await model(await processor(null, image));
    return l2(Float32Array.from(out.sentence_embedding.data));
  }
  const { processor, vision } = await loadClip();
  const img = await RawImage.read(imgUrl(url));
  const { image_embeds } = await vision(await processor(img));
  return l2(Float32Array.from(image_embeds.data));
}

async function embedClipText(q) {
  const { tokenizer, text } = await loadClip();
  const { text_embeds } = await text(tokenizer([q], { padding: true, truncation: true }));
  return l2(Float32Array.from(text_embeds.data));
}

async function imageLoop() {
  const m = cur();
  const tag = m.imageModel;
  try {
    const have = new Set(await getAllImgKeys(tag));
    const ids = (await scanTweets((t) => (t.media || []).length > 0)).filter((id) => !have.has(id));
    status.images = { active: true, done: 0, total: ids.length, error: '' };
    for (let i = 0; i < ids.length; i += 4) {
      if (cur().key !== m.key || stopRequested) break;
      const tweets = await getTweets(ids.slice(i, i + 4));
      const items = [];
      for (const t of tweets) {
        let vec = new Float32Array(0); // échec : marqueur vide (pas de nouvelle tentative)
        try { vec = await embedImage(t.media[0].url); } catch (e) { console.warn('[xbs] image', t.id, e); }
        items.push({ id: t.id, vec });
      }
      await putImgVectors(items, tag);
      status.images.done += tweets.length;
      if ((i / 4) % 5 === 0) emit({ type: 'imageProgress', ...status.images });
    }
    status.images.active = false;
    emit({ type: 'imageProgress', ...status.images });
  } catch (e) {
    console.error('[xbs] images', e);
    status.images.active = false;
    status.images.error = String(e?.message || e);
    emit({ type: 'imageProgress', ...status.images });
  }
}

// ---------------- boucle principale ----------------
let processing = false, rerun = false, lastFailure = 0;
let closingRetries = 0;
async function processAll(run = false, limit) {
  if (!(config.indexMode === 'auto' || run)) return; // mode manuel : jamais sans demande explicite
  if (run) stopRequested = false;
  if (processing) { rerun = true; return; }
  if (Date.now() - lastFailure < 60_000) return; // pas de retry en rafale après une erreur
  processing = true;
  budget = limit || Infinity;
  try {
    do {
      rerun = false;
      try {
        const waiting = new Set(config.enrichLinks ? await scanTweets(needsLinks) : []);
        await indexLoop(waiting);
        if (waiting.size) {
          await enrichIds([...waiting]);
          await indexLoop();
        }
        await chunkLoop();
        await setMeta('lastIndexed', Date.now());
        emit({ type: 'indexDone' });
      } catch (e) {
        if (isClosingError(e) && closingRetries < 3) { // connexion à la base fermée par le navigateur : on la rouvre et on reprend (sans message d'erreur)
          closingRetries++; resetDb(); console.warn('[xbs] base fermée, nouvelle connexion', e); await sleep(1000); rerun = true; continue;
        }
        lastFailure = Date.now();
        console.error('[xbs] indexation', e);
        emit({ type: 'indexError', message: String(e?.message || e) });
        status.enrich.active = false;
      }
      closingRetries = 0;
      if (config.imageSearch) await imageLoop();
    } while (rerun);
  } finally {
    processing = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type === 'off:index') {
    if (msg.config) {
      const switched = msg.config.embedModel && msg.config.embedModel !== config.embedModel;
      const computeChanged = msg.config.compute && msg.config.compute !== config.compute;
      config = { ...config, ...msg.config };
      if (computeChanged && !processing) disposeModels(); // le prochain chargement utilisera le nouveau mode de calcul
      status.modelKey = config.embedModel;
      if (switched) Object.assign(status, { model: loaded.has(config.embedModel) ? 'ready' : 'idle', pct: 0, device: '', error: '', indexing: false });
    }
    if (msg.force) lastFailure = 0;
    processAll(!!msg.run, msg.limit);
    return false;
  }
  if (msg?.type === 'off:stop') { stopRequested = true; (processing ? Promise.resolve() : disposeModels()).then(() => sendResponse({ ok: true })); return true; }
  if (msg?.type === 'off:free') { disposeModels().then(() => sendResponse({ ok: true })); return true; }
  if (msg?.type === 'off:status') {
    const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null; // Mo de tas JS (la mémoire GPU n'est pas mesurable ici)
    sendResponse({ ...status, memMB: mem });
    return false;
  }
  if (msg?.type === 'off:embedQuery') {
    if (msg.config) config = { ...config, ...msg.config };
    const clipText = msg.kind === 'image' && cur().imageModel === 'clip';
    const job = clipText ? embedClipText(msg.text) : embed([queryPrompt(msg.text)]).then(([v]) => v);
    job.then((v) => sendResponse({ vec: Array.from(v), model: cur().key })).catch((e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }
  return false;
});
