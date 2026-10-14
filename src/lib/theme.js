// Thème : « auto » (suit le système), « light » ou « dark ». Mémorisé, partagé par le panneau et les statistiques.
const KEY = 'xbs.theme';
export const THEMES = ['auto', 'dark', 'light'];

export function getTheme() {
  try { const t = localStorage.getItem(KEY); return THEMES.includes(t) ? t : 'auto'; } catch { return 'auto'; }
}
export function applyTheme(t = getTheme()) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  return t;
}
export function setTheme(t) {
  try { localStorage.setItem(KEY, t); } catch {}
  return applyTheme(t);
}
export const cycleTheme = () => setTheme(THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length]);
export const THEME_ICON = { auto: '◐', dark: '☾', light: '☀' };
export const THEME_LABEL = { auto: 'Thème : automatique (suit le système)', dark: 'Thème : sombre', light: 'Thème : clair' };

// Branche un bouton : affiche l'icône du thème courant, un clic passe au suivant.
export function bindThemeButton(btn) {
  const paint = () => { const t = getTheme(); btn.textContent = THEME_ICON[t]; btn.title = THEME_LABEL[t] + ' — cliquer pour changer'; };
  btn.onclick = () => { cycleTheme(); paint(); };
  paint();
}
