// Export / import des bookmarks (JSON), avec chiffrement optionnel (AES-GCM + PBKDF2).
const MAGIC = new TextEncoder().encode('XBSE1'); // fichier chiffré
const ITER = 200_000;

async function keyFrom(pass, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// extra : { saved: string[], vectors: {model, dim, scale, ids, data} } (facultatif)
export function toJson(tweets, extra = {}) {
  return JSON.stringify({ format: 'xbs-backup', version: 2, exportedAt: new Date().toISOString(), count: tweets.length, tweets, ...extra });
}

// ---- vecteurs : quantifiés en int8 (valeurs d'un vecteur unitaire dans [-1, 1]) puis base64 -> ~4× plus petit que du float32 ----
const SCALE = 127;
function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// entries : [{ id, vec: Float32Array }] tous de même dimension.
export function packVectors(model, dim, entries) {
  const good = entries.filter((e) => e.vec?.length === dim);
  const q = new Int8Array(good.length * dim);
  good.forEach((e, i) => { for (let d = 0; d < dim; d++) q[i * dim + d] = Math.max(-127, Math.min(127, Math.round(e.vec[d] * SCALE))); });
  return { model, dim, scale: SCALE, ids: good.map((e) => e.id), data: toB64(new Uint8Array(q.buffer)) };
}

export function unpackVectors(v) {
  const q = new Int8Array(fromB64(v.data).buffer);
  return v.ids.map((id, i) => {
    const vec = new Float32Array(v.dim);
    let n = 0;
    for (let d = 0; d < v.dim; d++) { vec[d] = q[i * v.dim + d] / (v.scale || SCALE); n += vec[d] * vec[d]; }
    n = Math.sqrt(n) || 1;
    for (let d = 0; d < v.dim; d++) vec[d] /= n; // renormalise : la quantification a légèrement changé la norme
    return { id, vec };
  });
}

// Retourne un Uint8Array : JSON brut, ou [MAGIC | sel | iv | chiffré] si passphrase.
export async function encode(tweets, passphrase, extra) {
  const bytes = new TextEncoder().encode(toJson(tweets, extra));
  if (!passphrase) return bytes;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(passphrase, salt), bytes));
  const out = new Uint8Array(MAGIC.length + 16 + 12 + enc.length);
  out.set(MAGIC, 0); out.set(salt, MAGIC.length); out.set(iv, MAGIC.length + 16); out.set(enc, MAGIC.length + 28);
  return out;
}

export const isEncrypted = (bytes) => MAGIC.every((b, i) => bytes[i] === b);

// Retourne { tweets, saved, vectors } ; lève une erreur lisible si mauvais mot de passe / fichier invalide.
export async function decodeFull(bytes, passphrase) {
  let json = bytes;
  if (isEncrypted(bytes)) {
    if (!passphrase) throw new Error('Fichier chiffré : mot de passe requis.');
    const salt = bytes.slice(MAGIC.length, MAGIC.length + 16);
    const iv = bytes.slice(MAGIC.length + 16, MAGIC.length + 28);
    try {
      json = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await keyFrom(passphrase, salt), bytes.slice(MAGIC.length + 28)));
    } catch {
      throw new Error('Mot de passe incorrect (ou fichier corrompu).');
    }
  }
  let data;
  try { data = JSON.parse(new TextDecoder().decode(json)); } catch { throw new Error('Fichier illisible.'); }
  if (data?.format !== 'xbs-backup' || !Array.isArray(data.tweets)) throw new Error('Ce fichier n’est pas une sauvegarde X Bookmarks.');
  return {
    tweets: data.tweets.filter((t) => t && t.id && typeof t.text === 'string'),
    saved: Array.isArray(data.saved) ? data.saved.filter((q) => typeof q === 'string') : [],
    vectors: data.vectors?.data && Array.isArray(data.vectors.ids) ? data.vectors : null,
  };
}

// Compatibilité : uniquement les tweets.
export async function decode(bytes, passphrase) {
  return (await decodeFull(bytes, passphrase)).tweets;
}
