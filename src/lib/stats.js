// Statistiques sur les bookmarks (tout est calculé localement, sur le sous-ensemble choisi par le filtre de période).
import { savedInfo, dayKey, parseDayStart } from './time.js';
import { decodeEntities, isStopword } from './text.js';
import { normalizeText } from './search.js';

const DAY = 86_400_000;
const count = (map, k, n = 1) => map.set(k, (map.get(k) || 0) + n);
const top = (map, n) => [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
const median = (arr) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pubMs = (t) => (t.createdAt ? Date.parse(t.createdAt) : null);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
// même page, quelle que soit la forme du lien : sans http(s)://, sans www., sans « / » final ni #ancre
const normLink = (l) => { try { const u = new URL(l); return u.hostname.replace(/^www\./, '').toLowerCase() + u.pathname.replace(/\/$/, '') + u.search; } catch { return l; } };
const SKIP_HOST = /^(x\.com|twitter\.com|t\.co|pic\.twitter\.com|mobile\.twitter\.com)$/;

export const typeOf = (t) => {
  const media = t.media || [];
  if (media.some((m) => m.type === 'video' || m.type === 'animated_gif')) return 'video';
  if (media.length) return 'photo';
  if ((t.links || []).some((l) => !SKIP_HOST.test(hostOf(l))) || t.xcard) return 'link';
  if (t.quoted) return 'quote';
  return 'text';
};
export const TYPE_LABELS = { video: 'Vidéo', photo: 'Photo', link: 'Lien', quote: 'Citation', text: 'Texte seul' };

const addDays = (key, n) => dayKey(parseDayStart(key) + n * DAY + 3 * 3600_000); // +3 h : insensible aux changements d'heure
function eachDay(fromKey, toKey) {
  const out = [];
  for (let k = fromKey, i = 0; k <= toKey && i < 20000; k = addDays(k, 1), i++) out.push(k);
  return out;
}
const mondayOf = (key) => { const d = new Date(parseDayStart(key)); return addDays(key, -((d.getDay() + 6) % 7)); };
const monthOf = (key) => key.slice(0, 7);

// rangeDays : null (tout) ou nombre de jours. now : injectable pour les tests.
export function computeStats(all, { now = Date.now(), rangeDays = null } = {}) {
  const sv = savedInfo(all, now);
  const basis = sv.valid ? 'saved' : 'published';
  const keyMs = (t) => (sv.valid ? sv.at(t) : pubMs(t));
  const from = rangeDays ? parseDayStart(dayKey(now - (rangeDays - 1) * DAY)) : null;
  const tweets = from === null ? all : all.filter((t) => (keyMs(t) ?? -1) >= from);

  // ---- agrégats simples ----
  const authors = new Map(), types = new Map(), langs = new Map(), domains = new Map(), hashtags = new Map(), mentions = new Map(), words = new Map(), links = new Map(), linkUrl = new Map();
  const authorName = new Map(), authorLikes = new Map();
  const likes = [];
  let totalLikes = 0, firstPub = null, lastPub = null;
  const hist = [0, 0, 0, 0, 0, 0]; // 0-9, 10-99, 100-999, 1k-9,9k, 10k-99k, 100k+
  const perDay = new Map(), perHour = new Array(24).fill(0), perWeekday = new Array(7).fill(0), pubMonth = new Map();
  const age = [0, 0, 0, 0, 0]; // < 1 jour, < 1 semaine, < 1 mois, < 1 an, plus ancien
  let ageN = 0;

  for (const t of tweets) {
    count(authors, t.handle);
    authorName.set(t.handle, t.name || t.handle);
    const lk = t.stats?.likes || 0;
    count(authorLikes, t.handle, lk);
    likes.push(lk); totalLikes += lk;
    hist[lk < 10 ? 0 : lk < 100 ? 1 : lk < 1000 ? 2 : lk < 10000 ? 3 : lk < 100000 ? 4 : 5]++;
    count(types, typeOf(t));
    if (t.lang) count(langs, t.lang);
    const hosts = new Set();
    for (const l of [...(t.links || []), ...(t.quoted?.links || [])]) {
      const h = hostOf(l);
      if (h && !SKIP_HOST.test(h)) hosts.add(h);
      if (h && !SKIP_HOST.test(h)) { const key = normLink(l); count(links, key); if (!linkUrl.has(key)) linkUrl.set(key, l); }
    }
    for (const h of hosts) count(domains, h);

    const text = decodeEntities(t.text || '');
    // une seule fois par tweet : on compte des tweets, pas des occurrences
    for (const h of new Set([...text.matchAll(/#[\p{L}\p{N}_]{2,}/gu)].map((m) => m[0].toLowerCase()))) count(hashtags, h);
    for (const h of new Set([...text.matchAll(/@[A-Za-z0-9_]{2,15}/g)].map((m) => m[0].toLowerCase()))) if (h !== '@' + t.handle.toLowerCase()) count(mentions, h);
    const plain = text.replace(/https?:\/\/\S+/g, ' ').replace(/[@#][\p{L}\p{N}_]+/gu, ' ');
    // mots conservés AVEC leurs accents pour l'affichage ; les mots courants sont repérés sans accents
    for (const w of new Set(plain.toLowerCase().match(/\p{L}[\p{L}\p{N}'’-]{3,}/gu) || [])) if (!isStopword(normalizeText(w))) count(words, w);

    const p = pubMs(t);
    if (p !== null) { if (firstPub === null || p < firstPub) firstPub = p; if (lastPub === null || p > lastPub) lastPub = p; count(pubMonth, monthOf(dayKey(p))); }
    const s = sv.valid ? sv.at(t) : null;
    if (s !== null) {
      count(perDay, dayKey(s));
      const d = new Date(s);
      perHour[d.getHours()]++;
      perWeekday[(d.getDay() + 6) % 7]++;
      if (p !== null && s >= p) { const dt = s - p; age[dt < DAY ? 0 : dt < 7 * DAY ? 1 : dt < 30 * DAY ? 2 : dt < 365 * DAY ? 3 : 4]++; ageN++; }
    } else if (!sv.valid && p !== null) count(perDay, dayKey(p)); // repli : on trace par date de publication
  }

  // ---- séries temporelles ----
  const todayKey = dayKey(now);
  const dayKeys = [...perDay.keys()].sort();
  const startKey = from !== null ? dayKey(from) : dayKeys[0] || todayKey;
  const endKey = sv.valid ? todayKey : (dayKeys.at(-1) || todayKey);
  const days = eachDay(startKey, endKey);
  const daily = days.map((k) => ({ k, n: perDay.get(k) || 0 }));
  const ma = daily.map((_, i) => { const a = Math.max(0, i - 6); const w = daily.slice(a, i + 1); return w.reduce((s, x) => s + x.n, 0) / w.length; });
  daily.forEach((d, i) => (d.ma = ma[i]));

  let gran = 'day', points = daily;
  if (days.length > 800) { // par mois
    const m = new Map(); for (const d of daily) count(m, monthOf(d.k), d.n);
    gran = 'month'; points = [...m].map(([k, n]) => ({ k, n }));
  } else if (days.length > 120) { // par semaine
    const m = new Map(); for (const d of daily) count(m, mondayOf(d.k), d.n);
    gran = 'week'; points = [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, n]) => ({ k, n }));
  }

  // cumulé : toute la collection (sur la même base de dates), recadré sur la période
  const allPer = new Map();
  for (const t of all) { const ms = keyMs(t); if (ms !== null) count(allPer, dayKey(ms)); }
  const allKeys = [...allPer.keys()].sort();
  let running = 0;
  const cumulAll = [];
  if (allKeys.length) for (const k of eachDay(allKeys[0], sv.valid ? todayKey : allKeys.at(-1))) { running += allPer.get(k) || 0; cumulAll.push({ k, n: running }); }
  const cumulative = from === null ? cumulAll : cumulAll.filter((x) => x.k >= startKey);

  // ---- séries d'activité ----
  const active = daily.filter((d) => d.n > 0).length;
  let best = { day: null, n: 0 };
  for (const d of daily) if (d.n > best.n) best = { day: d.k, n: d.n };
  let longest = 0, run = 0;
  for (const d of daily) { run = d.n > 0 ? run + 1 : 0; if (run > longest) longest = run; }
  let current = 0;
  for (let i = daily.length - 1; i >= 0; i--) { if (daily[i].n > 0) current++; else if (i === daily.length - 1) continue; else break; }
  const sumLast = (n) => daily.slice(-n).reduce((s, d) => s + d.n, 0);

  // ---- calendrier (53 semaines) : toute la collection, indépendant du filtre ----
  const heat = [];
  if (sv.valid) {
    const start = mondayOf(addDays(todayKey, -364));
    for (const k of eachDay(start, todayKey)) heat.push({ k, n: allPer.get(k) || 0 });
  }

  const nTweets = tweets.length;
  const typeList = ['video', 'photo', 'link', 'quote', 'text'].map((key) => ({ key, label: TYPE_LABELS[key], n: types.get(key) || 0 }));
  const topAuthors = top(authors, 30).map(([handle, n]) => ({ handle, name: authorName.get(handle), n, likes: authorLikes.get(handle) || 0 }));
  const topLiked = [...tweets].sort((a, b) => (b.stats?.likes || 0) - (a.stats?.likes || 0)).slice(0, 10)
    .map((t) => ({ id: t.id, url: t.url, handle: t.handle, text: decodeEntities(t.text || '').replace(/\s+/g, ' ').slice(0, 140), likes: t.stats?.likes || 0 }));

  return {
    n: nTweets, rangeDays, basis, savedValid: sv.valid, savedRatio: sv.ratio, startKey, endKey,
    kpi: {
      total: nTweets, authors: authors.size, activeDays: active, days: days.length,
      avgPerDay: days.length ? nTweets / days.length : 0, avgPerActiveDay: active ? nTweets / active : 0,
      best, streakLongest: longest, streakCurrent: current, last7: sumLast(7), last30: sumLast(30), today: daily.at(-1)?.k === todayKey ? daily.at(-1).n : 0,
      withMedia: (types.get('photo') || 0) + (types.get('video') || 0), withLink: types.get('link') || 0, withQuote: types.get('quote') || 0,
      langMain: top(langs, 1)[0]?.[0] || '', medianLikes: median(likes), totalLikes,
      firstPub: firstPub !== null ? dayKey(firstPub) : null, lastPub: lastPub !== null ? dayKey(lastPub) : null,
    },
    series: { gran, points }, cumulative, heat,
    weekday: sv.valid ? perWeekday : null, hour: sv.valid ? perHour : null,
    pubMonths: [...pubMonth].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, n]) => ({ k, n })),
    ageAtSave: ageN ? ['< 1 jour', '< 1 semaine', '< 1 mois', '< 1 an', 'plus ancien'].map((label, i) => ({ label, n: age[i] })) : null,
    types: typeList, langs: top(langs, 10), authors: topAuthors,
    domains: top(domains, 20), hashtags: top(hashtags, 30), mentions: top(mentions, 30), words: top(words, 40),
    likesHist: ['< 10', '10 – 99', '100 – 999', '1 k – 9,9 k', '10 k – 99 k', '≥ 100 k'].map((label, i) => ({ label, n: hist[i] })),
    topLiked, dupLinks: top(links, 50).filter(([, n]) => n > 1).slice(0, 10).map(([key, n]) => [linkUrl.get(key) || key, n]),
  };
}
