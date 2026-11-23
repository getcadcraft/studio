/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — protocol and developer messages; the person's words are in the hub card and the Ask box. */
/**
 * ask-engine.js — Studio's AI engine, passed down to every app (owner 2026-11-20: "AI belongs to Studios and passes down to apps").
 * The engine (./byok.mjs, the tested tools/mcp/byok.mjs) is Studio's: one copy, in Studio's package, never in an app build. Studio's own
 * window script (window.js, which Studio adds to every app page) calls passDown() so the app's Ask box finds the engine on the page;
 * nothing is added by the person and no add-on is involved. From 0.10 to this change the app-side half lived in the "Your own AI key"
 * add-on; that add-on is now the same engine for ONE app in a browser, without Studio.
 *
 * Where the key is. Studio's hub window keeps it in the computer's credential store and is the only window that can use it
 * (desktop-shell ask_keys.rs). An app window asks the hub, over Studio's window channel, to make one provider call
 * ('ask.call' → 'ask.result': the status and the JSON body come back, never the key). A window that holds the native commands itself
 * (a host with one window, such as SuperCad Studio) can call them directly: nativeTransport(desk).
 * The settings and the spending ledger are plain localStorage shared by every window of the suite, so the limits count every app
 * together. They are the same two entries as before: nothing is moved or copied.
 *
 * The seam on the page (the shell's assets/js/app-ai-ownkey.js reads it; it holds no provider code):
 *   globalThis.ccAskEngines = [{ id: 'studio', host: true, name, settingsKey, engine({ studio, store }) → an ask-style engine | null }]
 *   'cc-ask-engines' on the window whenever the list changes
 *
 *   studioEngine({ studio, desk, store, now, name }) → the engine, or null when the person has not set up a model (no stored settings)
 *   passDown({ g, studio, desk, name }) → off()     registers the engine for this window's Ask box
 *   channelTransport(studio) · nativeTransport(desk) · hasSettings(store) · SETTINGS_KEY · LEDGER_KEY · PROVIDER_ID
 */
import { createByok } from './byok.mjs';

export const PROVIDER_ID = 'studio';
export const SETTINGS_KEY = 'cadcraft.studio.byok.settings';
export const LEDGER_KEY = 'cadcraft.studio.byok.ledger';
const json = (store, key, d) => { try { const v = JSON.parse(store.getItem(key) || 'null'); return v === null ? d : v; } catch { return d; } };
export const hasSettings = (store = globalThis.localStorage) => { try { return store.getItem(SETTINGS_KEY) !== null; } catch { return false; } };
const isChannel = (s) => !!s && typeof s.post === 'function' && typeof s.on === 'function';
const isNative = (d) => !!d && !!d.ask && typeof d.ask.call === 'function';

/** A transport that sends one provider call to the hub and waits for its answer. */
export function channelTransport(studio, { timeoutMs = 130000, uid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36) } = {}) {
  return function call({ provider, baseUrl, keyName, request, signal }) {
    return new Promise((resolve) => {
      const id = uid();
      let done = false, off = () => {};
      const finish = (v) => { if (done) return; done = true; clearTimeout(timer); off(); if (signal) signal.removeEventListener('abort', onAbort); resolve(v); };
      const onAbort = () => finish({ status: 0, error: 'aborted' });
      const timer = setTimeout(() => finish({ status: 0, error: 'timeout' }), timeoutMs);
      off = studio.on('ask.result', (d) => { if (d && d.id === id) finish({ status: Number(d.status) || 0, json: d.json === undefined ? null : d.json, ...(d.error ? { error: String(d.error) } : {}) }); });
      if (signal) { if (signal.aborted) { finish({ status: 0, error: 'aborted' }); return; } signal.addEventListener('abort', onAbort, { once: true }); }
      try { studio.post('ask.call', { id, call: { provider, baseUrl, keyName, request } }, typeof studio.hub === 'function' ? studio.hub() : undefined); } catch { finish({ status: 0, error: 'unreachable' }); }
    });
  };
}

/** A transport for a window that holds the native key commands itself: the native side adds the key and returns only status + JSON. */
export function nativeTransport(desk) {
  return async function call({ provider, baseUrl, keyName, request, signal }) {
    if (signal && signal.aborted) return { status: 0, error: 'aborted' };
    try {
      const r = await desk.ask.call({ provider, baseUrl, keyName, path: request && request.path, headers: request && request.headers, body: request && request.body });
      return { status: Number(r && r.status) || 0, json: r && r.json !== undefined ? r.json : null, ...(r && r.error ? { error: String(r.error).slice(0, 80) } : {}) };
    } catch { return { status: 0, error: 'native_failed' }; }   // never the exception's words: they could hold anything the store said
  };
}

export function studioEngine({ studio = globalThis.cadcraftStudio, desk = null, store = globalThis.localStorage, now, name = 'Your own model' } = {}) {
  const viaHub = isChannel(studio), direct = !viaHub && isNative(desk);
  if ((!viaHub && !direct) || !hasSettings(store)) return null;
  const settings = { get: () => json(store, SETTINGS_KEY, {}) };
  const ledger = { get: () => json(store, LEDGER_KEY, []), set: (v) => { try { store.setItem(LEDGER_KEY, JSON.stringify(v)); } catch { /* full or private */ } } };
  // the key never reaches this window: has() / set() / delete() are the hub card's job, and a call without a key answers 'no_key'
  const keystore = { async has() { return true; }, async set() { throw new Error('The key is set in Studio, in Your own AI model.'); }, async delete() {}, async _get() { return null; } };
  const eng = createByok({ settings, ledger, keystore, transport: viaHub ? channelTransport(studio) : nativeTransport(desk), ...(now ? { now } : {}) });
  return { name, kind: 'byok', ask: (o) => eng.ask(o), check: eng.check, usage: eng.usage };
}

/** Studio hands its engine to this window's Ask box. Returns off(), which takes it away again. */
export function passDown({ g = globalThis, studio = g.cadcraftStudio, desk = null, name = 'Your own model' } = {}) {
  if (!isChannel(studio) && !isNative(desk)) return () => {};
  if (!Array.isArray(g.ccAskEngines)) g.ccAskEngines = [];
  const list = g.ccAskEngines;
  const provider = {
    id: PROVIDER_ID, host: true, name, settingsKey: SETTINGS_KEY,
    engine: (o = {}) => { let store = o.store; if (!store) { try { store = g.localStorage; } catch { store = null; } } return store ? studioEngine({ studio: o.studio || studio, desk, store, name }) : null; },
  };
  for (let i = list.length - 1; i >= 0; i--) if (list[i] && list[i].id === PROVIDER_ID) list.splice(i, 1);
  list.push(provider);
  const changed = () => { try { g.dispatchEvent(new CustomEvent('cc-ask-engines')); } catch { /* no window (a test in Node) */ } };
  changed();
  return () => { const i = list.indexOf(provider); if (i >= 0) list.splice(i, 1); changed(); };
}
