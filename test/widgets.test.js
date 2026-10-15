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
  assert.deepEqual(f.is, ['lancement']);
  assert.deepEqual(parseQuery('is:a is:b,c').filters.is, ['a', 'b,c']);
  assert.equal(passesFilters(items[0], f), true, 'sans ensemble résolu, is: est ignoré');
  assert.equal(passesFilters(items[0], { isIds: new Set(['1']) }), true);
  assert.equal(passesFilters(items[1], { isIds: new Set(['1']) }), false);
});

import { ambiguousIds, verdictKey } from '../src/lib/widgets.js';
import { jevJudge } from '../src/lib/jev.js';
test('détecteur confirmé par Jev : marge, verdicts, cas ambigus', () => {
  const sc = new Map([['hi', 0.9], ['m1', 0.58], ['m2', 0.52], ['m3', 0.47], ['lo', 0.2], ['m4', 0.43]]);
  const det = { threshold: 0.5, confirm: { on: true, band: 0.1 }, desc: ' Lancement ', pos: [], neg: [] };
  // sans verdict : le seuil seul décide dans la marge
  assert.deepEqual([...detectorSet(sc, det)].sort(), ['hi', 'm1', 'm2']);
  // avec verdicts : Jev tranche
  const v = { m1: 10, m2: 80, m3: 95 };
  assert.deepEqual([...detectorSet(sc, det, v)].sort(), ['hi', 'm2', 'm3']);
  // sans confirmation, les verdicts sont ignorés
  assert.deepEqual([...detectorSet(sc, { ...det, confirm: { on: false } }, v)].sort(), ['hi', 'm1', 'm2']);
  // à juger : dans la marge, sans verdict, les plus incertains (proches du seuil) d'abord
  assert.deepEqual(ambiguousIds(sc, det, v), ['m4']);
  assert.deepEqual(ambiguousIds(sc, det, {}), ['m2', 'm3', 'm4', 'm1']);
  assert.equal(verdictKey(det), 'lancement');
});

test('jevJudge : question « choice », pourcentages, enregistrement par lots, erreur d’accès', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const yes = /oui-/.test(body.state.contenu);
    return { ok: true, json: async () => ({ answers: { match: { choice: yes ? 'oui' : 'non', confidence: 0.9, probabilities: yes ? { oui: 0.9, non: 0.1 } : { oui: 0.2, non: 0.8 } } } }) };
  };
  const batches = [];
  const items = Array.from({ length: 5 }, (_, i) => ({ id: 'i' + i, text: (i % 2 ? 'non-' : 'oui-') + i }));
  const r = await jevJudge({ url: 'https://x/d', model: 'm', apiKey: 'k' }, 'Annonce d’un lancement', items, { concurrency: 2, every: 2, onBatch: async (b) => batches.push(b.size) });
  assert.equal(r.done.get('i0'), 90);
  assert.equal(r.done.get('i1'), 20);
  assert.equal(r.done.size, 5);
  assert.deepEqual(batches.reduce((a, b) => a + b, 0), 5, 'tous les verdicts passent par onBatch');
  assert.equal(calls[0].questions.match.type, 'choice');
  assert.match(calls[0].questions.match.instructions, /Annonce d’un lancement/);
  assert.deepEqual(Object.keys(calls[0].questions.match.criteria), ['oui', 'non']);
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'clé invalide' });
  await assert.rejects(() => jevJudge({ url: 'u', model: 'm', apiKey: 'k' }, 'd', items), /HTTP 401/);
});

import { splitOr, detsOf } from '../src/lib/widgets.js';
test('requêtes : « a | b » (OU) et plusieurs détecteurs (ET / OU)', () => {
  assert.deepEqual(splitOr('robot | humanoid | cobot'), { plain: '', groups: [['robot', 'humanoid', 'cobot']] });
  assert.deepEqual(splitOr('launch robot|humanoid from:@ana'), { plain: 'launch from:@ana', groups: [['robot', 'humanoid']] });
  assert.deepEqual(splitOr('from:@a | from:@b'), { plain: 'from:@a from:@b', groups: [] }, 'les opérateurs ne se combinent pas par OU');
  assert.deepEqual(splitOr('a |'), { plain: 'a', groups: [] });
  const m = (q, t) => matchItem(t, compileQuery(q));
  const rb = tw('r1', 'Our humanoid robot is launching today', 0), cb = tw('r2', 'New cobot arm available', 0), other = tw('r3', 'New recipe for crêpes', 0);
  assert.equal(m('robot | cobot', rb), true);
  assert.equal(m('robot | cobot', cb), true);
  assert.equal(m('robot | cobot', other), false);
  assert.equal(m('launching robot | cobot', rb), true, 'launching ET (robot OU cobot)');
  assert.equal(m('launching robot | cobot', cb), false);
  // plusieurs détecteurs
  const all = [...items, rb, cb, other];
  const ctx = (mode) => ({ sv, now: NOW, rangeDays: null, detSets: new Map([['L', new Set(['r1', 'r2', 'r3'])], ['R', new Set(['r1', 'r2'])]]) });
  assert.equal(evalWidget(all, { kind: 'number', q: '', dets: ['L', 'R'], detMode: 'and' }, ctx()).n, 2, 'Lancements ET Robotique');
  assert.equal(evalWidget(all, { kind: 'number', q: '', dets: ['L', 'R'], detMode: 'or' }, ctx()).n, 3, 'Lancements OU Robotique');
  assert.equal(evalWidget(all, { kind: 'number', q: 'cobot', dets: ['L', 'R'], detMode: 'and' }, ctx()).n, 1, 'avec une requête en plus');
  assert.deepEqual(detsOf({ det: 'X' }), ['X'], 'ancien format (un seul détecteur)');
  assert.equal(evalWidget(all, { kind: 'number', q: '', det: 'R' }, ctx()).n, 2, 'ancien format toujours compté');
});

import { scoreStats, suggestThreshold } from '../src/lib/widgets.js';
test('seuil suggéré : ~2 % des éléments, au moins 20, jamais au-dessus du meilleur score', () => {
  const sc = new Map(Array.from({ length: 1000 }, (_, i) => ['i' + i, i / 1000 * 0.5])); // scores de 0 à 0,5
  const st = scoreStats(sc);
  assert.ok(st.max > 0.49 && st.max <= 0.5);
  assert.ok(Math.abs(st.median - 0.25) < 0.01);
  const sg = suggestThreshold(sc);
  assert.ok(sg.threshold <= st.max && sg.threshold > 0.4, 'suggestion : ' + sg.threshold);
  assert.ok(sg.count >= 20 && sg.count <= 40, 'compte : ' + sg.count);
  // avec un seuil de 0,55 (trop haut), le détecteur ne retient rien : c'est ce que la suggestion corrige
  assert.equal(detectorSet(sc, { threshold: 0.55 }).size, 0);
  assert.ok(detectorSet(sc, { threshold: sg.threshold }).size >= 20);
  assert.equal(suggestThreshold(new Map()), null);
  assert.equal(suggestThreshold(new Map([['a', 0.3], ['b', 0.1]])).count, 2, 'petite collection : au plus tous les éléments');
});

test('opérateur during: (période d’une stat)', () => {
  assert.deepEqual(parseQuery('is:a during:2026-10-01..2026-10-14 foo').filters.during, { from: '2026-10-01', to: '2026-10-14' });
  assert.deepEqual(parseQuery('during:2026-10-05').filters.during, { from: '2026-10-05', to: '2026-10-05' });
  assert.equal(parseQuery('during:hier').filters.during, undefined);
  // les jours d'un élément servent aussi pour la recherche : même définition que la stat
  const d = eventDays(items[0], sv)[0];
  assert.ok(d >= '2026-10-14' && d <= '2026-10-14');
});
