// Journal hebdomadaire : sujets de la semaine, dossiers de preuves, invites pour le modèle, coûts, blocs HTML.
// Fonctions pures (testées sans navigateur) ; la mise en page par pages et l'orchestration sont dans journal.js.
import { dayKey } from './time.js';
import { decodeEntities } from './text.js';
import { isVideoItem } from './youtube.js';
import { clusterCandidates, eventDays, rankMembers, groupKeys, linkKeys, handleKey, OFFICIAL_MIN } from './widgets.js';
import { parseJsonLoose } from './llm.js';
import { sampleChunks, fmtTime } from './transcript.js';

const DAY = 86_400_000;
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s) => decodeEntities(String(s || '')).replace(/\s+/g, ' ').trim();

// ---------- période ----------
export function weekWindow(now = Date.now(), days = 7) {
  const to = dayKey(now), from = dayKey(now - (days - 1) * DAY);
  const a = new Date(now - (days - 1) * DAY), b = new Date(now);
  const label = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()
    ? `du ${a.getDate()} au ${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`
    : `du ${a.getDate()} ${MONTHS[a.getMonth()]}${a.getFullYear() !== b.getFullYear() ? ' ' + a.getFullYear() : ''} au ${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
  // numéro de semaine ISO
  const d = new Date(Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const week = Math.ceil(((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY + 1) / 7);
  return { from, to, days, label, week, year: b.getFullYear(), prevFrom: dayKey(now - (2 * days - 1) * DAY), prevTo: dayKey(now - days * DAY) };
}
export const inWindow = (d, win) => d >= win.from && d <= win.to;
export const dayLabel = (k) => { const [y, m, d] = k.split('-').map(Number); return `${['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'][new Date(y, m - 1, d).getDay()]} ${d}`; };

// ---------- images, liens ----------
export function imagesOf(t) {
  const out = [];
  for (const m of t.media || []) if (m?.url) out.push({ url: m.url, alt: clean(m.alt), video: m.type === 'video' || m.type === 'animated_gif', handle: t.handle });
  const c = t.xcard || (t.cards || []).find((x) => x.image);
  if (c?.image) out.push({ url: c.image, alt: clean(c.title), video: false, handle: t.handle, card: true });
  if (isVideoItem(t) && t.thumb) out.push({ url: t.thumb, alt: clean(t.text), video: true, handle: t.handle });
  return out;
}
const EXT_SKIP = /^(x\.com|twitter\.com|t\.co|pic\.twitter\.com|mobile\.twitter\.com)$/;
export function externalLinks(t) {
  const out = [];
  for (const l of [...(t.links || []), ...(t.quoted?.links || [])]) {
    try { const u = new URL(l); if (!EXT_SKIP.test(u.hostname.replace(/^www\./, '').toLowerCase()) && u.pathname.replace(/\/$/, '')) out.push(u.href); } catch { /* lien illisible */ }
  }
  return out;
}
export const tweetUrl = (t) => t.url || `https://x.com/${t.handle}/status/${t.id}`;

// ---------- sujets ----------
// sections : [{ id, name, set: Set(ids) }] — chacune correspond à un détecteur. Un tweet n'apparaît que dans la première rubrique qui le retient.
// Retourne [{ id, section, rep, members, score, firstDay, lastDay, likes, images, links }] triés par importance.
export function buildSubjects(items, { sv, sections, vecs = null, primary = new Set(), official = {}, win, sim = 0.9, days = 7, minPub = '' }) {
  const taken = new Set(), out = [];
  for (const sec of sections) {
    const cand = [];
    for (const t of items) {
      if (isVideoItem(t) || t.off || taken.has(t.id) || !sec.set.has(t.id)) continue;
      if (minPub && t.createdAt && t.createdAt.slice(0, 10) < minPub) continue; // publié trop longtemps avant la période
      const ds = eventDays(t, sv);
      if (ds.some((d) => inWindow(d, win))) cand.push({ t, days: ds });
    }
    if (!cand.length) continue;
    cand.forEach((c) => taken.add(c.t.id));
    const { groups } = clusterCandidates(cand, { sim, days, vecs });
    for (const idx of groups) {
      const members = rankMembers(idx.map((k) => cand[k].t), { primary, official });
      const rep = members[0];
      const ds = idx.flatMap((k) => cand[k].days.filter((d) => inWindow(d, win))).sort();
      const likes = members.reduce((n, m) => n + (m.stats?.likes || 0), 0);
      const isPrim = primary.has(handleKey(rep.handle)), isOff = (official[rep.id] ?? -1) >= OFFICIAL_MIN;
      const score = 3 * Math.log2(1 + members.length) + Math.log10(1 + likes) + (isPrim ? 2 : 0) + (isOff ? 2 : 0);
      const seenImg = new Set(), images = [];
      for (const m of members) for (const im of imagesOf(m)) if (!seenImg.has(im.url) && images.length < 4) { seenImg.add(im.url); images.push(im); }
      const seenL = new Set(), links = [];
      for (const m of members) for (const l of externalLinks(m)) { const k = [...linkKeys({ links: [l] })][0] || l; if (!seenL.has(k) && links.length < 4) { seenL.add(k); links.push(l); } }
      out.push({ id: rep.id, section: sec.id, sectionName: sec.name, rep, members, score, firstDay: ds[0] || win.from, lastDay: ds.at(-1) || win.to, likes, images, links, official: isOff, primary: isPrim });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

// Répartition en grands sujets, articles et brèves (au plus `maxPerSection` grands sujets d'une même rubrique pour garder de la variété).
export function assignTiers(subjects, { leads = 4, articles = 14, briefs = 30, maxPerSection = 2 } = {}) {
  const lead = [], per = new Map();
  for (const s of subjects) {
    if (lead.length >= leads) break;
    if ((per.get(s.section) || 0) >= maxPerSection) continue;
    per.set(s.section, (per.get(s.section) || 0) + 1); lead.push(s);
  }
  const rest = subjects.filter((s) => !lead.includes(s));
  return { leads: lead, articles: rest.slice(0, articles), briefs: rest.slice(articles, articles + briefs) };
}

// ---------- statistiques de la semaine ----------
export function weekStats(items, { sv, sections, win }) {
  const byDay = new Map(), sectionDays = new Map(sections.map((s) => [s.id, new Map()]));
  const accounts = new Map(), accountsPrev = new Map(), words = new Map(), wordsPrev = new Map(), domains = new Map(), heat = new Map();
  let total = 0;
  for (const t of items) {
    if (isVideoItem(t) || t.off) continue;
    const ds = eventDays(t, sv);
    const cur = ds.some((d) => inWindow(d, win)), prev = ds.some((d) => d >= win.prevFrom && d <= win.prevTo);
    if (!cur && !prev) continue;
    const inSec = sections.filter((s) => s.set.has(t.id));
    if (!inSec.length) continue;
    const target = cur ? [accounts, words] : [accountsPrev, wordsPrev];
    target[0].set(t.handle, (target[0].get(t.handle) || 0) + 1);
    for (const w of groupKeys('word', t)) target[1].set(w, (target[1].get(w) || 0) + 1);
    if (cur) {
      total++;
      const ms = sv?.valid ? sv.at(t) : t.createdAt ? Date.parse(t.createdAt) : null; // heure d'enregistrement (carte de chaleur)
      if (ms != null && Number.isFinite(ms)) { const d = new Date(ms), k = dayKey(ms) + '|' + d.getHours(); heat.set(k, (heat.get(k) || 0) + 1); }
      for (const l of externalLinks(t)) { try { const h = new URL(l).hostname.replace(/^www\./, ''); domains.set(h, (domains.get(h) || 0) + 1); } catch { /* adresse illisible */ } }
      for (const d of ds) if (inWindow(d, win)) { byDay.set(d, (byDay.get(d) || 0) + 1); for (const s of inSec) { const m = sectionDays.get(s.id); m.set(d, (m.get(d) || 0) + 1); } }
    }
  }
  const dayKeys = [];
  for (let i = win.days - 1; i >= 0; i--) dayKeys.push(dayKey(Date.parse(win.to + 'T12:00:00') - i * DAY));
  const topAccounts = [...accounts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([handle, n]) => ({ handle, n, d: n - (accountsPrev.get(handle) || 0) }));
  const rising = [...words].filter(([, n]) => n >= 3).map(([w, n]) => ({ word: w, n, prev: wordsPrev.get(w) || 0 })).map((x) => ({ ...x, d: x.n - x.prev })).filter((x) => x.d > 0).sort((a, b) => b.d - a.d || b.n - a.n).slice(0, 10);
  return { total, dayKeys, byDay: dayKeys.map((k) => byDay.get(k) || 0), sectionSeries: sections.map((s) => ({ id: s.id, name: s.name, vals: dayKeys.map((k) => sectionDays.get(s.id).get(k) || 0) })), topAccounts, rising, domains: [...domains].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([host, n]) => ({ host, n })), heat: dayKeys.map((k) => Array.from({ length: 24 }, (_, h) => heat.get(k + '|' + h) || 0)) };
}

// Chiffres marquants d'un texte (encadré « En chiffres ») : [{ num, text }] — le texte est la phrase d'origine, sans renvois de sources.
const UNIT = '(?:%|milliards?|millions?|mille|dollars?|\\$|€|euros?|fois|Go|Mo|To|tokens?|jours?|mois|ans|heures?|minutes?|paramètres?|étoiles?|vues?|abonnés?|M\\b|B\\b|k\\b)';
export function numberFacts(paragraphs, max = 4) {
  const out = [], seen = new Set();
  const re = new RegExp('(\\d[\\d\\s\\u00a0\\u202f.,]*\\d|\\d)\\s?(' + UNIT + ')', 'i');
  for (const p of paragraphs) {
    for (const sent of splitSentences(String(p).replace(/\s*\[[TLWV][\d,TLWV\s]*\]/g, ''))) {
      const m = re.exec(sent);
      if (!m) continue;
      const num = clean(m[0]).replace(/\s+/g, ' ');
      if (/^\d{4}$/.test(m[1]) || seen.has(num)) continue; // une année seule n'est pas un chiffre marquant
      seen.add(num);
      out.push({ num, text: sent.length > 120 ? sent.slice(0, 117).replace(/\s+\S*$/, '') + '…' : sent, w: /%|milliard|million|\$|€|dollar|euro|fois/i.test(num) ? 2 : 1 });
    }
  }
  return out.sort((a, b) => b.w - a.w).slice(0, max).map(({ num, text }) => ({ num, text }));
}

// ---------- texte des pages liées ----------
export function extractPageText(html, { max = 6000 } = {}) {
  const s = String(html || '');
  const title = clean((s.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  const image = ((s.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) || [])[1]) || '';
  let body = (s.match(/<article[\s\S]*?<\/article>/i) || s.match(/<main[\s\S]*?<\/main>/i) || [s])[0];
  body = body.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)[\s\S]*?<\/\1>/gi, ' ');
  const parts = [];
  for (const m of body.matchAll(/<(p|h2|h3|li)[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = clean(m[2].replace(/<[^>]+>/g, ' '));
    if (t.length >= (m[1].toLowerCase() === 'li' ? 50 : 40)) parts.push(t);
  }
  let text = parts.join('\n'), cut = false;
  if (text.length > max) { text = text.slice(0, max); cut = true; }
  return { title, image, text, cut };
}

// ---------- dossier de preuves ----------
// pages : Map(url -> { title, text }) lues pour ce sujet. Retourne { sources, text }.
export function evidenceFor(subject, pages = new Map(), { maxTweets = 8, maxPages = 2, maxTweetChars = 700, maxPageChars = 5000, web = [], videos = [] } = {}) {
  const sources = [];
  const lines = [];
  subject.members.slice(0, maxTweets).forEach((t) => {
    const id = 'T' + (sources.filter((s) => s.kind === 'tweet').length + 1);
    const date = (t.createdAt || '').slice(0, 10);
    const q = t.quoted?.text ? ` | cite @${t.quoted.handle || '?'} : ${clean(t.quoted.text).slice(0, 300)}` : '';
    const text = clean(t.text).slice(0, maxTweetChars);
    sources.push({ id, kind: 'tweet', handle: t.handle, name: t.name, url: tweetUrl(t), date, text, likes: t.stats?.likes || 0, rep: t === subject.rep });
    lines.push(`[${id}] @${t.handle}${t.name ? ' (' + clean(t.name) + ')' : ''}, ${date}${t === subject.rep ? ', COMPTE SOURCE PRINCIPALE' : ''} : ${text}${q}`);
  });
  let n = 0;
  for (const url of subject.links) {
    if (n >= maxPages) break;
    const p = pages.get(url);
    if (!p || !(p.text || p.title)) continue;
    n++;
    const id = 'L' + n;
    let host = ''; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* */ }
    const text = (p.text || '').slice(0, maxPageChars);
    sources.push({ id, kind: 'page', url, title: p.title || host, host, text });
    lines.push(`[${id}] Page liée (${host}) « ${p.title || ''} » : ${text}`);
  }
  web.forEach((w, i) => {
    const id = 'W' + (i + 1);
    sources.push({ id, kind: 'web', url: w.url, title: w.title || w.host, host: w.host, text: w.text });
    lines.push(`[${id}] Page web trouvée par recherche (${w.host}) « ${w.title || ''} » : ${w.text}`);
  });
  videos.forEach((v, i) => {
    const id = 'V' + (i + 1);
    const text = v.passages.map((p) => `[${fmtTime(Math.floor(p.t))}] ${clean(p.text)}`).join(' … ');
    sources.push({ id, kind: 'video', url: videoUrl(v.video, v.passages[0]?.t || 0), title: clean(v.video.text), host: 'youtube.com', channel: clean(v.video.name), text });
    lines.push(`[${id}] Vidéo YouTube « ${clean(v.video.text)} » (${clean(v.video.name)}) — extraits de la transcription : ${text}`);
  });
  return { sources, text: lines.join('\n\n') };
}

// ---------- transcriptions de vidéos ----------
export const videoUrl = (v, t = 0) => `https://www.youtube.com/watch?v=${v.videoId}${t ? '&t=' + Math.floor(t) + 's' : ''}`;
export function meanVec(vs) {
  const list = vs.filter(Boolean);
  if (!list.length) return null;
  const out = new Float32Array(list[0].length);
  for (const v of list) for (let i = 0; i < out.length; i++) out[i] += v[i];
  let n = 0; for (let i = 0; i < out.length; i++) n += out[i] * out[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}
const dot = (a, ao, b) => { let s = 0; for (let d = 0; d < b.length; d++) s += a[ao + d] * b[d]; return s; };
// Vidéos (avec passages vectorisés) dont un passage ressemble au sujet ; eligible : ensemble d'identifiants autorisés (ou null).
export function matchVideos(qvec, chunkMap, { eligible = null, minSim = 0.55, top = 2 } = {}) {
  if (!qvec) return [];
  const out = [];
  for (const [id, info] of chunkMap) {
    if (eligible && !eligible.has(id)) continue;
    if (info.vecs.length !== info.k * qvec.length) continue; // vecteurs d'un autre modèle
    let best = -1;
    for (let c = 0; c < info.k; c++) best = Math.max(best, dot(info.vecs, c * qvec.length, qvec));
    if (best >= minSim) out.push({ id, sim: best });
  }
  return out.sort((a, b) => b.sim - a.sim).slice(0, top);
}
// Passages les plus proches du sujet (les vecteurs correspondent à sampleChunks(chunks, k)), dans l'ordre de la vidéo.
export function bestPassages(chunks, info, qvec, n = 3) {
  const sampled = sampleChunks(chunks, info.k);
  const scored = sampled.map((c, i) => ({ t: c.t, text: c.text, sim: i < info.k ? dot(info.vecs, i * qvec.length, qvec) : -1 }));
  return scored.sort((a, b) => b.sim - a.sim).slice(0, n).sort((a, b) => a.t - b.t);
}
// Transcription découpée en parties d'environ `size` caractères (au plus maxParts, réparties sur toute la vidéo).
export function splitTranscript(chunks, { size = 9000, maxParts = 12 } = {}) {
  const parts = [];
  let cur = null;
  for (const c of chunks) {
    if (!cur) cur = { from: c.t, to: c.t, text: '' };
    cur.text += `[${fmtTime(Math.floor(c.t))}] ${clean(c.text)}\n`;
    cur.to = c.t;
    if (cur.text.length >= size) { parts.push(cur); cur = null; }
  }
  if (cur) parts.push(cur);
  if (parts.length <= maxParts) return parts;
  return Array.from({ length: maxParts }, (_, i) => parts[Math.floor((i * parts.length) / maxParts)]);
}
export function summaryMessages(video, part) {
  return [
    { role: 'system', content: 'Tu résumes une partie de la transcription d’une vidéo pour un journal. Utilise UNIQUEMENT ce texte, n’ajoute rien. Réponds uniquement en JSON : {"points": [{"t": secondes (nombre) du début du passage concerné, "text": "une idée ou un fait précis, en une phrase, en français"}], "quote": {"t": secondes, "text": "citation EXACTE de 80 à 220 caractères, copiée mot pour mot dans le texte"}}. 6 à 12 points, aussi détaillés que possible (chiffres, noms, étapes, arguments) ; omets "quote" s’il n’y a rien de citable.' },
    { role: 'user', content: `Vidéo : « ${clean(video.text)} » (${clean(video.name)})\nPARTIE (de ${fmtTime(Math.floor(part.from))} à ${fmtTime(Math.floor(part.to))}) :\n${part.text}` },
  ];
}
export function parseSummary(text, part) {
  const o = parseJsonLoose(text);
  const norm = (x) => clean(x).toLowerCase().replace(/\[[\d:]+\]/g, ' ').replace(/[«»"'’]/g, '').replace(/\s+/g, ' ');
  const points = (Array.isArray(o.points) ? o.points : []).map((p) => ({ t: Math.max(0, Math.floor(Number(p?.t) || part.from)), text: clean(p?.text) })).filter((p) => p.text.length > 10).slice(0, 12);
  const q = o.quote && clean(o.quote.text);
  const quote = q && q.length >= 40 && norm(part.text).includes(norm(q)) ? { t: Math.floor(Number(o.quote.t) || part.from), text: q } : null; // la citation doit figurer mot pour mot
  return { points, quote };
}
export function reportageEvidence(video, summaries) {
  const points = summaries.flatMap((s) => s.points).sort((a, b) => a.t - b.t);
  const quotes = summaries.map((s) => s.quote).filter(Boolean);
  const pts = points.map((p) => `- (${fmtTime(p.t)}) ${p.text}`).join('\n');
  const exact = quotes.map((q) => `[${fmtTime(q.t)}] ${q.text}`).join('\n');
  const src = { id: 'V1', kind: 'video', url: videoUrl(video), title: clean(video.text), host: 'youtube.com', channel: clean(video.name), text: exact };
  return { sources: [src], text: `[V1] Vidéo YouTube « ${clean(video.text)} » (${clean(video.name)}${video.durationText ? ', ' + video.durationText : ''}). Points clés de la transcription, avec leur horodatage :\n${pts}\n\nExtraits exacts :\n${exact}`, points: points.length };
}
export function reportageMessages(video, pack) {
  return [
    { role: 'system', content: `Tu es journaliste pour un journal hebdomadaire sur l’IA et la robotique. ${STYLE}\n${RULES}\nTu rédiges un reportage sur une vidéo à partir de ses points clés horodatés : raconte ce que dit la vidéo, dans l’ordre, en mentionnant les moments importants avec leur horodatage (par exemple « vers 12:40 »). Réponds uniquement en JSON : {"title": "titre informatif de 8 à 14 mots", "dek": "chapeau d’une phrase", "paragraphs": ["…"], "pull_quote": "citation exacte tirée des extraits exacts, ou chaîne vide", "pull_source": "V1", "key_points": ["3 points à retenir"]}. Rédige environ 500 mots en 5 à 7 paragraphes.` },
    { role: 'user', content: `DOSSIER :\n${pack.text}` },
  ];
}

// Reportage long, en sections : la longueur suit la durée de la vidéo.
export const DEPTH = { short: { perMin: 20, max: 1400, min: 450 }, normal: { perMin: 32, max: 2400, min: 600 }, detailed: { perMin: 48, max: 3400, min: 800 } };
export function reportagePlan(video, depth = 'detailed', cap = 0) {
  const d = DEPTH[depth] || DEPTH.detailed;
  const minutes = Math.max(5, (video.durationSec || 0) / 60 || 12);
  let words = Math.round(Math.max(d.min, Math.min(d.max, minutes * d.perMin)) / 50) * 50;
  if (cap > 0) words = Math.max(300, Math.min(words, cap));
  const sections = Math.max(1, Math.min(7, Math.round(words / 520)));
  return { words, sections, perSection: Math.round(words / sections / 10) * 10 };
}
// Budget de pages : combien de mots de reportage tiennent dans `maxPages` une fois le reste de l'édition compté (estimation prudente,
// texte à ≈ 90 %). Renvoie { reports, reportWords } : nombre de reportages gardés et mots maximum par reportage (0 = pas de limite).
export function pageBudget({ maxPages, leads = 0, articles = 0, briefs = 0, reportages = 0, sections = 1, extra = 0 }) {
  if (!maxPages || !reportages) return { reports: reportages, reportWords: 0, mainPages: 0 };
  const mainWords = leads * TIER.lead.words + articles * TIER.article.words + briefs * 45 + 450;
  const mainPages = Math.ceil(mainWords / 480) + Math.ceil(sections / 2); // + débuts de rubrique
  const fixed = 5 + extra; // une, chiffres, vidéos, lexique et sources (≈ 2) + pages de classements
  const free = Math.max(0, maxPages - fixed - mainPages);
  const total = free * 560; // mots de reportage par page (3 colonnes)
  let reports = reportages;
  while (reports > 1 && total / reports < 700) reports--;
  const perReport = Math.floor(total / reports / 50) * 50;
  return { reports: total < 450 ? 0 : reports, reportWords: Math.max(300, perReport), mainPages };
}
// Points horodatés répartis en `n` groupes consécutifs (même nombre de points par groupe).
export function splitPoints(summaries, n) {
  const pts = summaries.flatMap((s) => s.points).sort((a, b) => a.t - b.t);
  const quotes = summaries.map((s) => s.quote).filter(Boolean);
  n = Math.max(1, Math.min(n, Math.floor(pts.length / 3)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const g = pts.slice(Math.floor((i * pts.length) / n), Math.floor(((i + 1) * pts.length) / n));
    if (!g.length) continue;
    const from = g[0].t, to = i === n - 1 ? Infinity : pts[Math.floor(((i + 1) * pts.length) / n)].t;
    out.push({ points: g, quotes: quotes.filter((q) => q.t >= from && q.t < to) });
  }
  return out;
}
const groupText = (video, g) => `[V1] Vidéo YouTube « ${clean(video.text)} » (${clean(video.name)}). Points clés de cette partie, avec leur horodatage :\n${g.points.map((p) => `- (${fmtTime(p.t)}) ${p.text}`).join('\n')}${g.quotes.length ? '\n\nExtraits exacts :\n' + g.quotes.map((q) => `[${fmtTime(q.t)}] ${q.text}`).join('\n') : ''}`;
export function reportageIntroMessages(video, pack) {
  return [
    { role: 'system', content: `Tu es journaliste pour un journal hebdomadaire sur l’IA et la robotique. ${STYLE}\n${RULES}\nTu prépares l’ouverture d’un grand reportage sur une vidéo, à partir de ses points clés horodatés. Réponds uniquement en JSON : {"title": "titre informatif de 8 à 14 mots", "dek": "chapeau d’une phrase", "lede": "paragraphe d’introduction d’environ 90 mots qui présente la vidéo, son auteur et son fil directeur", "pull_quote": "citation exacte tirée des extraits exacts, ou chaîne vide", "pull_source": "V1", "key_points": ["5 points à retenir"]}.` },
    { role: 'user', content: `DOSSIER :\n${pack.text}` },
  ];
}
export function reportageSectionMessages(video, group, { index, total, words }) {
  return [
    { role: 'system', content: `Tu es journaliste pour un journal hebdomadaire sur l’IA et la robotique. ${STYLE}\n${RULES}\nTu rédiges la partie ${index + 1} sur ${total} d’un grand reportage sur une vidéo, à partir des points clés horodatés de cette partie uniquement. Raconte ce que dit la vidéo dans l’ordre, avec le plus de précision possible : chiffres, noms, étapes, arguments, exemples, en situant les moments importants (par exemple « vers 12:40 »). ${index ? 'N’introduis pas la vidéo : l’introduction est déjà écrite.' : 'L’introduction est déjà écrite : entre directement dans le contenu.'} Réponds uniquement en JSON : {"heading": "intertitre de 3 à 8 mots", "paragraphs": ["…"]}. Rédige environ ${words} mots en ${Math.max(3, Math.round(words / 110))} paragraphes.` },
    { role: 'user', content: `DOSSIER :\n${groupText(video, group)}` },
  ];
}
export function parseSection(text, pack) {
  const o = parseJsonLoose(text);
  const valid = new Set(pack.sources.map((s) => s.id));
  const paragraphs = (Array.isArray(o.paragraphs) ? o.paragraphs : String(o.paragraphs || '').split(/\n+/)).map((p) => cleanCitations(clean(p), valid)).filter((p) => p.length > 20);
  if (!paragraphs.length) throw new Error('article inexploitable');
  return { heading: clean(o.heading).replace(/^#+\s*/, '').slice(0, 90), paragraphs };
}
export function parseIntro(text, pack) {
  const o = parseJsonLoose(text);
  return parseArticle(JSON.stringify({ ...o, paragraphs: [o.lede || ''] }), pack);
}

// ---------- invites ----------
const STYLE = 'Style : journal économique sobre, factuel, phrases claires, pas de superlatifs ni d’emphase, pas d’exclamation.';
const RULES = 'Règles strictes : utilise UNIQUEMENT les informations du dossier fourni. N’ajoute aucun fait, chiffre, date ou nom qui n’y figure pas. Si une information manque, ne la devine pas. Cite tes sources dans le texte avec leur identifiant entre crochets, par exemple [T1], [L1] ou [W1], à la fin de la phrase concernée. Les sources [T] sont des tweets (elles portent l’annonce), [L] des pages liées dans les tweets, [W] des pages web trouvées par recherche (elles servent au contexte, aux chiffres et aux réactions), [V] une vidéo (d’après sa transcription). Le texte est en français.';

export const TIER = { lead: { words: 700, maxTokens: 2400, paras: '6 à 8' }, article: { words: 300, maxTokens: 1100, paras: '3 à 4' } };

export function articleMessages(tier, subject, pack) {
  const t = TIER[tier] || TIER.article;
  return [
    { role: 'system', content: `Tu es journaliste pour un journal hebdomadaire sur l’IA et la robotique. ${STYLE}\n${RULES}\nRéponds uniquement en JSON : {"title": "titre informatif de 8 à 14 mots", "dek": "chapeau d’une phrase", "paragraphs": ["…"], "pull_quote": "citation exacte et courte tirée d’un tweet du dossier, ou chaîne vide", "pull_source": "identifiant de la source de la citation, ex. T1", "key_points": ["3 points à retenir, une courte phrase chacun"]}. Rédige environ ${t.words} mots en ${t.paras} paragraphes.` },
    { role: 'user', content: `Rubrique : ${subject.sectionName}\nPériode : ${subject.firstDay} → ${subject.lastDay}\n\nDOSSIER :\n${pack.text}` },
  ];
}
export function briefsMessages(entries) {
  return [
    { role: 'system', content: `Tu es journaliste pour un journal hebdomadaire sur l’IA et la robotique. ${STYLE}\n${RULES}\nPour chaque entrée, écris une brève de 30 à 50 mots. Réponds uniquement en JSON : {"briefs": [{"id": "identifiant de l’entrée", "title": "titre court de 3 à 7 mots", "text": "la brève, avec ses citations [T1]"}]}.` },
    { role: 'user', content: entries.map((e) => `ENTRÉE ${e.id} (rubrique ${e.section}) :\n${e.pack.text}`).join('\n\n---\n\n') },
  ];
}
export function editorialMessages(summary) {
  return [
    { role: 'system', content: `Tu es rédacteur en chef d’un journal hebdomadaire sur l’IA et la robotique. ${STYLE}\nÀ partir de la liste des sujets de la semaine (titres et chapeaux ci-dessous), écris : un éditorial de 3 paragraphes qui dégage un fil rouge SANS ajouter de faits qui ne soient pas dans les titres et chapeaux ; trois idées à retenir ; une ligne par jour pour « la semaine en 60 secondes » (uniquement les jours où quelque chose est listé) ; un lexique de 4 termes techniques qui apparaissent dans les sujets, définis simplement de façon générale. Réponds uniquement en JSON : {"title": "titre de l’éditorial", "paragraphs": ["…"], "ideas": ["…","…","…"], "week": [{"day": "AAAA-MM-JJ", "text": "…"}], "glossary": [{"term": "…", "def": "…"}]}.` },
    { role: 'user', content: summary },
  ];
}

// ---------- lecture des réponses ----------
export function cleanCitations(text, valid) {
  return String(text || '').replace(/\[((?:[TLWV]\d+)(?:\s*[,;]\s*[TLWV]\d+)*)\]/g, (m, ids) => {
    const keep = ids.split(/\s*[,;]\s*/).filter((i) => valid.has(i));
    return keep.length ? `[${keep.join(',')}]` : '';
  }).replace(/\s{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
}
export function parseArticle(text, pack) {
  const o = parseJsonLoose(text);
  const valid = new Set(pack.sources.map((s) => s.id));
  const paragraphs = (Array.isArray(o.paragraphs) ? o.paragraphs : String(o.paragraphs || o.body || '').split(/\n+/)).map((p) => cleanCitations(clean(p), valid)).filter((p) => p.length > 20);
  if (!paragraphs.length || !clean(o.title)) throw new Error('article inexploitable');
  const norm = (x) => clean(x).toLowerCase().replace(/[«»"'’]/g, '');
  const pullTxt = clean(o.pull_quote).replace(/^[«"\s]+|[»"\s]+$/g, '');
  const pullFound = pullTxt && pack.sources.some((x) => (x.kind === 'tweet' || x.kind === 'video') && norm(x.text).includes(norm(pullTxt))); // la citation doit figurer mot pour mot dans un tweet
  const pull = pullFound ? pullTxt : '', ps = valid.has(String(o.pull_source || '').trim()) ? String(o.pull_source).trim() : '';
  return { title: clean(o.title), dek: cleanCitations(clean(o.dek), valid), paragraphs, pull: pull.length >= 15 && pull.length <= 220 ? pull : '', pullSource: ps, points: (Array.isArray(o.key_points) ? o.key_points : []).map((p) => cleanCitations(clean(p), valid)).filter(Boolean).slice(0, 4) };
}
export function parseBriefs(text, valids) {
  const o = parseJsonLoose(text);
  const out = new Map();
  for (const b of Array.isArray(o.briefs) ? o.briefs : []) {
    const id = String(b.id || '').trim(), v = valids.get(id);
    if (v && clean(b.text)) out.set(id, { title: clean(b.title), text: cleanCitations(clean(b.text), v) });
  }
  return out;
}
export function parseEditorial(text) {
  const o = parseJsonLoose(text);
  return {
    title: clean(o.title), paragraphs: (Array.isArray(o.paragraphs) ? o.paragraphs : []).map(clean).filter(Boolean),
    ideas: (Array.isArray(o.ideas) ? o.ideas : []).map(clean).filter(Boolean).slice(0, 3),
    week: (Array.isArray(o.week) ? o.week : []).filter((w) => /^\d{4}-\d{2}-\d{2}$/.test(String(w.day || ''))).map((w) => ({ day: w.day, text: clean(w.text) })).filter((w) => w.text),
    glossary: (Array.isArray(o.glossary) ? o.glossary : []).map((g) => ({ term: clean(g.term), def: clean(g.def) })).filter((g) => g.term && g.def).slice(0, 6),
  };
}

// Article de secours sans modèle (budget épuisé ou erreur) : le tweet source, présenté comme tel.
export function fallbackArticle(subject, pack) {
  const rep = pack.sources.find((s) => s.kind === 'tweet') || { text: '', handle: subject.rep.handle };
  const first = (rep.text.match(/^.{20,260}?[.!?](?:\s|$)/) || [rep.text.slice(0, 240)])[0].trim();
  return { title: first.length > 90 ? first.slice(0, 87).replace(/\s\S*$/, '') + '…' : first, dek: '', paragraphs: [`Selon @${rep.handle} : « ${rep.text.slice(0, 400)} » [${rep.id || 'T1'}]`], pull: '', pullSource: '', points: [], fallback: true };
}

// ---------- coûts ----------
export const tokensOf = (chars) => Math.ceil(chars / 3.5);
export function estimateCall(inChars, outTokens, { priceInPerM, priceOutPerM }) {
  const tin = tokensOf(inChars) + 300, tout = outTokens;
  return { tin, tout, dollars: (tin / 1e6) * priceInPerM + (tout / 1e6) * priceOutPerM };
}
export function costOf(usage, prices) {
  if (usage?.cost != null) return usage.cost;
  return ((usage?.promptTokens || 0) / 1e6) * prices.priceInPerM + ((usage?.completionTokens || 0) / 1e6) * prices.priceOutPerM;
}
export const fmtUsd = (d) => (d < 0.005 ? '< 0,01 $' : d.toFixed(2).replace('.', ',') + ' $');

// ---------- blocs HTML ----------
export const SECTION_LABEL = (name) => esc(name);
// Numérotation globale des sources de l'édition : Map(clé) -> numéro ; registre pour l'index final.
export function makeBibliography() {
  const nums = new Map(), list = [];
  return {
    list,
    number(src) {
      const key = src.kind + '|' + src.url;
      if (!nums.has(key)) { nums.set(key, list.length + 1); list.push({ n: list.length + 1, ...src }); }
      return nums.get(key);
    },
  };
}
// [T1,L1] -> <sup>3,4</sup>
export function citeHtml(text, pack, bib) {
  const byId = new Map(pack.sources.map((s) => [s.id, s]));
  return esc(text).replace(/\[((?:[TLWV]\d+)(?:,[TLWV]\d+)*)\]/g, (m, ids) => {
    const ns = [...new Set(ids.split(',').map((i) => byId.get(i)).filter(Boolean).map((s) => bib.number(s)))].sort((a, b) => a - b);
    return ns.length ? `<sup class="c">${ns.join(',')}</sup>` : '';
  });
}
export const sourcesLine = (article, pack, bib) => {
  const ids = new Set();
  for (const m of [article.dek, ...article.paragraphs, ...article.points].join(' ').matchAll(/\[((?:[TLWV]\d+)(?:,[TLWV]\d+)*)\]/g)) m[1].split(',').forEach((i) => ids.add(i));
  const srcs = pack.sources.filter((s) => ids.has(s.id));
  if (!srcs.length) return '';
  return `<p class="srcl">Sources : ${srcs.map((s) => `<a href="${esc(s.url)}">${bib.number(s)}. ${esc(s.kind === 'tweet' ? '@' + s.handle : s.kind === 'video' ? s.channel : s.host)}</a>`).join(' · ')}</p>`;
};

// ---------- recherche web ----------
export function searchMessages(subject) {
  const tw = subject.members.slice(0, 3).map((t) => `- @${t.handle} (${(t.createdAt || '').slice(0, 10)}) : ${clean(t.text).slice(0, 400)}`).join('\n');
  return [
    { role: 'system', content: 'Tu fais de la recherche documentaire pour un journal hebdomadaire sur l’IA et la robotique. Utilise la recherche web. Trouve 4 à 8 faits vérifiables et utiles sur le sujet : contexte, chiffres, dates, caractéristiques, réactions, concurrents ; privilégie les sources primaires (blog officiel, documentation, papier de recherche). Chaque fait est une phrase complète, en français, soutenue par UNE page que tu as réellement consultée. N’invente aucun fait ni aucune adresse. Réponds uniquement en JSON : {"findings": [{"fact": "…", "url": "https://…"}]}.' },
    { role: 'user', content: `Sujet (rubrique ${subject.sectionName}), d’après ces tweets :\n${tw}` },
  ];
}
const normUrl = (u) => { try { const x = new URL(u); x.hash = ''; for (const k of [...x.searchParams.keys()]) if (/^utm_|^ref$|^fbclid$|^gclid$/i.test(k)) x.searchParams.delete(k); return x.href.replace(/\/$/, ''); } catch { return ''; } };
// Retient les faits dont l'adresse figure parmi les pages réellement consultées (annotations du fournisseur) : jamais d'adresse inventée.
export function parseFindings(text, annotations = []) {
  const known = new Map();
  for (const a of annotations || []) {
    const c = a?.url_citation || a;
    const u = normUrl(c?.url);
    if (u && !known.has(u)) known.set(u, { title: clean(c.title), snippet: clean(c.content).slice(0, 1200) });
  }
  if (!known.size) return { sources: [], rejected: 0, noAnnotations: true };
  let o; try { o = parseJsonLoose(text); } catch { return { sources: [], rejected: 0 }; }
  const byUrl = new Map();
  let rejected = 0;
  for (const f of Array.isArray(o.findings) ? o.findings : []) {
    const u = normUrl(f?.url), fact = clean(f?.fact);
    if (!fact || !u || !known.has(u)) { rejected++; continue; }
    const cur = byUrl.get(u) || { url: u, title: known.get(u).title, host: '', facts: [], snippet: known.get(u).snippet };
    cur.facts.push(fact);
    byUrl.set(u, cur);
  }
  const sources = [...byUrl.values()].slice(0, 5).map((w) => { let host = ''; try { host = new URL(w.url).hostname.replace(/^www\./, ''); } catch { /* */ } return { url: w.url, title: w.title, host, text: `${w.facts.join(' ')}${w.snippet ? ' | Extrait de la page : ' + w.snippet : ''}`.slice(0, 1800) }; });
  return { sources, rejected };
}

// ---------- relecture automatique ----------
export function splitSentences(par) {
  return String(par || '').split(/(?<=[.!?»])\s+(?=[A-ZÀ-ÝÉ«"“0-9])/).map((x) => x.trim()).filter(Boolean);
}
export function verifyMessages(article, pack) {
  const lines = [];
  article.paragraphs.forEach((p, i) => splitSentences(p).forEach((s, j) => lines.push({ id: `${i}.${j}`, text: s })));
  return {
    lines,
    messages: [
      { role: 'system', content: 'Tu es vérificateur dans un journal. On te donne un dossier de sources et des phrases numérotées d’un article. Pour chaque phrase, réponds si elle est ENTIÈREMENT soutenue par le dossier (les faits, chiffres, dates et noms qu’elle contient figurent dans les sources citées ou dans le dossier). Une phrase de transition sans fait précis est soutenue. Réponds uniquement en JSON : {"results": [{"id": "numéro de la phrase", "supported": true ou false}]}.' },
      { role: 'user', content: `DOSSIER :\n${pack.text}\n\nPHRASES :\n${lines.map((l) => `${l.id} : ${l.text}`).join('\n')}` },
    ],
  };
}
// Retire les phrases jugées non étayées ; retourne { article, removed }. Garde l'article tel quel si la réponse est inexploitable.
export function applyVerification(article, lines, text) {
  let o; try { o = parseJsonLoose(text); } catch { return { article, removed: 0 }; }
  const bad = new Set((Array.isArray(o.results) ? o.results : []).filter((r) => r && r.supported === false).map((r) => String(r.id)));
  if (!bad.size || bad.size >= lines.length) return { article, removed: bad.size >= lines.length ? 0 : 0 }; // tout rejeter = réponse suspecte : on ne touche à rien
  const keep = new Map();
  lines.forEach((l) => { if (!bad.has(l.id)) { const [i] = l.id.split('.'); keep.set(i, [...(keep.get(i) || []), l.text]); } });
  const paragraphs = article.paragraphs.map((_, i) => (keep.get(String(i)) || []).join(' ')).filter((p) => p.length > 20);
  if (!paragraphs.length) return { article, removed: 0 };
  return { article: { ...article, paragraphs, verified: true }, removed: bad.size };
}
