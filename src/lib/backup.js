// Export / import des bookmarks (JSON), avec chiffrement optionnel (AES-GCM + PBKDF2).
const MAGIC = new TextEncoder().encode('XBSE1'); // fichier chiffré
const ITER = 200_000;

async function keyFrom(pass, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export function toJson(tweets) {
  return JSON.stringify({ format: 'xbs-backup', version: 1, exportedAt: new Date().toISOString(), count: tweets.length, tweets });
}

// Retourne un Uint8Array : JSON brut, ou [MAGIC | sel | iv | chiffré] si passphrase.
export async function encode(tweets, passphrase) {
  const bytes = new TextEncoder().encode(toJson(tweets));
  if (!passphrase) return bytes;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(passphrase, salt), bytes));
  const out = new Uint8Array(MAGIC.length + 16 + 12 + enc.length);
  out.set(MAGIC, 0); out.set(salt, MAGIC.length); out.set(iv, MAGIC.length + 16); out.set(enc, MAGIC.length + 28);
  return out;
}

export const isEncrypted = (bytes) => MAGIC.every((b, i) => bytes[i] === b);

// Retourne le tableau de tweets ; lève une erreur lisible si mauvais mot de passe / fichier invalide.
export async function decode(bytes, passphrase) {
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
  return data.tweets.filter((t) => t && t.id && typeof t.text === 'string');
}
