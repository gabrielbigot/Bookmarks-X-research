import test from 'node:test';
import assert from 'node:assert/strict';
import { compileQuery, matchItem, eventDays, evalWidget, detectorScores, detectorSet, detectorMargin, slugOf } from '../src/lib/widgets.js';
import { makeSnowflake, savedInfo } from '../src/lib/time.js';
import { toItem } from '../src/lib/youtube.js';
import { parseQuery, passesFilters } from '../src/lib/search.js';

const NOW = new Date(2026, 9, 14, 15).getTime();
const DAY = 86_400_000;
const tw = (id, text, daysAgo, extra = {}) => ({ id, name: 'N' + id, handle: extra.handle || 'h' + id, text, lang: extra.lang || 'en', createdAt: new Date(NOW - (daysAgo + 2) * DAY).toISOString(), sortIndex: makeSnowflake(NOW - daysAgo * DAY), links: extra.links || [], media: [], stats: { likes: 0 } });
const items = [
  tw('1', 'Today, we launch our new product', 0), tw('2', 'We are launching a startup next week', 1), tw('3', 'Recette de crêpes', 1),
  tw('4', 'Launch day! Lancement de notre boîte', 5, { handle: 'ana', links: ['https://www.blog.io/p'] }), tw('5', 'Old launch story', 40, { handle: 'ana' }),
];
// la fiabilité des dates d'enregistrement exige un minimum de tweets (20)
for (let i = 0; i < 25; i++) items.push(tw('f' + i, 'remplissage ' + i, 80 + i));
const sv = savedInfo(items, NOW);

test('requêtes : mots (début de mot, sans accents), opérateurs, source', () => {
  const m = (q, t) => matchItem(t, compileQuery(q));
  assert.equal(m('launch', items[0]), true);
  assert.equal(m('launching', items[1]), true);
  assert.equal(m('launch', items[2]), false);
  assert.equal(m('lancement boite', items[3]), true, 'sans accents, tous les mots');
  assert.equal(m('launch product', items[1]), false, 'tous les mots requis');
  assert.equal(m('launch from:@ana', items[3]), true);
  assert.equal(m('launch from:@ana', items[0]), false);
  assert.equal(m('', items[2]), true, 'requête vide : tout');
  const yt = toItem({ videoId: 'v', title: 'Product launch keynote' }, null);
  assert.equal(matchItem(yt, compileQuery('launch', 'x')), false);
  assert.equal(matchItem(yt, compileQuery('launch', 'youtube')), true);
});

test('jours d’un élément : tweet (enregistrement), vidéo vue, vidéo sans visionnage', () => {
  assert.equal(sv.valid, true);
  assert.equal(eventDays(items[1], sv).length, 1);
  assert.deepEqual(eventDays({ ...toItem({ videoId: 'v', title: 't' }, null), watched: ['2026-10-01', '2026-10-03'] }, sv), ['2026-10-01', '2026-10-03']);
  assert.equal(eventDays({ ...toItem({ videoId: 'v', title: 't' }, null), addedAt: NOW }, sv).length, 1);
});

test('évaluation : nombre, période précédente, série, classement', () => {
  const w = { kind: 'number', q: 'launch' };
  const r7 = evalWidget(items, w, { sv, now: NOW, rangeDays: 7 });
  assert.equal(r7.n, 3, 'items 1, 2 et 4 dans les 7 derniers jours');
  assert.equal(r7.prev, 0);
  const r1 = evalWidget(items, w, { sv, now: NOW, rangeDays: 1 });
  assert.equal(r1.n, 1);
  const r30 = evalWidget(items, w, { sv, now: NOW, rangeDays: 30 });
  assert.equal(r30.n, 3);
  assert.equal(r30.prev, 1, 'le tweet de il y a 40 jours tombe dans la période précédente (30-60 j)');
  assert.equal(evalWidget(items, w, { sv, now: NOW, rangeDays: null }).n, 4);
  const s = evalWidget(items, { kind: 'series', q: 'launch' }, { sv, now: NOW, rangeDays: 7 }).series;
  assert.equal(s.gran, 'day');
  assert.equal(s.points.length, 7);
  assert.equal(s.points.reduce((a, p) => a + p.n, 0), 3);
  const t = evalWidget(items, { kind: 'top', q: 'launch', by: 'author' }, { sv, now: NOW, rangeDays: null }).top;
  assert.equal(t[0].key, 'ana');
  assert.equal(t[0].n, 2);
  const sites = evalWidget(items, { kind: 'top', q: '', by: 'site' }, { sv, now: NOW, rangeDays: null }).top;
  assert.deepEqual(sites.map((x) => x.label), ['blog.io']);
});

test('détecteur : score = meilleur exemple (ou passage), seuil, ✓/✗, marge', () => {
  const u = (...v) => Float32Array.from(v);
  const vecs = new Map([['a', u(1, 0)], ['b', u(0.8, 0.6)], ['c', u(0, 1)], ['d', u(0.6, 0.8)]]);
  const chunks = new Map([['c', { vecs: Float32Array.from([1, 0]), k: 1 }]]); // un passage de c ressemble à l'exemple
  const protos = [u(1, 0)];
  const sc = detectorScores(vecs, chunks, protos);
  assert.equal(sc.get('a'), 1);
  assert.ok(Math.abs(sc.get('b') - 0.8) < 1e-6);
  assert.equal(sc.get('c'), 1, 'meilleur passage');
  const det = { threshold: 0.7, pos: ['d'], neg: ['a'] };
  assert.deepEqual([...detectorSet(sc, det)].sort(), ['b', 'c', 'd']);
  const m = detectorMargin(sc, { threshold: 0.7, pos: ['d'], neg: ['a'] }, 5);
  assert.deepEqual(m.above.map(([id]) => id), ['b', 'c']);
  assert.deepEqual(m.below.map(([id]) => id), []);
  // détecteur combiné à une requête
  const w = { kind: 'number', q: 'launch', det: 'D' };
  const r = evalWidget(items, w, { sv, now: NOW, rangeDays: null, detSets: new Map([['D', new Set(['1', '3'])]]) });
  assert.equal(r.n, 1, 'dans le détecteur ET contenant « launch »');
  assert.equal(slugOf('Lancements de boîte !'), 'lancements-de-boite');
});

test('opérateur is: et ensemble résolu', () => {
  const f = parseQuery('is:lancement foo').filters;
  assert.equal(f.is, 'lancement');
  assert.equal(passesFilters(items[0], f), true, 'sans ensemble résolu, is: est ignoré');
  assert.equal(passesFilters(items[0], { isIds: new Set(['1']) }), true);
  assert.equal(passesFilters(items[1], { isIds: new Set(['1']) }), false);
});
