#!/usr/bin/env node
// Déclare le serveur MCP dans Claude Desktop sans éditer le JSON à la main :
//   node mcp/setup.mjs --token <jeton> [--port 47821] [--config <fichier>] [--remove]
// Le fichier de config existant est conservé (copie de sauvegarde .bak) ; seule l'entrée « bookmarks » est ajoutée ou remplacée.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
const token = opt('token') || process.env.XBS_TOKEN || '';
const port = opt('port');
const remove = args.includes('--remove');
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');

const defaultConfig = () => {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json');
};
const file = path.resolve(opt('config') || defaultConfig());
const fail = (msg) => { console.error('✗ ' + msg); process.exit(1); };

if (!remove && !token) fail('jeton manquant : copiez-le depuis l’extension (⚙ › Pont MCP › Copier le jeton) puis relancez avec --token <jeton>');
let cfg = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim()) { try { cfg = JSON.parse(raw); } catch (e) { fail(`${file} n’est pas un JSON valide (${e.message}) : rien n’a été modifié`); } }
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) fail(`${file} n’est pas un objet JSON : rien n’a été modifié`);
  fs.copyFileSync(file, file + '.bak');
} else fs.mkdirSync(path.dirname(file), { recursive: true });

cfg.mcpServers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
if (remove) delete cfg.mcpServers.bookmarks;
else cfg.mcpServers.bookmarks = { command: process.execPath, args: [server], env: { XBS_TOKEN: token, ...(port ? { XBS_PORT: String(Number(port)) } : {}) } };
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log(`✓ ${remove ? 'Entrée « bookmarks » retirée de' : 'Serveur « bookmarks » déclaré dans'} ${file}`);
if (fs.existsSync(file + '.bak')) console.log(`  (sauvegarde de l’ancien fichier : ${file}.bak)`);
console.log('→ Quittez complètement Claude Desktop (pas seulement la fenêtre) puis relancez-le.');
