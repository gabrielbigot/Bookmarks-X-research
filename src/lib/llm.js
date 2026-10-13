// IA optionnelle via une API compatible OpenAI (OpenRouter, Ollama en local, OpenAI, Cloudflare Workers AI…).
// Rien n'est envoyé tant que l'utilisateur n'a pas configuré une URL + un modèle.
import { decodeEntities } from './text.js';

export async function chat(llm, messages, { json = false, signal } = {}) {
  const url = llm.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = { model: llm.model, messages, temperature: 0.2, stream: false };
  if (json) body.response_format = { type: 'json_object' };
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', ...(llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`API IA : HTTP ${res.status}${t ? ' — ' + t : ''}`);
  }
  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content;
  if (typeof out !== 'string') throw new Error('API IA : réponse inattendue');
  return out;
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
