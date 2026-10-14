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

const mk = (id, handle, name, text, si) => ({
  entryId: 'tweet-' + id, sortIndex: String(si),
  content: { itemContent: { tweet_results: { result: { rest_id: id, core: { user_results: { result: { core: { screen_name: handle, name } } } },
    legacy: { full_text: text, created_at: 'Wed Sep 17 10:00:00 +0000 2026', lang: 'en', entities: { urls: [] } } } } } },
});
const CHAIN = {
  CUR_NEXT: () => ['P3', [mk('2001', 'devops', 'DevOps', 'Kubernetes autoscaling with KEDA, event driven scaling tutorial', 1000), mk('2002', 'devops', 'DevOps', 'Postgres vacuum tuning for very large tables', 999)]],
  P3: () => ['P4', [mk('3001', 'misc', 'Misc', 'Rust async runtime benchmarks compared', 900), mk('3002', 'misc', 'Misc', 'Sourdough starter hydration tips', 899)]],
  P4: () => [null, [mk('4001', 'misc', 'Misc', 'Final tweet about vector databases', 800)]],
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
assert.equal(await panel.locator('.tw').count(), 1, 'filtre « Liens » : un seul tweet avec lien');
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

console.log('E2E OK');
await ctx.close();
server.close();
