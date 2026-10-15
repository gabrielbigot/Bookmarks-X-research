// Lecteur des réponses « youtubei/v1/browse » de YouTube (playlists, listes de playlists) -> vidéos normalisées.
// Le format change souvent : on gère l'ancien (playlistVideoRenderer) ET le nouveau (lockupViewModel), on parcourt
// le JSON en profondeur au lieu de suivre un chemin fixe, et on compte ce qu'on n'a pas su lire (alerte « format changé »).

export const txt = (x) => {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x.simpleText === 'string') return x.simpleText;
  if (Array.isArray(x.runs)) return x.runs.map((r) => r.text ?? '').join('');
  if (typeof x.content === 'string') return x.content;
  return '';
};

export function parseDuration(s) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec((s || '').trim());
  return m ? (m[1] ? +m[1] * 3600 : 0) + +m[2] * 60 + +m[3] : 0;
}
const DURATION_RE = /^\d{1,2}(?::\d{2}){1,2}$/;
export const fmtDuration = (sec) => { if (!sec) return ''; const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0'); };

// « 1,2 M de vues », « 12 k vues », « 3.4M views », « 1 234 vues » -> nombre
export function parseViews(s) {
  const m = /([\d\s .,]+)\s*(md|mrd|b|m|k)?\b/i.exec((s || '').replace(/ | /g, ' '));
  if (!m) return 0;
  let n = m[1].trim();
  if (!n) return 0;
  const suffix = (m[2] || '').toLowerCase();
  if (suffix) n = n.replace(/\s/g, '').replace(',', '.'); else n = n.replace(/[\s.,]/g, '');
  const v = parseFloat(n);
  if (Number.isNaN(v)) return 0;
  return Math.round(v * ({ k: 1e3, m: 1e6, md: 1e9, mrd: 1e9, b: 1e9 }[suffix] || 1));
}

const UNAVAILABLE_RE = /^\[(?:private|deleted|unavailable|vid[ée]o (?:priv[ée]e|supprim[ée]e|non disponible|indisponible)|.*(?:private|deleted|priv[ée]e|supprim[ée]e).*)\]/i;
const slug = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Parcours en profondeur (itératif, borné). visit(node) -> true pour ne PAS descendre dans ce nœud.
function walk(root, visit, cap = 400_000) {
  const stack = [root];
  let seen = 0;
  while (stack.length && seen++ < cap) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    if (!Array.isArray(n) && visit(n)) continue;
    const vals = Array.isArray(n) ? n : Object.values(n);
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] && typeof vals[i] === 'object') stack.push(vals[i]);
  }
}

function deepStrings(obj, limit = 400) {
  const out = [];
  walk(obj, (n) => {
    for (const [k, v] of Object.entries(n)) if (typeof v === 'string' && out.length < limit && /^(text|content|simpleText|label|title)$/.test(k)) out.push(v);
    return false;
  }, 5000);
  return out;
}
function deepFindString(obj, key, test = () => true) {
  let found = '';
  walk(obj, (n) => { if (!found && typeof n[key] === 'string' && test(n[key])) found = n[key]; return !!found; }, 5000);
  return found;
}

const handleOf = (path) => (typeof path === 'string' && path.startsWith('/@') ? decodeURIComponent(path.slice(2).split(/[/?]/)[0]) : '');

// -------- ancien format : playlistVideoRenderer --------
function fromPlaylistVideoRenderer(r) {
  if (!r.videoId) return null;
  const by = r.shortBylineText || r.longBylineText;
  const ep = by?.runs?.[0]?.navigationEndpoint?.browseEndpoint;
  const info = (r.videoInfo?.runs || []).map((x) => x.text).filter((t) => t && t.trim() && !/^[•·]$/.test(t.trim()));
  const title = txt(r.title);
  const durationText = txt(r.lengthText);
  return {
    videoId: r.videoId, title, channel: txt(by), handle: handleOf(ep?.canonicalBaseUrl), channelId: ep?.browseId || '',
    durationText, durationSec: Number(r.lengthSeconds) || parseDuration(durationText),
    thumb: r.thumbnail?.thumbnails?.at(-1)?.url || '', views: info.find((t) => /vues|views|visionnages/i.test(t)) || '',
    published: info.find((t) => /il y a|ago|hier|yesterday|\d{4}/i.test(t) && !/vues|views/i.test(t)) || '',
    pos: parseInt(txt(r.index), 10) || 0, unavailable: r.isPlayable === false || UNAVAILABLE_RE.test(title),
  };
}

// -------- historique : videoRenderer (+ progression, extrait de description) --------
function fromVideoRenderer(r) {
  if (!r.videoId) return null;
  const by = r.ownerText || r.longBylineText || r.shortBylineText;
  const ep = by?.runs?.[0]?.navigationEndpoint?.browseEndpoint;
  const title = txt(r.title);
  const durationText = txt(r.lengthText) || (r.thumbnailOverlays || []).map((o) => txt(o.thumbnailOverlayTimeStatusRenderer?.text)).find(Boolean) || '';
  const progress = (r.thumbnailOverlays || []).map((o) => o.thumbnailOverlayResumePlaybackRenderer?.percentDurationWatched).find((x) => typeof x === 'number') ?? 0;
  const desc = txt(r.descriptionSnippet) || (r.detailedMetadataSnippets || []).map((x) => txt(x.snippetText)).find(Boolean) || '';
  return {
    videoId: r.videoId, title, channel: txt(by), handle: handleOf(ep?.canonicalBaseUrl), channelId: ep?.browseId || '',
    durationText, durationSec: parseDuration(durationText), thumb: r.thumbnail?.thumbnails?.at(-1)?.url || '',
    views: txt(r.viewCountText) || txt(r.shortViewCountText), published: txt(r.publishedTimeText), pos: 0, progress, desc: desc.slice(0, 300),
    unavailable: UNAVAILABLE_RE.test(title),
  };
}
function fromShortsLockup(l) {
  const videoId = l.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId || l.entityId?.replace(/^shorts-shelf-item-/, '') || '';
  if (!videoId) return null;
  const title = txt(l.overlayMetadata?.primaryText);
  return { videoId, title, channel: '', handle: '', channelId: '', durationText: '', durationSec: 0, thumb: l.thumbnail?.sources?.at(-1)?.url || '', views: txt(l.overlayMetadata?.secondaryText), published: '', pos: 0, progress: 0, desc: '', short: true, unavailable: false };
}

// -------- nouveau format : lockupViewModel --------
function lockupParts(l) {
  const rows = l.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
  return rows.flatMap((row) => (row.metadataParts || []).map((p) => txt(p.text))).filter(Boolean);
}
function fromLockupVideo(l) {
  const videoId = l.contentId;
  if (!videoId) return null;
  const meta = l.metadata?.lockupMetadataViewModel;
  const title = txt(meta?.title);
  const parts = lockupParts(l);
  const views = parts.find((t) => /vues|views|visionnages/i.test(t)) || '';
  const published = parts.find((t) => t !== views && /il y a|ago|hier|yesterday|\d{4}/i.test(t)) || '';
  const channel = parts.find((t) => t !== views && t !== published) || '';
  const durationText = deepStrings(l.contentImage || l).find((s) => DURATION_RE.test(s.trim()))?.trim() || '';
  const sources = l.contentImage?.thumbnailViewModel?.image?.sources;
  return {
    videoId, title, channel, handle: handleOf(deepFindString(l, 'canonicalBaseUrl', (s) => s.startsWith('/'))), channelId: deepFindString(l, 'browseId', (s) => /^UC/.test(s)),
    durationText, durationSec: parseDuration(durationText), thumb: sources?.at(-1)?.url || '', views, published, pos: 0,
    unavailable: UNAVAILABLE_RE.test(title),
  };
}
const countOf = (s) => { const m = /(\d[\d\s.,  ]*)/.exec(s || ''); return m ? parseInt(m[1].replace(/\D/g, ''), 10) || 0 : 0; };

// opts.history : lit aussi les videoRenderer / shorts, en retenant l'en-tête de jour de chaque section (`label`).
export function parseYoutube(json, opts = {}) {
  const videos = [], playlists = [], seenV = new Set(), seenP = new Set();
  let continuation = null, contViaRenderer = null, header = null, unparsed = 0;
  const visitor = (label) => (n) => {
    if (opts.history && n.itemSectionRenderer) { // une section = un jour ; on lit ses vidéos avec l'étiquette du jour
      const h = n.itemSectionRenderer.header;
      const lab = txt(h?.itemSectionHeaderRenderer?.title) || txt(h?.richListHeaderRenderer?.title) || deepStrings(h || {}, 4)[0] || label;
      walk(n.itemSectionRenderer.contents, visitor(lab));
      return true;
    }
    if (opts.history && n.videoRenderer) {
      const v = fromVideoRenderer(n.videoRenderer);
      if (v) { const k = v.videoId + '|' + (label || ''); if (!seenV.has(k)) { seenV.add(k); videos.push({ ...v, label: label || '' }); } } else unparsed++;
      return true;
    }
    if (opts.history && n.shortsLockupViewModel) {
      const v = fromShortsLockup(n.shortsLockupViewModel);
      if (v) { const k = v.videoId + '|' + (label || ''); if (!seenV.has(k)) { seenV.add(k); videos.push({ ...v, label: label || '' }); } } else unparsed++;
      return true;
    }
    if (n.playlistVideoRenderer) {
      const v = fromPlaylistVideoRenderer(n.playlistVideoRenderer);
      if (v) { if (!seenV.has(v.videoId)) { seenV.add(v.videoId); videos.push(v); } } else unparsed++;
      return true;
    }
    if (n.lockupViewModel) {
      const l = n.lockupViewModel, type = l.contentType || '';
      if (/VIDEO/.test(type)) {
        const v = fromLockupVideo(l);
        if (v) { const k = opts.history ? v.videoId + '|' + (label || '') : v.videoId; if (!seenV.has(k)) { seenV.add(k); videos.push(opts.history ? { ...v, label: label || '' } : v); } } else unparsed++;
      } else if (/PLAYLIST/.test(type) && l.contentId) {
        if (!seenP.has(l.contentId)) {
          seenP.add(l.contentId);
          const count = deepStrings(l).map(countOf).find((c) => c > 0) || 0;
          playlists.push({ id: l.contentId, title: txt(l.metadata?.lockupMetadataViewModel?.title), count });
        }
      }
      return true;
    }
    const gp = n.gridPlaylistRenderer || n.playlistRenderer;
    if (gp?.playlistId) {
      if (!seenP.has(gp.playlistId)) { seenP.add(gp.playlistId); playlists.push({ id: gp.playlistId, title: txt(gp.title), count: countOf(txt(gp.videoCountText) || txt(gp.videoCountShortText) || gp.videoCount) }); }
      return true;
    }
    if (n.playlistHeaderRenderer) {
      const h = n.playlistHeaderRenderer;
      header = { id: h.playlistId || '', title: txt(h.title), count: countOf(txt(h.numVideosText)) };
    } else if (n.pageHeaderRenderer && typeof n.pageHeaderRenderer.pageTitle === 'string' && !header) {
      header = { id: '', title: n.pageHeaderRenderer.pageTitle, count: 0 };
    }
    // jeton de pagination : celui de l'élément de fin de liste en priorité (menus de tri exclus)
    if (n.continuationItemRenderer) {
      const t = n.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || deepFindString(n.continuationItemRenderer, 'token');
      if (t) contViaRenderer = t;
      return true;
    }
    if (n.continuationItemViewModel) {
      const t = deepFindString(n.continuationItemViewModel, 'token');
      if (t) contViaRenderer = contViaRenderer || t;
      return true;
    }
    return false;
  };
  walk(json, visitor(null));
  continuation = contViaRenderer;
  return { videos, playlists, continuation, header, unparsed };
}

// -------- historique : les vidéos sont groupées par jour (« Aujourd'hui », « Hier », « lundi », « 12 octobre ») --------
const MONTHS = { janvier: 1, janv: 1, fevrier: 2, fevr: 2, mars: 3, avril: 4, avr: 4, mai: 5, juin: 6, juillet: 7, juil: 7, aout: 8, septembre: 9, sept: 9, octobre: 10, oct: 10, novembre: 11, nov: 11, decembre: 12, dec: 12,
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, october: 10, november: 11, december: 12 };
const WEEKDAYS = { dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6, sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const noAccent = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const pad = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// -> 'AAAA-MM-JJ' ou null (langue non reconnue). `now` injectable pour les tests.
export function parseHistoryHeader(title, now = new Date()) {
  const t = noAccent((title || '').replace(/\u202f|\u00a0/g, ' ').trim()).replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const shift = (n) => dayStr(new Date(base.getFullYear(), base.getMonth(), base.getDate() - n, 12));
  if (/^(aujourd['’ ]?hui|today)$/.test(t)) return shift(0);
  if (/^(hier|yesterday)$/.test(t)) return shift(1);
  if (t in WEEKDAYS) { const back = (base.getDay() - WEEKDAYS[t] + 7) % 7; return shift(back === 0 ? 7 : back); } // le jour même s'affiche « Aujourd'hui » : un nom de jour = la semaine passée
  // « 12 octobre », « 12 oct 2025 », « oct 12 », « october 12 2025 »
  let m = /^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/.exec(t) || (() => { const x = /^([a-z]+) (\d{1,2})(?: (\d{4}))?$/.exec(t); return x ? [x[0], x[2], x[1], x[3]] : null; })();
  if (!m || !(m[2] in MONTHS)) return null;
  const day = +m[1], month = MONTHS[m[2]];
  let year = m[3] ? +m[3] : base.getFullYear();
  if (!m[3] && new Date(year, month - 1, day, 12) > base) year--; // sans année : la plus récente date passée
  return `${year}-${pad(month)}-${pad(day)}`;
}

// -------- éléments stockés --------
export const ytId = (videoId) => 'yt:' + videoId;
export const isVideoItem = (t) => t.kind === 'video' || (typeof t.id === 'string' && t.id.startsWith('yt:'));

export function toItem(v, playlist, now = Date.now()) {
  return {
    id: ytId(v.videoId), kind: 'video', videoId: v.videoId, text: v.title || '', name: v.channel || '', handle: v.handle || slug(v.channel) || 'youtube',
    channelId: v.channelId || '', url: `https://www.youtube.com/watch?v=${v.videoId}`, thumb: v.thumb || '', durationText: v.durationText || fmtDuration(v.durationSec),
    durationSec: v.durationSec || 0, viewsText: v.views || '', publishedText: v.published || '', unavailable: !!v.unavailable,
    playlists: playlist?.id ? [{ id: playlist.id, title: playlist.title || '', pos: v.pos || 0 }] : [],
    links: [], media: [], stats: { views: parseViews(v.views) }, lang: '', createdAt: null,
    sortIndex: String(1_000_000 - (v.pos || 0)), // sous tous les tweets dans « récents » ; ordre de la playlist entre vidéos
    addedAt: now,
  };
}

// Vidéo vue (historique). `day` = 'AAAA-MM-JJ' ou null si l'en-tête de jour n'a pas été reconnu.
export function toHistoryItem(v, day, now = Date.now()) {
  const it = toItem(v, null, now);
  const ms = day ? Date.parse(day + 'T12:00:00Z') : 0;
  return { ...it, watched: day ? [day] : [], lastWatched: day || '', progress: v.progress || 0, desc: v.desc || '', sortIndex: ms ? String(Math.floor(ms / 1000)) : it.sortIndex };
}

// Fusionne une vidéo déjà connue avec une nouvelle capture : appartenance aux playlists = union ; champs vides non écrasés.
export function mergeVideo(old, neu) {
  if (!old) return neu;
  const pl = new Map((old.playlists || []).map((p) => [p.id, p]));
  for (const p of neu.playlists || []) pl.set(p.id, { ...pl.get(p.id), ...p, title: p.title || pl.get(p.id)?.title || '' });
  const out = { ...old };
  for (const [k, v] of Object.entries(neu)) if (v !== '' && v != null && !(Array.isArray(v) && !v.length)) out[k] = v;
  out.playlists = [...pl.values()];
  const w = [...new Set([...(old.watched || []), ...(neu.watched || [])])].sort();
  if (w.length) { out.watched = w; out.lastWatched = w[w.length - 1]; }
  out.progress = Math.max(old.progress || 0, neu.progress || 0);
  if (!neu.desc && old.desc) out.desc = old.desc;
  if (BigInt(old.sortIndex || 0) > BigInt(neu.sortIndex || 0)) out.sortIndex = old.sortIndex;
  out.addedAt = old.addedAt ?? neu.addedAt;
  return out;
}

// Texte indexé (BM25 + embedding) d'une vidéo.
export function videoText(t) {
  const pls = (t.playlists || []).map((p) => p.title).filter(Boolean);
  return `${t.text}\nChaîne : ${t.name}${pls.length ? `\nPlaylists : ${pls.join(', ')}` : ''}${t.desc ? `\n${t.desc}` : ''}`;
}

// Une vidéo est « écartée » (off) si elle n'appartient qu'à des playlists que tu as décochées et n'a pas été vue (l'historique est
// indépendant des playlists). Rien n'est supprimé : recocher la playlist la fait revenir.
export function videoOff(t, excluded) {
  if (!excluded || !excluded.size) return false;
  const pls = t.playlists || [];
  if (!pls.length || (t.watched || []).length) return false;
  return pls.every((p) => excluded.has(p.id));
}
