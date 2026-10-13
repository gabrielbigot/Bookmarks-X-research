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
