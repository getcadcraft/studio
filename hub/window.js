/* SPDX-License-Identifier: Apache-2.0 */
/**
 * window.js — what every app window in Studio carries (docs/0.4-PART2.md H.3, H.11). The suite packer adds it to each
 * app's page (apps/<slug>/index.html); the app's own code is unchanged.
 *
 * - Joins Studio's message channel (channel.js) with a stable window id, so the hub lists the open windows and 0.5's
 *   Studio Live can plug in. `window.cadcraftStudio = {id, app, post(type, data, to), on(type, fn), hub()}` for app code
 *   and add-ons that want it (optional: an app that never reads it works the same).
 * - Puts a "Studio" button in the app bar: back to the hub in one click (desktop: the hub window; browser: the hub's tab).
 * - Answers the hub's "window.focus" message where the platform allows it.
 * - Drag between apps (0.8 EG.78): `window.cadcraftStudio.drag` (window-drag.js).
 * - Undo across apps (0.9 EG.77): forwards the app's `cc-undo-report` steps to the hub and answers its undo.probe / undo.run (see below).
 * - Send to a machine (0.8 EG.40): `window.cadcraftStudio.machines.send({ name, bytes, device })` (machines-ui.js; null outside desktop Studio).
 * Words: #studio-window-lang (the packer embeds the few strings, from hub/lang/<locale>.json "window.*").
 */
import { openChannel, windowId } from './channel.js';
import { createDrag } from './window-drag.js';
import { sendDialog } from './machines-ui.js';

const desk = window.cadcraftDesktop || null;
const app = (document.querySelector('script#cc-edition') && JSON.parse(document.querySelector('script#cc-edition').textContent || '{}').app) || 'app';
// Words: {"en": {...}, "es-MX": {...}} (window.* keys, packed per hub language); the app page's own language picks.
let packed = {};
try { packed = JSON.parse(document.getElementById('studio-window-lang')?.textContent || '{}'); } catch { packed = {}; }
const pageLang = document.documentElement.lang || 'en';
const lang = packed[pageLang] ? pageLang : Object.keys(packed).find((l) => l.split('-')[0] === pageLang.split('-')[0]) || 'en';
const words = Object.assign({}, packed.en || {}, packed[lang] || {});
const T = (k, fb) => (typeof words[k] === 'string' ? words[k] : fb);

async function start() {
  let deskId = null;
  if (desk && typeof desk.info === 'function') { try { deskId = (await desk.info()).windowId || null; } catch { /* older shell */ } }
  const ch = openChannel({ app, id: windowId(app, { desktopId: deskId }), title: document.title });
  const hub = async () => {
    if (desk && desk.windows && typeof desk.windows.focusHub === 'function') { await desk.windows.focusHub(); return; }
    const hubUrl = new URL('../../index.html', location.href).href;
    if (desk) { location.href = hubUrl; return; }   // a shell without suite windows: the app replaced the hub in this window
    let w = null;
    try { w = window.open('', 'cadcraft-studio'); } catch { w = null; }
    if (w) {
      let blank = false;
      try { blank = w.location.href === 'about:blank'; } catch { blank = false; }
      if (blank) w.location.href = hubUrl;
      try { w.focus(); } catch { /* the browser decides */ }
    } else {
      location.href = hubUrl;
    }
  };
  // EG.78: drag between apps (drag.js, window-drag.js): window.cadcraftStudio.drag.start / offer / accept
  const fillWords = (s, v = {}) => String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] === undefined ? m : v[k]));
  const drag = createDrag({ doc: document, win: window, channel: ch, app, T: (k) => T(k, k), fill: fillWords });
  // EG.40: "Send to a machine…" — window.cadcraftStudio.machines.send({ name, bytes, device? }) opens the dialog (desktop Studio only; null elsewhere)
  const machines = desk && desk.machines ? Object.freeze({ send: (o = {}) => sendDialog({ doc: document, T: (k) => T(k, k), desk, name: String(o.name || ''), bytes: o.bytes, device: o.device || null }) }) : null;
  // EG.40 (part-model_PART_4): the one call the apps make, `window.ccSendToMachine({ app, kind, files: [{ name, bytes }], note }) → Promise<{ ok, sent, cancelled?, error? }>`.
  // kind 'gcode' = a CNC / laser / printer program (the dialog lists every machine), 'nc1' = a steel-fabrication NC set (CNC machines only, never a printer).
  // Several files go to the one machine picked in one dialog. A program is uploaded, never started from here unless a printer is confirmed in the dialog.
  if (desk && desk.machines) {
    const sendToMachine = async (o = {}) => {
      const files = (Array.isArray(o.files) ? o.files : []).filter((f) => f && typeof f.name === 'string' && f.bytes instanceof Uint8Array && f.bytes.length);
      if (!files.length) return { ok: false, sent: 0, error: 'no files' };
      const r = await sendDialog({ doc: document, T: (k) => T(k, k), desk, files, device: o.kind === 'nc1' ? 'cnc' : null });
      if (!r) return { ok: false, sent: 0, cancelled: true };
      return { ok: true, sent: r.sent ?? files.length, started: !!r.started };
    };
    Object.defineProperty(window, 'ccSendToMachine', { value: sendToMachine, enumerable: true, configurable: true });
  }
  Object.defineProperty(window, 'cadcraftStudio', { value: Object.freeze({ id: ch.id, app, post: ch.post, on: ch.on, hub, drag, machines }), enumerable: true });
  ch.on('window.focus', () => { try { window.focus(); } catch { /* the browser decides */ } });
  // EG.77 undo across apps (0.9 mounts-09): the app tells its finished steps with the window event `cc-undo-report` (its undo-hook.js); they go to the channel as
  // `edit.done` for the hub's journal. The hub's undo.probe / undo.run reach the app's own reporter (window.ccUndoReporter), and the answer goes back as
  // `undo.reply` with the same rid. A window with no reporter answers null, so the hub does not wait for it.
  window.addEventListener('cc-undo-report', (e) => { const d = e && e.detail; if (d && d.type === 'edit.done') { try { ch.post('edit.done', d.data); } catch { /* closed */ } } });
  for (const type of ['undo.probe', 'undo.run']) {
    ch.on(type, (data, env) => {
      const rid = data && typeof data.rid === 'string' ? data.rid.slice(0, 64) : '';
      if (!rid) return;
      let reply = null;
      try { const rep = window.ccUndoReporter; reply = rep && typeof rep.onMessage === 'function' ? rep.onMessage(type, { step: data.step }) : null; } catch { reply = null; }
      try { ch.post('undo.reply', { rid, reply: reply === undefined ? null : reply }, env.from); } catch { /* closed */ }
    });
  }
  window.addEventListener('pagehide', () => ch.close());
  new MutationObserver(() => { ch.title = document.title; }).observe(document.querySelector('title') || document.head, { childList: true, subtree: true, characterData: true });

  const bar = document.querySelector('.app-bar');
  if (bar && !bar.querySelector('[data-studio-hub]')) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'app-bar-btn app-bar-studio';
    b.setAttribute('data-studio-hub', '');
    b.title = T('window.hub.title', 'Back to CadCraft Studio');
    const i = document.createElement('i');
    i.className = 'bi bi-grid-3x3-gap';
    i.setAttribute('aria-hidden', 'true');
    const s = document.createElement('span');
    s.className = 'app-bar-btn-label';
    s.textContent = T('window.hub', 'Studio');
    b.append(i, s);
    b.addEventListener('click', () => { hub(); });
    const before = bar.querySelector('.app-bar-help, [data-help-open]');
    if (before) bar.insertBefore(b, before); else bar.append(b);
  }

  tablet().catch(() => { /* tablets only; the app works the same without it */ });

  // Studio Live (0.5): the Live button and panel, only in apps whose build has an adapter (live/window-live.js).
  try {
    const { startLive } = await import('./live/window-live.js');
    const api = await startLive({ doc: document, win: window, desk, slug: app, words, locale: lang, channel: ch });
    if (api) Object.defineProperty(window, 'cadcraftStudioLive', { value: api, enumerable: false });
  } catch { /* Live is optional: the app works the same without it */ }
}

/**
 * Tablets (docs/0.5-PART3.md TB.4; the shell says info().mobile): the app's area chip says "Tablet", and the shell's phone
 * module lays the app out (assets/js/app-phone.js, one mechanism for phones and tablets; 0.5 final sweep): told it runs on a
 * tablet, it picks by width — under 600 px the phone layout (panels as sheets from a bar at the bottom), held upright and
 * narrower than 1000 px the tablet sheets (side panels slide in from their edge, a button each in the app bar), never both.
 * Builds without the phone module (frozen releases before 0.5) keep their own layout.
 */
async function tablet() {
  let info = null;
  if (desk && typeof desk.info === 'function') { try { info = await desk.info(); } catch { info = null; } }
  if (!info || !info.mobile) return;
  const root = document.documentElement;
  root.classList.add('is-tablet');
  // The shell's app-shell.js (deferred, later in the page) words it "Desktop": said again once the page has loaded.
  const chip = document.querySelector('.app-bar-area');
  const word = () => { if (chip) chip.textContent = Math.min(innerWidth, innerHeight) < 600 ? T('window.phone', 'Phone') : T('window.tablet', 'Tablet'); };   // a phone says Phone (0.7 IPH.1)
  word();
  // The phone module and the panels module start with the page (deferred): hand over once it has loaded.
  if (document.readyState !== 'complete') await new Promise((r) => addEventListener('load', r, { once: true }));
  word();
  const phone = window.ccShellPhone;
  if (phone && typeof phone.tablet === 'function') phone.tablet(true);
}

start();
