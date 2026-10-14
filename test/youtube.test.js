import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYoutube, parseDuration, parseViews, toItem, toHistoryItem, mergeVideo, txt, videoText, isVideoItem, fmtDuration, parseHistoryHeader } from '../src/lib/youtube.js';

const run = (text) => ({ runs: [{ text }] });
// --- ancien format ---
const pvr = (id, title, extra = {}) => ({ playlistVideoRenderer: {
  videoId: id, title: run(title), index: { simpleText: String(extra.pos ?? 1) }, lengthText: { simpleText: extra.len ?? '12:34' }, lengthSeconds: extra.sec ?? '754',
  shortBylineText: { runs: [{ text: extra.channel ?? 'Chaîne A', navigationEndpoint: { browseEndpoint: { browseId: 'UCaaa', canonicalBaseUrl: extra.handlePath ?? '/@chaine-a' } } }] },
  thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/small.jpg' }, { url: 'https://i.ytimg.com/big.jpg' }] },
  videoInfo: { runs: [{ text: '1,2 M de vues' }, { text: ' • ' }, { text: 'il y a 2 ans' }] }, isPlayable: extra.playable ?? true,
} });
const contItem = (token) => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });

test('texte, durées, vues', () => {
  assert.equal(txt({ simpleText: 'a' }), 'a');
  assert.equal(txt(run('b')), 'b');
  assert.equal(txt({ content: 'c' }), 'c');
  assert.equal(txt(null), '');
  assert.equal(parseDuration('12:34'), 754);
  assert.equal(parseDuration('1:02:03'), 3723);
  assert.equal(parseDuration('abc'), 0);
  assert.equal(fmtDuration(3723), '1:02:03');
  assert.equal(fmtDuration(754), '12:34');
  assert.equal(parseViews('1,2 M de vues'), 1_200_000);
  assert.equal(parseViews('12 k vues'), 12_000);
  assert.equal(parseViews('3.4M views'), 3_400_000);
  assert.equal(parseViews('1 234 vues'), 1234);
  assert.equal(parseViews('2,5 Md de vues'), 2_500_000_000);
  assert.equal(parseViews(''), 0);
});

test('ancien format : vidéos, chaîne/@handle, durée, vues, date, position, pagination, en-tête', () => {
  const json = { header: { playlistHeaderRenderer: { playlistId: 'PL123', title: { simpleText: 'Ma liste' }, numVideosText: run('3 vidéos') } },
    contents: [pvr('v1', 'Le cerveau expliqué', { pos: 1 }), pvr('v2', '[Vidéo privée]', { pos: 2, playable: false, channel: '' }), contItem('TOKEN_NEXT')] };
  const r = parseYoutube(json);
  assert.deepEqual(r.header, { id: 'PL123', title: 'Ma liste', count: 3 });
  assert.equal(r.videos.length, 2);
  assert.equal(r.continuation, 'TOKEN_NEXT');
  const v = r.videos[0];
  assert.deepEqual([v.videoId, v.title, v.channel, v.handle, v.durationSec, v.durationText, v.pos], ['v1', 'Le cerveau expliqué', 'Chaîne A', 'chaine-a', 754, '12:34', 1]);
  assert.equal(v.thumb, 'https://i.ytimg.com/big.jpg');
  assert.equal(v.views, '1,2 M de vues');
  assert.equal(v.published, 'il y a 2 ans');
  assert.equal(r.videos[1].unavailable, true);
  assert.equal(r.unparsed, 0);
});

test('nouveau format : lockupViewModel (vidéo + playlist) et jeton dans continuationItemViewModel', () => {
  const lock = (id, title, parts, badge) => ({ lockupViewModel: { contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentImage: { thumbnailViewModel: { image: { sources: [{ url: 'https://i.ytimg.com/t.jpg' }] }, overlays: [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [{ thumbnailBadgeViewModel: { text: badge } }] } }] } },
    metadata: { lockupMetadataViewModel: { title: { content: title }, metadata: { contentMetadataViewModel: { metadataRows: [
      { metadataParts: [{ text: { content: parts[0], commandRuns: [{ onTap: { innertubeCommand: { browseEndpoint: { browseId: 'UCbbb', canonicalBaseUrl: '/@brain-lab' } } } }] } }] },
      { metadataParts: [{ text: { content: parts[1] } }, { text: { content: parts[2] } }] }] } } } } } });
  const plist = { lockupViewModel: { contentId: 'PLabc', contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST', metadata: { lockupMetadataViewModel: { title: { content: 'Neurosciences' } } },
    contentImage: { collectionThumbnailViewModel: { primaryThumbnail: { thumbnailViewModel: { overlays: [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [{ thumbnailBadgeViewModel: { text: '42 vidéos' } }] } }] } } } } } };
  const json = { contents: [lock('n1', 'How the brain works', ['Brain Lab', '350 k vues', 'il y a 3 mois'], '1:02:03'), plist, { continuationItemViewModel: { continuationCommand: { token: 'TOK_VM' } } }] };
  const r = parseYoutube(json);
  assert.equal(r.videos.length, 1);
  const v = r.videos[0];
  assert.deepEqual([v.videoId, v.title, v.channel, v.handle, v.channelId, v.views, v.published, v.durationText, v.durationSec, v.thumb],
    ['n1', 'How the brain works', 'Brain Lab', 'brain-lab', 'UCbbb', '350 k vues', 'il y a 3 mois', '1:02:03', 3723, 'https://i.ytimg.com/t.jpg']);
  assert.deepEqual(r.playlists, [{ id: 'PLabc', title: 'Neurosciences', count: 42 }]);
  assert.equal(r.continuation, 'TOK_VM');
});

test('liste de playlists (gridPlaylistRenderer), doublons ignorés, menus de tri ignorés', () => {
  const grid = (id, title, n) => ({ gridPlaylistRenderer: { playlistId: id, title: run(title), videoCountText: run(`${n} vidéos`) } });
  const json = { contents: [grid('PL1', 'Musique', 120), grid('PL1', 'Musique', 120), grid('PL2', 'Tuto', 8)],
    sortMenu: { serviceEndpoint: { continuationCommand: { token: 'SORT_TOKEN' } } }, tail: contItem('REAL') };
  const r = parseYoutube(json);
  assert.deepEqual(r.playlists, [{ id: 'PL1', title: 'Musique', count: 120 }, { id: 'PL2', title: 'Tuto', count: 8 }]);
  assert.equal(r.continuation, 'REAL'); // le jeton de fin de liste, pas celui du menu de tri
});

test('format inconnu : rien d’inventé, éléments illisibles comptés', () => {
  assert.deepEqual(parseYoutube({}), { videos: [], playlists: [], continuation: null, header: null, unparsed: 0 });
  assert.equal(parseYoutube({ a: [{ playlistVideoRenderer: { title: run('sans id') } }] }).unparsed, 1);
  assert.equal(parseYoutube({ x: { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO' } } }).unparsed, 1);
});

test('élément stocké : identifiant espacé, texte indexé, fusion des playlists, jamais d’écrasement par du vide', () => {
  const v = parseYoutube({ c: [pvr('v1', 'Le cerveau expliqué', { pos: 3 })] }).videos[0];
  const it = toItem(v, { id: 'WL', title: 'À regarder plus tard' }, 1000);
  assert.equal(it.id, 'yt:v1');
  assert.equal(isVideoItem(it), true);
  assert.equal(isVideoItem({ id: '123' }), false);
  assert.equal(it.url, 'https://www.youtube.com/watch?v=v1');
  assert.equal(it.stats.views, 1_200_000);
  assert.equal(it.sortIndex, String(1_000_000 - 3));
  assert.deepEqual([it.links, it.media], [[], []]); // champs attendus par l'index de recherche
  assert.match(videoText(it), /Le cerveau expliqué\nChaîne : Chaîne A\nPlaylists : À regarder plus tard/);
  const again = toItem({ ...v, thumb: '', title: 'Titre modifié', views: '' }, { id: 'PLx', title: 'Neuro' }, 2000);
  const merged = mergeVideo(it, again);
  assert.deepEqual(merged.playlists.map((p) => p.id).sort(), ['PLx', 'WL']);
  assert.equal(merged.text, 'Titre modifié');
  assert.equal(merged.thumb, 'https://i.ytimg.com/big.jpg'); // miniature vide ne remplace pas l'existante
  assert.equal(merged.viewsText, '1,2 M de vues');
  assert.equal(merged.addedAt, 1000);
  // même playlist revue : titre mis à jour, pas dupliquée
  assert.equal(mergeVideo(merged, toItem(v, { id: 'WL', title: 'Watch later' })).playlists.length, 2);
  // chaîne sans @handle : repli sur un identifiant dérivé du nom
  assert.equal(toItem({ videoId: 'z', title: 't', channel: 'Ma Chaîne Étrange !' }, null).handle, 'machaineetrange');
});

import { parseQuery, passesFilters, Index } from '../src/lib/search.js';

test('recherche : opérateurs source: et playlist: (guillemets compris), texte des vidéos indexé', () => {
  const v1 = toItem({ videoId: 'a', title: 'Le cerveau expliqué', channel: 'Neuro', views: '1 k vues' }, { id: 'WL', title: 'À regarder plus tard' });
  const v2 = toItem({ videoId: 'b', title: 'Rust async', channel: 'Dev' }, { id: 'PL9', title: 'Programmation' });
  const tw = { id: '123', text: 'un tweet', name: 'X', handle: 'x', links: [], media: [], sortIndex: '5' };
  let q = parseQuery('cerveau playlist:"à regarder plus tard" source:youtube');
  assert.equal(q.text, 'cerveau');
  assert.deepEqual([q.filters.playlist, q.filters.source], ['à regarder plus tard', 'youtube']);
  assert.deepEqual([v1, v2, tw].map((t) => passesFilters(t, q.filters)), [true, false, false]);
  assert.deepEqual([v1, v2, tw].map((t) => passesFilters(t, parseQuery('source:x').filters)), [false, false, true]);
  assert.deepEqual([v1, v2, tw].map((t) => passesFilters(t, parseQuery('source:yt').filters)), [true, true, false]);
  assert.deepEqual([v1, v2].map((t) => passesFilters(t, parseQuery('playlist:programmation').filters)), [false, true]); // sans accents ni casse
  assert.deepEqual([v1, v2].map((t) => passesFilters(t, parseQuery('playlist:PL9').filters)), [false, true]); // ou par identifiant
  assert.equal(parseQuery('from:@neuro').filters.from, 'neuro');
  // l'index trouve une vidéo par son titre, sa chaîne ET sa playlist
  const idx = new Index();
  idx.add([v1, v2, tw]);
  const ids = (text) => idx.bm25(text, null).map(([r]) => idx.tweets[r].id);
  assert.deepEqual(ids('cerveau'), ['yt:a']);
  assert.deepEqual(ids('neuro'), ['yt:a']);
  assert.deepEqual(ids('programmation'), ['yt:b']);
});

// --- historique ---
const NOW = new Date(2026, 9, 14, 15); // mercredi 14 octobre 2026
test('en-têtes de jour (fr/en)', () => {
  const h = (x) => parseHistoryHeader(x, NOW);
  assert.equal(h("Aujourd'hui"), '2026-10-14');
  assert.equal(h('Today'), '2026-10-14');
  assert.equal(h('Hier'), '2026-10-13');
  assert.equal(h('Yesterday'), '2026-10-13');
  assert.equal(h('lundi'), '2026-10-12');
  assert.equal(h('Mercredi'), '2026-10-07');
  assert.equal(h('dimanche'), '2026-10-11');
  assert.equal(h('12 octobre'), '2026-10-12');
  assert.equal(h('3 déc.'), '2025-12-03');
  assert.equal(h('Oct 5'), '2026-10-05');
  assert.equal(h('12 octobre 2024'), '2024-10-12');
  assert.equal(h('bla bla'), null);
  assert.equal(h(''), null);
});

const vr = (id, title, extra = {}) => ({ videoRenderer: { videoId: id, title: run(title), ownerText: { runs: [{ text: 'Chaîne H', navigationEndpoint: { browseEndpoint: { browseId: 'UChh', canonicalBaseUrl: '/@chaine-h' } } }] },
  lengthText: { simpleText: '5:00' }, viewCountText: { simpleText: '1 000 vues' }, descriptionSnippet: run(extra.desc ?? ''),
  thumbnailOverlays: extra.pct ? [{ thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: extra.pct } }] : [], thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/h.jpg' }] } } });
const sec = (label, ...items) => ({ itemSectionRenderer: { header: { itemSectionHeaderRenderer: { title: { simpleText: label } } }, contents: items } });

test('historique : sections par jour, progression, dédoublonnage par jour, pagination', () => {
  const json = { contents: [sec("Aujourd'hui", vr('h1', 'Un', { pct: 40, desc: 'desc un' }), vr('h2', 'Deux')), sec('Hier', vr('h1', 'Un'), vr('h3', 'Trois')), contItem('HT')] };
  const r = parseYoutube(json, { history: true });
  assert.deepEqual(r.videos.map((v) => v.videoId + '@' + v.label), ['h1@Aujourd\'hui', 'h2@Aujourd\'hui', 'h1@Hier', 'h3@Hier']);
  assert.equal(r.videos[0].progress, 40);
  assert.equal(r.videos[0].desc, 'desc un');
  assert.equal(r.continuation, 'HT');
  // sans l'option, une page d'historique ne produit pas de vidéos (jamais les recommandations)
  assert.equal(parseYoutube(json).videos.length, 0);
});

test('historique : fusion avec une playlist, jours cumulés, requêtes viewed:/watched:', () => {
  const pl = toItem({ videoId: 'h1', title: 'Un', pos: 3 }, { id: 'WL', title: 'À regarder plus tard' });
  const a = toHistoryItem({ videoId: 'h1', title: 'Un', progress: 40, desc: 'd' }, '2026-10-13');
  const b = toHistoryItem({ videoId: 'h1', title: 'Un', progress: 10 }, '2026-10-14');
  let m = mergeVideo(mergeVideo(pl, a), b);
  assert.deepEqual(m.watched, ['2026-10-13', '2026-10-14']);
  assert.equal(m.lastWatched, '2026-10-14');
  assert.equal(m.progress, 40);
  assert.equal(m.desc, 'd');
  assert.equal(m.playlists.length, 1);
  assert.equal(BigInt(m.sortIndex), BigInt(Math.floor(Date.parse('2026-10-14T12:00:00Z') / 1000)));
  assert.match(videoText(m), /\nd$/);
  const unseen = toItem({ videoId: 'u', title: 'U' }, { id: 'WL', title: 'x' });
  const f = (q) => parseQuery(q).filters;
  assert.equal(passesFilters(m, f('viewed:yes')), true);
  assert.equal(passesFilters(unseen, f('viewed:yes')), false);
  assert.equal(passesFilters(unseen, f('vu:non')), true);
  assert.equal(passesFilters(m, f('viewed:no')), false);
  assert.equal(passesFilters(m, f('watched:2026-10-14')), true);
  assert.equal(passesFilters(m, f('watched:2026-10-01..2026-10-12')), false);
  assert.equal(passesFilters({ id: '1', handle: 'a', text: '' }, f('viewed:yes')), false);
});

import { computeYtStats, fmtHours } from '../src/lib/ytstats.js';
test('statistiques YouTube : visionnages, temps estimé, chaînes, à regarder', () => {
  const NOWMS = new Date(2026, 9, 14, 15).getTime();
  const mk = (id, ch, sec, watched, extra = {}) => ({ ...toItem({ videoId: id, title: 'T ' + id, channel: ch, durationSec: sec }, extra.pl ? { id: extra.pl, title: extra.pl } : null), watched, progress: extra.pct || 0 });
  const items = [mk('a', 'C1', 600, ['2026-10-14', '2026-10-13']), mk('b', 'C1', 1200, ['2026-10-14'], { pct: 50 }), mk('c', 'C2', 3600, ['2026-08-01']), mk('d', 'C2', 300, [], { pl: 'WL' }), { id: '1', handle: 'x', text: 'tweet' }];
  const st = computeYtStats(items, { now: NOWMS, rangeDays: 30 });
  assert.equal(st.kpi.videos, 4);
  assert.equal(st.kpi.views, 3); // c est hors période
  assert.equal(st.kpi.seen, 2);
  assert.equal(st.kpi.hours, 600 * 2 + 600); // a ×2 entier, b à 50 %
  assert.equal(st.kpi.wlBacklog, 1);
  assert.equal(st.kpi.backlogSec, 300);
  assert.equal(st.channels[0].handle, 'c1');
  assert.equal(st.channels[0].n, 3);
  assert.equal(st.series.points.at(-1).n, 2);
  assert.equal(st.rewatched[0].id, 'yt:a');
  assert.equal(computeYtStats(items, { now: NOWMS }).kpi.views, 4);
  assert.equal(fmtHours(3900), '1 h 05');
});
