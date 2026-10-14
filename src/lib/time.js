// Dates des bookmarks. X ne donne pas « la date où tu as mis ce tweet en bookmark », mais l'ordre de la liste
// (sortIndex) est un identifiant de type « snowflake » dont les bits de poids fort sont un horodatage en ms.
// On le décode, et on VÉRIFIE que ça a l'air vrai (sinon on n'affiche aucune statistique basée dessus).
const X_EPOCH = 1288834974657n; // 2010-11-04, origine des identifiants X
const MIN_PLAUSIBLE = Date.UTC(2012, 0, 1);

export function snowflakeMs(id) {
  try {
    if (!/^\d{12,20}$/.test(String(id))) return null;
    return Number((BigInt(id) >> 22n) + X_EPOCH);
  } catch { return null; }
}

// Pour les tests et les maquettes : fabrique un identifiant dont le décodage donne `ms`.
export const makeSnowflake = (ms) => ((BigInt(ms) - X_EPOCH) << 22n).toString();

// Jour local au format YYYY-MM-DD.
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const parseDayStart = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

// -> { valid, ratio, causal, same, at(t) } ; at(t) = date de mise en bookmark (ms) ou null.
// Contrôles INDÉPENDANTS du décodage lui-même :
//  - plausible : la date décodée tombe entre 2012 et aujourd'hui ;
//  - causal    : on ne met pas un tweet en bookmark AVANT qu'il soit publié (date décodée ≥ date de publication) ;
//  - same      : si la date décodée est identique à la publication (à la seconde), c'est l'identifiant du tweet, pas
//                l'instant du bookmark -> inutilisable.
export function savedInfo(tweets, now = Date.now()) {
  const dates = new Map();
  let plausible = 0, causal = 0, same = 0, withPub = 0;
  for (const t of tweets) {
    const ms = snowflakeMs(t.sortIndex);
    if (ms === null || ms < MIN_PLAUSIBLE || ms > now + 2 * 86_400_000) continue;
    dates.set(t.id, ms);
    plausible++;
    const pub = t.createdAt ? Date.parse(t.createdAt) : NaN;
    if (!Number.isNaN(pub)) {
      withPub++;
      if (ms >= pub - 60_000) causal++;
      if (Math.abs(ms - pub) < 2000) same++;
    }
  }
  const ratio = tweets.length ? plausible / tweets.length : 0;
  const causalRatio = withPub ? causal / withPub : 0;
  const sameRatio = withPub ? same / withPub : 1;
  const valid = tweets.length >= 20 && ratio >= 0.6 && causalRatio >= 0.95 && sameRatio < 0.5;
  return { valid, ratio, causal: causalRatio, same: sameRatio, at: (t) => (valid ? dates.get(t.id) ?? null : null) };
}

const cache = new WeakMap(); // tweet -> ms | null (pour les filtres, évalués des dizaines de milliers de fois)
export function savedAtOf(t) {
  if (cache.has(t)) return cache.get(t);
  const ms = snowflakeMs(t.sortIndex);
  const v = ms !== null && ms >= MIN_PLAUSIBLE && ms <= Date.now() + 2 * 86_400_000 ? ms : null;
  cache.set(t, v);
  return v;
}
