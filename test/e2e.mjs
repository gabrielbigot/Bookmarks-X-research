// Test de bout en bout : charge l'extension dans Chromium, simule x.com (HTTPS local) et une API d'IA,
// puis vérifie : capture, synchro complète / nouveautés / bookmarks supprimés, recherche, langage naturel,
// clavier, recherches enregistrées, export/import (chiffré), IA (question, intention, résumé).
// Lancer : npm run build && xvfb-run -a node test/e2e.mjs   (playwright doit être installé)
import { chromium } from 'playwright';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execSync } from 'node:child_process';
import { demoPage, page } from './fixtures/bookmarks.js';

const dist = path.resolve('dist');
const tmp = mkdtempSync(path.join(tmpdir(), 'xbs-'));
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tmp}/k.pem -out ${tmp}/c.pem -days 1 -subj /CN=x.com 2>/dev/null`);

const mk = (id, handle, name, text, si, extra = {}) => ({
  entryId: 'tweet-' + id, sortIndex: String(si),
  content: { itemContent: { tweet_results: { result: { rest_id: id, core: { user_results: { result: { core: { screen_name: handle, name } } } }, ...(extra.card ? { card: extra.card } : {}),
    legacy: { full_text: text, created_at: 'Wed Sep 17 10:00:00 +0000 2026', lang: 'en', entities: { urls: extra.urls || [] } } } } } },
});
const CARD = { legacy: { binding_values: [
  { key: 'title', value: { string_value: 'Intro to vector databases' } },
  { key: 'description', value: { string_value: 'A practical guide for engineers' } },
  { key: 'vanity_url', value: { string_value: 'blog.example.com' } },
  { key: 'thumbnail_image_original', value: { image_value: { url: 'https://llm.test/card.png', width: 800, height: 418 } } },
  { key: 'card_url', value: { string_value: 'https://t.co/zzz' } },
] } };
const CHAIN = {
  CUR_NEXT: () => ['P3', [mk('2001', 'devops', 'DevOps', 'Kubernetes autoscaling with KEDA, event driven scaling tutorial', 1000), mk('2002', 'devops', 'DevOps', 'Postgres vacuum tuning for very large tables', 999)]],
  P3: () => ['P4', [mk('3001', 'misc', 'Misc', 'Rust async runtime benchmarks compared', 900), mk('3002', 'misc', 'Misc', 'Sourdough starter hydration tips', 899)]],
  P4: () => [null, [mk('4001', 'misc', 'Misc', 'Final tweet about vector databases https://t.co/zzz', 800, { card: CARD, urls: [{ url: 'https://t.co/zzz', expanded_url: 'https://blog.example.com/vector-db' }] })]],
};
const hits = [];
let drop = null; // id retiré côté « X » (bookmark supprimé)
const llmLog = [];
const jevLog = [];

const server = https.createServer({ key: readFileSync(`${tmp}/k.pem`), cert: readFileSync(`${tmp}/c.pem`) }, (req, res) => {
  const url = new URL(req.url, 'https://x.com');
  // --- faux fournisseur d'IA (compatible OpenAI), avec CORS ---
  if (url.pathname === '/v1/chat/completions') {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST,OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      const sys = body.messages[0].content, usr = body.messages.at(-1).content;
      llmLog.push({ sys: sys.slice(0, 40), auth: req.headers.authorization });
      let out = 'ok';
      if (sys.includes('transformes une requête')) out = JSON.stringify({ topic: 'kubernetes', authors: ['devops'], sort: 'oldest', since: null, until: null, has: [] });
      else if (sys.includes('juges la pertinence')) out = JSON.stringify({ scores: [0, 9, 1] });
      else if (sys.includes('rédiges un résumé')) out = '**Infra**\nDu contenu sur le scheduler [1].';
      else if (usr.includes('Question :')) out = 'Réponse mock : le scheduler de tokio a été amélioré [1].';
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: out } }] }));
    });
    return;
  }
  if (url.pathname === '/card.png') { // image de carte (SVG servi comme image)
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'access-control-allow-origin': '*' });
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="418"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d9bf0"/><stop offset="1" stop-color="#7856ff"/></linearGradient></defs><rect width="800" height="418" fill="url(#g)"/><text x="400" y="225" font-size="54" fill="#fff" text-anchor="middle" font-family="sans-serif">card image</text></svg>');
  }
  // --- faux Jev (OpenRouter Decisions API) ---
  if (url.pathname === '/api/alpha/decisions') {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST,OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      jevLog.push({ auth: req.headers.authorization, model: body.model, keys: Object.keys(body.questions) });
      const answers = {};
      for (const key of Object.keys(body.questions)) {
        const crit = Object.keys(body.questions[key].criteria);
        let choice = crit.includes('none') ? 'none' : crit[0];
        if (key === 'sort') choice = 'newest';
        if (key === 'pertinent') choice = String(body.state?.tweet).includes('persist') ? 'oui' : 'non';
        const probabilities = Object.fromEntries(crit.map((c) => [c, c === choice ? 0.92 : 0.08 / (crit.length - 1)]));
        answers[key] = { choice, confidence: 0.92, probabilities };
      }
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ answers }));
    });
    return;
  }
  if (/\/Bookmarks$/.test(url.pathname)) {
    const vars = JSON.parse(url.searchParams.get('variables') || '{}');
    hits.push(vars.cursor || null);
    let body;
    if (!vars.cursor) body = demoPage('CUR_NEXT');
    else {
      const [next, entries] = CHAIN[vars.cursor]();
      body = page({ cursor: next, tweets: entries.filter((e) => e.entryId !== 'tweet-' + drop) });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(body));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  const viaFetch = url.searchParams.get('via') === 'fetch';
  res.end(`<!doctype html><title>X</title><body><script>
    const u = '/i/api/graphql/QID123/Bookmarks?variables=' + encodeURIComponent(JSON.stringify({count:20,includePromotedContent:false}));
    setTimeout(() => {
      if (${viaFetch}) fetch(u, {headers:{authorization:'Bearer x','x-csrf-token':'t'}});
      else { const x = new XMLHttpRequest(); x.open('GET', u); x.setRequestHeader('authorization','Bearer x'); x.setRequestHeader('x-csrf-token','t'); x.send(); }
    }, 800);
  </script>Bookmarks mock</body>`);
});
await new Promise((r) => server.listen(443, '127.0.0.1', r));

const ctx = await chromium.launchPersistentContext(tmp + '/profile', {
  headless: false,
  acceptDownloads: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-sandbox',
    '--host-resolver-rules=MAP x.com 127.0.0.1, MAP llm.test 127.0.0.1, MAP huggingface.co 127.0.0.1:1', '--ignore-certificate-errors', '--no-proxy-server'],
});

const waitFor = async (fn, what, ms = 45000) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error('timeout : ' + what);
    await new Promise((r) => setTimeout(r, 200));
  }
};
const sameHits = (a) => JSON.stringify(hits) === JSON.stringify(a);

// ------------------------------------------------------------------ 1. capture + synchro complète (fetch)
const p = await ctx.newPage();
await p.goto('https://x.com/i/bookmarks?via=fetch');
await p.waitForTimeout(1500);
assert.ok(await p.evaluate(() => [...document.documentElement.children].some((e) => e.style.zIndex === '2147483646')), 'pill injecté');
await p.evaluate(() => window.postMessage({ src: 'xbs-ctl', type: 'start', mode: 'full' }, '*'));
// la page fait sa propre requête (null), puis la synchro repart du haut (null) et suit les curseurs
await waitFor(() => sameHits([null, null, 'CUR_NEXT', 'P3', 'P4']), 'pagination complète');
await p.waitForTimeout(1500);

let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const panelUrl = `chrome-extension://${extId}/panel.html`;

const panel = await ctx.newPage();
await panel.goto(panelUrl);
await panel.waitForSelector('.tw');
await panel.waitForFunction(() => /11 bookmarks/.test(document.getElementById('stats').textContent));

// Sécurité : après capture de 11 tweets, rien ne s'est indexé tout seul (mode manuel) ; le bouton propose d'indexer
await panel.waitForTimeout(2500);
assert.ok(!/indisponible|téléchargement|indexation \d/.test(await panel.locator('#index').innerText()), 'aucune indexation automatique : ' + await panel.locator('#index').innerText());
assert.match(await panel.locator('#idx-now').innerText(), /Indexer 11 tweets/);
assert.equal(await panel.locator('#idx-now').isVisible(), true);
// Les runtimes ONNX (wasm) doivent être chargeables depuis l'extension.
for (const v of ['', '.jsep', '.jspi', '.asyncify']) {
  const ok = await panel.evaluate((u) => import(u).then(() => true, (e) => String(e)), `chrome-extension://${extId}/ort/ort-wasm-simd-threaded${v}.mjs`);
  assert.equal(ok, true, `ort${v}.mjs : ${ok}`);
}
await panel.setViewportSize({ width: 760, height: 1100 });
await panel.screenshot({ path: 'test/feed.png' });

// ------------------------------------------------------------------ 2. recherche, langage naturel
await panel.fill('#q', 'tokio');
await panel.waitForTimeout(500);
assert.match(await panel.locator('.tw').first().innerText(), /tokio/i);
// carte de lien fournie par X : image, domaine, titre, description ; le lien n'est pas répété dans le texte
await panel.fill('#q', 'vector databases');
await panel.waitForSelector('.tw .lc');
assert.match(await panel.locator('.tw .lc .lc-t').first().innerText(), /Intro to vector databases/);
assert.match(await panel.locator('.tw .lc .lc-site').first().innerText(), /blog\.example\.com/);
assert.match(await panel.locator('.tw .lc .lc-d').first().innerText(), /practical guide/);
assert.equal(await panel.locator('.tw .lc').first().getAttribute('href'), 'https://blog.example.com/vector-db');
assert.ok(!(await panel.locator('.tw .tx').first().innerText()).includes('blog.example.com'), 'lien de la carte retiré du texte');
await waitFor(() => panel.locator('.tw .lc .lc-img').evaluate((i) => i.complete && i.naturalWidth > 0), 'image de carte chargée', 8000);
await panel.locator('.tw', { has: panel.locator('.lc') }).first().screenshot({ path: 'test/card.png' });
// réglage « Afficher l'image des cartes » : désactivé -> la carte reste, sans image
await panel.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, linkImages: false } }); });
await waitFor(async () => (await panel.locator('.tw .lc .lc-img').count()) === 0, 'image de carte masquée', 5000);
assert.equal(await panel.locator('.tw .lc .lc-t').count() > 0, true);
await panel.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, linkImages: true } }); });
await panel.fill('#q', 'from:@devops postgres');
await panel.waitForTimeout(500);
assert.equal(await panel.locator('.tw').count(), 1);
await panel.fill('#q', 'montre-moi le tweet le plus ancien de devops');
await panel.waitForTimeout(500);
assert.equal(await panel.locator('.tw').count(), 2, 'filtre auteur déduit du texte');
assert.match(await panel.locator('#mode').innerText(), /Auteur : @devops/);
await panel.locator('#mode button').click();
await panel.fill('#q', 'qzxqzx');
await panel.waitForTimeout(400);
assert.match(await panel.locator('#results').innerText(), /Aucun résultat/);

// filtres de la barre d'outils + tri
await panel.fill('#q', '');
await panel.click('.chip[data-type="link"]');
await panel.waitForTimeout(300);
assert.equal(await panel.locator('.tw').count(), 2, 'filtre « Liens » : deux tweets avec lien (tokio + carte)');
await panel.click('.chip[data-type="link"]');
await panel.selectOption('#sort', 'likes');
await panel.waitForTimeout(300);
assert.ok((await panel.locator('.tw').count()) >= 6);
await panel.selectOption('#sort', 'relevance');

// ------------------------------------------------------------------ 3. clavier, historique, recherches enregistrées, redécouverte, thèmes
await panel.focus('#q');
await panel.keyboard.press('ArrowDown');
assert.equal(await panel.evaluate(() => document.activeElement.classList.contains('tw')), true, '↓ depuis la recherche -> 1re carte');
const first = await panel.evaluate(() => document.activeElement.dataset.row);
await panel.keyboard.press('j');
assert.notEqual(await panel.evaluate(() => document.activeElement.dataset.row), first, 'j -> carte suivante');
await panel.keyboard.press('Escape');
assert.equal(await panel.evaluate(() => document.activeElement.id), 'q');

await panel.fill('#q', 'tokio');
await panel.click('#save');
await panel.waitForSelector('.saved .s');
assert.equal(await panel.locator('.saved .s').count(), 1);
await panel.click('#rand');
assert.ok((await panel.locator('.tw').count()) > 0, 'au hasard');
await panel.click('#yearago');
assert.match(await panel.locator('#mode').innerText(), /Il y a un an|Rien de sauvegardé/);
await panel.click('#themes');
await panel.waitForTimeout(400);
assert.match(await panel.locator('#mode').innerText(), /Pas assez de bookmarks indexés/);

// ------------------------------------------------------------------ 3b. la voie SÉMANTIQUE s'exécute de bout en bout (embedding de requête simulé)
// (régression : « expectDim is not defined » cassait toute recherche sémantique sans que rien ne le signale)
await panel.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('xbs'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = db.transaction(['tweets', 'vectors'], 'readwrite');
  { // un tweet qui contient le MOT « alpha » mais dont le vecteur est celui du thème « gamma » (axe 2)
    const v = new Float32Array(256); v[2] = 1;
    tx.objectStore('tweets').put({ id: 'kw0', text: 'zorglub terme littéral hors sujet', name: 'Kw', handle: 'kw', links: [], media: [], stats: {}, createdAt: '2026-08-02T10:00:00.000Z', sortIndex: '299', url: 'https://x.com/kw/status/kw0', capturedAt: Date.now() });
    tx.objectStore('vectors').put({ id: 'kw0', vec: v, model: 'onnx-community/embeddinggemma-300m-ONNX' });
  }
  for (let i = 0; i < 6; i++) { // 2 tweets par thème (axes 0, 1, 2), vecteurs du modèle par défaut
    const g = i % 3, id = 'sem' + i, v = new Float32Array(256); v[g] = 1;
    tx.objectStore('tweets').put({ id, text: `sujet ${['alpha', 'beta', 'gamma'][g]} numéro ${i}`, name: 'Sem', handle: 'sem', links: [], media: [], stats: {}, createdAt: '2026-08-02T10:00:00.000Z', sortIndex: String(300 - i), url: 'https://x.com/sem/status/' + id, capturedAt: Date.now() });
    tx.objectStore('vectors').put({ id, vec: v, model: 'onnx-community/embeddinggemma-300m-ONNX' });
  }
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
});
await panel.reload();
await panel.waitForFunction(() => /7 indexés sémantiquement/.test(document.getElementById('stats').textContent), null, { timeout: 15000 });
await panel.evaluate(() => { // le « modèle » répond comme si la requête était proche de l'axe 1 (« beta »)
  const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (m, ...r) => (m?.type === 'q:embed' ? Promise.resolve({ vec: Array.from({ length: 256 }, (_, i) => (i === 1 ? 1 : 0)), model: 'gemma1' }) : orig(m, ...r));
});
await panel.fill('#q', 'zzqqxx idée sans mot commun');
await waitFor(async () => /Hybride/.test(await panel.locator('#mode').innerText()), 'recherche hybride (voie sémantique)', 10000);
assert.match(await panel.locator('.tw').first().innerText(), /beta/, 'le résultat le plus proche en vecteur arrive en premier');
assert.ok(!/modèle indisponible/.test(await panel.locator('#mode').innerText()), 'pas d’erreur « modèle indisponible »');
// Équilibre : requête « zorglub » dont le sens (axe 1 simulé) pointe vers « beta », mais dont le MOT n'est que dans « kw0 »
await panel.fill('#q', 'zorglub');
await waitFor(async () => /zorglub terme littéral/.test((await panel.locator('.tw').first().innerText().catch(() => '')) || ''), 'équilibré : le mot exact + un peu de sens passe en premier', 10000);
await panel.selectOption('#blend', 'semantic');
await waitFor(async () => /beta/.test(await panel.locator('.tw').first().innerText()), 'sens d’abord : le résultat le plus proche en vecteur passe devant', 8000);
await panel.selectOption('#blend', 'keywords');
await waitFor(async () => /zorglub terme littéral/.test(await panel.locator('.tw').first().innerText()), 'mots exacts d’abord', 8000);
assert.equal((await panel.evaluate(() => JSON.parse(localStorage.getItem('xbs.view')))).blend, 'keywords', 'réglage mémorisé');
await panel.selectOption('#blend', 'balanced');
await panel.fill('#q', '');
await panel.evaluate(async () => { // nettoyage : ces tweets de test ne doivent pas fausser la suite
  const db = await new Promise((res, rej) => { const r = indexedDB.open('xbs'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = db.transaction(['tweets', 'vectors'], 'readwrite');
  for (let i = 0; i < 6; i++) { tx.objectStore('tweets').delete('sem' + i); tx.objectStore('vectors').delete('sem' + i); }
  tx.objectStore('tweets').delete('kw0'); tx.objectStore('vectors').delete('kw0');
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
});
await panel.reload();
await panel.waitForSelector('.tw');

// ------------------------------------------------------------------ 4. export / import (clair et chiffré)
await panel.fill('#q', '');
await panel.click('#gear');
const [dl1] = await Promise.all([panel.waitForEvent('download'), panel.click('#bk-export')]);
const plain = JSON.parse(readFileSync(await dl1.path(), 'utf8'));
assert.equal(plain.tweets.length, 11);
await panel.setInputFiles('#bk-import', await dl1.path());
await panel.waitForFunction(() => /0 nouveaux/.test(document.getElementById('bk-msg').textContent));
await panel.fill('#bk-pass', 'pw');
const [dl2] = await Promise.all([panel.waitForEvent('download'), panel.click('#bk-export')]);
assert.ok(dl2.suggestedFilename().endsWith('.xbsbak'));
const encBytes = readFileSync(await dl2.path());
assert.ok(!encBytes.toString('latin1').includes('Kubernetes'), 'le fichier chiffré ne contient pas le texte en clair');
await panel.setInputFiles('#bk-import', await dl2.path());
await panel.waitForFunction(() => /0 nouveaux/.test(document.getElementById('bk-msg').textContent));
await panel.fill('#bk-pass', 'mauvais');
await panel.setInputFiles('#bk-import', await dl2.path());
await panel.waitForFunction(() => /incorrect/.test(document.getElementById('bk-msg').textContent));
await panel.keyboard.press('Escape');

// ------------------------------------------------------------------ 5. IA (faux fournisseur)
await panel.evaluate(() => chrome.storage.local.set({ settings: {
  llm: { baseUrl: 'https://llm.test/v1', model: 'm', apiKey: 'secret-key' }, aiIntent: true, aiRerank: false, enrichLinks: false, imageSearch: false, autoSync: true } }));
await panel.reload();
await panel.waitForSelector('.tw');
await panel.fill('#q', 'scheduler tokio');
await panel.waitForSelector('#ask:not([hidden])');
await panel.click('#ask');
await panel.waitForSelector('.ans a.cite');
assert.match(await panel.locator('.ans').innerText(), /Réponse mock/);
assert.ok(llmLog.some((l) => l.auth === 'Bearer secret-key'), 'clé d’API envoyée');
await panel.click('#ans-x');
// compréhension par l'IA : tri + auteur + sujet
await panel.fill('#q', 'les tweets les plus anciens de devops à propos de kubernetes');
await waitFor(async () => /compris par l’IA/.test(await panel.locator('#mode').innerText()), 'intention IA', 15000);
assert.match(await panel.locator('.tw').first().innerText(), /Kubernetes/);
await panel.fill('#q', '');
await panel.click('#digest');
await panel.waitForSelector('.ans a.cite');
assert.match(await panel.locator('.ans').innerText(), /Infra/);

// ---- Jev : reclassement + compréhension de la requête (tri) ----
await panel.evaluate(() => chrome.storage.local.set({ settings: {
  llm: { baseUrl: 'https://llm.test/v1', model: 'm', apiKey: 'secret-key' }, aiIntent: false, aiRerank: false, enrichLinks: false, imageSearch: false, autoSync: true,
  decision: { url: 'https://llm.test/api/alpha/decisions', model: 'typesafe/jev-1.13', apiKey: 'jev-key' }, decisionIntent: true, decisionRerank: true } }));
await panel.reload();
await panel.waitForSelector('.tw');
await panel.fill('#q', 'memory agents');
await waitFor(async () => /reclassé par Jev/.test(await panel.locator('#mode').innerText()), 'reclassement Jev', 15000);
assert.match(await panel.locator('.tw').first().innerText(), /persist their memory/, 'Jev place le tweet jugé pertinent en premier');
assert.ok(jevLog.some((j) => j.auth === 'Bearer jev-key' && j.model === 'typesafe/jev-1.13' && j.keys.includes('pertinent')), 'requête Decisions conforme');
await panel.fill('#q', 'montre les tweets les plus récents sur les agents cette semaine');
await waitFor(async () => /compris par Jev/.test(await panel.locator('#mode').innerText()), 'intention Jev', 15000);
assert.ok(jevLog.some((j) => ['sort', 'period', 'kind'].every((k) => j.keys.includes(k))), 'questions d’intention envoyées');
await panel.fill('#q', '');

// les recherches enregistrées survivent à un rechargement
await panel.reload();
await panel.waitForSelector('.tw');
assert.equal(await panel.locator('.saved .s').count(), 1);
await panel.screenshot({ path: 'test/panel.png' });

// ------------------------------------------------------------------ 6. synchro complète depuis le panneau (XHR, sans onglet X) + bookmarks supprimés
await p.close();
hits.length = 0;
drop = '2002'; // ce bookmark n'existe plus côté X
await panel.click('#sync');
await waitFor(() => sameHits([null, null, 'CUR_NEXT', 'P3', 'P4']), 'synchro complète depuis le panneau');
await panel.waitForFunction(() => /Synchro terminée/.test(document.getElementById('progress').textContent), null, { timeout: 30000 });
await panel.waitForSelector('#banners .bn:has-text("n’existent plus")');
await panel.click('#banners .bn button:has-text("Les retirer")');
await panel.waitForFunction(() => /10 bookmarks/.test(document.getElementById('stats').textContent));

// ------------------------------------------------------------------ 7. nouveautés seulement : s'arrête dès que tout est connu
hits.length = 0;
await panel.click('#news');
await panel.waitForFunction(() => /Nouveautés terminée/.test(document.getElementById('progress').textContent), null, { timeout: 40000 });
assert.ok(sameHits([null, 'CUR_NEXT']), 'incrémental : 2 pages seulement, obtenu ' + JSON.stringify(hits));

// ------------------------------------------------------------------ 8. thèmes + « similaires » avec de faux vecteurs (3 groupes)
await panel.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('xbs'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = db.transaction(['tweets', 'vectors'], 'readwrite');
  const topics = [['rust', 'cargo', 'tokio runtime'], ['pain', 'levain', 'boulangerie fermentation'], ['agents', 'memoire', 'llm vector store']];
  for (let i = 0; i < 45; i++) {
    const g = i % 3, id = 'th' + i;
    tx.objectStore('tweets').put({ id, text: `${topics[g][0]} ${topics[g][1]} ${topics[g][2]} numero ${i}`, name: 'Th', handle: 'th' + g, links: [], media: [], stats: { likes: i },
      createdAt: '2026-08-01T10:00:00.000Z', sortIndex: String(500 - i), url: 'https://x.com/th/status/' + id, capturedAt: Date.now() });
    const v = new Float32Array(256); v[g] = 1; v[10 + (i % 7)] = 0.05;
    tx.objectStore('vectors').put({ id, vec: v, model: 'onnx-community/embeddinggemma-300m-ONNX' });
  }
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
});
await panel.reload();
await panel.waitForFunction(() => /45 indexés/.test(document.getElementById('stats').textContent) || /\b4[5-9] indexés|[5-9]\d indexés/.test(document.getElementById('stats').textContent));
await panel.click('#themes');
await panel.waitForSelector('.th');
assert.ok((await panel.locator('.th').count()) >= 3, 'au moins 3 thèmes');
const names = (await panel.locator('.th b').allInnerTexts()).join(' ');
for (const w of ['rust', 'levain', 'agents']) assert.ok(names.includes(w), `thème « ${w} » dans : ${names}`);
await panel.locator('.th', { hasText: 'levain' }).first().click();
await panel.waitForSelector('.tw');
assert.match(await panel.locator('#mode').innerText(), /Thème :/);
assert.equal(await panel.locator('.tw').count(), 15, 'le thème « pain/levain » contient 15 tweets');
await panel.locator('.tw .sim').first().click();
assert.match(await panel.locator('#mode').innerText(), /Similaires à/);

// ------------------------------------------------------------------ 9. changement de modèle : Gemma 2 (768 dim), vecteurs rattachés à leur modèle
const setModel = (key) => panel.evaluate(async (k) => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, embedModel: k } });
}, key);
await setModel('gemma2');
await panel.waitForFunction(() => /0 indexés sémantiquement \(EmbeddingGemma 2\)/.test(document.getElementById('stats').textContent), null, { timeout: 15000 });
assert.equal(await panel.locator('.tw .sim').count(), 0, 'plus de « Similaires » sans vecteur du bon modèle');
await panel.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('xbs'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = db.transaction('vectors_gemma2', 'readwrite');
  for (let i = 0; i < 45; i++) {
    const g = i % 3, v = new Float32Array(768); v[g * 200] = 1; v[500 + (i % 7)] = 0.05;
    tx.objectStore('vectors_gemma2').put({ id: 'th' + i, vec: v, model: 'onnx-community/embeddinggemma-2-ONNX' });
  }
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
});
await panel.reload();
await panel.waitForFunction(() => /45 indexés sémantiquement \(EmbeddingGemma 2\)/.test(document.getElementById('stats').textContent), null, { timeout: 15000 });
await panel.click('#themes');
await panel.waitForSelector('.th');
assert.ok((await panel.locator('.th').count()) >= 3, 'thèmes en 768 dimensions');
await setModel('gemma1');
await panel.waitForFunction(() => /45 indexés sémantiquement \(EmbeddingGemma\)/.test(document.getElementById('stats').textContent), null, { timeout: 15000 });

// ------------------------------------------------------------------ 10. export AVEC vecteurs -> on les efface -> import -> ils reviennent
await panel.click('#gear');
await panel.check('#bk-vecs');
await panel.fill('#bk-pass', '');
const [dl3] = await Promise.all([panel.waitForEvent('download'), panel.click('#bk-export')]);
const withVecs = JSON.parse(readFileSync(await dl3.path(), 'utf8'));
assert.equal(withVecs.vectors.ids.length, 45, 'vecteurs du modèle courant exportés');
assert.equal(withVecs.vectors.dim, 256);
assert.ok(Array.isArray(withVecs.saved) && withVecs.saved.includes('tokio'), 'recherches enregistrées exportées');
await panel.keyboard.press('Escape');
await panel.evaluate(async () => { // efface tous les vecteurs de Gemma 1
  const db = await new Promise((res, rej) => { const r = indexedDB.open('xbs'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = db.transaction('vectors', 'readwrite');
  tx.objectStore('vectors').clear();
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
});
await panel.reload();
await panel.waitForFunction(() => /\b0 indexés sémantiquement/.test(document.getElementById('stats').textContent), null, { timeout: 15000 });
await panel.click('#gear');
await panel.setInputFiles('#bk-import', await dl3.path());
await panel.waitForFunction(() => /45 vecteurs restaurés/.test(document.getElementById('bk-msg').textContent), null, { timeout: 15000 });
await panel.keyboard.press('Escape');
await panel.waitForFunction(() => /45 indexés sémantiquement/.test(document.getElementById('stats').textContent), null, { timeout: 15000 });

// ------------------------------------------------------------------ 10b. sécurité mémoire : indexation MANUELLE par défaut, CPU par défaut, arrêt, libération
await panel.click('#gear');
assert.equal(await panel.locator('#compute').inputValue(), 'cpu', 'calcul CPU par défaut');
assert.equal(await panel.locator('#opt-autoindex').isChecked(), false, 'indexation automatique désactivée par défaut');
await waitFor(async () => /Tas JS : panneau \d+ Mo/.test(await panel.locator('#mem-info').innerText()), 'mesure mémoire', 8000);
await panel.click('#mem-free');
await waitFor(async () => /en veille|actif/.test(await panel.locator('#mem-info').innerText()), 'libération mémoire', 8000);
await panel.selectOption('#compute', 'auto');
assert.equal((await panel.evaluate(() => chrome.storage.local.get('settings'))).settings.compute, 'auto');
await panel.selectOption('#compute', 'cpu');
await panel.check('#opt-autoindex');
assert.equal((await panel.evaluate(() => chrome.storage.local.get('settings'))).settings.indexMode, 'auto');
await panel.uncheck('#opt-autoindex');
assert.equal((await panel.evaluate(() => chrome.storage.local.get('settings'))).settings.indexMode, 'manual');
await panel.click('#idx-pause');
await panel.keyboard.press('Escape');

// ------------------------------------------------------------------ 11. interface : bandeau repliable, grille, textes longs, défilement infini
await panel.setViewportSize({ width: 1400, height: 900 });
await panel.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('xbs'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = db.transaction('tweets', 'readwrite');
  tx.objectStore('tweets').put({ id: 'long1', text: 'Un très long tweet. ' + 'Beaucoup de texte pour dépasser la limite. '.repeat(40), name: 'Long', handle: 'long', links: [], media: [], stats: {},
    createdAt: '2026-09-30T10:00:00.000Z', sortIndex: '9999', url: 'https://x.com/long/status/long1', capturedAt: Date.now() });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
});
await panel.reload();
await panel.waitForSelector('.tw');
// texte long replié, « Afficher plus » le déplie
const card = panel.locator('.tw', { hasText: 'Un très long tweet' });
await card.locator('.more-t').click();
assert.equal(await card.evaluate((e) => e.classList.contains('open')), true);
assert.match(await card.locator('.more-t').innerText(), /moins/);
// bandeau repliable, état conservé après rechargement
assert.equal(await panel.locator('#extras').isVisible(), true);
await panel.click('#fold');
assert.equal(await panel.locator('#extras').isVisible(), false, 'filtres repliés');
assert.equal(await panel.locator('#q').isVisible(), true, 'la recherche reste visible');
await panel.reload();
await panel.waitForSelector('.tw');
assert.equal(await panel.locator('#extras').isVisible(), false, 'repli mémorisé');
await panel.keyboard.press('Alt+f');
assert.equal(await panel.locator('#extras').isVisible(), true, 'Alt+F déplie');
// grille × 3 sur toute la largeur
await panel.selectOption('#view', '3');
const cols = await panel.locator('#results').evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(' ').length);
assert.equal(cols, 3, '3 colonnes');
const xs = await panel.locator('.tw').evaluateAll((els) => els.slice(0, 3).map((e) => Math.round(e.getBoundingClientRect().left)));
assert.equal(new Set(xs).size, 3, 'les 3 premières cartes côte à côte : ' + xs);
const w = await panel.locator('#results').evaluate((e) => e.getBoundingClientRect().width);
assert.ok(w > 1200, 'la grille prend toute la largeur : ' + w);
// défilement infini : 40 cartes d'abord, la suite au scroll
assert.equal(await panel.locator('.tw').count(), 40);
await panel.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await waitFor(async () => (await panel.locator('.tw').count()) > 40, 'défilement infini', 10000);
// retour en liste
await panel.selectOption('#view', 'list');
assert.equal(await panel.evaluate(() => document.body.classList.contains('grid')), false);
await panel.screenshot({ path: 'test/list.png' });
await panel.selectOption('#view', '3');
await panel.evaluate(() => window.scrollTo(0, 0));
await panel.screenshot({ path: 'test/grid.png' });

// ------------------------------------------------------------------ 12. mode sombre + page de statistiques (jeu de données synthétique : 300 tweets sur 100 jours)
await panel.evaluate(async () => {
  const X_EPOCH = 1288834974657n, DAY = 86_400_000, now = Date.now();
  const snow = (ms) => ((BigInt(ms) - X_EPOCH) << 22n).toString();
  const db = await new Promise((res, rej) => { const r = indexedDB.open('xbs'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = db.transaction(['tweets', 'vectors', 'vectors_gemma2'], 'readwrite');
  for (const st of ['tweets', 'vectors', 'vectors_gemma2']) tx.objectStore(st).clear();
  const names = { a: 'Auteur A', b: 'Auteur B', c: 'Auteur C', d: 'Auteur D', e: 'Auteur E', f: 'Auteur F' };
  for (let i = 0; i < 300; i++) {
    const handle = i % 5 === 0 ? 'a' : i % 7 === 0 ? 'b' : ['c', 'd', 'e', 'f'][i % 4];
    const saved = now - (i % 100) * DAY - ((i * 7) % 20) * 3_600_000; // 3 tweets par jour, à des heures variées
    const pub = saved - (1 + (i % 9)) * DAY;
    tx.objectStore('tweets').put({ id: 's' + i, name: names[handle], handle, lang: i % 2 ? 'fr' : 'en', createdAt: new Date(pub).toISOString(), sortIndex: snow(saved),
      text: `Tweet numéro ${i} sur les agents et la mémoire ${i % 6 === 0 ? '#ia' : ''}`, url: `https://x.com/${handle}/status/s${i}`,
      links: i % 3 === 1 ? ['https://blog' + (i % 3) + '.example.com/p' + (i % 5)] : [], media: i % 4 === 0 ? [{ type: i % 8 === 0 ? 'video' : 'photo', url: 'https://x/y.jpg' }] : [],
      stats: { likes: (i * 37) % 5000, reposts: 1 }, capturedAt: now });
  }
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
});
// thème : le bouton fait tourner auto -> sombre -> clair, et le fond change vraiment
await panel.reload();
await panel.waitForSelector('.tw');
const bg = () => panel.evaluate(() => getComputedStyle(document.body).backgroundColor);
await panel.evaluate(() => localStorage.setItem('xbs.theme', 'light'));
await panel.reload(); await panel.waitForSelector('.tw');
assert.equal(await bg(), 'rgb(255, 255, 255)', 'thème clair forcé');
await panel.click('#theme'); // light -> auto
await panel.click('#theme'); // auto -> dark
assert.equal(await panel.evaluate(() => document.documentElement.dataset.theme), 'dark');
assert.equal(await bg(), 'rgb(0, 0, 0)', 'thème sombre forcé');
await panel.reload(); await panel.waitForSelector('.tw');
assert.equal(await bg(), 'rgb(0, 0, 0)', 'le thème est mémorisé après rechargement');
// opérateur saved: dans le panneau (3 tweets par jour)
await panel.evaluate(() => localStorage.setItem('xbs.theme', 'light'));
await panel.reload(); await panel.waitForSelector('.tw');
const today = await panel.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });

const stats = await ctx.newPage();
await stats.setViewportSize({ width: 1360, height: 900 });
await stats.goto(`chrome-extension://${extId}/stats.html`);
await stats.waitForSelector('.kpis .tile.hero .v');
const hero = async () => Number((await stats.locator('.tile.hero .v').innerText()).replace(/\D/g, ''));
assert.equal(await hero(), 270, '90 jours = 90 × 3 bookmarks');
assert.match(await stats.locator('.tile.hero .l').innerText(), /90 j/);
assert.equal(await stats.locator('.note').count(), 0, 'dates d’enregistrement jugées fiables : pas d’avertissement');
for (const t of ['Bookmarks par jour', 'Calendrier de l’année', 'Par jour de la semaine', 'Par heure de la journée', 'Types de tweets', 'Auteurs les plus enregistrés', 'Sites les plus cités', 'Tweets les plus likés']) {
  assert.ok((await stats.locator('h3', { hasText: t }).count()) > 0, 'carte : ' + t);
}
const cells = await stats.locator('.cell.mk').count();
assert.ok(cells >= 365 && cells <= 371, 'calendrier : ' + cells + ' cases');
// filtre de période : un seul filtre scope tout
await stats.click('#ranges button:has-text("Tout")');
await waitFor(async () => (await hero()) === 300, 'filtre « Tout »', 8000);
await stats.click('#ranges button:has-text("7 j")');
await waitFor(async () => (await hero()) === 21, 'filtre « 7 j » (7 × 3)', 8000);
await stats.click('#ranges button:has-text("90 j")');
await waitFor(async () => (await hero()) === 270, 'retour à 90 j', 8000);
// jumeau « tableau » : mêmes valeurs, sans dépendre de l'infobulle
const c0 = stats.locator('.card').first();
await c0.locator('.tbl-btn').click();
assert.equal(await c0.locator('.tbl').isVisible(), true);
assert.equal(await c0.locator('.viz').isVisible(), false);
assert.ok((await c0.locator('.tbl tbody tr').count()) >= 90, 'une ligne par jour');
await c0.locator('.tbl-btn').click();
// infobulle sur une marque (survol d'une barre d'auteur)
const authorCard = stats.locator('.card', { hasText: 'Auteurs les plus enregistrés' });
await authorCard.locator('.mk').first().hover();
await waitFor(async () => (await stats.locator('.tip').count()) > 0 && (await stats.locator('.tip').first().isVisible()), 'infobulle', 4000);
assert.match(await stats.locator('.tip').first().innerText(), /Auteur A/);
// clic sur la 1re barre d'auteur -> ouvre le panneau avec from:@a
const [popup] = await Promise.all([ctx.waitForEvent('page'), authorCard.locator('.mk').first().click()]);
await popup.waitForLoadState();
assert.equal(await popup.locator('#q').inputValue(), 'from:@a', 'la requête passe au panneau');
await popup.waitForSelector('.tw');
assert.equal(await popup.locator('.tw .hd .nm', { hasText: 'Auteur A' }).count() > 0, true);
await popup.close();
// clic sur le carré « aujourd'hui » du calendrier -> saved:AAAA-MM-JJ -> exactement les 3 tweets du jour
const [popup2] = await Promise.all([ctx.waitForEvent('page'), stats.locator('.cell.mk').last().click()]);
await popup2.waitForLoadState();
assert.equal(await popup2.locator('#q').inputValue(), 'saved:' + today);
await popup2.waitForSelector('.tw');
assert.equal(await popup2.locator('.tw').count(), 3, 'saved:aujourd’hui = 3 tweets');
await popup2.close();
// pastille (hashtag) -> chercher
assert.ok((await stats.locator('.chip-s', { hasText: '#ia' }).count()) > 0, 'hashtag #ia');
assert.ok((await stats.locator('.chip-s', { hasText: 'mémoire' }).count()) > 0, 'mot « mémoire » avec accent');
// captures dans les deux thèmes (inspection visuelle)
await stats.evaluate(() => { localStorage.setItem('xbs.theme', 'light'); document.documentElement.dataset.theme = 'light'; });
await stats.screenshot({ path: 'test/stats-light.png', fullPage: true });
await stats.click('#theme'); await stats.click('#theme'); // light -> auto -> dark
assert.equal(await stats.evaluate(() => document.documentElement.dataset.theme), 'dark');
assert.equal(await stats.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(13, 13, 13)');
await stats.screenshot({ path: 'test/stats-dark.png', fullPage: true });

console.log('E2E OK');
await ctx.close();
server.close();
