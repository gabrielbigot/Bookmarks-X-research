import { getAllTweets, getMeta, setMeta, getAllVectors, getAllChunkVecs } from './lib/db.js';
import { getSettings } from './lib/settings.js';
import { modelOf } from './lib/models.js';
import { savedInfo, dayKey } from './lib/time.js';
import { detsOf, evalWidget, detectorScores, detectorSet, detectorMargin, ambiguousIds, scoreStats, suggestThreshold, verdictKey, CONFIRM_BAND, textOf, slugOf } from './lib/widgets.js';
import { jevJudge, estimateJudgeCost, fmtDollars } from './lib/jev.js';
import { decodeEntities } from './lib/text.js';
import { decisionReady } from './lib/settings.js';
import { computeStats, TYPE_LABELS } from './lib/stats.js';
import { bindThemeButton } from './lib/theme.js';
import { isVideoItem } from './lib/youtube.js';
import { computeYtStats, fmtHours } from './lib/ytstats.js';
import { timeSeries, cumulative, columns, hbars, stacked, calendar, sparkline, esc, fmtInt, fmtCompact, fmtDay, WEEKDAYS } from './lib/charts.js';

const $ = (id) => document.getElementById(id);
const RANGES = [[1, '1 j'], [7, '7 j'], [30, '30 j'], [90, '90 j'], [365, '1 an'], [null, 'Tout']];
const RKEY = 'xbs.stats.range';
let all = [], videos = [], everything = [], range = 90, src = 'x', widgets = [], detectors = [], verdicts = {};
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
async function detectorSetsFor(ids) {
  const out = new Map(), missing = [];
  for (const id of ids) {
    const det = detectors.find((d) => d.id === id);
    if (!det) continue;
    const sc = await scoresOf(det);
    if (!sc) { missing.push(det.name); out.set(id, new Set()); } else out.set(id, detectorSet(sc, det, verdictsOf(det)));
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

const KINDS = { number: 'Nombre', series: 'Courbe', top: 'Classement' };
const SOURCES = { all: 'Tout', x: 'Bookmarks X', youtube: 'YouTube' };
const BYS = { author: 'Auteurs / chaînes', site: 'Sites cités', lang: 'Langues' };
const detSlugs = (w) => detsOf(w).map((id) => slugOf(detectors.find((d) => d.id === id)?.name)).filter(Boolean);
const wQuery = (w) => [w.q, detSlugs(w).length ? (w.detMode === 'or' ? 'is:' + detSlugs(w).join(',') : detSlugs(w).map((x) => 'is:' + x).join(' ')) : '', w.source === 'x' ? 'source:x' : w.source === 'youtube' ? 'source:youtube' : ''].filter(Boolean).join(' ');
// Ce qui est compté = éléments dont le jour (enregistrement / visionnage / ajout) tombe dans la période : le clic ouvre la même chose.
const duringRange = () => { if (!range) return ''; const to = dayKey(Date.now()), from = dayKey(Date.now() - (range - 1) * 86_400_000); return `during:${from}..${to}`; };
const withPeriod = (q) => [q, duringRange()].filter(Boolean).join(' ');
const duringBucket = (k, g) => `during:${g === 'month' ? k + '-01..' + lastOfMonth(k) : g === 'week' ? k + '..' + shiftDay(k, 6) : k}`;
const rangeLabel = () => (range ? RANGES.find(([v]) => v === range)[1] : 'tout');
const delta = (n, prev) => (prev == null || (n === 0 && prev === 0) ? '' : prev === 0 ? (n ? 'nouveau' : '=') : `${n >= prev ? '▲' : '▼'} ${Math.abs(Math.round(((n - prev) / prev) * 100))} % vs période précédente`);

const TEMPLATES = [
  { title: 'Tweets avec un lien', kind: 'series', q: 'has:link', source: 'x' },
  { title: 'Vidéos YouTube vues', kind: 'series', q: 'viewed:yes', source: 'youtube' },
  { title: 'À regarder, pas encore vu', kind: 'number', q: 'playlist:"à regarder plus tard" viewed:no', source: 'youtube' },
  { title: 'Auteurs les plus enregistrés', kind: 'top', q: '', source: 'x', by: 'author' },
];
const LAUNCH_DETECTOR = { name: 'Lancements', desc: 'Annonce d’un lancement : produit, entreprise, fonctionnalité', examples: ['Today, we launch our new product', 'Introducing our new app, available now', 'We just shipped a major update', 'Aujourd’hui, nous lançons notre startup', 'Lancement officiel de notre nouvelle version'], threshold: 0.4 };

async function renderMine(app) {
  const sv = savedInfo(all, Date.now());
  const needed = new Set(widgets.flatMap(detsOf));
  const { sets, missing } = await detectorSetsFor(needed);
  const ctx = { sv, now: Date.now(), rangeDays: range, detSets: sets };
  let html = `<div class="mine-bar"><button type="button" class="pbtn" id="w-add">+ Ajouter une stat</button><button type="button" class="gbtn" id="d-manage">Détecteurs (${detectors.length})</button></div>`;
  if (missing.length) html += `<p class="note">Détecteur(s) <b>${esc(missing.join(', '))}</b> : les exemples n’ont pas encore été analysés avec le modèle actuel — ouvre « Détecteurs » et enregistre-les à nouveau (le modèle de recherche doit être disponible).</p>`;
  const emptyDets = [...needed].filter((id) => sets.has(id) && sets.get(id).size === 0 && !missing.includes(detectors.find((d) => d.id === id)?.name)).map((id) => detectors.find((d) => d.id === id)?.name).filter(Boolean);
  if (emptyDets.length) html += `<p class="note">⚠ Détecteur(s) <b>${esc(emptyDets.join(', '))}</b> : aucun élément retenu. Le seuil est probablement trop haut : ouvre « Détecteurs » › Modifier, une suggestion de seuil y est proposée.</p>`;
  if (!widgets.length) {
    html += `<p class="muted">Aucune stat personnalisée pour l’instant. Une stat compte ce que tu veux dans le temps, avec le filtre de période du haut : une requête de recherche (mots, <code>from:@…</code>, <code>has:link</code>, <code>playlist:"…"</code>) ou un <b>détecteur</b> qui comprend le sens (par exemple « annonce d’un lancement »).</p>
      <div class="tpl">${TEMPLATES.map((t, i) => `<button type="button" class="gbtn" data-tpl="${i}">+ ${esc(t.title)}</button>`).join('')}<button type="button" class="gbtn" data-tpl="launch">+ Détecteur « Lancements »</button></div>`;
  } else {
    html += '<div class="mine-grid">';
    widgets.forEach((w, i) => {
      const r = evalWidget(everything, w, ctx);
      const q = wQuery(w);
      const head = `<header><div><h3>${esc(w.title || 'Sans titre')}</h3><p class="sub">${esc(KINDS[w.kind])} · ${esc(SOURCES[w.source || 'all'])} · ${esc(rangeLabel())}${q ? ' · ' + esc(q) : ''}</p></div>
        <div class="wact"><button type="button" data-act="edit" data-i="${i}" title="Modifier">✎</button><button type="button" data-act="dup" data-i="${i}" title="Dupliquer">⧉</button><button type="button" data-act="up" data-i="${i}" title="Monter"${i ? '' : ' disabled'}>↑</button><button type="button" data-act="down" data-i="${i}" title="Descendre"${i < widgets.length - 1 ? '' : ' disabled'}>↓</button><button type="button" data-act="del" data-i="${i}" title="Supprimer">✕</button></div></header>`;
      const headT = head.replace('</header>', '<button class="tbl-btn" type="button" aria-pressed="false" title="Afficher les valeurs en tableau">Tableau</button></header>');
      if (w.kind === 'number') {
        html += `<section class="card mine"><div>${head}<div class="big"><button type="button" class="bignum" data-open="${esc(withPeriod(q))}" title="Ouvrir ces éléments dans la recherche (même période)">${fmtInt(r.n)}</button><span class="dl">${esc(delta(r.n, r.prev))}</span></div>${r.noDate && range ? `<p class="sub">${fmtInt(r.noDate)} éléments sans date ne sont pas comptés sur une période.</p>` : ''}</div></section>`;
      } else {
        const chart = w.kind === 'series'
          ? timeSeries(r.series.points, { gran: r.series.gran, label: 'éléments', onPick: (pt) => openQ(`${q} ${duringBucket(pt.k, r.series.gran)}`.trim()) })
          : hbars((r.top || []).map((x) => ({ label: x.label, n: x.n, q: w.by === 'site' ? `${w.q || ''} ${x.key}`.trim() : w.by === 'lang' ? `${w.q || ''} lang:${x.key}`.trim() : `${w.q || ''} from:@${x.key}`.trim() })), { label: 'éléments', labelW: 200, onPick: (x) => openQ(withPeriod(x.q)) });
        const id = 'c' + cards.length;
        cards.push({ id, chart });
        html += `<section class="card mine wide" id="${id}">${headT}<div class="big inl"><button type="button" class="bignum sm" data-open="${esc(withPeriod(q))}">${fmtInt(r.n)}</button><span class="dl">${esc(delta(r.n, r.prev))}</span></div><div class="viz">${chart.html}</div><div class="tbl" hidden>${tableHtml(chart.table)}</div></section>`;
      }
    });
    html += '</div>';
  }
  app.innerHTML = html;
  app.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openQ(b.dataset.open)));
  $('w-add').onclick = () => editWidget(null);
  $('d-manage').onclick = () => manageDetectors();
  app.querySelectorAll('[data-tpl]').forEach((b) => (b.onclick = async () => {
    if (b.dataset.tpl === 'launch') return editDetector(null, LAUNCH_DETECTOR);
    widgets.push({ id: uid(), ...TEMPLATES[+b.dataset.tpl] }); await saveWidgets(); render();
  }));
  app.querySelectorAll('.wact button').forEach((b) => (b.onclick = async () => {
    const i = +b.dataset.i, a = b.dataset.act;
    if (a === 'edit') return editWidget(i);
    if (a === 'dup') widgets.splice(i + 1, 0, { ...widgets[i], id: uid(), title: widgets[i].title + ' (copie)' });
    if (a === 'up' && i) [widgets[i - 1], widgets[i]] = [widgets[i], widgets[i - 1]];
    if (a === 'down' && i < widgets.length - 1) [widgets[i + 1], widgets[i]] = [widgets[i], widgets[i + 1]];
    if (a === 'del') { if (!confirm(`Supprimer « ${widgets[i].title} » ?`)) return; widgets.splice(i, 1); }
    await saveWidgets(); render();
  }));
}

// ---------- éditeur d'une stat ----------
function dialog() {
  let d = $('dlg');
  if (!d) { d = document.createElement('dialog'); d.id = 'dlg'; document.body.append(d); }
  return d;
}
async function editWidget(i, init) {
  const w = i === null ? { id: uid(), title: '', kind: 'number', q: '', dets: [], detMode: 'and', source: 'all', by: 'author', ...init } : { ...widgets[i] };
  w.dets = detsOf(w); delete w.det;
  const d = dialog();
  const opt = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
  d.innerHTML = `<form method="dialog" class="ed"><h3>${i === null ? 'Nouvelle stat' : 'Modifier la stat'}</h3>
    <label>Nom<input name="title" value="${esc(w.title)}" placeholder="Ex. : Lancements"></label>
    <div class="row"><label>Forme<select name="kind">${opt(KINDS, w.kind)}</select></label><label>Source<select name="source">${opt(SOURCES, w.source || 'all')}</select></label>
      <label class="byl">Regrouper par<select name="by">${opt(BYS, w.by || 'author')}</select></label></div>
    <label>Requête <span class="hint">mots (tous requis), <code>a | b</code> = l’un ou l’autre, <code>from:@x</code>, <code>has:link</code>, <code>lang:fr</code>, <code>playlist:"…"</code>, <code>viewed:no</code>…</span><input name="q" value="${esc(w.q)}" placeholder="vide = tout"></label>
    <div class="dsel"><span class="lab">Détecteurs (sens) <span class="hint">facultatif — se combinent avec la requête</span></span>
      <div class="dlist">${detectors.map((x) => `<label class="chk"><input type="checkbox" name="dets" value="${x.id}"${w.dets.includes(x.id) ? ' checked' : ''}> ${esc(x.name)}</label>`).join('') || '<span class="muted">Aucun détecteur pour l’instant.</span>'}</div>
      <div class="row2"><label class="inl" id="dm">Combiner <select name="detMode"><option value="and"${w.detMode !== 'or' ? ' selected' : ''}>ET : tous les détecteurs cochés</option><option value="or"${w.detMode === 'or' ? ' selected' : ''}>OU : au moins un</option></select></label><button type="button" class="gbtn" id="ed-newdet">+ Nouveau détecteur</button></div></div>
    <div class="pv" id="pv">…</div>
    <menu><button value="cancel" class="gbtn">Annuler</button><button value="ok" class="pbtn" id="ed-ok">Enregistrer</button></menu></form>`;
  const f = d.querySelector('form');
  const read = () => { const fd = new FormData(f); return { ...w, title: fd.get('title').trim(), kind: fd.get('kind'), source: fd.get('source'), by: fd.get('by'), q: fd.get('q').trim(), dets: fd.getAll('dets'), detMode: fd.get('detMode') }; };
  let timer = 0, seq = 0;
  const preview = async () => {
    const draft = read(), my = ++seq;
    f.querySelector('.byl').style.display = draft.kind === 'top' ? '' : 'none';
    f.querySelector('#dm').style.display = draft.dets.length > 1 ? '' : 'none';
    const { sets } = await detectorSetsFor(new Set(draft.dets));
    if (my !== seq) return;
    const r = evalWidget(everything, { ...draft, kind: 'number' }, { sv: savedInfo(all, Date.now()), now: Date.now(), rangeDays: range, detSets: sets });
    const idm = byId();
    const sizes = draft.dets.map((id) => [detectors.find((x) => x.id === id)?.name || id, sets.get(id)?.size ?? 0]);
    const empty = sizes.filter(([, n]) => n === 0).map(([nm]) => nm);
    const warn = empty.length ? `<p class="warn">⚠ ${esc(empty.join(', '))} ne retien${empty.length > 1 ? 'nent' : 't'} <b>aucun élément</b> : le seuil est trop haut (ou les exemples n’ont pas été analysés). Ouvre « Détecteurs » › Modifier : une suggestion de seuil y est proposée.</p>` : sizes.length ? `<p class="muted">${sizes.map(([nm, n]) => `${esc(nm)} : ${fmtInt(n)} retenus au total`).join(' · ')}</p>` : '';
    $('pv').innerHTML = `${warn}<b>${fmtInt(r.n)}</b> élément(s) sur la période (${esc(rangeLabel())})${r.prev != null && delta(r.n, r.prev) ? ` · ${esc(delta(r.n, r.prev))}` : ''}<ol>${r.matched.slice(0, 5).map(({ t, day }) => `<li><span class="muted">${esc(day)}</span> ${esc(textOf(idm.get(t.id) || t))}</li>`).join('')}</ol>`;
  };
  f.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(preview, 250); });
  f.addEventListener('change', preview);
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
    <div class="jv"><label class="chk"><input type="checkbox" name="cf"${det.confirm?.on ? ' checked' : ''}> Faire confirmer les cas ambigus par Jev <span class="hint">(facultatif : un modèle de décision tranche les éléments proches du seuil)</span></label>
      <div id="jvbox" ${det.confirm?.on ? '' : 'hidden'}><label>Zone ambiguë ± <b id="bdv"></b> autour du seuil <input type="range" name="bd" min="0.03" max="0.2" step="0.01" value="${det.confirm?.band ?? CONFIRM_BAND}"></label>
        <div id="jvstat" class="muted"></div>
        <div class="row2"><label class="inl">Appels au plus <input type="number" name="mx" min="1" max="5000" value="50" style="width:90px"></label><button type="button" class="gbtn" id="jv-go">Juger maintenant</button><button type="button" class="gbtn" id="jv-stop" hidden>Arrêter</button></div>
        <div id="jvmsg" class="muted"></div></div></div>
    <div id="dsug" class="sug" hidden></div>
    <div id="dstat" class="muted">Analyse…</div>
    <div class="cols"><div><h4>Retenus (les moins sûrs)</h4><ul class="ex" id="ex-above"></ul></div><div><h4>Écartés (les plus proches)</h4><ul class="ex" id="ex-below"></ul></div></div>
    <menu><button value="cancel" class="gbtn">Annuler</button><button value="ok" class="pbtn" id="d-ok">Enregistrer</button></menu></form>`;
  const f = d.querySelector('form');
  const idm = byId();
  const texts = () => { const fd = new FormData(f); return [fd.get('desc').trim(), ...fd.get('examples').split('\n').map((x) => x.trim())].filter(Boolean); };
  const draft = () => { const fd = new FormData(f); return { ...det, name: fd.get('name').trim(), desc: fd.get('desc').trim(), examples: fd.get('examples').split('\n').map((x) => x.trim()).filter(Boolean), threshold: Number(fd.get('th')), confirm: { on: fd.get('cf') === 'on', band: Number(fd.get('bd')) } }; };
  let current = null, seq = 0, embedTimer = 0, protoErr = '', touched = k !== null;
  let costPrice = (await getSettings()).decision.priceInPerM;
  const { mid } = await loadVectors();
  const protoKeyOf = (arr) => arr.join('␞');
  const lists = () => {
    const dd = draft();
    $('thv').textContent = dd.threshold.toFixed(2);
    if (!current) return;
    const vd = verdictsOf(dd);
    const set = detectorSet(current, dd, vd);
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
      const pend = ambiguousIds(current, dd, vd).length, judged = Object.keys(vd).length;
      const pids = ambiguousIds(current, dd, vd);
      const est = estimateJudgeCost(dd.desc, pids.map((id) => idm.get(id)).filter(Boolean).map((t) => jtext(t).text), costPrice);
      $('jvstat').textContent = `${fmtInt(pend)} cas ambigu(s) à juger${pend ? ` (≈ ${fmtDollars(est.dollars)} pour tous, estimation)` : ''} · ${fmtInt(judged)} déjà jugé(s) par Jev (jamais redemandés)`;
    }
    $('dstat').textContent = `${fmtInt(set.size)} élément(s) retenus au total (sur ${fmtInt(current.size)} avec un vecteur) · ${dd.pos.length} validé(s), ${dd.neg.length} écarté(s) à la main`;
    const { above, below } = detectorMargin(current, dd, 8);
    const li = (id, s, tag) => { const t = idm.get(id); const v = vd[id]; return `<li><span class="sc">${s.toFixed(2)}</span>${v !== undefined ? ` <span class="jvt ${v >= 50 ? 'y' : 'n'}" title="Verdict de Jev">Jev ${v >= 50 ? 'oui' : 'non'} ${v} %</span>` : ''} ${esc(t ? textOf(t) : id)} <span class="vb"><button type="button" data-v="ok" data-id="${esc(id)}" title="Oui, c’en est un">✓</button><button type="button" data-v="no" data-id="${esc(id)}" title="Non">✗</button></span></li>`; };
    $('ex-above').innerHTML = above.map(([id, s]) => li(id, s)).join('') || '<li class="muted">—</li>';
    $('ex-below').innerHTML = below.map(([id, s]) => li(id, s)).join('') || '<li class="muted">—</li>';
  };
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
      if (k === null && !touched) { const sg = suggestThreshold(sc); if (sg) { f.elements.th.value = sg.threshold; touched = true; } } // nouveau détecteur : seuil de départ réaliste
      lists();
    } catch (e) { protoErr = e.message; $('dstat').textContent = '⚠ ' + e.message; }
  };
  f.addEventListener('input', (ev) => { if (ev.target.name === 'th') touched = true; if (ev.target.name === 'th' || ev.target.name === 'bd' || ev.target.name === 'cf') return lists(); clearTimeout(embedTimer); embedTimer = setTimeout(analyse, 900); });
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
      msg(r.error ? `Terminé partiellement (${done}/${items.length}) : ${r.error}` : `Terminé : ${done} élément(s) jugé(s).`);
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
  }
}

drawSources();
drawRanges();
Promise.all([getAllTweets(), getMeta('dashWidgets'), getMeta('dashDetectors'), getMeta('detVerdicts')]).then(([t0, w, dts, vds]) => { verdicts = vds || {}; const t = t0.filter((x) => !x.off); everything = t; all = t.filter((x) => !isVideoItem(x)); videos = t.filter(isVideoItem); widgets = w || []; detectors = dts || []; render(); }); // ces statistiques portent sur les bookmarks X
