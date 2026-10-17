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

import { findTranscriptParams, parseTranscript, captionTracks, pickTrack, parseJson3, parseTimedTextXml, chunkSegments, sampleChunks, bestChunk, chunksText, fmtTime } from '../src/lib/transcript.js';
test('transcriptions : jeton, segments, json3, passages, extrait', () => {
  const next = { engagementPanels: [{ x: { content: { continuationItemRenderer: { continuationEndpoint: { getTranscriptEndpoint: { params: 'PARAMS1' } } } } } }] };
  assert.equal(findTranscriptParams(next), 'PARAMS1');
  assert.equal(findTranscriptParams({ a: 1 }), null);
  const tr = { actions: [{ updateEngagementPanelAction: { content: { transcriptRenderer: { content: { transcriptSearchPanelRenderer: { body: { transcriptSegmentListRenderer: { initialSegments: [
    { transcriptSegmentRenderer: { startMs: '0', snippet: { runs: [{ text: 'Bonjour à tous' }] } } },
    { transcriptSegmentRenderer: { startMs: '4000', snippet: { runs: [{ text: '[Musique]' }] } } },
    { transcriptSegmentRenderer: { startMs: '65000', snippet: { runs: [{ text: 'le  cerveau\n apprend' }] } } },
    { transcriptSectionHeaderRenderer: { x: 1 } }] } } } } } } } }] };
  const segs = parseTranscript(tr);
  assert.deepEqual(segs, [{ t: 0, text: 'Bonjour à tous' }, { t: 4, text: '[Musique]' }, { t: 65, text: 'le cerveau apprend' }]);
  const chunks = chunkSegments(segs, { size: 10 });
  assert.deepEqual(chunks.map((c) => c.t), [0, 65]); // « [Musique] » écarté
  assert.equal(chunksText(chunks), 'Bonjour à tous le cerveau apprend ');
  assert.deepEqual(parseJson3({ events: [{ tStartMs: 1500, segs: [{ utf8: 'a ' }, { utf8: 'b' }] }, { tStartMs: 3000 }, { tStartMs: 9000, segs: [{ utf8: '\n' }] }] }), [{ t: 2, text: 'a b' }]);
  const pl = { captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'u1', languageCode: 'de', kind: 'asr' }, { baseUrl: 'u2', languageCode: 'en' }, { baseUrl: 'u3', languageCode: 'fr', kind: 'asr' }] } } };
  assert.equal(captionTracks(pl).length, 3);
  assert.equal(pickTrack(captionTracks(pl)).url, 'u3'); // fr > en, même automatique
  assert.equal(pickTrack([]), null);
  const many = Array.from({ length: 100 }, (_, i) => ({ t: i, text: 'x' + i }));
  const s = sampleChunks(many, 10);
  assert.equal(s.length, 10); assert.equal(s[0].t, 0); assert.ok(s[9].t >= 90);
  assert.equal(sampleChunks(many.slice(0, 5), 10).length, 5);
  assert.equal(bestChunk(chunks, ['cerveau'], (x) => x.toLowerCase()).t, 65);
  assert.equal(bestChunk(chunks, ['zzz']), null);
  assert.equal(fmtTime(65), '1:05'); assert.equal(fmtTime(3725), '1:02:05');
});

test('index : mots de la transcription et meilleur passage vectoriel', () => {
  const dim = 4;
  const idx = new Index(dim);
  const vid = (id, title, transcript) => ({ ...toItem({ videoId: id, title }, null), transcript });
  const unit = (...v) => Float32Array.from(v);
  idx.add([vid('a', 'Vlog numéro 12', 'on parle de la photosynthèse des plantes'), vid('b', 'Autre vidéo', '')], new Map([['yt:a', unit(1, 0, 0, 0)], ['yt:b', unit(0, 1, 0, 0)]]));
  assert.equal(idx.bm25('photosynthèse')[0][0], 0, 'les mots de la transcription sont indexés');
  idx.setChunkVecs('yt:a', Float32Array.from([0, 0, 1, 0, 0, 0, 0, 1]), 2);
  const r = idx.vector(unit(0, 0, 0, 1));
  assert.equal(r[0][0], 0, 'le passage 2 de la vidéo a répond à la requête');
  assert.ok(r[0][1] > 0.99);
  assert.equal(idx.setChunkVecs('yt:a', new Float32Array(3), 1), false);
  assert.equal(passesFilters({ ...vid('c', 'x'), trState: 'ok' }, parseQuery('has:transcript').filters), true);
  assert.equal(passesFilters(vid('c', 'x'), parseQuery('has:transcript').filters), false);
});

test('transcriptions : XML timedtext et ancien format de cues', () => {
  assert.deepEqual(parseTimedTextXml('<?xml?><transcript><text start="1.5" dur="2">Salut &amp; bienvenue &#39;ici&#39;</text><text start="9">  </text><text start="12.4">suite</text></transcript>'),
    [{ t: 2, text: "Salut & bienvenue 'ici'" }, { t: 12, text: 'suite' }]);
  assert.deepEqual(parseTimedTextXml('<timedtext><body><p t="2500" d="1000"><s>a</s><s> b</s></p></body></timedtext>'), [{ t: 3, text: 'a b' }]);
  assert.deepEqual(parseTimedTextXml(''), []);
  assert.deepEqual(parseTranscript({ cueGroups: [{ transcriptCueGroupRenderer: { cues: [{ transcriptCueRenderer: { cue: { simpleText: 'ancien' }, startOffsetMs: '3000' } }] } }] }), [{ t: 3, text: 'ancien' }]);
});

import { learnTemplate, deriveParams } from '../src/lib/transcript.js';
test('transcriptions : jeton get_transcript réécrit pour une autre vidéo', () => {
  const mk = (id, extra = '') => btoa('\n\x0b' + id + '\x12\x0cCgNhc3ISAmVuGAEqMmVuZ2FnZW1lbnQ=' + extra);
  const std = mk('dQw4w9WgXcQ');
  const tpl = learnTemplate(std, 'dQw4w9WgXcQ');
  assert.ok(tpl);
  assert.equal(deriveParams(tpl, 'abcdefghijk'), mk('abcdefghijk'));
  assert.equal(deriveParams(tpl, 'court'), null, 'longueur différente : pas de réécriture');
  // variante encodée pour une URL, avec « = » en pourcentage et alphabet url-safe
  const enc = encodeURIComponent(std.replace(/\+/g, '-').replace(/\//g, '_'));
  const t2 = learnTemplate(enc, 'dQw4w9WgXcQ');
  assert.equal(deriveParams(t2, 'abcdefghijk'), encodeURIComponent(mk('abcdefghijk').replace(/\+/g, '-').replace(/\//g, '_')));
  assert.equal(learnTemplate(std, 'zzzzzzzzzzz'), null, 'identifiant absent : pas de modèle');
  assert.equal(learnTemplate('pas du base64 !!', 'dQw4w9WgXcQ'), null);
});

import { playlistFate } from '../src/lib/youtube.js';
test('suppression d’une playlist : qui est supprimé, qui est seulement détaché', () => {
  const v = (pls, watched = []) => ({ id: 'yt:x', playlists: pls.map((id) => ({ id })), watched });
  assert.equal(playlistFate(v(['A']), 'A'), 'delete', 'propre à la playlist, jamais vue');
  assert.equal(playlistFate(v(['A', 'B']), 'A'), 'detach', 'aussi dans une autre playlist');
  assert.equal(playlistFate(v(['A'], ['2026-10-01']), 'A'), 'detach', 'vue dans l’historique : conservée');
  assert.equal(playlistFate(v(['A'], ['2026-10-01']), 'A', true), 'delete', '… sauf si on supprime aussi l’historique');
  assert.equal(playlistFate(v(['A', 'B'], ['2026-10-01']), 'A', true), 'detach', 'dans une autre playlist : jamais supprimée');
  assert.equal(playlistFate(v(['B']), 'A'), 'skip');
  assert.equal(playlistFate({ id: 'yt:y' }, 'A'), 'skip');
});

import { transcriptOrder } from '../src/lib/youtube.js';
test('transcriptions : les vidéos les plus récentes d’abord, jusqu’à la plus ancienne', () => {
  const v = (id, extra = {}) => ({ id, playlists: [], lastWatched: '', addedAt: 0, ...extra });
  const vids = [
    v('old', { playlists: [{ pos: 900 }], addedAt: 5 }),                       // en bas d'une grande playlist
    v('new', { playlists: [{ pos: 0 }], addedAt: 1 }),                         // tout en haut : ajoutée en dernier
    v('mid', { playlists: [{ pos: 40 }, { pos: 3 }], addedAt: 2 }),            // plusieurs playlists : le meilleur rang compte
    v('w1', { lastWatched: '2026-10-15' }), v('w2', { lastWatched: '2026-10-01' }), // vues, sans playlist
    v('none'),                                                                  // ni playlist ni visionnage : en dernier
    v('p2', { playlists: [{ pos: 1 }] }),
  ];
  assert.deepEqual(transcriptOrder(vids), ['w1', 'new', 'w2', 'p2', 'mid', 'old', 'none']);
  // égalité de rang : la plus récemment vue puis la plus récemment capturée
  assert.deepEqual(transcriptOrder([v('a', { playlists: [{ pos: 0 }], addedAt: 1 }), v('b', { playlists: [{ pos: 0 }], addedAt: 9 })]), ['b', 'a']);
});

import { syncSummary } from '../src/lib/youtube.js';
test('fin de synchro : playlists incomplètes nommées, avec lu / annoncé', () => {
  assert.equal(syncSummary({ total: 120, lists: 3, incomplete: 0 }), '120 vidéos dans 3 playlists');
  const s = syncSummary({ total: 220, lists: 4, incomplete: 2, problems: [{ title: '3', count: 100, expected: 549, why: 'YouTube n’a pas renvoyé la suite' }, { title: 'À regarder plus tard 2', count: 0, expected: 4995, why: 'HTTP 400' }] });
  assert.match(s, /\(2 incomplète\(s\)\) — à reprendre : 3 \(100\/549 : YouTube n’a pas renvoyé la suite\) ; À regarder plus tard 2 \(0\/4995 : HTTP 400\)/);
});

import { orderLists, incrementalStop } from '../src/lib/youtube.js';
test('synchro : playlists incomplètes d’abord, mise à jour incrémentale bornée', () => {
  const lists = [{ id: 'WL' }, { id: 'LL' }, { id: 'A', count: 40 }, { id: 'B', count: 549 }, { id: 'C', count: 4995 }, { id: 'D', count: 10 }];
  const counts = { A: 40, B: 100, C: 100, D: 8 };
  assert.deepEqual(orderLists(lists, counts).map((l) => l.id), ['B', 'C', 'WL', 'LL', 'A', 'D']); // D : 8/10, écart ≤ 5 = complète
  const st = {};
  assert.equal(incrementalStop(30, st), false);   // page riche en nouveautés : on continue
  assert.equal(incrementalStop(1, st), false);    // presque rien (1re fois)
  assert.equal(incrementalStop(2, st), true);     // presque rien 2 fois de suite : stop
  assert.equal(incrementalStop(0, {}), true);     // rien : stop
  const st2 = {}; let stop = false, n = 0;
  while (!stop) { stop = incrementalStop(50, st2); n++; }
  assert.equal(n, 6, 'borné à 6 pages (600 vidéos) même si chaque page apporte des nouveautés');
  assert.equal(incrementalStop(null, {}), false); // accusé perdu : on continue (jusqu'à la borne)
});

import { findAnyContinuation } from '../src/lib/youtube.js';
test('pagination : ancien format (jeton porté par la liste) et jeton de dernier recours', () => {
  const old = { contents: { playlistVideoListRenderer: { contents: [pvr('aaaaaaaaaaa', 'Une')], continuations: [{ nextContinuationData: { continuation: 'TOKEN_OLD_FORMAT_AAAAAAAAAAAAAAA' } }] } } };
  assert.equal(parseYoutube(old).continuation, 'TOKEN_OLD_FORMAT_AAAAAAAAAAAAAAA');
  const oldCont = { continuationContents: { playlistVideoListContinuation: { contents: [pvr('bbbbbbbbbbb', 'Deux')], continuations: [{ nextContinuationData: { continuation: 'TOKEN_OLD_CONT_BBBBBBBBBBBBBBBBBB' } }] } } };
  assert.equal(parseYoutube(oldCont).continuation, 'TOKEN_OLD_CONT_BBBBBBBBBBBBBBBBBB');
  assert.equal(parseYoutube({ a: [pvr('ccccccccccc', 'Trois'), contItem('TOKEN_NEW_FORMAT_CCCCCCCCCCCCCCCCCCC')] }).continuation, 'TOKEN_NEW_FORMAT_CCCCCCCCCCCCCCCCCCC');
  // dernier recours : un jeton que le lecteur normal ne reconnaît pas
  const odd = { x: { weird: { continuationCommand: { token: 'TOKEN_SOMEWHERE_ELSE_DDDDDDDDDDDDDD' } } } };
  assert.equal(parseYoutube(odd).continuation, null);
  assert.equal(findAnyContinuation(odd), 'TOKEN_SOMEWHERE_ELSE_DDDDDDDDDDDDDD');
  assert.equal(findAnyContinuation({ a: 1 }), null);
});

import { jsonShape } from '../src/lib/youtube.js';
test('diagnostic : la forme d’une réponse ne contient aucun texte, seulement des clés et des tailles', () => {
  const json = { responseContext: { x: 1 }, contents: { playlistVideoListRenderer: { contents: [pvr('aaaaaaaaaaa', 'Secret titre'), contItem('TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ')], isEditable: true } }, header: { title: 'Mon titre privé' } };
  const shape = jsonShape(json);
  assert.ok(!/Secret|privé|aaaaaaaaaaa/.test(shape), shape);
  assert.ok(/playlistVideoListRenderer/.test(shape) && /continuationItemRenderer/.test(shape) && /token:str\(32\)/.test(shape), shape);
  assert.ok(!/responseContext/.test(shape));
  assert.ok(jsonShape({ a: 'x'.repeat(10000) }, { max: 100 }).length <= 101);
});

import { allContinuations } from '../src/lib/youtube.js';
test('pagination : le jeton de la liste de vidéos prime sur un autre jeton de la page', () => {
  const list = { playlistVideoListRenderer: { contents: [pvr('aaaaaaaaaaa', 'Une'), contItem('TOKEN_THE_REAL_LIST_AAAAAAAAAAAAAAAA')] } };
  const decoyAfter = { secondaryContents: { sidebar: [contItem('TOKEN_DECOY_AFTER_THE_LIST_BBBBBBBBBB')] } };
  const decoyBefore = { header: { menu: [contItem('TOKEN_DECOY_BEFORE_THE_LIST_CCCCCCCCC')] } };
  assert.equal(parseYoutube({ a: decoyBefore, b: { contents: list }, c: decoyAfter }).continuation, 'TOKEN_THE_REAL_LIST_AAAAAAAAAAAAAAAA');
  // page de suite : les éléments ajoutés finissent par le jeton suivant
  const cont = { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [pvr('bbbbbbbbbbb', 'Deux'), contItem('TOKEN_NEXT_PAGE_DDDDDDDDDDDDDDDDDDDDD')] } }], other: contItem('TOKEN_OTHER_EEEEEEEEEEEEEEEEEEEEEEE') };
  assert.equal(parseYoutube(cont).continuation, 'TOKEN_NEXT_PAGE_DDDDDDDDDDDDDDDDDDDDD');
  // sans liste reconnue : comportement d'avant (dernier jeton rencontré)
  assert.equal(parseYoutube({ a: [pvr('ccccccccccc', 'Trois'), contItem('TOKEN_ONLY_ONE_FFFFFFFFFFFFFFFFFFFFFF')] }).continuation, 'TOKEN_ONLY_ONE_FFFFFFFFFFFFFFFFFFFFFF');
  assert.deepEqual(allContinuations({ a: decoyBefore, b: { contents: list }, c: decoyAfter }), ['TOKEN_DECOY_BEFORE_THE_LIST_CCCCCCCCC', 'TOKEN_THE_REAL_LIST_AAAAAAAAAAAAAAAA', 'TOKEN_DECOY_AFTER_THE_LIST_BBBBBBBBBB']);
});

import { parsePublished, videoPubMs } from '../src/lib/ytdate.js';
import { sortRows } from '../src/lib/search.js';
test('dates relatives des vidéos', () => {
  const ref = Date.UTC(2026, 9, 17, 12);
  assert.equal(parsePublished('il y a 18 heures', ref), ref - 18 * 3_600_000);
  assert.equal(parsePublished('il y a 1 j', ref), ref - 86_400_000);
  assert.equal(parsePublished('18 k vues • il y a 3 ans', ref) != null, true);
  assert.equal(parsePublished('Streamed 2 weeks ago', ref), ref - 14 * 86_400_000);
  assert.equal(parsePublished('Diffusé il y a 2 mois', ref) < ref - 55 * 86_400_000, true);
  assert.equal(new Date(parsePublished('12 janv. 2024', ref)).toISOString().slice(0, 10), '2024-01-12');
  assert.equal(parsePublished('', ref), null);
  assert.equal(videoPubMs({ publishedText: 'il y a 1 j', addedAt: ref }), ref - 86_400_000);
});
test('tri par date : publication et ajout, vidéos et tweets mélangés', () => {
  const X = 1288834974657n, snow = (ms) => ((BigInt(ms) - X) << 22n).toString();
  const base = Date.UTC(2026, 0, 1);
  const tw = [
    { id: 't1', createdAt: new Date(base).toISOString(), sortIndex: snow(base + 5 * 86_400_000) },
    { id: 'yt:a', publishedText: 'il y a 10 j', addedAt: base + 30 * 86_400_000, sortIndex: '999999' },
    { id: 'yt:b', publishedText: 'il y a 3 j', addedAt: base + 30 * 86_400_000, sortIndex: '999998' },
    { id: 'yt:c', publishedText: '', addedAt: base + 40 * 86_400_000, sortIndex: '1' },
  ];
  const rows = tw.map((_, i) => [i, 0]);
  const ids = (how) => sortRows(rows, tw, how).map((r) => tw[r[0]].id);
  assert.deepEqual(ids('newest'), ['yt:b', 'yt:a', 't1', 'yt:c']);
  assert.deepEqual(ids('oldest'), ['t1', 'yt:a', 'yt:b', 'yt:c']);
  assert.deepEqual(ids('addednew'), ['yt:c', 'yt:a', 'yt:b', 't1']);
  assert.deepEqual(ids('addedold'), ['t1', 'yt:b', 'yt:a', 'yt:c']);
});

import { findSortBody } from '../src/lib/youtube.js';
test('menu de tri : jeton « Date d\'ajout (plus récentes) »', () => {
  const menu = (items) => ({ header: { playlistHeaderRenderer: {} }, sortFilterSubMenuRenderer: { subMenuItems: items } });
  const item = (title, token) => ({ title, serviceEndpoint: { continuationCommand: { token } } });
  const j = menu([item('Manuel', 'M'.repeat(30)), item('Date d’ajout (plus récentes)', 'A'.repeat(30)), item('Date d’ajout (plus anciennes)', 'B'.repeat(30))]);
  assert.deepEqual(findSortBody(j, 'PL1'), { continuation: 'A'.repeat(30) });
  const en = menu([item('Date added (newest)', 'N'.repeat(30))]);
  assert.deepEqual(findSortBody(en, 'PL1'), { continuation: 'N'.repeat(30) });
  const old = menu([{ title: 'Date d\'ajout (plus récentes)', navigationEndpoint: { browseEndpoint: { browseId: 'VLPL1', params: 'sp=xyz' } } }]);
  assert.deepEqual(findSortBody(old, 'PL1'), { browseId: 'VLPL1', params: 'sp=xyz' });
  assert.equal(findSortBody(menu([item('Manuel', 'M'.repeat(30))]), 'PL1'), null);
  assert.equal(findSortBody({}, 'PL1'), null);
});
test('ordre d\'ajout : une vidéo lue dans la liste triée garde sa date estimée', () => {
  const a = toItem({ videoId: 'a', title: 'A', addAt: 1000 }, { id: 'P' }, 5);
  assert.equal(a.addedAt, 1000);
  const old = toItem({ videoId: 'a', title: 'A' }, { id: 'P' }, 7);
  assert.equal(mergeVideo(old, a).addedAt, 1000);
  assert.equal(mergeVideo(a, toItem({ videoId: 'a', title: 'A' }, { id: 'P' }, 9)).addedAt, 1000);
});
