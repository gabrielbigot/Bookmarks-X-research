// Test de bout en bout : charge l'extension dans Chromium, simule x.com/i/bookmarks (réseau mocké),
// vérifie capture -> IndexedDB -> synchro (pagination) -> recherche dans le panneau.
// Lancer : npm run build && xvfb-run -a node test/e2e.mjs   (playwright doit être installé)
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { demoPage, page } from './fixtures/bookmarks.js';

const dist = path.resolve('dist');
const tmp = mkdtempSync(path.join(tmpdir(), 'xbs-'));
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tmp}/k.pem -out ${tmp}/c.pem -days 1 -subj /CN=x.com 2>/dev/null`);

const MORE = [
  ['2001', 'devops', 'DevOps', 'Kubernetes autoscaling with KEDA, event driven scaling tutorial', {}],
  ['2002', 'devops', 'DevOps', 'Postgres vacuum tuning for very large tables', {}],
];
const hits = [];
// Faux x.com : x.com est résolu vers 127.0.0.1 (voir --host-resolver-rules).
const server = https.createServer({ key: readFileSync(`${tmp}/k.pem`), cert: readFileSync(`${tmp}/c.pem`) }, (req, res) => {
  const url = new URL(req.url, 'https://x.com');
  if (/\/Bookmarks$/.test(url.pathname)) {
    const vars = JSON.parse(url.searchParams.get('variables') || '{}');
    hits.push(vars.cursor || null);
    const body = vars.cursor === 'CUR_NEXT'
      ? page({ cursor: null, tweets: MORE.map(([id, h, n, t], i) => ({
          entryId: 'tweet-' + id, sortIndex: String(1000 - i),
          content: { itemContent: { tweet_results: { result: { rest_id: id, core: { user_results: { result: { core: { screen_name: h, name: n } } } }, legacy: { full_text: t, created_at: 'Wed Sep 17 10:00:00 +0000 2026', lang: 'en', entities: { urls: [] } } } } } },
        })) })
      : demoPage('CUR_NEXT');
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
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-sandbox',
    '--host-resolver-rules=MAP x.com 127.0.0.1, MAP huggingface.co 127.0.0.1:1', '--ignore-certificate-errors', '--no-proxy-server'],
});

const p = await ctx.newPage();
await p.goto('https://x.com/i/bookmarks?via=fetch'); // scénario 1 : fetch
await p.waitForTimeout(1500);
// Le bouton injecté doit exister (shadow DOM fermé -> on vérifie via l'hôte).
assert.ok(await p.evaluate(() => [...document.documentElement.children].some((e) => e.style.zIndex === '2147483646')), 'pill injecté');

// Lance la synchro depuis la page (comme le bouton).
await p.evaluate(() => window.postMessage({ src: 'xbs-ctl', type: 'start' }, '*'));
await p.waitForTimeout(6000);
assert.deepEqual(hits, [null, 'CUR_NEXT'], 'pagination par curseur');

let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;

const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html`);
await panel.waitForSelector('.tw');
await panel.waitForFunction(() => /8 bookmarks/.test(document.getElementById('stats').textContent));

// Les runtimes ONNX (wasm) doivent être chargeables depuis l'extension (régression : variante asyncify absente).
for (const v of ['', '.jsep', '.jspi', '.asyncify']) {
  const ok = await panel.evaluate((u) => import(u).then(() => true, (e) => String(e)), `chrome-extension://${extId}/ort/ort-wasm-simd-threaded${v}.mjs`);
  assert.equal(ok, true, `ort${v}.mjs : ${ok}`);
}
await panel.setViewportSize({ width: 760, height: 1100 });
await panel.screenshot({ path: 'test/feed.png' });
await panel.fill('#q', 'tokio');
await panel.waitForTimeout(500);
assert.match(await panel.locator('.tw').first().innerText(), /tokio/i);

await panel.fill('#q', 'from:@devops postgres');
await panel.waitForTimeout(500);
assert.equal(await panel.locator('.tw').count(), 1);

// Langage naturel : tri + auteur (« le plus ancien tweet de devops »).
await panel.fill('#q', 'montre-moi le tweet le plus ancien de devops');
await panel.waitForTimeout(500);
assert.equal(await panel.locator('.tw').count(), 2, 'filtre auteur déduit du texte');
assert.match(await panel.locator('#mode').innerText(), /Auteur : @devops/);
await panel.locator('#mode button').click(); // « ✕ retirer »
await panel.waitForTimeout(400);
assert.ok((await panel.locator('.tw').count()) >= 0);

await panel.fill('#q', 'qzxqzx');
await panel.waitForTimeout(400);
assert.match(await panel.locator('#results').innerText(), /Aucun résultat/);

await panel.screenshot({ path: 'test/panel.png' });

// Scénario 2 (page en XMLHttpRequest, comme le vrai X) : aucun onglet X ouvert, clic sur « Tout synchroniser » dans le panneau -> démarre seul.
await p.close();
hits.length = 0;
await panel.click('#sync');
await panel.waitForFunction(() => /terminée/.test(document.getElementById('progress').textContent), null, { timeout: 30000 });
assert.deepEqual(hits, [null, 'CUR_NEXT'], 'synchro lancée depuis le panneau sans onglet X');
console.log('E2E OK — requêtes Bookmarks:', hits);
await ctx.close();
server.close();
