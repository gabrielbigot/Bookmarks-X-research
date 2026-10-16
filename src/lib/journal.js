// Journal hebdomadaire : sujets de la semaine, dossiers de preuves, invites pour le modèle, coûts, blocs HTML.
// Fonctions pures (testées sans navigateur) ; la mise en page par pages et l'orchestration sont dans journal.js.
import { dayKey } from './time.js';
import { decodeEntities } from './text.js';
import { isVideoItem } from './youtube.js';
import { clusterCandidates, eventDays, rankMembers, groupKeys, linkKeys, handleKey, OFFICIAL_MIN } from './widgets.js';
import { parseJsonLoose } from './llm.js';

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
export function buildSubjects(items, { sv, sections, vecs = null, primary = new Set(), official = {}, win, sim = 0.9, days = 7 }) {
  const taken = new Set(), out = [];
  for (const sec of sections) {
    const cand = [];
    for (const t of items) {
      if (isVideoItem(t) || t.off || taken.has(t.id) || !sec.set.has(t.id)) continue;
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
  const accounts = new Map(), accountsPrev = new Map(), words = new Map(), wordsPrev = new Map();
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
      for (const d of ds) if (inWindow(d, win)) { byDay.set(d, (byDay.get(d) || 0) + 1); for (const s of inSec) { const m = sectionDays.get(s.id); m.set(d, (m.get(d) || 0) + 1); } }
    }
  }
  const dayKeys = [];
  for (let i = win.days - 1; i >= 0; i--) dayKeys.push(dayKey(Date.parse(win.to + 'T12:00:00') - i * DAY));
  const topAccounts = [...accounts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([handle, n]) => ({ handle, n, d: n - (accountsPrev.get(handle) || 0) }));
  const rising = [...words].filter(([, n]) => n >= 3).map(([w, n]) => ({ word: w, n, prev: wordsPrev.get(w) || 0 })).map((x) => ({ ...x, d: x.n - x.prev })).filter((x) => x.d > 0).sort((a, b) => b.d - a.d || b.n - a.n).slice(0, 10);
  return { total, dayKeys, byDay: dayKeys.map((k) => byDay.get(k) || 0), sectionSeries: sections.map((s) => ({ id: s.id, name: s.name, vals: dayKeys.map((k) => sectionDays.get(s.id).get(k) || 0) })), topAccounts, rising };
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
export function evidenceFor(subject, pages = new Map(), { maxTweets = 8, maxPages = 2, maxTweetChars = 700, maxPageChars = 5000 } = {}) {
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
  return { sources, text: lines.join('\n\n') };
}

// ---------- invites ----------
const STYLE = 'Style : journal économique sobre, factuel, phrases claires, pas de superlatifs ni d’emphase, pas d’exclamation.';
const RULES = 'Règles strictes : utilise UNIQUEMENT les informations du dossier fourni. N’ajoute aucun fait, chiffre, date ou nom qui n’y figure pas. Si une information manque, ne la devine pas. Cite tes sources dans le texte avec leur identifiant entre crochets, par exemple [T1] ou [L1], à la fin de la phrase concernée. Le texte est en français.';

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
  return String(text || '').replace(/\[((?:[TL]\d+)(?:\s*[,;]\s*[TL]\d+)*)\]/g, (m, ids) => {
    const keep = ids.split(/\s*[,;]\s*/).filter((i) => valid.has(i));
    return keep.length ? `[${keep.join(',')}]` : '';
  }).replace(/\s{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
}
export function parseArticle(text, pack) {
  const o = parseJsonLoose(text);
  const valid = new Set(pack.sources.map((s) => s.id));
  const paragraphs = (Array.isArray(o.paragraphs) ? o.paragraphs : String(o.paragraphs || o.body || '').split(/\n+/)).map((p) => cleanCitations(clean(p), valid)).filter((p) => p.length > 20);
  if (!paragraphs.length || !clean(o.title)) throw new Error('article inexploitable');
  const pull = clean(o.pull_quote), ps = valid.has(String(o.pull_source || '').trim()) ? String(o.pull_source).trim() : '';
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
  return esc(text).replace(/\[((?:[TL]\d+)(?:,[TL]\d+)*)\]/g, (m, ids) => {
    const ns = [...new Set(ids.split(',').map((i) => byId.get(i)).filter(Boolean).map((s) => bib.number(s)))].sort((a, b) => a - b);
    return ns.length ? `<sup class="c">${ns.join(',')}</sup>` : '';
  });
}
export const sourcesLine = (article, pack, bib) => {
  const ids = new Set();
  for (const m of [article.dek, ...article.paragraphs, ...article.points].join(' ').matchAll(/\[((?:[TL]\d+)(?:,[TL]\d+)*)\]/g)) m[1].split(',').forEach((i) => ids.add(i));
  const srcs = pack.sources.filter((s) => ids.has(s.id));
  if (!srcs.length) return '';
  return `<p class="srcl">Sources : ${srcs.map((s) => `<a href="${esc(s.url)}">${bib.number(s)}. ${esc(s.kind === 'tweet' ? '@' + s.handle : s.host)}</a>`).join(' · ')}</p>`;
};
