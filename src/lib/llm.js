// IA optionnelle via une API compatible OpenAI (OpenRouter, Ollama en local, OpenAI, Cloudflare Workers AI…).
// Rien n'est envoyé tant que l'utilisateur n'a pas configuré une URL + un modèle.
import { decodeEntities } from './text.js';

export async function chat(llm, messages, opts = {}) {
  return (await chatFull(llm, messages, opts)).text;
}

// Comme chat(), mais retourne aussi l'usage (tokens, et le coût réel si le fournisseur le donne : OpenRouter).
// opts.model remplace le modèle configuré ; opts.maxTokens borne la sortie ; opts.temperature.
const thinkMode = new Map(); // modèle -> réglage du raisonnement accepté
export async function chatFull(llm, messages, { json = false, signal, model, maxTokens, temperature = 0.2, plugins, noThink = false } = {}) {
  const url = llm.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = { model: model || llm.model, messages, temperature, stream: false };
  if (maxTokens) body.max_tokens = maxTokens;
  if (plugins) body.plugins = plugins; // ex. [{ id: 'web', max_results: 5 }] (recherche web OpenRouter)
  if (/openrouter\.ai/i.test(llm.baseUrl)) body.usage = { include: true }; // coût réel dans la réponse
  if (noThink && /openrouter\.ai/i.test(llm.baseUrl)) body.reasoning = { enabled: false }; // modèles « à raisonnement » : pas de réflexion qui mange la limite de sortie
  if (json) body.response_format = { type: 'json_object' };
  const call = async (b) => {
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', ...(llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}) },
      body: JSON.stringify(b),
    });
    if (!res.ok) {
      const t = (await res.text().catch(() => '')).slice(0, 300);
      const err = new Error(`API IA : HTTP ${res.status}${t ? ' — ' + t : ''}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };
  // Réglage du raisonnement, mémorisé par modèle : « off » (désactivé) -> « low » (raisonnement court, marge de sortie ajoutée) -> « default » (rien)
  const key = body.model;
  const modes = ['off', 'low', 'default'];
  let mode = noThink && /openrouter\.ai/i.test(llm.baseUrl) ? (thinkMode.get(key) || 'off') : 'default';
  const bodyFor = (m) => {
    const { reasoning, ...rest } = body;
    if (m === 'off') return { ...rest, reasoning: { enabled: false } };
    if (m === 'low' && rest.max_tokens) return { ...rest, reasoning: { effort: 'low' }, max_tokens: rest.max_tokens + 2500 };
    if (m === 'low') return { ...rest, reasoning: { effort: 'low' } };
    return m === 'default' && noThink && rest.max_tokens ? { ...rest, max_tokens: rest.max_tokens + 2500 } : rest;
  };
  let data, cur;
  for (;;) {
    cur = bodyFor(mode);
    try { data = await call(cur); break; } catch (e) {
      const next = modes[modes.indexOf(mode) + 1];
      if (!(noThink && e.status === 400 && next && /reason/i.test(e.message))) throw e; // « Reasoning is mandatory… » : on essaie le réglage suivant
      mode = next;
    }
  }
  if (noThink && /openrouter\.ai/i.test(llm.baseUrl)) thinkMode.set(key, mode);
  let msg = data?.choices?.[0];
  if (data?.error && !msg) throw new Error('API IA : ' + String(data.error.message || data.error.code || JSON.stringify(data.error)).slice(0, 200));
  // sortie vide parce que la limite a été consommée par le raisonnement : un seul nouvel essai avec une limite double
  if (!String(msg?.message?.content ?? '').trim() && msg?.finish_reason === 'length' && cur.max_tokens && cur.max_tokens < 16000) {
    data = await call({ ...cur, max_tokens: cur.max_tokens * 2 });
    msg = data?.choices?.[0];
  }
  const out = msg?.message?.content;
  if (typeof out !== 'string' || !out.trim()) {
    const why = msg?.finish_reason === 'length' ? 'limite de sortie atteinte avant la réponse (modèle à raisonnement ?)' : msg?.finish_reason ? 'fin : ' + msg.finish_reason : 'pas de contenu';
    throw new Error(`API IA : réponse vide (${why})`);
  }
  const u = data.usage || {};
  return { text: out, annotations: msg?.message?.annotations || [], usage: { promptTokens: Number(u.prompt_tokens) || 0, completionTokens: Number(u.completion_tokens) || 0, cost: typeof u.cost === 'number' ? u.cost : null } };
}

export function parseJsonLoose(text) {
  const t = text.replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('JSON introuvable dans la réponse');
  return JSON.parse(t.slice(a, b + 1));
}

const fmtTweet = (t, i, max = 600) => {
  const d = t.createdAt ? t.createdAt.slice(0, 10) : '?';
  const links = (t.links || []).slice(0, 2).join(' ');
  const lt = t.linkText ? ` | page liée : ${t.linkText.slice(0, 200)}` : '';
  return `[${i + 1}] @${t.handle} (${d}) : ${decodeEntities(t.text).replace(/\s+/g, ' ').slice(0, max)}${links ? ' | ' + links : ''}${lt}`;
};

export function askMessages(question, tweets) {
  return [
    { role: 'system', content:
      'Tu aides à retrouver des informations dans les bookmarks X de l’utilisateur. Réponds en français, de façon concise, ' +
      'UNIQUEMENT à partir des tweets fournis. Cite tes sources avec [n] (numéro du tweet) après chaque affirmation. ' +
      'Si les tweets ne permettent pas de répondre, dis-le franchement. N’invente rien.' },
    { role: 'user', content: `Question : ${question}\n\nTweets :\n${tweets.map((t, i) => fmtTweet(t, i)).join('\n')}` },
  ];
}

export function digestMessages(label, tweets) {
  return [
    { role: 'system', content:
      'Tu rédiges un résumé de veille à partir de bookmarks X. Réponds en français : regroupe par thèmes (titres en **gras**), ' +
      'une à deux phrases par thème, cite les tweets avec [n]. Mets en avant ce qui est le plus important. N’invente rien.' },
    { role: 'user', content: `Période : ${label}\n\nTweets :\n${tweets.map((t, i) => fmtTweet(t, i, 400)).join('\n')}` },
  ];
}

export function intentMessages(query, today) {
  return [
    { role: 'system', content:
      'Tu transformes une requête de recherche dans des bookmarks X en JSON. Réponds UNIQUEMENT par un objet JSON : ' +
      '{"topic": string (le sujet à chercher, sans les mots de commande ; "" si aucun), "authors": string[] (noms ou pseudos d’auteurs demandés), ' +
      '"sort": "oldest"|"newest"|null, "since": "YYYY-MM-DD"|null, "until": "YYYY-MM-DD"|null, "has": ("link"|"media"|"video")[]}. ' +
      `Date du jour : ${today}.` },
    { role: 'user', content: query },
  ];
}

export function rerankMessages(query, tweets) {
  return [
    { role: 'system', content:
      'Tu juges la pertinence de tweets pour une requête. Réponds UNIQUEMENT par {"scores": number[]} : une note de 0 (hors sujet) à 10 ' +
      '(répond exactement), dans l’ordre des tweets, un score par tweet.' },
    { role: 'user', content: `Requête : ${query}\n\nTweets :\n${tweets.map((t, i) => fmtTweet(t, i, 300)).join('\n')}` },
  ];
}

export function themeNamesMessages(groups) {
  return [
    { role: 'system', content:
      'On te donne des groupes de tweets déjà regroupés par thème. Donne un nom court (2 à 4 mots, en français) à chaque groupe. ' +
      'Réponds UNIQUEMENT par {"names": string[]} dans l’ordre des groupes.' },
    { role: 'user', content: groups.map((g, i) => `Groupe ${i + 1} — mots-clés : ${g.terms.join(', ')}\n${g.samples.map((s) => '- ' + s).join('\n')}`).join('\n\n') },
  ];
}

// Markdown minimal et sûr : gras, listes, paragraphes, citations [n] -> liens vers les cartes.
export function renderMd(text, nSources) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inline = (s) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\[(\d{1,3})\]/g, (m, n) => (+n >= 1 && +n <= nSources ? `<a class="cite" href="#t-${n}" data-n="${n}">[${n}]</a>` : m));
  const out = [];
  let list = false;
  for (const line of text.split(/\r?\n/)) {
    const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      if (!list) { out.push('<ul>'); list = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (list) { out.push('</ul>'); list = false; }
    if (line.trim()) out.push(`<p>${inline(line.replace(/^#+\s*/, ''))}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}
