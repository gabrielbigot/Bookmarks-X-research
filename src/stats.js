import { getAllTweets, getMeta, setMeta, getAllVectors, getAllChunkVecs } from './lib/db.js';
import { getSettings } from './lib/settings.js';
import { modelOf } from './lib/models.js';
import { savedInfo, dayKey } from './lib/time.js';
import { detsOf, evalWidget, evalMulti, seriesDefs, detectorScores, detectorSet, detectorMargin, learnedLabels, LEARN_SIM, ambiguousIds, scoreStats, suggestThreshold, verdictKey, CONFIRM_BAND, textOf, slugOf, OFFICIAL_DESC, OFFICIAL_MIN, judgeText, suggestPrimary, handleKey } from './lib/widgets.js';
import { jevJudge, estimateJudgeCost, fmtDollars } from './lib/jev.js';
import { decodeEntities } from './lib/text.js';
import { decisionReady } from './lib/settings.js';
import { computeStats, TYPE_LABELS } from './lib/stats.js';
import { bindThemeButton } from './lib/theme.js';
import { isVideoItem } from './lib/youtube.js';
import { computeYtStats, fmtHours } from './lib/ytstats.js';
import { timeSeries, cumulative, columns, hbars, stacked, calendar, sparkline, multiSeries, donut, heatmap, esc, fmtInt, fmtCompact, fmtDay, WEEKDAYS } from './lib/charts.js';

const $ = (id) => document.getElementById(id);
const RANGES = [[1, '1 j'], [7, '7 j'], [30, '30 j'], [90, '90 j'], [365, '1 an'], [null, 'Tout']];
const RKEY = 'xbs.stats.range';
let all = [], videos = [], everything = [], range = 90, src = 'x', widgets = [], detectors = [], verdicts = {};
let primaryList = [], official = { v: OFFICIAL_DESC, m: {} }; // sources primaires déclarées ; verdicts « annonce officielle » de Jev (% oui)
const primarySet = () => new Set(primaryList.map(handleKey));
const saveOfficial = () => setMeta('officialVerdicts', official);
try { const v = localStorage.getItem('xbs.stats.src'); src = v === 'yt' || v === 'mine' ? v : 'x'; } catch {}
try { const v = localStorage.getItem(RKEY); if (v !== null) range = v === 'all' ? null : Number(v); } catch {}

bindThemeButton($('theme'));

// Ouvre le panneau de recherche avec une requête (cliquer sur une barre, une case, une pastille…).
const openQ = (q) => window.open(`panel.html?q=${encodeURIComponent(q)}`, '_blank', 'noopener');

function drawSources() {
  $('source').replaceChildren(...[['x', 'Bookmarks X'], ['yt', 'YouTube'], ['mine', 'Mes stats']].map(([v, label]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.setAttribute('aria-pressed', String(v === src));
    b.onclick = () => { src = v; try { localStorage.setItem('xbs.stats.src', v); } catch {} drawSources(); render(); };
    return b;
  }));
}

function drawRanges() {
  $('ranges').replaceChildren(...RANGES.map(([v, label]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.setAttribute('aria-pressed', String(v === range));
    b.onclick = () => { range = v; try { localStorage.setItem(RKEY, v === null ? 'all' : String(v)); } catch {} drawRanges(); render(); };
    return b;
  }));
}

const tableHtml = ({ head, rows }) =>
  `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

// Une carte = titre + sous-titre + graphique + jumeau « tableau » (les valeurs ne dépendent jamais de l'infobulle).
const cards = [];
function card(title, sub, chart, { full = false } = {}) {
  const id = 'c' + cards.length;
  cards.push({ id, chart });
  return `<section class="card${full ? ' full' : ''}" id="${id}"><header><div><h3>${esc(title)}</h3>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}</div>
    <button class="tbl-btn" type="button" aria-pressed="false" title="Afficher les valeurs en tableau">Tableau</button></header>
    <div class="viz">${chart.html}</div><div class="tbl" hidden>${tableHtml(chart.table)}</div></section>`;
}
const tile = (label, value, sub = '', extra = '', cls = '') => `<div class="tile ${cls}"><div class="l">${esc(label)}</div><div class="v">${value}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}${extra}</div>`;
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(n / d < 0.1 ? 1 : 0).replace('.', ',') + ' %' : '–');
const chips = (rows, qOf) => `<div class="chips">${rows.map(([k, n]) => `<button class="chip-s" type="button" data-q="${esc(qOf(k))}">${esc(k)}<b>${fmtInt(n)}</b></button>`).join('')}</div>`;

function dayQuery(st, k, gran) {
  const end = gran === 'week' ? shiftDay(k, 6) : gran === 'month' ? lastOfMonth(k) : k;
  const start = gran === 'month' ? k + '-01' : k;
  return st.savedValid ? `saved:${start}..${end}` : `since:${start} until:${end}`;
}
const shiftDay = (k, n) => { const [y, m, d] = k.split('-').map(Number); const t = new Date(y, m - 1, d + n); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
const lastOfMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };


// =====================================================================================================================
// Mes stats : requêtes et détecteurs comptés dans le temps (période = filtre du haut)
// =====================================================================================================================
const saveWidgets = () => setMeta('dashWidgets', widgets);
const saveDetectors = () => setMeta('dashDetectors', detectors);
const saveVerdicts = () => setMeta('detVerdicts', verdicts);
// verdicts de Jev valables pour ce détecteur (la description a pu changer depuis)
const verdictsOf = (det) => (verdicts[det.id]?.key === verdictKey(det) ? verdicts[det.id].v : {});
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const byId = () => new Map(everything.map((t) => [t.id, t]));

// Vecteurs chargés une fois (les détecteurs comparent les exemples à tous les vecteurs de la base).
let vecCache = null;
async function loadVectors() {
  if (vecCache) return vecCache;
  const mid = modelOf((await getSettings()).embedModel).id;
  vecCache = { mid, vecs: await getAllVectors(mid), chunks: await getAllChunkVecs(mid) };
  return vecCache;
}
const scoreCache = new Map(); // id du détecteur + exemples -> scores
async function scoresOf(det) {
  const { mid, vecs, chunks } = await loadVectors();
  const protos = (det.protos?.[mid] || []).map((a) => Float32Array.from(a));
  if (!protos.length) return null;
  const key = det.id + '|' + mid + '|' + det.protoKey;
  if (!scoreCache.has(key)) scoreCache.set(key, detectorScores(vecs, chunks, protos));
  return scoreCache.get(key);
}
const learnCache = new Map();
async function learnedOf(det) {
  if (det.learn?.on === false || (!det.pos?.length && !det.neg?.length)) return null;
  const sim = det.learn?.sim ?? LEARN_SIM;
  const key = `${det.id}|${sim}|${(det.pos || []).join(',')}|${(det.neg || []).join(',')}`;
  if (!learnCache.has(key)) { const { vecs } = await loadVectors(); learnCache.set(key, learnedLabels(vecs, det.pos, det.neg, sim)); }
  return learnCache.get(key);
}
async function detectorSetsFor(ids) {
  const out = new Map(), missing = [];
  for (const id of ids) {
    const det = detectors.find((d) => d.id === id);
    if (!det) continue;
    const sc = await scoresOf(det);
    if (!sc) { missing.push(det.name); out.set(id, new Set()); } else out.set(id, detectorSet(sc, det, verdictsOf(det), await learnedOf(det)));
  }
  return { sets: out, missing };
}
async function embedTexts(texts) {
  const out = [];
  for (const text of texts) {
    const res = await chrome.runtime.sendMessage({ type: 'q:embed', text, kind: 't' });
    if (!res || res.error) throw new Error('le modèle de recherche n’est pas disponible pour l’instant (' + (res?.error || 'pas de réponse') + ')');
    out.push(Array.from(res.vec));
  }
  return out;
}

const KINDS = { compare: 'Comparaison de stats', number: 'Nombre', series: 'Courbe / comparaison', top: 'Classement', ratio: 'Ratio (A ÷ B)', heat: 'Carte de chaleur (jour × heure)', trend: 'Tendances (ce qui monte)' };
const VIZ = { bars: 'Barres', stacked: 'Barres empilées', lines: 'Courbes', area: 'Aires' };
const TVIZ = { bars: 'Barres', donut: 'Anneau' };
const SIZES = { '': 'Taille automatique', 1: 'Petite', 2: 'Moyenne', 3: 'Grande', all: 'Pleine largeur' };
const sizeOf = (w) => w.size || (w.kind === 'number' || w.kind === 'ratio' ? 1 : 2);
const SOURCES = { all: 'Tout', x: 'Bookmarks X', youtube: 'YouTube' };
const BYS = { author: 'Auteurs / chaînes', site: 'Sites cités', lang: 'Langues', word: 'Mots marquants' };
const detSlugs = (w) => detsOf(w).map((id) => slugOf(detectors.find((d) => d.id === id)?.name)).filter(Boolean);
const wQuery = (w) => [w.q, w.noQuotes ? 'quoted:no' : '', detSlugs(w).length ? (w.detMode === 'or' ? 'is:' + detSlugs(w).join(',') : detSlugs(w).map((x) => 'is:' + x).join(' ')) : '', w.primaryOnly ? 'primary:oui' : '', w.officialOnly ? 'official:oui' : '', w.dedupe?.on ? `dedupe:${w.dedupe.sim ?? 0.92},${w.dedupe.days ?? 7}` : '', w.source === 'x' ? 'source:x' : w.source === 'youtube' ? 'source:youtube' : ''].filter(Boolean).join(' ');
// Ce qui est compté = éléments dont le jour (enregistrement / visionnage / ajout) tombe dans la période : le clic ouvre la même chose.
const duringRange = () => { if (!range) return ''; const to = dayKey(Date.now()), from = dayKey(Date.now() - (range - 1) * 86_400_000); return `during:${from}..${to}`; };
const withPeriod = (q) => [q, duringRange()].filter(Boolean).join(' ');
const duringBucket = (k, g) => `during:${g === 'month' ? k + '-01..' + lastOfMonth(k) : g === 'week' ? k + '..' + shiftDay(k, 6) : k}`;
const rangeLabel = () => (range ? RANGES.find(([v]) => v === range)[1] : 'tout');
const groupedNote = (r) => (r.grouped ? `${fmtInt(r.n)} sujet${r.n > 1 ? 's' : ''} distinct${r.n > 1 ? 's' : ''} · ${fmtInt(r.tweets)} tweet${r.tweets > 1 ? 's' : ''}${r.limited ? ' · regroupement par le sens désactivé (trop d’éléments)' : ''}` : '');
const delta = (n, prev) => (prev == null || (n === 0 && prev === 0) ? '' : prev === 0 ? (n ? 'nouveau' : '=') : `${n >= prev ? '▲' : '▼'} ${Math.abs(Math.round(((n - prev) / prev) * 100))} % vs période précédente`);

const TEMPLATES = [
  { title: 'Tweets avec un lien', kind: 'series', q: 'has:link', source: 'x' },
  { title: 'Vidéos YouTube vues', kind: 'series', q: 'viewed:yes', source: 'youtube' },
  { title: 'À regarder, pas encore vu', kind: 'number', q: 'playlist:"à regarder plus tard" viewed:no', source: 'youtube' },
  { title: 'Auteurs les plus enregistrés', kind: 'top', q: '', source: 'x', by: 'author' },
  { title: 'X vs YouTube', kind: 'series', q: '', source: 'x', slabel: 'X', more: [{ label: 'YouTube', q: '', source: 'youtube' }], viz: 'lines' },
  { title: 'Activité par source', kind: 'series', q: '', source: 'all', split: 'source', viz: 'stacked' },
  { title: 'Langues', kind: 'top', q: '', source: 'x', by: 'lang', viz: 'donut' },
  { title: 'Quand les tweets sont publiés', kind: 'heat', q: '', source: 'x' },
  { title: 'Sujets qui montent (mots)', kind: 'trend', q: '', source: 'x', by: 'word' },
  { title: 'Part des tweets avec un lien', kind: 'ratio', q: 'has:link', source: 'x', slabel: 'Avec lien', more: [{ label: 'Tous les tweets', q: '', source: 'x' }] },
];
const LAUNCH_DETECTOR = { name: 'Lancements', desc: 'Annonce d’un lancement : produit, entreprise, fonctionnalité', examples: ['Today, we launch our new product', 'Introducing our new app, available now', 'We just shipped a major update', 'Aujourd’hui, nous lançons notre startup', 'Lancement officiel de notre nouvelle version'], threshold: 0.4 };

// ---------- tableaux de bord ----------
let boards = [], board = 'main';
const MAIN = { id: 'main', name: 'Général' };
const allBoards = () => [MAIN, ...boards.filter((b) => b.id !== 'main')];
const boardOf = (w) => (allBoards().some((b) => b.id === w.board) ? w.board : 'main');
try { board = localStorage.getItem('xbs.stats.board') || 'main'; } catch {}
const saveBoards = () => setMeta('dashBoards', boards);

// ---------- export ----------
function download(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
const fileSlug = (t) => slugOf(t || 'stat');
function exportCsv(chart, title) {
  const cell = (v) => (/[",;\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  download(fileSlug(title) + '.csv', new Blob(['﻿' + [chart.table.head, ...chart.table.rows].map((r) => r.map(cell).join(';')).join('\n')], { type: 'text/csv;charset=utf-8' }));
}
function exportPng(el, title) {
  const svg = el.querySelector('svg.chart');
  if (!svg) return;
  const clone = svg.cloneNode(true);
  const src = [svg, ...svg.querySelectorAll('*')], dst = [clone, ...clone.querySelectorAll('*')];
  src.forEach((n, i) => { // les styles viennent de la feuille de style : on les fige dans le SVG exporté
    const cs = getComputedStyle(n), d = dst[i];
    d.setAttribute('style', ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-size', 'font-weight', 'font-family'].map((k) => `${k}:${cs.getPropertyValue(k)}`).join(';'));
  });
  clone.querySelectorAll('.xh,.hit').forEach((n) => n.remove());
  const vb = svg.viewBox.baseVal, w = 1200, h = Math.round((w * vb.height) / vb.width), head = 70;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); clone.setAttribute('width', w); clone.setAttribute('height', h);
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = w; c.height = h + head;
    const g = c.getContext('2d'), css = getComputedStyle(document.documentElement);
    g.fillStyle = css.getPropertyValue('--surface').trim() || '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = css.getPropertyValue('--text-1').trim() || '#000'; g.font = '600 28px system-ui,sans-serif'; g.fillText(title || 'Stat', 24, 44);
    g.drawImage(img, 0, head, w, h);
    c.toBlob((b) => b && download(fileSlug(title) + '.png', b), 'image/png');
  };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
}

// requête qui ouvre exactement une série (utilisée au clic)
const seriesQuery = (w, si, multi) => {
  if (multi.split) { const g = multi.series[si].label; return [wQuery(w), w.split === 'source' ? (g === 'YouTube' ? 'source:youtube' : g === 'X' ? 'source:x' : '') : w.split === 'lang' && g !== 'Autres' && g !== '–' ? 'lang:' + g : ''].filter(Boolean).join(' '); }
  return wQuery(multi.defs[si].def);
};
const keyQuery = (w, by, key) => [wQuery(w), by === 'author' ? `from:@${key}` : by === 'lang' ? `lang:${key}` : key].filter(Boolean).join(' ');

async function renderMine(app) {
  const sv = savedInfo(all, Date.now());
  const needed = new Set(widgets.flatMap((w) => [...detsOf(w), ...(w.more || []).flatMap((m) => m.dets || [])]));
  const { sets, missing } = await detectorSetsFor(needed);
  const ctx = { sv, now: Date.now(), rangeDays: range, detSets: sets, primary: primarySet(), official: official.m };
  if (widgets.some((w) => w.dedupe?.on)) ctx.vecs = (await loadVectors()).vecs; // regroupement par le sens
  if (!allBoards().some((b) => b.id === board)) board = 'main';
  let html = `<div class="boards">${allBoards().map((b) => `<button type="button" class="bt${b.id === board ? ' on' : ''}" data-b="${esc(b.id)}">${esc(b.name)}</button>`).join('')}<button type="button" class="bt add" id="b-add">+ Tableau</button>${board !== 'main' ? '<button type="button" class="bt" id="b-ren">Renommer</button><button type="button" class="bt" id="b-del">Supprimer</button>' : '<button type="button" class="bt" id="b-ren">Renommer</button>'}</div>`;
  html += `<div class="mine-bar"><button type="button" class="pbtn" id="w-add">+ Ajouter une stat</button><button type="button" class="pbtn alt" id="w-cmp" title="Superposer plusieurs de tes stats sur un même graphique">⇄ Comparer des stats</button><select id="tpl-sel" class="gbtn" title="Ajouter une stat toute prête"><option value="">+ Modèle…</option>${TEMPLATES.map((t, i) => `<option value="${i}">${esc(t.title)}</option>`).join('')}</select><button type="button" class="gbtn" id="d-manage">Détecteurs (${detectors.length})</button><button type="button" class="gbtn" id="p-manage">Sources primaires (${primaryList.length})</button></div>`;
  if (missing.length) html += `<p class="note">Détecteur(s) <b>${esc(missing.join(', '))}</b> : les exemples n’ont pas encore été analysés avec le modèle actuel — ouvre « Détecteurs » et enregistre-les à nouveau (le modèle de recherche doit être disponible).</p>`;
  const emptyDets = [...needed].filter((id) => sets.has(id) && sets.get(id).size === 0 && !missing.includes(detectors.find((d) => d.id === id)?.name)).map((id) => detectors.find((d) => d.id === id)?.name).filter(Boolean);
  if (emptyDets.length) html += `<p class="note">⚠ Détecteur(s) <b>${esc(emptyDets.join(', '))}</b> : aucun élément retenu. Le seuil est probablement trop haut : ouvre « Détecteurs » › Modifier, une suggestion de seuil y est proposée.</p>`;
  const mine = widgets.map((w, i) => [w, i]).filter(([w]) => boardOf(w) === board);
  if (!mine.length) {
    html += `<p class="muted">${widgets.length ? 'Ce tableau est vide.' : 'Aucune stat personnalisée pour l’instant.'} Une stat compte ce que tu veux dans le temps, avec le filtre de période du haut : une requête de recherche (mots, <code>from:@…</code>, <code>has:link</code>, <code>playlist:"…"</code>) ou un <b>détecteur</b> qui comprend le sens (par exemple « annonce d’un lancement »). Elle peut comparer plusieurs séries sur un même graphique, se découper par source ou par langue, et prendre la forme d’une courbe, de barres empilées, d’un anneau, d’une carte de chaleur, d’un ratio ou d’un classement de tendances.</p>
      <div class="tpl">${TEMPLATES.map((t, i) => `<button type="button" class="gbtn" data-tpl="${i}">+ ${esc(t.title)}</button>`).join('')}<button type="button" class="gbtn" data-tpl="launch">+ Détecteur « Lancements »</button></div>`;
  } else {
    html += '<div class="mine-grid">';
    mine.forEach(([w, i]) => {
      const q = wQuery(w);
      const nb = mine.findIndex(([, j]) => j === i);
      const goal = Number(w.goal) || 0;
      const act = (chart) => `<div class="wact"><button type="button" class="grab" data-act="grab" data-i="${i}" title="Glisser pour déplacer">⠿</button>${chart ? `<button type="button" data-act="csv" data-i="${i}" title="Exporter les valeurs (CSV)">CSV</button><button type="button" data-act="png" data-i="${i}" title="Exporter l’image (PNG)">PNG</button>` : ''}<button type="button" data-act="edit" data-i="${i}" title="Modifier">✎</button><button type="button" data-act="dup" data-i="${i}" title="Dupliquer">⧉</button><button type="button" data-act="up" data-i="${i}" title="Monter"${nb ? '' : ' disabled'}>↑</button><button type="button" data-act="down" data-i="${i}" title="Descendre"${nb < mine.length - 1 ? '' : ' disabled'}>↓</button><button type="button" data-act="del" data-i="${i}" title="Supprimer">✕</button></div>`;
      const head = (chart, extra = '') => `<header><div><h3>${esc(w.title || 'Sans titre')}</h3><p class="sub">${esc(KINDS[w.kind] || w.kind)}${w.kind === 'compare' ? '' : ' · ' + esc(SOURCES[w.source || 'all'])} · ${esc(rangeLabel())}${q ? ' · ' + esc(q) : ''}${extra}</p></div>${act(chart)}</header>`;
      const headT = (extra) => head(true, extra).replace('</header>', '<button class="tbl-btn" type="button" aria-pressed="false" title="Afficher les valeurs en tableau">Tableau</button></header>');
      const goalBar = (v) => (goal > 0 ? `<div class="goal${v >= goal ? ' done' : ''}" title="objectif ${goal}"><i style="width:${Math.min(100, (v / goal) * 100)}%"></i></div><p class="sub">objectif ${fmtInt(goal)} · ${Math.round((v / goal) * 100)} %${v >= goal ? ' ✓ atteint' : ''}</p>` : '');
      const cls = `card mine sz-${sizeOf(w)}`;
      const push = (chart, body, extra) => { const id = 'c' + cards.length; cards.push({ id, chart, title: w.title }); html += `<section class="${cls}" id="${id}" data-i="${i}">${headT(extra)}${body}<div class="viz">${chart.html}</div><div class="tbl" hidden>${tableHtml(chart.table)}</div></section>`; };
      if (w.kind === 'number') {
        const r = evalWidget(everything, w, ctx);
        html += `<section class="${cls}" data-i="${i}"><div>${head(false)}<div class="big"><button type="button" class="bignum" data-open="${esc(withPeriod(q))}" title="Ouvrir ces éléments dans la recherche (même période)">${fmtInt(r.n)}</button><span class="dl">${esc(delta(r.n, r.prev))}</span></div>${goalBar(r.n)}${groupedNote(r) ? `<p class="sub">${esc(groupedNote(r))}</p>` : ''}${r.noDate && range ? `<p class="sub">${fmtInt(r.noDate)} éléments sans date ne sont pas comptés sur une période.</p>` : ''}</div></section>`;
      } else if (w.kind === 'ratio') {
        const defs = seriesDefs(w);
        if (defs.length < 2) { html += `<section class="${cls}" data-i="${i}"><div>${head(false)}<p class="note">Ajoute le dénominateur (la série « divisé par ») dans ✎.</p></div></section>`; return; }
        const a = evalWidget(everything, { ...defs[0].def, kind: 'number' }, ctx), b = evalWidget(everything, { ...defs[1].def, kind: 'number' }, ctx);
        const pc = b.n ? (a.n / b.n) * 100 : null, pp = b.prev ? (a.prev / b.prev) * 100 : null;
        const f1 = (v) => (v == null ? '–' : v.toFixed(v < 10 ? 1 : 0).replace('.', ','));
        html += `<section class="${cls}" data-i="${i}"><div>${head(false)}<div class="big"><button type="button" class="bignum" data-open="${esc(withPeriod(wQuery(defs[0].def)))}" title="Ouvrir le numérateur dans la recherche">${f1(pc)} %</button><span class="dl">${pc != null && pp != null ? esc(`${pc >= pp ? '▲' : '▼'} ${Math.abs(pc - pp).toFixed(1).replace('.', ',')} pt vs période précédente`) : ''}</span></div>${goalBar(pc || 0)}<p class="sub">${esc(defs[0].label)} : ${fmtInt(a.n)} · ${esc(defs[1].label)} : ${fmtInt(b.n)}</p></div></section>`;
      } else if (w.kind === 'series' || w.kind === 'compare') {
        const cmp = w.kind === 'compare';
        const multi = evalMulti(everything, cmp ? { ...w, refDefs: refDefsOf(w) } : w, ctx);
        if (cmp && multi.series.length < 2) { html += `<section class="${cls}" data-i="${i}"><div>${head(false)}<p class="note">Les stats comparées ont été supprimées : ouvre ✎ pour en choisir d’autres.</p></div></section>`; return; }
        const r0 = multi.series[0];
        const legacy = !cmp && !w.viz && !(w.more || []).length && !w.split && !w.cumul && !w.pct && !w.prev && !goal;
        const chart = legacy
          ? timeSeries(seriesFromVals(multi), { gran: multi.gran, label: 'éléments', onPick: (pt) => openQ(`${q} ${duringBucket(pt.k, multi.gran)}`.trim()) })
          : multiSeries(multi, { viz: w.viz || (multi.series.length > 1 ? 'lines' : 'bars'), cumul: !!w.cumul, ma: !!w.ma, pct: !!w.pct, prev: !!w.prev, goal, label: 'éléments', onPick: (si, k, g) => openQ(`${seriesQuery(w, si, multi)} ${duringBucket(k, g)}`.trim()) });
        const single = multi.series.length === 1;
          const total = multi.series.reduce((a, s) => a + s.n, 0);
        push(chart, `<div class="big inl"><button type="button" class="bignum sm" data-open="${esc(withPeriod(single ? q : seriesQuery(w, 0, multi)))}">${fmtInt(single ? r0.n : total)}</button><span class="dl">${esc(single ? delta(r0.n, r0.prev) : multi.split ? 'total, découpé par ' + (w.split === 'lang' ? 'langue' : 'source') : 'total des séries')}</span></div>`, '');
      } else if (w.kind === 'heat') {
        const r = evalWidget(everything, w, ctx);
        const chart = heatmap(r.heat.m, { label: 'tweets' });
        push(chart, `<div class="big inl"><button type="button" class="bignum sm" data-open="${esc(withPeriod(q))}">${fmtInt(r.heat.n)}</button><span class="dl">tweets · heure locale de publication</span></div>`, '');
      } else if (w.kind === 'trend') {
        const r = evalWidget(everything, { ...w, by: w.by || 'word' }, ctx);
        const by = w.by || 'word';
        if (!r.trendOk) { html += `<section class="${cls}" data-i="${i}"><div>${head(false)}<p class="note">Les tendances comparent la période choisie à la précédente : choisis 1 j, 7 j, 30 j, 90 j ou 1 an (pas « Tout »).</p></div></section>`; return; }
        const rows = r.trend.map((x) => ({ label: x.label, n: x.n, sub: `+${x.d} (avant : ${x.prev})`, q: keyQuery(w, by, x.key) }));
        const chart = rows.length ? hbars(rows, { label: 'éléments', labelW: 200, onPick: (x) => openQ(withPeriod(x.q)) }) : { html: '<p class="muted">Rien ne monte nettement sur cette période.</p>', table: { head: [''], rows: [] }, bind() {} };
        push(chart, `<p class="sub">Ce qui apparaît plus souvent que sur la période précédente (${esc(BYS[by] || by)}).</p>`, '');
      } else {
        const r = evalWidget(everything, w, ctx);
        const by = w.by || 'author';
        const rows = (r.top || []).map((x) => ({ label: x.label, n: x.n, q: keyQuery(w, by, x.key) }));
        const chart = w.viz === 'donut' ? donut(rows.slice(0, 8), { label: 'éléments', onPick: (x) => openQ(withPeriod(x.q)) }) : hbars(rows, { label: 'éléments', labelW: 200, onPick: (x) => openQ(withPeriod(x.q)) });
        push(chart, `<div class="big inl"><button type="button" class="bignum sm" data-open="${esc(withPeriod(q))}">${fmtInt(r.n)}</button><span class="dl">${esc(groupedNote(r) || delta(r.n, r.prev))}</span></div>`, '');
      }
    });
    html += '</div>';
  }
  app.innerHTML = html;
  app.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openQ(b.dataset.open)));
  $('w-add').onclick = () => editWidget(null);
  $('w-cmp').onclick = () => editCompare(null);
  $('d-manage').onclick = () => manageDetectors();
  $('p-manage').onclick = () => manageSources();
  app.querySelectorAll('[data-b]').forEach((b) => (b.onclick = () => { board = b.dataset.b; try { localStorage.setItem('xbs.stats.board', board); } catch {} render(); }));
  $('b-add').onclick = async () => {
    const name = (prompt('Nom du nouveau tableau de bord :') || '').trim();
    if (!name) return;
    const b = { id: uid(), name: name.slice(0, 40) };
    boards.push(b); board = b.id; try { localStorage.setItem('xbs.stats.board', board); } catch {}
    await saveBoards(); render();
  };
  $('b-ren').onclick = async () => {
    const cur = allBoards().find((b) => b.id === board);
    const name = (prompt('Nouveau nom :', cur.name) || '').trim();
    if (!name) return;
    if (board === 'main') MAIN.name = name.slice(0, 40); else boards.find((b) => b.id === board).name = name.slice(0, 40);
    await setMeta('dashMainName', MAIN.name); await saveBoards(); render();
  };
  $('b-del')?.addEventListener('click', async () => {
    const n = widgets.filter((w) => w.board === board).length;
    if (!confirm(`Supprimer ce tableau ?${n ? ` Ses ${n} stat(s) seront déplacées dans « ${MAIN.name} ».` : ''}`)) return;
    widgets.forEach((w) => { if (w.board === board) w.board = 'main'; });
    boards = boards.filter((b) => b.id !== board); board = 'main';
    await saveBoards(); await saveWidgets(); render();
  });
  $('tpl-sel').onchange = async (e) => {
    if (e.target.value === '') return;
    widgets.push({ id: uid(), board, ...structuredClone(TEMPLATES[+e.target.value]) }); await saveWidgets(); render();
  };
  app.querySelectorAll('[data-tpl]').forEach((b) => (b.onclick = async () => {
    if (b.dataset.tpl === 'launch') return editDetector(null, LAUNCH_DETECTOR);
    widgets.push({ id: uid(), board, ...structuredClone(TEMPLATES[+b.dataset.tpl]) }); await saveWidgets(); render();
  }));
  // glisser-déposer : on attrape la poignée ⠿, on dépose sur une autre carte
  app.querySelectorAll('.card.mine[data-i]').forEach((el) => {
    el.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('text/plain', el.dataset.i); el.classList.add('dragging'); });
    el.addEventListener('dragend', () => { el.draggable = false; el.classList.remove('dragging'); app.querySelectorAll('.over').forEach((n) => n.classList.remove('over')); });
    el.addEventListener('dragover', (ev) => { ev.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      const from = Number(ev.dataTransfer.getData('text/plain')), to = Number(el.dataset.i);
      if (Number.isNaN(from) || from === to) return;
      const [moved] = widgets.splice(from, 1);
      widgets.splice(to, 0, moved);
      await saveWidgets(); render();
    });
  });
  app.querySelectorAll('.wact button').forEach((b) => {
    const i = +b.dataset.i, a = b.dataset.act;
    if (a === 'grab') { b.addEventListener('pointerdown', () => { const c = b.closest('.card'); c.draggable = true; }); return; }
    b.onclick = async () => {
      const sameBoard = (j) => boardOf(widgets[j]) === boardOf(widgets[i]);
      if (a === 'edit') return widgets[i].kind === 'compare' ? editCompare(i) : editWidget(i);
      if (a === 'csv' || a === 'png') { const c = cards.find((x) => x.id === b.closest('.card').id); if (!c) return; return a === 'csv' ? exportCsv(c.chart, c.title) : exportPng(document.getElementById(c.id), c.title); }
      if (a === 'dup') widgets.splice(i + 1, 0, { ...structuredClone(widgets[i]), id: uid(), title: widgets[i].title + ' (copie)' });
      if (a === 'up') { let j = i - 1; while (j >= 0 && !sameBoard(j)) j--; if (j >= 0) [widgets[j], widgets[i]] = [widgets[i], widgets[j]]; }
      if (a === 'down') { let j = i + 1; while (j < widgets.length && !sameBoard(j)) j++; if (j < widgets.length) [widgets[j], widgets[i]] = [widgets[i], widgets[j]]; }
      if (a === 'del') { if (!confirm(`Supprimer « ${widgets[i].title} » ?`)) return; widgets.splice(i, 1); }
      await saveWidgets(); render();
    };
  });
}
// points d'une seule série (ancien affichage en barres + moyenne 7 j)
function seriesFromVals(multi) {
  const v = multi.series[0].vals;
  return multi.keys.map((k, i) => ({ k, n: v[i], ma: v.slice(Math.max(0, i - 6), i + 1).reduce((a, b) => a + b, 0) / Math.min(7, i + 1) }));
}

// ---------- comparaison de stats existantes ----------
const comparable = () => widgets.filter((x) => x.kind === 'number' || x.kind === 'series');
const refDefsOf = (w) => (w.refs || []).map((id) => widgets.find((x) => x.id === id)).filter((x) => x && (x.kind === 'number' || x.kind === 'series'))
  .map((x) => ({ def: { ...x, more: undefined, split: undefined, slabel: undefined, kind: 'number' }, label: x.title || 'Sans titre' }));
function editCompare(i) {
  const w = i === null ? { id: uid(), board, kind: 'compare', title: '', refs: [], viz: 'lines' } : { ...widgets[i] };
  const d = dialog();
  const opt = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
  const list = comparable();
  d.innerHTML = `<form method="dialog" class="ed"><h3>${i === null ? 'Comparer des stats' : 'Modifier la comparaison'}</h3>
    <label>Nom<input name="title" value="${esc(w.title)}" placeholder="Ex. : Robotique vs IA"></label>
    <div class="dsel"><span class="lab">Stats à comparer <span class="hint">coche-en au moins deux ; le graphique suit leurs réglages (requête, détecteurs, regroupement…)</span></span>
      <div class="dlist">${list.map((x) => `<label class="chk"><input type="checkbox" name="refs" value="${x.id}"${(w.refs || []).includes(x.id) ? ' checked' : ''}> ${esc(x.title || 'Sans titre')} <span class="hint">${esc(KINDS[x.kind])}${x.kind === 'series' && (x.more || []).length ? ' · seule la première série est reprise' : ''}</span></label>`).join('') || '<span class="muted">Aucune stat « Nombre » ou « Courbe » pour l’instant.</span>'}</div></div>
    <div class="vopts"><label>Affichage <select name="viz">${opt(VIZ, w.viz || 'lines')}</select></label>
      <label class="chk"><input type="checkbox" name="cumul"${w.cumul ? ' checked' : ''}> Cumul</label>
      <label class="chk"><input type="checkbox" name="ma"${w.ma ? ' checked' : ''}> Lissage 7 j</label>
      <label class="chk"><input type="checkbox" name="pct"${w.pct ? ' checked' : ''}> Parts en %</label>
      <label class="chk"><input type="checkbox" name="prev"${w.prev ? ' checked' : ''}> Période précédente en pointillés</label>
      <label>Taille <select name="size">${opt(SIZES, w.size || '')}</select></label></div>
    <p class="warn" id="cmp-warn" hidden>Choisis au moins deux stats.</p>
    <menu><button value="cancel" class="gbtn">Annuler</button><button value="ok" class="pbtn" id="cmp-ok">Créer le graphique</button></menu></form>`;
  const f = d.querySelector('form');
  const read = () => { const fd = new FormData(f); return { ...w, title: fd.get('title').trim(), refs: fd.getAll('refs'), viz: fd.get('viz'), cumul: fd.get('cumul') === 'on', ma: fd.get('ma') === 'on', pct: fd.get('pct') === 'on', prev: fd.get('prev') === 'on', size: fd.get('size') || '' }; };
  $('cmp-ok').addEventListener('click', (ev) => { if (read().refs.length < 2) { ev.preventDefault(); $('cmp-warn').hidden = false; } });
  d.onclose = async () => {
    if (d.returnValue !== 'ok') return;
    const nw = read();
    if (!nw.title) nw.title = nw.refs.map((id) => widgets.find((x) => x.id === id)?.title).filter(Boolean).join(' vs ') || 'Comparaison';
    if (i === null) widgets.push(nw); else widgets[i] = nw;
    await saveWidgets(); render();
  };
  d.showModal();
}

// ---------- éditeur d'une stat ----------
function dialog() {
  let d = $('dlg');
  if (!d) { d = document.createElement('dialog'); d.id = 'dlg'; document.body.append(d); }
  return d;
}
async function editWidget(i, init) {
  const w = i === null ? { id: uid(), board, title: '', kind: 'number', q: '', dets: [], detMode: 'and', source: 'all', by: 'author', ...init } : { ...widgets[i] };
  w.dets = detsOf(w); delete w.det;
  const more = structuredClone(w.more || []);
  const d = dialog();
  const opt = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
  d.innerHTML = `<form method="dialog" class="ed"><h3>${i === null ? 'Nouvelle stat' : 'Modifier la stat'}</h3>
    <label>Nom<input name="title" value="${esc(w.title)}" placeholder="Ex. : Lancements"></label>
    <div class="row"><label>Forme<select name="kind">${opt(Object.fromEntries(Object.entries(KINDS).filter(([k]) => k !== 'compare')), w.kind)}</select></label><label>Source<select name="source">${opt(SOURCES, w.source || 'all')}</select></label>
      <label class="byl">Regrouper par<select name="by">${opt(BYS, w.by || 'author')}</select></label></div>
    <div id="optbox" class="jv dd">
      <div class="vopts" id="vseries"><label>Affichage <select name="viz">${opt(VIZ, w.viz || '')}</select></label>
        <label class="chk"><input type="checkbox" name="cumul"${w.cumul ? ' checked' : ''}> Cumul</label>
        <label class="chk"><input type="checkbox" name="ma"${w.ma ? ' checked' : ''}> Lissage 7 j</label>
        <label class="chk"><input type="checkbox" name="pct"${w.pct ? ' checked' : ''}> Parts en % <span class="hint">(plusieurs séries)</span></label>
        <label class="chk"><input type="checkbox" name="prev"${w.prev ? ' checked' : ''}> Période précédente en pointillés</label>
        <label>Découper par <select name="split"><option value="">—</option><option value="source"${w.split === 'source' ? ' selected' : ''}>Source (X / YouTube)</option><option value="lang"${w.split === 'lang' ? ' selected' : ''}>Langue</option></select></label></div>
      <div class="vopts" id="vtop"><label>Affichage <select name="tviz">${opt(TVIZ, w.viz === 'donut' ? 'donut' : 'bars')}</select></label></div>
      <div class="vopts"><label>Objectif <input name="goal" type="number" min="0" step="any" value="${w.goal || ''}" placeholder="aucun" style="width:90px"></label>
        <label>Taille <select name="size">${opt(SIZES, w.size || '')}</select></label></div>
    </div>
    <div id="msbox"><span class="lab" id="mslab">Séries à comparer</span> <span class="hint" id="mshint">la requête et les détecteurs ci-dessous forment la première série ; chaque série ajoutée a les siens</span>
      <label id="slabl" class="inl">Nom de la première série <input name="slabel" value="${esc(w.slabel || '')}" placeholder="ex. : Robotique"></label>
      <div id="msrows"></div><button type="button" class="gbtn" id="ms-add">+ Ajouter une série</button></div>
    <label>Requête <span class="hint">mots (tous requis), <code>a | b</code> = l’un ou l’autre, <code>from:@x</code>, <code>has:link</code>, <code>lang:fr</code>, <code>playlist:"…"</code>, <code>viewed:no</code>…</span><input name="q" value="${esc(w.q)}" placeholder="vide = tout"></label>
    <div class="jv dd"><label class="chk"><input type="checkbox" name="noq"${w.noQuotes ? ' checked' : ''}> Ignorer les tweets qui citent un autre tweet</label>
      <label class="chk"><input type="checkbox" name="dd"${w.dedupe?.on ? ' checked' : ''}> Compter des sujets distincts <span class="hint">(plusieurs tweets sur le même sujet = un seul)</span></label>
      <label class="chk"><input type="checkbox" name="po"${w.primaryOnly ? ' checked' : ''}> Ne compter que mes <b>sources primaires</b> <span class="hint">(comptes déclarés dans « Sources primaires » : ${primaryList.length})</span></label>
      <label class="chk"><input type="checkbox" name="oo"${w.officialOnly ? ' checked' : ''}> Ne compter que les <b>annonces officielles</b> <span class="hint">(jugées par Jev : l’entreprise elle-même, pas un commentaire)</span></label>
      <div id="offbox"><button type="button" class="gbtn" id="off-go">Faire juger par Jev</button> <button type="button" class="gbtn" id="off-stop" hidden>Arrêter</button> <span class="muted" id="offmsg"></span></div>
      <div id="ddbox"${w.dedupe?.on ? '' : ' hidden'}><span class="hint">Regroupés si : même tweet cité, même page citée, ou sens quasi identique à moins de quelques jours. Un sujet est daté de son premier enregistrement.</span>
        <label>Ressemblance minimale ≥ <b id="dsv"></b> <input type="range" name="dsim" min="0.8" max="0.98" step="0.01" value="${w.dedupe?.sim ?? 0.92}"></label>
        <label>Fenêtre : <b id="ddv"></b> jour(s) <input type="range" name="dday" min="1" max="30" step="1" value="${w.dedupe?.days ?? 7}"></label></div></div>
    <div class="dsel"><span class="lab">Détecteurs (sens) <span class="hint">facultatif — se combinent avec la requête</span></span>
      <div class="dlist">${detectors.map((x) => `<label class="chk"><input type="checkbox" name="dets" value="${x.id}"${w.dets.includes(x.id) ? ' checked' : ''}> ${esc(x.name)}</label>`).join('') || '<span class="muted">Aucun détecteur pour l’instant.</span>'}</div>
      <div class="row2"><label class="inl" id="dm">Combiner <select name="detMode"><option value="and"${w.detMode !== 'or' ? ' selected' : ''}>ET : tous les détecteurs cochés</option><option value="or"${w.detMode === 'or' ? ' selected' : ''}>OU : au moins un</option></select></label><button type="button" class="gbtn" id="ed-newdet">+ Nouveau détecteur</button></div></div>
    <div class="pv" id="pv">…</div>
    <menu><button value="cancel" class="gbtn">Annuler</button><button value="ok" class="pbtn" id="ed-ok">Enregistrer</button></menu></form>`;
  const f = d.querySelector('form');
  const read = () => { const fd = new FormData(f); return { ...w, title: fd.get('title').trim(), kind: fd.get('kind'), source: fd.get('source'), by: fd.get('by'), q: fd.get('q').trim(), dets: fd.getAll('dets'), detMode: fd.get('detMode'), slabel: (fd.get('slabel') || '').trim(), more: more.map((m) => ({ ...m })), viz: fd.get('kind') === 'top' ? (fd.get('tviz') === 'donut' ? 'donut' : '') : fd.get('viz') || '', cumul: fd.get('cumul') === 'on', ma: fd.get('ma') === 'on', pct: fd.get('pct') === 'on', prev: fd.get('prev') === 'on', split: fd.get('split') || '', goal: Number(fd.get('goal')) || 0, size: fd.get('size') || '', noQuotes: fd.get('noq') === 'on', primaryOnly: fd.get('po') === 'on', officialOnly: fd.get('oo') === 'on', dedupe: { on: fd.get('dd') === 'on', sim: Number(fd.get('dsim')), days: Number(fd.get('dday')) } }; };
  const drawRows = () => {
    $('msrows').innerHTML = more.map((m, k) => `<div class="msrow" data-k="${k}"><label>Nom<input data-f="label" value="${esc(m.label || '')}" placeholder="Série ${k + 2}"></label><label>Requête<input data-f="q" value="${esc(m.q || '')}" placeholder="vide = tout"></label>
      <button type="button" class="gbtn" data-rm="${k}" title="Retirer cette série">✕</button>
      <label>Source<select data-f="source"><option value="">comme la première</option>${opt(SOURCES, m.source || '')}</select></label>
      <div class="dl2">${detectors.map((x) => `<label class="chk"><input type="checkbox" data-f="det" value="${x.id}"${(m.dets || []).includes(x.id) ? ' checked' : ''}> ${esc(x.name)}</label>`).join(' ') || '<span class="muted">Aucun détecteur.</span>'}</div></div>`).join('');
  };
  drawRows();
  $('ms-add').onclick = () => { more.push({ label: '', q: '', dets: [], source: '' }); drawRows(); preview(); };
  $('msrows').addEventListener('click', (ev) => { const b = ev.target.closest('[data-rm]'); if (!b) return; more.splice(+b.dataset.rm, 1); drawRows(); preview(); });
  $('msrows').addEventListener('input', (ev) => {
    const row = ev.target.closest('.msrow'); if (!row) return;
    const m = more[+row.dataset.k], fld = ev.target.dataset.f;
    if (fld === 'det') m.dets = [...row.querySelectorAll('[data-f="det"]:checked')].map((x) => x.value);
    else if (fld) m[fld] = ev.target.value;
  });
  $('msrows').addEventListener('change', (ev) => { const row = ev.target.closest('.msrow'); if (row) { const m = more[+row.dataset.k]; if (ev.target.dataset.f === 'det') m.dets = [...row.querySelectorAll('[data-f="det"]:checked')].map((x) => x.value); } });
  let timer = 0, seq = 0;
  const preview = async () => {
    const draft = read(), my = ++seq;
    f.querySelector('.byl').style.display = draft.kind === 'top' || draft.kind === 'trend' ? '' : 'none';
    const isS = draft.kind === 'series', isR = draft.kind === 'ratio';
    $('vseries').style.display = isS ? '' : 'none'; $('vtop').style.display = draft.kind === 'top' ? '' : 'none';
    $('msbox').style.display = isS || isR ? '' : 'none';
    $('mslab').textContent = isR ? 'Ratio : la requête ci-dessous ÷ la série ci-dessous' : 'Séries à comparer';
    $('mshint').textContent = isR ? 'ex. : « avec lien » ÷ « tous les tweets »' : 'la requête et les détecteurs ci-dessous forment la première série ; chaque série ajoutée a les siens';
    $('ms-add').style.display = more.length >= (isR ? 1 : 4) ? 'none' : '';
    $('ms-add').textContent = isR ? '+ Ajouter le dénominateur' : '+ Ajouter une série';
    f.querySelector('select[name="split"]').disabled = more.length > 0;
        f.querySelector('#dm').style.display = draft.dets.length > 1 ? '' : 'none';
    $('ddbox').hidden = !draft.dedupe.on;
    $('dsv').textContent = draft.dedupe.sim.toFixed(2); $('ddv').textContent = draft.dedupe.days;
    const { sets } = await detectorSetsFor(new Set([...draft.dets, ...more.flatMap((m) => m.dets || [])]));
    const vecs = draft.dedupe.on ? (await loadVectors()).vecs : null;
    if (my !== seq) return;
    const pctx = { sv: savedInfo(all, Date.now()), now: Date.now(), rangeDays: range, detSets: sets, vecs, primary: primarySet(), official: official.m };
    const r = evalWidget(everything, { ...draft, kind: 'number' }, pctx);
    let ser = '';
    if ((draft.kind === 'series' || draft.kind === 'ratio') && (more.length || draft.split)) {
      const mu = evalMulti(everything, draft, pctx);
      ser = `<p class="muted">${mu.series.map((x) => `${esc(x.label)} : <b>${fmtInt(x.n)}</b>`).join(' · ')}${draft.kind === 'ratio' && mu.series[1]?.n ? ` · ratio ${(mu.series[0].n / mu.series[1].n * 100).toFixed(1).replace('.', ',')} %` : ''}</p>`;
    }
    const idm = byId();
    const sizes = draft.dets.map((id) => [detectors.find((x) => x.id === id)?.name || id, sets.get(id)?.size ?? 0]);
    const empty = sizes.filter(([, n]) => n === 0).map(([nm]) => nm);
    const warn = empty.length ? `<p class="warn">⚠ ${esc(empty.join(', '))} ne retien${empty.length > 1 ? 'nent' : 't'} <b>aucun élément</b> : le seuil est trop haut (ou les exemples n’ont pas été analysés). Ouvre « Détecteurs » › Modifier : une suggestion de seuil y est proposée.</p>` : sizes.length ? `<p class="muted">${sizes.map(([nm, n]) => `${esc(nm)} : ${fmtInt(n)} retenus au total`).join(' · ')}</p>` : '';
    $('pv').innerHTML = `${warn}${ser}<b>${fmtInt(r.n)}</b> ${r.grouped ? 'sujet(s) distinct(s)' : 'élément(s)'} sur la période (${esc(rangeLabel())})${r.grouped ? ` · ${fmtInt(r.tweets)} tweets regroupés${r.limited ? ' (regroupement par le sens désactivé : trop d’éléments)' : ''}` : ''}${r.prev != null && delta(r.n, r.prev) ? ` · ${esc(delta(r.n, r.prev))}` : ''}<ol>${r.matched.slice(0, 5).map(({ t, day, members }) => `<li><span class="muted">${esc(day)}</span> ${esc(textOf(idm.get(t.id) || t))}${members.length > 1 ? ` <span class="jvt y" title="${esc(members.map((m) => '@' + m.handle).join(', '))}">+ ${members.length - 1} similaire${members.length > 2 ? 's' : ''}</span>` : ''}</li>`).join('')}</ol>`;
  };
  f.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(preview, 250); });
  f.addEventListener('change', preview);
  let offAbort = null;
  const offMsg = (t) => { $('offmsg').textContent = t; };
  const offTargets = async (draft) => { // tweets à faire juger : tous les candidats si « annonces officielles », sinon seulement les membres de groupes
    const { sets } = await detectorSetsFor(new Set(draft.dets));
    const vecs = draft.dedupe.on ? (await loadVectors()).vecs : null;
    const r = evalWidget(everything, { ...draft, kind: 'number', officialOnly: false }, { sv: savedInfo(all, Date.now()), now: Date.now(), rangeDays: null, detSets: sets, vecs, primary: primarySet(), official: official.m });
    const seen = new Map();
    for (const u of r.matched) if (draft.officialOnly || u.members.length > 1) for (const t of u.members) if (!isVideoItem(t) && !(t.id in official.m)) seen.set(t.id, t);
    return [...seen.values()];
  };
  const offJudge = async () => {
    const settings = await getSettings(), draft = read();
    if (!decisionReady(settings)) return offMsg('Configure d’abord Jev (clé, modèle) dans ⚙ du panneau de recherche.');
    if (official.v !== OFFICIAL_DESC) official = { v: OFFICIAL_DESC, m: {} };
    const items = (await offTargets(draft)).map(judgeText);
    if (!items.length) return offMsg(draft.officialOnly ? 'Rien à juger : tout est déjà jugé.' : 'Rien à juger : aucun groupe de tweets similaires non jugés (active « sujets distincts » pour que Jev départage les groupes).');
    const est = estimateJudgeCost(OFFICIAL_DESC, items.map((x) => x.text), settings.decision.priceInPerM);
    if (!confirm(`Envoyer le texte de ${items.length} tweet(s) à ${settings.decision.url} (modèle ${settings.decision.model}) ?\nJev dira si chacun est l’annonce de l’entreprise elle-même.\nCoût estimé : ${fmtDollars(est.dollars)} (≈ ${Math.round(est.tokens / 1000)} k tokens d’entrée ; la sortie est gratuite). Chaque tweet est jugé une seule fois.`)) return;
    offAbort = new AbortController();
    $('off-go').disabled = true; $('off-stop').hidden = false;
    let done = 0;
    try {
      offMsg(`Jugement en cours… 0/${items.length}`);
      const r = await jevJudge(settings.decision, OFFICIAL_DESC, items, { signal: offAbort.signal, onBatch: async (b) => {
        for (const [id, p] of b) official.m[id] = p;
        done += b.size; offMsg(`Jugement en cours… ${done}/${items.length}`); await saveOfficial();
      } });
      offMsg(r.error ? `Interrompu (${done}/${items.length}) : ${r.error}` : `Terminé : ${done} tweet(s) jugé(s).`);
    } catch (e) { offMsg('⚠ ' + e.message); } finally { offAbort = null; $('off-go').disabled = false; $('off-stop').hidden = true; preview(); }
  };
  $('off-go').onclick = offJudge;
  $('off-stop').onclick = () => offAbort?.abort();
  $('ed-newdet').onclick = () => { d.close('cancel'); editDetector(null, { ...LAUNCH_DETECTOR, name: '', desc: '', examples: [] }, w); };
  d.onclose = async () => {
    if (d.returnValue !== 'ok') return;
    const nw = read();
    if (!nw.title) nw.title = nw.q || (nw.dets.length ? nw.dets.map((id) => detectors.find((x) => x.id === id)?.name).filter(Boolean).join(nw.detMode === 'or' ? ' ou ' : ' + ') : '') || 'Ma stat';
    if (i === null) widgets.push(nw); else widgets[i] = nw;
    await saveWidgets(); render();
  };
  d.showModal();
  preview();
}

// ---------- sources primaires ----------
// Comptes officiels (OpenAI, Anthropic…) : ils représentent un sujet avant les commentateurs, et une stat peut ne compter qu'eux.
function manageSources() {
  const d = dialog();
  d.innerHTML = `<form method="dialog" class="ed"><h3>Sources primaires</h3>
    <p class="hint">Un @compte par ligne. Quand plusieurs tweets parlent du même sujet, celui d’une source primaire est affiché en premier (recherche et stats), et une stat peut ne compter qu’elles.</p>
    <textarea name="h" rows="10" placeholder="@openai&#10;@anthropicai">${esc(primaryList.map((h) => '@' + handleKey(h)).join('\n'))}</textarea>
    <div class="row2"><button type="button" class="gbtn" id="ps-sug">Proposer d’après mes bookmarks</button><span class="muted" id="ps-msg"></span></div>
    <menu><button value="cancel" class="gbtn">Annuler</button><button value="ok" class="pbtn">Enregistrer</button></menu></form>`;
  const ta = d.querySelector('textarea');
  const parse = () => [...new Set((ta.value.match(/@?[A-Za-z0-9_]{1,15}/g) || []).map(handleKey))];
  $('ps-sug').onclick = () => {
    const have = new Set(parse());
    const sug = suggestPrimary(all, 40).filter((x) => !have.has(x.handle));
    ta.value = [...parse().map((h) => '@' + h), ...sug.map((x) => '@' + x.handle)].join('\n');
    $('ps-msg').textContent = sug.length ? `${sug.length} comptes ajoutés (les plus mentionnés par tes autres tweets) : supprime ceux qui ne sont pas des sources officielles.` : 'Aucune suggestion de plus.';
  };
  d.onclose = async () => {
    if (d.returnValue !== 'ok') return;
    primaryList = parse();
    await setMeta('primarySources', primaryList);
    render();
  };
  d.showModal();
}

// ---------- détecteurs ----------
function manageDetectors() {
  const d = dialog();
  d.innerHTML = `<form method="dialog" class="ed"><h3>Détecteurs</h3>
    <p class="muted">Un détecteur reconnaît un <b>type de contenu</b> par son sens (« annonce d’un lancement », « recrutement »…), dans toutes les langues. Il sert dans les stats et dans la recherche (<code>is:nom</code>).</p>
    <ul class="dets">${detectors.map((x, k) => `<li><b>${esc(x.name)}</b> <span class="muted">is:${esc(slugOf(x.name))} · seuil ${x.threshold.toFixed(2)}</span> <button type="button" class="gbtn" data-e="${k}">Modifier</button> <button type="button" class="gbtn" data-x="${k}">Supprimer</button></li>`).join('') || '<li class="muted">Aucun détecteur.</li>'}</ul>
    <div class="row2"><button type="button" class="gbtn" id="dn">+ Nouveau</button><button type="button" class="gbtn" id="dl">+ Modèle « Lancements »</button></div>
    <menu><button value="cancel" class="pbtn">Fermer</button></menu></form>`;
  d.querySelectorAll('[data-e]').forEach((b) => (b.onclick = () => { d.close('cancel'); editDetector(+b.dataset.e); }));
  d.querySelectorAll('[data-x]').forEach((b) => (b.onclick = async () => {
    const k = +b.dataset.x;
    if (!confirm(`Supprimer le détecteur « ${detectors[k].name} » ? Les stats qui l’utilisent seront vidées.`)) return;
    const id = detectors[k].id; detectors.splice(k, 1);
    widgets.forEach((w) => { w.dets = detsOf(w).filter((x) => x !== id); delete w.det; });
    await Promise.all([saveDetectors(), saveWidgets()]); d.close('cancel'); render();
  }));
  $('dn').onclick = () => { d.close('cancel'); editDetector(null); };
  $('dl').onclick = () => { d.close('cancel'); editDetector(null, LAUNCH_DETECTOR); };
  d.onclose = null;
  d.showModal();
}

// Texte envoyé à Jev pour un élément.
const jtext = (t) => ({ id: t.id, text: isVideoItem(t) ? `${t.text} — ${t.name}${t.desc ? ' — ' + t.desc : ''}` : `${t.name} (@${t.handle}) : ${decodeEntities(t.text)}${t.quoted ? ' | cite : ' + decodeEntities(t.quoted.text) : ''}` });

async function editDetector(k, init, backTo) {
  const base = k === null ? { id: uid(), name: '', desc: '', examples: [], threshold: 0.55, pos: [], neg: [], protos: {}, protoKey: '', ...init } : JSON.parse(JSON.stringify(detectors[k]));
  const det = { ...base, pos: [...(base.pos || [])], neg: [...(base.neg || [])] };
  const d = dialog();
  d.innerHTML = `<form method="dialog" class="ed wide"><h3>${k === null ? 'Nouveau détecteur' : 'Modifier le détecteur'}</h3>
    <label>Nom<input name="name" value="${esc(det.name)}" placeholder="Ex. : Lancements"></label>
    <label>Description <span class="hint">une phrase : ce que tu cherches</span><input name="desc" value="${esc(det.desc)}"></label>
    <label>Exemples <span class="hint">un par ligne, dans n’importe quelle langue (plus il y en a de variés, mieux c’est)</span><textarea name="examples" rows="5">${esc(det.examples.join('\n'))}</textarea></label>
    <label>Seuil de ressemblance <b id="thv"></b> <span class="hint">plus bas = plus de résultats, moins sûrs</span><input type="range" name="th" min="0" max="0.9" step="0.01" value="${det.threshold}"></label>
    <div class="jv"><label class="chk"><input type="checkbox" name="ln"${det.learn?.on === false ? '' : ' checked'}> Apprendre de mes ✓ et ✗ <span class="hint">(les éléments très semblables à un de tes choix le suivent)</span></label>
      <div id="lnbox"><label>Ressemblance minimale ≥ <b id="lsv"></b> <input type="range" name="ls" min="0.75" max="0.98" step="0.01" value="${det.learn?.sim ?? LEARN_SIM}"></label><div id="lrn" class="muted"></div></div></div>
    <div class="jv"><label class="chk"><input type="checkbox" name="cf"${det.confirm?.on ? ' checked' : ''}> Faire confirmer les cas ambigus par Jev <span class="hint">(facultatif : un modèle de décision tranche les éléments proches du seuil)</span></label>
      <div id="jvbox" ${det.confirm?.on ? '' : 'hidden'}><label>Zone ambiguë ± <b id="bdv"></b> autour du seuil <input type="range" name="bd" min="0.03" max="0.2" step="0.01" value="${det.confirm?.band ?? CONFIRM_BAND}"></label>
        <div id="jvstat" class="muted"></div>
        <div class="row2"><label class="inl">Appels au plus <input type="number" name="mx" min="1" max="5000" value="50" style="width:90px"></label><button type="button" class="gbtn" id="jv-go">Juger maintenant</button><button type="button" class="gbtn" id="jv-stop" hidden>Arrêter</button></div>
        <div id="jvmsg" class="muted"></div></div></div>
    <div id="dsug" class="sug" hidden></div>
    <div id="dstat" class="muted">Analyse…</div>
    <div class="cols"><div><h4>Retenus (les moins sûrs)</h4><p class="hint">Ce que le détecteur garde, du moins certain au plus certain. ✗ = « non, ça n’en est pas ».</p><ul class="ex" id="ex-above"></ul></div><div><h4>Écartés (les plus proches)</h4><p class="hint">Ce que le détecteur laisse de côté, du plus proche au plus éloigné. ✓ = « si, ça en est un ».</p><ul class="ex" id="ex-below"></ul></div></div>
    <menu><button value="cancel" class="gbtn">Annuler</button><button value="ok" class="pbtn" id="d-ok">Enregistrer</button></menu></form>`;
  const f = d.querySelector('form');
  const idm = byId();
  const texts = () => { const fd = new FormData(f); return [fd.get('desc').trim(), ...fd.get('examples').split('\n').map((x) => x.trim())].filter(Boolean); };
  const draft = () => { const fd = new FormData(f); return { ...det, name: fd.get('name').trim(), desc: fd.get('desc').trim(), examples: fd.get('examples').split('\n').map((x) => x.trim()).filter(Boolean), threshold: Number(fd.get('th')), confirm: { on: fd.get('cf') === 'on', band: Number(fd.get('bd')) }, learn: { on: fd.get('ln') === 'on', sim: Number(fd.get('ls')) } }; };
  let current = null, seq = 0, embedTimer = 0, protoErr = '', touched = k !== null, learnedNow = null, lseq = 0, lTimer = 0;
  let costPrice = (await getSettings()).decision.priceInPerM;
  const { mid } = await loadVectors();
  const protoKeyOf = (arr) => arr.join('␞');
  const lists = () => {
    const dd = draft();
    $('thv').textContent = dd.threshold.toFixed(2);
    if (!current) return;
    const vd = verdictsOf(dd);
    const set = detectorSet(current, dd, vd, learnedNow);
    $('lsv').textContent = dd.learn.sim.toFixed(2);
    $('lnbox').hidden = !dd.learn.on;
    if (dd.learn.on) { const pl = learnedNow ? [...learnedNow.values()].filter((x) => x > 0).length : 0, mi = learnedNow ? learnedNow.size - pl : 0; $('lrn').textContent = `${dd.pos.length} ✓ et ${dd.neg.length} ✗ de ta part · ${fmtInt(pl)} élément(s) suivent tes ✓ et ${fmtInt(mi)} suivent tes ✗, parce qu’ils leur ressemblent beaucoup`; }
    const st = scoreStats(current), sg = suggestThreshold(current);
    const sug = $('dsug');
    // suggestion : toujours visible si le détecteur ne retient (presque) rien ou si le seuil dépasse le meilleur score
    if (sg && (set.size < 5 || dd.threshold > st.max || Math.abs(sg.threshold - dd.threshold) > 0.05)) {
      sug.hidden = false;
      sug.innerHTML = `${set.size === 0 ? '⚠ <b>Ce seuil ne retient aucun élément.</b> ' : ''}Meilleur score : ${st.max.toFixed(2)} · médiane : ${st.median.toFixed(2)}. Suggestion : seuil <b>${sg.threshold.toFixed(2)}</b> (≈ ${fmtInt(sg.count)} éléments, environ 2 %). <button type="button" class="gbtn" id="sug-apply">Appliquer</button>`;
      $('sug-apply').onclick = () => { f.elements.th.value = sg.threshold; lists(); };
    } else sug.hidden = true;
    $('bdv').textContent = dd.confirm.band.toFixed(2);
    $('jvbox').hidden = !dd.confirm.on;
    if (dd.confirm.on) {
      const pend = ambiguousIds(current, dd, vd).length, judged = Object.values(vd).filter((x) => x >= 0).length;
      const pids = ambiguousIds(current, dd, vd);
      const est = estimateJudgeCost(dd.desc, pids.map((id) => idm.get(id)).filter(Boolean).map((t) => jtext(t).text), costPrice);
      $('jvstat').textContent = `${fmtInt(pend)} cas ambigu(s) à juger${pend ? ` (≈ ${fmtDollars(est.dollars)} pour tous, estimation)` : ''} · ${fmtInt(judged)} déjà jugé(s) par Jev (jamais redemandés)`;
    }
    $('dstat').textContent = `${fmtInt(set.size)} élément(s) retenus au total (sur ${fmtInt(current.size)} avec un vecteur) · ${dd.pos.length} validé(s), ${dd.neg.length} écarté(s) à la main`;
    const { above, below } = detectorMargin(current, dd, 8, vd, learnedNow);
    const li = (id, s, tag) => { const t = idm.get(id); const v = vd[id]; const lb = learnedNow?.get(id); return `<li><span class="sc">${s.toFixed(2)}</span>${lb ? ` <span class="jvt ${lb > 0 ? 'y' : 'n'}" title="Suit ton choix sur un élément très semblable">↳ comme ton ${lb > 0 ? '✓' : '✗'}</span>` : ''}${v !== undefined ? ` <span class="jvt ${v >= 50 ? 'y' : 'n'}" title="Verdict de Jev">Jev ${v >= 50 ? 'oui' : 'non'} ${v} %</span>` : ''} ${esc(t ? textOf(t) : id)} <span class="vb"><button type="button" data-v="ok" data-id="${esc(id)}" title="Oui, c’en est un">✓</button><button type="button" data-v="no" data-id="${esc(id)}" title="Non">✗</button></span></li>`; };
    $('ex-above').innerHTML = above.map(([id, s]) => li(id, s)).join('') || '<li class="muted">—</li>';
    $('ex-below').innerHTML = below.map(([id, s]) => li(id, s)).join('') || '<li class="muted">—</li>';
  };
  const recompute = async () => { const my = ++lseq; learnedNow = await learnedOf({ ...draft(), id: det.id }); if (my === lseq) lists(); };
  const analyse = async () => {
    const my = ++seq, tx = texts();
    if (!tx.length) { $('dstat').textContent = 'Ajoute une description ou des exemples.'; current = null; return; }
    const key = protoKeyOf(tx);
    try {
      if (!det.protos?.[mid] || det.protoKey !== key) {
        $('dstat').textContent = 'Analyse des exemples (le modèle se charge la première fois)…';
        const vecs = await embedTexts(tx);
        if (my !== seq) return;
        det.protos = { ...(det.protos || {}), [mid]: vecs }; det.protoKey = key;
      }
      const sc = await scoresOf({ ...det, id: det.id });
      current = sc; protoErr = '';
      learnedNow = await learnedOf({ ...draft(), id: det.id });
      if (k === null && !touched) { const sg = suggestThreshold(sc); if (sg) { f.elements.th.value = sg.threshold; touched = true; } } // nouveau détecteur : seuil de départ réaliste
      lists();
    } catch (e) { protoErr = e.message; $('dstat').textContent = '⚠ ' + e.message; }
  };
  f.addEventListener('input', (ev) => { if (ev.target.name === 'th') touched = true; if (ev.target.name === 'ls' || ev.target.name === 'ln') { lists(); clearTimeout(lTimer); lTimer = setTimeout(recompute, 300); return; } if (ev.target.name === 'th' || ev.target.name === 'bd' || ev.target.name === 'cf') return lists(); clearTimeout(embedTimer); embedTimer = setTimeout(analyse, 900); });
  let abort = null;
  const judge = async () => {
    const dd = draft(), settings = await getSettings();
    const msg = (t) => { $('jvmsg').textContent = t; };
    if (!decisionReady(settings)) return msg('Configure d’abord Jev (clé, modèle) dans ⚙ du panneau de recherche.');
    if (!current) return msg('Les exemples n’ont pas encore été analysés.');
    if (!dd.desc) return msg('Ajoute une description : c’est elle qui est posée à Jev.');
    const vd = verdictsOf(dd);
    const max = Math.max(1, Number(new FormData(f).get('mx')) || 50);
    const ids = ambiguousIds(current, dd, vd).slice(0, max);
    // vie privée : pas d'historique de visionnage envoyé à un service externe sauf autorisation
    const sendable = (t) => settings.aiHistory || !isVideoItem(t) || !(t.watched || []).length || (t.playlists || []).length > 0;
    const items = ids.map((id) => idm.get(id)).filter((t) => t && sendable(t)).map(jtext);
    if (!items.length) return msg('Rien à juger pour l’instant.');
    const est = estimateJudgeCost(dd.desc, items.map((x) => x.text), settings.decision.priceInPerM);
    if (!confirm(`Envoyer le texte de ${items.length} élément(s) à ${settings.decision.url} (modèle ${settings.decision.model}) pour confirmation ?\nCoût estimé : ${fmtDollars(est.dollars)} (≈ ${Math.round(est.tokens / 1000)} k tokens d’entrée à ${settings.decision.priceInPerM} $ le million ; la sortie est gratuite).\nChaque élément est jugé une seule fois ; les verdicts sont conservés.`)) return;
    abort = new AbortController();
    $('jv-go').disabled = true; $('jv-stop').hidden = false;
    let done = 0;
    try {
      msg(`Jugement en cours… 0/${items.length}`);
      const key = verdictKey(dd);
      if (verdicts[det.id]?.key !== key) verdicts[det.id] = { key, v: {} };
      const r = await jevJudge(settings.decision, dd.desc, items, { signal: abort.signal, onBatch: async (b) => {
        for (const [id, p] of b) verdicts[det.id].v[id] = p;
        done += b.size; msg(`Jugement en cours… ${done}/${items.length}`);
        await saveVerdicts(); lists();
      } });
      const sk = r.skipped ? ` (dont ${r.skipped} texte(s) refusé(s) par l’API, ignorés et non redemandés)` : '';
      msg(r.error ? `Interrompu (${done}/${items.length}) : ${r.error}` : `Terminé : ${done} élément(s) jugé(s)${sk}.`);
    } catch (e) { msg('⚠ ' + e.message); } finally {
      abort = null; $('jv-go').disabled = false; $('jv-stop').hidden = true; scoreCache.size; lists();
    }
  };
  $('jv-go').onclick = judge;
  $('jv-stop').onclick = () => abort?.abort();
  d.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-v]');
    if (!b) return;
    const id = b.dataset.id;
    det.pos = det.pos.filter((x) => x !== id); det.neg = det.neg.filter((x) => x !== id);
    (b.dataset.v === 'ok' ? det.pos : det.neg).push(id);
    lists();
    recompute();
  });
  d.onclose = async () => {
    if (d.returnValue === 'ok') {
      const dd = draft();
      if (!dd.name) dd.name = dd.desc.slice(0, 30) || 'Détecteur';
      if (protoErr && !dd.protos?.[mid]) { alert('Détecteur non enregistré : ' + protoErr); }
      else {
        scoreCache.clear();
        if (k === null) detectors.push(dd); else detectors[k] = dd;
        await saveDetectors();
        if (backTo) { backTo.dets = [...(backTo.dets || []), dd.id]; return editWidget(null, backTo); }
      }
    }
    render();
  };
  d.showModal();
  lists();
  analyse();
}

function renderYt(app) {
  const st = computeYtStats(videos, { rangeDays: range });
  const k = st.kpi, rl = range ? RANGES.find(([v]) => v === range)[1] : 'tout';
  if (!videos.length) { app.innerHTML = '<p class="muted">Aucune vidéo YouTube pour l’instant : synchronise tes playlists et ton historique depuis le panneau de recherche.</p>'; return; }
  const last30 = st.series.gran === 'day' ? st.series.points.slice(-30).map((p) => p.n) : [];
  let html = '';
  if (!st.hasHistory) html += '<p class="note">Aucun <b>historique de visionnage</b> synchronisé : seules les statistiques de ta bibliothèque (playlists) sont disponibles. Lance « ▶ Historique YouTube » dans le panneau pour voir l’activité, les chaînes et le temps de visionnage.</p>';
  html += '<div class="kpis">'
    + tile('Vidéos en base', fmtInt(k.videos), `${fmtInt(k.inPlaylists)} dans une playlist`, sparkline(last30), 'hero')
    + (st.hasHistory ? tile(`Visionnages (${rl})`, fmtInt(k.views), `${fmtInt(k.seen)} vidéos différentes`)
      + tile('Temps regardé (estimé)', fmtHours(k.hours), 'durée × progression ; sans progression = vue en entier')
      + tile('Moyenne par jour actif', k.avgPerActiveDay.toFixed(1).replace('.', ','), `${fmtInt(k.activeDays)} jours actifs sur ${fmtInt(k.days)}`)
      + tile('Jour record', fmtInt(k.best.n), k.best.day ? fmtDay(k.best.day) : '')
      + tile('Chaînes regardées', fmtInt(k.channels), `${fmtInt(k.started)} vidéo${k.started > 1 ? "s" : ""} commencée${k.started > 1 ? "s" : ""} sans finir`) : '')
    + tile('À regarder (playlists)', fmtInt(k.backlog), `${fmtHours(k.backlogSec)} de vidéos jamais vues`)
    + tile('« À regarder plus tard »', fmtInt(k.wlBacklog), `${fmtHours(k.wlBacklogSec)} non vues`)
    + '</div>';
  const g = st.series.gran, by = 'par date de visionnage';
  if (st.hasHistory) {
    html += '<h2 class="sec">Activité</h2><div class="grid2">';
    html += card(`Visionnages par ${g === 'day' ? 'jour' : g === 'week' ? 'semaine' : 'mois'}`, `${by}${g === 'day' ? ' · barres = jour, courbe = moyenne sur 7 jours' : ''} · clic = ouvrir ces vidéos`,
      timeSeries(st.series.points, { gran: g, label: 'visionnages', onPick: (p) => openQ(watchedQ(p.k, g)) }), { full: true });
    if (st.heat.length) html += card('Calendrier de l’année', 'visionnages des 12 derniers mois · clic = ouvrir ce jour', calendar(st.heat, { label: 'visionnages', onPick: (d) => openQ(`watched:${d.k}`) }), { full: true });
    html += card('Par jour de la semaine', 'quand tu regardes le plus', columns(WEEKDAYS.map((label, i) => ({ label, n: st.weekday[i] })), { label: 'visionnages' }));
    html += card('Durée des vidéos regardées', 'courtes ou longues ?', hbars(st.durations, { label: 'visionnages', labelW: 110 }));
    html += '</div><h2 class="sec">Chaînes</h2><div class="grid2">';
    html += card('Chaînes les plus regardées', 'visionnages · clic = ouvrir ses vidéos', hbars(st.channels.map((c) => ({ label: c.name || c.handle, n: c.n, q: `source:youtube from:@${c.handle}`, sub: `${fmtHours(c.sec)} regardées (estimé)` })), { label: 'visionnages', labelW: 200, onPick: (r) => openQ(r.q) }), { full: true });
    html += '</div>';
  }
  html += '<h2 class="sec">Bibliothèque</h2><div class="grid2">';
  html += card('Playlists', 'nombre de vidéos en base · clic = ouvrir la playlist', hbars(st.playlists.map((p) => ({ label: p.title, n: p.n, q: `playlist:"${p.title}"` })), { label: 'vidéos', labelW: 200, onPick: (r) => openQ(r.q) }));
  html += '</div><div class="grid2">';
  const cardHtml = (title, sub, inner) => `<section class="card"><header><div><h3>${esc(title)}</h3><p class="sub">${esc(sub)}</p></div></header>${inner}</section>`;
  if (st.words.length) html += cardHtml('Mots des titres', 'hors mots courants · clic = chercher', chips(st.words, (w) => w));
  if (st.oldestBacklog.length) html += cardHtml('« À regarder plus tard » : à ressortir', 'jamais vues, depuis le plus longtemps dans l’index', `<ol class="list">${st.oldestBacklog.map((t) => `<li><b>${esc(t.durationText || '')}</b><a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.name)} — ${esc(decodeEntitiesSafe(t.text))}</a></li>`).join('')}</ol>`);
  if (st.rewatched.length) html += cardHtml('Les plus revues', 'vidéos vues sur plusieurs jours', `<ol class="list">${st.rewatched.map((t) => `<li><b>× ${t.watched.length}</b><a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.name)} — ${esc(decodeEntitiesSafe(t.text))}</a></li>`).join('')}</ol>`);
  html += '</div>';
  app.innerHTML = html;
}
const watchedQ = (k, g) => `watched:${g === 'month' ? k + '-01..' + lastOfMonth(k) : g === 'week' ? k + '..' + shiftDay(k, 6) : k}`;
const decodeEntitiesSafe = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 120);

function render() {
  const app = $('app');
  app.classList.add('loading');
  setTimeout(() => {
    cards.length = 0;
    if (src === 'yt') { renderYt(app); finish(app); return; }
    if (src === 'mine') { renderMine(app).then(() => finish(app), (e) => { app.innerHTML = `<p class="note">⚠ ${esc(e.message)}</p>`; finish(app); }); return; }
    const st = computeStats(all, { rangeDays: range });
    if (!all.length) { app.innerHTML = '<p class="muted">Aucun bookmark pour l’instant : synchronise-les depuis le panneau de recherche.</p>'; app.classList.remove('loading'); return; }
    const k = st.kpi, by = st.savedValid ? 'par date d’enregistrement' : 'par date de publication';
    const last30 = st.series.gran === 'day' ? st.series.points.slice(-30).map((p) => p.n) : [];
    let html = '';
    if (!st.savedValid) html += `<p class="note">Les <b>dates d’enregistrement</b> (quand tu as mis chaque tweet en bookmark) ne sont pas disponibles ou n’ont pas pu être vérifiées : les statistiques d’activité sont calculées <b>par date de publication</b> des tweets, et les graphiques par heure, par jour de la semaine et « âge à l’enregistrement » sont masqués.</p>`;

    html += '<div class="kpis">'
      + tile('Bookmarks' + (range ? ` (${RANGES.find(([v]) => v === range)[1]})` : ''), fmtInt(k.total), `${fmtInt(k.authors)} auteurs différents`, sparkline(last30), 'hero')
      + tile('Moyenne par jour actif', k.avgPerActiveDay.toFixed(1).replace('.', ','), `${fmtInt(k.activeDays)} jours actifs sur ${fmtInt(k.days)}`)
      + tile('Jour record', fmtInt(k.best.n), k.best.day ? fmtDay(k.best.day) : '')
      + tile('Plus longue série', `${fmtInt(k.streakLongest)} j`, `série en cours : ${fmtInt(k.streakCurrent)} j`)
      + tile('7 derniers jours', fmtInt(k.last7), `30 derniers jours : ${fmtInt(k.last30)}`)
      + tile('Avec médias', pct(k.withMedia, k.total), `${fmtInt(k.withMedia)} tweets`)
      + tile('Avec un lien', pct(k.withLink, k.total), `${fmtInt(k.withLink)} tweets`)
      + tile('Likes médians', fmtCompact(k.medianLikes), `total : ${fmtCompact(k.totalLikes)}`)
      + tile('Langue principale', esc(k.langMain || '–'), k.firstPub ? `tweets publiés du ${fmtDay(k.firstPub)} au ${fmtDay(k.lastPub)}` : '')
      + '</div>';

    // ---- activité ----
    const g = st.series.gran;
    const onDay = (p) => openQ(dayQuery(st, p.k, g));
    html += '<h2 class="sec">Activité</h2><div class="grid2">';
    html += card(`Bookmarks par ${g === 'day' ? 'jour' : g === 'week' ? 'semaine' : 'mois'}`, `${by}${g === 'day' ? ' · barres = jour, courbe = moyenne sur 7 jours' : ''} · clic = ouvrir ces tweets`, timeSeries(st.series.points, { gran: g, onPick: onDay }), { full: true });
    if (st.heat.length) html += card('Calendrier de l’année', 'les 12 derniers mois, un carré par jour · clic = ouvrir ce jour', calendar(st.heat, { onPick: (d) => openQ(`saved:${d.k}`) }), { full: true });
    if (st.cumulative.length > 1) html += card('Taille de la collection', `total cumulé ${by}`, cumulative(st.cumulative), { full: true });
    html += '</div>';

    // ---- habitudes (nécessitent les dates d'enregistrement) ----
    if (st.weekday) {
      html += '<h2 class="sec">Habitudes</h2><div class="grid2">';
      html += card('Par jour de la semaine', 'quand tu enregistres le plus', columns(WEEKDAYS.map((label, i) => ({ label, n: st.weekday[i] }))));
      html += card('Par heure de la journée', 'heure locale d’enregistrement', columns(st.hour.map((n, h) => ({ label: String(h), n })), { labelEvery: 3, tipTitle: (d) => `${d.label} h` }));
      if (st.ageAtSave) html += card('Âge du tweet à l’enregistrement', 'tu enregistres… dès la publication, ou longtemps après ?', hbars(st.ageAtSave.map((a) => ({ label: a.label, n: a.n })), { labelW: 110 }));
      html += '</div>';
    }

    // ---- contenu ----
    const typeQ = { video: 'has:video', photo: 'has:image', link: 'has:link' };
    html += '<h2 class="sec">Contenu</h2><div class="grid2">';
    html += card('Types de tweets', 'chaque tweet compte une seule fois (vidéo > photo > lien > citation > texte)', stacked(st.types.map((t) => ({ label: t.label, n: t.n, q: typeQ[t.key] }) ), { onPick: (d) => openQ(d.q) }));
    html += card('Langues', 'code de langue détecté par X', hbars(st.langs.map(([l, n]) => ({ label: l, n, q: `lang:${l}` })), { labelW: 80, onPick: (r) => openQ(r.q) }));
    html += card('Quand les tweets ont été publiés', 'par mois de publication · clic = ouvrir ce mois', columns(st.pubMonths.slice(-24).map((m) => ({ label: m.k.slice(2).replace('-', '/'), n: m.n, k: m.k })), { labelEvery: Math.max(1, Math.ceil(Math.min(24, st.pubMonths.length) / 8)), tipTitle: (d) => d.label, onPick: (d) => openQ(`since:${d.k}-01 until:${lastOfMonth(d.k)}`) }), { full: true });
    html += card('Popularité des tweets enregistrés', 'nombre de likes du tweet', columns(st.likesHist.map((h) => ({ label: h.label, n: h.n })), { tipTitle: (d) => `${d.label} likes` }));
    html += '</div>';

    // ---- sources ----
    html += '<h2 class="sec">Sources</h2><div class="grid2">';
    html += card('Auteurs les plus enregistrés', 'clic = ouvrir ses tweets', hbars(st.authors.slice(0, 20).map((a) => ({ label: a.name && a.name !== a.handle ? `${a.name} (@${a.handle})` : '@' + a.handle, n: a.n, q: `from:@${a.handle}`, sub: `${fmtCompact(a.likes)} likes cumulés` })), { labelW: 200, onPick: (r) => openQ(r.q) }));
    html += card('Sites les plus cités', 'domaines des liens', hbars(st.domains.slice(0, 20).map(([d, n]) => ({ label: d, n, q: d })), { labelW: 200, onPick: (r) => openQ(r.q) }));
    html += '</div><div class="grid2">';
    const cardHtml = (title, sub, inner) => `<section class="card"><header><div><h3>${esc(title)}</h3><p class="sub">${esc(sub)}</p></div></header>${inner}</section>`;
    if (st.hashtags.length) html += cardHtml('Hashtags', 'nombre de tweets · clic = chercher', chips(st.hashtags, (t) => t));
    if (st.mentions.length) html += cardHtml('Comptes les plus mentionnés', 'dans le texte des tweets', chips(st.mentions, (m) => m));
    html += cardHtml('Mots les plus fréquents', 'hors mots courants, une fois par tweet', chips(st.words, (w) => w));
    html += '</div>';

    // ---- pépites ----
    html += '<h2 class="sec">À redécouvrir</h2><div class="grid2">';
    html += cardHtml('Tweets les plus likés', 'parmi ta sélection', `<ol class="list">${st.topLiked.map((t) => `<li><b>${fmtCompact(t.likes)} ♥</b><a href="${esc(t.url)}" target="_blank" rel="noopener">@${esc(t.handle)} — ${esc(t.text)}</a></li>`).join('')}</ol>`);
    if (st.dupLinks.length) html += cardHtml('Liens enregistrés plusieurs fois', 'le même lien dans plusieurs tweets', `<ol class="list">${st.dupLinks.map(([u, n]) => `<li><b>× ${n}</b><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\/(www\.)?/, ''))}</a></li>`).join('')}</ol>`);
    html += '</div>';

    app.innerHTML = html;
    finish(app);
  }, 0);
}

function finish(app) {
  try {
    for (const c of cards) {
      const el = document.getElementById(c.id);
      if (!el) continue;
      c.chart.bind(el.querySelector('.viz'));
      const btn = el.querySelector('.tbl-btn'), tbl = el.querySelector('.tbl'), viz = el.querySelector('.viz');
      if (btn && tbl && viz) btn.onclick = () => { const on = btn.getAttribute('aria-pressed') !== 'true'; btn.setAttribute('aria-pressed', String(on)); tbl.hidden = !on; viz.hidden = on; };
    }
    app.querySelectorAll('.chip-s').forEach((b) => (b.onclick = () => openQ(b.dataset.q)));
  } catch (e) { console.error('[xbs] stats', e); } finally {
    app.classList.remove('loading'); // quoi qu'il arrive, l'écran ne reste jamais grisé
    if (savedScroll != null) { const y = savedScroll; savedScroll = null; requestAnimationFrame(() => window.scrollTo(0, y)); }
  }
}

// ---------- mise à jour automatique : les stats suivent les nouvelles données ----------
// Écoute les messages de l'extension (nouveaux tweets/vidéos, indexation, fin de « Tout mettre à jour »). Au plus un rechargement
// toutes les 45 s, jamais pendant l'édition (boîte de dialogue ouverte) ni onglet caché (rattrapage au retour).
let refreshAt = 0, refreshTimer = 0, refreshDirty = false, vecDirty = false, refreshing = false, savedScroll = null;
const REFRESH_GAP = 45_000;
async function refreshData() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [t0, ov] = await Promise.all([getAllTweets(), getMeta('officialVerdicts')]);
    if (ov?.v === OFFICIAL_DESC) official = ov;
    const t = t0.filter((x) => !x.off);
    everything = t; all = t.filter((x) => !isVideoItem(x)); videos = t.filter(isVideoItem);
    if (vecDirty) { vecCache = null; scoreCache.clear(); learnCache.clear(); vecDirty = false; }
    refreshDirty = false;
    savedScroll = window.scrollY;
    render();
  } catch (e) { console.error('[xbs] refresh', e); } finally { refreshing = false; refreshAt = Date.now(); }
}
function wantRefresh(force = false) {
  refreshDirty = true;
  if (refreshTimer && !force) return; // un rechargement est déjà prévu (pas de report en boucle pendant l'indexation)
  clearTimeout(refreshTimer);
  const wait = force ? 1500 : Math.max(4000, refreshAt + REFRESH_GAP - Date.now());
  refreshTimer = setTimeout(function go() {
    refreshTimer = 0;
    if (document.hidden) return; // rattrapage dans visibilitychange
    if ($('dlg')?.open) { refreshTimer = setTimeout(go, 5000); return; }
    refreshData();
  }, wait);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && refreshDirty) wantRefresh(true); });
try {
  chrome.runtime.onMessage.addListener((m) => {
    switch (m?.type) {
      case 'tweetsAdded': case 'tweetsUpdated': case 'tweetsRemoved': case 'tweetsEnriched': wantRefresh(); break;
      case 'indexProgress': vecDirty = true; wantRefresh(); break;
      case 'indexDone': vecDirty = true; wantRefresh(true); break;
      case 'updateProgress': if (m.step === 'end') { vecDirty = true; wantRefresh(true); } break;
    }
  });
} catch { /* hors extension */ }

drawSources();
drawRanges();
Promise.all([getAllTweets(), getMeta('dashWidgets'), getMeta('dashDetectors'), getMeta('detVerdicts'), getMeta('primarySources'), getMeta('officialVerdicts'), getMeta('dashBoards'), getMeta('dashMainName')]).then(([t0, w, dts, vds, ps, ov, bds, mn]) => { boards = bds || []; if (mn) MAIN.name = mn; verdicts = vds || {}; primaryList = ps || []; official = ov?.v === OFFICIAL_DESC ? ov : { v: OFFICIAL_DESC, m: {} }; const t = t0.filter((x) => !x.off); everything = t; all = t.filter((x) => !isVideoItem(x)); videos = t.filter(isVideoItem); widgets = w || []; detectors = dts || []; render(); }); // ces statistiques portent sur les bookmarks X
