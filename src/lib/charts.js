// Graphiques en SVG pur (aucune dépendance). Chaque constructeur retourne { html, table, bind(root) }.
// Règles : marques fines (barres ≤ 24 px, bout arrondi 4 px côté données), lignes 2 px, grille en filets,
// texte en encres neutres (jamais la couleur de la série), infobulle sur chaque marque, jumeau « tableau ».
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtInt = (n) => Math.round(n).toLocaleString('fr-FR');
export function fmtCompact(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',').replace(',0', '') + ' M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace('.', ',').replace(',0', '') + ' k';
  return String(Math.round(n * 10) / 10).replace('.', ',');
}
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
export const fmtDay = (k) => { const [y, m, d] = k.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const fmtDayShort = (k) => { const [, m, d] = k.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };
const fmtMonth = (k) => { const [y, m] = k.split('-').map(Number); return `${MONTHS[m - 1]} ${String(y).slice(2)}`; };
export const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

const W = 600;
let uid = 0;

// ---------- infobulle (une seule, textContent uniquement : les libellés viennent des tweets) ----------
let tipEl;
export const tip = {
  show(x, y, title, lines = []) {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; tipEl.setAttribute('role', 'tooltip'); document.body.appendChild(tipEl); }
    tipEl.replaceChildren();
    const t = document.createElement('div'); t.className = 'tip-t'; t.textContent = title; tipEl.appendChild(t);
    for (const [label, value] of lines) {
      const row = document.createElement('div'); row.className = 'tip-r';
      const v = document.createElement('b'); v.textContent = value;
      const l = document.createElement('span'); l.textContent = label;
      row.append(v, l); tipEl.appendChild(row);
    }
    tipEl.style.display = 'block';
    const r = tipEl.getBoundingClientRect();
    const left = Math.min(Math.max(8, x + 14), window.innerWidth - r.width - 8);
    const top = y - r.height - 12 < 8 ? y + 18 : y - r.height - 12;
    tipEl.style.left = left + 'px'; tipEl.style.top = top + 'px';
  },
  hide() { if (tipEl) tipEl.style.display = 'none'; },
};
const tipAt = (el, title, lines) => { const r = el.getBoundingClientRect(); tip.show(r.left + r.width / 2, r.top, title, lines); };

// Graduations « rondes » (0 / 5 / 10 …).
export function niceTicks(max, want = 4) {
  if (max <= 0) return { top: 1, ticks: [0, 1] };
  const raw = max / want, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const top = Math.ceil(max / step) * step;
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toFixed(6)) };
}

// Rectangle dont seul le bout « données » est arrondi (4 px) ; le pied reste droit sur la ligne de base.
const topRounded = (x, y, w, h, r = 4) => { r = Math.max(0, Math.min(r, w / 2, h)); return h <= 0 ? '' : `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };
const rightRounded = (x, y, w, h, r = 4) => { r = Math.max(0, Math.min(r, h / 2, w)); return w <= 0 ? '' : `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`; };

const tableOf = (head, rows) => ({ head, rows });

// ---------- série temporelle (barres + moyenne 7 j) avec repère vertical ----------
export function timeSeries(points, { gran, height = 200, label = 'bookmarks', tipTitle, onPick } = {}) {
  const m = { l: 40, r: 10, t: 10, b: 26 }, iw = W - m.l - m.r, ih = height - m.t - m.b;
  const max = Math.max(1, ...points.map((p) => p.n), ...points.map((p) => p.ma || 0));
  const { top, ticks } = niceTicks(max);
  const y = (v) => m.t + ih - (v / top) * ih;
  const N = points.length, slot = iw / Math.max(1, N), bw = Math.max(1, Math.min(24, slot - 2));
  const x = (i) => m.l + slot * i + slot / 2;
  const fmtK = gran === 'month' ? fmtMonth : fmtDayShort;
  let g = '';
  for (const t of ticks) g += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text class="ax" x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmtCompact(t)}</text>`;
  g += `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
  const cls = gran === 'day' ? 'bar-soft' : 'bar';
  points.forEach((p, i) => { g += `<path class="${cls}" d="${topRounded(x(i) - bw / 2, y(p.n), bw, y(0) - y(p.n), bw >= 8 ? 4 : 1)}"/>`; });
  if (gran === 'day' && N > 1) g += `<path class="line" d="${points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.ma).toFixed(1)}`).join('')}"/>`;
  const every = Math.max(1, Math.ceil(N / 6));
  points.forEach((p, i) => { if (i % every === 0) g += `<text class="ax" x="${x(i)}" y="${height - 8}" text-anchor="middle">${esc(fmtK(gran === 'month' ? p.k : p.k.length === 7 ? p.k : p.k))}</text>`; });
  const html = `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(label)} par ${gran === 'day' ? 'jour' : gran === 'week' ? 'semaine' : 'mois'}">${g}<line class="xh" y1="${m.t}" y2="${y(0)}" x1="0" x2="0" style="display:none"/><rect class="hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih + 4}" fill="transparent"/></svg>`;
  const unit = gran === 'day' ? 'jour' : gran === 'week' ? 'semaine du' : 'mois';
  const table = tableOf([unit[0].toUpperCase() + unit.slice(1), label, ...(gran === 'day' ? ['Moyenne 7 j'] : [])], points.map((p) => [gran === 'month' ? fmtMonth(p.k) : fmtDay(p.k), fmtInt(p.n), ...(gran === 'day' ? [(p.ma || 0).toFixed(1).replace('.', ',')] : [])]));
  const bind = (root) => {
    const svg = root.querySelector('svg.chart'), hit = svg.querySelector('.hit'), xh = svg.querySelector('.xh');
    const idxAt = (ev) => { const r = svg.getBoundingClientRect(); const px = ((ev.clientX - r.left) / r.width) * W; return Math.max(0, Math.min(N - 1, Math.floor((px - m.l) / slot))); };
    hit.addEventListener('pointermove', (ev) => {
      const i = idxAt(ev), p = points[i];
      xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.style.display = '';
      const lines = [[label, fmtInt(p.n)]];
      if (gran === 'day') lines.push(['moyenne 7 j', (p.ma || 0).toFixed(1).replace('.', ',')]);
      tip.show(ev.clientX, ev.clientY, tipTitle ? tipTitle(p) : gran === 'month' ? fmtMonth(p.k) : (gran === 'week' ? 'Semaine du ' : '') + fmtDay(p.k), lines);
    });
    hit.addEventListener('pointerleave', () => { xh.style.display = 'none'; tip.hide(); });
    if (onPick) { hit.style.cursor = 'pointer'; hit.addEventListener('click', (ev) => onPick(points[idxAt(ev)])); }
  };
  return { html, table, bind };
}

// ---------- courbe cumulée (aire 10 % + ligne 2 px + point final étiqueté) ----------
export function cumulative(points, { height = 190, label = 'bookmarks au total' } = {}) {
  const m = { l: 44, r: 54, t: 10, b: 26 }, iw = W - m.l - m.r, ih = height - m.t - m.b;
  const max = Math.max(1, ...points.map((p) => p.n));
  const { top, ticks } = niceTicks(max);
  const y = (v) => m.t + ih - (v / top) * ih;
  const N = points.length;
  const x = (i) => m.l + (N <= 1 ? iw / 2 : (iw * i) / (N - 1));
  let g = '';
  for (const t of ticks) g += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text class="ax" x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmtCompact(t)}</text>`;
  g += `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
  if (N) {
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.n).toFixed(1)}`).join('');
    g += `<path class="area" d="${line}L${x(N - 1)},${y(0)}L${x(0)},${y(0)}Z"/><path class="line" d="${line}"/>`;
    const last = points[N - 1];
    g += `<circle class="dot" cx="${x(N - 1)}" cy="${y(last.n)}" r="4"/><text class="val" x="${x(N - 1) + 9}" y="${y(last.n) + 4}">${fmtCompact(last.n)}</text>`;
  }
  const every = Math.max(1, Math.ceil(N / 6));
  points.forEach((p, i) => { if (i % every === 0 && i < N - 1) g += `<text class="ax" x="${x(i)}" y="${height - 8}" text-anchor="middle">${esc(fmtDayShort(p.k))}</text>`; });
  const html = `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(label)}">${g}<line class="xh" y1="${m.t}" y2="${y(0)}" x1="0" x2="0" style="display:none"/><rect class="hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih + 4}" fill="transparent"/></svg>`;
  const step = Math.max(1, Math.ceil(N / 30)); // jumeau tableau : ~30 lignes
  const table = tableOf(['Jour', 'Total cumulé'], points.filter((_, i) => i % step === 0 || i === N - 1).map((p) => [fmtDay(p.k), fmtInt(p.n)]));
  const bind = (root) => {
    const svg = root.querySelector('svg.chart'), hit = svg.querySelector('.hit'), xh = svg.querySelector('.xh');
    hit.addEventListener('pointermove', (ev) => {
      const r = svg.getBoundingClientRect(), px = ((ev.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(N - 1, Math.round(((px - m.l) / iw) * (N - 1))));
      xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.style.display = '';
      tip.show(ev.clientX, ev.clientY, fmtDay(points[i].k), [[label, fmtInt(points[i].n)]]);
    });
    hit.addEventListener('pointerleave', () => { xh.style.display = 'none'; tip.hide(); });
  };
  return { html, table, bind };
}

// ---------- colonnes (jour de la semaine, heure, mois…) : la plus haute est mise en avant ----------
export function columns(items, { height = 150, label = 'bookmarks', labelEvery = 1, tipTitle, onPick } = {}) {
  const m = { l: 40, r: 8, t: 18, b: 24 }, iw = W - m.l - m.r, ih = height - m.t - m.b;
  const max = Math.max(1, ...items.map((d) => d.n));
  const { top, ticks } = niceTicks(max, 3);
  const y = (v) => m.t + ih - (v / top) * ih;
  const slot = iw / Math.max(1, items.length), bw = Math.min(24, slot - 4);
  const best = items.reduce((b, d, i) => (d.n > items[b].n ? i : b), 0);
  let g = '';
  for (const t of ticks) g += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text class="ax" x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmtCompact(t)}</text>`;
  g += `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
  items.forEach((d, i) => {
    const cx = m.l + slot * i + slot / 2;
    g += `<g class="mk" tabindex="0" data-i="${i}" role="img" aria-label="${esc(d.label)} : ${d.n}"><rect class="hitbox" x="${cx - slot / 2}" y="${m.t}" width="${slot}" height="${ih + 20}" fill="transparent"/><path class="${i === best && d.n > 0 ? 'bar' : 'bar-soft'}" d="${topRounded(cx - bw / 2, y(d.n), bw, y(0) - y(d.n))}"/></g>`;
    if (i % labelEvery === 0) g += `<text class="ax" x="${cx}" y="${height - 8}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  if (items[best]?.n > 0) g += `<text class="val" x="${m.l + slot * best + slot / 2}" y="${y(items[best].n) - 5}" text-anchor="middle">${fmtCompact(items[best].n)}</text>`;
  const html = `<svg class="chart" viewBox="0 0 ${W} ${height}" role="group" aria-label="${esc(label)}">${g}</svg>`;
  const table = tableOf(['', label], items.map((d) => [d.label, fmtInt(d.n)]));
  const bind = (root) => root.querySelectorAll('.mk').forEach((el) => {
    const d = items[el.dataset.i], show = () => tipAt(el.querySelector('path'), tipTitle ? tipTitle(d) : d.label, [[label, fmtInt(d.n)]]);
    el.addEventListener('pointerenter', show); el.addEventListener('focus', show);
    el.addEventListener('pointerleave', () => tip.hide()); el.addEventListener('blur', () => tip.hide());
    if (onPick && d.n > 0) { el.style.cursor = 'pointer'; el.addEventListener('click', () => onPick(d)); }
  });
  return { html, table, bind };
}

// ---------- barres horizontales classées (une seule teinte) ----------
export function hbars(rows, { label = 'tweets', labelW = 170, rowH = 24, onPick, tipSub } = {}) {
  const barH = 14, vw = 54, aw = W - labelW - vw - 8;
  const max = Math.max(1, ...rows.map((r) => r.n));
  const height = Math.max(rowH, rows.length * rowH) + 4;
  const maxChars = Math.floor(labelW / 6.4);
  let g = '';
  rows.forEach((r, i) => {
    const cy = i * rowH + 2, w = Math.max(2, (r.n / max) * aw);
    const text = r.label.length > maxChars ? r.label.slice(0, maxChars - 1) + '…' : r.label;
    g += `<g class="mk" tabindex="0" data-i="${i}" role="img" aria-label="${esc(r.label)} : ${r.n}"><rect class="hitbox" x="0" y="${cy}" width="${W}" height="${rowH}" fill="transparent"/>`
      + `<text class="lbl" x="${labelW - 8}" y="${cy + rowH / 2 + 4}" text-anchor="end">${esc(text)}</text>`
      + `<path class="bar" d="${rightRounded(labelW, cy + (rowH - barH) / 2, w, barH)}"/><text class="ax" x="${labelW + w + 6}" y="${cy + rowH / 2 + 4}">${fmtCompact(r.n)}</text></g>`;
  });
  const html = `<svg class="chart" viewBox="0 0 ${W} ${height}" role="group" aria-label="${esc(label)}">${g}</svg>`;
  const table = tableOf(['', label, ...(rows.some((r) => r.sub !== undefined) ? ['Détail'] : [])], rows.map((r) => [r.label, fmtInt(r.n), ...(rows.some((x) => x.sub !== undefined) ? [r.sub ?? ''] : [])]));
  const bind = (root) => root.querySelectorAll('.mk').forEach((el) => {
    const r = rows[el.dataset.i], show = () => tipAt(el.querySelector('path'), r.label, [[label, fmtInt(r.n)], ...(r.sub ? [[r.sub, '']] : [])]);
    el.addEventListener('pointerenter', show); el.addEventListener('focus', show);
    el.addEventListener('pointerleave', () => tip.hide()); el.addEventListener('blur', () => tip.hide());
    if (onPick && r.q) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => onPick(r));
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') onPick(r); });
    }
  });
  return { html, table, bind };
}

// ---------- barre empilée (part d'un tout), légende toujours présente ----------
export function stacked(items, { label = 'tweets', onPick } = {}) {
  const total = items.reduce((s, d) => s + d.n, 0) || 1, h = 30, id = 'cp' + ++uid;
  let x = 0, g = `<clipPath id="${id}"><rect x="0" y="0" width="${W}" height="${h}" rx="4"/></clipPath><g clip-path="url(#${id})">`;
  items.forEach((d, i) => {
    const w = (d.n / total) * W;
    if (w <= 0) return;
    g += `<rect class="seg s${i + 1} mk" tabindex="0" data-i="${i}" x="${x + (x > 0 ? 1 : 0)}" y="0" width="${Math.max(0, w - (x > 0 ? 1 : 0) - 1)}" height="${h}" role="img" aria-label="${esc(d.label)} : ${d.n}"/>`;
    x += w;
  });
  g += '</g>';
  const legend = items.map((d, i) => `<li class="lg mk" tabindex="0" data-i="${i}"><span class="sw s${i + 1}"></span><span class="lg-l">${esc(d.label)}</span><b>${fmtInt(d.n)}</b><span class="lg-p">${((d.n / total) * 100).toFixed(d.n / total < 0.1 ? 1 : 0).replace('.', ',')} %</span></li>`).join('');
  const html = `<svg class="chart stack" viewBox="0 0 ${W} ${h}" role="group" aria-label="${esc(label)}">${g}</svg><ul class="legend">${legend}</ul>`;
  const table = tableOf(['Type', label, 'Part'], items.map((d) => [d.label, fmtInt(d.n), ((d.n / total) * 100).toFixed(1).replace('.', ',') + ' %']));
  const bind = (root) => root.querySelectorAll('.mk').forEach((el) => {
    const d = items[el.dataset.i], show = () => tipAt(el, d.label, [[label, fmtInt(d.n)], ['part', ((d.n / total) * 100).toFixed(1).replace('.', ',') + ' %']]);
    el.addEventListener('pointerenter', show); el.addEventListener('focus', show);
    el.addEventListener('pointerleave', () => tip.hide()); el.addEventListener('blur', () => tip.hide());
    if (onPick && d.q) { el.style.cursor = 'pointer'; el.addEventListener('click', () => onPick(d)); }
  });
  return { html, table, bind };
}

// ---------- calendrier (53 semaines × 7 jours), échelle séquentielle d'une seule teinte ----------
export function calendar(days, { label = 'bookmarks', onPick } = {}) {
  const cell = 11, gap = 2, pitch = cell + gap, left = 28, topM = 16;
  const weeks = Math.ceil(days.length / 7), width = left + weeks * pitch + 4, height = topM + 7 * pitch + 28;
  const nz = days.map((d) => d.n).filter((n) => n > 0).sort((a, b) => a - b);
  const q = (p) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] || 1;
  const th = [q(0.25), q(0.5), q(0.75), q(0.92)];
  const level = (n) => (n === 0 ? 0 : n <= th[0] ? 1 : n <= th[1] ? 2 : n <= th[2] ? 3 : n <= th[3] ? 4 : 5);
  let g = '';
  ['Lun', 'Mer', 'Ven'].forEach((d, i) => { g += `<text class="ax" x="${left - 6}" y="${topM + (i * 2) * pitch + cell - 1}" text-anchor="end">${d}</text>`; });
  let lastMonth = '';
  days.forEach((d, i) => {
    const wk = Math.floor(i / 7), dow = i % 7, x = left + wk * pitch, y = topM + dow * pitch;
    const mo = d.k.slice(0, 7);
    if (dow === 0 && mo !== lastMonth && wk > 0) { g += `<text class="ax" x="${x}" y="${topM - 5}">${MONTHS[+d.k.slice(5, 7) - 1]}</text>`; }
    if (dow === 0) lastMonth = mo;
    g += `<rect class="cell h${level(d.n)} mk" tabindex="${d.n ? 0 : -1}" data-i="${i}" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" role="img" aria-label="${esc(fmtDay(d.k))} : ${d.n}"/>`;
  });
  const ly = topM + 7 * pitch + 12;
  g += `<text class="ax" x="${left}" y="${ly + 9}">Moins</text>` + [0, 1, 2, 3, 4, 5].map((l, i) => `<rect class="cell h${l}" x="${left + 40 + i * pitch}" y="${ly}" width="${cell}" height="${cell}" rx="2"/>`).join('') + `<text class="ax" x="${left + 40 + 6 * pitch + 4}" y="${ly + 9}">Plus</text>`;
  const html = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="group" aria-label="Calendrier d’activité">${g}</svg>`;
  const topDays = [...days].filter((d) => d.n > 0).sort((a, b) => b.n - a.n).slice(0, 20);
  const table = tableOf(['Jour (les plus actifs)', label], topDays.map((d) => [fmtDay(d.k), fmtInt(d.n)]));
  const bind = (root) => root.querySelectorAll('.cell.mk').forEach((el) => {
    const d = days[el.dataset.i], show = () => tipAt(el, fmtDay(d.k), [[label, fmtInt(d.n)]]);
    el.addEventListener('pointerenter', show); el.addEventListener('focus', show);
    el.addEventListener('pointerleave', () => tip.hide()); el.addEventListener('blur', () => tip.hide());
    if (onPick && d.n > 0) { el.style.cursor = 'pointer'; el.addEventListener('click', () => onPick(d)); }
  });
  return { html, table, bind };
}

// ---------- mini-courbe pour une tuile de chiffre ----------
export function sparkline(values, { w = 120, h = 28 } = {}) {
  if (values.length < 2) return '';
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * (w - 6) + 3).toFixed(1)},${(h - 4 - (v / max) * (h - 8)).toFixed(1)}`).join('');
  const last = values.length - 1;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path class="line-soft" d="${pts}"/><circle class="dot" cx="${(w - 3).toFixed(1)}" cy="${(h - 4 - (values[last] / max) * (h - 8)).toFixed(1)}" r="3"/></svg>`;
}
