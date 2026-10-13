// Utilitaires texte partagés (parser, recherche, panneau).
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// X renvoie le texte HTML-échappé (&amp; &lt; …).
export function decodeEntities(s) {
  return (s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const STOP = new Set((
  'le la les un une des du de d l et ou en au aux a à y je j tu il elle on nous vous ils elles me te se ce cet cette ces ' +
  'mon ma mes ton ta tes son sa ses notre votre leur que qui quoi dont où pour par sur sous dans avec sans ne pas plus ' +
  'est sont ete etre avoir ai as ont suis cherche chercher recherche rechercher trouve trouver retrouve retrouver voudrais veux ' +
  'tweet tweets post posts bookmark bookmarks publication publications parle parlent parler concernant concerne propos sujet ' +
  'the a an of and or to in on at for with about is are was were be been i me my we you he she it they that this these those ' +
  'looking find some any talk talks talking tweet tweets'
).split(/\s+/));

export const isStopword = (t) => STOP.has(t);

// Retire l'amorce « je cherche des tweets qui parlent de … » avant l'embedding.
export function semanticQuery(q) {
  const s = q.trim();
  const stripped = s.replace(
    /^(?:(?:je|j')\s*(?:cherche|recherche|voudrais retrouver|voudrais trouver|veux retrouver|veux trouver)|trouve(?:-moi)?|retrouve(?:-moi)?|i(?:'m| am) looking for|looking for|find(?: me)?)\s*(?:(?:des|les|un|une|le|la|some|the|a)\s+)?(?:tweets?|posts?|bookmarks?|publications?)?\s*(?:(?:qui\s+)?(?:parl(?:ent|e)|traitent|concernent|that\s+(?:talk|are)|talking)\s*(?:de|du|des|d'|à propos de|about)?|(?:concernant|sur|about|à propos de|à propos d')|(?:de|du|des))?\s*/i,
    '',
  );
  return stripped.length >= 3 ? stripped : s;
}
