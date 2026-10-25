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
 * Words: #studio-window-lang (the packer embeds the few strings, from hub/lang/<locale>.json "window.*").
 */
import { openChannel, windowId } from './channel.js';

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
  Object.defineProperty(window, 'cadcraftStudio', { value: Object.freeze({ id: ch.id, app, post: ch.post, on: ch.on, hub }), enumerable: true });
  ch.on('window.focus', () => { try { window.focus(); } catch { /* the browser decides */ } });
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
