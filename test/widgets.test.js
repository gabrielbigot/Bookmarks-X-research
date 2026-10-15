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

import { estimateJudgeCost, fmtDollars } from '../src/lib/jev.js';
test('estimation du coût Jev : tokens d’entrée × prix (sortie gratuite)', () => {
  const texts = Array.from({ length: 1000 }, () => 'x'.repeat(300));
  const e = estimateJudgeCost('Annonce d’un lancement', texts);
  assert.equal(e.calls, 1000);
  assert.ok(e.tokens > 150_000 && e.tokens < 250_000, 'tokens : ' + e.tokens);
  assert.ok(e.dollars > 0.005 && e.dollars < 0.02, 'dollars : ' + e.dollars); // ~0,01 $ pour 1 000 appels à 0,042 $/M
  assert.equal(estimateJudgeCost('d', texts, 0.1).dollars > e.dollars, true);
  assert.equal(fmtDollars(0.004), '< 0,01 $');
  assert.equal(fmtDollars(1.234), '1,23 $');
});

test('listes de réglage : reflètent la décision finale (verdicts de Jev compris)', () => {
  const sc = new Map([['a', 0.9], ['m1', 0.52], ['m2', 0.48], ['lo', 0.1]]);
  const det = { threshold: 0.5, confirm: { on: true, band: 0.1 }, pos: [], neg: [] };
  const v = { m1: 5, m2: 95 }; // Jev écarte m1 (score au-dessus du seuil) et retient m2 (en dessous)
  const m = detectorMargin(sc, det, 8, v);
  assert.deepEqual(m.above.map(([id]) => id), ['m2', 'a'], 'retenus : m2 (confirmé par Jev) et a, pas m1');
  assert.deepEqual(m.below.map(([id]) => id), ['m1', 'lo'], 'écartés : m1 (refusé par Jev) puis lo');
});

import { learnedLabels } from '../src/lib/widgets.js';
test('apprentissage : les éléments très semblables à un ✓ ou un ✗ suivent ton choix', () => {
  const u = (...v) => { const n = Math.hypot(...v); return Float32Array.from(v.map((x) => x / n)); };
  const vecs = new Map([['yes', u(1, 0, 0)], ['near-yes', u(1, 0.1, 0)], ['no', u(0, 1, 0)], ['near-no', u(0.1, 1, 0)], ['far', u(0, 0, 1)], ['mid', u(1, 1, 0)]]);
  const l = learnedLabels(vecs, ['yes'], ['no'], 0.9);
  assert.equal(l.get('near-yes'), 1);
  assert.equal(l.get('near-no'), -1);
  assert.equal(l.has('far'), false, 'trop différent : aucune étiquette');
  assert.equal(l.has('mid'), false, 'à mi-chemin (0,71) : sous le seuil de ressemblance');
  assert.equal(l.has('yes'), false, 'les éléments étiquetés à la main ne sont pas dans la propagation');
  assert.equal(learnedLabels(vecs, [], [], 0.9).size, 0);
  // effet sur le détecteur
  const sc = new Map([['near-yes', 0.1], ['near-no', 0.9], ['far', 0.3]]);
  const det = { threshold: 0.5, pos: ['yes'], neg: ['no'], learn: { on: true } };
  assert.deepEqual([...detectorSet(sc, det, {}, l)].sort(), ['near-yes', 'yes'], 'near-no écarté malgré son score, near-yes retenu malgré le sien');
  assert.deepEqual([...detectorSet(sc, { ...det, learn: { on: false } }, {}, l)].sort(), ['near-no', 'yes'], 'désactivé : seul le seuil décide');
  // les choix explicites l'emportent
  assert.equal(detectorSet(sc, { ...det, neg: ['no', 'near-yes'] }, {}, l).has('near-yes'), false);
});

import { cleanText } from '../src/lib/jev.js';
test('Jev : texte nettoyé (surrogats isolés), contenu refusé ignoré sans arrêter le lot, accès refusé = arrêt', async () => {
  // une coupe au milieu d'un emoji laisserait un surrogat isolé : l'API refuse ("invalid Unicode text")
  const cut = ('a'.repeat(899) + '😀').slice(0, 900);
  assert.match(cut, /[\ud800-\udbff]$/);
  const clean = cleanText(cut, 900);
  assert.doesNotMatch(clean, /[\ud800-\udfff]/);
  assert.equal(cleanText('ok 😀 fin\u0000x\u0007', 900), 'ok 😀 fin x ');
  assert.equal(cleanText(undefined), '');
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.state.contenu);
    if (body.state.contenu.includes('REFUSE')) return { ok: false, status: 400, text: async () => '{"error":"invalid Unicode text"}' };
    return { ok: true, json: async () => ({ answers: { match: { choice: 'oui', confidence: 0.9, probabilities: { oui: 0.9, non: 0.1 } } } }) };
  };
  const items = [{ id: 'a', text: 'bon' }, { id: 'b', text: 'REFUSE ' + cut }, { id: 'c', text: 'bon aussi' }];
  const got = [];
  const r = await jevJudge({ url: 'u', model: 'm', apiKey: 'k' }, 'desc', items, { concurrency: 1, every: 1, onBatch: async (b) => got.push(...b) });
  assert.equal(r.done.get('a'), 90);
  assert.equal(r.done.get('b'), -1, 'texte refusé : verdict -1, jamais redemandé');
  assert.equal(r.done.get('c'), 90, 'le lot continue après un texte refusé');
  assert.equal(r.skipped, 1);
  assert.equal(r.error, '');
  assert.ok(seen.every((t) => !/[\ud800-\udfff]/.test(t.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''))), 'aucun surrogat isolé envoyé');
  // -1 : le seuil décide (comme sans verdict) ; et ce n'est plus un « cas à juger »
  const sc = new Map([['x', 0.52], ['y', 0.47]]);
  const det = { threshold: 0.5, confirm: { on: true, band: 0.1 } };
  assert.deepEqual([...detectorSet(sc, det, { x: -1, y: -1 })], ['x']);
  assert.deepEqual(ambiguousIds(sc, det, { x: -1, y: -1 }), []);
  // accès refusé : arrêt
  globalThis.fetch = async () => ({ ok: false, status: 402, text: async () => 'crédit insuffisant' });
  await assert.rejects(() => jevJudge({ url: 'u', model: 'm', apiKey: 'k' }, 'd', items, { concurrency: 1 }), /HTTP 402/);
});

import { clusterCandidates, linkKeys } from '../src/lib/widgets.js';
test('regroupement : même tweet cité, même page, sens quasi identique dans la fenêtre ; sujet daté de son premier enregistrement', () => {
  const day = (n) => new Date(NOW - n * DAY).toISOString().slice(0, 10);
  const mk = (id, daysAgo, extra = {}) => ({ t: { ...tw(id, 'x' + id, daysAgo), ...extra }, days: [day(daysAgo)] });
  const u = (...v) => { const n = Math.hypot(...v); return Float32Array.from(v.map((x) => x / n)); };
  const cand = [
    mk('a', 10), mk('b', 9, { quoted: { id: 'a', links: [] } }),            // b cite a (présent dans la liste)
    mk('c', 8, { quoted: { id: 'Z' } }), mk('d', 7, { quoted: { id: 'Z' } }), // c et d citent le même tweet absent
    mk('e', 6, { links: ['https://www.blog.io/launch?utm=1'] }), mk('f', 5, { links: ['https://blog.io/launch/'] }), // même page
    mk('g', 4, { links: ['https://blog.io/'] }), mk('h', 3, { links: ['https://blog.io/'] }), // simple page d'accueil : pas un signal
    mk('i', 2), mk('j', 1),                                                   // sens quasi identique, proches dans le temps
    mk('k', 30), mk('l', 1),                                                  // même sens mais 29 jours d'écart : séparés
  ];
  // un vecteur « canonique » par tweet (12 dimensions, une par tweet) : par défaut tous différents
  const oh = (n, extra = {}) => { const v = new Float32Array(12); v[n] = 1; for (const [k, x] of Object.entries(extra)) v[k] = x; const nn = Math.hypot(...v); return v.map((x) => x / nn); };
  const vecs = new Map(cand.map(({ t }, n) => [t.id, oh(n)]));
  vecs.set('j', oh(8, { 9: 0.05 }));          // i (indice 8) et j (indice 9) : sens quasi identique
  vecs.set('j', oh(8, { 9: 0.1 }));
  vecs.set('l', oh(10));                      // k (indice 10) et l : identiques mais 29 jours d'écart
  const names = (g) => g.map((idx) => idx.map((i) => cand[i].t.id).join('')).sort();
  const r = clusterCandidates(cand, { sim: 0.95, days: 7, vecs });
  assert.deepEqual(names(r.groups).filter((x) => x.length > 1), ['ab', 'cd', 'ef', 'ij'], names(r.groups).join(','));
  assert.equal(names(r.groups).includes('g') && names(r.groups).includes('h'), true, 'deux pages d’accueil ne regroupent pas');
  assert.equal(names(r.groups).includes('k') && names(r.groups).includes('l'), true, 'même sens mais 29 jours d’écart : deux sujets');
  assert.deepEqual([...linkKeys({ links: ['https://x.com/a/status/1', 'https://t.co/zz', 'https://www.Blog.io/p/?a=1'], quoted: { links: ['https://news.org/story'] } })].sort(), ['blog.io/p', 'news.org/story']);
  // sans vecteurs : seulement les signaux de citation et de lien
  assert.deepEqual(names(clusterCandidates(cand, { vecs: null }).groups).filter((x) => x.length > 1), ['ab', 'cd', 'ef']);

  // décompte : un sujet = une unité, daté de son premier enregistrement
  const base = items.filter((t) => t.id.startsWith('f'));
  const all = [...base, ...cand.map((c) => c.t)];
  const sv2 = savedInfo(all, NOW);
  const w = { kind: 'number', q: '' };
  const plain = evalWidget(cand.map((c) => c.t), w, { sv: null, now: NOW, rangeDays: null });
  assert.equal(plain.n, 12);
  // sv null : la date vient de createdAt → on force des dates simples en passant par des vidéos ? ici on teste via eventDays réel
  const g = evalWidget(cand.map((c) => c.t), { ...w, dedupe: { on: true, sim: 0.95, days: 7 } }, { sv: null, now: NOW, rangeDays: null, vecs });
  assert.equal(g.n, 8, '12 tweets → 8 sujets : ' + g.matched.map((m) => m.members.map((x) => x.id).join('')).join(','));
  assert.equal(g.tweets, 12);
  assert.equal(g.grouped, true);
  assert.ok(g.matched.some((m) => m.members.length === 2));
  // ignorer les citations
  const nq = evalWidget(cand.map((c) => c.t), { ...w, noQuotes: true }, { sv: null, now: NOW, rangeDays: null });
  assert.equal(nq.n, 9, 'b, c et d citent un autre tweet : écartés (12 − 3)');
  // opérateur de recherche équivalent
  assert.equal(passesFilters(cand[1].t, parseQuery('quoted:no').filters), false);
  assert.equal(passesFilters(cand[0].t, parseQuery('quoted:no').filters), true);
  assert.equal(passesFilters(cand[1].t, parseQuery('cite:oui').filters), true);
});

import { rankMembers, mentions, suggestPrimary } from '../src/lib/widgets.js';
test('source primaire : commentaire qui nomme l’auteur relié à l’annonce, l’annonce passe en tête', () => {
  const day = (n) => new Date(NOW - n * DAY).toISOString().slice(0, 10);
  const o = (v) => { const n = Math.hypot(...v); return Float32Array.from(v.map((x) => x / n)); };
  const official = { ...tw('o', 'we announced Jev 1.14 today', 1, { handle: 'typesafeai' }), stats: { likes: 100 } };
  const comment = { ...tw('c', 'the @typesafeai team dropped a banger with jev image support', 1, { handle: 'dotpem' }), stats: { likes: 900 } };
  const other = { ...tw('x', 'the @typesafeai cat is cute', 1, { handle: 'zed' }) };
  const vecs = new Map([['o', o([1, 0.45, 0])], ['c', o([1, 0, 0])], ['x', o([0, 0, 1])]]); // o~c ≈ 0.91 : sous 0.92, au-dessus de 0.80
  const cand = [official, comment, other].map((t) => ({ t, days: [day(1)] }));
  const g = clusterCandidates(cand, { sim: 0.95, days: 7, vecs }).groups.map((x) => x.map((i) => cand[i].t.id).join('')).sort();
  assert.deepEqual(g, ['oc', 'x'], 'le commentaire qui nomme l’auteur rejoint le groupe ; le hors-sujet reste seul');
  assert.equal(clusterCandidates(cand, { sim: 0.95, days: 7, vecs, mentionSim: null }).groups.length, 3);
  assert.ok(mentions(comment, '@TypeSafeAI') && !mentions(comment, 'type'));
  // l'annonce passe avant le commentaire plus liké parce que l'autre la nomme ; une source déclarée ou jugée officielle prime
  assert.equal(rankMembers([comment, official])[0].id, 'o');
  assert.equal(rankMembers([comment, official], { primary: new Set(['dotpem']) })[0].id, 'c');
  assert.equal(rankMembers([comment, official], { official: { c: 80, o: 10 } })[0].id, 'c');
  const r = evalWidget([official, comment, other], { kind: 'number', q: '', dedupe: { on: true, sim: 0.95, days: 7 } }, { sv: null, now: NOW, rangeDays: null, vecs });
  assert.equal(r.n, 2);
  assert.equal(r.matched.find((m) => m.members.length > 1).t.id, 'o', 'le sujet est représenté par la source primaire');
  assert.equal(evalWidget([official, comment, other], { kind: 'number', q: '', primaryOnly: true }, { sv: null, now: NOW, rangeDays: null, primary: new Set(['typesafeai']) }).n, 1);
  assert.equal(evalWidget([official, comment, other], { kind: 'number', q: '', officialOnly: true }, { sv: null, now: NOW, rangeDays: null, official: { o: 90, c: 5 } }).n, 1);
  assert.deepEqual(suggestPrimary([official, comment, other]).map((x) => x.handle), ['typesafeai']);
  assert.equal(parseQuery('primary:oui official:non').filters.primary, true);
  assert.equal(parseQuery('official:non').filters.official, false);
  assert.equal(passesFilters(official, { primary: true, primarySet: new Set(['typesafeai']) }), true);
  assert.equal(passesFilters(comment, { primary: true, primarySet: new Set(['typesafeai']) }), false);
});

import { evalMulti, seriesDefs, groupKeys } from '../src/lib/widgets.js';
test('comparaison de séries, découpage, période précédente, chaleur, tendances', () => {
  const mk = (id, text, daysAgo, extra = {}) => ({ ...tw(id, text, daysAgo, extra), createdAt: new Date(NOW - daysAgo * DAY).toISOString() });
  const xs = [mk('a', 'robot launch humanoid', 1), mk('b', 'robot launch arm', 2), mk('c', 'cooking pasta', 3, { lang: 'fr' }), mk('d', 'robot humanoid update', 12), mk('e', 'robot humanoid demo', 13)];
  const sv = savedInfo(xs, NOW);
  const ctx = { sv, now: NOW, rangeDays: 7 };
  // deux séries alignées (robot vs tout)
  const w = { kind: 'series', q: 'robot', slabel: 'Robot', more: [{ label: 'Tout', q: '' }], prev: true };
  assert.equal(seriesDefs(w).length, 2);
  const m = evalMulti(xs, w, ctx);
  assert.equal(m.keys.length, 7);
  assert.deepEqual(m.series.map((s) => s.label), ['Robot', 'Tout']);
  assert.deepEqual(m.series.map((s) => s.n), [2, 3]);
  assert.equal(m.series[0].vals.reduce((a, b) => a + b, 0), 2);
  assert.equal(m.series[0].prevVals.length, 7);
  assert.equal(m.series[0].prevVals.reduce((a, b) => a + b, 0), 2, 'la période précédente (d, e) est ramenée sur la période courante');
  assert.equal(m.series[0].prev, 2);
  // découpage par langue : en (a, b, d, e) et fr (c)
  const sp = evalMulti(xs, { kind: 'series', q: '', split: 'lang' }, ctx);
  assert.deepEqual(sp.series.map((s) => s.label).sort(), ['en', 'fr']);
  assert.equal(sp.series.find((s) => s.label === 'en').n, 2);
  // chaleur + tendances
  const h = evalWidget(xs, { kind: 'heat', q: '' }, ctx);
  assert.equal(h.heat.n, 3);
  const tr = evalWidget(xs, { kind: 'trend', by: 'word', q: '' }, { ...ctx, rangeDays: 7 });
  assert.ok(tr.trendOk);
  assert.ok(tr.trend.some((x) => x.key === 'launch' && x.n === 2 && x.prev === 0), JSON.stringify(tr.trend));
  assert.ok(!tr.trend.some((x) => x.key === 'robot' && x.d > 0), 'robot : 2 puis 2, ne monte pas');
  assert.equal(evalWidget(xs, { kind: 'trend', by: 'word', q: '' }, { ...ctx, rangeDays: null }).trendOk, false);
  assert.deepEqual(groupKeys('word', xs[0]).sort(), ['humanoid', 'launch', 'robot']);
});

test('comparaison de stats existantes : refDefs fournit les séries', () => {
  const mk = (id, text, daysAgo) => ({ ...tw(id, text, daysAgo), createdAt: new Date(NOW - daysAgo * DAY).toISOString() });
  const xs = [mk('a', 'robot arm', 1), mk('b', 'robot leg', 2), mk('c', 'llm model', 2)];
  const refDefs = [{ def: { kind: 'number', q: 'robot' }, label: 'Robots' }, { def: { kind: 'number', q: 'llm' }, label: 'IA' }];
  const m = evalMulti(xs, { kind: 'compare', refDefs }, { sv: savedInfo(xs, NOW), now: NOW, rangeDays: 7 });
  assert.deepEqual(m.series.map((s) => [s.label, s.n]), [['Robots', 2], ['IA', 1]]);
  assert.equal(m.keys.length, 7);
});

import { runAutoJev } from '../src/lib/autojev.js';
import { modelOf } from '../src/lib/models.js';
test('Jev automatique : mêmes réglages que les détecteurs et les stats, plafond quotidien, jamais deux fois', async () => {
  const mid = modelOf('default').id;
  const settings = { embedModel: 'default', aiHistory: false, autoJev: { on: true, dailyCap: 1 }, decision: { url: 'u', model: 'm', apiKey: 'k', priceInPerM: 0.042 } };
  const det = { id: 'd1', name: 'D', desc: 'annonce de lancement', threshold: 0.5, confirm: { on: true, band: 0.2 }, protos: { [mid]: [[1, 0, 0]] }, examples: ['x'] };
  const unused = { id: 'd2', name: 'U', desc: 'autre', threshold: 0.5, confirm: { on: true, band: 0.2 }, protos: { [mid]: [[1, 0, 0]] } };
  const meta = new Map([['dashWidgets', [{ id: 'w', kind: 'number', dets: ['d1'] }, { id: 'w2', kind: 'number', q: '', source: 'x', officialOnly: true }]], ['dashDetectors', [det, unused]]]);
  const T = (id, s) => ({ id, name: 'N' + id, handle: 'h' + id, text: 'tweet ' + id, createdAt: '2026-10-1' + id, links: [], media: [], stats: {} });
  const tweets = [T('1'), T('2'), T('3')];
  const vecs = new Map([['1', Float32Array.from([0.55, 0, 0])], ['2', Float32Array.from([0.95, 0, 0])], ['3', Float32Array.from([0.1, 0, 0])]]);
  const io = { getMeta: async (k) => meta.get(k), setMeta: async (k, v) => { meta.set(k, v); }, getAllVectors: async () => vecs, getAllChunkVecs: async () => new Map(), getTweets: async (ids) => tweets.filter((t) => ids.includes(t.id)), eachTweet: async (fn) => tweets.forEach(fn) };
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ answers: { match: { choice: 'oui', confidence: 0.9, probabilities: { oui: 0.9, non: 0.1 } } } }) }; };
  const now = Date.parse('2026-10-14T12:00:00Z');
  const r = await runAutoJev(settings, { io, now });
  assert.equal(r.detectors, 1, 'seul le cas ambigu (0,55) du détecteur utilisé et confirmé est jugé');
  assert.equal(r.official, 3, 'la stat « annonces officielles » fait juger ses 3 tweets');
  assert.equal(calls, 4);
  assert.equal(meta.get('detVerdicts').d1.v['1'], 90);
  assert.equal(Object.keys(meta.get('officialVerdicts').m).length, 3);
  assert.equal(meta.get('jevSpend').count, 4);
  const r2 = await runAutoJev(settings, { io, now });
  assert.equal(r2.judged, 0, 'rien n’est rejugé');
  assert.equal(calls, 4);
  // désactivé / plafond
  assert.equal((await runAutoJev({ ...settings, autoJev: { on: false, dailyCap: 1 } }, { io, now })).skipped, 'off');
  meta.delete('officialVerdicts'); meta.delete('detVerdicts'); meta.delete('jevSpend');
  const r3 = await runAutoJev({ ...settings, autoJev: { on: true, dailyCap: 0.0001 } }, { io, now });
  assert.equal(r3.judged, 0);
  assert.ok(r3.capReached, 'le plafond du jour bloque les dépenses');
  assert.equal(calls, 4);
});

import { condKey, condOf } from '../src/lib/widgets.js';
test('condition libre posée à Jev : filtre la stat, jugée automatiquement, rangée par clé', async () => {
  const xs = [tw('1', 'we raised 5M', 1), tw('2', 'nice weather', 1)];
  const w = { kind: 'number', q: '', jevDesc: ' Le tweet annonce une levée de fonds ' };
  assert.equal(condOf(w), 'Le tweet annonce une levée de fonds');
  const ctx = { sv: savedInfo(xs, NOW), now: NOW, rangeDays: null, conds: { [condKey(w.jevDesc)]: { 1: 90, 2: 10 } } };
  assert.equal(evalWidget(xs, w, ctx).n, 1);
  assert.equal(evalWidget(xs, w, { ...ctx, conds: {} }).n, 0, 'sans verdict, rien n’est compté');
  assert.equal(condKey('  LE tweet annonce une levée de fonds'), condKey('le tweet annonce une levée de fonds'));
  // automatique
  const mid = modelOf('default').id;
  const meta = new Map([['dashWidgets', [w]], ['dashDetectors', []]]);
  const io = { getMeta: async (k) => meta.get(k), setMeta: async (k, v) => { meta.set(k, v); }, getAllVectors: async () => new Map(), getAllChunkVecs: async () => new Map(), getTweets: async () => [], eachTweet: async (fn) => xs.forEach(fn) };
  const asked = [];
  globalThis.fetch = async (url, init) => { asked.push(JSON.parse(init.body).questions.match.instructions); return { ok: true, json: async () => ({ answers: { match: { choice: 'oui', confidence: 0.8, probabilities: { oui: 0.8, non: 0.2 } } } }) }; };
  const settings = { embedModel: 'default', autoJev: { on: true, dailyCap: 1 }, decision: { url: 'u', model: 'm', apiKey: 'k', priceInPerM: 0.042 } };
  const r = await runAutoJev(settings, { io, now: NOW });
  assert.equal(r.official, 2);
  assert.ok(asked.every((q) => q.includes('levée de fonds')), 'la question posée est celle de la stat');
  assert.equal(Object.keys(meta.get('jevConds')[condKey(w.jevDesc)].m).length, 2);
  void mid;
});
