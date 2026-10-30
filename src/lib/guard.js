// Garde-fous contre la perte de données : détection d'une base vidée (corruption, extension réinstallée, nettoyage du navigateur…)
// et planification des sauvegardes automatiques. Fonctions pures, testées. L'état (dernier effectif connu, dernière sauvegarde) est gardé
// dans chrome.storage.local, qui survit à un effacement de la base.
export const WIPE_MIN = 200; // en dessous, une base vide n'a rien d'inquiétant

// n : éléments actuellement en base ; seen : { n, at } dernier effectif connu.
// Une chute brutale (< 20 % de l'effectif connu) est suspecte : on n'écrase alors rien et on prévient.
export const looksWiped = (n, seen) => !!seen && seen.n >= WIPE_MIN && n < seen.n * 0.2;

// Nouvel effectif connu : mis à jour tant que la base n'a pas l'air vidée, conservé sinon (l'alerte reste affichée jusqu'à restauration).
export const nextSeen = (n, seen, now = Date.now()) => (n >= WIPE_MIN && !looksWiped(n, seen) ? { n, at: now } : seen);

// Faut-il sauvegarder maintenant ? -> { due, skip } ; skip = raison d'une suspension (jamais d'écrasement d'une bonne sauvegarde par une base vide)
export function backupDue(state, { now = Date.now(), hours = 24, n = 0 } = {}) {
  const last = state?.lastBackup;
  const due = !last || now - last.at >= hours * 3600_000;
  if (!due) return { due: false, skip: null };
  if (looksWiped(n, state?.seen)) return { due: false, skip: 'la base semble avoir été vidée : restaure-la avant de sauvegarder' };
  if (n < 20) return { due: false, skip: 'la base est presque vide' };
  if (last && last.count >= WIPE_MIN && n < last.count * 0.5) return { due: false, skip: `la base a perdu plus de la moitié de ses éléments depuis la dernière sauvegarde (${last.count} → ${n})` };
  return { due: true, skip: null };
}
