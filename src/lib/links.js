// Métadonnées des pages liées (titre + description) pour enrichir l'index.
import { decodeEntities } from './text.js';

const BLOCKED_HOSTS = /(^|\.)(x\.com|twitter\.com|t\.co|pic\.twitter\.com)$/i;

// Refuse localhost / réseau privé / IP littérale : on ne sonde jamais le réseau local.
export function isPublicUrl(u) {
  let url;
  try { url = new URL(u); } catch { return false; }
  if (!/^https?:$/.test(url.protocol)) return false;
  const h = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.test(h)) return false;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return false; // IPv4 / IPv6 littérales
  return true;
}

const attr = (tag, name) => {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : '';
};

const absUrl = (u, base) => {
  if (!u) return '';
  try {
    const x = new URL(u, base);
    return /^https?:$/.test(x.protocol) ? x.href : '';
  } catch { return ''; }
};

export function extractMeta(html, base) {
  const head = html.slice(0, 200_000);
  const metas = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(m[0], 'property') || attr(m[0], 'name')).toLowerCase();
    const content = attr(m[0], 'content');
    if (key && content && !(key in metas)) metas[key] = content;
  }
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const title = decodeEntities((metas['og:title'] || metas['twitter:title'] || (t ? t[1] : '')).replace(/\s+/g, ' ').trim());
  const desc = decodeEntities((metas['og:description'] || metas['twitter:description'] || metas['description'] || '').replace(/\s+/g, ' ').trim());
  const image = absUrl(metas['og:image'] || metas['og:image:url'] || metas['twitter:image'] || metas['twitter:image:src'] || '', base);
  const site = decodeEntities((metas['og:site_name'] || '').trim()).slice(0, 60);
  return { title: title.slice(0, 200), description: desc.slice(0, 320), image, site };
}

// fetchFn(url, { signal, credentials }) -> Response. Lit au plus ~300 Ko, 8 s max.
export async function fetchMeta(url, fetchFn = fetch) {
  if (!isPublicUrl(url)) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetchFn(url, { signal: ctl.signal, credentials: 'omit', redirect: 'follow', headers: { accept: 'text/html' } });
    if (!res.ok || !/html/i.test(res.headers.get('content-type') || '')) return null;
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < 300_000) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});
    const html = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
    const meta = extractMeta(html, res.url || url);
    return meta.title || meta.description ? { ...meta, url: res.url || url } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const linkTextOf = (metas) => metas.filter(Boolean).map((m) => [m.title, m.description].filter(Boolean).join(' — ')).join(' | ');

// Carte de lien à afficher (même forme que la carte fournie par X) : { url, title, description, image, site }.
export const cardFromMeta = (url, m) => (m ? { url, title: m.title || '', description: m.description || '', image: m.image || '', site: m.site || '' } : null);
