// Banc d'essai : mesure la qualité de la recherche sur des requêtes avec résultats attendus.
// expect : liste d'ids de tweets, de @handles, ou de fragments de texte (insensibles à la casse).
export function matches(tweet, expect) {
  const txt = (tweet.text || '').toLowerCase();
  return expect.some((e) => {
    const x = String(e).toLowerCase();
    if (x === String(tweet.id).toLowerCase()) return true;
    if (x.startsWith('@')) return tweet.handle.toLowerCase() === x.slice(1);
    return txt.includes(x);
  });
}

// rankedTweets : tweets dans l'ordre des résultats. Retourne { hit10, rr, firstRank }.
export function score(rankedTweets, expect, k = 10) {
  const i = rankedTweets.findIndex((t) => matches(t, expect));
  return { hit10: i >= 0 && i < k ? 1 : 0, rr: i >= 0 ? 1 / (i + 1) : 0, firstRank: i >= 0 ? i + 1 : null };
}

export function summarize(scores) {
  const n = scores.length || 1;
  return {
    n: scores.length,
    recall10: scores.reduce((a, s) => a + s.hit10, 0) / n,
    mrr: scores.reduce((a, s) => a + s.rr, 0) / n,
  };
}
