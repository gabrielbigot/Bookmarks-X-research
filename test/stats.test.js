import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, typeOf } from '../src/lib/stats.js';
import { makeSnowflake, snowflakeMs, savedInfo, dayKey } from '../src/lib/time.js';
import { parseQuery, passesFilters } from '../src/lib/search.js';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0); // 2026-10-14 midi UTC
const at = (daysAgo, hour = 12) => NOW - daysAgo * 86_400_000 + (hour - 12) * 3_600_000;
let seq = 0;
// Fabrique un tweet « mis en bookmark » il y a savedAgo jours, publié pubAgo jours avant la mise en bookmark.
const mk = (savedAgo, over = {}) => {
  const s = at(savedAgo, over.hour ?? 12);
  return { id: 't' + ++seq, text: 'texte ' + seq, handle: 'a', name: 'A', links: [], media: [], stats: { likes: 0 }, lang: 'fr',
    createdAt: new Date(s - (over.pubBefore ?? 2 * 86_400_000)).toISOString(), sortIndex: makeSnowflake(s), ...over };
};

test('time : décodage snowflake aller-retour, validité', () => {
  assert.equal(snowflakeMs(makeSnowflake(NOW)), NOW);
  const good = Array.from({ length: 40 }, (_, i) => mk(i % 10));
  const info = savedInfo(good, NOW);
  assert.equal(info.valid, true);
  assert.equal(info.at(good[3]), snowflakeMs(good[3].sortIndex));
  // sortIndex qui n'ont rien d'un horodatage (petits entiers) : pas de stats « enregistrement »
  const fake = Array.from({ length: 40 }, (_, i) => ({ id: 'f' + i, sortIndex: String(2000 - i), text: '', handle: 'x', links: [], media: [] }));
  assert.equal(savedInfo(fake, NOW).valid, false);
  // dates décodées sans rapport avec la publication (certaines AVANT la publication) : refusé
  const incoherent = good.map((t, i) => ({ ...t, sortIndex: makeSnowflake(at((i * 7919) % 300)) }));
  assert.equal(savedInfo(incoherent, NOW).valid, false);
  // sortIndex = identifiant du tweet lui-même (date décodée == date de publication) : ce n'est pas l'instant du bookmark
  const own = good.map((t) => ({ ...t, sortIndex: makeSnowflake(Date.parse(t.createdAt)) }));
  const ownInfo = savedInfo(own, NOW);
  assert.equal(ownInfo.valid, false);
  assert.ok(ownInfo.same > 0.9);
});

test('stats : totaux, séries, séries d’activité, jour/heure', () => {
  const tweets = [];
  // 10 jours consécutifs (hier compris), n = jour+1 bookmarks, à 21 h ; puis 3 le jour 20, à 9 h
  for (let d = 1; d <= 10; d++) for (let i = 0; i < d; i++) tweets.push(mk(d, { hour: 21 }));
  for (let i = 0; i < 3; i++) tweets.push(mk(20, { hour: 9, handle: 'b', name: 'B' }));
  const st = computeStats(tweets, { now: NOW });
  assert.equal(st.basis, 'saved');
  assert.equal(st.kpi.total, 58);
  assert.equal(st.kpi.authors, 2);
  assert.equal(st.kpi.best.n, 10);
  assert.equal(st.kpi.best.day, dayKey(at(10)));
  assert.equal(st.kpi.streakLongest, 10);
  assert.equal(st.kpi.streakCurrent, 10); // aujourd'hui vide mais hier plein : la série n'est pas rompue
  assert.equal(st.kpi.last7, 1 + 2 + 3 + 4 + 5 + 6); // 6 jours pleins (hier .. il y a 6 j) + aujourd'hui vide
  assert.equal(st.hour.length, 24);
  assert.equal(st.hour[21], 55);
  assert.equal(st.hour[9], 3);
  assert.equal(st.weekday.reduce((a, b) => a + b, 0), 58);
  assert.equal(st.series.gran, 'day');
  assert.equal(st.series.points.reduce((s, p) => s + p.n, 0), 58);
  assert.ok(st.series.points.every((p) => typeof p.ma === 'number'));
  assert.equal(st.cumulative.at(-1).n, 58);
  assert.ok(st.heat.length >= 365 && st.heat.length <= 371);
  assert.equal(new Date(st.heat[0].k + 'T12:00:00').getDay(), 1); // le calendrier commence un lundi
  assert.equal(st.heat.reduce((s, c) => s + c.n, 0), 58);
});

test('stats : filtre de période (7 jours) et granularité', () => {
  const tweets = [];
  for (let d = 0; d < 400; d++) tweets.push(mk(d));
  const all = computeStats(tweets, { now: NOW });
  assert.equal(all.series.gran, 'week'); // 400 jours > 120
  const r7 = computeStats(tweets, { now: NOW, rangeDays: 7 });
  assert.equal(r7.kpi.total, 7);
  assert.equal(r7.series.gran, 'day');
  assert.equal(r7.series.points.length, 7);
  assert.equal(r7.cumulative.at(-1).n, 400); // le cumulé reste celui de toute la collection
  assert.equal(computeStats(tweets, { now: NOW, rangeDays: 30 }).kpi.total, 30);
  const many = [];
  for (let d = 0; d < 1000; d++) many.push(mk(d));
  assert.equal(computeStats(many, { now: NOW }).series.gran, 'month');
});

test('stats : types exclusifs, langues, domaines, hashtags, mots, auteurs, likes, doublons', () => {
  const t = [
    mk(1, { media: [{ type: 'video' }], links: ['https://blog.example.com/a'], stats: { likes: 12000 } }),
    mk(1, { media: [{ type: 'photo' }], stats: { likes: 50 } }),
    mk(1, { links: ['https://www.blog.example.com/a', 'https://x.com/u/status/1'], text: 'Super article sur #IA et #IA @sama @sama', stats: { likes: 5 } }),
    mk(1, { links: ['https://github.com/a/b'], quoted: { handle: 'z', text: 'q' }, lang: 'en' }),
    mk(1, { quoted: { handle: 'z', text: 'q' } }),
    mk(1, { text: 'agents mémoire agents mémoire longue', handle: 'b', name: 'B' }),
  ];
  assert.deepEqual(t.map(typeOf), ['video', 'photo', 'link', 'link', 'quote', 'text']);
  const st = computeStats(t, { now: NOW });
  assert.deepEqual(st.types.map((x) => x.n), [1, 1, 2, 1, 1]); // exclusifs : somme = 6
  assert.equal(st.types.reduce((s, x) => s + x.n, 0), 6);
  assert.deepEqual(st.langs[0], ['fr', 5]);
  assert.deepEqual(st.domains.find(([d]) => d === 'blog.example.com'), ['blog.example.com', 2]); // www ignoré, x.com exclu
  assert.equal(st.domains.some(([d]) => d === 'x.com'), false);
  assert.deepEqual(st.hashtags[0], ['#ia', 1]); // compté une fois par tweet
  assert.deepEqual(st.mentions[0], ['@sama', 1]);
  assert.ok(st.words.some(([w]) => w === 'agents'));
  assert.equal(st.words.find(([w]) => w === 'agents')[1], 1); // un mot compte une fois par tweet
  assert.ok(st.words.some(([w]) => w === 'mémoire'), 'accents conservés à l’affichage');
  assert.equal(st.words.some(([w]) => w === 'avec' || w === 'dans'), false); // mots courants exclus
  assert.equal(st.authors[0].handle, 'a');
  assert.equal(st.topLiked[0].likes, 12000);
  assert.equal(st.likesHist[0].n + st.likesHist[1].n + st.likesHist[2].n + st.likesHist[3].n + st.likesHist[4].n + st.likesHist[5].n, 6);
  assert.equal(st.likesHist[4].n, 1); // 12 000 likes
  assert.deepEqual(st.dupLinks, [['https://blog.example.com/a', 2]]); // http(s), www et / final ne distinguent pas deux liens
  assert.equal(st.kpi.medianLikes, 2.5); // [0,0,0,5,50,12000] -> (0+5)/2
});

test('stats : sans dates d’enregistrement fiables -> repli sur la date de publication, pas de stats horaires', () => {
  const t = Array.from({ length: 30 }, (_, i) => ({ id: 'p' + i, text: 'x', handle: 'a', links: [], media: [], stats: {}, sortIndex: String(900 - i), createdAt: new Date(at(i)).toISOString() }));
  const st = computeStats(t, { now: NOW });
  assert.equal(st.basis, 'published');
  assert.equal(st.savedValid, false);
  assert.equal(st.hour, null);
  assert.equal(st.weekday, null);
  assert.equal(st.ageAtSave, null);
  assert.equal(st.heat.length, 0);
  assert.equal(st.series.points.reduce((s, p) => s + p.n, 0), 30);
});

test('stats : âge au moment de l’enregistrement', () => {
  const D = 86_400_000;
  const t = [mk(1, { pubBefore: 3_600_000 }), mk(1, { pubBefore: 3 * D }), mk(1, { pubBefore: 10 * D }), mk(1, { pubBefore: 100 * D }), mk(1, { pubBefore: 800 * D }), mk(2), mk(3), mk(4)];
  for (let i = 0; i < 15; i++) t.push(mk(5 + (i % 5), { pubBefore: 3 * D })); // (≥ 20 tweets pour que les dates soient jugées fiables)
  const st = computeStats(t, { now: NOW });
  assert.deepEqual(st.ageAtSave.map((a) => a.n), [1, 4 + 15, 1, 1, 1]); // 3 mk() par défaut (2 jours) + 15 à 3 jours : « < 1 semaine »
});

test('recherche : opérateur saved: (jour ou intervalle, date de mise en bookmark)', () => {
  const a = mk(3), b = mk(30);
  const day = dayKey(snowflakeMs(a.sortIndex));
  const { filters } = parseQuery(`saved:${day} agents`);
  assert.deepEqual(filters.saved, { from: day, to: day });
  assert.equal(passesFilters(a, filters), true);
  assert.equal(passesFilters(b, filters), false);
  const range = parseQuery(`saved:${dayKey(at(40))}..${dayKey(at(20))}`).filters;
  assert.equal(passesFilters(b, range), true);
  assert.equal(passesFilters(a, range), false);
  assert.equal(passesFilters({ id: 'z', sortIndex: '12', text: '', handle: 'h', links: [], media: [] }, filters), false); // pas de date fiable
});
