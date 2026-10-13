// Test de bout en bout : charge l'extension dans Chromium, simule x.com/i/bookmarks (réseau mocké),
// vérifie capture -> IndexedDB -> synchro (pagination) -> recherche dans le panneau.
// Lancer : npm run build && xvfb-run -a node test/e2e.mjs   (playwright doit être installé)
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { demoPage, page } from './fixtures/bookmarks.js';

const dist = path.resolve('dist');
const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'xbs-')), {
  headless: false,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-sandbox'],
});

const MORE = [
  ['2001', 'devops', 'DevOps', 'Kubernetes autoscaling with KEDA, event driven scaling tutorial', {}],
  ['2002', 'devops', 'DevOps', 'Postgres vacuum tuning for very large tables', {}],
];
const hits = [];
await ctx.route('https://x.com/**', async (route) => {
  const url = new URL(route.request().url());
  if (/\/Bookmarks$/.test(url.pathname)) {
    const vars = JSON.parse(url.searchParams.get('variables') || '{}');
    hits.push(vars.cursor || null);
    const body = vars.cursor === 'CUR_NEXT'
      ? page({ cursor: null, tweets: MORE.map(([id, h, n, t], i) => ({
          entryId: 'tweet-' + id, sortIndex: String(1000 - i),
          content: { itemContent: { tweet_results: { result: { rest_id: id, core: { user_results: { result: { core: { screen_name: h, name: n } } } }, legacy: { full_text: t, created_at: 'Wed Sep 17 10:00:00 +0000 2026', lang: 'en', entities: { urls: [] } } } } } },
        })) })
      : demoPage('CUR_NEXT');
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  }
  route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><title>X</title><body><script>
      fetch('/i/api/graphql/QID123/Bookmarks?variables=' + encodeURIComponent(JSON.stringify({count:20,includePromotedContent:false})), {headers:{authorization:'Bearer x','x-csrf-token':'t'}});
    </script>Bookmarks mock</body>`,
  });
});
await ctx.route('https://huggingface.co/**', (r) => r.abort()); // pas de modèle dans ce test

const p = await ctx.newPage();
await p.goto('https://x.com/i/bookmarks');
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
await panel.waitForSelector('.card');
await panel.waitForFunction(() => /8 bookmarks/.test(document.getElementById('stats').textContent));

await panel.fill('#q', 'tokio');
await panel.waitForTimeout(500);
assert.match(await panel.locator('.card').first().innerText(), /tokio/i);

await panel.fill('#q', 'from:@devops postgres');
await panel.waitForTimeout(500);
assert.equal(await panel.locator('.card').count(), 1);

await panel.fill('#q', 'qzxqzx');
await panel.waitForTimeout(400);
assert.match(await panel.locator('#results').innerText(), /Aucun résultat/);

await panel.screenshot({ path: 'test/panel.png' });
console.log('E2E OK — requêtes Bookmarks:', hits);
await ctx.close();
