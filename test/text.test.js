import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, semanticQuery } from '../src/lib/text.js';
import { parseBookmarksResponse } from '../src/lib/parse.js';
import { Index, DIM, contentWords } from '../src/lib/search.js';
import { page } from './fixtures/bookmarks.js';

test('decodeEntities : &amp; &lt; numériques', () => {
  assert.equal(decodeEntities('short &amp; accessible &lt;3 &#39;ok&#39; &#x1F600;'), "short & accessible <3 'ok' 😀");
  assert.equal(decodeEntities('&inconnu; reste'), '&inconnu; reste');
});

test('semanticQuery : retire l’amorce « je cherche des tweets … »', () => {
  assert.equal(semanticQuery('je cherche des tweets concernant les agents IA'), 'les agents IA');
  assert.equal(semanticQuery('Je cherche des tweets qui parlent de la mémoire des agents'), 'la mémoire des agents');
  assert.equal(semanticQuery("I'm looking for posts about vector databases"), 'vector databases');
  assert.equal(semanticQuery('mixture of experts'), 'mixture of experts');
  assert.equal(semanticQuery('trouve'), 'trouve'); // rien d'utile après l'amorce : on garde l'original
});

test('parse : entités décodées, vidéo mp4, vues et réponses', () => {
  const tw = {
    rest_id: '7', core: { user_results: { result: { core: { screen_name: 'a', name: 'A' } } } },
    views: { count: '12345' },
    legacy: {
      full_text: 'Tom &amp; Jerry https://t.co/v', created_at: 'Tue Sep 16 10:00:00 +0000 2026', reply_count: 4, favorite_count: 1,
      entities: { urls: [], media: [] },
      extended_entities: { media: [{ type: 'video', url: 'https://t.co/v', media_url_https: 'https://pbs.twimg.com/p.jpg', original_info: { width: 1280, height: 720 },
        video_info: { variants: [
          { content_type: 'application/x-mpegURL', url: 'https://v/x.m3u8' },
          { content_type: 'video/mp4', bitrate: 256000, url: 'https://v/low.mp4' },
          { content_type: 'video/mp4', bitrate: 832000, url: 'https://v/mid.mp4' },
          { content_type: 'video/mp4', bitrate: 2176000, url: 'https://v/hd.mp4' },
          { content_type: 'video/mp4', bitrate: 9000000, url: 'https://v/huge.mp4' },
        ] } }] },
    },
  };
  const { tweets } = parseBookmarksResponse(page({ cursor: null, tweets: [{ entryId: 't', sortIndex: '1', content: { itemContent: { tweet_results: { result: tw } } } }] }));
  const t = tweets[0];
  assert.equal(t.text, 'Tom & Jerry');
  assert.equal(t.media[0].video, 'https://v/hd.mp4');
  assert.equal(t.media[0].w, 1280);
  assert.equal(t.stats.views, 12345);
  assert.equal(t.stats.replies, 4);
});

test('BM25 : une phrase libre ne se laisse pas polluer par les mots vides', () => {
  const idx = new Index();
  const mk = (id, text) => ({ id, name: 'n', handle: 'h', text, links: [], media: [] });
  idx.build([mk('1', 'je cherche des tweets de recettes de cuisine pour des amis'), mk('2', 'agents IA et mémoire à long terme')], new Map());
  const res = idx.bm25('je cherche des tweets concernant la mémoire des agents IA', null).map(([r]) => idx.tweets[r].id);
  assert.equal(res[0], '2');
  assert.equal(contentWords('je cherche des tweets concernant la mémoire des agents IA'), 3); // mémoire, agents, ia
});
