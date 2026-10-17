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
    const cue = n.transcriptCueRenderer; // ancien format : { cue: { simpleText }, startOffsetMs }
    if (cue) {
      const text = clean(txt(cue.cue));
      const ms = Number(cue.startOffsetMs);
      if (text && Number.isFinite(ms)) out.push({ t: Math.round(ms / 1000), text });
      return;
    }
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

const unent = (x) => x.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// Sous-titres au format XML (timedtext : <text start="1.5" dur="2">…</text>, ou <p t="1500"><s>…</s></p>)
export function parseTimedTextXml(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<text\b[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)) {
    const text = clean(unent(m[2].replace(/<[^>]+>/g, '')));
    if (text) out.push({ t: Math.round(parseFloat(m[1])), text });
  }
  if (out.length) return out;
  for (const m of String(xml || '').matchAll(/<p\b[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) {
    const text = clean(unent(m[2].replace(/<[^>]+>/g, '')));
    if (text) out.push({ t: Math.round(+m[1] / 1000), text });
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

// Transcription par un modèle qui regarde la vidéo (Gemini via OpenRouter, lien YouTube) : pour les vidéos sans sous-titres (récentes).
export function aiTranscriptMessages(video) {
  const id = video.videoId || String(video.id || '').replace(/^yt:/, '');
  const dur = video.durationText ? `, durée ${video.durationText}` : '';
  return [{ role: 'user', content: [
    { type: 'text', text: `Transcris fidèlement la partie parlée de cette vidéo YouTube (« ${String(video.text || '').slice(0, 120)} », chaîne ${video.name || '?'}${dur}), dans la langue parlée, sans résumer ni reformuler. Une ligne par passage d’environ 20 à 40 secondes, au format exact « [mm:ss] texte » (« [h:mm:ss] » après une heure), du début à la fin de la vidéo. N’ajoute aucun commentaire avant ou après. Si un passage est inaudible, écris [inaudible].` },
    { type: 'video_url', video_url: { url: `https://www.youtube.com/watch?v=${id}` } },
  ] }];
}
// « [12:40] texte » / « [1:02:03] texte » / « 12:40 - texte » -> [{ t, text }]
export function parseAiTranscript(text) {
  const out = [];
  for (const line of String(text || '').split(/\n+/)) {
    const m = /^\s*[\[(]?(?:(\d+):)?(\d{1,3}):(\d{2})[\])]?\s*[-–—:]?\s*(.+)$/.exec(line);
    if (!m) continue;
    const t = (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
    const txt = clean(m[4]);
    if (txt && !/^\[?inaudible\]?$/i.test(txt)) out.push({ t, text: txt });
  }
  return out;
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

// ---- gain de vitesse : le jeton `params` de get_transcript est un message protobuf encodé en base64 qui contient l'identifiant
// de la vidéo en clair. Appris une fois (via « next »), il se réécrit pour une autre vidéo : une seule requête par vidéo au lieu de deux.
// Un modèle ne sert qu'à tenter ; en cas d'échec l'appelant retombe sur « next » (jamais de « sans transcription » conclu à partir d'un modèle).
export function learnTemplate(params, videoId) {
  try {
    const pct = /%[0-9A-Fa-f]{2}/.test(params);
    const raw = pct ? decodeURIComponent(params) : params;
    const urlSafe = /[-_]/.test(raw);
    const std = raw.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
    const i = bin.indexOf(videoId);
    if (i < 0 || bin.indexOf(videoId, i + 1) >= 0 || !videoId) return null;
    return { prefix: bin.slice(0, i), suffix: bin.slice(i + videoId.length), len: videoId.length, pct, urlSafe, padded: raw.endsWith('=') };
  } catch { return null; }
}
export function deriveParams(tpl, videoId) {
  if (!tpl || videoId.length !== tpl.len) return null;
  let b = btoa(tpl.prefix + videoId + tpl.suffix);
  if (tpl.urlSafe) b = b.replace(/\+/g, '-').replace(/\//g, '_');
  if (!tpl.padded) b = b.replace(/=+$/, '');
  return tpl.pct ? encodeURIComponent(b) : b;
}
