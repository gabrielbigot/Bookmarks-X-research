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
  assert.deepEqual(extractMeta(html), { title: 'Super article', description: 'Une "belle" description', image: '', site: '' });
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

import { packVectors, unpackVectors, decodeFull } from '../src/lib/backup.js';

test('sauvegarde avec vecteurs : quantification int8 fidèle, recherches enregistrées, chiffrement', async () => {
  const dim = 256;
  const mkvec = (seed) => { const v = new Float32Array(dim); let n = 0; for (let d = 0; d < dim; d++) { v[d] = Math.sin(seed * 12.9898 + d * 78.233); n += v[d] ** 2; } return v.map((x) => x / Math.sqrt(n)); };
  const entries = [{ id: 'a', vec: mkvec(1) }, { id: 'b', vec: mkvec(2) }, { id: 'bad', vec: new Float32Array(3) }];
  const packed = packVectors('model-x', dim, entries);
  assert.deepEqual(packed.ids, ['a', 'b']); // mauvaise dimension ignorée
  assert.ok(packed.data.length < 2 * dim * 4); // ≪ float32 en JSON
  const back = unpackVectors(packed);
  for (const [i, e] of back.entries()) {
    const cos = e.vec.reduce((s, x, d) => s + x * entries[i].vec[d], 0);
    assert.ok(cos > 0.999, `cosinus ${cos}`);
    assert.ok(Math.abs(e.vec.reduce((s, x) => s + x * x, 0) - 1) < 1e-4); // renormalisé
  }
  const tweets = [T('a', 'un'), T('b', 'deux')];
  for (const pass of [undefined, 'pw']) {
    const bytes = await encode(tweets, pass, { saved: ['mémoire des agents'], vectors: packed });
    const r = await decodeFull(bytes, pass);
    assert.equal(r.tweets.length, 2);
    assert.deepEqual(r.saved, ['mémoire des agents']);
    assert.equal(r.vectors.model, 'model-x');
    assert.equal(unpackVectors(r.vectors).length, 2);
  }
  // sauvegarde ancienne (sans vecteurs ni recherches) toujours lisible
  const old = await decodeFull(await encode(tweets));
  assert.deepEqual([old.saved, old.vectors], [[], null]);
});

import { getSettings, setSettings } from '../src/lib/settings.js';

test('réglages : migration de sécurité (GPU auto + indexation au démarrage -> CPU + indexation par tranches), une seule fois', async () => {
  let store = { settings: { llm: { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' }, compute: 'auto', indexPaused: false, embedModel: 'gemma2' } };
  globalThis.chrome = { storage: { local: { get: async () => ({ ...store }), set: async (o) => { store = { ...store, ...o }; } } } };
  const s = await getSettings();
  assert.equal(s.compute, 'cpu');
  assert.equal(s.indexMode, 'soft'); // v3 : manuel, puis v4 : automatique par petites tranches
  assert.equal(s.embedModel, 'gemma2'); // les autres choix de l'utilisateur sont conservés
  assert.equal(s.llm.apiKey, 'k');
  assert.equal('indexPaused' in store.settings, false);
  assert.equal(store.settings.settingsVersion, 4);
  // après la migration, un choix explicite de l'utilisateur est respecté
  await setSettings({ compute: 'auto', indexMode: 'auto' });
  const s2 = await getSettings();
  assert.equal(s2.compute, 'auto');
  assert.equal(s2.indexMode, 'auto');
  // première installation : valeurs sûres par défaut
  store = {};
  const d = await getSettings();
  assert.deepEqual([d.compute, d.indexMode], ['cpu', 'manual']);
});

test('parseQuery: opérateur dedupe', async () => {
  const { parseQuery } = await import('../src/lib/search.js');
  assert.deepEqual(parseQuery('robot dedupe:oui').filters.dedupe, { sim: 0.92, days: 7 });
  assert.deepEqual(parseQuery('dedupe:0.9,3').filters.dedupe, { sim: 0.9, days: 3 });
  assert.equal(parseQuery('dedupe:non').filters.dedupe, false);
  assert.equal(parseQuery('robot dedupe:oui').text, 'robot');
});

test('sauvegarde : tableaux de bord, sources primaires et verdicts officiels font l’aller-retour', async () => {
  const { encode, decodeFull } = await import('../src/lib/backup.js');
  const dash = { widgets: [{ id: 'w', title: 't', board: 'b1' }], detectors: [], verdicts: {}, boards: [{ id: 'b1', name: 'Veille IA' }, { bad: 1 }], mainName: 'Accueil', primary: ['openai', 7], official: { v: 'desc', m: { 1: 90 } } };
  const out = await decodeFull(await encode([{ id: '1', text: 'x' }], '', { dash }), '');
  assert.deepEqual(out.dash.boards, [{ id: 'b1', name: 'Veille IA' }]);
  assert.equal(out.dash.mainName, 'Accueil');
  assert.deepEqual(out.dash.primary, ['openai']);
  assert.deepEqual(out.dash.official, { v: 'desc', m: { 1: 90 } });
  assert.equal(out.dash.widgets[0].board, 'b1');
});

import { chatFull } from '../src/lib/llm.js';
test('chatFull : raisonnement obligatoire -> réglage « low », mémorisé, puis limite doublée si sortie vide', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    calls.push(b);
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o, text: async () => JSON.stringify(o) });
    if (b.reasoning?.enabled === false) return json({ error: { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.' } }, 400);
    if (b.max_tokens < 5000) return json({ choices: [{ finish_reason: 'length', message: { content: null } }] });
    return json({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":1}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  };
  try {
    const llm = { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', model: 'z-ai/glm-test' };
    const r = await chatFull(llm, [{ role: 'user', content: 'x' }], { maxTokens: 1000, noThink: true });
    assert.equal(r.text, '{"ok":1}');
    assert.deepEqual(calls.map((c) => c.reasoning), [{ enabled: false }, { effort: 'low' }, { effort: 'low' }]);
    assert.equal(calls[2].max_tokens, 7000); // (1000 + 2500) × 2
    calls.length = 0;
    await chatFull(llm, [{ role: 'user', content: 'x' }], { maxTokens: 1000, noThink: true });
    assert.equal(calls[0].reasoning.effort, 'low', 'le réglage accepté est mémorisé : pas de nouvel essai inutile');
  } finally { globalThis.fetch = orig; }
});

import { aiTranscriptMessages, parseAiTranscript } from '../src/lib/transcript.js';
test('transcription IA : messages avec le lien de la vidéo, lecture des lignes horodatées', () => {
  const m = aiTranscriptMessages({ id: 'yt:abc123', text: 'Une vidéo', name: 'Chaîne', durationText: '1:25:36' });
  assert.equal(m[0].content[1].video_url.url, 'https://www.youtube.com/watch?v=abc123');
  assert.match(m[0].content[0].text, /1:25:36/);
  const segs = parseAiTranscript('[00:00] Bonjour à tous\n[0:45] Aujourd’hui on parle d’IA.\n[1:02:03] Merci beaucoup\n12:40 - Un passage sans crochets\n[05:00] [inaudible]\nBlabla sans horodatage\n[75:30] Après plus de 60 minutes');
  assert.deepEqual(segs.map((s) => s.t), [0, 45, 3723, 760, 4530]);
  assert.equal(segs[0].text, 'Bonjour à tous');
  assert.ok(!segs.some((s) => /inaudible|Blabla/.test(s.text)));
});

import { parseBenchmarks, newModels, citedModels, pickRows, modelKey } from '../src/lib/bench.js';
test('classements : lecture tolérante des benchmarks OpenRouter, nouveaux modèles, modèles cités', () => {
  const b = parseBenchmarks({ data: [
    { source: 'artificial-analysis', model_permaslug: 'z-ai/glm-5.3', display_name: 'GLM-5.3 (Reasoning)', intelligence_index: 61.2, coding_index: '55', agentic_index: 50, pricing: { prompt: '0.0000014', completion: '0.0000044' } },
    { source: 'artificial-analysis', model_permaslug: 'z-ai/glm-5.3-nr', display_name: 'GLM-5.3 (Non-reasoning)', intelligence_index: 48 },
    { source: 'artificial-analysis', model_permaslug: 'x/y', display_name: 'Autre', intelligence_index: 70, pricing: { price_1m_input_tokens: 2, price_1m_output_tokens: 10 } },
    { model_permaslug: 'bad', display_name: 'Sans score' },
  ], meta: { as_of: '2026-10-16' } });
  assert.equal(b.rows.length, 2, 'variantes fusionnées, lignes sans score ignorées');
  const glm = b.rows.find((r) => /GLM/.test(r.name));
  assert.equal(glm.intelligence, 61.2); assert.equal(glm.coding, 55);
  assert.ok(Math.abs(glm.priceIn - 1.4) < 1e-6 && Math.abs(glm.priceOut - 4.4) < 1e-6);
  assert.deepEqual([b.rows.find((r) => r.name === 'Autre').priceIn, b.rows.find((r) => r.name === 'Autre').priceOut], [2, 10]);
  const win = { from: '2026-10-11', to: '2026-10-17' };
  const nm = newModels({ data: [{ id: 'a/new', name: 'New One', created: Date.UTC(2026, 9, 14, 12) / 1000, context_length: 128000, pricing: { prompt: '0.000001', completion: '0.000002' } }, { id: 'a/old', name: 'Old', created: Date.UTC(2026, 5, 1) / 1000 }] }, win);
  assert.equal(nm.length, 1); assert.equal(nm[0].day, '2026-10-14'); assert.equal(nm[0].priceIn, 1);
  const cited = citedModels(b.rows, 'Z.ai lance GLM-5.3 aujourd’hui, et un modèle quelconque');
  assert.ok(cited.has('z-ai/glm-5.3') && !cited.has('x/y'));
  assert.equal(modelKey('GLM-5.3 (Reasoning)'), 'glm53');
  assert.deepEqual(pickRows(b.rows, 'intelligence', cited, { top: 1 }).map((r) => r.name), ['Autre', 'GLM-5.3 (Reasoning)']);
  assert.deepEqual(parseBenchmarks({}).rows, []);
});
