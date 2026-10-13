/* SPDX-License-Identifier: Apache-2.0 */
/*
 * sw.js — "Save for offline" for CadCraft Studio's browser edition (docs/0.4-PART2.md H.8). One worker for the whole
 * suite folder (the hub and every app under apps/<slug>/), because the apps share the libraries at the suite's root.
 * Speaks the same messages as the single-app edition's sw.js (assets/js/app-offline.js sends them unchanged):
 * {type: 'status' | 'save' | 'remove', key, page?, urls?}. Keys: "studio/hub" and "studio/<slug>".
 *
 * Each key has its own caches "cc-suite:<scope>|<key>@<time>": saving one app never drops another app's copy, and a
 * failed save keeps the last good one. URLs in a save are relative to the suite's folder. Requests: pages (the suite's
 * index.html, apps/<slug>/ or apps/<slug>/index.html) network first, any saved copy offline; files whose folder name
 * holds a version (assets/vendor/<lib>/<x.y.z>/, …/assets/apps/<slug>/<x.y>/) a saved copy first; others network
 * first. Anything outside the folder, or not a GET, is never touched.
 */
'use strict';

const SCOPE = new URL(self.registration.scope);
const PREFIX = 'cc-suite:' + SCOPE.pathname + '|';
const IMMUTABLE = /^(apps\/[a-z0-9-]+\/)?assets\/(vendor\/[a-z0-9._-]+\/\d[^/]*\/|apps\/[a-z0-9-]+\/\d[^/]*\/)/;
const KEY_RE = /^[a-z0-9-]+\/[a-z0-9.-]+$/;

const inScope = (url) => url.origin === SCOPE.origin && url.pathname.startsWith(SCOPE.pathname);
const rel = (url) => url.pathname.slice(SCOPE.pathname.length);
const isPage = (url) => inScope(url) && /^(|index\.html|apps\/[a-z0-9-]+\/(index\.html)?)$/.test(rel(url));
/** apps/x/ and apps/x/index.html are one page. */
const pageKey = (url) => { const u = new URL(url); u.search = ''; u.hash = ''; if (u.pathname.endsWith('/')) u.pathname += 'index.html'; return u.href; };
const metaUrl = (key) => new URL('__offline-meta/' + key.replace('/', '-'), SCOPE).href;
const cachesOf = async (key) => (await caches.keys()).filter((k) => key ? k.startsWith(PREFIX + key + '@') : k.startsWith(PREFIX));

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

async function saved(req, loose = true) {
  for (const k of await cachesOf(null)) {
    const c = await caches.open(k);
    const hit = await c.match(req) || (loose ? await c.match(req, { ignoreSearch: true }) : null);
    if (hit) return { hit, cache: c };
  }
  return null;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!inScope(url)) return;
  if (req.mode === 'navigate' && isPage(url)) {
    e.respondWith((async () => {
      const page = pageKey(url);
      const copy = await saved(new Request(page));
      try {
        const res = await fetch(req);
        if (copy && res.ok && !res.redirected) copy.cache.put(page, res.clone());
        return res;
      } catch (err) {
        if (copy) return copy.hit;
        throw err;
      }
    })());
    return;
  }
  e.respondWith((async () => {
    if (IMMUTABLE.test(rel(url))) {
      const exact = await saved(req, false);
      if (exact) return exact.hit;
    }
    try {
      return await fetch(req);
    } catch (err) {
      const near = await saved(req);
      if (near) return near.hit;
      throw err;
    }
  })());
});

self.addEventListener('message', (e) => {
  const msg = e.data || {};
  const port = e.ports && e.ports[0];
  const reply = (m) => { try { port ? port.postMessage(m) : e.source.postMessage(m); } catch (_) {} };
  const key = typeof msg.key === 'string' && KEY_RE.test(msg.key) ? msg.key : null;
  if (!key) return;

  if (msg.type === 'status') {
    e.waitUntil((async () => {
      let when = null;
      for (const k of await cachesOf(key)) {
        const meta = await (await caches.open(k)).match(metaUrl(key));
        if (meta) when = (await meta.json()).saved || when;
      }
      reply({ type: 'status', key, saved: when !== null, when });
    })());
  }

  if (msg.type === 'remove') {
    e.waitUntil((async () => {
      for (const k of await cachesOf(key)) await caches.delete(k);
      reply({ type: 'removed', key });
    })());
  }

  if (msg.type === 'save' && Array.isArray(msg.urls) && typeof msg.page === 'string') {
    e.waitUntil((async () => {
      const resolve = (u) => { try { const x = new URL(u, SCOPE); return inScope(x) ? x.href : null; } catch { return null; } };
      const page = resolve(msg.page);
      const urls = [...new Set([page ? pageKey(page) : null, ...msg.urls.filter((u) => typeof u === 'string').map(resolve)].filter(Boolean))];
      const older = await cachesOf(key);
      const name = PREFIX + key + '@' + Date.now();
      const tmp = await caches.open(name);
      let done = 0;
      const failed = [];
      const queue = urls.slice();
      const worker = async () => {
        while (queue.length) {
          const u = queue.shift();
          try {
            const res = await fetch(u, { cache: 'no-cache', credentials: 'same-origin' });
            if (!res.ok || res.redirected) throw new Error(String(res.status));
            await tmp.put(u, res);
          } catch (err) {
            failed.push(rel(new URL(u)));
          }
          done++;
          if (done % 5 === 0 || done === urls.length) reply({ type: 'progress', key, done, total: urls.length });
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (failed.length) {
        await caches.delete(name);
        reply({ type: 'failed', key, failed: failed.slice(0, 5), count: failed.length });
        return;
      }
      await tmp.put(metaUrl(key), new Response(JSON.stringify({ saved: new Date().toISOString(), files: urls.length }), { headers: { 'Content-Type': 'application/json' } }));
      for (const k of older) await caches.delete(k);
      reply({ type: 'saved', key, files: urls.length });
    })());
  }
});
