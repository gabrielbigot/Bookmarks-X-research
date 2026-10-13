// Compréhension (par règles) des requêtes en langage naturel :
//   « le tweet le plus vieux d'OpenAI »  ->  tri par date + filtre auteur.
import { normalizeText } from './search.js';

const OLDEST = /\b(?:le |la |les |tout )?(?:plus (?:vieux|vieille|vieilles|vieux|ancien|anciens|ancienne|anciennes)|tout premier|premier|oldest|earliest|first ever)\b/;
const NEWEST = /\b(?:le |la |les )?(?:plus (?:recent|recents|recente|recentes|nouveau|nouveaux)|dernier|derniers|derniere|dernieres|newest|latest|most recent)\b/;
const AUTHOR = /\b(?:d'|de |du |des |from |by |par |of )@?([a-z0-9_.-]{3,})/;

// Retourne { text, sort, author } ; author = { token, phrase } ou null.
// Les positions sont calculées sur le texte normalisé (accents retirés, même longueur).
export function interpret(raw) {
  let text = raw;
  const norm = normalizeText(raw);
  let sort = null;
  const strip = (re) => {
    const m = re.exec(normalizeText(text));
    if (!m) return null;
    text = text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);
    return m;
  };
  if (norm.length === raw.length) { // garde-fou : normalisation qui change la longueur (ligatures)
    if (strip(OLDEST)) sort = 'oldest';
    else if (strip(NEWEST)) sort = 'newest';
  }
  let author = null;
  const m = AUTHOR.exec(normalizeText(text));
  if (m && normalizeText(text).length === text.length) {
    author = { token: m[1].replace(/[.-]+$/, ''), phrase: text.slice(m.index, m.index + m[0].length) };
  }
  return { text: text.replace(/\s+/g, ' ').trim(), sort, author };
}

// Comptes dont le nom ou le @handle correspond au mot demandé.
export function findAuthors(tweets, token) {
  const t = normalizeText(token);
  if (t.length < 3) return [];
  const seen = new Map();
  for (const tw of tweets) {
    const h = tw.handle.toLowerCase();
    if (seen.has(h)) continue;
    const nameWords = normalizeText(tw.name || '').split(/[^a-z0-9]+/).filter(Boolean);
    const hit = nameWords.some((w) => w.startsWith(t)) || normalizeText(h).startsWith(t) || normalizeText(h).includes(t);
    if (hit) seen.set(h, { handle: tw.handle, name: tw.name || tw.handle });
  }
  return [...seen.values()];
}
