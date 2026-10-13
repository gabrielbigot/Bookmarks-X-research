import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBookmarksResponse } from '../src/lib/parse.js';
import { demoPage, page } from './fixtures/bookmarks.js';

test('parse : tweets, curseur bas, URLs développées, médias', () => {
  const { tweets, cursorBottom } = parseBookmarksResponse(demoPage());
  assert.equal(tweets.length, 6);
  assert.equal(cursorBottom, 'CUR_NEXT');
  const t2 = tweets.find((t) => t.id === '1002');
  assert.match(t2.text, /github\.com\/tokio-rs/);
  assert.equal(t2.url, 'https://x.com/rustacean/status/1002');
  assert.equal(t2.createdAt, '2026-09-16T10:00:00.000Z');
  const t3 = tweets.find((t) => t.id === '1003');
  assert.equal(t3.media[0].alt, 'diagram of expert routing');
  assert.ok(!t3.text.includes('t.co'));
});

test('parse : citation et note_tweet (texte long)', () => {
  const { tweets } = parseBookmarksResponse(demoPage());
  assert.equal(tweets.find((t) => t.id === '1005').quoted.handle, 'someone');
  assert.match(tweets.find((t) => t.id === '1006').text, /full long-form note/);
});

test('parse : dernière page (pas de curseur) et tweets indisponibles ignorés', () => {
  const tomb = { entryId: 'tweet-x', sortIndex: '1', content: { itemContent: { tweet_results: { result: { __typename: 'TweetTombstone' } } } } };
  const { tweets, cursorBottom } = parseBookmarksResponse(page({ cursor: null, tweets: [tomb] }));
  assert.equal(tweets.length, 0);
  assert.equal(cursorBottom, null);
});

test('parse : JSON inattendu ne plante pas', () => {
  assert.deepEqual(parseBookmarksResponse({}), { tweets: [], cursorBottom: null });
});
