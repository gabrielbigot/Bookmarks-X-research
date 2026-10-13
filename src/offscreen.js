// Document hors-écran : héberge le modèle d'embedding (transformers.js + ONNX Runtime Web)
// et la boucle d'indexation. Tout tourne en local ; seul le premier téléchargement du modèle sort.
import { AutoModel, AutoTokenizer, env } from '@huggingface/transformers';
import { pendingIds, getTweets, putVectors, setMeta } from './lib/db.js';
import { DIM, tweetText } from './lib/search.js';

export const MODEL_ID = 'onnx-community/embeddinggemma-300m-ONNX';
const DTYPE = 'q8'; // q8 ≈ 300 Mo ; 'fp32' plus précis mais ~1,2 Go
const BATCH = 8;

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/');
env.backends.onnx.wasm.numThreads = 1; // pas de SharedArrayBuffer dans une page d'extension

// État interrogeable par le panneau (les messages envoyés avant son ouverture seraient perdus).
const status = { model: 'idle', pct: 0, device: '', indexing: false, done: 0, total: 0, error: '' };
const emit = (msg) => {
  if (msg.type === 'modelProgress') { status.model = msg.ready ? 'ready' : 'loading'; if (msg.pct != null) status.pct = msg.pct; }
  if (msg.type === 'modelDevice') status.device = msg.device;
  if (msg.type === 'indexProgress') { status.indexing = true; status.done = msg.done; status.total = msg.total; }
  if (msg.type === 'indexDone') { status.indexing = false; status.error = ''; }
  if (msg.type === 'indexError') { status.indexing = false; status.model = status.model === 'ready' ? 'ready' : 'error'; status.error = msg.message; }
  chrome.runtime.sendMessage(msg).catch(() => {});
};

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

let indexing = false;
let lastFailure = 0;
async function indexLoop() {
  if (indexing || Date.now() - lastFailure < 60_000) return; // pas de retry en rafale après une erreur
  indexing = true;
  try {
    for (;;) {
      const ids = await pendingIds();
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
    await setMeta('lastIndexed', Date.now());
    emit({ type: 'indexDone' });
  } catch (e) {
    lastFailure = Date.now();
    console.error('[xbs] indexation', e);
    emit({ type: 'indexError', message: String(e?.message || e) });
  } finally {
    indexing = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type === 'off:index') { if (msg.force) lastFailure = 0; indexLoop(); return false; }
  if (msg?.type === 'off:status') { sendResponse(status); return false; }
  if (msg?.type === 'off:embedQuery') {
    embed([queryPrompt(msg.text)])
      .then(([v]) => sendResponse({ vec: Array.from(v) }))
      .catch((e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }
  return false;
});
