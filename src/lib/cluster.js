// Thèmes automatiques : k-means sphérique sur les embeddings + libellés TF-IDF.
import { DIM as DIM_DEFAULT, tokenize, tweetText } from './search.js';
import { isStopword } from './text.js';

function dot(a, ao, b, bo, DIM) {
  let s = 0;
  for (let d = 0; d < DIM; d++) s += a[ao + d] * b[bo + d];
  return s;
}

// rows : indices ayant un vecteur dans matrix. Retourne { centroids (k*DIM), assign: Int32Array(rows.length) }.
export function kmeans(matrix, rows, k, { iters = 12, sample = 4000, seed = 1, dim = DIM_DEFAULT } = {}) {
  const DIM = dim;
  let rnd = seed;
  const rand = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  k = Math.max(1, Math.min(k, rows.length));
  const pool = rows.length > sample ? Array.from({ length: sample }, () => rows[Math.floor(rand() * rows.length)]) : rows;
  // init k-means++
  const cent = new Float32Array(k * DIM);
  const first = pool[Math.floor(rand() * pool.length)];
  cent.set(matrix.subarray(first * DIM, first * DIM + DIM), 0);
  const best = new Float32Array(pool.length).fill(-2);
  for (let c = 1; c < k; c++) {
    let total = 0;
    const w = new Float32Array(pool.length);
    for (let i = 0; i < pool.length; i++) {
      const s = dot(matrix, pool[i] * DIM, cent, (c - 1) * DIM, DIM);
      if (s > best[i]) best[i] = s;
      w[i] = 1 - best[i] + 1e-6; // distance cosinus
      total += w[i];
    }
    let r = rand() * total, pick = 0;
    for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) { pick = i; break; } }
    cent.set(matrix.subarray(pool[pick] * DIM, pool[pick] * DIM + DIM), c * DIM);
  }
  const assignOf = (row) => {
    let bi = 0, bs = -2;
    for (let c = 0; c < k; c++) { const s = dot(matrix, row * DIM, cent, c * DIM, DIM); if (s > bs) { bs = s; bi = c; } }
    return bi;
  };
  for (let it = 0; it < iters; it++) {
    const sum = new Float32Array(k * DIM);
    const cnt = new Int32Array(k);
    for (const row of pool) {
      const c = assignOf(row);
      cnt[c]++;
      for (let d = 0; d < DIM; d++) sum[c * DIM + d] += matrix[row * DIM + d];
    }
    for (let c = 0; c < k; c++) {
      if (!cnt[c]) continue;
      let n = 0;
      for (let d = 0; d < DIM; d++) n += sum[c * DIM + d] ** 2;
      n = Math.sqrt(n) || 1;
      for (let d = 0; d < DIM; d++) cent[c * DIM + d] = sum[c * DIM + d] / n;
    }
  }
  const assign = new Int32Array(rows.length);
  for (let i = 0; i < rows.length; i++) assign[i] = assignOf(rows[i]);
  return { centroids: cent, assign, k };
}

// Libellé = termes les plus distinctifs du groupe (tf dans le groupe × idf global).
export function labelClusters(tweets, rows, assign, k, topN = 3) {
  const df = new Map();
  const perCluster = Array.from({ length: k }, () => new Map());
  const sizes = new Array(k).fill(0);
  rows.forEach((row, i) => {
    const toks = new Set(tokenize(tweetText(tweets[row])).filter((t) => t.length >= 3 && !isStopword(t) && !/^https?|^www|^@/.test(t)));
    const c = assign[i];
    sizes[c]++;
    for (const t of toks) {
      df.set(t, (df.get(t) || 0) + 1);
      perCluster[c].set(t, (perCluster[c].get(t) || 0) + 1);
    }
  });
  const N = rows.length;
  return perCluster.map((m, c) => {
    const scored = [...m]
      .filter(([, n]) => n >= Math.min(3, Math.ceil(sizes[c] * 0.1)))
      .map(([t, n]) => [t, n * Math.log(1 + N / df.get(t)) * (n / df.get(t))])
      .sort((a, b) => b[1] - a[1]);
    return scored.slice(0, topN).map(([t]) => t);
  });
}
