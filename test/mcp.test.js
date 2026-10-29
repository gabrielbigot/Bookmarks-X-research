import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { parseBookmarksResponse } from '../src/lib/parse.js';
import { Index, DIM } from '../src/lib/search.js';
import { createTools, bestPassages, htmlToText, itemView } from '../src/lib/mcp.js';
import { TOOL_DEFS } from '../src/lib/mcp-defs.js';
import { demoPage } from './fixtures/bookmarks.js';

const { tweets } = parseBookmarksResponse(demoPage());
const axis = (i) => { const v = new Float32Array(DIM); v[i] = 1; return v; };
const video = { id: 'yt:v1', kind: 'youtube', source: 'youtube', videoId: 'v1', handle: 'chaine', name: 'Chaîne Test', text: 'Une conférence sur les agents autonomes', url: 'https://www.youtube.com/watch?v=v1', createdAt: null, sortIndex: '5', links: [], media: [], stats: {}, durationText: '12:00', trState: 'ok', playlists: [{ id: 'PL1', title: 'À voir' }], watched: ['2026-10-12'], addedAt: Date.parse('2026-10-10T10:00:00Z') };
const chunks = [{ t: 0, text: 'Bienvenue dans cette vidéo.' }, { t: 125, text: 'Ici on explique la mémoire des agents et le stockage vectoriel.' }, { t: 300, text: 'Conclusion et remerciements.' }];
const idx = new Index();
idx.build([...tweets, video], new Map([['1001', axis(0)], ['1005', axis(0)], ['1002', axis(1)]]));
const ctx = (over = {}) => ({
  getIndex: async () => idx, embed: async () => axis(0),
  getTranscripts: async (ids) => new Map(ids.filter((i) => i === 'yt:v1').map((i) => [i, chunks])),
  playlists: async () => [{ id: 'PL1', title: 'À voir', n: 1 }], journals: async () => [{ id: 'j1', label: 'du 12 au 18 octobre 2026', pages: 30, subjects: 40, at: Date.parse('2026-10-18T10:00:00Z') }],
  journal: async (id) => (id === 'j1' ? { html: '<section class="page"><h2>Titre</h2><p>Un &amp; deux</p></section>' } : null), ...over,
});

test('search : hybride, filtres, passage de transcription, repli sans embedding', async () => {
  const t = createTools(ctx());
  const r = await t.search({ query: 'mémoire agents', limit: 5 });
  assert.equal(r.mode, 'hybrid');
  assert.ok(r.results.length >= 2 && r.results.every((x) => x.id && x.url && x.kind));
  assert.ok(r.results.some((x) => x.kind === 'x' && /agents/i.test(x.text)));
  const v = r.results.find((x) => x.id === 'yt:v1');
  assert.ok(v && v.passage && /mémoire des agents/.test(v.passage.text) && v.passage.seconds === 125 && /t=125s$/.test(v.passage.link), JSON.stringify(v));
  const yt = await t.search({ query: 'agents source:youtube' });
  assert.deepEqual(yt.results.map((x) => x.id), ['yt:v1']);
  const x = await t.search({ query: 'agents', source: 'x', limit: 1 });
  assert.equal(x.results.length, 1); assert.equal(x.results[0].kind, 'x');
  assert.equal((await t.search({ query: 'from:rustacean' })).results[0].id, '1002');
  const noEmb = createTools(ctx({ embed: async () => { throw new Error('modèle absent'); } }));
  const f = await noEmb.search({ query: 'tokio' });
  assert.equal(f.mode, 'keywords'); assert.ok(f.notes[0].includes('modèle absent')); assert.equal(f.results[0].id, '1002');
  const ign = await t.search({ query: 'agents is:truc' });
  assert.ok(ign.notes.some((n) => /is:/.test(n)));
  const recent = await t.search({ query: 'source:youtube' }); // opérateurs seuls : liste filtrée
  assert.equal(recent.mode, 'filtre'); assert.equal(recent.results[0].id, 'yt:v1');
});

test('search : pagination et liste compacte pour parcourir tous les éléments', async () => {
  const t = createTools(ctx());
  const p1 = await t.search({ query: 'source:x', limit: 2 });
  assert.equal(p1.shown, 2); assert.equal(p1.next_offset, 2);
  const p2 = await t.search({ query: 'source:x', limit: 2, offset: p1.next_offset });
  assert.ok(p2.results.every((r) => !p1.results.some((x) => x.id === r.id)), 'pas de doublon entre pages');
  const b = await t.search({ query: 'from:"chaîne test" source:youtube', brief: true });
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(b.results[0]))).sort(), ['duration', 'hasTranscript', 'id', 'published', 'title']);
  assert.ok(!b.next_offset);
});

test('extract : un modèle bon marché lit des extraits ; citations vérifiées, cache, plafond, estimation', async () => {
  const calls = [];
  const cache = new Map();
  const mk = (reply, cost = 0.001) => ctx({ extractCfg: async () => ({ model: 'm/x', budget: 0.3, prices: { inPerM: 0.2, outPerM: 0.6 }, cache: { get: (k) => cache.get(k), set: (k, v) => cache.set(k, v) }, llm: async (msgs) => { calls.push(msgs); return { text: reply, cost }; } }) });
  const good = JSON.stringify({ answers: [{ value: 'Matthieu Rouif', evidence: 'Ici on explique la mémoire des agents' }] });
  const t = createTools(mk(good));
  const est = await t.extract({ question: 'Qui est l’invité ?', query: 'source:youtube', estimate: true });
  assert.equal(est.estimateOnly, true); assert.equal(est.videos, 1); assert.equal(calls.length, 0); assert.ok(est.estimatedUsd > 0 && est.estimatedUsd < 0.01);
  const r = await t.extract({ question: 'Qui est l’invité ?', query: 'source:youtube' });
  assert.equal(calls.length, 1);
  assert.match(calls[0][1].content, /EXTRAITS :[\s\S]*\[0:00\] Bienvenue/); // l'ouverture de la vidéo est toujours montrée
  assert.ok(!/Conclusion et remerciements/.test(calls[0][1].content) || calls[0][1].content.length < 4000);
  assert.equal(r.results[0].answers[0].value, 'Matthieu Rouif'); assert.equal(r.results[0].answers[0].at, '2:05'); assert.match(r.results[0].answers[0].link, /t=125s$/);
  assert.equal(r.costUsd, 0.001); assert.equal(r.rejectedCitations, 0);
  await t.extract({ question: 'Qui est l’invité ?', query: 'source:youtube' }); // même question : cache, aucun appel de plus
  assert.equal(calls.length, 1);
  // citation inventée : la réponse est écartée
  cache.clear();
  const bad = createTools(mk(JSON.stringify({ answers: [{ value: 'Quelqu’un', evidence: 'Une phrase que la vidéo ne contient pas du tout' }] })));
  const rb = await bad.extract({ question: 'Qui ?', ids: ['yt:v1'] });
  assert.deepEqual(rb.results[0].answers, []); assert.equal(rb.rejectedCitations, 1);
  // réponse illisible : pas mise en cache
  cache.clear(); calls.length = 0;
  const junk = createTools(mk('pas du json'));
  assert.equal((await junk.extract({ question: 'Qui ?', ids: ['yt:v1'] })).invalidReplies, 1); assert.equal(cache.size, 0);
  await assert.rejects(t.extract({ question: '' }), /question requise/);
  assert.equal((await t.extract({ question: 'x', ids: ['1002'] })).videos, 0); // un tweet n'est pas une vidéo
});

test('extract : le plafond de coût arrête la lecture', async () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ ...video, id: 'yt:m' + i, videoId: 'm' + i, text: 'Vidéo ' + i, url: 'https://www.youtube.com/watch?v=m' + i }));
  const ix = new Index(); ix.build(many, new Map());
  const n = { c: 0 };
  const t = createTools(ctx({ getIndex: async () => ix, getTranscripts: async (ids) => new Map(ids.map((i) => [i, chunks])), extractCfg: async () => ({ model: 'm', budget: 0.3, prices: { inPerM: 0.2, outPerM: 0.6 }, cache: { get: () => undefined, set() {} }, llm: async () => { n.c++; return { text: '{"answers":[]}', cost: 0.06 }; } }) }));
  const r = await t.extract({ question: 'Qui ?', query: 'source:youtube', max_cost: 0.1, limit: 6 });
  assert.equal(r.stoppedByBudget, true); assert.ok(n.c >= 2 && n.c < 6, 'appels : ' + n.c); assert.ok(r.results.some((x) => x.skipped));
});

test('get_item, get_transcript, similar, playlists, stats, journal', async () => {
  const t = createTools(ctx());
  assert.match((await t.get_item({ id: '1002' })).text, /tokio/i);
  await assert.rejects(t.get_item({ id: 'nope' }), /inconnu/);
  const q = await t.get_transcript({ id: 'yt:v1', query: 'stockage vectoriel' });
  assert.equal(q.passages[0].seconds, 125); assert.equal(q.passages[0].at, '2:05');
  const seq = await t.get_transcript({ id: 'yt:v1', max_chars: 500 });
  assert.match(seq.text, /\[0:00\] Bienvenue/); assert.match(seq.text, /\[5:00\]/);
  const cut = await t.get_transcript({ id: 'yt:v1', from_seconds: 100 });
  assert.ok(!/Bienvenue/.test(cut.text));
  await assert.rejects(t.get_transcript({ id: '1002' }), /pas une vidéo/);
  const sim = await t.similar({ id: '1001', limit: 3 });
  assert.equal(sim.results[0].id, '1005'); assert.ok(sim.results.every((r) => r.id !== '1001'));
  await assert.rejects(t.similar({ id: '1004' }), /pas encore indexé/);
  assert.deepEqual((await t.list_playlists()).playlists, [{ id: 'PL1', title: 'À voir', videos: 1 }]);
  const st = await t.stats();
  assert.equal(st.videos, 1); assert.equal(st.tweets, tweets.length); assert.equal(st.videosWithTranscript, 1); assert.equal(st.indexedSemantically, 3);
  assert.equal((await t.journal_list()).editions[0].id, 'j1');
  assert.match((await t.journal_read({ id: 'j1' })).text, /Titre\nUn & deux/);
  await assert.rejects(t.journal_read({ id: 'zz' }), /inconnue/);
});

test('utilitaires : passages, html, vue compacte', () => {
  assert.equal(bestPassages(chunks, ['conclusion'], 1)[0].at, 300);
  assert.deepEqual(bestPassages(chunks, ['zzz']), []);
  assert.equal(htmlToText('<p>a</p><script>x</script><p>b&nbsp;c</p>'), 'a\nb c');
  const v = itemView(tweets[0]);
  assert.ok(v.text && !('sortIndex' in v) && v.stats.likes === 12);
  assert.ok(TOOL_DEFS.every((d) => d.name && d.description && d.inputSchema.type === 'object') && TOOL_DEFS.some((d) => d.name === 'search'));
});

// ---------- serveur Node : protocole MCP sur stdio + WebSocket de l'extension ----------
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
function wsClient(port, { origin = 'chrome-extension://abc', onMessage }) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({ host: '127.0.0.1', port, path: '/xbs', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', ...(origin ? { Origin: origin } : {}) } });
    req.on('upgrade', (res, socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', (c) => { buf = Buffer.concat([buf, c]); while (buf.length >= 2) { let len = buf[1] & 127, off = 2; if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; } if (buf.length < off + len) return; const op = buf[0] & 15; const data = buf.subarray(off, off + len); buf = buf.subarray(off + len); if (op === 1) onMessage?.(data.toString('utf8')); } });
      const send = (text) => { const p = Buffer.from(text), m = crypto.randomBytes(4); const head = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : p.length < 65536 ? Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(p.length), 2); return h; })(); const body = Buffer.from(p); for (let i = 0; i < body.length; i++) body[i] ^= m[i & 3]; socket.write(Buffer.concat([head, m, body])); };
      resolve({ send, socket, accept: res.headers['sec-websocket-accept'], key });
    });
    req.on('response', (res) => reject(new Error('HTTP ' + res.statusCode)));
    req.on('error', reject);
    req.end();
  });
}

test('serveur MCP : initialize, tools/list, appel relayé à l’extension, jeton et origine contrôlés', async () => {
  const port = await freePort();
  const srv = spawn(process.execPath, ['mcp/server.mjs'], { env: { ...process.env, XBS_TOKEN: 'secret', XBS_PORT: String(port) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = []; let wake;
  srv.stdout.setEncoding('utf8'); let acc = '';
  srv.stdout.on('data', (d) => { acc += d; let i; while ((i = acc.indexOf('\n')) >= 0) { lines.push(JSON.parse(acc.slice(0, i))); acc = acc.slice(i + 1); wake?.(); } });
  const rpc = async (msg) => { srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); const t0 = Date.now(); while (!lines.some((l) => l.id === msg.id)) { await new Promise((r) => { wake = r; setTimeout(r, 100); }); if (Date.now() - t0 > 8000) throw new Error('pas de réponse'); } return lines.find((l) => l.id === msg.id); };
  let ready = ''; srv.stderr.setEncoding('utf8'); srv.stderr.on('data', (d) => (ready += d));
  try {
    for (let i = 0; i < 50 && !/en attente/.test(ready); i++) await new Promise((r) => setTimeout(r, 100));
    const init = await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    assert.equal(init.result.protocolVersion, '2025-03-26'); assert.ok(init.result.capabilities.tools);
    const list = await rpc({ id: 2, method: 'tools/list' });
    assert.equal(list.result.tools.length, TOOL_DEFS.length);
    // pas d'extension : erreur d'outil claire (pas d'erreur de protocole)
    const none = await rpc({ id: 3, method: 'tools/call', params: { name: 'stats', arguments: {} } });
    assert.equal(none.result.isError, true); assert.match(none.result.content[0].text, /n’est pas connectée/);
    // origine refusée (une page web ne peut pas se connecter)
    await assert.rejects(wsClient(port, { origin: 'https://evil.example' }), /403/);
    await assert.rejects(wsClient(port, { origin: 'http://comet-extension.evil.example' }), /403/);
    await assert.rejects(wsClient(port, { origin: '' }), /403/);
    // jeton incorrect : connexion fermée, pas d'appel possible
    const bad = await wsClient(port, {}); let closed = false; bad.socket.on('close', () => (closed = true));
    bad.send(JSON.stringify({ type: 'hello', token: 'wrong' }));
    for (let i = 0; i < 30 && !closed; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(closed, 'jeton incorrect : fermée');
    // extension simulée (navigateur Comet : l'origine est « comet-extension:// »)
    const seen = [];
    const ext = await wsClient(port, { origin: 'comet-extension://ihkijnjcinobacbdafhcdbgdfemnecoo', onMessage: (t) => { const m = JSON.parse(t); if (m.type === 'pong') return; seen.push(m); ext.send(JSON.stringify({ id: m.id, result: { echo: m.method, args: m.params } })); } });
    assert.equal(ext.accept, crypto.createHash('sha1').update(ext.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'));
    ext.send(JSON.stringify({ type: 'hello', token: 'secret' }));
    await new Promise((r) => setTimeout(r, 200));
    ext.send('{"type":"ping"}');
    const call = await rpc({ id: 4, method: 'tools/call', params: { name: 'search', arguments: { query: 'agents', limit: 3 } } });
    assert.ok(!call.result.isError, JSON.stringify(call));
    assert.deepEqual(JSON.parse(call.result.content[0].text), { echo: 'search', args: { query: 'agents', limit: 3 } });
    assert.equal(seen[0].method, 'search');
    assert.equal((await rpc({ id: 5, method: 'tools/call', params: { name: 'rm_rf', arguments: {} } })).error.code, -32602);
    // grosses trames (200 ko, longueur sur 64 bits) dans les deux sens
    const big = await rpc({ id: 6, method: 'tools/call', params: { name: 'search', arguments: { query: 'x'.repeat(200000) } } });
    assert.equal(JSON.parse(big.result.content[0].text).args.query.length, 200000);
  } finally { srv.kill(); }
});

test('serveur MCP sans jeton : refuse de démarrer l’écoute et le dit', async () => {
  const srv = spawn(process.execPath, ['mcp/server.mjs'], { env: { ...process.env, XBS_TOKEN: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = ''; srv.stderr.setEncoding('utf8'); srv.stderr.on('data', (d) => (err += d));
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'stats', arguments: {} } }) + '\n');
  const out = await new Promise((res) => { srv.stdout.once('data', (d) => res(JSON.parse(String(d)))); });
  srv.kill();
  assert.match(err, /XBS_TOKEN manquant/); assert.equal(out.result.isError, true); assert.match(out.result.content[0].text, /jeton/);
});

test('setup.mjs : ajoute le serveur à une config existante sans rien casser, refuse un JSON invalide', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbs-setup-'));
  const file = path.join(dir, 'claude_desktop_config.json');
  const run = (...a) => new Promise((res) => { const p = spawn(process.execPath, ['mcp/setup.mjs', ...a], { stdio: ['ignore', 'pipe', 'pipe'] }); let o = ''; p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (o += d)); p.on('close', (code) => res({ code, o })); });
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark', mcpServers: { autre: { command: 'x' } } }));
  const r = await run('--token', 'tok123', '--port', '48000', '--config', file);
  assert.equal(r.code, 0, r.o);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.theme, 'dark'); assert.deepEqual(cfg.mcpServers.autre, { command: 'x' });
  assert.equal(cfg.mcpServers.bookmarks.env.XBS_TOKEN, 'tok123'); assert.equal(cfg.mcpServers.bookmarks.env.XBS_PORT, '48000');
  assert.ok(path.isAbsolute(cfg.mcpServers.bookmarks.args[0]) && cfg.mcpServers.bookmarks.args[0].endsWith(path.join('mcp', 'server.mjs')));
  assert.ok(fs.existsSync(file + '.bak'));
  assert.equal((await run('--remove', '--config', file)).code, 0);
  assert.ok(!('bookmarks' in JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers));
  fs.writeFileSync(file, '{ "theme": ');
  const bad = await run('--token', 't', '--config', file);
  assert.equal(bad.code, 1); assert.match(bad.o, /pas un JSON valide/); assert.equal(fs.readFileSync(file, 'utf8'), '{ "theme": ');
  fs.rmSync(file); // fichier absent : créé
  assert.equal((await run('--token', 't', '--config', file)).code, 0); assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.bookmarks);
  assert.equal((await run('--config', file)).code, 1); // jeton manquant
});

// ---------- deux assistants (ou une instance en double) : le second se raccorde au premier ----------
const startServer = (port, token = 'secret') => {
  const srv = spawn(process.execPath, ['mcp/server.mjs'], { env: { ...process.env, XBS_TOKEN: token, XBS_PORT: String(port) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = []; let acc = '', log = '';
  srv.stdout.setEncoding('utf8'); srv.stdout.on('data', (d) => { acc += d; let i; while ((i = acc.indexOf('\n')) >= 0) { lines.push(JSON.parse(acc.slice(0, i))); acc = acc.slice(i + 1); } });
  srv.stderr.setEncoding('utf8'); srv.stderr.on('data', (d) => (log += d));
  let n = 1;
  const call = async (name, args) => { const id = n++; srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n'); for (let i = 0; i < 100 && !lines.some((l) => l.id === id); i++) await new Promise((r) => setTimeout(r, 100)); return lines.find((l) => l.id === id).result; };
  return { srv, call, log: () => log };
};
test('serveur MCP : une 2e instance sur le même port se raccorde à la première', async () => {
  const port = await freePort();
  const A = startServer(port);
  for (let i = 0; i < 50 && !/en attente/.test(A.log()); i++) await new Promise((r) => setTimeout(r, 100));
  const ext = await wsClient(port, { onMessage: (t) => { const m = JSON.parse(t); if (m.method) ext.send(JSON.stringify({ id: m.id, result: { via: 'extension', method: m.method } })); } });
  ext.send(JSON.stringify({ type: 'hello', token: 'secret' }));
  await new Promise((r) => setTimeout(r, 200));
  const B = startServer(port);
  try {
    const r = await B.call('stats', {});
    assert.ok(!r.isError, JSON.stringify(r) + B.log());
    assert.deepEqual(JSON.parse(r.content[0].text), { via: 'extension', method: 'stats' });
    assert.match(B.log(), /raccordé au serveur déjà actif/);
    assert.ok(!(await A.call('stats', {})).isError, 'le premier fonctionne toujours');
    // jeton différent : refusé, avec une explication
    const C = startServer(port, 'autre');
    const rc = await C.call('stats', {});
    assert.equal(rc.isError, true); assert.match(rc.content[0].text, /port \d+ est occupé/);
    C.srv.kill();
  } finally { A.srv.kill(); B.srv.kill(); }
});

test('serveur MCP : port pris par un autre programme -> message clair (et pas « indisponible »)', async () => {
  const port = await freePort();
  const blocker = net.createServer((s) => s.destroy()).listen(port, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const S = startServer(port);
  try {
    const r = await S.call('stats', {});
    assert.equal(r.isError, true); assert.match(r.content[0].text, /occupé par un autre programme/); assert.match(r.content[0].text, /XBS_PORT/);
  } finally { S.srv.kill(); blocker.close(); }
});
