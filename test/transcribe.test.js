import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ytId, parseInput, pickSubtitle, mistralSegments, estimateAudioUsd } from '../mcp/transcribe.mjs';

test('parseInput : liens et identifiants YouTube, colonnes de l’extension, sans doublon ni intrus', () => {
  const v = parseInput([
    'https://www.youtube.com/watch?v=aaaaaaaaaaa\t2415\tTitre avec | barre',
    'https://youtu.be/bbbbbbbbbbb?t=3',
    'ccccccccccc',
    'https://www.youtube.com/watch?v=aaaaaaaaaaa\t1\tdoublon',
    'https://example.com/pas-youtube',
    '; rm -rf /',
    '',
  ].join('\n'));
  assert.deepEqual(v.map((x) => x.id), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
  assert.equal(v[0].seconds, 2415); assert.equal(v[0].title, 'Titre avec | barre'); assert.equal(v[1].seconds, 0);
  assert.equal(ytId('https://www.youtube.com/shorts/ddddddddddd'), 'ddddddddddd');
});

test('pickSubtitle : langue d’origine d’abord ; mistralSegments : décalage des morceaux', () => {
  const files = ['aaaaaaaaaaa.en.json3', 'aaaaaaaaaaa.fr-orig.json3', 'bbbbbbbbbbb.fr.json3', 'aaaaaaaaaaa.de.json3'];
  assert.equal(pickSubtitle(files, 'aaaaaaaaaaa', ['fr-orig', 'en-orig', 'fr', 'en']).lang, 'fr-orig');
  assert.equal(pickSubtitle(files, 'aaaaaaaaaaa', ['fr', 'en']).lang, 'en');
  assert.equal(pickSubtitle(files, 'zzzzzzzzzzz', ['fr']), null);
  assert.deepEqual(mistralSegments({ segments: [{ start: 1.2, text: ' Bonjour  à tous ' }, { start: 5, text: '' }] }, 600), [{ t: 601, text: 'Bonjour à tous' }]);
  assert.deepEqual(mistralSegments({ text: 'Tout le texte' }, 1200), [{ t: 1200, text: 'Tout le texte' }]);
  assert.deepEqual(mistralSegments({}), []);
  assert.ok(Math.abs(estimateAudioUsd([{ seconds: 600 }, { seconds: 0 }], 0.003) - (0.03 + 0.09)) < 1e-9);
});

// Faux yt-dlp / ffmpeg (scripts Node) et faux serveur Mistral : tout le pipeline sans réseau
function fakeTools(dir) {
  const ytdlp = path.join(dir, 'yt-dlp');
  fs.writeFileSync(ytdlp, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
if (process.env.XBS_FAKE_LOG) fs.appendFileSync(process.env.XBS_FAKE_LOG, JSON.stringify(a) + '\\n');
if (a[0] === '--version') { console.log('2026.10.01'); process.exit(0); }
const url = a[a.length - 1], id = url.split('v=')[1], tpl = a[a.indexOf('-o') + 1], dir = path.dirname(tpl);
if (id.startsWith('bbbb')) { console.error('ERROR: Sign in to confirm you\\'re not a bot'); process.exit(1); }
if (a.includes('--skip-download')) {
  if (id.startsWith('aaaa')) fs.writeFileSync(path.join(dir, id + '.fr-orig.json3'), JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: 'Bonjour ' }, { utf8: 'à tous' }] }, { tStartMs: 9000, segs: [{ utf8: 'Deuxième phrase' }] }] }));
  process.exit(0);
}
if (a.includes('-x')) { fs.writeFileSync(path.join(dir, id + '.mp3'), 'AUDIO'); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
  const ffmpeg = path.join(dir, 'ffmpeg');
  fs.writeFileSync(ffmpeg, `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === '-version') { console.log('ffmpeg'); process.exit(0); }
const out = a[a.length - 1];
for (let k = 0; k < 2; k++) fs.writeFileSync(out.replace('%03d', String(k).padStart(3, '0')), 'PART' + k);
`, { mode: 0o755 });
  return { ytdlp, ffmpeg };
}
const startMistral = () => new Promise((res) => {
  const calls = [];
  const srv = http.createServer((req, rsp) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      calls.push({ auth: req.headers.authorization, model: /name="model"\r\n\r\n([^\r]+)/.exec(body)?.[1], gran: /name="timestamp_granularities"\r\n\r\n([^\r]+)/.exec(body)?.[1], part: /PART(\d)/.exec(body)?.[1] });
      rsp.writeHead(200, { 'content-type': 'application/json' });
      rsp.end(JSON.stringify({ language: 'fr', segments: [{ start: 2, end: 6, text: 'Voix reconnue ' + calls.length }] }));
    });
  }).listen(0, '127.0.0.1', () => res({ srv, calls, port: srv.address().port }));
});
const runCli = (args, env, input) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['mcp/transcribe.mjs', '--no-reveal', ...args], { env: { ...process.env, XBS_CONFIG: path.join(os.tmpdir(), 'xbs-config-inexistante.json'), MISTRAL_API_KEY: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => resolve({ code, out, err }));
  p.stdin.end(input || '');
});

test('transcribe.mjs : sous-titres, puis audio + Mistral, reprise, plafond et arrêt anti-robot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbs-trtest-'));
  const { ytdlp, ffmpeg } = fakeTools(dir);
  const m = await startMistral();
  const out = path.join(dir, 'out');
  const env = { XBS_YTDLP: ytdlp, XBS_FFMPEG: ffmpeg, MISTRAL_API_KEY: 'cle-test', MISTRAL_API_BASE: `http://127.0.0.1:${m.port}` };
  const input = ['https://www.youtube.com/watch?v=aaaaaaaaaaa\t600\tAvec sous-titres', 'https://www.youtube.com/watch?v=cccccccccc1\t1200\tSans sous-titres'].join('\n');
  try {
    // estimation : rien n'est appelé
    const dry = await runCli(['--dry-run', '--audio', '--out', out], env, input);
    assert.equal(dry.code, 0); assert.match(dry.out, /2 vidéo\(s\) en entrée/); assert.match(dry.out, /≈ 0\.0\d \$/); assert.equal(m.calls.length, 0);
    // sans --audio : la vidéo sans sous-titres est signalée, rien n'est envoyé à Mistral
    const a = await runCli(['--sleep', '0', '--out', out], env, input);
    assert.equal(a.code, 0, a.err); assert.match(a.out, /aaaaaaaaaaa.*sous-titres fr-orig \(2 segments\)/); assert.match(a.out, /cccccccccc1.*aucun sous-titre \(essaie --audio\)/); assert.equal(m.calls.length, 0);
    let res = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
    assert.equal(res.format, 'xbs-transcripts/1'); assert.deepEqual(res.items.map((i) => [i.id, i.source]), [['yt:aaaaaaaaaaa', 'subs']]);
    assert.deepEqual(res.items[0].segments, [{ t: 1, text: 'Bonjour à tous' }, { t: 9, text: 'Deuxième phrase' }]);
    // avec --audio : reprise (la 1re n'est pas refaite), l'autre passe par Mistral, 2 morceaux de 10 min décalés
    const b = await runCli(['--sleep', '0', '--audio', '--out', out], env, input);
    assert.equal(b.code, 0, b.err); assert.match(b.out, /1 déjà faite/); assert.match(b.out, /cccccccccc1.*reconnaissance vocale \(2 segments/);
    assert.equal(m.calls.length, 2); assert.equal(m.calls[0].auth, 'Bearer cle-test'); assert.equal(m.calls[0].model, 'voxtral-mini-latest'); assert.equal(m.calls[0].gran, 'segment');
    res = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
    const stt = res.items.find((i) => i.source === 'stt');
    assert.deepEqual(stt.segments.map((s) => s.t), [2, 602]); assert.equal(stt.model, 'voxtral-mini-latest'); assert.equal(stt.lang, 'fr');
    assert.equal(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('xbs-tr-')).length, 0, 'fichiers temporaires supprimés');
    // plafond : l'audio est refusé quand l'estimation dépasse le budget
    m.calls.length = 0;
    const c = await runCli(['--sleep', '0', '--audio', '--budget', '0.001', '--out', path.join(dir, 'out2')], env, 'https://www.youtube.com/watch?v=dddddddddd1\t3600\tLong');
    assert.match(c.out, /plafond de 0\.001 \$ atteint/); assert.equal(m.calls.length, 0);
    // anti-robot : arrêt après 3 refus de suite
    const d = await runCli(['--sleep', '0', '--out', path.join(dir, 'out3')], env, ['bbbbbbbbbb1', 'bbbbbbbbbb2', 'bbbbbbbbbb3', 'bbbbbbbbbb4', 'bbbbbbbbbb5'].join('\n'));
    assert.match(d.err, /YouTube bloque/); assert.equal((d.out.match(/anti-robot/g) || []).length, 3);
    // clé manquante / entrée vide
    assert.match((await runCli(['--audio', '--out', out], { ...env, MISTRAL_API_KEY: '' }, input)).err, /clé Mistral/);
    assert.equal((await runCli(['--out', out], env, 'rien d’utile')).code, 1);
  } finally { m.srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('transcribe.mjs : yt-dlp absent -> message d’installation', async () => {
  const r = await runCli(['--out', fs.mkdtempSync(path.join(os.tmpdir(), 'xbs-trt2-'))], { XBS_YTDLP: '/nonexistent/yt-dlp' }, 'aaaaaaaaaaa');
  assert.equal(r.code, 1); assert.match(r.err, /yt-dlp est introuvable/);
});

test('réglages enregistrés (setup), presse-papiers, options par défaut : plus rien à retaper', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbs-trcfg-'));
  const { ytdlp, ffmpeg } = fakeTools(dir);
  const m = await startMistral();
  const cfgFile = path.join(dir, 'cfg', 'transcribe.json');
  const clip = path.join(dir, 'clip');
  fs.writeFileSync(clip, `#!${process.execPath}\nconsole.log('https://www.youtube.com/watch?v=aaaaaaaaaaa\\t600\\tAvec sous-titres\\nhttps://www.youtube.com/watch?v=cccccccccc1\\t1200\\tSans sous-titres');\n`, { mode: 0o755 });
  const log = path.join(dir, 'calls.log');
  const env = { XBS_CONFIG: cfgFile, XBS_YTDLP: ytdlp, XBS_FFMPEG: ffmpeg, MISTRAL_API_BASE: `http://127.0.0.1:${m.port}`, XBS_CLIPBOARD_CMD: clip, XBS_FAKE_LOG: log };
  try {
    // setup : questions lues ligne par ligne quand l'entrée est redirigée
    const s = await runCli(['setup'], env, 'cle-enregistree\nchrome\no\n3\n');
    assert.equal(s.code, 0, s.err); assert.match(s.out, /Enregistré/);
    const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.deepEqual(saved, { mistralKey: 'cle-enregistree', cookiesBrowser: 'chrome', audio: true, budget: 3 });
    if (process.platform !== 'win32') assert.equal(fs.statSync(cfgFile).mode & 0o777, 0o600, 'fichier lisible par toi seul');
    const c = await runCli(['config'], env);
    assert.match(c.out, /cle…ree/); assert.ok(!c.out.includes('cle-enregistree'), 'la clé est masquée');
    // lancement sans argument : liens lus dans le presse-papiers, clé / cookies / audio repris de la config
    const r = await runCli(['--sleep', '0', '--out', path.join(dir, 'out')], env, '');
    assert.equal(r.code, 0, r.err); assert.match(r.out, /presse-papiers/); assert.match(r.out, /aaaaaaaaaaa.*sous-titres/); assert.match(r.out, /cccccccccc1.*reconnaissance vocale/);
    assert.equal(m.calls[0].auth, 'Bearer cle-enregistree');
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(calls.some((a) => a.includes('--cookies-from-browser') && a[a.indexOf('--cookies-from-browser') + 1] === 'chrome'), 'cookies du navigateur enregistré');
    // --no-audio l'emporte sur la config
    m.calls.length = 0;
    await runCli(['--sleep', '0', '--no-audio', '--out', path.join(dir, 'out2')], env, '');
    assert.equal(m.calls.length, 0);
    // « - » efface la clé
    await runCli(['setup'], env, '-\n\n\n\n');
    assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).mistralKey, undefined);
  } finally { m.srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
