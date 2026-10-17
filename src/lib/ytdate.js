// Dates des vidéos : YouTube ne donne dans les listes qu'une date relative (« il y a 3 jours ») ; on la convertit en
// date approximative à partir du moment de la capture.
const UNITS = [
  [/^(?:seconde|second|sec)s?$/, 1000], [/^(?:minute|min)s?$/, 60_000], [/^(?:heure|hour|h)s?$/, 3_600_000],
  [/^(?:jour|day|j|d)s?$/, 86_400_000], [/^(?:semaine|week|sem|w)s?$/, 7 * 86_400_000], [/^(?:mois|month)s?$/, 30.44 * 86_400_000], [/^(?:an|ans|année|années|year|years|y)$/, 365.25 * 86_400_000],
];
const MONTHS = { janv: 0, jan: 0, fevr: 1, fev: 1, feb: 1, mars: 2, mar: 2, avr: 3, apr: 3, mai: 4, may: 4, juin: 5, jun: 5, juil: 6, jul: 6, aout: 7, aug: 7, sept: 8, sep: 8, oct: 9, nov: 10, dec: 11 };
const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// -> ms ou null
export function parsePublished(text, ref = Date.now()) {
  const s = fold(text || '').trim();
  if (!s) return null;
  if (/\b(hier|yesterday)\b/.test(s)) return ref - 86_400_000;
  if (/\b(aujourd|today)/.test(s)) return ref;
  const rel = /(?:il y a\s*(\d+(?:[.,]\d+)?)\s*([a-z]+))|(?:(\d+(?:[.,]\d+)?)\s*([a-z]+)\s+ago)/.exec(s);
  let m;
  if (rel) {
    const n = parseFloat((rel[1] || rel[3]).replace(',', '.'));
    const u = UNITS.find(([re]) => re.test(rel[2] || rel[4]));
    if (u) return Math.round(ref - n * u[1]);
  }
  m = /(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})/.exec(s) || /([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
  if (m) {
    const [d, mo, y] = /^\d/.test(m[1]) ? [m[1], m[2], m[3]] : [m[2], m[1], m[3]];
    const k = MONTHS[mo] ?? MONTHS[mo.slice(0, 4)] ?? MONTHS[mo.slice(0, 3)];
    if (k != null) return Date.UTC(+y, k, +d, 12);
  }
  return null;
}

// Date de publication estimée d'une vidéo (ms) : valeur enregistrée à la capture, sinon déduite du texte relatif.
export const videoPubMs = (t) => t.pubMs || parsePublished(t.publishedText, t.addedAt || Date.now()) || null;

// Dates d'ajout peu fiables : la date d'ajout d'une vidéo est celle où l'extension l'a vue pour la première fois. Quand des dizaines de
// vidéos portent la même date à quelques secondes près (première synchronisation, synchronisation complète, retard important), ce n'est
// pas une vraie date d'ajout : on marque ces vidéos (`addedBulk`, non enregistré) pour ne pas les compter dans « ajoutées cette semaine ».
export function markBulkAdded(items, { windowMs = 15_000, limit = 40 } = {}) {
  const vids = items.filter((t) => typeof t.id === 'string' && t.id.startsWith('yt:'));
  const times = vids.map((t) => t.addedAt || 0).filter(Boolean).sort((a, b) => a - b);
  // nombre de vidéos ajoutées à ± windowMs de chaque instant (fenêtre glissante, sans effet de bord de seau)
  const near = new Map();
  let lo = 0, hi = 0;
  for (let i = 0; i < times.length; i++) {
    while (times[lo] < times[i] - windowMs) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < times.length && times[hi + 1] <= times[i] + windowMs) hi++;
    near.set(times[i], hi - lo + 1);
  }
  for (const t of vids) t.addedBulk = !!t.addedAt && (near.get(t.addedAt) || 0) > limit;
  return items;
}
