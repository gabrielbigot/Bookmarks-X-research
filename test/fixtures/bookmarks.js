// Réponse GraphQL "Bookmarks" synthétique, calquée sur la forme observée de X.
const user = (handle, name) => ({ result: { core: { screen_name: handle, name }, avatar: { image_url: `https://pbs.twimg.com/${handle}.jpg` } } });
const tweet = (id, handle, name, text, extra = {}) => ({
  __typename: 'Tweet',
  rest_id: id,
  core: { user_results: user(handle, name) },
  legacy: {
    full_text: text,
    created_at: 'Tue Sep 16 10:00:00 +0000 2026',
    lang: extra.lang ?? 'en',
    favorite_count: 12, retweet_count: 3, bookmark_count: 7,
    entities: { urls: extra.urls ?? [], media: extra.media ?? [] },
    extended_entities: extra.media ? { media: extra.media } : undefined,
  },
  ...(extra.note ? { note_tweet: { note_tweet_results: { result: { text: extra.note, entity_set: { urls: extra.urls ?? [] } } } } } : {}),
  ...(extra.quoted ? { quoted_status_result: { result: extra.quoted } } : {}),
});
const entry = (id, sortIndex, result) => ({
  entryId: `tweet-${id}`, sortIndex,
  content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: { result } } },
});

export function page({ cursor = 'CUR_NEXT', tweets }) {
  return {
    data: { bookmark_timeline_v2: { timeline: { instructions: [{
      type: 'TimelineAddEntries',
      entries: [
        ...tweets,
        ...(cursor ? [{ entryId: 'cursor-bottom-1', sortIndex: '0', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: cursor } }] : []),
        { entryId: 'cursor-top-1', sortIndex: '9', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Top', value: 'CUR_TOP' } },
      ],
    }] } } },
  };
}

export const DEMO = [
  ['1001', 'karpathy_fan', 'Andrej Fan', 'Long-term memory for LLM agents: store episodic summaries and retrieve them with embeddings.', {}],
  ['1002', 'rustacean', 'Ferris', 'Nouvelle version de tokio : améliorations du scheduler et moins de latence. https://t.co/abc', { lang: 'fr', urls: [{ url: 'https://t.co/abc', expanded_url: 'https://github.com/tokio-rs/tokio/releases' }] }],
  ['1003', 'mlpapers', 'ML Papers', 'Mixture of experts routing explained with diagrams https://t.co/img1', { media: [{ type: 'photo', url: 'https://t.co/img1', media_url_https: 'https://pbs.twimg.com/media/x.jpg', ext_alt_text: 'diagram of expert routing' }] }],
  ['1004', 'cookingdaily', 'Cuisine', 'Recette de pain au levain, hydratation 75%, fermentation longue au frigo.', { lang: 'fr' }],
  ['1005', 'agentsdev', 'Agents Dev', 'Our agents now persist their memory between sessions using a vector store.', { quoted: tweet('900', 'someone', 'Someone', 'Memory is the missing piece for autonomous agents') }],
  ['1006', 'longposter', 'Long', 'short preview…', { note: 'This is the full long-form note tweet about decision models replacing LLM calls for routing.' }],
];

export const demoPage = (cursor = 'CUR_NEXT') =>
  page({ cursor, tweets: DEMO.map(([id, h, n, t, e], i) => entry(id, String(2000 - i), tweet(id, h, n, t, e))) });
