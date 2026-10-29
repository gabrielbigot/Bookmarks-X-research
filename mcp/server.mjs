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

function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
  return Buffer.concat([head, payload]);
}

function serveSocket(socket, onText) {
  let buf = Buffer.alloc(0), partial = [], partialOp = 0;
  const send = (op, data) => { if (!socket.destroyed) socket.write(frame(op, data)); };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = !!(buf[0] & 0x80), op = buf[0] & 15, masked = !!(buf[1] & 0x80);
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 64 * 1024 * 1024) return socket.destroy();
      if (!masked) return socket.destroy(); // un client doit masquer ses trames
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
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

const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
server.on('upgrade', (req, socket) => {
  const origin = String(req.headers.origin || '');
  const key = req.headers['sec-websocket-key'];
  if (req.url !== '/xbs' || !key || !/^chrome-extension:\/\//.test(origin)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; } // une page web ne peut pas s'y connecter (Origin)
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let authed = false;
  const me = serveSocket(socket, (text) => {
    let m; try { m = JSON.parse(text); } catch { return; }
    if (!authed) {
      if (m.type !== 'hello' || !TOKEN || !safeEq(m.token, TOKEN)) { log('connexion refusée : jeton incorrect'); return me.close(); }
      authed = true; conn?.close(); conn = me; log('extension connectée'); return;
    }
    if (m.type === 'ping') return me.send('{"type":"pong"}');
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  });
  setTimeout(() => { if (!authed) me.close(); }, 5000);
  socket.on('close', () => { if (conn === me) { conn = null; log('extension déconnectée'); for (const [id, p] of pending) { pending.delete(id); clearTimeout(p.timer); p.reject(new Error('connexion perdue avec l’extension')); } } });
  socket.on('error', () => {});
});
let listening = false;
server.on('error', (e) => log(e.code === 'EADDRINUSE' ? `le port ${PORT} est déjà utilisé (un autre assistant a lancé ce serveur ?) : cet assistant ne pourra pas interroger l’extension` : String(e)));
if (!TOKEN) log('XBS_TOKEN manquant : copiez le jeton affiché dans l’extension (⚙ › Pont MCP) dans la variable d’environnement XBS_TOKEN');
else server.listen(PORT, '127.0.0.1', () => { listening = true; log(`en attente de l’extension sur 127.0.0.1:${PORT}`); });

function callExtension(method, params) {
  if (!conn) throw new Error(!TOKEN ? 'jeton XBS_TOKEN absent de la configuration du serveur MCP' : !listening ? `port ${PORT} indisponible` : 'l’extension n’est pas connectée : Chrome doit être ouvert, l’extension active et « Pont MCP » coché dans ⚙ (même jeton, même port)');
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
