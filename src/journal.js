// Page « Journal » : prépare la semaine, fait rédiger les articles par le modèle d'IA (avec plafond de dépense), met en pages A4.
import { getAllTweets, getMeta, setMeta, getAllVectors, getAllChunkVecs, getTweets } from './lib/db.js';
import { getSettings, setSettings, llmReady } from './lib/settings.js';
import { modelOf } from './lib/models.js';
import { savedInfo, dayKey } from './lib/time.js';
import { isVideoItem } from './lib/youtube.js';
import { detectorSetFor } from './lib/detsets.js';
import { chatFull } from './lib/llm.js';
import { isPublicUrl } from './lib/links.js';
import { handleKey, OFFICIAL_DESC } from './lib/widgets.js';
import {
  weekWindow, inWindow, dayLabel, buildSubjects, assignTiers, weekStats, extractPageText, evidenceFor, articleMessages, briefsMessages, editorialMessages,
  searchMessages, parseFindings, verifyMessages, applyVerification, parseArticle, parseBriefs, parseEditorial, fallbackArticle, estimateCall, costOf, fmtUsd, makeBibliography, citeHtml, sourcesLine, esc, TIER,
} from './lib/journal.js';

const $ = (id) => document.getElementById(id);
const DAY = 86_400_000;
const NAME = 'La Gazette IA & Robotique';
let abort = null;
const logEl = $('j-log');
const log = (m) => { logEl.hidden = false; logEl.textContent += (logEl.textContent ? '\n' : '') + m; logEl.scrollTop = logEl.scrollHeight; };
const prog = (v) => { $('j-prog').hidden = v == null; if (v != null) $('j-prog').value = Math.round(v * 100); };
const ms = (n) => new Promise((r) => setTimeout(r, n));

// ---------- réglages ----------
let settings, detectors = [];
const readCfg = () => ({
  writerModel: $('j-writer').value.trim(), assistModel: $('j-assist').value.trim(),
  priceInPerM: Math.max(0, Number($('j-pin').value) || 0), priceOutPerM: Math.max(0, Number($('j-pout').value) || 0),
  budget: Math.max(0, Number($('j-budget').value) || 0),
  leads: Math.max(0, Math.min(8, Math.round(Number($('j-leads').value) || 0))), articles: Math.max(0, Math.min(40, Math.round(Number($('j-articles').value) || 0))), briefs: Math.max(0, Math.min(80, Math.round(Number($('j-briefs').value) || 0))),
  sections: [...document.querySelectorAll('#j-sections input:checked')].map((i) => i.value), readLinks: $('j-links').checked,
  search: $('j-search').checked, searchTop: Math.max(1, Math.min(20, Math.round(Number($('j-top').value) || 6))), searchPrice: Math.max(0, Number($('j-sprice').value) || 0), verify: $('j-verify').checked,
});
async function loadUi() {
  settings = await getSettings();
  detectors = (await getMeta('dashDetectors')) || [];
  const j = settings.journal;
  $('j-writer').value = j.writerModel; $('j-assist').value = j.assistModel; $('j-pin').value = j.priceInPerM; $('j-pout').value = j.priceOutPerM; $('j-budget').value = j.budget;
  $('j-links').checked = j.readLinks; $('j-search').checked = j.search; $('j-top').value = j.searchTop; $('j-sprice').value = j.searchPrice; $('j-verify').checked = j.verify; $('j-leads').value = j.leads; $('j-articles').value = j.articles; $('j-briefs').value = j.briefs;
  const sel = j.sections ?? detectors.map((d) => d.id);
  $('j-sections').innerHTML = detectors.length ? detectors.map((d) => `<label><input type="checkbox" value="${esc(d.id)}"${sel.includes(d.id) ? ' checked' : ''}> ${esc(d.name)}</label>`).join('') : '<span class="hint">Aucun détecteur : le journal couvrira toute la semaine (crée des détecteurs dans « Mes stats » pour avoir des rubriques).</span>';
  const st = $('j-status');
  st.hidden = llmReady(settings);
  st.textContent = 'Configure d’abord l’IA (⚙ du panneau de recherche › IA : URL, modèle, clé) : c’est elle qui rédige les articles.';
}
for (const id of ['j-search', 'j-top', 'j-sprice', 'j-verify', 'j-links', 'j-writer', 'j-assist', 'j-pin', 'j-pout', 'j-budget', 'j-leads', 'j-articles', 'j-briefs']) $(id).addEventListener('change', async () => { settings = await setSettings({ journal: readCfg() }); });
$('j-sections').addEventListener('change', async () => { settings = await setSettings({ journal: readCfg() }); });

// ---------- préparation de la semaine ----------
async function prepare(s) {
  log('Lecture de la base…');
  const [all, dets, verdicts, primary, offStore] = await Promise.all([getAllTweets(), getMeta('dashDetectors'), getMeta('detVerdicts'), getMeta('primarySources'), getMeta('officialVerdicts')]);
  const items = all.filter((t) => !t.off);
  const mid = modelOf(s.embedModel).id;
  const [vecs, chunks] = await Promise.all([getAllVectors(mid), getAllChunkVecs(mid)]);
  const sv = savedInfo(items.filter((t) => !isVideoItem(t)), Date.now());
  const win = weekWindow();
  const selIds = s.journal.sections ?? (dets || []).map((d) => d.id);
  let sections = [];
  for (const id of selIds) {
    const det = (dets || []).find((d) => d.id === id);
    if (!det) continue;
    const set = detectorSetFor(det, { mid, vecs, chunks, verdicts: verdicts || {} });
    if (!set) { log(`⚠ Détecteur « ${det.name} » ignoré : ses exemples ne sont pas analysés avec le modèle actuel.`); continue; }
    sections.push({ id: det.id, name: det.name, set });
  }
  if (!sections.length) sections = [{ id: 'all', name: 'À la une', set: new Set(items.filter((t) => !isVideoItem(t)).map((t) => t.id)) }];
  const primarySet = new Set((primary || []).map(handleKey));
  const official = offStore?.v === OFFICIAL_DESC ? offStore.m : {};
  const subjects = buildSubjects(items, { sv, sections, vecs, primary: primarySet, official, win });
  const tiers = assignTiers(subjects, { leads: s.journal.leads, articles: s.journal.articles, briefs: s.journal.briefs });
  const stats = weekStats(items, { sv, sections, win });
  const videos = items.filter(isVideoItem).filter((v) => (v.watched || []).some((d) => inWindow(d, win)) || (v.addedAt && inWindow(dayKey(v.addedAt), win)))
    .sort((a, b) => String(b.lastWatched || dayKey(b.addedAt || 0)).localeCompare(String(a.lastWatched || dayKey(a.addedAt || 0)))).slice(0, 8);
  return { items, win, sections, subjects, tiers, stats, videos };
}

function estimatePlan(plan, cfg) {
  const prices = { priceInPerM: cfg.priceInPerM, priceOutPerM: cfg.priceOutPerM };
  let usd = 0, calls = 0, tin = 0, tout = 0;
  const add = (e) => { usd += e.dollars; tin += e.tin; tout += e.tout; calls++; };
  for (const [tier, list] of [['lead', plan.tiers.leads], ['article', plan.tiers.articles]]) {
    for (const sub of list) add(estimateCall(evidenceFor(sub).text.length + (sub.links.length ? 4500 : 0) + 900, tier === 'lead' ? 1400 : 650, prices));
  }
  for (let i = 0; i < plan.tiers.briefs.length; i += 8) {
    const grp = plan.tiers.briefs.slice(i, i + 8);
    add(estimateCall(grp.reduce((n, s) => n + evidenceFor(s).text.length, 0) + 800, grp.length * 90, prices));
  }
  add(estimateCall(plan.subjects.length * 220 + 900, 1000, prices));
  const detailed = [...plan.tiers.leads, ...plan.tiers.articles];
  if (cfg.search) for (let i = 0; i < Math.min(cfg.searchTop, detailed.length); i++) { add(estimateCall(1500, 900, prices)); usd += cfg.searchPrice; }
  if (cfg.verify) for (const sub of detailed) add(estimateCall(evidenceFor(sub).text.length + (sub.links.length ? 4500 : 0) + (cfg.search ? 2500 : 0) + 1500, 400, prices));
  return { usd, calls, tin, tout };
}

// ---------- pages liées ----------
let pageCache = {};
async function fetchPage(url) {
  const c = pageCache[url];
  if (c && Date.now() - c.at < 14 * DAY) return c;
  if (!isPublicUrl(url)) return null;
  try {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 10_000);
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', credentials: 'omit' });
    clearTimeout(timer);
    if (!res.ok || !/html|text/.test(res.headers.get('content-type') || '')) return null;
    const out = { ...extractPageText((await res.text()).slice(0, 1_500_000)), at: Date.now() };
    pageCache[url] = out;
    return out;
  } catch { return null; }
}
async function loadPages(subjects, hasPerm) {
  pageCache = (await getMeta('journalPages')) || {};
  const pages = new Map(), want = [];
  for (const sub of subjects) for (const url of sub.links.slice(0, 2)) want.push([sub, url]);
  let done = 0;
  const worker = async () => {
    while (want.length) {
      const [sub, url] = want.shift();
      let p = hasPerm ? await fetchPage(url) : pageCache[url] || null;
      if (!p?.text) { // à défaut : la carte du tweet (titre + description) déjà enregistrée
        const card = sub.members.flatMap((m) => m.cards || []).find((c) => c.url === url) || null;
        if (card && (card.title || card.description)) p = { title: card.title, text: card.description || '', image: card.image || '' };
      }
      if (p && (p.text || p.title)) pages.set(url, p);
      done++;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const keys = Object.keys(pageCache);
  if (keys.length > 300) for (const k of keys.sort((a, b) => pageCache[a].at - pageCache[b].at).slice(0, keys.length - 300)) delete pageCache[k];
  await setMeta('journalPages', pageCache);
  return pages;
}

// ---------- images ----------
const probe = (url) => new Promise((res) => { const im = new Image(); const t = setTimeout(() => res(false), 7000); im.onload = () => { clearTimeout(t); res(true); }; im.onerror = () => { clearTimeout(t); res(false); }; im.referrerPolicy = 'no-referrer'; im.src = url; });
async function pickImages(entries) {
  let i = 0;
  const worker = async () => {
    while (i < entries.length) {
      const e = entries[i++];
      e.image = null;
      for (const im of e.subject.images.slice(0, 3)) { if (await probe(im.url)) { e.image = im; break; } }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

// ---------- génération ----------
async function generate() {
  const cfg = readCfg();
  settings = await setSettings({ journal: cfg });
  if (!llmReady(settings)) { $('j-status').hidden = false; return; }
  const origins = ['https://*/*', 'http://*/*'];
  let hasPerm = await chrome.permissions.contains({ origins }).catch(() => false);
  if (!hasPerm && cfg.readLinks) hasPerm = await Promise.race([chrome.permissions.request({ origins }).catch(() => false), ms(60_000).then(() => false)]);
  abort = new AbortController();
  $('j-go').disabled = true; $('j-est').disabled = true; $('j-stop').hidden = false; logEl.textContent = ''; prog(0);
  const prices = { priceInPerM: cfg.priceInPerM, priceOutPerM: cfg.priceOutPerM };
  let spent = 0, fallbacks = 0, budgetHit = false;
  try {
    const plan = await prepare(settings);
    log(`Semaine ${plan.win.label} : ${plan.subjects.length} sujets (${plan.tiers.leads.length} grands sujets, ${plan.tiers.articles.length} articles, ${plan.tiers.briefs.length} brèves).`);
    if (!plan.subjects.length) { log('Rien à publier : aucun élément retenu cette semaine.'); return; }
    if (!plan.tiers.leads.length && !plan.tiers.articles.length && !plan.tiers.briefs.length) { log('Rien à publier : les nombres de grands sujets, d’articles et de brèves sont à 0.'); return; }
    const est = estimatePlan(plan, cfg);
    log(`Coût estimé : ${fmtUsd(est.usd)} (plafond ${fmtUsd(cfg.budget)}).${est.usd > cfg.budget ? ' Au-delà du plafond, les derniers sujets seront traités en brèves simples.' : ''}`);
    const writer = cfg.writerModel || undefined, assist = cfg.assistModel || cfg.writerModel || undefined;

    const detailed = [...plan.tiers.leads, ...plan.tiers.articles];
    log(hasPerm ? `Lecture des pages liées (${detailed.reduce((n, s) => n + Math.min(2, s.links.length), 0)})…` : 'Accès aux pages liées non autorisé : on se limite aux tweets et aux cartes déjà enregistrées.');
    const pages = await loadPages(detailed, hasPerm);
    prog(0.1);

    const ask = async (messages, { model, maxTokens, plugins, extra = 0, full = false }) => {
      const e = estimateCall(JSON.stringify(messages).length, Math.round(maxTokens * 0.6), prices).dollars + extra;
      if (spent + e > cfg.budget) { budgetHit = true; throw new Error('budget'); }
      const r = await chatFull(settings.llm, messages, { model, maxTokens, temperature: plugins ? 0.1 : 0.3, signal: abort.signal, plugins });
      spent += r.usage.cost != null ? r.usage.cost : costOf(r.usage, prices) + extra;
      return full ? r : r.text;
    };
    const pagesOf = (subject) => new Map(subject.links.map((l) => [l, pages.get(l)]).filter(([, p]) => p));
    const entries = detailed.map((subject, i) => ({ subject, tier: i < plan.tiers.leads.length ? 'lead' : 'article', pack: evidenceFor(subject, pagesOf(subject)) }));
    // recherche web : les sujets les plus importants d'abord ; seules les adresses réellement consultées sont retenues
    let webCount = 0, removedTotal = 0;
    if (cfg.search) {
      const targets = entries.slice(0, cfg.searchTop);
      log(`Recherche web pour ${targets.length} sujet(s)…`);
      let k = 0, warned = false;
      const sw = async () => {
        while (k < targets.length && !abort.signal.aborted && !budgetHit) {
          const e = targets[k++];
          try {
            const r = await ask(searchMessages(e.subject), { model: assist, maxTokens: 1400, plugins: [{ id: 'web', max_results: 5 }], extra: cfg.searchPrice, full: true });
            const pf = parseFindings(r.text, r.annotations);
            if (pf.noAnnotations && !warned) { warned = true; log('⚠ Le fournisseur n’a pas renvoyé les pages consultées : résultats de recherche ignorés (impossible de vérifier les adresses).'); }
            if (pf.sources.length) { webCount++; e.pack = evidenceFor(e.subject, pagesOf(e.subject), { web: pf.sources }); }
            if (pf.rejected) log(`  ${pf.rejected} fait(s) écarté(s) : adresse non consultée.`);
          } catch (err) { if (abort.signal.aborted) return; if (err.message !== 'budget') log(`⚠ Recherche web : ${err.message}`); }
        }
      };
      await Promise.all([sw(), sw()]);
      log(`Recherche web : ${webCount} sujet(s) complété(s).`);
    }
    prog(0.2);
    // articles : 2 en parallèle
    let next = 0, finished = 0;
    const work = async () => {
      while (next < entries.length && !abort.signal.aborted) {
        const e = entries[next++];
        const t = TIER[e.tier];
        try {
          let article = null;
          for (let attempt = 0; attempt < 2 && !article; attempt++) {
            const msgs = articleMessages(e.tier, e.subject, e.pack);
            if (attempt) msgs.push({ role: 'user', content: 'Réponds uniquement avec un objet JSON valide, sans texte autour.' });
            try { article = parseArticle(await ask(msgs, { model: e.tier === 'lead' ? writer : assist, maxTokens: t.maxTokens }), e.pack); }
            catch (err) { if (err.message === 'budget' || abort.signal.aborted) throw err; if (!/inexploitable|JSON|Unexpected|Expected/.test(err.message)) throw err; }
          }
          e.article = article || (fallbacks++, fallbackArticle(e.subject, e.pack));
        } catch (err) {
          if (abort.signal.aborted) return;
          fallbacks++; e.article = fallbackArticle(e.subject, e.pack);
          if (err.message !== 'budget') log(`⚠ ${e.subject.sectionName} : ${err.message} — article simplifié.`);
        }
        finished++; prog(0.1 + 0.6 * (finished / entries.length));
        $('j-prog').title = `${fmtUsd(spent)} dépensés`;
      }
    };
    log('Rédaction des articles…');
    await Promise.all([work(), work()]);
    if (abort.signal.aborted) throw new Error('arrêté');
    if (budgetHit) log(`Plafond de ${fmtUsd(cfg.budget)} atteint : les sujets restants sont présentés sous forme simplifiée.`);

    // relecture automatique : retire ce que les sources ne soutiennent pas
    if (cfg.verify && !budgetHit) {
      log('Relecture automatique…');
      let k = 0;
      const vw = async () => {
        while (k < entries.length && !abort.signal.aborted && !budgetHit) {
          const e = entries[k++];
          if (e.article.fallback) continue;
          const v = verifyMessages(e.article, e.pack);
          if (!v.lines.length) continue;
          try {
            const r = applyVerification(e.article, v.lines, await ask(v.messages, { model: assist, maxTokens: Math.min(1800, 300 + v.lines.length * 14) }));
            e.article = r.article; e.removed = r.removed; removedTotal += r.removed;
          } catch (err) { if (abort.signal.aborted) return; if (err.message !== 'budget') log(`⚠ Relecture : ${err.message}`); }
        }
      };
      await Promise.all([vw(), vw()]);
      log(`Relecture : ${removedTotal} phrase(s) non étayée(s) retirée(s).`);
    }
    if (budgetHit) log(`Plafond de ${fmtUsd(cfg.budget)} atteint : étapes restantes allégées.`);

    // brèves
    const briefEntries = plan.tiers.briefs.map((subject) => ({ subject, tier: 'brief', pack: evidenceFor(subject, new Map(), { maxTweets: 3 }) }));
    log('Rédaction des brèves…');
    for (let i = 0; i < briefEntries.length && !abort.signal.aborted; i += 8) {
      const grp = briefEntries.slice(i, i + 8);
      const ids = grp.map((g, k) => ({ id: 'B' + (i + k + 1), section: g.subject.sectionName, pack: g.pack }));
      try {
        const out = parseBriefs(await ask(briefsMessages(ids), { model: assist, maxTokens: 900 }), new Map(ids.map((x) => [x.id, new Set(x.pack.sources.map((s) => s.id))])));
        grp.forEach((g, k) => { const b = out.get('B' + (i + k + 1)); g.article = b ? { title: b.title, dek: '', paragraphs: [b.text], pull: '', points: [] } : (fallbacks++, fallbackArticle(g.subject, g.pack)); });
      } catch (err) {
        if (abort.signal.aborted) break;
        grp.forEach((g) => { g.article = fallbackArticle(g.subject, g.pack); fallbacks++; });
        if (err.message !== 'budget') log(`⚠ Brèves : ${err.message} — version simplifiée.`);
      }
      prog(0.7 + 0.1 * Math.min(1, (i + 8) / briefEntries.length));
    }
    if (abort.signal.aborted) throw new Error('arrêté');

    // éditorial
    let editorial = null;
    try {
      const summary = [...entries, ...briefEntries].map((e) => `- [${e.subject.sectionName}] ${e.subject.firstDay} : ${e.article.title}${e.article.dek ? ' — ' + e.article.dek : ''}`).join('\n');
      editorial = parseEditorial(await ask(editorialMessages(summary.replace(/\[[TLW]\d+(,[TLW]\d+)*\]/g, '')), { model: assist, maxTokens: 1400 }));
    } catch (err) { if (abort.signal.aborted) throw err; log(`Éditorial non rédigé (${err.message === 'budget' ? 'plafond atteint' : err.message}).`); }
    prog(0.85);

    // mise en pages
    log('Choix des images…');
    await pickImages(entries);
    log('Mise en pages…');
    const model = { plan, entries, briefEntries, editorial, cost: spent, fallbacks, budget: cfg.budget, budgetHit, webCount, removedTotal };
    await renderPaper(model);
    prog(0.97);
    const id = String(Date.now());
    const pagesN = $('paper').children.length;
    await saveEdition({ id, at: Date.now(), label: plan.win.label, pages: pagesN, cost: spent, subjects: plan.subjects.length, html: $('paper').innerHTML });
    log(`Édition terminée : ${pagesN} pages, ${plan.subjects.length} sujets, coût : ${fmtUsd(spent)}${fallbacks ? `, ${fallbacks} sujet(s) en version simplifiée` : ''}.`);
    prog(1);
    $('j-print').hidden = false;
    $('paper').scrollIntoView({ behavior: 'smooth' });
    await renderList();
  } catch (e) {
    log(abort?.signal.aborted ? 'Arrêté.' : '⚠ ' + (e.message || e));
  } finally {
    abort = null; $('j-go').disabled = false; $('j-est').disabled = false; $('j-stop').hidden = true;
    setTimeout(() => prog(null), 1500);
  }
}

// ---------- mise en pages ----------
const paper = $('paper');
function newPage(label, sec) {
  const pg = document.createElement('section');
  pg.className = 'page'; if (sec) pg.dataset.sec = sec;
  pg.innerHTML = `<div class="run"><span>${esc(label)}</span><span>${esc(curWin.label)}</span><span>Édition n° ${curWin.week}</span></div><div class="body flow"></div><div class="pn"><b>${esc(NAME)}</b><span></span></div>`;
  paper.append(pg);
  return pg;
}
let curWin = null;
const nodesOf = (html) => { const d = document.createElement('div'); d.innerHTML = html; return [...d.childNodes]; };
const overflows = (body) => body.scrollWidth > body.clientWidth + 2;
// blocks : [{ html, ref? }] ; ref = clé retenue avec la page où le bloc a atterri.
function flow(label, blocks, refs) {
  let pg = newPage(label), body = pg.querySelector('.body');
  const pagesOut = [pg];
  for (const b of blocks) {
    const nodes = nodesOf(b.html);
    nodes.forEach((n) => body.append(n));
    if (overflows(body) && body.children.length > nodes.length) {
      nodes.forEach((n) => n.remove());
      pg = newPage(label); body = pg.querySelector('.body'); pagesOut.push(pg);
      nodes.forEach((n) => body.append(n));
    }
    if (b.ref && refs) refs.set(b.ref, pg);
  }
  return pagesOut;
}
function fixedPage(label, html, cls = '') {
  const pg = document.createElement('section');
  pg.className = 'page ' + cls;
  pg.innerHTML = `<div class="run"><span>${esc(label)}</span><span>${esc(curWin.label)}</span><span>Édition n° ${curWin.week}</span></div><div class="body">${html}</div><div class="pn"><b>${esc(NAME)}</b><span></span></div>`;
  paper.append(pg);
  const body = pg.querySelector('.body');
  for (let z = 1; z > 0.6 && body.scrollHeight > body.clientHeight + 2; z -= 0.04) body.style.zoom = z.toFixed(2);
  return pg;
}

const figHtml = (im, wide, cap) => (im ? `<figure class="${wide ? 'wide' : ''}"><span class="im"><img src="${esc(im.url)}" alt="" referrerpolicy="no-referrer"></span><figcaption>${esc(cap || im.alt || `Image du tweet de @${im.handle}`)}</figcaption></figure>` : '');
function articleBlocks(e, bib) {
  const a = e.article, lead = e.tier === 'lead', ref = e.subject.id;
  const cite = (t) => citeHtml(t, e.pack, bib);
  const by = `D’après ${e.pack.sources.filter((s) => s.kind === 'tweet').slice(0, 3).map((s) => '@' + esc(s.handle)).join(', ')} · ${esc(e.subject.firstDay.slice(8))}/${esc(e.subject.firstDay.slice(5, 7))}${e.pack.sources.some((x) => x.kind === 'web') ? ' · recherche web' : ''}${a.fallback ? ' · <span class="fb">version simplifiée</span>' : ''}`;
  const head = `<div class="art-head${lead ? ' lead' : ''}"><p class="kick">${esc(e.subject.sectionName)}${lead ? ' · À la une' : ''}</p>${lead ? `<h2 class="t">${esc(a.title)}</h2>` : `<h3 class="t">${esc(a.title)}</h3>`}${a.dek ? `<p class="dek">${cite(a.dek)}</p>` : ''}<p class="by">${by}</p></div>`;
  const blocks = [];
  const img = e.image && !a.fallback ? figHtml(e.image, lead, e.image.card ? `Illustration : ${e.image.alt}` : null) : '';
  blocks.push({ ref, html: head + img + `<p class="${lead ? 'drop ' : ''}">${cite(a.paragraphs[0])}</p>` });
  a.paragraphs.slice(1).forEach((p, i) => {
    blocks.push({ html: `<p>${cite(p)}</p>` });
    if (i === 0 && a.pull) blocks.push({ html: `<blockquote class="pull">« ${esc(a.pull)} »<cite>${esc(a.pullSource ? '@' + (e.pack.sources.find((s) => s.id === a.pullSource)?.handle || '') : '')}</cite></blockquote>` });
  });
  if (a.points.length) blocks.push({ html: `<div class="kp"><h5>À retenir</h5><ul>${a.points.map((p) => `<li>${cite(p)}</li>`).join('')}</ul></div>` });
  const sl = sourcesLine(a, e.pack, bib);
  if (sl) blocks.push({ html: sl });
  return blocks;
}

// graphiques SVG de la page de chiffres
function lineSvg(series, keys) {
  const W = 300, H = 150, m = { l: 26, r: 6, t: 8, b: 20 };
  const max = Math.max(4, ...series.flatMap((s) => s.vals));
  const x = (i) => m.l + ((W - m.l - m.r) / Math.max(1, keys.length - 1)) * i, y = (v) => H - m.b - (v / max) * (H - m.t - m.b);
  const C = ['#1f4e79', '#b5532a', '#2e7d5b', '#b8860b', '#8a4f7d'];
  let g = '';
  for (let t = 0; t <= 4; t++) { const v = (max / 4) * t; g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="#d9d2c3"/><text x="${m.l - 4}" y="${y(v) + 3}" font-size="9" text-anchor="end" fill="#4a4640" font-family="Arial">${Math.round(v)}</text>`; }
  keys.forEach((k, i) => { g += `<text x="${x(i)}" y="${H - 6}" font-size="8.5" text-anchor="middle" fill="#4a4640" font-family="Arial">${esc(dayLabel(k).split(' ')[0].replace('.', ''))}</text>`; });
  series.forEach((s, si) => { g += `<path d="${s.vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')}" fill="none" stroke="${C[si % 5]}" stroke-width="2.2"/>`; });
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%">${g}</svg><div class="legend">${series.map((s, i) => `<span><i style="background:${C[i % 5]}"></i>${esc(s.name)}</span>`).join('')}</div>`;
}
function barsSvg(vals, keys) {
  const W = 300, H = 150, m = { l: 26, r: 6, t: 8, b: 20 }, max = Math.max(4, ...vals), bw = 22;
  const y = (v) => H - m.b - (v / max) * (H - m.t - m.b);
  let g = '';
  for (let t = 0; t <= 4; t++) { const v = (max / 4) * t; g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="#d9d2c3"/><text x="${m.l - 4}" y="${y(v) + 3}" font-size="9" text-anchor="end" fill="#4a4640" font-family="Arial">${Math.round(v)}</text>`; }
  vals.forEach((v, i) => { const cx = m.l + ((W - m.l - m.r) / Math.max(1, vals.length - 1)) * i - bw / 2; g += `<rect x="${cx}" y="${y(v)}" width="${bw}" height="${y(0) - y(v)}" fill="#141210"/><text x="${cx + bw / 2}" y="${H - 6}" font-size="8.5" text-anchor="middle" fill="#4a4640" font-family="Arial">${esc(dayLabel(keys[i]).split(' ')[0].replace('.', ''))}</text>`; });
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%">${g}</svg>`;
}

async function renderPaper(model) {
  const { plan, entries, briefEntries, editorial } = model;
  curWin = plan.win;
  paper.innerHTML = '';
  const bib = makeBibliography();
  const refs = new Map();
  const secPage = new Map();

  // éditorial
  if (editorial && editorial.paragraphs.length) {
    const blocks = [{ html: `<div class="art-head lead"><p class="kick">Éditorial</p><h2 class="t">${esc(editorial.title || 'La semaine')}</h2><p class="by">Par la rédaction · ${plan.subjects.length} sujets cette semaine</p></div><p class="drop">${esc(editorial.paragraphs[0])}</p>` }];
    editorial.paragraphs.slice(1).forEach((p) => blocks.push({ html: `<p>${esc(p)}</p>` }));
    if (editorial.ideas.length) blocks.push({ html: `<div class="kp"><h5>Les idées à retenir</h5><ul>${editorial.ideas.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>` });
    if (editorial.week.length) blocks.push({ html: `<h4 class="t">La semaine en 60 secondes</h4><ul class="week">${editorial.week.sort((a, b) => a.day.localeCompare(b.day)).map((w) => `<li><b>${esc(dayLabel(w.day))}</b><span>${esc(w.text)}</span></li>`).join('')}</ul>` });
    const pgs = flow('Éditorial', blocks);
    secPage.set('edito', pgs[0]);
  }
  // rubriques
  for (const sec of plan.sections) {
    const list = [...entries.filter((e) => e.subject.section === sec.id), ...briefEntries.filter((e) => e.subject.section === sec.id)];
    if (!list.length) continue;
    const blocks = [];
    for (const e of list.filter((x) => x.tier === 'lead')) blocks.push(...articleBlocks(e, bib));
    for (const e of list.filter((x) => x.tier === 'article')) { blocks.push({ html: '<div class="sep"></div>' }); blocks.push(...articleBlocks(e, bib)); }
    const br = list.filter((x) => x.tier === 'brief');
    if (br.length) {
      blocks.push({ html: '<h4 class="t" style="column-span:all">Brèves</h4>' });
      br.forEach((e) => blocks.push({ html: `<div class="brief"><b>${esc(e.article.title)}</b>${citeHtml(e.article.paragraphs[0], e.pack, bib)}${e.article.fallback ? ' <span class="fb">version simplifiée</span>' : ''}</div>` }));
    }
    const pgs = flow(sec.name, blocks, refs);
    secPage.set(sec.id, pgs[0]);
  }
  // chiffres
  const st = plan.stats;
  const chiffres = fixedPage('Chiffres', `<p class="kick">Chiffres</p><h2 class="t">Votre veille en chiffres</h2><p class="dek">Ce que vous avez gardé cette semaine, jour par jour, et ce qui progresse par rapport à la semaine précédente.</p>
    <div class="g2" style="grid-template-columns:1fr 1fr"><div class="l"><h4 class="t">Par rubrique</h4>${lineSvg(st.sectionSeries, st.dayKeys)}</div><div class="r"><h4 class="t">Tous les éléments retenus</h4>${barsSvg(st.byDay, st.dayKeys)}<div class="legend"><span>${st.total} éléments · ${plan.subjects.length} sujets distincts</span></div></div></div>
    <div class="dbl"></div>
    <div class="g2" style="grid-template-columns:1fr 1fr"><div class="l"><h4 class="t">Les comptes les plus enregistrés</h4><table><tr><th>Compte</th><th class="n">Éléments</th><th class="n">Évolution</th></tr>${st.topAccounts.map((a) => `<tr><td>@${esc(a.handle)}</td><td class="n">${a.n}</td><td class="n ${a.d > 0 ? 'up' : a.d < 0 ? 'dn' : ''}">${a.d > 0 ? '▲ ' + a.d : a.d < 0 ? '▼ ' + -a.d : '='}</td></tr>`).join('')}</table></div>
    <div class="r"><h4 class="t">Les mots qui montent</h4><table><tr><th>Mot</th><th class="n">Cette semaine</th><th class="n">Avant</th></tr>${st.rising.map((w) => `<tr><td>${esc(w.word)}</td><td class="n">${w.n}</td><td class="n">${w.prev}</td></tr>`).join('') || '<tr><td colspan="3">Rien ne se détache nettement.</td></tr>'}</table></div></div>`);
  secPage.set('stats', chiffres);
  // vidéos
  if (plan.videos.length) {
    const vids = await Promise.all(plan.videos.map(async (v) => ({ v, ok: v.thumb ? await probe(v.thumb) : false })));
    const vp = fixedPage('À voir et à écouter', `<p class="kick">Vidéos</p><h2 class="t">À voir et à écouter</h2><p class="dek">Les vidéos ajoutées à vos playlists ou regardées cette semaine.</p>${vids.map(({ v, ok }) => `<div class="vid"><span class="im">${ok ? `<img src="${esc(v.thumb)}" alt="" referrerpolicy="no-referrer">` : ''}</span><div><p class="kick">${esc(v.durationText || 'Vidéo')}${(v.watched || []).length ? ' · regardée' : ''}</p><h3 class="t">${esc(v.text)}</h3><p class="src">${esc(v.name)}${(v.playlists || []).length ? ' · ' + esc(v.playlists[0].title) : ''} · <a href="${esc(v.url)}">${esc(v.url.replace('https://www.', ''))}</a></p></div></div>`).join('')}`);
    secPage.set('videos', vp);
  }
  // lexique et sources
  const blocks = [];
  if (editorial?.glossary.length) { blocks.push({ html: '<h4 class="t" style="column-span:all">Lexique</h4>' }); editorial.glossary.forEach((g) => blocks.push({ html: `<p class="gloss"><b>${esc(g.term)}</b> — ${esc(g.def)}</p>` })); }
  blocks.push({ html: '<h4 class="t" style="column-span:all">Index des sources</h4>' });
  for (const s of bib.list) blocks.push({ html: `<p class="bibl"><b>${s.n}.</b> ${s.kind === 'tweet' ? `@${esc(s.handle)} (${esc(s.date)})` : esc(s.title)} — <a href="${esc(s.url)}">${esc(s.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 70))}</a></p>` });
  blocks.push({ html: `<h4 class="t" style="column-span:all">Colophon</h4><p class="src">Édition ${model.plan.win.label}, générée le ${new Date().toLocaleDateString('fr-FR')} à partir de ${plan.stats.total} éléments (X) et ${plan.videos.length} vidéo(s). Articles rédigés automatiquement d’après vos bookmarks et les pages liées ; coût de génération : ${fmtUsd(model.cost)} (plafond ${fmtUsd(model.budget)}).${model.webCount ? ` Recherche web pour ${model.webCount} sujet(s) (seules les pages réellement consultées sont citées).` : ''}${model.removedTotal ? ` Relecture automatique : ${model.removedTotal} phrase(s) non étayée(s) retirée(s).` : ''}${model.fallbacks ? ` ${model.fallbacks} sujet(s) présenté(s) sous forme simplifiée (plafond atteint ou erreur).` : ''} Les informations ne sont pas vérifiées indépendamment : consultez les sources.</p>` });
  const lp = flow('Lexique et sources', blocks);
  secPage.set('sources', lp[0]);

  // une
  const lead = entries.find((e) => e.tier === 'lead') || entries[0] || briefEntries[0];
  const pages = () => [...paper.children];
  const front = document.createElement('section');
  front.className = 'page';
  paper.prepend(front);
  const numOf = (pg) => pages().indexOf(pg) + 1;
  const toc = [['Éditorial', secPage.get('edito')], ...plan.sections.map((s) => [s.name, secPage.get(s.id)]), ['Chiffres', secPage.get('stats')], ['À voir et à écouter', secPage.get('videos')], ['Lexique et sources', secPage.get('sources')]].filter(([, pg]) => pg);
  const others = entries.filter((e) => e !== lead && e.tier === 'lead').concat(entries.filter((e) => e !== lead && e.tier === 'article')).slice(0, 3);
  const leadWords = (n) => lead.article.paragraphs.join(' ').split(/\s+/).slice(0, n).join(' ').replace(/\s*\[[TLW][\d,TLW]*\]/g, '');
  const buildFront = (n) => `<h1 class="mast">${esc(NAME)}</h1><div class="tag">Ce que vous avez gardé cette semaine — rédigé d’après vos bookmarks X et YouTube</div><div class="dbl" style="margin:4px 0 0"></div>
    <div class="g2" style="margin-top:12px"><div class="l"><p class="kick">${esc(lead.subject.sectionName)} · À la une</p><h2 class="t" style="font-size:40px">${esc(lead.article.title)}</h2>${lead.article.dek ? `<p class="dek">${esc(lead.article.dek.replace(/\s*\[[TLW][\d,TLW]*\]/g, ''))}</p>` : ''}${lead.image ? figHtml(lead.image, false, null).replace('class=""', 'style="column-span:none"') : ''}<div style="column-count:2;column-gap:20px;column-rule:1px solid var(--soft);text-align:justify;hyphens:auto"><p class="drop">${esc(leadWords(n))}…</p></div><p class="src">Suite page ${numOf(refs.get(lead.subject.id) || secPage.get(lead.subject.section))}.</p></div>
    <div class="r"><div class="box"><h4 class="t">Dans ce numéro</h4>${toc.map(([l, pg]) => `<div class="fig"><span>${esc(l)}</span><b style="font-size:14px">${numOf(pg)}</b></div>`).join('')}</div>
    <div class="box"><h4 class="t">Cette semaine</h4><div class="fig"><span>Éléments retenus</span><b>${st.total}</b></div><div class="fig"><span>Sujets distincts</span><b>${plan.subjects.length}</b></div></div>
    ${others.map((e) => `<div style="margin-bottom:10px;text-align:left"><p class="kick">${esc(e.subject.sectionName)}</p><h3 class="t">${esc(e.article.title)}</h3><p class="src">page ${numOf(refs.get(e.subject.id) || secPage.get(e.subject.section))}</p></div>`).join('')}</div></div>`;
  front.innerHTML = `<div class="run"><span>Édition du week-end</span><span>${esc(plan.win.label)}</span><span>Édition n° ${plan.win.week}</span></div><div class="body">${buildFront(130)}</div><div class="pn"><b>${esc(NAME)}</b><span></span></div>`;
  const fb = front.querySelector('.body');
  for (let n = 130; n > 30 && fb.scrollHeight > fb.clientHeight + 2; n -= 15) fb.innerHTML = buildFront(n);
  pages().forEach((pg, i) => { pg.querySelector('.pn span').textContent = String(i + 1); });
}

// ---------- éditions enregistrées ----------
async function saveEdition(ed) {
  await setMeta('journal:' + ed.id, ed);
  const idx = ((await getMeta('journalIndex')) || []).filter((e) => e.id !== ed.id);
  idx.unshift({ id: ed.id, at: ed.at, label: ed.label, pages: ed.pages, cost: ed.cost, subjects: ed.subjects });
  for (const old of idx.splice(12)) await setMeta('journal:' + old.id, null);
  await setMeta('journalIndex', idx);
}
async function renderList() {
  const idx = (await getMeta('journalIndex')) || [];
  const box = $('j-list');
  if (!idx.length) { box.innerHTML = '<p class="hint">Aucune édition pour l’instant.</p>'; return; }
  box.innerHTML = idx.map((e) => `<div class="ed"><b>Semaine ${esc(e.label)}</b><span>${e.pages} pages · ${e.subjects} sujets · ${fmtUsd(e.cost)} · ${new Date(e.at).toLocaleString('fr-FR')}</span><button type="button" data-open="${e.id}">Ouvrir</button><button type="button" data-del="${e.id}">Supprimer</button></div>`).join('');
}
$('j-list').addEventListener('click', async (ev) => {
  const open = ev.target.closest('[data-open]'), del = ev.target.closest('[data-del]');
  if (open) { const ed = await getMeta('journal:' + open.dataset.open); if (ed) { paper.innerHTML = ed.html; $('j-print').hidden = false; paper.scrollIntoView({ behavior: 'smooth' }); } }
  if (del && confirm('Supprimer cette édition ?')) {
    await setMeta('journal:' + del.dataset.del, null);
    await setMeta('journalIndex', ((await getMeta('journalIndex')) || []).filter((e) => e.id !== del.dataset.del));
    await renderList();
  }
});

// ---------- boutons ----------
$('j-print').onclick = () => window.print();
$('j-stop').onclick = () => abort?.abort();
$('j-go').onclick = generate;
$('j-est').onclick = async () => {
  const cfg = readCfg();
  settings = await setSettings({ journal: cfg });
  $('j-go').disabled = true; $('j-est').disabled = true; logEl.textContent = '';
  try {
    const plan = await prepare(settings);
    const est = estimatePlan(plan, cfg);
    log(`Semaine ${plan.win.label} : ${plan.subjects.length} sujets.`);
    log(`Grands sujets : ${plan.tiers.leads.length} · articles : ${plan.tiers.articles.length} · brèves : ${plan.tiers.briefs.length}.`);
    log(`≈ ${est.calls} appels au modèle, ≈ ${Math.round(est.tin / 1000)} k tokens lus et ${Math.round(est.tout / 1000)} k écrits.`);
    log(`Coût estimé : ${fmtUsd(est.usd)} avec les prix indiqués (plafond ${fmtUsd(cfg.budget)}). Ordre de grandeur : le coût réel s’affichera après génération.`);
    plan.tiers.leads.forEach((s) => log(`  • [${s.sectionName}] ${s.members.length} tweet(s), source @${s.rep.handle} : ${s.rep.text.replace(/\s+/g, ' ').slice(0, 90)}`));
  } catch (e) { log('⚠ ' + (e.message || e)); }
  $('j-go').disabled = false; $('j-est').disabled = false;
};

loadUi().then(renderList);
