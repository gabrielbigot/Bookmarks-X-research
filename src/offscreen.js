// Document hors-écran : héberge les modèles (transformers.js + ONNX Runtime Web) et les boucles de fond :
// enrichissement des liens, indexation sémantique, embeddings d'images. Tout tourne en local ;
// seuls le premier téléchargement des modèles et la lecture des pages liées (si activée) sortent.
// NB : un document offscreen n'a accès qu'à chrome.runtime -> la config arrive par message.
import { AutoModel, AutoTokenizer, AutoProcessor, CLIPVisionModelWithProjection, CLIPTextModelWithProjection, RawImage, env } from '@huggingface/transformers';
import { pendingIds, getTweets, putVectors, setMeta, scanTweets, updateTweet, putImgVectors, getAllImgKeys } from './lib/db.js';
import { DIM, tweetText } from './lib/search.js';
import { fetchMeta, isPublicUrl, linkTextOf } from './lib/links.js';

export const MODEL_ID = 'onnx-community/embeddinggemma-300m-ONNX';
const DTYPE = 'q8'; // q8 ≈ 300 Mo ; 'fp32' plus précis mais ~1,2 Go
const BATCH = 8;
const CLIP_ID = 'Xenova/clip-vit-base-patch32'; // recherche d'images (expérimental)

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/');
env.backends.onnx.wasm.numThreads = 1; // pas de SharedArrayBuffer dans une page d'extension

let config = { enrichLinks: false, imageSearch: false };

// État interrogeable par le panneau (les messages envoyés avant son ouverture seraient perdus).
const status = {
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
let modelPromise;
function loadModel() {
  modelPromise ??= (async () => {
    const progress_callback = (p) => {
      if (p.status === 'progress') emit({ type: 'modelProgress', file: p.file, pct: Math.round(p.progress) });
      if (p.status === 'ready') emit({ type: 'modelProgress', pct: 100, ready: true });
    };
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback });
    let model;
    const tries = navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
    for (const device of tries) {
      try {
        model = await AutoModel.from_pretrained(MODEL_ID, { dtype: DTYPE, device, progress_callback });
        emit({ type: 'modelDevice', device });
        break;
      } catch (e) {
        console.warn('[xbs] device', device, 'a échoué', e);
        if (device === tries.at(-1)) throw e;
      }
    }
    emit({ type: 'modelProgress', pct: 100, ready: true });
    return { tokenizer, model };
  })().catch((e) => { modelPromise = undefined; throw e; });
  return modelPromise;
}

function l2(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

async function embed(texts) {
  const { tokenizer, model } = await loadModel();
  const inputs = tokenizer(texts, { padding: true, truncation: true, max_length: 256 });
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
  // Matryoshka : on tronque à DIM dimensions puis on renormalise.
  return texts.map((_, i) => l2(Float32Array.from(data.subarray(i * dim, i * dim + DIM))));
}

const docPrompt = (t) => `title: none | text: ${t}`;
const queryPrompt = (q) => `task: search result | query: ${q}`;

// Indexe tous les tweets sans vecteur, sauf ceux de `exclude` (en attente d'enrichissement des liens).
async function indexLoop(exclude = new Set()) {
  for (;;) {
    const ids = (await pendingIds()).filter((id) => !exclude.has(id));
    if (!ids.length) break;
    let done = 0;
    const total = ids.length;
    emit({ type: 'indexProgress', done, total });
    for (let i = 0; i < ids.length; i += BATCH) {
      const tweets = await getTweets(ids.slice(i, i + BATCH));
      const vecs = await embed(tweets.map((t) => docPrompt(tweetText(t))));
      await putVectors(tweets.map((t, k) => ({ id: t.id, vec: vecs[k] })), MODEL_ID);
      done += tweets.length;
      if ((i / BATCH) % 4 === 0) emit({ type: 'indexProgress', done, total });
    }
  }
}

// ---------------- enrichissement des liens ----------------
const needsLinks = (t) => !t.linksTriedAt && [...(t.links || []), ...(t.quoted?.links || [])].some(isPublicUrl);

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
      await updateTweet(id, { linkText: linkTextOf(metas), linksTriedAt: Date.now() });
      status.enrich.done++;
      if (status.enrich.done % 10 === 0) emit({ type: 'enrichProgress', ...status.enrich });
      await new Promise((r) => setTimeout(r, 120)); // politesse envers les sites
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  status.enrich.active = false;
  emit({ type: 'tweetsEnriched', count: ids.length });
}

// ---------------- recherche d'images (CLIP, expérimental) ----------------
let clipPromise;
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

async function embedImage(url) {
  const { processor, vision } = await loadClip();
  const img = await RawImage.read(url + (url.includes('?') ? '&' : '?') + 'name=small');
  const { image_embeds } = await vision(await processor(img));
  return l2(Float32Array.from(image_embeds.data));
}

async function embedClipText(q) {
  const { tokenizer, text } = await loadClip();
  const { text_embeds } = await text(tokenizer([q], { padding: true, truncation: true }));
  return l2(Float32Array.from(text_embeds.data));
}

async function imageLoop() {
  try {
    const have = new Set(await getAllImgKeys());
    const ids = (await scanTweets((t) => (t.media || []).length > 0)).filter((id) => !have.has(id));
    status.images = { active: true, done: 0, total: ids.length, error: '' };
    for (let i = 0; i < ids.length; i += 4) {
      const tweets = await getTweets(ids.slice(i, i + 4));
      const items = [];
      for (const t of tweets) {
        let vec = new Float32Array(0); // échec : marqueur vide (pas de nouvelle tentative)
        try { vec = await embedImage(t.media[0].url); } catch (e) { console.warn('[xbs] image', t.id, e); }
        items.push({ id: t.id, vec });
      }
      await putImgVectors(items);
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
async function processAll() {
  if (processing) { rerun = true; return; }
  if (Date.now() - lastFailure < 60_000) return; // pas de retry en rafale après une erreur
  processing = true;
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
        await setMeta('lastIndexed', Date.now());
        emit({ type: 'indexDone' });
      } catch (e) {
        lastFailure = Date.now();
        console.error('[xbs] indexation', e);
        emit({ type: 'indexError', message: String(e?.message || e) });
        status.enrich.active = false;
      }
      if (config.imageSearch) await imageLoop();
    } while (rerun);
  } finally {
    processing = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type === 'off:index') {
    if (msg.config) config = { ...config, ...msg.config };
    if (msg.force) lastFailure = 0;
    processAll();
    return false;
  }
  if (msg?.type === 'off:status') { sendResponse(status); return false; }
  if (msg?.type === 'off:embedQuery') {
    const job = msg.kind === 'image' ? embedClipText(msg.text) : embed([queryPrompt(msg.text)]).then(([v]) => v);
    job.then((v) => sendResponse({ vec: Array.from(v) })).catch((e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }
  return false;
});
