// Banc d'essai des modèles d'extraction (voir lib/extract.js) : mêmes extraits, même consigne, même vérification des citations que l'outil MCP.
import { getSettings, setSettings } from './lib/settings.js';
import { getTweets, getTranscripts } from './lib/db.js';
import { chatFull } from './lib/llm.js';
import { selectPassages, passagesText, extractMessages, parseExtraction } from './lib/extract.js';
import { normalizeText } from './lib/search.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const flat = (s) => normalizeText(String(s || '')).replace(/[^a-z0-9]+/g, ' ').trim();
const perM = (v) => (v == null ? null : Number(v) < 0.01 ? Number(v) * 1e6 : Number(v)); // OpenRouter : prix par token
let catalog = [];

async function loadCatalog(llm) {
  if (!/openrouter\.ai/i.test(llm.baseUrl)) return [];
  const r = await fetch(new URL(llm.baseUrl).origin + '/api/v1/models');
  return (await r.json()).data || [];
}
// « deepseek v4 flash » -> le modèle du catalogue dont l'identifiant ou le nom contient tous les mots (le plus court, donc le plus générique)
function resolve(line) {
  const l = line.trim();
  if (!l) return null;
  const exact = catalog.find((m) => m.id === l);
  if (exact) return exact;
  const words = flat(l).split(' ').filter(Boolean);
  const hits = catalog.filter((m) => { const h = flat(m.id + ' ' + m.name); return words.every((w) => h.includes(w)) && !/:free$/.test(m.id); });
  return hits.sort((a, b) => a.id.length - b.id.length)[0] || null;
}
const ytId = (s) => (String(s).match(/(?:v=|youtu\.be\/|shorts\/|^)([\w-]{11})(?:[&?\s]|$)/) || [])[1];

$('go').onclick = async () => {
  const s = await getSettings();
  if (!s.llm.baseUrl || !s.llm.apiKey) { $('status').textContent = '⚠ Configure d’abord l’IA dans ⚙ du panneau (adresse et clé OpenRouter).'; return; }
  $('go').disabled = true; $('out').innerHTML = '';
  try {
    $('status').textContent = 'Lecture du catalogue…';
    catalog = await loadCatalog(s.llm).catch(() => []);
    const question = $('q').value.trim();
    const models = [], missing = [];
    for (const line of $('models').value.split('\n').map((x) => x.trim()).filter(Boolean)) {
      const m = catalog.length ? resolve(line) : { id: line, name: line, pricing: {} };
      if (m) models.push(m); else missing.push(line);
    }
    const cases = [];
    for (const line of $('cases').value.split('\n').map((x) => x.trim()).filter(Boolean)) {
      const [ref, ...exp] = line.split('|');
      const id = ytId(ref), expected = exp.join('|').trim();
      if (!id || !expected) { missing.push(`vidéo illisible : ${line}`); continue; }
      const [v] = await getTweets(['yt:' + id]);
      if (!v) { missing.push(`vidéo absente de l’extension : ${id}`); continue; }
      const ch = (await getTranscripts([v.id])).get(v.id);
      const passages = ch?.length ? selectPassages(ch, question) : [{ at: 0, text: v.text }];
      cases.push({ v, expected, passages, text: passagesText(passages), hasTr: !!ch?.length });
    }
    if (!models.length || !cases.length) { $('status').textContent = '⚠ ' + (missing.join(' · ') || 'rien à tester'); return; }
    const rows = [];
    for (const m of models) {
      const row = { m, ok: 0, n: 0, cost: 0, ms: 0, rejected: 0, invalid: 0, errors: 0, details: [] };
      for (const c of cases) {
        $('status').textContent = `${m.id} — ${row.n + 1}/${cases.length}…`;
        const t0 = performance.now();
        try {
          const r = await chatFull(s.llm, extractMessages(c.v, c.text, question), { model: m.id, maxTokens: 500, temperature: 0, noThink: true });
          row.ms += performance.now() - t0;
          const p = parseExtraction(r.text, c.passages);
          const got = p.answers.map((a) => a.value).join(' ; ');
          const good = p.answers.some((a) => flat(a.value).includes(flat(c.expected)) || flat(c.expected).split(' ').every((w) => flat(a.value).includes(w)));
          if (good) row.ok++;
          row.rejected += p.rejected; if (p.invalid) row.invalid++;
          row.cost += r.usage.cost != null ? r.usage.cost : ((c.text.length / 3.5 + 700) * (perM(m.pricing?.prompt) || 0) + 150 * (perM(m.pricing?.completion) || 0)) / 1e6;
          row.details.push({ title: c.v.text, expected: c.expected, got: got || (p.invalid ? '(réponse illisible)' : '(rien)'), good, rejected: p.rejected });
        } catch (e) { row.errors++; row.details.push({ title: c.v.text, expected: c.expected, got: '⚠ ' + String(e.message || e).slice(0, 140), good: false }); }
        row.n++;
      }
      rows.push(row);
    }
    rows.sort((a, b) => b.ok - a.ok || a.cost - b.cost);
    $('out').innerHTML = `<table><tr><th>Modèle</th><th>Justesse</th><th>Coût / vidéo</th><th>≈ pour 100 vidéos</th><th>Durée / vidéo</th><th>Citations rejetées</th><th></th></tr>${rows.map((r, i) => `<tr><td><b>${esc(r.m.id)}</b><br><small>${esc(r.m.name || '')}</small></td><td class="${r.ok === r.n ? 'ok' : r.ok / r.n >= 0.8 ? '' : 'ko'}">${r.ok} / ${r.n}${r.errors ? ` (${r.errors} erreur(s))` : ''}</td><td>${(r.cost / r.n).toFixed(5)} $</td><td>${((r.cost / r.n) * 100).toFixed(3)} $</td><td>${(r.ms / r.n / 1000).toFixed(1)} s</td><td>${r.rejected}${r.invalid ? ` · ${r.invalid} illisible(s)` : ''}</td><td><button data-use="${i}">Utiliser</button></td></tr><tr><td colspan="7"><details><summary>Détail</summary><pre>${esc(r.details.map((d) => `${d.good ? '✓' : '✗'} ${d.title.slice(0, 70)}\n    attendu : ${d.expected}\n    obtenu  : ${d.got}${d.rejected ? `  (${d.rejected} citation(s) inventée(s) écartée(s))` : ''}`).join('\n'))}</pre></details></td></tr>`).join('')}</table>${missing.length ? `<p class="hint">Ignoré : ${esc(missing.join(' · '))}</p>` : ''}<p class="hint">Un petit jeu d’essai donne une indication, pas une garantie : ajoute des cas difficiles (invité nommé tard, plusieurs invités, vidéo sans transcription). Une « justesse » élevée avec 0 citation rejetée est le signe à chercher.</p>`;
    $('out').querySelectorAll('[data-use]').forEach((b) => (b.onclick = async () => {
      const r = rows[Number(b.dataset.use)];
      await setSettings({ mcp: { extractModel: r.m.id, priceIn: perM(r.m.pricing?.prompt) ?? s.mcp.priceIn, priceOut: perM(r.m.pricing?.completion) ?? s.mcp.priceOut } });
      b.textContent = 'Choisi ✓';
    }));
    $('status').textContent = 'Terminé.';
  } catch (e) { $('status').textContent = '⚠ ' + (e.message || e); } finally { $('go').disabled = false; }
};
