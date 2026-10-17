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
// ---------------- faux YouTube ----------------
const run = (t) => ({ runs: [{ text: t }] });
const pvr = (id, title, channel, pos) => ({ playlistVideoRenderer: { videoId: id, title: run(title), index: { simpleText: String(pos) }, lengthText: { simpleText: '12:34' }, lengthSeconds: '754',
  shortBylineText: { runs: [{ text: channel, navigationEndpoint: { browseEndpoint: { browseId: 'UC' + channel.length, canonicalBaseUrl: '/@' + channel.toLowerCase().replace(/\s+/g, '-') } } }] },
  thumbnail: { thumbnails: [{ url: 'https://llm.test/card.png' }] }, videoInfo: { runs: [{ text: '1,2 M de vues' }, { text: ' • ' }, { text: 'il y a 2 ans' }] }, isPlayable: true } });
const cont = (t) => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: t } } } });
const grid = (id, title, n) => ({ gridPlaylistRenderer: { playlistId: id, title: run(title), videoCountText: run(n + ' vidéos') } });
const V = { w1: ['Le cerveau expliqué', 'Chaîne Neuro'], w2: ['Recette de ramen maison', 'Cuisine Fun'], w3: ['Rust async en 20 minutes', 'Dev Chan'], l1: ['Documentaire sur la mer', 'Océan TV'],
  p2: ['How memory works in the brain', 'Brain Lab'], c1: ['Pain au levain facile', 'Cuisine Fun'], m1: ['Lo-fi beats pour coder', 'Chill Lab'] };
const PLAYLISTS = { WL: ['w1', 'w2', 'w3'], LL: ['l1'], PL1: ['w1', 'p2'], PL2: ['w2', 'c1'], PL3: ['m1'] };
let ytDrop = null; // vidéo retirée de TOUTES les playlists (simule « retirée côté YouTube »)
const ytLog = [];
const ytItems = (pid) => PLAYLISTS[pid].filter((v) => v !== ytDrop).map((v, i) => pvr(v, V[v][0], V[v][1], i + 1));
// historique : 4 pages (HP1 -> HC1 -> HC2 -> HC3), groupées par jour avec les libellés français de YouTube
const DAYS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const dayLabel = (n) => n === 0 ? "Aujourd'hui" : n === 1 ? 'Hier' : DAYS_FR[new Date(Date.now() - n * 864e5).getDay()];
const dayIso = (n) => { const d = new Date(Date.now() - n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
Object.assign(V, { h2: ['Histoire de Rome en 10 minutes', 'Hist Chan'], h4: ['Conférence sur la mémoire', 'Hist Chan'], h5: ['Tutoriel pâtes fraîches', 'Cuisine Fun'], h6: ['Nouveauté du jour : zorglub', 'Hist Chan'], h7: ['Vieux sujet oublié', 'Hist Chan'] });
let histNew = false;
const PLAYER_ONLY = new Set(['p2']); // pas de panneau « Transcription » : sous-titres du lecteur (repli timedtext)
// transcriptions : [début en ms, texte] ; les vidéos absentes d'ici n'ont pas de transcription
const TRANSCRIPTS = {
  w1: [[0, 'Bonjour et bienvenue ' + 'blabla '.repeat(70)], [60000, 'Aujourd’hui on parle du cortex ' + 'blabla '.repeat(70)], [125000, 'et surtout du zorglubtranscript, un mot que le titre ne contient pas'], [200000, 'Merci d’avoir regardé jusqu’au bout']],
  p2: [[0, 'Memory is stored in synapses and consolidated during sleep']],
  w3: [[0, 'Les futures et les tâches asynchrones expliquées avec tokio']],
};
const vrd = (id, pct) => ({ videoRenderer: { videoId: id, title: run(V[id][0]), ownerText: { runs: [{ text: V[id][1], navigationEndpoint: { browseEndpoint: { browseId: 'UCh', canonicalBaseUrl: '/@' + V[id][1].toLowerCase().replace(/\s+/g, '-') } } }] },
  lengthText: { simpleText: '8:00' }, viewCountText: { simpleText: '5 000 vues' }, thumbnail: { thumbnails: [{ url: 'https://llm.test/card.png' }] },
  thumbnailOverlays: pct ? [{ thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: pct } }] : [] } });
const hsec = (n, ...ids) => ({ itemSectionRenderer: { header: { itemSectionHeaderRenderer: { title: { simpleText: dayLabel(n) } } }, contents: ids.map((i) => (Array.isArray(i) ? vrd(...i) : vrd(i))) } });
const histPage = (b) => {
  if (b.browseId === 'FEhistory') return { contents: [hsec(0, ...(histNew ? ['h6'] : []), ['w1', 60], 'h2'), hsec(1, 'l1'), cont('HC1')] };
  if (b.continuation === 'HC1') return { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [hsec(2, 'h4'), cont('HC2')] } }] };
  if (b.continuation === 'HC2') return { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [hsec(3, 'h5'), cont('HC3')] } }] };
  if (b.continuation === 'HC3') return { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [hsec(4, 'h7')] } }] };
  return null;
};
const ytBrowse = (b) => {
  const hp = histPage(b); if (hp) return hp;
  if (b.continuation === 'LISTCONT') return { contents: [grid('PL3', 'Musique', 1)] };
  if (b.continuation === 'WLC') return { contents: ytItems('WL').slice(2) };
  const pid = (b.browseId || '').slice(2);
  if (!PLAYLISTS[pid]) return {};
  const header = { playlistHeaderRenderer: { playlistId: pid, title: run({ WL: 'À regarder plus tard', LL: 'Vidéos que j’aime', PL1: 'Neurosciences', PL2: 'Cuisine', PL3: 'Musique' }[pid]) } };
  if (pid === 'WL') return { header, contents: [...ytItems('WL').slice(0, 2), cont('WLC')] };
  return { header, contents: ytItems(pid) };
};
const ytPage = () => `<!doctype html><title>Playlists - YouTube</title><body><script>
  document.cookie = 'SAPISID=abc123; path=/';
  const cfg = { INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '2.20261014' } }, INNERTUBE_API_KEY: 'KEY123', SESSION_INDEX: 0, VISITOR_DATA: 'vd', INNERTUBE_CLIENT_VERSION: '2.20261014', INNERTUBE_CONTEXT_CLIENT_NAME: 1 };
  window.ytcfg = { get: (k) => cfg[k], data_: cfg };
  window.ytInitialData = ${JSON.stringify({ contents: [grid('PL1', 'Neurosciences', 2), grid('PL2', 'Cuisine', 2), cont('LISTCONT')] })};
</script>Playlists mock</body>`;

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
      let out = 'ok', ann;
      if (sys.includes('transformes une requête')) out = JSON.stringify({ topic: 'kubernetes', authors: ['devops'], sort: 'oldest', since: null, until: null, has: [] });
      else if (sys.includes('juges la pertinence')) out = JSON.stringify({ scores: [0, 9, 1] });
      else if (sys.includes('recherche documentaire') && body.plugins) {
        ann = [{ type: 'url_citation', url_citation: { url: 'https://ref.example/a', title: 'Page de référence', content: 'Extrait de la page de référence sur le sujet.' } }];
        out = JSON.stringify({ findings: [{ fact: 'Un fait de contexte tiré de la page de référence.', url: 'https://ref.example/a' }, { fact: 'Un fait avec une adresse inventée.', url: 'https://made.up/x' }] });
      } else if (sys.includes('vérificateur')) {
        const ids = [...usr.matchAll(/^(\d+\.\d+) : /gm)].map((m) => m[1]);
        out = JSON.stringify({ results: ids.map((id) => ({ id, supported: id !== '1.0' })) });
      } else if (sys.includes('résumes une partie')) {
        out = JSON.stringify({ points: [1, 2, 3, 4].map((n) => ({ t: n * 60, text: 'Point numéro ' + n + ' tiré de la partie de transcription.' })) });
      } else if (sys.includes('reportage sur une vidéo')) {
        out = JSON.stringify({ title: 'Un reportage sur la vidéo de la semaine et ses idées', dek: 'Chapeau du reportage [V1]', paragraphs: [1, 2, 3, 4, 5].map((n) => 'Paragraphe ' + n + ' du reportage : la vidéo développe ses idées dans l’ordre, vers ' + n + ':00. [V1]'), pull_quote: '', pull_source: 'V1', key_points: ['Premier point [V1]', 'Deuxième point', 'Troisième point'] });
      } else if (sys.includes('journaliste pour un journal hebdomadaire') && sys.includes('Pour chaque entrée')) {
        const ids = [...usr.matchAll(/ENTRÉE (B\d+) /g)].map((m) => m[1]);
        out = JSON.stringify({ briefs: ids.map((id) => ({ id, title: 'Brève ' + id, text: 'Une brève rédigée à partir du tweet source, avec sa citation [T1].' })) });
      } else if (sys.includes('journaliste pour un journal hebdomadaire')) {
        const para = (n) => 'Paragraphe ' + n + ' : ' + 'le sujet est décrit à partir des tweets du dossier, avec ses chiffres et son contexte, pour que le lecteur comprenne ce qui change cette semaine. '.repeat(3) + (n >= 3 && usr.includes('[W1]') ? '[W1]' : '[T1]');
        out = JSON.stringify({ title: 'Un grand titre informatif pour le sujet de la semaine', dek: 'Chapeau du sujet [T1]', paragraphs: [1, 2, 3, 4, 5, 6].map(para), pull_quote: '', pull_source: '', key_points: ['Premier point [T1]', 'Deuxième point', 'Troisième point'] });
      } else if (sys.includes('rédacteur en chef')) out = JSON.stringify({ title: 'Éditorial du test', paragraphs: ['Premier paragraphe de l’éditorial.', 'Deuxième paragraphe.'], ideas: ['Idée un', 'Idée deux', 'Idée trois'], week: [{ day: new Date().toISOString().slice(0, 10), text: 'Un fait du jour.' }], glossary: [{ term: 'VLM', def: 'Modèle qui comprend images et texte.' }] });
      else if (sys.includes('rédiges un résumé')) out = '**Infra**\nDu contenu sur le scheduler [1].';
      else if (usr.includes('Question :')) out = 'Réponse mock : le scheduler de tokio a été amélioré [1].';
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: out, annotations: ann } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
    });
    return;
  }
  if (url.pathname === '/card.png') { // image de carte (SVG servi comme image)
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'access-control-allow-origin': '*' });
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="418"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d9bf0"/><stop offset="1" stop-color="#7856ff"/></linearGradient></defs><rect width="800" height="418" fill="url(#g)"/><text x="400" y="225" font-size="54" fill="#fff" text-anchor="middle" font-family="sans-serif">card image</text></svg>');
  }
  if ((req.headers.host || '').includes('youtube.com')) {
    if (url.pathname === '/youtubei/v1/browse') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        ytLog.push({ auth: req.headers.authorization || '', key: url.searchParams.get('key'), ctx: !!body.context, client: req.headers['x-youtube-client-version'], body: { browseId: body.browseId, continuation: body.continuation } });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ytBrowse(body)));
      });
      return;
    }
    if (/^\/youtubei\/v1\/(next|get_transcript|player)$/.test(url.pathname)) {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        const ep = url.pathname.split('/').pop();
        ytLog.push({ auth: req.headers.authorization || '', key: url.searchParams.get('key'), ctx: !!body.context, client: req.headers['x-youtube-client-version'], body: { ep, videoId: body.videoId, params: body.params } });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (ep === 'next') return res.end(JSON.stringify(TRANSCRIPTS[body.videoId] && !PLAYER_ONLY.has(body.videoId) ? { engagementPanels: [{ engagementPanelSectionListRenderer: { content: { continuationItemRenderer: { continuationEndpoint: { getTranscriptEndpoint: { params: btoa('\n\x02' + body.videoId + '\x12\x03asr') } } } } } }] } : {}));
        if (ep === 'get_transcript') { const segs = TRANSCRIPTS[atob(body.params || '').slice(2, 4)] || []; return res.end(JSON.stringify({ actions: [{ updateEngagementPanelAction: { content: { transcriptRenderer: { body: { transcriptSegmentListRenderer: { initialSegments: segs.map(([ms, text]) => ({ transcriptSegmentRenderer: { startMs: String(ms), snippet: { runs: [{ text }] } } })) } } } } } }] })); }
        if (ep === 'player' && PLAYER_ONLY.has(body.videoId)) return res.end(JSON.stringify({ playabilityStatus: { status: 'OK' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: `https://www.youtube.com/api/timedtext?v=${body.videoId}&lang=en`, languageCode: 'en', kind: 'asr' }] } } }));
        return res.end('{}');
      });
      return;
    }
    if (url.pathname === '/api/timedtext') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ events: (TRANSCRIPTS[url.searchParams.get('v')] || []).map(([ms, t]) => ({ tStartMs: ms, segs: [{ utf8: t }] })) })); }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(ytPage());
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
        if (key === 'match') { const n = Number(/numéro (\d+)/.exec(String(body.state?.contenu))?.[1]); choice = Math.floor(n / 6) % 2 === 0 ? 'oui' : 'non'; }
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
    '--host-resolver-rules=MAP x.com 127.0.0.1, MAP www.youtube.com 127.0.0.1, MAP llm.test 127.0.0.1, MAP huggingface.co 127.0.0.1:1', '--ignore-certificate-errors', '--no-proxy-server'],
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
assert.equal(await panel.locator('#opt-autoindex').isChecked(), true, 'réglages d’une ancienne version : indexation automatique par tranches (migration v4)');
await waitFor(async () => /Tas JS : panneau \d+ Mo/.test(await panel.locator('#mem-info').innerText()), 'mesure mémoire', 8000);
await panel.click('#mem-free');
await waitFor(async () => /en veille|actif/.test(await panel.locator('#mem-info').innerText()), 'libération mémoire', 8000);
await panel.selectOption('#compute', 'auto');
await waitFor(async () => (await panel.evaluate(() => chrome.storage.local.get('settings'))).settings.compute === 'auto', 'compute enregistré', 5000);
await panel.selectOption('#compute', 'cpu');
await panel.uncheck('#opt-autoindex');
await waitFor(async () => (await panel.evaluate(() => chrome.storage.local.get('settings'))).settings.indexMode === 'manual', 'réglage indexMode manuel', 5000);
await panel.check('#opt-autoindex');
await waitFor(async () => (await panel.evaluate(() => chrome.storage.local.get('settings'))).settings.indexMode === 'soft', 'réglage indexMode par tranches', 5000);
await panel.uncheck('#opt-autoindex'); // la suite des tests tourne en manuel (aucun calcul de modèle)
await waitFor(async () => (await panel.evaluate(() => chrome.storage.local.get('settings'))).settings.indexMode === 'manual', 'retour manuel', 5000);
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

// ------------------------------------------------------------------ 11b. YouTube : playlists (WL, J'aime, perso), fusion, recherche, retrait
await panel.setViewportSize({ width: 1100, height: 900 });
assert.equal(await panel.evaluate(() => self.crossOriginIsolated), true, 'page isolée (SharedArrayBuffer) : calcul CPU multi-threads possible');
await panel.evaluate(() => localStorage.setItem('xbs.reloadGap', '1500')); // rechargements groupés : délai réduit pour les tests
await panel.reload(); await panel.waitForSelector('.tw');
const before = Number((await panel.locator('#stats').innerText()).match(/^([\d\s\u202f\u00a0]+) bookmarks/)[1].replace(/\D/g, ''));
await panel.click('#yt-sync');
await panel.waitForFunction(() => /YouTube : terminé/.test(document.getElementById('progress').textContent), null, { timeout: 90000 });
assert.match(await panel.locator('#progress').innerText(), /7 vidéos dans 5 playlists|\d+ vidéos dans 5 playlists/);
await panel.waitForFunction(() => /7 vidéos YouTube/.test(document.getElementById('stats').textContent), null, { timeout: 15000 });
assert.ok(ytLog.length >= 6, 'requêtes browse : ' + ytLog.length);
assert.ok(ytLog.every((l) => /^SAPISIDHASH \d+_[0-9a-f]{40}$/.test(l.auth)), 'en-tête Authorization signé (SAPISIDHASH) : ' + ytLog[0].auth);
assert.ok(ytLog.every((l) => l.key === 'KEY123' && l.ctx && l.client === '2.20261014'), 'clé, contexte et version client transmis');
assert.deepEqual(ytLog.map((l) => l.body.browseId || 'cont:' + l.body.continuation).filter((x) => x.startsWith('VL')).sort(), ['VLLL', 'VLPL1', 'VLPL2', 'VLPL3', 'VLWL']);
assert.equal(await panel.locator('#stats').innerText().then((t) => Number(t.match(/^([\d\s\u202f\u00a0]+) bookmarks/)[1].replace(/\D/g, ''))), before, 'les vidéos ne comptent pas comme des bookmarks X');
// l'onglet YouTube ouvert en arrière-plan est refermé tout seul
await waitFor(() => !ctx.pages().some((p) => p.url().includes('youtube.com')), 'onglet YouTube refermé', 15000);
// recherche : carte vidéo (miniature, durée, chaîne, playlists)
await panel.fill('#q', 'cerveau');
await waitFor(async () => /Le cerveau expliqué/.test(await panel.locator('.tw.yt').first().innerText().catch(() => '')), 'recherche « cerveau » : la vidéo arrive', 8000);
const vc = panel.locator('.tw.yt').first();
assert.match(await vc.locator('.yt-t').innerText(), /Le cerveau expliqué/);
assert.equal(await vc.locator('.dur').innerText(), '12:34');
assert.match(await vc.locator('.yt-m').innerText(), /Chaîne Neuro · 1,2 M de vues · il y a 2 ans/);
assert.deepEqual((await vc.locator('.chip-pl').allInnerTexts()).sort(), ['Neurosciences', 'À regarder plus tard'], 'une vidéo dans 2 playlists : appartenances fusionnées');
assert.equal(await vc.locator('a:has-text("Ouvrir sur YouTube")').getAttribute('href'), 'https://www.youtube.com/watch?v=w1');
await vc.screenshot({ path: 'test/yt-card.png' });
// filtres : source, playlist (chip et opérateur entre guillemets)
await panel.selectOption('#source', 'youtube');
await panel.fill('#q', '');
await waitFor(async () => (await panel.locator('.tw.yt').count()) === 7 && (await panel.locator('.tw:not(.yt)').count()) === 0, '7 vidéos, aucun tweet', 8000);
await panel.fill('#q', 'playlist:"à regarder plus tard"');
await waitFor(async () => (await panel.locator('.tw').count()) === 3, 'playlist WL : 3 vidéos', 8000);
await panel.fill('#q', 'source:youtube rust');
await waitFor(async () => /Rust async/.test(await panel.locator('.tw').first().innerText().catch(() => '')), 'opérateur source:youtube', 8000);
await panel.locator('.tw.yt').first().locator('.chip-pl').first().click(); // le chip lance la recherche de la playlist
assert.match(await panel.locator('#q').inputValue(), /^playlist:"/);
await panel.selectOption('#source', 'x');
await waitFor(async () => (await panel.locator('.tw.yt').count()) === 0, 'source X : aucune vidéo', 8000);
await panel.selectOption('#source', 'all');
await panel.fill('#q', '');
// 2e synchro : « Recette de ramen » a été retirée de TOUTES les playlists côté YouTube -> proposée à la suppression
ytDrop = 'w2';
ytLog.length = 0;
await panel.click('#yt-sync');
await panel.waitForFunction(() => /YouTube : terminé/.test(document.getElementById('progress').textContent), null, { timeout: 90000 });
await panel.waitForSelector('#banners .bn:has-text("n’existent plus")', { timeout: 15000 });
await panel.click('#banners .bn button:has-text("Les retirer")');
await panel.waitForFunction(() => /6 vidéos YouTube/.test(document.getElementById('stats').textContent), null, { timeout: 15000 });
await panel.fill('#q', 'ramen');
await panel.waitForTimeout(500);
assert.equal(await panel.locator('.tw.yt').count(), 0, 'vidéo retirée : plus dans la recherche');
await panel.fill('#q', 'pain au levain');
await waitFor(async () => (await panel.locator('.tw.yt').count()) === 1, 'une vidéo encore dans une autre playlist reste', 6000);
await waitFor(async () => (await panel.locator('.tw.yt .chip-pl').allTextContents()).join() === 'Cuisine', 'chip Cuisine', 6000);
assert.deepEqual(await panel.locator('.tw.yt .chip-pl').allTextContents(), ['Cuisine'], 'seule l’appartenance retirée disparaît');
await panel.fill('#q', '');

// ------------------------------------------------------------------ 11c. YouTube : historique de visionnage (4 pages), badges, filtres, synchro incrémentale
ytLog.length = 0;
await panel.click('#yt-hist');
await panel.waitForFunction(() => /historique terminé/.test(document.getElementById('progress').textContent), null, { timeout: 90000 });
assert.match(await panel.locator('#progress').innerText(), /9 visionnages lus, 4 nouveaux|\d+ visionnages lus, \d+ nouveaux/);
await panel.waitForFunction(() => /10 vidéos YouTube/.test(document.getElementById('stats').textContent), null, { timeout: 15000 });
const hlog = () => ytLog.map((l) => l.body.browseId === 'FEhistory' ? 'FEhistory' : l.body.continuation).filter((x) => x === 'FEhistory' || /^HC/.test(x));
assert.deepEqual(hlog(), ['FEhistory', 'HC1', 'HC2', 'HC3'], 'toutes les pages de l’historique sont lues');
await waitFor(() => !ctx.pages().some((p) => p.url().includes('youtube.com')), 'onglet YouTube refermé (historique)', 15000);
// badge « Vu » et barre de progression sur une vidéo déjà dans une playlist
await panel.fill('#q', 'cerveau');
await waitFor(async () => /Le cerveau expliqué/.test(await panel.locator('.tw.yt').first().innerText().catch(() => '')), 'cerveau (historique)', 8000);
const wv = panel.locator('.tw.yt').first();
await waitFor(async () => (await wv.locator('.yt-w').count()) > 0, 'badge « Vu » (rechargement de l’index)', 10000);
assert.match(await wv.locator('.yt-w').innerText(), new RegExp('Vu le ' + dayIso(0) + ' · 60 %'));
assert.equal(await wv.locator('.prog i').evaluate((e) => e.style.width), '60%');
assert.deepEqual((await wv.locator('.chip-pl').allInnerTexts()).sort(), ['Neurosciences', 'À regarder plus tard'], 'l’historique n’efface pas les playlists');
// filtres
const count = async (q, n, msg) => { await panel.fill('#q', q); await waitFor(async () => (await panel.locator('.tw').count()) === n, msg + ' : ' + n, 8000); };
await count('viewed:yes', 6, 'viewed:yes');
await count('viewed:no playlist:"à regarder plus tard"', 1, 'à regarder et pas encore vu');
assert.match(await panel.locator('.tw').first().innerText(), /Rust async/);
await count('watched:today', 2, 'watched:today');
await count('watched:' + dayIso(2), 1, 'watched:<jour>');
await count('mémoire viewed:yes', 1, 'recherche dans l’historique');
// synchro incrémentale : une nouveauté en tête ; on s’arrête dès qu’on retombe sur du connu (la dernière page n’est pas demandée)
histNew = true; ytLog.length = 0;
await panel.fill('#q', '');
await panel.click('#yt-hist');
await panel.waitForFunction(() => /historique terminé/.test(document.getElementById('progress').textContent) && /11 vidéos YouTube/.test(document.getElementById('stats').textContent), null, { timeout: 90000 });
assert.deepEqual(hlog(), ['FEhistory', 'HC1', 'HC2'], 'synchro incrémentale : arrêt avant la dernière page : ' + hlog());
await count('zorglub', 1, 'nouvelle vidéo de l’historique');
await panel.fill('#q', '');

// ------------------------------------------------------------------ 11d. YouTube : transcriptions
ytLog.length = 0;
await panel.fill('#q', '');
// une vidéo à la fois : le jeton appris sur la première sert ensuite aux suivantes (ordre déterministe)
await panel.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, ytTrSpeed: 'prudent' } }); });
await panel.click('#yt-tr');
await panel.waitForFunction(() => /transcriptions terminées/.test(document.getElementById('progress').textContent), null, { timeout: 120000 });
assert.match(await panel.locator('#progress').innerText(), /3 récupérées, 3 sans transcription/);
const nextIds = ytLog.filter((l) => l.body.ep === 'next').map((l) => l.body.videoId);
for (const id of ['c1', 'l1', 'm1']) assert.ok(nextIds.includes(id), 'next pour ' + id + ' (sans transcription via le modèle : jamais conclu sans « next ») : ' + nextIds);
// ordre : les plus récentes d'abord (w1 est en haut de « À regarder plus tard » et de PL1)
assert.equal(ytLog.find((l) => l.body.ep === 'next')?.body.videoId, 'w1', 'la vidéo la plus récente est traitée en premier');
const gtIds = ytLog.filter((l) => l.body.ep === 'get_transcript').map((l) => Buffer.from(l.body.params, 'base64').toString().slice(2, 4));
assert.ok(gtIds.includes('w1') && gtIds.includes('w3'), 'transcriptions récupérées : ' + gtIds);
assert.ok(!(nextIds.includes('w1') && nextIds.includes('w3')), 'le jeton appris sur une vidéo sert pour l’autre : une seule requête « next » parmi w1/w3 : ' + nextIds);
assert.ok(ytLog.filter((l) => l.client !== '20.10.38').every((l) => /^SAPISIDHASH/.test(l.auth)), 'requêtes web signées ; le client Android n’envoie ni cookies ni signature');
await waitFor(() => !ctx.pages().some((p) => p.url().includes('youtube.com')), 'onglet YouTube refermé (transcriptions)', 15000);
// recherche par un mot qui n'est QUE dans la transcription : extrait daté + lien à la seconde près
await panel.fill('#q', 'zorglubtranscript');
await waitFor(async () => /Le cerveau expliqué/.test(await panel.locator('.tw.yt').first().innerText().catch(() => '')), 'mot de la transcription trouvé', 15000);
const sn = panel.locator('.tw.yt').first().locator('.yt-sn');
await waitFor(async () => (await sn.count()) > 0, 'extrait de transcription', 10000);
assert.match(await sn.innerText(), /▶ 2:05 … .*zorglubtranscript/);
assert.equal(await sn.locator('a').getAttribute('href'), 'https://www.youtube.com/watch?v=w1&t=125s');
assert.equal(await panel.locator('.tw.yt').first().locator('.yt-tr').count(), 1, 'badge transcription');
await count('has:transcript', 3, 'has:transcript');
// deuxième passage : plus rien à récupérer (les vidéos sans transcription ne sont pas redemandées avant 30 jours)
await panel.fill('#q', '');
await panel.click('#yt-tr');
await panel.waitForFunction(() => /ont déjà leur transcription/.test(document.getElementById('progress').textContent), null, { timeout: 15000 });

// ------------------------------------------------------------------ 11e. « Tout mettre à jour » : X + playlists (historique et transcriptions exclus par défaut) + indexation
ytLog.length = 0;
histNew = false;
await panel.fill('#q', '');
await panel.click('#update-all');
await panel.waitForFunction(() => /Mise à jour terminée/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
const upd = await panel.locator('#progress').innerText();
assert.match(upd, /X : \d+ lus/, 'étape X : ' + upd);
assert.match(upd, /playlists : \d+/, 'étape playlists : ' + upd);
assert.ok(!/historique|transcriptions :/.test(upd), 'historique et transcriptions exclus par défaut : ' + upd);
assert.ok(!ytLog.some((l) => l.body.browseId === 'FEhistory'), 'aucune requête d’historique');
const plLog = ytLog.filter((l) => l.body.browseId?.startsWith('VL')).map((l) => l.body.browseId).sort();
assert.ok(plLog.includes('VLWL') && plLog.includes('VLLL'), 'WL et J’aime relus : ' + plLog);
assert.ok(!plLog.includes('VLPL3'), 'une playlist dont le nombre de vidéos n’a pas changé est ignorée : ' + plLog);
await waitFor(() => !ctx.pages().some((p) => p.url().includes('youtube.com')), 'onglet YouTube refermé (mise à jour)', 15000);
assert.equal(await panel.locator('#update-all').isVisible(), true, 'bouton de retour');

// ------------------------------------------------------------------ 11f. choisir les playlists YouTube prises en compte
await panel.fill('#q', 'lo-fi');
await waitFor(async () => (await panel.locator('.tw.yt').count()) === 1, 'vidéo de la playlist « Musique » trouvée', 8000);
await panel.click('#gear');
await panel.waitForSelector('#ytpl-list input[data-id="PL3"]');
assert.equal(await panel.locator('#ytpl-list input[type=checkbox]').count() >= 5, true, 'WL, J’aime et les playlists perso listées');
await panel.uncheck('#ytpl-list input[data-id="PL3"]');
await waitFor(async () => (await panel.evaluate(() => chrome.storage.local.get('settings'))).settings.ytExcluded?.includes('PL3'), 'playlist décochée enregistrée', 5000);
await panel.keyboard.press('Escape');
await waitFor(async () => (await panel.locator('.tw.yt').count()) === 0, 'vidéo d’une playlist décochée : plus dans la recherche', 8000);
await waitFor(async () => /10 vidéos YouTube/.test(await panel.locator('#stats').innerText()), 'compteur sans la playlist décochée', 8000);
// synchro : la playlist décochée n'est pas lue
ytLog.length = 0;
await panel.fill('#q', '');
await panel.click('#yt-sync');
await panel.waitForFunction(() => /YouTube : terminé/.test(document.getElementById('progress').textContent), null, { timeout: 90000 });
const vl = ytLog.map((l) => l.body.browseId).filter((x) => x?.startsWith('VL'));
assert.ok(vl.includes('VLWL') && !vl.includes('VLPL3'), 'VLPL3 non demandée : ' + vl);
await waitFor(() => !ctx.pages().some((p) => p.url().includes('youtube.com')), 'onglet YouTube refermé', 15000);
// recocher : la vidéo revient sans rien resynchroniser
await panel.click('#gear');
await panel.check('#ytpl-list input[data-id="PL3"]');
await panel.keyboard.press('Escape');
await panel.fill('#q', 'lo-fi');
await waitFor(async () => (await panel.locator('.tw.yt').count()) === 1, 'playlist recochée : la vidéo revient', 8000);
await waitFor(async () => /11 vidéos YouTube/.test(await panel.locator('#stats').innerText()), 'compteur rétabli', 8000);
await panel.fill('#q', '');

// statistiques YouTube
const ys = await ctx.newPage();
await ys.setViewportSize({ width: 1360, height: 900 });
await ys.goto(`chrome-extension://${extId}/stats.html`);
await ys.waitForSelector('.kpis .tile.hero');
await ys.click('#source button:has-text("YouTube")');
await ys.waitForFunction(() => /Vidéos en base/.test(document.querySelector('.tile.hero .l')?.textContent || ''));
assert.equal(Number((await ys.locator('.tile.hero .v').innerText()).replace(/\D/g, '')), 11, '11 vidéos en base');
const kt = await ys.locator('.kpis').innerText();
assert.match(kt, /Visionnages \(90 j\)\s*\n?\s*7/, 'visionnages : ' + kt.replace(/\s+/g, ' '));
assert.match(kt, /Temps regardé/);
for (const t of ['Visionnages par jour', 'Calendrier de l’année', 'Chaînes les plus regardées', 'Playlists']) assert.ok(await ys.locator(`h3:has-text("${t}")`).count(), 'carte : ' + t);
assert.match(await ys.locator('.card:has(h3:has-text("Chaînes les plus regardées"))').innerText(), /Hist Chan/);
await ys.screenshot({ path: 'test/stats-yt.png', fullPage: true });
await ys.evaluate(() => localStorage.removeItem('xbs.stats.src'));
await ys.close();

// ------------------------------------------------------------------ 11g. supprimer toutes les données d'une playlist
panel.on('dialog', (d) => d.accept());
await panel.click('#gear');
await panel.waitForSelector('#ytpl-list [data-del="PL3"]');
await panel.click('#ytpl-list [data-del="PL3"]');
await panel.waitForFunction(() => /1 vidéo\(s\) supprimée\(s\), 0 conservée\(s\)/.test(document.getElementById('progress').textContent), null, { timeout: 20000 });
const idbGet = (id) => panel.evaluate(async (k) => { const db = await new Promise((res) => { const r = indexedDB.open('xbs'); r.onsuccess = () => res(r.result); }); return await new Promise((res) => { const g = db.transaction('tweets').objectStore('tweets').get(k); g.onsuccess = () => res(g.result); }); }, id);
assert.equal(await idbGet('yt:m1'), undefined, 'la vidéo propre à la playlist « Musique » est supprimée de la base');
assert.ok((await panel.evaluate(() => chrome.storage.local.get('settings'))).settings.ytExcluded.includes('PL3'), 'playlist décochée après suppression (plus synchronisée)');
// « Neurosciences » : p2 n'est que là (supprimée), w1 est aussi dans « À regarder plus tard » et a été vue (conservée, détachée)
await panel.click('#ytpl-list [data-del="PL1"]');
await panel.waitForFunction(() => /1 vidéo\(s\) supprimée\(s\), 1 conservée\(s\)/.test(document.getElementById('progress').textContent), null, { timeout: 20000 });
assert.equal(await idbGet('yt:p2'), undefined);
assert.deepEqual((await idbGet('yt:w1')).playlists.map((p) => p.id), ['WL'], 'w1 garde « À regarder plus tard » et perd « Neurosciences »');
await panel.keyboard.press('Escape');
await panel.fill('#q', 'lo-fi');
await panel.waitForTimeout(600);
assert.equal(await panel.locator('.tw.yt').count(), 0, 'plus de résultat pour la vidéo supprimée');
await waitFor(async () => /9 vidéos YouTube/.test(await panel.locator('#stats').innerText()), 'compteur après suppressions', 8000);
panel.removeAllListeners('dialog');
await panel.fill('#q', '');

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

// ------------------------------------------------------------------ 13. Mes stats : stat personnalisée (requête) qui suit le filtre de période, persiste, se supprime
await stats.click('#source button:has-text("Mes stats")');
await stats.waitForSelector('#w-add');
assert.ok(await stats.locator('.tpl [data-tpl]').count() >= 4, 'modèles proposés quand il n’y a aucune stat');
await stats.click('#w-add');
await stats.fill('#dlg input[name="title"]', 'Agents');
await stats.fill('#dlg input[name="q"]', 'agents mémoire');
await stats.waitForFunction(() => /\b2[67]\d\b|270/.test(document.getElementById('pv')?.textContent || ''), null, { timeout: 8000 });
assert.match(await stats.locator('#pv').innerText(), /270 élément\(s\) sur la période \(90 j\)/, 'aperçu en direct');
// « a | b » : l'un OU l'autre
await stats.fill('#dlg input[name="q"]', 'introuvable | agents');
await stats.waitForFunction(() => /270 élément\(s\) sur la période \(90 j\)/.test(document.getElementById('pv')?.textContent || ''), null, { timeout: 8000 });
await stats.fill('#dlg input[name="q"]', 'agents mémoire');
await stats.waitForFunction(() => /270 élément\(s\)/.test(document.getElementById('pv')?.textContent || ''), null, { timeout: 8000 });
await stats.click('#dlg #ed-ok');
await stats.waitForSelector('.card.mine .bignum');
const bignum = async () => Number((await stats.locator('.card.mine .bignum').first().innerText()).replace(/\D/g, ''));
assert.equal(await bignum(), 270, 'sur 90 jours');
await stats.click('#ranges button:has-text("7 j")');
await waitFor(async () => { const n = await bignum(); return n >= 18 && n <= 24; }, 'la stat suit le filtre « 7 j »', 6000);
// le clic sur le nombre ouvre la recherche sur la MÊME période : autant de résultats que le chiffre affiché
const n7 = await bignum();
const [opened] = await Promise.all([ctx.waitForEvent('page'), stats.locator('.card.mine .bignum').first().click()]);
await opened.waitForSelector('.tw', { timeout: 15000 });
assert.match(decodeURIComponent(opened.url()), /during:\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}/, 'période transmise à la recherche : ' + opened.url());
await waitFor(async () => new RegExp('— ' + n7 + ' résultat').test(await opened.locator('#mode').innerText()), `la recherche affiche ${n7} résultats (comme la stat)`, 15000);
await opened.close();
await stats.click('#ranges button:has-text("1 j")');
await waitFor(async () => (await bignum()) <= 4, 'la stat suit le filtre « 1 j »', 6000);
await stats.click('#ranges button:has-text("Tout")');
await waitFor(async () => (await bignum()) === 300, 'la stat suit « Tout »', 6000);
// courbe et classement
await stats.click('.wact [data-act="dup"]');
await stats.waitForFunction(() => document.querySelectorAll('.card.mine').length === 2);
await stats.locator('.wact [data-act="edit"]').nth(1).click();
await stats.selectOption('#dlg select[name="kind"]', 'top');
await stats.click('#dlg #ed-ok');
await stats.waitForSelector('.card.mine svg.chart');
await stats.waitForFunction(() => !document.getElementById('app').classList.contains('loading'), null, { timeout: 5000 }); // l'écran n'est pas resté grisé
await stats.locator('.card.mine .tbl-btn').first().click();
await stats.waitForSelector('.card.mine .tbl:not([hidden]) table');
assert.match(await stats.locator('.card.mine').nth(1).innerText(), /Auteur/, 'classement des auteurs');
// persistance
await stats.reload();
await stats.waitForSelector('.card.mine');
assert.equal(await stats.locator('.card.mine').count(), 2, 'stats conservées après rechargement');
stats.on('dialog', (d) => d.accept());
await stats.locator('.wact [data-act="del"]').nth(1).click();
await stats.locator('.wact [data-act="del"]').first().click();
await stats.waitForSelector('.tpl [data-tpl]');

// ---- détecteur confirmé par Jev (vecteurs et exemples simulés : pas de modèle ici) ----
await stats.evaluate(async () => {
  const mid = 'onnx-community/embeddinggemma-300m-ONNX';
  const e = (a, b) => { const v = new Float32Array(256); v[0] = a; v[1] = b; return v; };
  const db = await new Promise((res, rej) => { const r = indexedDB.open('xbs'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = db.transaction(['vectors', 'meta'], 'readwrite');
  for (let i = 0; i < 300; i++) tx.objectStore('vectors').put({ id: 's' + i, model: mid, vec: i % 6 === 0 ? e(1, 0) : i % 6 === 1 ? e(0.52, Math.sqrt(1 - 0.52 ** 2)) : e(0, 1) });
  const det = { id: 'det1', name: 'Annonces', desc: 'Annonce', examples: ['Lancement'], threshold: 0.5, pos: [], neg: [], protoKey: 'Annonce\u241eLancement', protos: { [mid]: [Array.from(e(1, 0))] }, confirm: { on: true, band: 0.1 } };
  tx.objectStore('meta').put({ key: 'dashDetectors', value: [det] });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
});
await stats.reload();
await stats.waitForSelector('#d-manage');
stats.removeAllListeners('dialog');
stats.on('dialog', (d) => d.accept());
jevLog.length = 0;
await stats.click('#d-manage');
await stats.click('#dlg [data-e="0"]');
await stats.waitForFunction(() => /50 cas ambigu\(s\) à juger.*· 0 déjà jugé/.test(document.getElementById('jvstat')?.textContent || ''), null, { timeout: 15000 });
assert.match(await stats.locator('#dsug').innerText().catch(() => ''), /Suggestion : seuil \d\.\d\d/, 'suggestion de seuil proposée');
assert.match(await stats.locator('#jvstat').innerText(), /≈ (< 0,01|\d+,\d\d) \$ pour tous/, 'coût estimé affiché avant de juger');
await stats.fill('#dlg input[name="mx"]', '50');
await stats.click('#jv-go');
await stats.waitForFunction(() => /Terminé : 50 élément/.test(document.getElementById('jvmsg')?.textContent || ''), null, { timeout: 30000 });
assert.match(await stats.locator('#jvstat').innerText(), /0 cas ambigu\(s\) à juger.*· 50 déjà jugé/);
assert.equal(jevLog.length, 50, 'un appel Jev par cas ambigu (et pas un de plus) : ' + jevLog.length);
assert.ok(jevLog.every((j) => j.auth === 'Bearer jev-key' && j.keys.join() === 'match'), 'question « match » uniquement');
assert.match(await stats.locator('#dstat').innerText(), /75 élément\(s\) retenus au total/, '50 sûrs + 25 confirmés par Jev');
assert.ok(await stats.locator('#ex-above .jvt').count() > 0, 'verdicts affichés dans la liste');
await stats.click('#dlg #d-ok');
// une stat reliée à ce détecteur : 75 éléments
await stats.waitForSelector('#w-add');
await stats.click('#w-add');
await stats.fill('#dlg input[name="title"]', 'Annonces');
await stats.check('#dlg input[name="dets"][value="det1"]');
await stats.waitForFunction(() => /75 élément\(s\)/.test(document.getElementById('pv')?.textContent || ''), null, { timeout: 8000 });
await stats.click('#dlg #ed-ok');
await waitFor(async () => Number((await stats.locator('.card.mine .bignum').first().innerText()).replace(/\D/g, '')) === 75, 'stat « Annonces » = 75', 8000);
// rechargement : verdicts conservés, rien à redemander
await stats.reload();
await stats.waitForSelector('.card.mine .bignum');
await stats.click('#d-manage');
await stats.click('#dlg [data-e="0"]');
await stats.waitForFunction(() => /0 cas ambigu\(s\) à juger.*· 50 déjà jugé/.test(document.getElementById('jvstat')?.textContent || ''), null, { timeout: 15000 });
// apprentissage : un ✓ sur un élément refusé par Jev fait suivre ses jumeaux (vecteur identique)
assert.match(await stats.locator('#dstat').innerText(), /75 élément\(s\) retenus au total/);
await stats.locator('#ex-below [data-v="ok"]').first().click();
await stats.waitForFunction(() => /100 élément\(s\) retenus au total/.test(document.getElementById('dstat')?.textContent || ''), null, { timeout: 15000 });
assert.match(await stats.locator('#lrn').innerText(), /1 ✓ et 0 ✗ de ta part · 49 élément\(s\) suivent tes ✓ et 0 suivent tes ✗/, 'les 49 jumeaux (hors lui-même) suivent le ✓ : ' + await stats.locator('#lrn').innerText());
assert.ok(await stats.locator('#ex-above .jvt:has-text("comme ton ✓")').count() > 0, 'étiquette « comme ton ✓ » dans la liste');
// désactivé : le ✓ ne vaut plus que pour l'élément lui-même
await stats.uncheck('#dlg input[name="ln"]');
await stats.waitForFunction(() => /76 élément\(s\) retenus au total/.test(document.getElementById('dstat')?.textContent || ''), null, { timeout: 10000 });
await stats.click('#dlg button[value="cancel"]');

// ---- sujets distincts : 3 familles de vecteurs dans les données simulées, mais les familles « mid » et « e1 » partagent des pages citées (blog1.example.com/pN) : elles fusionnent -> 2 sujets
await stats.click('#w-add');
await stats.fill('#dlg input[name="title"]', 'Sujets');
await stats.fill('#dlg input[name="q"]', 'agents');
await stats.check('#dlg input[name="dd"]');
await stats.locator('#dlg input[name="dsim"]').evaluate((e) => { e.value = '0.98'; e.dispatchEvent(new Event('input', { bubbles: true })); });
await stats.locator('#dlg input[name="dday"]').evaluate((e) => { e.value = '30'; e.dispatchEvent(new Event('input', { bubbles: true })); });
try { await stats.waitForFunction(() => /2 sujet\(s\) distinct\(s\)/.test(document.getElementById('pv')?.textContent || '') && /300 tweets regroupés/.test(document.getElementById('pv')?.textContent || ''), null, { timeout: 15000 }); } catch (e) { console.log('PV:', await stats.locator('#pv').innerText(), await stats.evaluate(() => localStorage.getItem('xbs.stats.range'))); throw e; }
assert.ok(await stats.locator('#pv .jvt:has-text("similaire")').count() > 0, 'les groupes montrent « + N similaires »');
await stats.click('#dlg #ed-ok');
await waitFor(async () => /2 sujets distincts · 300 tweets/.test(await stats.locator('.card.mine:has-text("Sujets")').innerText()), 'carte « 2 sujets distincts · 300 tweets »', 10000);
assert.equal(Number((await stats.locator('.card.mine:has-text("Sujets") .bignum').innerText()).replace(/\D/g, '')), 2);
// l'option « ignorer les citations » existe et se retrouve dans la requête ouverte
await stats.locator('.card.mine:has-text("Sujets") [data-act="edit"]').click();
await stats.check('#dlg input[name="noq"]');
await stats.click('#dlg #ed-ok');
await waitFor(async () => /quoted:no/.test(await stats.locator('.card.mine:has-text("Sujets") .sub').first().innerText()), 'requête avec quoted:no', 8000);
await stats.evaluate(() => localStorage.removeItem('xbs.stats.src'));
// sources primaires : dialogue, suggestion, enregistrement ; l'option de stat existe
await stats.click('#p-manage');
await stats.fill('#dlg textarea[name="h"]', '@openai\n@anthropicai');
await stats.click('#dlg button[value="ok"]');
await waitFor(async () => /Sources primaires \(2\)/.test(await stats.locator('#p-manage').innerText()), 'bouton « Sources primaires (2) »', 8000);
await stats.locator('.card.mine:has-text("Sujets") [data-act="edit"]').click();
assert.ok(await stats.locator('#dlg input[name="po"]').count() === 1 && await stats.locator('#dlg textarea[name="jd"]').count() === 1 && await stats.locator('#off-go').count() === 1, 'options sources primaires / annonces officielles');
await stats.click('#dlg button[value="cancel"]');
// ---- nouvelles formes : modèles (comparaison, empilé, anneau, chaleur, tendances, ratio), export CSV, tableaux de bord
const TPLS = ['X vs YouTube', 'Activité par source', 'Langues', 'Quand les tweets sont publiés', 'Sujets qui montent (mots)', 'Part des tweets avec un lien'];
for (const label of TPLS) {
  await stats.selectOption('#tpl-sel', { label });
  await waitFor(async () => (await stats.locator(`.card.mine:has-text("${label}")`).count()) > 0, `carte « ${label} »`, 10000);
}
assert.ok(await stats.locator('.card.mine:has-text("X vs YouTube") svg.chart').count() === 1 && await stats.locator('.card.mine:has-text("X vs YouTube") .legend li').count() >= 2, 'comparaison : une courbe par série + légende');
assert.ok(await stats.locator('.card.mine:has-text("Activité par source") svg.chart').count() === 1, 'barres empilées par source');
assert.ok(await stats.locator('.card.mine:has-text("Langues") .donut path.dn').count() > 0, 'anneau des langues');
assert.ok(await stats.locator('.card.mine:has-text("Quand les tweets") rect.cell').count() === 168, 'carte de chaleur 7 × 24');
assert.ok(await stats.locator('.card.mine:has-text("Part des tweets avec un lien") .bignum').innerText().then((t) => /%/.test(t)), 'ratio en %');
const [dl] = await Promise.all([stats.waitForEvent('download'), stats.locator('.card.mine:has-text("X vs YouTube") [data-act="csv"]').click()]);
assert.match(dl.suggestedFilename(), /\.csv$/);
await stats.evaluate(() => { window.prompt = () => 'Veille IA'; });
await stats.click('#b-add');
await waitFor(async () => /Veille IA/.test(await stats.locator('.boards .bt.on').innerText()), 'nouveau tableau de bord actif', 8000);
assert.equal(await stats.locator('.card.mine').count(), 0, 'le nouveau tableau est vide');
await stats.selectOption('#tpl-sel', { label: 'Langues' });
await waitFor(async () => (await stats.locator('.card.mine').count()) === 1, 'stat ajoutée au nouveau tableau', 8000);
await stats.click('.boards .bt[data-b="main"]');
await waitFor(async () => (await stats.locator('.card.mine:has-text("X vs YouTube")').count()) === 1, 'retour au tableau Général', 8000);
// condition libre posée à Jev : le décompte « à juger » apparaît dès qu'on la saisit (nouvelle condition = rien n'est encore jugé)
await stats.locator('.card.mine:has-text("Sujets") [data-act="edit"]').first().click();
await stats.fill('#dlg textarea[name="jd"]', 'Le tweet annonce une nouveauté sur les agents');
await waitFor(async () => /(\d[\d\s\u202f]*) tweet\(s\) candidat\(s\), (\d[\d\s\u202f]*) à juger, 0 déjà jugé/.test(await stats.locator('#offmsg').innerText()), 'décompte des tweets à juger pour la condition', 10000);
assert.ok(!/^Pour cette condition : 0 tweet/.test(await stats.locator('#offmsg').innerText()), 'des candidats existent');
// « Faire juger par Jev » sur une condition libre : tous les candidats sont jugés ET conservés (pas seulement le premier paquet de 20)
await stats.click('#off-go');
await waitFor(async () => /Terminé : (\d+) tweet/.test(await stats.locator('#offmsg').innerText()), 'jugement Jev de la condition', 60000);
const judgedN = Number((await stats.locator('#offmsg').innerText()).match(/Terminé : (\d+) tweet/)[1]);
assert.ok(judgedN > 40, 'plus d’un paquet de 20 jugé : ' + judgedN);
await waitFor(async () => /, 0 à juger,/.test(await stats.locator('#offmsg').innerText()), 'plus rien à juger après la passe', 10000);
await stats.click('#dlg button[value="cancel"]');
// comparaison de stats existantes : on coche deux stats, le graphique se génère
await stats.click('#w-cmp');
await stats.locator('#dlg input[name="refs"]').nth(0).check();
await stats.locator('#dlg input[name="refs"]').nth(1).check();
await stats.fill('#dlg input[name="title"]', 'Ma comparaison');
await stats.click('#dlg #cmp-ok');
await waitFor(async () => (await stats.locator('.card.mine:has-text("Ma comparaison") svg.chart').count()) === 1 && (await stats.locator('.card.mine:has-text("Ma comparaison") .legend li').count()) >= 2, 'graphique de comparaison de deux stats', 10000);
// mise à jour automatique : un message « nouvelles données » recharge l'affichage sans toucher à rien
await stats.evaluate(() => { document.querySelector('.mine-bar').dataset.m = '1'; });
await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'tweetsAdded', added: 1 }));
await waitFor(async () => (await stats.evaluate(() => document.querySelector('.mine-bar')?.dataset.m)) !== '1', 'les stats se rechargent après « nouvelles données »', 20000);
await stats.screenshot({ path: 'test/stats-mine.png', fullPage: true });

// ---- recherche : regroupement des quasi-doublons (mêmes règles que les stats)
await panel.bringToFront();
await panel.reload(); // recharge l'index avec les vecteurs simulés
await panel.waitForSelector('.tw');
await panel.fill('#q', 'agents quoted:no dedupe:0.98,30');
try { await waitFor(async () => /sujets \(\d+ tweets/.test(await panel.locator('#mode').innerText()), 'recherche regroupée : « N sujets (M tweets…) »', 10000); } catch (e) { console.log('MODE:', await panel.locator('#mode').innerText(), '| url', panel.url()); throw e; }
assert.ok(await panel.locator('.dupbtn').count() > 0, 'les cartes regroupées proposent « + N similaires »');
try {
  await panel.locator('.dupbtn').first().click();
  await waitFor(async () => (await panel.locator('.dups:not([hidden]) .dup').count()) > 0, 'les similaires se déplient', 6000);
} catch (e) { console.log('DUPS:', await panel.locator('.dupbtn').count(), await panel.locator('.dups').count(), await panel.locator('#mode').innerText()); throw e; }
await panel.fill('#q', '');

// ---- journal : estimation puis génération avec le faux modèle, pages A4 sans débordement
const journal = await ctx.newPage();
await journal.goto(`chrome-extension://${extId}/journal.html`);
await journal.waitForSelector('#j-go');
await journal.evaluate(() => { document.getElementById('j-links').checked = false; document.getElementById('j-links').dispatchEvent(new Event('change')); });
await journal.evaluate(() => { for (const id of ['j-search', 'j-verify']) { const c = document.getElementById(id); c.checked = true; c.dispatchEvent(new Event('change')); } });
await journal.fill('#j-budget', '5');
await journal.dispatchEvent('#j-budget', 'change');
await journal.evaluate(async () => { // une vidéo regardée cette semaine, avec sa transcription
  const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
  const db = await new Promise((res, rej) => { const r = indexedDB.open('xbs'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = db.transaction(['tweets', 'transcripts'], 'readwrite');
  tx.objectStore('tweets').put({ id: 'yt:jr1', kind: 'youtube', source: 'youtube', handle: 'chaine', name: 'Chaîne Test', text: 'Une conférence sur les agents', url: 'https://www.youtube.com/watch?v=jr1', createdAt: new Date(now).toISOString(), sortIndex: String(now), links: [], media: [], stats: {}, capturedAt: now, addedAt: now, watched: [day], lastWatched: now, durationText: '12:00', trState: 'ok', trChars: 4000, playlists: [] });
  tx.objectStore('transcripts').put({ id: 'yt:jr1', chunks: Array.from({ length: 12 }, (_, i) => ({ t: i * 60, text: 'Le conférencier explique le point ' + i + ' sur les agents et leur mémoire de façon détaillée. '.repeat(4) })) });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
});
await journal.click('#j-est');
await waitFor(async () => /Coût estimé :/.test(await journal.locator('#j-log').innerText().catch(() => '')), 'estimation du coût du journal', 60000);
await journal.click('#j-go');
await waitFor(async () => /Édition terminée/.test(await journal.locator('#j-log').innerText().catch(() => '')) || /⚠/.test(await journal.locator('#j-log').innerText().catch(() => '')), 'fin de la génération du journal', 120000);
const jlog = await journal.locator('#j-log').innerText();
assert.match(jlog, /Édition terminée : (\d+) pages/, jlog);
assert.match(jlog, /Recherche web : [1-9]\d* sujet\(s\) complété/, jlog);
assert.match(jlog, /fait\(s\) écarté\(s\) : adresse non consultée/, jlog);
assert.match(jlog, /Relecture : [1-9]\d* phrase\(s\) non étayée\(s\) retirée\(s\)/, jlog);
assert.match(jlog, /Transcriptions : \d+ sujet/, jlog);
assert.match(jlog, /Reportages : 1\./, jlog);
console.log('journal :', jlog.split('\n').filter((l) => /Reportage|Transcriptions/.test(l)).join(' | '));
const paperText = await journal.locator('#paper').innerText();
assert.match(paperText, /ref\.example/, 'la page web consultée figure dans l’index des sources');
assert.ok(!/made\.up/.test(paperText), 'l’adresse inventée n’apparaît nulle part');
const pagesN = await journal.locator('#paper .page').count();
assert.ok(pagesN >= 4, 'au moins 4 pages : ' + pagesN);
assert.match(await journal.locator('#paper .page').first().innerText(), /La Gazette IA & Robotique/);
const bad = await journal.evaluate(() => [...document.querySelectorAll('#paper .page .body.flow')].filter((b) => b.scrollWidth > b.clientWidth + 2).length);
assert.ok(bad <= 2, 'pages qui débordent : ' + bad);
for (let i = 0; i < Math.min(pagesN, 4); i++) await journal.locator('#paper .page').nth(i).screenshot({ path: `${process.env.TMPDIR || '/tmp'}/journal-e2e-p${i + 1}.png` });
assert.ok(await journal.locator('#j-list .ed').count() >= 1, 'l’édition est enregistrée');

console.log('E2E OK');
await ctx.close();
server.close();
