import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMeta, fetchMeta, cardFromMeta } from '../src/lib/links.js';
import { parseBookmarksResponse } from '../src/lib/parse.js';
import { page } from './fixtures/bookmarks.js';

test('extractMeta : image (absolue, relative, absente) et nom du site', () => {
  const html = `<head><title>T</title><meta property="og:image" content="/img/cover.png"><meta property="og:site_name" content="Mon &amp; Blog"></head>`;
  const m = extractMeta(html, 'https://blog.example.com/post/1');
  assert.equal(m.image, 'https://blog.example.com/img/cover.png');
  assert.equal(m.site, 'Mon & Blog');
  assert.equal(extractMeta('<meta name="twitter:image" content="https://cdn.x/a.jpg"><title>t</title>', 'https://a.b/').image, 'https://cdn.x/a.jpg');
  assert.equal(extractMeta('<title>t</title>', 'https://a.b/').image, '');
  assert.equal(extractMeta('<meta property="og:image" content="javascript:alert(1)"><title>t</title>', 'https://a.b/').image, ''); // jamais de schéma exotique
});

test('fetchMeta : lit la page (flux), renvoie l’URL finale + carte', async () => {
  const html = '<title>Article</title><meta property="og:image" content="/c.png"><meta name="description" content="Résumé">';
  const bytes = new TextEncoder().encode(html);
  const fake = async () => ({
    ok: true, url: 'https://final.example.com/p', headers: { get: () => 'text/html; charset=utf-8' },
    body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : ((done = true), { done: false, value: bytes })), cancel: async () => {} }; } },
  });
  const m = await fetchMeta('https://short.example.com/x', fake);
  assert.equal(m.url, 'https://final.example.com/p');
  assert.equal(m.image, 'https://final.example.com/c.png');
  assert.deepEqual(cardFromMeta('https://short.example.com/x', m), { url: 'https://short.example.com/x', title: 'Article', description: 'Résumé', image: 'https://final.example.com/c.png', site: '' });
  assert.equal(await fetchMeta('http://localhost/x', fake), null);
});

const withCard = (card, urls = [{ url: 'https://t.co/z', expanded_url: 'https://blog.example.com/post' }]) => parseBookmarksResponse(page({ cursor: null, tweets: [{
  entryId: 'tweet-9', sortIndex: '9',
  content: { itemContent: { tweet_results: { result: { rest_id: '9', core: { user_results: { result: { core: { screen_name: 'a', name: 'A' } } } }, card,
    legacy: { full_text: 'Lisez ça https://t.co/z', created_at: 'Tue Sep 16 10:00:00 +0000 2026', entities: { urls } } } } } },
}] })).tweets[0];

test('parse : carte de lien fournie par X (tableau ou objet de binding_values)', () => {
  const arr = [
    { key: 'title', value: { string_value: 'Titre de la carte', type: 'STRING' } },
    { key: 'description', value: { string_value: 'Description' } },
    { key: 'vanity_url', value: { string_value: 'blog.example.com' } },
    { key: 'thumbnail_image_large', value: { image_value: { url: 'https://pbs.twimg.com/card_img/1/a.jpg' } } },
    { key: 'card_url', value: { string_value: 'https://t.co/z' } },
  ];
  const t = withCard({ legacy: { binding_values: arr } });
  assert.deepEqual(t.xcard, { url: 'https://blog.example.com/post', title: 'Titre de la carte', description: 'Description', image: 'https://pbs.twimg.com/card_img/1/a.jpg', site: 'blog.example.com' });
  // même carte, binding_values en objet
  const obj = Object.fromEntries(arr.map((b) => [b.key, b.value]));
  assert.equal(withCard({ legacy: { binding_values: obj } }).xcard.title, 'Titre de la carte');
  // sondage / appli (ni titre ni image) : pas de carte ; tweet sans carte : clé absente
  assert.equal(withCard({ legacy: { binding_values: [{ key: 'choice1_label', value: { string_value: 'Oui' } }] } }).xcard, undefined);
  assert.equal('xcard' in withCard(undefined), false);
});
