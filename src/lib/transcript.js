// Transcriptions YouTube : lecture des réponses (get_transcript, timedtext json3), découpage en passages datés,
// échantillonnage pour les embeddings, passage le plus pertinent pour une requête. Fonctions pures, testées.
import { txt } from './youtube.js';

const isObj = (x) => x && typeof x === 'object';
function deepFind(node, pred, depth = 0) {
  if (!isObj(node) || depth > 40) return undefined;
  if (Array.isArray(node)) { for (const x of node) { const r = deepFind(x, pred, depth + 1); if (r !== undefined) return r; } return undefined; }
  const hit = pred(node);
  if (hit !== undefined) return hit;
  for (const k of Object.keys(node)) { const r = deepFind(node[k], pred, depth + 1); if (r !== undefined) return r; }
  return undefined;
}

// Réponse « next » d'une vidéo -> jeton `params` du panneau « Transcription » (absent = pas de transcription).
export const findTranscriptParams = (json) => deepFind(json, (n) => (isObj(n.getTranscriptEndpoint) && typeof n.getTranscriptEndpoint.params === 'string' ? n.getTranscriptEndpoint.params : undefined)) || null;

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Réponse « get_transcript » -> [{ t (secondes), text }]
export function parseTranscript(json) {
  const out = [];
  (function walk(n, d = 0) {
    if (!isObj(n) || d > 40) return;
    if (Array.isArray(n)) { n.forEach((x) => walk(x, d + 1)); return; }
    const r = n.transcriptSegmentRenderer;
    if (r) {
      const text = clean(txt(r.snippet));
      const ms = Number(r.startMs);
      if (text && Number.isFinite(ms)) out.push({ t: Math.round(ms / 1000), text });
      return;
    }
    for (const k of Object.keys(n)) walk(n[k], d + 1);
  })(json);
  return out;
}

// Réponse du lecteur (« player ») -> pistes de sous-titres [{ url, lang, auto }]
export function captionTracks(playerJson) {
  const tracks = playerJson?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return (Array.isArray(tracks) ? tracks : []).filter((t) => typeof t.baseUrl === 'string')
    .map((t) => ({ url: t.baseUrl, lang: t.languageCode || '', auto: t.kind === 'asr' }));
}
export function pickTrack(tracks, prefer = ['fr', 'en']) {
  const rank = (t) => (prefer.indexOf(t.lang.slice(0, 2)) + 1 || 99) + (t.auto ? 0.5 : 0);
  return [...tracks].sort((a, b) => rank(a) - rank(b))[0] || null;
}

// Sous-titres au format json3 -> segments
export function parseJson3(json) {
  const out = [];
  for (const e of json?.events || []) {
    const text = clean((e.segs || []).map((s) => s.utf8 || '').join(''));
    if (text && Number.isFinite(e.tStartMs)) out.push({ t: Math.round(e.tStartMs / 1000), text });
  }
  return out;
}

// Segments -> passages d'environ `size` caractères (début daté). Écarte les annotations seules « [Musique] ».
export function chunkSegments(segs, { size = 450 } = {}) {
  const chunks = [];
  let cur = null;
  for (const s of segs) {
    if (/^\[[^\]]*\]$/.test(s.text)) continue;
    if (!cur) cur = { t: s.t, text: s.text };
    else cur.text += ' ' + s.text;
    if (cur.text.length >= size) { chunks.push(cur); cur = null; }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export const chunksText = (chunks, cap = 40000) => { let s = ''; for (const c of chunks) { if (s.length >= cap) break; s += c.text + ' '; } return s.slice(0, cap); };

// Au plus n passages, répartis sur toute la vidéo (le calcul d'embeddings reste borné pour les vidéos longues).
export function sampleChunks(chunks, n = 24) {
  if (chunks.length <= n) return chunks;
  return Array.from({ length: n }, (_, i) => chunks[Math.floor((i * chunks.length) / n)]);
}

// Passage contenant le plus de mots distincts de la requête (termes déjà normalisés par l'appelant : minuscules, sans accents).
export function bestChunk(chunks, terms, norm = (x) => x.toLowerCase()) {
  if (!chunks?.length || !terms?.length) return null;
  let best = null, bestN = 0;
  for (const c of chunks) {
    const low = norm(c.text);
    let n = 0;
    for (const t of terms) if (low.includes(t)) n++;
    if (n > bestN) { bestN = n; best = c; }
  }
  return best;
}

export const fmtTime = (sec) => { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0'); };
