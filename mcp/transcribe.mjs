#!/usr/bin/env node
// Transcrit en local les vidéos YouTube dont l'extension n'a pas pu récupérer la transcription.
//
//   1. Dans l'extension : ⋯ › « Copier les liens des vidéos sans transcription » (selon ta recherche / tes comptes affichés)
//   2. pbpaste | node mcp/transcribe.mjs                      (macOS ; sous Linux : xclip -o | …, sous Windows : un fichier .txt)
//      node mcp/transcribe.mjs liens.txt --audio              (en plus : audio + reconnaissance vocale Mistral quand il n'y a aucun sous-titre)
//   3. Dans l'extension : ⋯ › « Importer des transcriptions… » et choisir le fichier créé (transcripts/results.json)
//
// Étape A (gratuite) : yt-dlp récupère les sous-titres YouTube (y compris automatiques).
// Étape B (--audio, payante, clé MISTRAL_API_KEY) : yt-dlp récupère l'audio, ffmpeg le découpe, Mistral (Voxtral) le transcrit avec horodatage.
// Aucune dépendance npm : Node 18+, yt-dlp et ffmpeg installés (brew install yt-dlp ffmpeg).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJson3 } from '../src/lib/transcript.js';

const HELP = `Usage : node mcp/transcribe.mjs [liens.txt] [options]   (sans fichier : lit l'entrée standard)

Entrée : une vidéo par ligne (lien ou identifiant YouTube) ; colonnes optionnelles séparées par une tabulation : durée en secondes, titre.
         C'est exactement ce que copie le bouton de l'extension.

Options
  --out <dossier>            dossier de sortie (défaut : ./transcripts) ; le fichier à importer est results.json
  --audio                    si aucun sous-titre : audio + reconnaissance vocale Mistral (clé MISTRAL_API_KEY requise)
  --model <nom>              modèle Mistral (défaut : voxtral-mini-latest)
  --price <$/min>            prix d'une minute d'audio, pour l'estimation et le plafond (défaut : 0.003 ; vérifie la grille de Mistral)
  --budget <$>               plafond de dépense pour la reconnaissance vocale (défaut : 2)
  --lang <code>              langue de l'audio (fr, en…) ; défaut : détection automatique
  --sub-langs <liste>        langues de sous-titres essayées, par ordre (défaut : fr-orig,en-orig,fr,en)
  --limit <n>                ne traiter que n vidéos (pour essayer)
  --sleep <secondes>         pause entre deux vidéos (défaut : 3) : ménage YouTube
  --cookies-from-browser <b> utilise les cookies d'un navigateur connecté à YouTube (chrome, firefox, safari, brave, edge…) : souvent
                             nécessaire quand YouTube répond « Sign in to confirm you're not a bot »
  --cookies <fichier>        fichier cookies.txt
  --dry-run                  n'appelle rien : compte les vidéos et estime le coût de l'audio
  --help

Variables : MISTRAL_API_KEY, XBS_YTDLP / XBS_FFMPEG (chemins des programmes), MISTRAL_API_BASE`;

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

// Réponse de Mistral (/v1/audio/transcriptions) -> segments { t, text } décalés de `offset` secondes (morceau n° k d'un long audio)
export function mistralSegments(json, offset = 0) {
  const segs = Array.isArray(json?.segments) ? json.segments : [];
  const out = segs.map((s) => ({ t: Math.round(offset + (Number(s.start) || 0)), text: String(s.text || '').replace(/\s+/g, ' ').trim() })).filter((s) => s.text);
  if (out.length) return out;
  const text = String(json?.text || '').replace(/\s+/g, ' ').trim();
  return text ? [{ t: Math.round(offset), text }] : [];
}

export const estimateAudioUsd = (videos, price) => videos.reduce((n, v) => n + ((v.seconds || 1800) / 60) * price, 0);

// ---------- exécution ----------
const run = (cmd, args, { timeout = 30 * 60_000 } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, code: err?.code, stdout: String(stdout), stderr: String(stderr), missing: err?.code === 'ENOENT' }));
});
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

function parseArgs(argv) {
  const o = { out: 'transcripts', audio: false, model: 'voxtral-mini-latest', price: 0.003, budget: 2, lang: '', subLangs: 'fr-orig,en-orig,fr,en', limit: 0, sleep: 3, cookiesBrowser: '', cookies: '', dry: false, file: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--audio') o.audio = true;
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
    else if (!a.startsWith('--') && !o.file) o.file = a;
    else { console.error(`Option inconnue : ${a}\n`); o.help = true; }
  }
  return o;
}

async function readInput(file) {
  if (file) return fs.readFileSync(file, 'utf8');
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function transcribeAudio(o, v, tmp, ffmpeg, ytdlp, cookieArgs) {
  const url = `https://www.youtube.com/watch?v=${v.id}`;
  const dl = await run(ytdlp, [...cookieArgs, '--no-playlist', '-f', 'bestaudio[abr<=64]/worstaudio/bestaudio', '-x', '--audio-format', 'mp3', '--audio-quality', '9', '-o', path.join(tmp, '%(id)s.%(ext)s'), url]);
  if (!dl.ok) return { why: 'audio : ' + (dl.stderr.trim().split('\n').pop() || 'échec yt-dlp'), blocked: /Sign in to confirm|429|bot/i.test(dl.stderr) };
  const audio = path.join(tmp, `${v.id}.mp3`);
  if (!fs.existsSync(audio)) return { why: 'audio : fichier introuvable après le téléchargement' };
  const SPLIT = 600;
  const cut = await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', audio, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'segment', '-segment_time', String(SPLIT), '-reset_timestamps', '1', path.join(tmp, `${v.id}_%03d.mp3`)]);
  const parts = fs.readdirSync(tmp).filter((f) => f.startsWith(v.id + '_') && f.endsWith('.mp3')).sort();
  if (!cut.ok || !parts.length) return { why: 'ffmpeg : découpage impossible' + (cut.missing ? ' (ffmpeg introuvable)' : '') };
  const base = (process.env.MISTRAL_API_BASE || 'https://api.mistral.ai').replace(/\/+$/, '');
  const segments = [];
  let lang = '';
  for (let k = 0; k < parts.length; k++) {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(path.join(tmp, parts[k]))], { type: 'audio/mpeg' }), parts[k]);
    form.append('model', o.model);
    form.append('timestamp_granularities', 'segment');
    if (o.lang) form.append('language', o.lang);
    const res = await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${process.env.MISTRAL_API_KEY}` }, body: form });
    if (!res.ok) return { why: `Mistral : HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}` };
    const json = await res.json();
    lang = lang || json.language || '';
    segments.push(...mistralSegments(json, k * SPLIT));
  }
  return { segments, lang, seconds: parts.length * SPLIT };
}

export async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) { console.log(HELP); return 0; }
  const text = await readInput(o.file);
  let videos = parseInput(text);
  if (!videos.length) { console.error('Aucune vidéo YouTube dans l’entrée. Copie d’abord les liens depuis l’extension (⋯ › Copier les liens des vidéos sans transcription), puis : pbpaste | node mcp/transcribe.mjs\n'); return 1; }
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
    console.log(o.audio ? `Étape B (audio + ${o.model}) : au plus ≈ ${estimateAudioUsd(batch, o.price).toFixed(2)} $ si AUCUNE vidéo n'avait de sous-titres (${o.price} $/min ; durée de 30 min supposée si inconnue).` : 'Étape B (audio) désactivée : ajoute --audio pour traiter aussi les vidéos sans sous-titres.');
    return 0;
  }
  const ytdlp = process.env.XBS_YTDLP || 'yt-dlp', ffmpeg = process.env.XBS_FFMPEG || 'ffmpeg';
  const probe = await run(ytdlp, ['--version'], { timeout: 20_000 });
  if (!probe.ok) { console.error(probe.missing ? '✗ yt-dlp est introuvable. Installe-le : brew install yt-dlp ffmpeg (macOS) ou pipx install yt-dlp.' : '✗ yt-dlp ne démarre pas : ' + probe.stderr.trim()); return 1; }
  if (o.audio) {
    if (!process.env.MISTRAL_API_KEY) { console.error('✗ --audio demande une clé Mistral : export MISTRAL_API_KEY=… (https://console.mistral.ai).'); return 1; }
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
          const r = await transcribeAudio(o, v, tmp, ffmpeg, ytdlp, cookieArgs);
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
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error('✗', e.message || e); process.exit(1); });
