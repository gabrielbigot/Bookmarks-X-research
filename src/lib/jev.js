// Modèle de décision « System One » (Jev de TypeSafe) via l'API Decisions d'OpenRouter.
// Contrat vérifié : POST {model, state, questions:{clé:{type, instructions, criteria}}} -> {answers:{clé:{choice, confidence, probabilities}}}.
// On n'utilise que des questions de type « choice » (format de réponse vérifié) ; « score » et « noul » sont évités.
// Un modèle de décision ne génère pas de texte : il sert ici à classer (intention de la requête) et à noter (pertinence).

export async function decide(cfg, state, questions, { signal } = {}) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, state, questions }),
  });
  if (!res.ok) {
    const t = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Jev : HTTP ${res.status}${t ? ' — ' + t : ''}`);
  }
  const data = await res.json();
  const answers = data?.answers;
  if (!answers || typeof answers !== 'object') throw new Error('Jev : réponse inattendue');
  return answers;
}

// Probabilité d'une option : probabilities[option], sinon dérivée de choice + confidence.
export function probOf(answer, option) {
  if (!answer) return 0;
  const p = answer.probabilities?.[option];
  if (typeof p === 'number') return p;
  if (answer.choice === option) return Number(answer.confidence) || 0;
  return 0;
}

const pick = (answer, options, min = 0.6) => {
  if (!answer || !options.includes(answer.choice)) return null;
  const p = probOf(answer, answer.choice);
  return p >= min ? answer.choice : null;
};

export const INTENT_QUESTIONS = {
  sort: {
    type: 'choice',
    instructions: 'La requête demande-t-elle un tri par date de publication ?',
    criteria: {
      oldest: 'Elle veut le plus ancien, le plus vieux ou le tout premier',
      newest: 'Elle veut le plus récent ou le dernier',
      none: 'Aucun tri par date n’est demandé',
    },
  },
  period: {
    type: 'choice',
    instructions: 'Sur quelle période portent les tweets recherchés ?',
    criteria: {
      week: 'Les 7 derniers jours, cette semaine',
      month: 'Le dernier mois, ce mois-ci',
      year: 'La dernière année, cette année',
      none: 'Aucune période précisée',
    },
  },
  kind: {
    type: 'choice',
    instructions: 'La requête vise-t-elle un type de contenu particulier ?',
    criteria: {
      link: 'Des tweets avec un lien ou un article',
      media: 'Des tweets avec une image ou une photo',
      video: 'Des tweets avec une vidéo',
      none: 'Aucun type de contenu particulier',
    },
  },
};

// -> { sort: 'oldest'|'newest'|null, period: 'week'|'month'|'year'|null, kind: 'link'|'media'|'video'|null }
export async function jevIntent(cfg, query) {
  const a = await decide(cfg, query, INTENT_QUESTIONS);
  return {
    sort: pick(a.sort, ['oldest', 'newest']),
    period: pick(a.period, ['week', 'month', 'year']),
    kind: pick(a.kind, ['link', 'media', 'video']),
  };
}

export const PERIOD_DAYS = { week: 7, month: 30, year: 365 };

const RELEVANCE = {
  pertinent: {
    type: 'choice',
    instructions: 'Ce tweet répond-il à la requête de recherche ?',
    criteria: {
      oui: 'Il traite directement le sujet de la requête',
      non: 'Il est hors sujet ou seulement vaguement lié',
    },
  },
};

// Note chaque tweet (probabilité « oui ») ; appels en parallèle limités. Retourne un tableau de scores 0..1.
export async function jevRerank(cfg, query, texts, { concurrency = 5 } = {}) {
  const scores = new Array(texts.length).fill(0);
  let next = 0;
  const worker = async () => {
    while (next < texts.length) {
      const i = next++;
      try {
        const a = await decide(cfg, { requête: query, tweet: texts[i].slice(0, 800) }, RELEVANCE);
        scores[i] = probOf(a.pertinent, 'oui');
      } catch (e) {
        if (i === 0) throw e; // erreur d'accès (clé, quota) : on remonte une seule fois
        scores[i] = 0;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, worker));
  return scores;
}

// ---- détecteurs : confirmation des cas ambigus ----
const MATCH = (description) => ({
  match: {
    type: 'choice',
    instructions: `Ce contenu correspond-il à la description suivante : « ${description} » ? Juge selon le sens et l'intention, pas seulement selon les mots présents.`,
    criteria: { oui: 'Il correspond clairement à la description', non: 'Il ne correspond pas, ou seulement de loin' },
  },
});

// items : [{ id, text }] -> Map id -> probabilité « oui » en pour cent (0..100). Appels en parallèle limités ;
// onBatch(Map) est rappelé régulièrement (pour enregistrer au fil de l'eau) ; la première erreur d'accès interrompt tout.
export async function jevJudge(cfg, description, items, { concurrency = 4, signal, onBatch, every = 20 } = {}) {
  const out = new Map(), fresh = new Map();
  const q = MATCH(description);
  let next = 0, failed = null;
  const worker = async () => {
    while (next < items.length && !failed && !signal?.aborted) {
      const it = items[next++];
      try {
        const a = await decide(cfg, { contenu: it.text.slice(0, 900) }, q, { signal });
        const p = Math.round(probOf(a.match, 'oui') * 100);
        out.set(it.id, p); fresh.set(it.id, p);
        if (fresh.size >= every) { const b = new Map(fresh); fresh.clear(); await onBatch?.(b); }
      } catch (e) {
        if (signal?.aborted) return;
        failed = failed || e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (fresh.size) await onBatch?.(new Map(fresh));
  if (failed && !out.size) throw failed; // rien n'a abouti : erreur d'accès (clé, quota…)
  return { done: out, error: failed ? String(failed.message || failed) : '' };
}

// Estimation du coût d'une série de jugements : tokens d'entrée ≈ caractères / 3,5 (+ consignes) ; la sortie de Jev est gratuite chez OpenRouter.
// priceInPerM : dollars par million de tokens d'entrée (0,042 pour jev-1.13 au moment de l'écriture ; à vérifier sur la fiche du modèle).
export const DEFAULT_PRICE_IN_PER_M = 0.042;
export function estimateJudgeCost(description, texts, priceInPerM = DEFAULT_PRICE_IN_PER_M) {
  const overhead = (description || '').length + 260; // consignes + critères + clés JSON
  const tokens = texts.reduce((n, t) => n + Math.ceil((Math.min(900, t.length) + overhead) / 3.5), 0);
  return { calls: texts.length, tokens, dollars: (tokens / 1e6) * priceInPerM };
}
export const fmtDollars = (d) => (d < 0.01 ? '< 0,01 $' : d.toFixed(2).replace('.', ',') + ' $');
