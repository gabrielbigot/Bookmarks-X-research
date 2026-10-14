// Statistiques YouTube (local). La période porte sur les DATES DE VISIONNAGE (historique) ; la bibliothèque (playlists, à regarder) n'en dépend pas.
import { dayKey, parseDayStart } from './time.js';
import { decodeEntities, isStopword } from './text.js';
import { normalizeText } from './search.js';
import { isVideoItem } from './youtube.js';
import { addDays, eachDay, mondayOf, monthOf, top, count } from './stats.js';

const DAY = 86_400_000;
const DUR_BINS = [['< 5 min', 300], ['5 – 20 min', 1200], ['20 min – 1 h', 3600], ['≥ 1 h', Infinity]];
const durBin = (s) => DUR_BINS.findIndex(([, max]) => s < max);
// Une vidéo « commencée » affiche sa progression ; sans progression, on la compte entièrement regardée (estimation).
const watchedSec = (t) => (t.durationSec || 0) * (t.progress ? Math.min(100, t.progress) / 100 : 1);
export const fmtHours = (sec) => { const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`; };

export function computeYtStats(items, { now = Date.now(), rangeDays = null } = {}) {
  const videos = items.filter(isVideoItem);
  const todayKey = dayKey(now);
  const fromKey = rangeDays ? dayKey(now - (rangeDays - 1) * DAY) : null;
  const inRange = (d) => !fromKey || d >= fromKey;

  const perDay = new Map(), perWeekday = new Array(7).fill(0), channels = new Map(), chName = new Map(), chSec = new Map(), words = new Map(), durs = [0, 0, 0, 0];
  const seenIds = new Set(); // vidéos distinctes vues dans la période
  let views = 0, sec = 0, started = 0;
  const rewatch = [];

  for (const t of videos) {
    const days = (t.watched || []).filter(inRange);
    if (!days.length) continue;
    seenIds.add(t.id);
    views += days.length;
    for (const d of days) {
      count(perDay, d);
      perWeekday[(new Date(parseDayStart(d)).getDay() + 6) % 7]++;
    }
    const w = watchedSec(t) * days.length;
    sec += w;
    if (t.progress && t.progress < 90) started++;
    count(channels, t.handle, days.length); chName.set(t.handle, t.name || t.handle); count(chSec, t.handle, w);
    if (t.durationSec) durs[durBin(t.durationSec)] += days.length;
    if ((t.watched || []).length > 1) rewatch.push(t);
    const plain = decodeEntities(t.text || '').toLowerCase();
    for (const x of new Set(plain.match(/\p{L}[\p{L}\p{N}'’-]{3,}/gu) || [])) if (!isStopword(normalizeText(x))) count(words, x);
  }

  // ---- séries ----
  const keys = [...perDay.keys()].sort();
  const startKey = fromKey || keys[0] || todayKey;
  const days = eachDay(startKey, todayKey);
  const daily = days.map((k) => ({ k, n: perDay.get(k) || 0 }));
  daily.forEach((d, i) => { const w = daily.slice(Math.max(0, i - 6), i + 1); d.ma = w.reduce((s, x) => s + x.n, 0) / w.length; });
  let gran = 'day', points = daily;
  if (days.length > 800) { const m = new Map(); for (const d of daily) count(m, monthOf(d.k), d.n); gran = 'month'; points = [...m].map(([k, n]) => ({ k, n })); }
  else if (days.length > 120) { const m = new Map(); for (const d of daily) count(m, mondayOf(d.k), d.n); gran = 'week'; points = [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, n]) => ({ k, n })); }

  // calendrier : 12 derniers mois, toute la période de l'historique (indépendant du filtre)
  const allPer = new Map();
  for (const t of videos) for (const d of t.watched || []) count(allPer, d);
  const heat = allPer.size ? eachDay(mondayOf(addDays(todayKey, -364)), todayKey).map((k) => ({ k, n: allPer.get(k) || 0 })) : [];

  const active = daily.filter((d) => d.n > 0).length;
  let best = { day: null, n: 0 };
  for (const d of daily) if (d.n > best.n) best = { day: d.k, n: d.n };

  // ---- bibliothèque (playlists) : indépendante de la période ----
  const pls = new Map(), plTitle = new Map();
  for (const t of videos) for (const p of t.playlists || []) { count(pls, p.id); if (p.title) plTitle.set(p.id, p.title); }
  const unseen = (pid) => videos.filter((t) => (t.playlists || []).some((p) => p.id === pid) && !(t.watched || []).length);
  const wl = unseen('WL');
  const inPl = videos.filter((t) => (t.playlists || []).length);
  const backlogAll = inPl.filter((t) => !(t.watched || []).length);
  const oldestBacklog = [...wl].sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0)).slice(0, 8);

  return {
    n: seenIds.size, rangeDays, startKey, hasHistory: allPer.size > 0,
    kpi: { videos: videos.length, seen: seenIds.size, views, hours: sec, avgPerActiveDay: active ? views / active : 0, activeDays: active, days: days.length, best, started, channels: channels.size,
      inPlaylists: inPl.length, backlog: backlogAll.length, backlogSec: backlogAll.reduce((s, t) => s + (t.durationSec || 0), 0), wlBacklog: wl.length, wlBacklogSec: wl.reduce((s, t) => s + (t.durationSec || 0), 0) },
    series: { gran, points }, heat, weekday: perWeekday,
    channels: top(channels, 20).map(([handle, n]) => ({ handle, name: chName.get(handle), n, sec: chSec.get(handle) || 0 })),
    durations: DUR_BINS.map(([label], i) => ({ label, n: durs[i] })),
    playlists: top(pls, 15).map(([id, n]) => ({ id, title: plTitle.get(id) || id, n })),
    words: top(words, 40), rewatched: rewatch.sort((a, b) => b.watched.length - a.watched.length).slice(0, 10), oldestBacklog,
  };
}
