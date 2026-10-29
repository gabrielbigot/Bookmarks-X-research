#!/usr/bin/env node
// Serveur MCP (stdio) pour « Bookmarks & Playlists – Recherche intelligente ».
// Lancé par le client MCP (Claude Desktop, Claude Code…), il ouvre un port local (127.0.0.1) auquel l'extension se connecte ;
// chaque appel d'outil est transmis à l'extension, qui répond avec sa propre recherche. Aucune dépendance : Node 18+ suffit.
import http from 'node:http';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { TOOL_DEFS } from '../src/lib/mcp-defs.js';

const PORT = Number(process.env.XBS_PORT) || 47821;
const TOKEN = process.env.XBS_TOKEN || '';
const log = (...a) => console.error('[xbs-mcp]', ...a); // stdout est réservé au protocole MCP

// ---------- WebSocket minimal (RFC 6455) : une seule connexion, celle de l'extension ----------
let conn = null; // { socket, send(text) }
let nextId = 1;
const pending = new Map();

function frame(opcode, payload, mask) {
  const len = payload.length;
  const m = mask ? 0x80 : 0;
  const head = len < 126 ? Buffer.from([0x80 | opcode, m | len]) : len < 65536 ? Buffer.from([0x80 | opcode, m | 126, len >> 8, len & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = m | 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
  if (!mask) return Buffer.concat([head, payload]);
  const key = crypto.randomBytes(4), body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
  return Buffer.concat([head, key, body]);
}

function serveSocket(socket, onText, { client = false } = {}) {
  let buf = Buffer.alloc(0), partial = [], partialOp = 0;
  const send = (op, data) => { if (!socket.destroyed) socket.write(frame(op, data, client)); };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = !!(buf[0] & 0x80), op = buf[0] & 15, masked = !!(buf[1] & 0x80);
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 64 * 1024 * 1024) return socket.destroy();
      if (masked === client) return socket.destroy(); // un client doit masquer ses trames, un serveur non
      const mlen = masked ? 4 : 0;
      if (buf.length < off + mlen + len) return;
      const data = Buffer.from(buf.subarray(off + mlen, off + mlen + len));
      if (masked) { const mask = buf.subarray(off, off + 4); for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3]; }
      buf = buf.subarray(off + mlen + len);
      if (op === 8) { send(8, Buffer.alloc(0)); return socket.end(); }
      if (op === 9) { send(10, data); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2) { partial = [data]; partialOp = op; } else if (op === 0) partial.push(data);
      if (fin && partial.length) { const text = Buffer.concat(partial).toString('utf8'); partial = []; if (partialOp === 1) onText(text); }
    }
  });
  return { send: (text) => send(1, Buffer.from(text, 'utf8')), close: () => { try { send(8, Buffer.alloc(0)); socket.end(); } catch { /* déjà fermée */ } } };
}

const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---------- hub : l'instance qui tient le port parle à l'extension ; les autres s'y raccordent (relais) ----------
let hub = null; // serveur http si CETTE instance est le hub
let listenError = '';
let relay = null; // { send(text), close() } si cette instance est raccordée à un autre hub
const relayPending = new Map();

function onUpgrade(req, socket) {
  const origin = req.headers.origin ? String(req.headers.origin) : '';
  const key = req.headers['sec-websocket-key'];
  const isExt = req.url === '/xbs', isRelay = req.url === '/relay';
  // /xbs : seulement une extension de navigateur (Origin « chrome-extension:// », « comet-extension:// »… : un site web ne peut pas en usurper un) ; /relay : seulement un autre processus local (jamais une page web : elle envoie toujours un Origin)
  if (!key || !((isExt && /^[a-z]+-extension:\/\//i.test(origin)) || (isRelay && !origin))) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let authed = false;
  const me = serveSocket(socket, (text) => {
    let m; try { m = JSON.parse(text); } catch { return; }
    if (!authed) {
      if (m.type !== 'hello' || !TOKEN || !safeEq(m.token, TOKEN)) { log('connexion refusée : jeton incorrect'); return me.close(); }
      authed = true;
      if (m.test) { me.send('{"type":"ready","test":true}'); setTimeout(() => me.close(), 100); return; } // test de connexion depuis le panneau : ne remplace pas la vraie connexion
      if (isRelay) { me.send('{"type":"ok"}'); log('un autre assistant s’est raccordé'); return; }
      conn?.close(); conn = me; me.send('{"type":"ready"}'); log('extension connectée'); return;
    }
    if (isRelay) { // appel d'un autre assistant : relayé à l'extension
      if (m.id === undefined || !m.method) return;
      callExtension(m.method, m.params || {}).then((result) => me.send(JSON.stringify({ id: m.id, result })), (e) => me.send(JSON.stringify({ id: m.id, error: String(e.message || e) })));
      return;
    }
    if (m.type === 'ping') return me.send('{"type":"pong"}');
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  });
  setTimeout(() => { if (!authed) me.close(); }, 5000);
  socket.on('close', () => { if (!isRelay && conn === me) { conn = null; log('extension déconnectée'); for (const [id, p] of pending) { pending.delete(id); clearTimeout(p.timer); p.reject(new Error('connexion perdue avec l’extension')); } } });
  socket.on('error', () => {});
}

// Tente de devenir le hub : true si le port est à nous.
function startHub() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); return res.end('{"app":"xbs-mcp"}'); } // sert au diagnostic de l'extension ; ne donne aucune donnée
      res.writeHead(404); res.end();
    });
    srv.on('upgrade', onUpgrade);
    srv.once('error', (e) => { listenError = e.code === 'EADDRINUSE' ? 'EADDRINUSE' : String(e.code || e.message || e); resolve(false); });
    srv.listen(PORT, '127.0.0.1', () => { hub = srv; listenError = ''; log(`en attente de l’extension sur 127.0.0.1:${PORT}`); resolve(true); });
  });
}

// Se raccorde au hub qui tient déjà le port (autre assistant, ou instance précédente) : true si le relais est établi.
function connectRelay() {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/relay', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
    const fail = () => resolve(false);
    req.setTimeout(3000, () => { req.destroy(); fail(); });
    req.on('response', fail); req.on('error', fail);
    req.on('upgrade', (_res, socket) => {
      let done = false;
      const me = serveSocket(socket, (text) => {
        let m; try { m = JSON.parse(text); } catch { return; }
        if (!done && m.type === 'ok') { done = true; relay = me; log(`raccordé au serveur déjà actif sur le port ${PORT}`); return resolve(true); }
        const p = relayPending.get(m.id);
        if (!p) return;
        relayPending.delete(m.id); clearTimeout(p.timer);
        m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      }, { client: true });
      socket.on('close', () => { if (relay === me) relay = null; for (const [id, p] of relayPending) { relayPending.delete(id); clearTimeout(p.timer); p.reject(new Error('le serveur principal s’est arrêté : réessayez')); } if (!done) resolve(false); });
      socket.on('error', () => {});
      me.send(JSON.stringify({ type: 'hello', token: TOKEN }));
      setTimeout(() => { if (!done) { me.close(); resolve(false); } }, 4000);
    });
    req.end();
  });
}

const why = () => !TOKEN ? 'jeton XBS_TOKEN absent de la configuration du serveur MCP'
  : listenError === 'EADDRINUSE' ? `le port ${PORT} est occupé par un autre programme qui n’est pas ce serveur (ou qui n’accepte pas ce jeton) : changez de port (XBS_PORT côté serveur ET dans ⚙ › Pont MCP) ou arrêtez ce programme (macOS / Linux : lsof -i :${PORT}, Windows : netstat -ano | findstr ${PORT})`
  : `impossible d’ouvrir le port ${PORT} (${listenError || 'raison inconnue'})`;
const notConnected = 'l’extension n’est pas connectée : Chrome (ou Comet…) doit être ouvert, l’extension active et « Pont MCP » coché dans ⚙ (même jeton, même port)';

if (!TOKEN) log('XBS_TOKEN manquant : copiez le jeton affiché dans l’extension (⚙ › Pont MCP) dans la variable d’environnement XBS_TOKEN');
else if (!(await startHub())) { log(listenError === 'EADDRINUSE' ? `le port ${PORT} est déjà utilisé : tentative de raccordement au serveur actif…` : why()); if (listenError === 'EADDRINUSE' && !(await connectRelay())) log(why()); }

async function callExtension(method, params) {
  if (!TOKEN) throw new Error(why());
  if (!hub && !relay) { // premier essai raté ou hub disparu : redevenir hub, sinon se raccorder
    if (!(await startHub()) && !(listenError === 'EADDRINUSE' && (await connectRelay()))) throw new Error(why());
  }
  if (relay) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { relayPending.delete(id); reject(new Error('délai dépassé (60 s) : l’index est peut-être en cours de chargement, réessayez')); }, 60_000);
      relayPending.set(id, { resolve, reject, timer });
      relay.send(JSON.stringify({ id, method, params }));
    });
  }
  if (!conn) throw new Error(notConnected);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('délai dépassé (60 s) : l’index est peut-être en cours de chargement, réessayez')); }, 60_000);
    pending.set(id, { resolve, reject, timer });
    conn.send(JSON.stringify({ id, method, params }));
  });
}

// ---------- MCP : JSON-RPC 2.0, un message par ligne sur stdin / stdout ----------
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
async function handle(msg) {
  const { id, method, params } = msg;
  const ok = (result) => id !== undefined && out({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && out({ jsonrpc: '2.0', id, error: { code, message } });
  try {
    if (method === 'initialize') return ok({ protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'bookmarks-x-research', version: '1.0.0' },
      instructions: 'Recherche dans les bookmarks X, les playlists et l’historique YouTube (avec transcriptions) de l’utilisateur. Commence par `search` ; utilise `get_transcript` avec une question pour retrouver un passage précis d’une vidéo.' });
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: TOOL_DEFS });
    if (method === 'tools/call') {
      const name = params?.name;
      if (!TOOL_DEFS.some((t) => t.name === name)) return fail(-32602, 'outil inconnu : ' + name);
      try { const r = await callExtension(name, params.arguments || {}); return ok({ content: [{ type: 'text', text: JSON.stringify(r) }] }); }
      catch (e) { return ok({ isError: true, content: [{ type: 'text', text: String(e.message || e) }] }); }
    }
    if (method?.startsWith('notifications/')) return;
    return fail(-32601, 'méthode inconnue : ' + method);
  } catch (e) { return fail(-32603, String(e.message || e)); }
}
readline.createInterface({ input: process.stdin }).on('line', (line) => { if (!line.trim()) return; let m; try { m = JSON.parse(line); } catch { return; } handle(m); }).on('close', () => process.exit(0));
