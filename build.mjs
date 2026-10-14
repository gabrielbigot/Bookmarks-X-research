import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readdirSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/ort', { recursive: true });

const BUILD = new Date().toISOString().slice(0, 16).replace('T', ' ');
const common = { define: { __BUILD__: JSON.stringify(BUILD) }, bundle: true, minify: false, sourcemap: false, target: 'chrome120', logLevel: 'info' };
await build({ ...common, entryPoints: { background: 'src/background.js', panel: 'src/panel.js', offscreen: 'src/offscreen.js', stats: 'src/stats.js' }, format: 'esm', outdir: 'dist' });
// Scripts de page : pas de modules ES.
await build({ ...common, entryPoints: { inject: 'src/inject.js', content: 'src/content.js', 'theme-boot': 'src/theme-boot.js' }, format: 'iife', outdir: 'dist' });

for (const f of ['manifest.json', 'panel.html', 'panel.css', 'offscreen.html', 'stats.html', 'stats.css']) cpSync(`src/${f}`, `dist/${f}`);
// Runtime WASM d'ONNX : chargé localement (le CSP des extensions interdit le code distant).
const ort = 'node_modules/onnxruntime-web/dist';
for (const f of readdirSync(ort)) if (/^ort-wasm-simd-threaded(\.(jsep|jspi|asyncify))?\.(mjs|wasm)$/.test(f)) cpSync(`${ort}/${f}`, `dist/ort/${f}`);
console.log('OK -> dist/');
