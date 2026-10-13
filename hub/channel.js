/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — protocol only, no words. */
/**
 * channel.js — the one message channel between Studio's windows (docs/0.4-PART2.md H.11; the hook for 0.5 Studio Live,
 * docs/STUDIO-LIVE-SPEC.md). Every window — the hub and each app window — has a stable window id and talks to the others
 * only through this channel, never through ad hoc calls between windows, so 0.5's session server can plug in here
 * (a relay that forwards the same envelopes over the network). No networking in 0.4.
 *
 *   const ch = openChannel({ app: 'cadcraft' });       // or { app: 'studio' } for the hub
 *   ch.id                                              // "cadcraft-3f9a…" (desktop: the shell's window id)
 *   ch.post('file.opened', { name }, to?)              // to = a window id, or omitted = everyone
 *   const off = ch.on('file.opened', (data, env) => …) // env = {v, id, from, app, to, type, data, at}
 *   await ch.peers()                                   // [{id, app, title}] of the windows answering now
 *   ch.close()
 *
 * Transport: BroadcastChannel "cadcraft-studio" (every window of the suite shares the origin: browser tabs, and the
 * desktop shell's windows). Without BroadcastChannel, localStorage "storage" events carry the same envelopes.
 * Envelope (v 1): {v: 1, id (message id), from (window id), app, to (window id | null), type, data, at (ms)}.
 * Types the channel itself uses: "hello" (a window opened), "bye" (it closed), "who" → "here" (peers()).
 * Types are lower-case words with dots ("cloud.save"); data must survive structured clone (no functions).
 */

export const CHANNEL = 'cadcraft-studio';
export const VERSION = 1;
const TYPE_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

const rnd = () => {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().replace(/-/g, '').slice(0, 12);
  return Math.random().toString(36).slice(2, 14);
};

/** This window's id: the desktop shell's when it gives one, else kept for the life of the tab (sessionStorage), so a
 *  reload keeps the same id. */
export function windowId(app, { storage = safeSession(), desktopId = null } = {}) {
  const slug = String(app || 'window').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'window';
  if (desktopId && ID_RE.test(String(desktopId).toLowerCase())) return String(desktopId).toLowerCase();
  const key = 'cadcraft.studio.window.' + slug;
  try {
    const have = storage && storage.getItem(key);
    if (have && ID_RE.test(have)) return have;
    const id = slug + '-' + rnd();
    if (storage) storage.setItem(key, id);
    return id;
  } catch { return slug + '-' + rnd(); }
}

function safeSession() { try { return globalThis.sessionStorage || null; } catch { return null; } }
function safeLocal() { try { return globalThis.localStorage || null; } catch { return null; } }

/** A valid envelope or null (messages come from any window of the origin: checked like any input). */
export function cleanEnvelope(m) {
  if (!m || typeof m !== 'object' || m.v !== VERSION) return null;
  if (typeof m.type !== 'string' || !TYPE_RE.test(m.type) || m.type.length > 80) return null;
  if (typeof m.from !== 'string' || !ID_RE.test(m.from)) return null;
  if (m.to !== null && m.to !== undefined && (typeof m.to !== 'string' || !ID_RE.test(m.to))) return null;
  if (typeof m.id !== 'string' || m.id.length > 40) return null;
  return { v: VERSION, id: m.id, from: m.from, app: typeof m.app === 'string' ? m.app.slice(0, 40) : '', to: m.to || null,
    type: m.type, data: m.data === undefined ? null : m.data, at: Number.isFinite(m.at) ? m.at : 0 };
}

/** Transport over BroadcastChannel, else localStorage events, else nothing (a lone window). */
function transport({ BC = globalThis.BroadcastChannel, storage = safeLocal(), win = globalThis.window } = {}) {
  if (typeof BC === 'function') {
    const bc = new BC(CHANNEL);
    let fn = null;
    bc.onmessage = (e) => fn && fn(e.data);
    return { kind: 'broadcast', send: (m) => bc.postMessage(m), listen: (f) => { fn = f; }, close: () => bc.close() };
  }
  if (storage && win && typeof win.addEventListener === 'function') {
    const key = CHANNEL + ':msg';
    let fn = null;
    const onStorage = (e) => { if (e.key === key && e.newValue && fn) { try { fn(JSON.parse(e.newValue)); } catch { /* not ours */ } } };
    win.addEventListener('storage', onStorage);
    return { kind: 'storage', send: (m) => { try { storage.setItem(key, JSON.stringify(m)); storage.removeItem(key); } catch { /* full */ } },
      listen: (f) => { fn = f; }, close: () => win.removeEventListener('storage', onStorage) };
  }
  return { kind: 'none', send: () => {}, listen: () => {}, close: () => {} };
}

export function openChannel({ app, id = null, title = '', now = () => Date.now(), ...t } = {}) {
  const me = id || windowId(app);
  const tr = transport(t);
  const handlers = new Map();
  const seen = new Set();
  const env = (type, data, to) => ({ v: VERSION, id: rnd(), from: me, app: String(app || ''), to: to || null, type, data: data === undefined ? null : data, at: now() });
  const ch = {
    id: me, app, kind: tr.kind, title,
    post(type, data, to) {
      if (!TYPE_RE.test(type)) throw new Error('channel: bad message type ' + JSON.stringify(type));
      const m = env(type, data, to);
      tr.send(m);
      return m.id;
    },
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type).delete(fn);
    },
    /** Windows answering "who" within `waitMs`. */
    peers(waitMs = 250) {
      return new Promise((resolve) => {
        const found = new Map();
        const off = ch.on('here', (d, e) => { if (e.to === me) found.set(e.from, { id: e.from, app: e.app, title: (d && d.title) || '' }); });
        ch.post('who', null);
        setTimeout(() => { off(); resolve([...found.values()]); }, waitMs);
      });
    },
    close() { try { tr.send(env('bye', null)); } catch { /* closing */ } tr.close(); handlers.clear(); },
  };
  tr.listen((raw) => {
    const m = cleanEnvelope(raw);
    if (!m || m.from === me || (m.to && m.to !== me) || seen.has(m.id)) return;
    seen.add(m.id);
    if (seen.size > 500) seen.delete(seen.values().next().value);
    if (m.type === 'who') { tr.send(env('here', { title: ch.title }, m.from)); }
    for (const fn of handlers.get(m.type) || []) { try { fn(m.data, m); } catch { /* a handler */ } }
    for (const fn of handlers.get('*') || []) { try { fn(m.data, m); } catch { /* a handler */ } }
  });
  tr.send(env('hello', { title }));
  return ch;
}
