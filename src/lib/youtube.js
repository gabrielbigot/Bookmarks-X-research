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

export function parseYoutube(json) {
  const videos = [], playlists = [], seenV = new Set(), seenP = new Set();
  let continuation = null, contViaRenderer = null, header = null, unparsed = 0;
  walk(json, (n) => {
    if (n.playlistVideoRenderer) {
      const v = fromPlaylistVideoRenderer(n.playlistVideoRenderer);
      if (v) { if (!seenV.has(v.videoId)) { seenV.add(v.videoId); videos.push(v); } } else unparsed++;
      return true;
    }
    if (n.lockupViewModel) {
      const l = n.lockupViewModel, type = l.contentType || '';
      if (/VIDEO/.test(type)) {
        const v = fromLockupVideo(l);
        if (v) { if (!seenV.has(v.videoId)) { seenV.add(v.videoId); videos.push(v); } } else unparsed++;
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
  });
  continuation = contViaRenderer;
  return { videos, playlists, continuation, header, unparsed };
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

// Fusionne une vidéo déjà connue avec une nouvelle capture : appartenance aux playlists = union ; champs vides non écrasés.
export function mergeVideo(old, neu) {
  if (!old) return neu;
  const pl = new Map((old.playlists || []).map((p) => [p.id, p]));
  for (const p of neu.playlists || []) pl.set(p.id, { ...pl.get(p.id), ...p, title: p.title || pl.get(p.id)?.title || '' });
  const out = { ...old };
  for (const [k, v] of Object.entries(neu)) if (v !== '' && v != null && !(Array.isArray(v) && !v.length)) out[k] = v;
  out.playlists = [...pl.values()];
  out.addedAt = old.addedAt ?? neu.addedAt;
  return out;
}

// Texte indexé (BM25 + embedding) d'une vidéo.
export function videoText(t) {
  const pls = (t.playlists || []).map((p) => p.title).filter(Boolean);
  return `${t.text}\nChaîne : ${t.name}${pls.length ? `\nPlaylists : ${pls.join(', ')}` : ''}`;
}
