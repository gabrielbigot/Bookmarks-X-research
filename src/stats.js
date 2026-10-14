import { getAllTweets } from './lib/db.js';
import { computeStats, TYPE_LABELS } from './lib/stats.js';
import { bindThemeButton } from './lib/theme.js';
import { isVideoItem } from './lib/youtube.js';
import { timeSeries, cumulative, columns, hbars, stacked, calendar, sparkline, esc, fmtInt, fmtCompact, fmtDay, WEEKDAYS } from './lib/charts.js';

const $ = (id) => document.getElementById(id);
const RANGES = [[7, '7 j'], [30, '30 j'], [90, '90 j'], [365, '1 an'], [null, 'Tout']];
const RKEY = 'xbs.stats.range';
let all = [], range = 90;
try { const v = localStorage.getItem(RKEY); if (v !== null) range = v === 'all' ? null : Number(v); } catch {}

bindThemeButton($('theme'));

// Ouvre le panneau de recherche avec une requête (cliquer sur une barre, une case, une pastille…).
const openQ = (q) => window.open(`panel.html?q=${encodeURIComponent(q)}`, '_blank', 'noopener');

function drawRanges() {
  $('ranges').replaceChildren(...RANGES.map(([v, label]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.setAttribute('aria-pressed', String(v === range));
    b.onclick = () => { range = v; try { localStorage.setItem(RKEY, v === null ? 'all' : String(v)); } catch {} drawRanges(); render(); };
    return b;
  }));
}

const tableHtml = ({ head, rows }) =>
  `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

// Une carte = titre + sous-titre + graphique + jumeau « tableau » (les valeurs ne dépendent jamais de l'infobulle).
const cards = [];
function card(title, sub, chart, { full = false } = {}) {
  const id = 'c' + cards.length;
  cards.push({ id, chart });
  return `<section class="card${full ? ' full' : ''}" id="${id}"><header><div><h3>${esc(title)}</h3>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}</div>
    <button class="tbl-btn" type="button" aria-pressed="false" title="Afficher les valeurs en tableau">Tableau</button></header>
    <div class="viz">${chart.html}</div><div class="tbl" hidden>${tableHtml(chart.table)}</div></section>`;
}
const tile = (label, value, sub = '', extra = '', cls = '') => `<div class="tile ${cls}"><div class="l">${esc(label)}</div><div class="v">${value}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}${extra}</div>`;
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(n / d < 0.1 ? 1 : 0).replace('.', ',') + ' %' : '–');
const chips = (rows, qOf) => `<div class="chips">${rows.map(([k, n]) => `<button class="chip-s" type="button" data-q="${esc(qOf(k))}">${esc(k)}<b>${fmtInt(n)}</b></button>`).join('')}</div>`;

function dayQuery(st, k, gran) {
  const end = gran === 'week' ? shiftDay(k, 6) : gran === 'month' ? lastOfMonth(k) : k;
  const start = gran === 'month' ? k + '-01' : k;
  return st.savedValid ? `saved:${start}..${end}` : `since:${start} until:${end}`;
}
const shiftDay = (k, n) => { const [y, m, d] = k.split('-').map(Number); const t = new Date(y, m - 1, d + n); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
const lastOfMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };

function render() {
  const app = $('app');
  app.classList.add('loading');
  setTimeout(() => {
    cards.length = 0;
    const st = computeStats(all, { rangeDays: range });
    if (!all.length) { app.innerHTML = '<p class="muted">Aucun bookmark pour l’instant : synchronise-les depuis le panneau de recherche.</p>'; app.classList.remove('loading'); return; }
    const k = st.kpi, by = st.savedValid ? 'par date d’enregistrement' : 'par date de publication';
    const last30 = st.series.gran === 'day' ? st.series.points.slice(-30).map((p) => p.n) : [];
    let html = '';
    if (!st.savedValid) html += `<p class="note">Les <b>dates d’enregistrement</b> (quand tu as mis chaque tweet en bookmark) ne sont pas disponibles ou n’ont pas pu être vérifiées : les statistiques d’activité sont calculées <b>par date de publication</b> des tweets, et les graphiques par heure, par jour de la semaine et « âge à l’enregistrement » sont masqués.</p>`;

    html += '<div class="kpis">'
      + tile('Bookmarks' + (range ? ` (${RANGES.find(([v]) => v === range)[1]})` : ''), fmtInt(k.total), `${fmtInt(k.authors)} auteurs différents`, sparkline(last30), 'hero')
      + tile('Moyenne par jour actif', k.avgPerActiveDay.toFixed(1).replace('.', ','), `${fmtInt(k.activeDays)} jours actifs sur ${fmtInt(k.days)}`)
      + tile('Jour record', fmtInt(k.best.n), k.best.day ? fmtDay(k.best.day) : '')
      + tile('Plus longue série', `${fmtInt(k.streakLongest)} j`, `série en cours : ${fmtInt(k.streakCurrent)} j`)
      + tile('7 derniers jours', fmtInt(k.last7), `30 derniers jours : ${fmtInt(k.last30)}`)
      + tile('Avec médias', pct(k.withMedia, k.total), `${fmtInt(k.withMedia)} tweets`)
      + tile('Avec un lien', pct(k.withLink, k.total), `${fmtInt(k.withLink)} tweets`)
      + tile('Likes médians', fmtCompact(k.medianLikes), `total : ${fmtCompact(k.totalLikes)}`)
      + tile('Langue principale', esc(k.langMain || '–'), k.firstPub ? `tweets publiés du ${fmtDay(k.firstPub)} au ${fmtDay(k.lastPub)}` : '')
      + '</div>';

    // ---- activité ----
    const g = st.series.gran;
    const onDay = (p) => openQ(dayQuery(st, p.k, g));
    html += '<h2 class="sec">Activité</h2><div class="grid2">';
    html += card(`Bookmarks par ${g === 'day' ? 'jour' : g === 'week' ? 'semaine' : 'mois'}`, `${by}${g === 'day' ? ' · barres = jour, courbe = moyenne sur 7 jours' : ''} · clic = ouvrir ces tweets`, timeSeries(st.series.points, { gran: g, onPick: onDay }), { full: true });
    if (st.heat.length) html += card('Calendrier de l’année', 'les 12 derniers mois, un carré par jour · clic = ouvrir ce jour', calendar(st.heat, { onPick: (d) => openQ(`saved:${d.k}`) }), { full: true });
    if (st.cumulative.length > 1) html += card('Taille de la collection', `total cumulé ${by}`, cumulative(st.cumulative), { full: true });
    html += '</div>';

    // ---- habitudes (nécessitent les dates d'enregistrement) ----
    if (st.weekday) {
      html += '<h2 class="sec">Habitudes</h2><div class="grid2">';
      html += card('Par jour de la semaine', 'quand tu enregistres le plus', columns(WEEKDAYS.map((label, i) => ({ label, n: st.weekday[i] }))));
      html += card('Par heure de la journée', 'heure locale d’enregistrement', columns(st.hour.map((n, h) => ({ label: String(h), n })), { labelEvery: 3, tipTitle: (d) => `${d.label} h` }));
      if (st.ageAtSave) html += card('Âge du tweet à l’enregistrement', 'tu enregistres… dès la publication, ou longtemps après ?', hbars(st.ageAtSave.map((a) => ({ label: a.label, n: a.n })), { labelW: 110 }));
      html += '</div>';
    }

    // ---- contenu ----
    const typeQ = { video: 'has:video', photo: 'has:image', link: 'has:link' };
    html += '<h2 class="sec">Contenu</h2><div class="grid2">';
    html += card('Types de tweets', 'chaque tweet compte une seule fois (vidéo > photo > lien > citation > texte)', stacked(st.types.map((t) => ({ label: t.label, n: t.n, q: typeQ[t.key] }) ), { onPick: (d) => openQ(d.q) }));
    html += card('Langues', 'code de langue détecté par X', hbars(st.langs.map(([l, n]) => ({ label: l, n, q: `lang:${l}` })), { labelW: 80, onPick: (r) => openQ(r.q) }));
    html += card('Quand les tweets ont été publiés', 'par mois de publication · clic = ouvrir ce mois', columns(st.pubMonths.slice(-24).map((m) => ({ label: m.k.slice(2).replace('-', '/'), n: m.n, k: m.k })), { labelEvery: Math.max(1, Math.ceil(Math.min(24, st.pubMonths.length) / 8)), tipTitle: (d) => d.label, onPick: (d) => openQ(`since:${d.k}-01 until:${lastOfMonth(d.k)}`) }), { full: true });
    html += card('Popularité des tweets enregistrés', 'nombre de likes du tweet', columns(st.likesHist.map((h) => ({ label: h.label, n: h.n })), { tipTitle: (d) => `${d.label} likes` }));
    html += '</div>';

    // ---- sources ----
    html += '<h2 class="sec">Sources</h2><div class="grid2">';
    html += card('Auteurs les plus enregistrés', 'clic = ouvrir ses tweets', hbars(st.authors.slice(0, 20).map((a) => ({ label: a.name && a.name !== a.handle ? `${a.name} (@${a.handle})` : '@' + a.handle, n: a.n, q: `from:@${a.handle}`, sub: `${fmtCompact(a.likes)} likes cumulés` })), { labelW: 200, onPick: (r) => openQ(r.q) }));
    html += card('Sites les plus cités', 'domaines des liens', hbars(st.domains.slice(0, 20).map(([d, n]) => ({ label: d, n, q: d })), { labelW: 200, onPick: (r) => openQ(r.q) }));
    html += '</div><div class="grid2">';
    const cardHtml = (title, sub, inner) => `<section class="card"><header><div><h3>${esc(title)}</h3><p class="sub">${esc(sub)}</p></div></header>${inner}</section>`;
    if (st.hashtags.length) html += cardHtml('Hashtags', 'nombre de tweets · clic = chercher', chips(st.hashtags, (t) => t));
    if (st.mentions.length) html += cardHtml('Comptes les plus mentionnés', 'dans le texte des tweets', chips(st.mentions, (m) => m));
    html += cardHtml('Mots les plus fréquents', 'hors mots courants, une fois par tweet', chips(st.words, (w) => w));
    html += '</div>';

    // ---- pépites ----
    html += '<h2 class="sec">À redécouvrir</h2><div class="grid2">';
    html += cardHtml('Tweets les plus likés', 'parmi ta sélection', `<ol class="list">${st.topLiked.map((t) => `<li><b>${fmtCompact(t.likes)} ♥</b><a href="${esc(t.url)}" target="_blank" rel="noopener">@${esc(t.handle)} — ${esc(t.text)}</a></li>`).join('')}</ol>`);
    if (st.dupLinks.length) html += cardHtml('Liens enregistrés plusieurs fois', 'le même lien dans plusieurs tweets', `<ol class="list">${st.dupLinks.map(([u, n]) => `<li><b>× ${n}</b><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\/(www\.)?/, ''))}</a></li>`).join('')}</ol>`);
    html += '</div>';

    app.innerHTML = html;
    for (const c of cards) {
      const el = document.getElementById(c.id);
      c.chart.bind(el.querySelector('.viz'));
      const btn = el.querySelector('.tbl-btn'), tbl = el.querySelector('.tbl'), viz = el.querySelector('.viz');
      btn.onclick = () => { const on = btn.getAttribute('aria-pressed') !== 'true'; btn.setAttribute('aria-pressed', String(on)); tbl.hidden = !on; viz.hidden = on; };
    }
    app.querySelectorAll('.chip-s').forEach((b) => (b.onclick = () => openQ(b.dataset.q)));
    app.classList.remove('loading');
  }, 0);
}

drawRanges();
getAllTweets().then((t) => { all = t.filter((x) => !isVideoItem(x)); render(); }); // ces statistiques portent sur les bookmarks X
