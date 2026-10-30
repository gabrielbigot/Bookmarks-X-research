#!/usr/bin/env node
// Transcrit en local les vidéos YouTube dont l'extension n'a pas pu récupérer la transcription.
//
//   Une fois :          npm run transcribe -- setup          (clé OpenRouter, navigateur pour les cookies : enregistrés, plus à les retaper)
//   À chaque fois :     1. Dans l'extension : ⋯ › « Copier les liens sans transcription »
//                       2. npm run transcribe                (lit le presse-papiers tout seul)
//                       3. Dans l'extension : ⋯ › « Importer des transcriptions… » et choisir le fichier indiqué (results.json)
//
// Étape A (gratuite) : yt-dlp récupère les sous-titres YouTube (y compris automatiques).
// Étape B (audio, payante, clé OpenRouter) : yt-dlp récupère l'audio, ffmpeg le découpe, Voxtral (Mistral, via OpenRouter) le transcrit.
// Aucune dépendance npm : Node 18+, yt-dlp et ffmpeg installés (brew install yt-dlp ffmpeg).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJson3 } from '../src/lib/transcript.js';

const HELP = `Usage : npm run transcribe [-- commande ou options]        (ou : node mcp/transcribe.mjs …)

Commandes
  setup                      enregistre une fois pour toutes : clé Mistral, navigateur des cookies, réglages par défaut
  config                     affiche les réglages enregistrés (la clé est masquée)
  (aucune)                   transcrit les vidéos : liens lus dans un fichier, sinon l'entrée standard, sinon le PRESSE-PAPIERS

Entrée : une vidéo par ligne (lien ou identifiant YouTube) ; colonnes optionnelles séparées par une tabulation : durée en secondes, titre.
         C'est exactement ce que copie le bouton de l'extension.

Options (elles l'emportent sur les réglages enregistrés)
  --out <dossier>            dossier de sortie (défaut : ./transcripts) ; le fichier à importer est results.json
  --audio / --no-audio       si aucun sous-titre : audio + reconnaissance vocale Voxtral (clé OpenRouter requise)
  --model <nom>              modèle de transcription (défaut : mistralai/voxtral-mini-transcribe-3-0, via OpenRouter)
  --price <$/min>            prix d'une minute d'audio, pour l'estimation et le plafond (défaut : 0.0035 ; vérifie la grille d'OpenRouter)
  --eu                       point d'accès européen d'OpenRouter (eu.openrouter.ai)
  --provider mistral         passer directement par l'API de Mistral (clé MISTRAL_API_KEY) au lieu d'OpenRouter
  --budget <$>               plafond de dépense pour la reconnaissance vocale (défaut : 2)
  --lang <code>              langue de l'audio (fr, en…) ; défaut : détection automatique
  --sub-langs <liste>        langues de sous-titres essayées, par ordre (défaut : fr-orig,en-orig,fr,en)
  --limit <n>                ne traiter que n vidéos (pour essayer)
  --sleep <secondes>         pause entre deux vidéos (défaut : 3) : ménage YouTube
  --cookies-from-browser <b> cookies d'un navigateur connecté à YouTube (chrome, firefox, safari, brave, edge…) : souvent nécessaire
                             quand YouTube répond « Sign in to confirm you're not a bot »
  --cookies <fichier>        fichier cookies.txt
  --dry-run                  n'appelle rien : compte les vidéos et estime le coût de l'audio
  --no-reveal                ne pas montrer le fichier créé dans le Finder (macOS)
  --help

Réglages enregistrés dans ~/.config/xbs/transcribe.json (lisible par toi seul). Variables d'environnement prioritaires :
OPENROUTER_API_KEY, MISTRAL_API_KEY, XBS_CONFIG (autre fichier de réglages), XBS_YTDLP / XBS_FFMPEG (chemins des programmes), OPENROUTER_API_BASE, MISTRAL_API_BASE`;

// ---------- fonctions pures (testées) ----------
export const ytId = (s) => (String(s).match(/(?:v=|youtu\.be\/|shorts\/|live\/|embed\/|^)([\w-]{11})(?![\w-])/) || [])[1] || null;

// Entrée collée depuis l'extension : « lien \t durée \t titre » par ligne. Seuls les liens / identifiants YouTube sont retenus, sans doublon.
export function parseInput(text) {
  const out = [], seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const [ref = '', sec = '', ...title] = line.split('\t');
    const id = ytId(ref.trim());
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, seconds: Number(sec) > 0 ? Number(sec) : 0, title: title.join(' ').trim() });
  }
  return out;
}

// Parmi les fichiers de sous-titres produits (<id>.<langue>.json3), celui de la langue la plus prioritaire
export function pickSubtitle(files, id, langs) {
  const found = files.map((f) => ({ f, m: f.match(new RegExp('^' + id.replace(/[-_]/g, '\\$&') + '\\.(.+)\\.json3$')) })).filter((x) => x.m).map((x) => ({ f: x.f, lang: x.m[1] }));
  for (const l of langs) { const hit = found.find((x) => x.lang === l); if (hit) return hit; }
  return found[0] || null;
}

// Réponse d'un service de transcription (Mistral, OpenRouter : formats voisins) -> segments { t, text } décalés de `offset` secondes
// (morceau n° k d'un long audio). Sans horodatage dans la réponse, le texte est découpé en phrases dont l'instant est ESTIMÉ au
// prorata des caractères sur la durée du morceau (`seconds`) : approximatif mais utile pour retrouver un passage à quelques secondes près.
export function mistralSegments(json, offset = 0, seconds = 0) {
  const j = json?.data && !json.segments && !json.text ? json.data : json;
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const segs = Array.isArray(j?.segments) ? j.segments : [];
  const out = segs.map((s) => ({ t: Math.round(offset + (Number(s.start ?? s.start_time ?? s.t) || 0)), text: clean(s.text) })).filter((s) => s.text);
  if (out.length) return out;
  const text = clean(j?.text ?? j?.transcript ?? j?.transcription);
  if (!text) return [];
  if (!(seconds > 0)) return [{ t: Math.round(offset), text }];
  const sentences = text.split(/(?<=[.!?…])\s+/).filter(Boolean);
  const total = text.length || 1;
  let acc = 0;
  return sentences.map((s) => { const t = Math.round(offset + (acc / total) * seconds); acc += s.length + 1; return { t, text: s }; });
}

export const estimateAudioUsd = (videos, price) => videos.reduce((n, v) => n + ((v.seconds || 1800) / 60) * price, 0);

// ---------- exécution ----------
const run = (cmd, args, { timeout = 30 * 60_000 } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, code: err?.code, stdout: String(stdout), stderr: String(stderr), missing: err?.code === 'ENOENT' }));
});
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// ---------- réglages enregistrés ----------
export const configPath = () => process.env.XBS_CONFIG || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'xbs', 'transcribe.json');
export function loadConfig() { try { const c = JSON.parse(fs.readFileSync(configPath(), 'utf8')); return c && typeof c === 'object' ? c : {}; } catch { return {}; } }
export function saveConfig(cfg) {
  const f = configPath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch { /* systèmes sans droits unix */ }
}
const mask = (k) => (k ? k.slice(0, 3) + '…' + k.slice(-3) : '(aucune)');

// Question dans le terminal ; `hidden` n'affiche pas la saisie (clé secrète). Entrée redirigée : une ligne par question.
let pipedLines = null;
async function ask(question, { hidden = false } = {}) {
  process.stdout.write(question);
  if (!process.stdin.isTTY) {
    if (!pipedLines) { const chunks = []; for await (const c of process.stdin) chunks.push(c); pipedLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/); }
    process.stdout.write('\n');
    return (pipedLines.shift() || '').trim();
  }
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (c === '\r' || c === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); return resolve(s.trim()); }
        if (c === '\u007f' || c === '\b') { if (s) { s = s.slice(0, -1); if (!hidden) process.stdout.write('\b \b'); } continue; }
        s += c; if (!hidden) process.stdout.write(c);
      }
    };
    process.stdin.on('data', onData);
  });
}
const yes = (a, def) => (a === '' ? def : /^(o|oui|y|yes|1)$/i.test(a));

async function setup() {
  const cur = loadConfig();
  console.log(`Réglages enregistrés dans ${configPath()} (lisible par toi seul). Entrée = garder la valeur actuelle.\n`);
  const key = await ask(`Clé API OpenRouter pour la reconnaissance vocale [${mask(cur.openrouterKey)}] (vide = inchangée, « -» = effacer) : `, { hidden: true });
  const browser = await ask(`Navigateur connecté à YouTube pour les cookies (chrome, safari, firefox, brave, edge… ; « -» = aucun) [${cur.cookiesBrowser || 'aucun'}] : `);
  const audio = await ask(`Transcrire par l'audio les vidéos sans sous-titre ? (o/n) [${cur.audio ? 'o' : 'n'}] : `);
  const budget = await ask(`Plafond de dépense par lancement, en $ [${cur.budget ?? 2}] : `);
  const next = { ...cur };
  if (key === '-') delete next.openrouterKey; else if (key) { next.openrouterKey = key; next.provider = 'openrouter'; }
  if (browser === '-') delete next.cookiesBrowser; else if (browser) next.cookiesBrowser = browser;
  if (audio) next.audio = yes(audio, !!cur.audio);
  if (budget && Number(budget) > 0) next.budget = Number(budget);
  if (next.audio && !next.openrouterKey && !next.mistralKey && !process.env.OPENROUTER_API_KEY && !process.env.MISTRAL_API_KEY) console.log('\n⚠ L\'audio est activé mais aucune clé n\'est enregistrée : relance « setup » pour saisir ta clé OpenRouter.');
  saveConfig(next);
  console.log(`\n✓ Enregistré. Il suffit maintenant de copier les liens dans l'extension puis de lancer : npm run transcribe`);
  return 0;
}

// Presse-papiers (quand rien n'est redirigé ni donné en fichier)
async function readClipboard() {
  const cands = process.env.XBS_CLIPBOARD_CMD ? [[process.env.XBS_CLIPBOARD_CMD, []]]
    : process.platform === 'darwin' ? [['pbpaste', []]]
    : process.platform === 'win32' ? [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw']]]
    : [['wl-paste', ['--no-newline']], ['xclip', ['-o', '-selection', 'clipboard']], ['xsel', ['-ob']]];
  for (const [cmd, args] of cands) { const r = await run(cmd, args, { timeout: 10_000 }); if (r.ok) return r.stdout; }
  return '';
}

function parseArgs(argv, cfg = {}) {
  const provider = cfg.provider === 'mistral' ? 'mistral' : 'openrouter';
  const o = { cmd: '', provider, eu: !!cfg.eu, out: 'transcripts', audio: !!cfg.audio, model: cfg.model || (provider === 'mistral' ? 'voxtral-mini-latest' : 'mistralai/voxtral-mini-transcribe-3-0'), price: cfg.price ?? (provider === 'mistral' ? 0.003 : 0.0035), budget: cfg.budget ?? 2, lang: cfg.lang || '', subLangs: cfg.subLangs || 'fr-orig,en-orig,fr,en', limit: 0, sleep: cfg.sleep ?? 3, cookiesBrowser: cfg.cookiesBrowser || '', cookies: '', dry: false, file: '', help: false, reveal: process.platform === 'darwin' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--audio') o.audio = true;
    else if (a === '--no-audio') o.audio = false;
    else if (a === '--no-reveal') o.reveal = false;
    else if (a === '--eu') o.eu = true;
    else if (a === '--provider') { o.provider = v() === 'mistral' ? 'mistral' : 'openrouter'; if (!argv.includes('--model') && !cfg.model) o.model = o.provider === 'mistral' ? 'voxtral-mini-latest' : 'mistralai/voxtral-mini-transcribe-3-0'; if (!argv.includes('--price') && cfg.price == null) o.price = o.provider === 'mistral' ? 0.003 : 0.0035; }
    else if (a === '--dry-run') o.dry = true;
    else if (a === '--out') o.out = v();
    else if (a === '--model') o.model = v();
    else if (a === '--price') o.price = Number(v());
    else if (a === '--budget') o.budget = Number(v());
    else if (a === '--lang') o.lang = v();
    else if (a === '--sub-langs') o.subLangs = v();
    else if (a === '--limit') o.limit = Number(v());
    else if (a === '--sleep') o.sleep = Number(v());
    else if (a === '--cookies-from-browser') o.cookiesBrowser = v();
    else if (a === '--cookies') o.cookies = v();
    else if (!a.startsWith('--') && !o.cmd && !o.file && (a === 'setup' || a === 'config')) o.cmd = a;
    else if (!a.startsWith('--') && !o.file) o.file = a;
    else { console.error(`Option inconnue : ${a}\n`); o.help = true; }
  }
  return o;
}

async function readInput(file) {
  if (file) return fs.readFileSync(file, 'utf8');
  if (process.stdin.isTTY) return ''; // presse-papiers : voir main
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// Un morceau d'audio -> JSON du service. OpenRouter : format de la requête à confirmer (JSON base64 ou multipart) : les deux sont essayés.
let sttMode = ''; // format qui a fonctionné ('json' | 'form'), mémorisé pour la suite du lancement
async function sttRequest(o, key, file, name) {
  const bytes = fs.readFileSync(file);
  const openrouter = o.provider === 'openrouter';
  const base = (openrouter ? (process.env.OPENROUTER_API_BASE || (o.eu ? 'https://eu.openrouter.ai/api/v1' : 'https://openrouter.ai/api/v1')) : (process.env.MISTRAL_API_BASE || 'https://api.mistral.ai') + '/v1').replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${key}` };
  const asForm = () => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'audio/mpeg' }), name);
    form.append('model', o.model);
    form.append('timestamp_granularities', 'segment');
    if (openrouter) form.append('response_format', 'verbose_json');
    if (o.lang) form.append('language', o.lang);
    return fetch(`${base}/audio/transcriptions`, { method: 'POST', headers, body: form });
  };
  const asJson = () => fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ model: o.model, input_audio: { data: bytes.toString('base64'), format: 'mp3' }, ...(o.lang ? { language: o.lang } : {}) }) });
  let res;
  if (!openrouter) res = await asForm();
  else if (sttMode === 'form') res = await asForm();
  else {
    res = await asJson();
    if (sttMode !== 'json' && [400, 415, 422].includes(res.status)) { const second = await asForm(); if (second.ok) { sttMode = 'form'; res = second; } }
    else if (res.ok) sttMode = 'json';
  }
  if (!res.ok) throw new Error(`${openrouter ? 'OpenRouter' : 'Mistral'} : HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

async function transcribeAudio(o, v, tmp, ffmpeg, ytdlp, cookieArgs, key) {
  const url = `https://www.youtube.com/watch?v=${v.id}`;
  const dl = await run(ytdlp, [...cookieArgs, '--no-playlist', '-f', 'bestaudio[abr<=64]/worstaudio/bestaudio', '-x', '--audio-format', 'mp3', '--audio-quality', '9', '-o', path.join(tmp, '%(id)s.%(ext)s'), url]);
  if (!dl.ok) return { why: 'audio : ' + (dl.stderr.trim().split('\n').pop() || 'échec yt-dlp'), blocked: /Sign in to confirm|429|bot/i.test(dl.stderr) };
  const audio = path.join(tmp, `${v.id}.mp3`);
  if (!fs.existsSync(audio)) return { why: 'audio : fichier introuvable après le téléchargement' };
  const SPLIT = 600;
  const cut = await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', audio, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'segment', '-segment_time', String(SPLIT), '-reset_timestamps', '1', path.join(tmp, `${v.id}_%03d.mp3`)]);
  const parts = fs.readdirSync(tmp).filter((f) => f.startsWith(v.id + '_') && f.endsWith('.mp3')).sort();
  if (!cut.ok || !parts.length) return { why: 'ffmpeg : découpage impossible' + (cut.missing ? ' (ffmpeg introuvable)' : '') };
  const segments = [];
  let lang = '', seconds = 0;
  for (let k = 0; k < parts.length; k++) {
    const file = path.join(tmp, parts[k]);
    const dur = Math.min(SPLIT, Math.max(1, (fs.statSync(file).size * 8) / 32000)); // durée d'un morceau à 32 kbit/s
    let json;
    try { json = await sttRequest(o, key, file, parts[k]); } catch (e) { return { why: e.message }; }
    lang = lang || json.language || '';
    segments.push(...mistralSegments(json, k * SPLIT, dur));
    seconds += dur;
  }
  return { segments, lang, seconds: Math.round(seconds) };
}

export async function main(argv) {
  const cfg = loadConfig();
  const o = parseArgs(argv, cfg);
  if (o.help) { console.log(HELP); return 0; }
  if (o.cmd === 'setup') return setup();
  if (o.cmd === 'config') { console.log(`Fichier : ${configPath()}\n` + JSON.stringify({ ...cfg, ...(cfg.mistralKey ? { mistralKey: mask(cfg.mistralKey) } : {}), ...(cfg.openrouterKey ? { openrouterKey: mask(cfg.openrouterKey) } : {}) }, null, 2)); return 0; }
  const sttKey = o.provider === 'mistral' ? (process.env.MISTRAL_API_KEY || cfg.mistralKey || '') : (process.env.OPENROUTER_API_KEY || cfg.openrouterKey || '');
  let text = await readInput(o.file);
  if (!text.trim() && !o.file) { console.log('Lecture des liens dans le presse-papiers…'); text = await readClipboard(); }
  let videos = parseInput(text);
  if (!videos.length) { console.error('Aucun lien YouTube trouvé. Copie d’abord les liens dans l’extension (⋯ › Copier les liens sans transcription), puis relance : npm run transcribe\n'); return 1; }
  fs.mkdirSync(o.out, { recursive: true });
  const resultsFile = path.join(o.out, 'results.json');
  let results = { format: 'xbs-transcripts/1', items: [], failed: [] };
  try { const old = JSON.parse(fs.readFileSync(resultsFile, 'utf8')); if (old?.format === results.format) results = { ...old, failed: [] }; } catch { /* premier passage */ }
  const done = new Set(results.items.map((i) => i.videoId));
  const todo = videos.filter((v) => !done.has(v.id));
  const batch = o.limit > 0 ? todo.slice(0, o.limit) : todo;
  console.log(`${videos.length} vidéo(s) en entrée, ${videos.length - todo.length} déjà faite(s) (reprise), ${batch.length} à traiter.`);
  if (o.dry) {
    console.log(`Étape A (sous-titres YouTube) : gratuite.`);
    console.log(o.audio ? `Étape B (audio + ${o.model} via ${o.provider === 'mistral' ? 'Mistral' : 'OpenRouter'}) : au plus ≈ ${estimateAudioUsd(batch, o.price).toFixed(2)} $ si AUCUNE vidéo n'avait de sous-titres (${o.price} $/min ; durée de 30 min supposée si inconnue).` : 'Étape B (audio) désactivée : ajoute --audio pour traiter aussi les vidéos sans sous-titres.');
    return 0;
  }
  const ytdlp = process.env.XBS_YTDLP || 'yt-dlp', ffmpeg = process.env.XBS_FFMPEG || 'ffmpeg';
  const probe = await run(ytdlp, ['--version'], { timeout: 20_000 });
  if (!probe.ok) { console.error(probe.missing ? '✗ yt-dlp est introuvable. Installe-le : brew install yt-dlp ffmpeg (macOS) ou pipx install yt-dlp.' : '✗ yt-dlp ne démarre pas : ' + probe.stderr.trim()); return 1; }
  if (o.audio) {
    if (!sttKey) { console.error(`✗ L'audio demande une clé ${o.provider === 'mistral' ? 'Mistral' : 'OpenRouter'} : lance « npm run transcribe -- setup » pour l'enregistrer, ou utilise --no-audio.`); return 1; }
    if (!(await run(ffmpeg, ['-version'], { timeout: 20_000 })).ok) { console.error('✗ ffmpeg est introuvable (nécessaire pour --audio). Installe-le : brew install ffmpeg.'); return 1; }
  }
  const cookieArgs = o.cookiesBrowser ? ['--cookies-from-browser', o.cookiesBrowser] : o.cookies ? ['--cookies', o.cookies] : [];
  const langs = o.subLangs.split(',').map((x) => x.trim()).filter(Boolean);
  let spent = 0, nSubs = 0, nStt = 0, blocked = 0;
  const save = () => fs.writeFileSync(resultsFile, JSON.stringify(results));
  for (let i = 0; i < batch.length; i++) {
    const v = batch[i];
    const label = `[${i + 1}/${batch.length}] ${v.id}${v.title ? ' — ' + v.title.slice(0, 60) : ''}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbs-tr-'));
    try {
      const url = `https://www.youtube.com/watch?v=${v.id}`;
      // A. sous-titres YouTube
      const subs = await run(ytdlp, [...cookieArgs, '--no-playlist', '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', langs.join(','), '--sub-format', 'json3', '--sleep-subtitles', '1', '-o', path.join(tmp, '%(id)s.%(ext)s'), url]);
      const pick = pickSubtitle(fs.readdirSync(tmp), v.id, langs);
      let segments = pick ? parseJson3(JSON.parse(fs.readFileSync(path.join(tmp, pick.f), 'utf8'))) : [];
      if (segments.length) {
        results.items.push({ id: 'yt:' + v.id, videoId: v.id, source: 'subs', lang: pick.lang, segments }); nSubs++; blocked = 0;
        console.log(`${label} : sous-titres ${pick.lang} (${segments.length} segments)`);
      } else {
        const bot = /Sign in to confirm|HTTP Error 429|bot/i.test(subs.stderr);
        // B. audio + reconnaissance vocale
        if (o.audio && !bot) {
          const est = ((v.seconds || 1800) / 60) * o.price;
          if (spent + est > o.budget) { console.log(`${label} : plafond de ${o.budget} $ atteint : arrêt de l'audio.`); results.failed.push({ videoId: v.id, why: 'plafond' }); continue; }
          const r = await transcribeAudio(o, v, tmp, ffmpeg, ytdlp, cookieArgs, sttKey);
          if (r.segments?.length) {
            spent += ((r.seconds || v.seconds || 1800) / 60) * o.price;
            results.items.push({ id: 'yt:' + v.id, videoId: v.id, source: 'stt', lang: r.lang, model: o.model, segments: r.segments }); nStt++; blocked = 0;
            console.log(`${label} : reconnaissance vocale (${r.segments.length} segments, ≈ ${spent.toFixed(3)} $ au total)`);
          } else { console.log(`${label} : ✗ ${r.why || 'aucune parole reconnue'}`); results.failed.push({ videoId: v.id, why: r.why || 'vide' }); if (r.blocked) blocked++; }
        } else {
          const why = bot ? 'YouTube demande une vérification anti-robot' : 'aucun sous-titre' + (o.audio ? '' : ' (essaie --audio)');
          console.log(`${label} : ✗ ${why}`); results.failed.push({ videoId: v.id, why }); if (bot) blocked++;
        }
      }
      save();
      if (blocked >= 3) { console.error('\n✗ YouTube bloque les requêtes (3 refus de suite). Arrêt pour éviter un blocage durable. Relance plus tard (la reprise est automatique), ou ajoute --cookies-from-browser chrome (navigateur connecté à YouTube).'); break; }
    } catch (e) { console.log(`${label} : ✗ ${e.message}`); results.failed.push({ videoId: v.id, why: String(e.message) }); }
    finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    if (i < batch.length - 1 && o.sleep > 0) await sleep(o.sleep);
  }
  save();
  console.log(`\nTerminé : ${nSubs} par sous-titres, ${nStt} par reconnaissance vocale (≈ ${spent.toFixed(3)} $), ${results.failed.length} sans résultat.`);
  console.log(`Fichier à importer dans l'extension (⋯ › Importer des transcriptions…) : ${path.resolve(resultsFile)}`);
  if (o.reveal && results.items.length) await run('open', ['-R', path.resolve(resultsFile)], { timeout: 10_000 }); // macOS : le montre dans le Finder
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error('✗', e.message || e); process.exit(1); });
