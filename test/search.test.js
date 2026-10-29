import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBookmarksResponse } from '../src/lib/parse.js';
import { Index, DIM, parseQuery, rrf, tokenize, passesFilters } from '../src/lib/search.js';
import { demoPage } from './fixtures/bookmarks.js';

const { tweets } = parseBookmarksResponse(demoPage());
const idx = new Index();
// Faux vecteurs : un axe par "thème" pour tester la fusion sans modèle.
const axis = (i) => { const v = new Float32Array(DIM); v[i] = 1; return v; };
const vecs = new Map([['1001', axis(0)], ['1005', axis(0)], ['1002', axis(1)], ['1003', axis(2)], ['1004', axis(3)], ['1006', axis(4)]]);
idx.build(tweets, vecs);
const ids = (res) => res.map(([r]) => idx.tweets[r].id);

test('tokenize : accents, casse, @ et #', () => {
  assert.deepEqual(tokenize('Éléphant @Bob #IA x'), ['elephant', 'bob', 'ia']);
});

test('BM25 : mot-clé exact et préfixe', () => {
  assert.equal(ids(idx.bm25('tokio'))[0], '1002');
  assert.ok(ids(idx.bm25('agent')).includes('1001')); // "agent" ~ "agents"
});

test('BM25 : insensible aux accents', () => {
  assert.equal(ids(idx.bm25('ameliorations scheduler'))[0], '1002');
});

test('recherche vectorielle + RRF : trouve sans mot commun', () => {
  const sem = idx.vector(axis(0), null);
  const kw = idx.bm25('mémoire des agents'); // mots-clés partiels
  const fused = ids(rrf([sem, kw]));
  assert.deepEqual(new Set(fused.slice(0, 2)), new Set(['1001', '1005']));
});

test('filtres : from, has, lang, since', () => {
  const { filters } = parseQuery('from:@rustacean has:link lang:fr since:2026-01-01 tokio');
  const mask = idx.allowedMask(filters);
  assert.deepEqual(ids(idx.bm25('tokio', mask)), ['1002']);
  assert.equal(ids(idx.bm25('agents', idx.allowedMask(parseQuery('from:rustacean').filters))).length, 0);
  assert.equal(parseQuery('from:@x hello world').text, 'hello world');
  assert.ok(idx.allowedMask(parseQuery('has:media').filters)[2]);
});

test('has:notranscript : vidéos dont la transcription manque', () => {
  const mk = (id, extra) => ({ id: 'yt:' + id, kind: 'youtube', source: 'youtube', videoId: id, handle: 'c', name: 'C', text: 'v ' + id, url: 'u' + id, links: [], media: [], stats: {}, sortIndex: '1', ...extra });
  const vids = [mk('a', { trState: 'ok' }), mk('b', { trState: 'none' }), mk('c', {}), mk('d', { unavailable: true })];
  const ix = new Index(); ix.build([...vids, ...tweets], new Map());
  const f = parseQuery('has:notranscript').filters;
  const got = ix.tweets.filter((t) => passesFilters(t, f)).map((t) => t.id).sort();
  assert.deepEqual(got, ['yt:b', 'yt:c']);
});
