import { decodeEntities } from './text.js';

// Parse les réponses GraphQL "Bookmarks" de X vers un format de tweet normalisé.
// Volontairement défensif : X change souvent la forme de ses réponses.

function unwrap(result) {
  if (!result) return null;
  if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) return result.tweet;
  return result;
}

function userInfo(r) {
  const u = r?.core?.user_results?.result;
  const handle = u?.core?.screen_name ?? u?.legacy?.screen_name ?? '';
  const name = u?.core?.name ?? u?.legacy?.name ?? handle;
  const avatar = u?.avatar?.image_url ?? u?.legacy?.profile_image_url_https ?? '';
  return { handle, name, avatar };
}

export function normalizeTweet(raw, depth = 0) {
  let r = unwrap(raw);
  if (!r || !r.legacy) return null; // tombstone / indisponible
  // Un retweet dans les bookmarks : on garde le contenu d'origine.
  const rt = unwrap(r.legacy.retweeted_status_result?.result);
  if (rt?.legacy) r = rt;

  const legacy = r.legacy;
  const note = r.note_tweet?.note_tweet_results?.result;
  let text = note?.text ?? legacy.full_text ?? '';
  const urlEntities = note?.entity_set?.urls ?? legacy.entities?.urls ?? [];
  const links = [];
  for (const u of urlEntities) {
    if (!u.url) continue;
    const expanded = u.expanded_url || u.url;
    text = text.split(u.url).join(expanded);
    links.push(expanded);
  }
  const mediaEntities = legacy.extended_entities?.media ?? legacy.entities?.media ?? [];
  const media = [];
  for (const m of mediaEntities) {
    if (m.url) text = text.split(m.url).join('');
    const item = { type: m.type, url: m.media_url_https, alt: m.ext_alt_text || '', w: m.original_info?.width, h: m.original_info?.height };
    const mp4 = (m.video_info?.variants ?? []).filter((v) => v.content_type === 'video/mp4');
    if (mp4.length) { // meilleur débit raisonnable (≤ ~2,2 Mbit/s), sinon le plus léger
      const ok = mp4.filter((v) => (v.bitrate ?? 0) <= 2_200_000).sort((a, b) => b.bitrate - a.bitrate);
      item.video = (ok[0] ?? mp4.sort((a, b) => a.bitrate - b.bitrate)[0]).url;
    }
    media.push(item);
  }
  text = decodeEntities(text.replace(/[ \t]+\n/g, '\n').trim());

  const id = r.rest_id ?? legacy.id_str;
  const { handle, name, avatar } = userInfo(r);
  const created = legacy.created_at ? new Date(legacy.created_at) : null;

  const tweet = {
    id,
    text,
    handle,
    name,
    avatar,
    createdAt: created && !isNaN(created) ? created.toISOString() : null,
    url: handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/status/${id}`,
    links,
    media,
    lang: legacy.lang || '',
    stats: {
      replies: legacy.reply_count ?? 0,
      views: Number(r.views?.count) || 0,
      likes: legacy.favorite_count ?? 0,
      reposts: legacy.retweet_count ?? 0,
      bookmarks: legacy.bookmark_count ?? 0,
    },
  };
  if (depth === 0 && r.quoted_status_result?.result) {
    const q = normalizeTweet(r.quoted_status_result.result, 1);
    if (q) tweet.quoted = { id: q.id, text: q.text, handle: q.handle, name: q.name, url: q.url, links: q.links };
  }
  return tweet;
}

function findInstructions(json) {
  const direct =
    json?.data?.bookmark_timeline_v2?.timeline?.instructions ??
    json?.data?.bookmark_timeline?.timeline?.instructions;
  if (Array.isArray(direct)) return direct;
  // Repli : cherche récursivement un tableau "instructions".
  const stack = [json];
  while (stack.length) {
    const o = stack.pop();
    if (!o || typeof o !== 'object') continue;
    if (Array.isArray(o.instructions)) return o.instructions;
    for (const v of Object.values(o)) if (v && typeof v === 'object') stack.push(v);
  }
  return [];
}

export function parseBookmarksResponse(json) {
  const tweets = [];
  let cursorBottom = null;
  for (const ins of findInstructions(json)) {
    const entries = ins.entries ?? [];
    for (const e of entries) {
      const c = e.content;
      if (!c) continue;
      if (c.entryType === 'TimelineTimelineCursor' || c.__typename === 'TimelineTimelineCursor') {
        if (/bottom/i.test(c.cursorType || '') || /^cursor-bottom/.test(e.entryId || '')) cursorBottom = c.value;
        continue;
      }
      const results = [];
      if (c.itemContent?.tweet_results?.result) results.push(c.itemContent.tweet_results.result);
      for (const it of c.items ?? []) {
        const r = it?.item?.itemContent?.tweet_results?.result;
        if (r) results.push(r);
      }
      for (const raw of results) {
        const t = normalizeTweet(raw);
        if (t) {
          t.sortIndex = e.sortIndex ?? '';
          tweets.push(t);
        }
      }
    }
  }
  return { tweets, cursorBottom };
}
