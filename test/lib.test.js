import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, isEncrypted } from '../src/lib/backup.js';
import { kmeans, labelClusters } from '../src/lib/cluster.js';
import { extractMeta, isPublicUrl } from '../src/lib/links.js';
import { score, summarize, matches } from '../src/lib/evalbench.js';
import { parseJsonLoose, renderMd, askMessages } from '../src/lib/llm.js';
import { Index, DIM } from '../src/lib/search.js';

const T = (id, text, extra = {}) => ({ id, text, name: 'N', handle: 'h', links: [], media: [], sortIndex: id, ...extra });

test('backup : JSON clair et aller-retour chiffré', async () => {
  const tweets = [T('1', 'héhé ça marche 😀'), T('2', 'deux')];
  const plain = await encode(tweets);
  assert.equal(isEncrypted(plain), false);
  assert.equal((await decode(plain)).length, 2);
  const enc = await encode(tweets, 'secret');
  assert.equal(isEncrypted(enc), true);
  assert.deepEqual((await decode(enc, 'secret')).map((t) => t.text), ['héhé ça marche 😀', 'deux']);
  await assert.rejects(decode(enc, 'faux'), /incorrect/);
  await assert.rejects(decode(enc), /mot de passe requis/);
  await assert.rejects(decode(new TextEncoder().encode('{"a":1}')), /pas une sauvegarde/);
});

test('index incrémental : add sans reconstruire, setVector, recentRows', () => {
  const idx = new Index();
  idx.add([T('1', 'alpha beta'), T('2', 'gamma')]);
  assert.equal(idx.tweets.length, 2);
  idx.add([T('2', 'dup'), T('3', 'alpha delta', { sortIndex: '9' })]);
  assert.equal(idx.tweets.length, 3);
  assert.deepEqual(idx.bm25('alpha', null).map(([r]) => idx.tweets[r].id).sort(), ['1', '3']);
  const v = new Float32Array(DIM); v[0] = 1;
  assert.equal(idx.setVector('3', v), true);
  assert.equal(idx.vectorCount(), 1);
  assert.deepEqual(idx.vector(v, null).map(([r]) => idx.tweets[r].id), ['3']);
  assert.equal(idx.tweets[idx.recentRows()[0]].id, '3'); // sortIndex le plus grand d'abord
  for (let i = 0; i < 3000; i++) idx.add([T('x' + i, 'bulk ' + i)]); // croissance de la matrice
  assert.equal(idx.vector(v, null)[0][0], idx.rowById.get('3')); // vecteur conservé après _grow
});

test('k-means : retrouve 3 groupes et les nomme', () => {
  const n = 90, rows = [], tweets = [];
  const m = new Float32Array(n * DIM);
  const words = [['rust', 'cargo'], ['pain', 'levain'], ['agents', 'memoire']];
  for (let i = 0; i < n; i++) {
    const g = i % 3;
    m[i * DIM + g] = 1; m[i * DIM + 3 + (i % 5)] = 0.05; // axe du groupe + bruit
    rows.push(i);
    tweets.push(T(String(i), `${words[g][0]} ${words[g][1]} sujet ${words[g][0]} numéro ${i}`));
  }
  const { assign, k } = kmeans(m, rows, 3);
  const groups = [0, 1, 2].map((g) => new Set(rows.filter((r) => r % 3 === g).map((r) => assign[r])));
  groups.forEach((s) => assert.equal(s.size, 1)); // chaque vrai groupe -> un seul cluster
  assert.equal(new Set(groups.map((s) => [...s][0])).size, 3);
  const labels = labelClusters(tweets, rows, assign, k);
  const flat = labels.flat();
  for (const w of ['rust', 'levain', 'agents']) assert.ok(flat.includes(w), `${w} dans ${flat}`);
});

test('links : extractMeta et isPublicUrl', () => {
  const html = `<html><head><title> Fallback &amp; titre </title>
    <meta property="og:title" content="Super article">
    <meta name="description" content="Desc simple">
    <meta property="og:description" content='Une &quot;belle&quot; description'></head></html>`;
  assert.deepEqual(extractMeta(html), { title: 'Super article', description: 'Une "belle" description' });
  assert.equal(extractMeta('<title>Seul titre</title>').title, 'Seul titre');
  assert.equal(isPublicUrl('https://github.com/a/b'), true);
  for (const u of ['http://localhost:3000', 'http://192.168.1.2/x', 'https://x.com/a', 'https://t.co/abc', 'ftp://a.com', 'http://[::1]/', 'https://intranet/x'])
    assert.equal(isPublicUrl(u), false, u);
});

test('evalbench : score / résumé', () => {
  const ranked = [T('1', 'foo'), T('2', 'Mémoire des agents'), T('3', 'bar', { handle: 'zed' })];
  assert.equal(score(ranked, ['mémoire']).firstRank, 2);
  assert.equal(score(ranked, ['@zed']).firstRank, 3);
  assert.equal(score(ranked, ['3']).firstRank, 3);
  assert.equal(score(ranked, ['absent']).hit10, 0);
  const s = summarize([score(ranked, ['foo']), score(ranked, ['absent'])]);
  assert.equal(s.recall10, 0.5);
  assert.equal(s.mrr, 0.5);
  assert.ok(matches(ranked[0], ['FOO']));
});

test('llm : JSON tolérant, markdown sûr, messages', () => {
  assert.deepEqual(parseJsonLoose('Voici :\n```json\n{"a":1,"b":[2]}\n```'), { a: 1, b: [2] });
  assert.throws(() => parseJsonLoose('rien'));
  const html = renderMd('**Titre**\n- point [1] et [9]\n- <script>x</script>\n\nFin [2]', 2);
  assert.match(html, /<b>Titre<\/b>/);
  assert.match(html, /<li>point <a class="cite" href="#t-1" data-n="1">\[1\]<\/a> et \[9\]<\/li>/); // [9] hors bornes : texte brut
  assert.ok(!html.includes('<script>'));
  assert.match(askMessages('q?', [T('1', 'a &amp; b')])[1].content, /\[1\] @h \(\?\) : a & b/);
});

import { sortRows, selectPool } from '../src/lib/search.js';

test('tri par date : dates manquantes en dernier, quel que soit le sens', () => {
  const tw = [{ createdAt: '2026-03-01T00:00:00Z' }, { createdAt: null }, { createdAt: '2024-01-01T00:00:00Z' }, { createdAt: '2025-06-01T00:00:00Z' }];
  const rows = tw.map((_, i) => [i, 0]);
  assert.deepEqual(sortRows(rows, tw, 'oldest').map(([r]) => r), [2, 3, 0, 1]);
  assert.deepEqual(sortRows(rows, tw, 'newest').map(([r]) => r), [0, 3, 2, 1]);
});

test('« le plus ancien » porte sur TOUTES les correspondances, pas les 200 mieux classées', () => {
  const idx = new Index();
  const mk = (i, text, year) => T(String(i), text, { createdAt: `${year}-01-01T00:00:00Z`, stats: {} });
  const tweets = [];
  // 300 tweets très pertinents (« openai » répété) récents, et 1 vieux tweet qui mentionne openai une seule fois, parmi du texte.
  for (let i = 0; i < 300; i++) tweets.push(mk(i, 'openai openai openai nouveautés', 2026));
  tweets.push(mk(999, "un très long message qui parle de plein de choses et mentionne openai une fois au passage", 2023));
  idx.add(tweets);
  const kw = idx.bm25('openai', null, 5000);
  assert.ok(kw.length >= 301);
  // l'ancien tweet est classé au-delà du rang 200 par pertinence…
  assert.ok(kw.findIndex(([r]) => idx.tweets[r].id === '999') > 200);
  // …mais il sort bien en tête d'un tri « plus ancien » sur l'ensemble des correspondances
  const { pool, kind } = selectPool(kw, kw, { words: 1 });
  assert.equal(kind, 'contenant les mots de la requête');
  assert.equal(idx.tweets[sortRows(pool, idx.tweets, 'oldest')[0][0]].id, '999');
  // et avec seulement 200 candidats, on l'aurait raté
  assert.notEqual(idx.tweets[sortRows(kw.slice(0, 200), idx.tweets, 'oldest')[0][0]].id, '999');
  // requête longue : lot = les mieux classés
  assert.equal(selectPool(kw, kw, { words: 6, size: 50 }).pool.length, 50);
});

import { decide, probOf, jevIntent, jevRerank, INTENT_QUESTIONS } from '../src/lib/jev.js';
import { MODELS, modelOf } from '../src/lib/models.js';

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.authorization, body });
    const out = handler(body);
    return { ok: true, status: 200, json: async () => out, text: async () => '' };
  };
  return calls;
}

test('jev : requête conforme (modèle, state, questions) et réponse analysée', async () => {
  const calls = mockFetch(() => ({ answers: { sort: { choice: 'oldest', confidence: 0.9, probabilities: { oldest: 0.9, newest: 0.05, none: 0.05 } } } }));
  const a = await decide({ url: 'https://x/decisions', model: 'typesafe/jev-1.13', apiKey: 'K' }, 'le plus vieux', INTENT_QUESTIONS);
  assert.equal(calls[0].url, 'https://x/decisions');
  assert.equal(calls[0].auth, 'Bearer K');
  assert.equal(calls[0].body.model, 'typesafe/jev-1.13');
  assert.equal(calls[0].body.state, 'le plus vieux');
  for (const q of Object.values(calls[0].body.questions)) { assert.equal(q.type, 'choice'); assert.ok(q.instructions); assert.ok(Object.keys(q.criteria).length >= 2); }
  assert.equal(probOf(a.sort, 'oldest'), 0.9);
  assert.equal(probOf({ choice: 'a', confidence: 0.7 }, 'a'), 0.7); // repli sans probabilities
  assert.equal(probOf({ choice: 'a', confidence: 0.7 }, 'b'), 0);
});

test('jev : intention — on n’accepte une réponse que si elle est assez sûre', async () => {
  mockFetch(() => ({ answers: {
    sort: { choice: 'newest', confidence: 0.95, probabilities: { newest: 0.95, oldest: 0.03, none: 0.02 } },
    period: { choice: 'month', confidence: 0.4, probabilities: { month: 0.4, week: 0.3, year: 0.2, none: 0.1 } }, // trop incertain
    kind: { choice: 'none', confidence: 0.9, probabilities: { none: 0.9 } },
  } }));
  assert.deepEqual(await jevIntent({ url: 'u', model: 'm', apiKey: 'k' }, 'q'), { sort: 'newest', period: null, kind: null });
});

test('jev : reclassement — un appel par tweet, score = P(oui)', async () => {
  const calls = mockFetch((b) => ({ answers: { pertinent: { choice: 'oui', confidence: 0.5, probabilities: b.state.tweet.includes('scheduler') ? { oui: 0.95, non: 0.05 } : { oui: 0.1, non: 0.9 } } } }));
  const scores = await jevRerank({ url: 'u', model: 'm', apiKey: 'k' }, 'tokio', ['autre sujet', 'le scheduler de tokio', 'rien']);
  assert.equal(calls.length, 3);
  assert.deepEqual(scores, [0.1, 0.95, 0.1]);
  assert.equal(calls[0].body.state.requête, 'tokio');
});

test('jev : erreur HTTP lisible', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
  await assert.rejects(decide({ url: 'u', model: 'm', apiKey: 'k' }, 's', {}), /HTTP 401 — bad key/);
});

test('modèles : Gemma 2 en 768 dimensions, Gemma 1 tronqué à 256 ; Index suit la dimension', () => {
  assert.equal(MODELS.gemma1.dim, 256);
  assert.equal(MODELS.gemma2.dim, 768);
  assert.equal(modelOf('inconnu').key, 'gemma1');
  const idx = new Index(768);
  idx.add([T('1', 'a'), T('2', 'b')]);
  const v = new Float32Array(768); v[700] = 1;
  assert.equal(idx.setVector('2', v), true);
  assert.equal(idx.setVector('1', new Float32Array(256)), false); // mauvaise dimension refusée
  assert.deepEqual(idx.vector(v, null).map(([r]) => idx.tweets[r].id), ['2']);
  idx.setDim(256);
  assert.equal(idx.tweets.length, 0); // changement de modèle : index vidé
});
