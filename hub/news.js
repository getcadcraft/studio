/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — data only; hub.js words it. */
/**
 * news.js — What's new from getcadcraft.com, for Studio's What's new card (0.5 SI.5). DOM-free.
 *
 * Two public, anonymous reads (no account, no cookie, nothing about the person sent):
 *   GET https://getcadcraft.com/api/v1/news?limit=8      → the latest news posts and tutorials (title, plain-text summary,
 *                                                          date, app, URL), session live-relay's endpoint
 *   GET https://getcadcraft.com/api/v1/catalog           → downloads.studio.version / downloads.version: the release out now
 * Fetched when Studio opens and again once a day, kept in localStorage so the card still shows them offline. Nothing is
 * downloaded or installed: a newer version is only a line with a link to /download.
 *
 *   const n = newsFeed({ fetch, storage, now });
 *   await n.load({ force })   → { items: [{kind, title, summary, app, date, url}], latest: {version, url} | null,
 *                                at (ms of the last good fetch), offline (the last try failed) }
 *   n.cached()                → the same from storage only
 *   newer(a, b)               → true when version a is newer than b ("0.5" > "0.4.1"; "dev" is never compared)
 *
 * Dismissing the card (owner, 2026-10-15: "allow me to dismiss What's new"): remembered by what was newest when it was
 * dismissed, not per item, so it comes back by itself only when there is something newer:
 *   const d = newsDismissal({ storage, now });
 *   d.dismiss(n, build)       → keeps {at (when), post (the newest post's date then), version (the newest release then),
 *                               build (this Studio's build)}
 *   d.get()                   → that, or null
 *   d.hidden(n, build)        → true while dismissed and nothing is newer: no post dated after both `at` and `post` (a
 *                               clock ahead of this computer's can't bring it straight back), no release newer
 *                               than `version`, the same build (a new build brings new release notes)
 *   d.clear()                 → shown again (Settings › News › Show What's new again)
 *
 * Everything from the network is untrusted: fields are type-checked, text is trimmed and length-capped, links must be
 * https://getcadcraft.com/…, so hub.js can put them on screen with el() and an <a href> as they are.
 */

export const SITE = 'https://getcadcraft.com';
export const DAY = 24 * 3600 * 1000;
const KEY = 'cadcraft.studio.news';
const APPS = ['cadcraft', 'bimcraft', 'modelcraft', 'markupcraft', 'takeoffcraft', 'civilcraft', 'detailcraft', 'partcraft'];

const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const siteUrl = (u) => (typeof u === 'string' && /^https:\/\/getcadcraft\.com\/[A-Za-z0-9/_.~%-]*(\?[A-Za-z0-9=&_.~%-]*)?$/.test(u) ? u : null);
const version = (v) => (typeof v === 'string' && /^\d{1,3}(\.\d{1,3}){1,2}$/.test(v) ? v : null);

export function newer(a, b) {
  if (!version(a) || !version(b)) return false;
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; }
  return false;
}

export function cleanItems(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const it of list.slice(0, 20)) {
    if (!it || typeof it !== 'object') continue;
    const url = siteUrl(it.url);
    const title = text(it.title, 160);
    const t = Date.parse(it.published_at);
    if (!url || !title || !Number.isFinite(t)) continue;
    out.push({ kind: it.kind === 'tutorial' ? 'tutorial' : 'news', title, summary: text(it.summary, 400), app: APPS.includes(it.app) ? it.app : null, date: t, url });
  }
  return out.sort((a, b) => b.date - a.date).slice(0, 8);
}

export function cleanLatest(catalog) {
  const d = catalog && catalog.downloads;
  if (!d || typeof d !== 'object') return null;
  const v = version(d.studio && d.studio.version) || version(d.version);
  return v ? { version: v, url: siteUrl(d.url) || SITE + '/download' } : null;
}

const DISMISS_KEY = 'cadcraft.studio.news.dismissed';
export function newsDismissal({ storage = globalThis.localStorage, now = () => Date.now() } = {}) {
  const get = () => {
    try {
      const j = JSON.parse(storage.getItem(DISMISS_KEY) || 'null');
      if (!j || typeof j !== 'object' || !Number.isFinite(j.at)) return null;
      return { at: j.at, post: Number.isFinite(j.post) ? j.post : 0, version: version(j.version), build: typeof j.build === 'string' ? j.build.slice(0, 200) : '' };
    } catch { return null; }
  };
  return {
    get,
    dismiss(n, build) {
      const v = n && n.latest ? version(n.latest.version) : null;
      const post = Math.max(0, ...(n && Array.isArray(n.items) ? n.items.map((i) => i.date).filter(Number.isFinite) : []));
      try { storage.setItem(DISMISS_KEY, JSON.stringify({ at: now(), post, version: v, build: String(build || '').slice(0, 200) })); } catch { /* private: shown next time */ }
    },
    hidden(n, build) {
      const d = get();
      if (!d) return false;
      if (String(build || '').slice(0, 200) !== d.build) return false;
      const items = n && Array.isArray(n.items) ? n.items : [];
      const since = Math.max(d.at, d.post);
      if (items.some((i) => Number.isFinite(i.date) && i.date > since)) return false;
      const v = n && n.latest ? version(n.latest.version) : null;
      if (v && (!d.version || newer(v, d.version))) return false;
      return true;
    },
    clear() { try { storage.removeItem(DISMISS_KEY); } catch { /* nothing kept */ } },
  };
}

export function newsFeed({ fetch = globalThis.fetch, storage = globalThis.localStorage, now = () => Date.now(), site = SITE } = {}) {
  const read = () => { try { const j = JSON.parse(storage.getItem(KEY) || 'null'); return j && typeof j === 'object' ? j : null; } catch { return null; } };
  const write = (v) => { try { storage.setItem(KEY, JSON.stringify(v)); } catch { /* full or private */ } };
  const view = (c, offline) => ({ items: cleanItems(c && c.items ? c.items.map((i) => ({ ...i, published_at: new Date(i.date).toISOString() })) : []), latest: c && c.latest ? cleanLatest({ downloads: { version: c.latest.version, url: c.latest.url } }) : null, at: (c && c.at) || 0, offline: !!offline });
  const getJson = async (path) => {
    const r = await fetch(site + path, { credentials: 'omit', cache: 'no-cache', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    return j && j.data ? j.data : null;
  };
  return {
    cached: () => view(read(), false),
    async load({ force = false } = {}) {
      const c = read();
      if (!force && c && c.at && now() - c.at < DAY) return view(c, false);
      try {
        const [news, cat] = await Promise.all([getJson('/api/v1/news?limit=8'), getJson('/api/v1/catalog').catch(() => null)]);
        const items = cleanItems(news && news.items);
        const latest = cleanLatest(cat) || (c && c.latest) || null;
        const keep = { at: now(), items: items.map((i) => ({ ...i })), latest };
        write(keep);
        return view(keep, false);
      } catch {
        return view(c, true);
      }
    },
    forget() { try { storage.removeItem(KEY); } catch { /* nothing kept */ } },
  };
}
