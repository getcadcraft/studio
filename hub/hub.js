/* SPDX-License-Identifier: Apache-2.0 */
/**
 * hub.js — CadCraft Studio's home screen (docs/0.4-PART2.md track H; working name "Studio", decision 13: the name lives in
 * the language file's `studio.name` and `studio.short`, nowhere else). Plain JS, no build step.
 *
 * What it shows: the eight apps as tiles (layer colours, version, Open), SuperCadCraft grayed out, recent files from
 * every app (H.4) and — signed in on the desktop — cloud drawings beside them (C.7), "Open a file…" + a drop zone that
 * route each file to the right app (H.5), the open windows (H.3), the account card (C.7) with the save queue (C.8),
 * what's new and updates (H.7), settings (theme, language, "always use") and help.
 *
 * Data: #studio-suite (suite.json, written by pack/suite.mjs from the Catalog and each app's release.json) and the
 * language catalog in #cc-lang (i18n.js). Every word goes through t(); file contents and names reach the DOM only as
 * text (el()).
 *
 * Opening an app (H.3): desktop (the shell's suite mode) → cadcraftDesktop.windows.open({app, paths, search}), one window
 * per document; browser → a new tab. Handing it a file (H.5/H.6): desktop paths go with the window; browser files go
 * through the same IndexedDB handoff the apps use between themselves (handoff.js), for apps whose build accepts it.
 */
import { t, has, init, locale } from '../assets/js/i18n.js';
import { route, cleanAlways, knownExtensions, extOf } from './route.js';
import { openChannel, windowId } from './channel.js';
import { putHandoff, newHandoffId } from './handoff.js';
import { cloudClient, cardModel, SyncQueue, SIGN_IN_AGAIN, CloudError } from './cloud.js';
import { createHost, recentStore, createControlRelay } from './host.js';
import { wireJoin } from './live/hub-join.js';
import { newsFeed, newsDismissal, newer } from './news.js';
import { avatarStore } from './avatar.js';

const doc = document;
const suite = JSON.parse(doc.getElementById('studio-suite').textContent);
const desk = window.cadcraftDesktop && Number(window.cadcraftDesktop.version) >= 1 ? window.cadcraftDesktop : null;
// Studio on a tablet (TB.4): one window, apps as views; set from the shell's info() at start.
let tablet = false;
const APPS = suite.apps.map((a) => a.slug);
const appBy = Object.fromEntries(suite.apps.map((a) => [a.slug, a]));
const LS = { news: 'cadcraft.studio.news.on', always: 'cadcraft.studio.always', lang: 'cadcraft.studio.lang', filter: 'cadcraft.studio.filter', ws: 'cadcraft.studio.workspace', tab: 'cadcraft.studio.tab' };
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// A language other than the page's, chosen in Settings and packed in #studio-langs.
(() => {
  const want = ls.get(LS.lang);
  if (!want || want === locale()) return;
  try {
    const all = JSON.parse(doc.getElementById('studio-langs')?.textContent || '{}');
    if (all[want]) { init({ locale: want, chain: [want, 'en'], strings: { ...(all.en || {}), ...all[want] } }); doc.documentElement.lang = want; }
  } catch { /* keep the page's */ }
})();

// ------------------------------------------------------------------ helpers

function el(tag, attrs = {}, ...kids) {
  const n = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}
const icon = (name) => el('i', { class: 'bi bi-' + name, 'aria-hidden': 'true' });
const $ = (sel) => doc.querySelector(sel);

function whenText(ms) {
  if (!ms) return '';
  const diff = Math.round((ms - Date.now()) / 1000), abs = Math.abs(diff);
  try {
    const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
    if (abs < 45) return rtf.format(0, 'second');
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    if (abs < 7 * 86400) return rtf.format(Math.round(diff / 86400), 'day');
    return new Date(ms).toLocaleDateString(locale(), { dateStyle: 'medium' });
  } catch { return new Date(ms).toLocaleString(); }
}

let statusTimer = null;
function say(msg, kind = 'info') {
  const s = $('[data-studio-status]');
  if (!s) return;
  s.textContent = msg;
  s.dataset.kind = kind;
  s.hidden = !msg;
  clearTimeout(statusTimer);
  if (msg && kind !== 'error') statusTimer = setTimeout(() => { s.hidden = true; }, 9000);
}

const always = () => cleanAlways(ls.get(LS.always), APPS);
const appName = (slug) => (appBy[slug] ? appBy[slug].name : slug);
const appUrl = (slug) => 'apps/' + slug + '/index.html';
/** An app's role / tagline / short in the hub's language (catalog.<slug>.<field>, packed from the site), else the English. */
const word = (slug, f, en) => (has('catalog.' + slug + '.' + f) ? t('catalog.' + slug + '.' + f) : en);

// ------------------------------------------------------------------ the channel (H.11) and windows (H.3)

const channel = openChannel({ app: 'studio', id: windowId('studio', { desktopId: 'main' }), title: t('studio.name') });
window.name = 'cadcraft-studio';   // app windows find the hub's tab by this name (window.js)
const openWindows = new Map();     // id → {id, app, title}

async function refreshWindows() {
  let list = [];
  if (desk && desk.windows && typeof desk.windows.list === 'function') {
    try { list = (await desk.windows.list()).filter((w) => w.app && w.app !== 'studio' && w.id !== 'main'); } catch { list = []; }
  } else {
    list = (await channel.peers()).filter((w) => APPS.includes(w.app));
  }
  openWindows.clear();
  for (const w of list) openWindows.set(w.id, w);
  renderWindows();
}
channel.on('hello', (d, e) => { if (APPS.includes(e.app)) { openWindows.set(e.from, { id: e.from, app: e.app, title: (d && d.title) || '' }); renderWindows(); } });
channel.on('bye', (d, e) => { if (openWindows.delete(e.from)) renderWindows(); });

/** Open an app window. paths (desktop) and search ("?handoff=…") go with it. Browser: call inside the click. */
async function openApp(slug, { paths = [], search = '' } = {}) {
  if (!appBy[slug]) return null;
  if (desk && desk.windows && typeof desk.windows.open === 'function') {
    // Tablet: Android's Back only hides a view, its work kept. Tapping the app again goes back to that view (its unsaved
    // drawing) rather than starting a second, empty one.
    if (tablet && !paths.length && !search && typeof desk.windows.list === 'function') {
      const open = (await desk.windows.list().catch(() => [])).filter((w) => w.app === slug);
      if (open.length) { await desk.windows.focus(open[open.length - 1].id); return { id: open[open.length - 1].id }; }
    }
    const w = await desk.windows.open({ app: slug, paths, search });
    setTimeout(refreshWindows, 400);
    return w;
  }
  if (desk) {
    // A shell without suite windows yet: the hub's own window becomes the app (the app bar's Studio button comes back).
    location.href = appUrl(slug) + search;
    return { id: 'main' };
  }
  const w = window.open(appUrl(slug) + search, '_blank');
  return w ? { id: null, window: w } : null;
}

/** The browser allows one new tab per click: anything more waits here as a button the person clicks. */
function pending(label, run) {
  const ul = $('[data-pending]');
  const li = el('li', {}, el('button', { type: 'button', class: 'studio-btn studio-btn-sm', onclick: async () => { li.remove(); ul.hidden = !ul.children.length; await run(); } }, label));
  ul.append(li);
  ul.hidden = false;
}

/** Hand a browser File (or Blob with a name) to an app. Inside the click: the tab opens first. */
async function handTo(slug, file) {
  const a = appBy[slug];
  if (!a.accepts_handoff) {
    if (!(await openApp(slug))) { pending(t('open.pending', { app: a.name, file: file.name }), () => handTo(slug, file)); return; }
    say(t('open.manual', { app: a.name, file: file.name }), 'info');
    return;
  }
  const id = newHandoffId();
  const w = await openApp(slug, { search: '?handoff=' + id });
  if (!w) { pending(t('open.pending', { app: a.name, file: file.name }), () => handTo(slug, file)); return; }
  try { await putHandoff(id, file, 'studio'); say(t('open.sent', { app: a.name, file: file.name })); }
  catch { if (w.window) w.window.close(); say(t('open.storage'), 'error'); }
}

// ------------------------------------------------------------------ choosing an app (H.5)

/** Ask which app opens `name` (PDF: review or takeoff). → slug or null. Remembers "always use". */
function askApp(name, r) {
  const dlg = $('[data-ask]');
  const list = dlg.querySelector('[data-ask-apps]');
  const remember = dlg.querySelector('[data-ask-always]');
  // r.noRemember: a question that isn't about a file type (which app a live session is in); `name` is then the question.
  dlg.querySelector('[data-ask-title]').textContent = r.noRemember ? name : t('ask.title', { file: name });
  dlg.querySelector('[data-ask-always-label]').textContent = r.noRemember ? '' : t('ask.always', { ext: '.' + r.ext });
  remember.closest('label').hidden = !!r.noRemember;
  remember.checked = false;
  list.replaceChildren(...r.apps.map((slug) => el('button', { type: 'button', class: 'studio-ask-app layer-' + appBy[slug].layer, value: slug },
    el('span', { class: 'studio-swatch', 'aria-hidden': 'true' }), el('strong', {}, appBy[slug].name), el('span', { class: 'studio-ask-role' }, word(slug, 'role', appBy[slug].role)))));
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); list.replaceChildren(); resolve(v); };
    list.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      if (remember.checked && !r.noRemember) { const a = always(); a[r.ext] = b.value; ls.set(LS.always, JSON.stringify(a)); renderSettingsTypes(); }
      done(b.value);
    }, { once: true }));
    dlg.addEventListener('cancel', () => done(null), { once: true });
    dlg.querySelector('[data-ask-cancel]').onclick = () => done(null);
    dlg.showModal();
  });
}

/** Route one picked/dropped file. `item` = {name, path?, file?}. In the browser this must start inside the gesture. */
async function routeOne(item) {
  const r = route(item.name, { apps: APPS, always: always() });
  if (!r.known || !r.apps.length) { say(t('open.unknown', { file: item.name, ext: r.ext ? '.' + r.ext : '' }), 'error'); return; }
  let slug = r.app;
  if (r.ask) {
    // The choice is a click of its own, so the new tab that follows it is allowed.
    slug = await askApp(item.name, r);
    if (!slug) return;
  }
  if (item.path && desk) { await openApp(slug, { paths: [item.path] }); say(t('open.sent', { app: appName(slug), file: item.name })); return; }
  if (item.file) {
    createHost({ app: slug, recentStore: recents, window: null, document: null }).recent.add({ name: item.name, size: item.file.size, lastModified: item.file.lastModified, path: null, handle: item.handle || null }, 'open').then(renderRecent);
    await handTo(slug, item.file);
  }
}

async function routeMany(items) {
  for (const it of items) await routeOne(it);   // one window per document (H.3)
}

// The open dialog: every type the suite's apps open.
async function pickAndOpen() {
  const exts = knownExtensions(APPS).filter((e) => !e.includes('.'));
  if (desk) {
    const paths = await desk.openDialog({ multiple: true, title: t('open.dialog'), filters: [{ name: t('open.filter'), extensions: exts }] });
    if (paths && paths.length) await routeMany(paths.map((p) => ({ name: String(p).split(/[\\/]/).pop(), path: p })));
    return;
  }
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const hs = await window.showOpenFilePicker({ multiple: true, id: 'studio-open', excludeAcceptAllOption: false,
        types: [{ description: t('open.filter'), accept: { 'application/octet-stream': exts.map((e) => '.' + e) } }] });
      const items = [];
      for (const h of hs) { const f = await h.getFile(); items.push({ name: f.name, file: f, handle: h }); }
      await routeMany(items);
    } catch (e) { if (e && e.name !== 'AbortError') say(t('open.failed'), 'error'); }
    return;
  }
  const inp = el('input', { type: 'file', multiple: true, accept: exts.map((e) => '.' + e).join(','), hidden: true });
  inp.addEventListener('change', () => { routeMany([...inp.files].map((f) => ({ name: f.name, file: f }))); inp.remove(); });
  doc.body.append(inp);
  inp.click();
}

function wireDrop() {
  const zone = $('[data-drop]');
  let depth = 0;
  doc.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { depth++; doc.body.classList.add('is-dropping'); } });
  doc.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) doc.body.classList.remove('is-dropping'); });
  doc.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  doc.addEventListener('drop', async (e) => {
    depth = 0;
    doc.body.classList.remove('is-dropping');
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const dt = e.dataTransfer;
    const items = [...dt.items].filter((i) => i.kind === 'file').map((i) => ({ file: i.getAsFile(), handle: typeof i.getAsFileSystemHandle === 'function' ? i.getAsFileSystemHandle().catch(() => null) : null }));
    const out = [];
    for (const it of items) { if (!it.file) continue; const h = it.handle ? await it.handle : null; out.push({ name: it.file.name, file: it.file, handle: h && h.kind === 'file' ? h : null }); }
    routeMany(out);
  });
  if (zone) zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickAndOpen(); } });
}

// Files the suite was started with, or double-clicked while it runs (desktop: the shell hands them to the hub).
function wireLaunch() {
  if (!desk) return;
  const take = (paths) => routeMany((paths || []).map((p) => ({ name: String(p).split(/[\\/]/).pop(), path: p })));
  if (typeof desk.onOpenFiles === 'function') desk.onOpenFiles(take);
  if (typeof desk.launchFiles === 'function') desk.launchFiles().then(take).catch(() => {});
  // A per-app shortcut ("CadCraft", "BimCraft", … from the Studio installer, `--app=<slug>`): open that app (SD.6).
  const w = desk.windows;
  if (w && typeof w.launchApps === 'function') {
    w.onLaunchApp((slug) => { openApp(slug).catch(() => {}); });
    w.launchApps().then((slugs) => (slugs || []).forEach((slug) => openApp(slug).catch(() => {}))).catch(() => {});
  }
}

// ------------------------------------------------------------------ tiles (H.1)

function renderTiles() {
  const ul = $('[data-tiles]');
  ul.replaceChildren(...suite.apps.map((a) => el('li', { class: 'studio-tile layer-' + a.layer, 'data-app': a.slug },
    el('div', { class: 'studio-tile-head' },
      el('span', { class: 'studio-swatch', 'aria-hidden': 'true' }),
      el('h3', { class: 'studio-tile-name' }, a.name),
      el('span', { class: 'studio-tile-ver', title: t('tile.version.title') }, a.release === 'dev' ? t('tile.dev') : t('tile.version', { v: a.release }))),
    el('p', { class: 'studio-tile-role' }, word(a.slug, 'role', a.role)),
    el('p', { class: 'studio-tile-short' }, word(a.slug, 'short', a.short)),
    el('div', { class: 'studio-tile-foot' },
      el('button', { type: 'button', class: 'studio-btn studio-btn-plot', 'data-open-app': a.slug, onclick: () => openApp(a.slug) }, t('tile.open'), el('span', { class: 'visually-hidden' }, ' ' + a.name)),
      el('span', { class: 'studio-tile-count', 'data-tile-count': a.slug, hidden: true }))),
  ));
  const up = $('[data-upcoming]');
  up.replaceChildren(...(suite.upcoming || []).map((u) => el('div', { class: 'studio-upcoming', 'aria-disabled': 'true' },
    el('h3', {}, u.name), el('p', { class: 'studio-upcoming-role' }, t('upcoming.role')), el('p', {}, word(u.slug, 'short', u.short)), el('span', { class: 'studio-upcoming-tag' }, t('upcoming.tag')))));
}

function renderWindows() {
  const box = $('[data-windows]');
  const list = [...openWindows.values()];
  box.hidden = !list.length;
  for (const a of suite.apps) {
    const n = list.filter((w) => w.app === a.slug).length;
    const c = doc.querySelector(`[data-tile-count="${a.slug}"]`);
    if (c) { c.hidden = !n; c.textContent = t('tile.windows', { n }); }
  }
  // Tablets: the apps are views in Studio's one window, so this list is the switcher, with Close (TB.4).
  const closable = tablet && desk && desk.windows && typeof desk.windows.close === 'function';
  box.querySelector('ul').replaceChildren(...list.map((w) => el('li', { class: 'studio-win layer-' + (appBy[w.app]?.layer || 'blue') },
    el('span', { class: 'studio-swatch', 'aria-hidden': 'true' }),
    el('span', { class: 'studio-win-title' }, w.title || appName(w.app)),
    el('button', { type: 'button', class: 'studio-btn studio-btn-sm', onclick: () => focusWindow(w) }, t('windows.show')),
    closable ? el('button', { type: 'button', class: 'studio-btn studio-btn-sm studio-btn-line', 'data-close-window': w.id, onclick: () => closeView(w) }, t('windows.close')) : null)));
}

/** Tablets: close an app's view; an app with unsaved work is closed only after asking. */
async function closeView(w) {
  let done = await desk.windows.close(w.id).catch(() => false);
  if (!done) {
    const sure = await confirmBox(t('windows.unsaved.title', { app: appName(w.app) }), t('windows.unsaved.body'), t('windows.unsaved.go'));
    if (sure) done = await desk.windows.close(w.id, { force: true }).catch(() => false);
  }
  if (done) refreshWindows();
}

/** A yes/no question in the hub's own dialog. → true when the person chose `go`. */
function confirmBox(title, body, go) {
  const dlg = $('[data-confirm]');
  dlg.querySelector('[data-confirm-title]').textContent = title;
  dlg.querySelector('[data-confirm-body]').textContent = body;
  const goBtn = dlg.querySelector('[data-confirm-go]');
  goBtn.textContent = go;
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); resolve(v); };
    goBtn.onclick = () => done(true);
    dlg.querySelector('[data-confirm-cancel]').onclick = () => done(false);
    dlg.addEventListener('cancel', () => done(false), { once: true });
    dlg.showModal();
  });
}

async function focusWindow(w) {
  if (desk && desk.windows && typeof desk.windows.focus === 'function') { await desk.windows.focus(w.id); return; }
  channel.post('window.focus', null, w.id);
}

// ------------------------------------------------------------------ assistants (X.5): Studio's local MCP server

/** The shell runs the server (127.0.0.1, token, AGENTS-SPEC §6.2); the hub relays each message to the app windows
 *  (host.js createControlRelay) and keeps the server on only while a window takes assistants. Desktop only. */
let relay = null;
const assistSessions = new Set();     // sessions the relay has seen this run (for "Disconnect all")
let assistShow = false;
let assistQueue = Promise.resolve();
const GROUP_WORD = { read: () => t('assist.group.read'), edit: () => t('assist.group.edit'), save: () => t('assist.group.save'), export: () => t('assist.group.export') };

function wireAssistants() {
  if (!desk || !desk.control || typeof desk.control.onRequest !== 'function') return;
  relay = createControlRelay({ channel, onDisconnect: (sid) => { assistSessions.delete(sid); desk.control.dropSession(sid).catch(() => {}); } });
  desk.control.onRequest((message, session, reply) => {
    if (session && session.id) assistSessions.add(session.id);
    relay.handle(message, session || {}).then(reply, () => reply(message && message.id !== undefined
      ? { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Studio could not pass this on.' } } : null));
  });
  const later = () => setTimeout(syncAssist, 0);   // after the relay has read the same message
  channel.on('control.status', later);
  channel.on('bye', later);
  syncAssist();
}

/** Start the server while some window takes assistants, stop it when none does; then redraw the card. */
function syncAssist() {
  assistQueue = assistQueue.then(async () => {
    const want = relay.windows().some((w) => w.enabled);
    let st = {};
    try { st = await desk.control.server(); } catch { st = {}; }
    try {
      if (want && !st.running) await desk.control.start();
      else if (!want && st.running) { await desk.control.stop(); assistSessions.clear(); }
    } catch { /* the card says what is running */ }
    await renderAssist();
  });
  return assistQueue;
}

async function renderAssist() {
  const card = $('[data-assist]');
  const body = card.querySelector('[data-assist-body]');
  card.hidden = false;
  let st = {};
  try { st = await desk.control.server(); } catch { st = {}; }
  const on = relay.windows().filter((w) => w.enabled);
  if (!st.running || !st.token) {
    body.replaceChildren(el('p', {}, t('assist.off')), el('p', { class: 'studio-hint' }, t('assist.how')));
    return;
  }
  const mask = (s) => (assistShow ? s : s.split(st.token).join('•'.repeat(16)));
  const json = JSON.stringify({ mcpServers: { cadcraft: { type: 'http', url: st.url, headers: { Authorization: 'Bearer ' + st.token } } } }, null, 2);
  const copy = (text, label) => el('button', { type: 'button', class: 'studio-btn studio-btn-sm studio-btn-line', onclick: async () => {
    try { await navigator.clipboard.writeText(text); say(t('assist.copied', { what: label })); } catch { say(t('assist.copyfailed'), 'error'); }
  } }, icon('clipboard'), ' ', t('assist.copy'));
  const block = (title, text, attr) => el('div', { class: 'studio-assist-block' },
    el('div', { class: 'studio-assist-head' }, el('strong', {}, title), copy(text, title)),
    el('pre', { class: 'studio-assist-pre', [attr]: true }, mask(text)));
  body.replaceChildren(
    el('p', {}, t('assist.on', { n: on.length })),
    el('ul', { class: 'studio-assist-wins' }, ...on.map((w) => el('li', { class: 'layer-' + (appBy[w.app]?.layer || 'blue') },
      el('span', { class: 'studio-swatch', 'aria-hidden': 'true' }), ' ', el('span', {}, w.title || appName(w.app)), ' ',
      el('span', { class: 'studio-muted' }, '· ', w.groups.map((g) => GROUP_WORD[g]?.() || g).join(', '))))),
    el('dl', { class: 'studio-assist-dl' },
      el('dt', {}, t('assist.url')), el('dd', {}, el('code', { 'data-assist-url': true }, st.url)),
      el('dt', {}, t('assist.token')), el('dd', {}, el('code', { 'data-assist-token': true }, assistShow ? st.token : '•'.repeat(16)), ' ',
        el('button', { type: 'button', class: 'studio-btn studio-btn-sm studio-btn-line', 'data-assist-show': true, 'aria-pressed': String(assistShow),
          onclick: () => { assistShow = !assistShow; renderAssist(); } }, assistShow ? t('assist.hide') : t('assist.show')), ' ',
        copy(st.token, t('assist.token')))),
    block(t('assist.others'), json, 'data-assist-json'),
    el('p', { class: 'studio-hint' }, t('assist.local')),
    el('p', { class: 'studio-hint' }, t('assist.newtoken.hint')),
    el('div', { class: 'studio-btnrow' },
      el('button', { type: 'button', class: 'studio-btn studio-btn-line', 'data-assist-new-token': true, onclick: async () => {
        try { await desk.control.newToken(); assistSessions.clear(); say(t('assist.newtoken.done')); } catch { say(t('assist.failed'), 'error'); }
        renderAssist();
      } }, t('assist.newtoken')),
      el('button', { type: 'button', class: 'studio-btn studio-btn-line', 'data-assist-disconnect': true, onclick: async () => {
        await Promise.all([...assistSessions].map((sid) => desk.control.dropSession(sid).catch(() => false)));
        assistSessions.clear();
        say(t('assist.disconnected'));
      } }, t('assist.disconnect'))));
}

// ------------------------------------------------------------------ recent files (H.4) + cloud drawings (C.7)

const recents = recentStore();
let cloudList = null;      // [{…}] when signed in and listed
let filter = ls.get(LS.filter) || 'all';

async function renderRecent() {
  const box = $('[data-recent]');
  const rows = (await recents.all().catch(() => []))
    .filter((e) => APPS.includes(e.app))
    .sort((a, b) => Math.max(b.openedAt || 0, b.savedAt || 0) - Math.max(a.openedAt || 0, a.savedAt || 0));
  const apps = [...new Set(rows.map((r) => r.app))];
  if (filter !== 'all' && !apps.includes(filter)) filter = 'all';
  const chips = $('[data-recent-filter]');
  chips.hidden = apps.length < 2;
  chips.replaceChildren(...['all', ...apps].map((s) => el('button', { type: 'button', class: 'studio-chip' + (s === 'all' ? '' : ' layer-' + appBy[s].layer), 'aria-pressed': String(filter === s),
    onclick: () => { filter = s; ls.set(LS.filter, s); renderRecent(); } }, s === 'all' ? t('recent.all') : appBy[s].name)));
  const shown = rows.filter((r) => filter === 'all' || r.app === filter).slice(0, 40);
  const ul = box.querySelector('[data-recent-list]');
  $('[data-recent-empty]').hidden = !!rows.length;
  ul.replaceChildren(...shown.map((e) => {
    const can = !!((e.path && desk) || (e.handle && typeof e.handle.getFile === 'function'));
    const msg = el('span', { class: 'studio-row-msg', role: 'status' });
    const where = e.path ? e.path.slice(0, Math.max(0, e.path.length - e.name.length)).replace(/[\\/]$/, '') : '';
    const when = Math.max(e.openedAt || 0, e.savedAt || 0);
    return el('li', { class: 'studio-row layer-' + appBy[e.app].layer, 'data-recent-row': e.id },
      el('button', { type: 'button', class: 'studio-row-open', disabled: !can, title: can ? (e.path || e.name) : t('recent.noreopen'),
        onclick: () => reopen(e, msg) },
        el('span', { class: 'studio-swatch', 'aria-hidden': 'true' }),
        el('span', { class: 'studio-row-name' }, e.name),
        el('span', { class: 'studio-row-app' }, appBy[e.app].name),
        el('span', { class: 'studio-row-when' }, t(e.savedAt && e.savedAt >= (e.openedAt || 0) ? 'recent.saved' : 'recent.opened', { when: whenText(when) })),
        where ? el('span', { class: 'studio-row-where' }, where) : null),
      el('button', { type: 'button', class: 'studio-x', 'aria-label': t('recent.remove', { file: e.name }), title: t('recent.remove', { file: e.name }),
        onclick: async () => { await recents.del(e.id); renderRecent(); } }, icon('x')),
      msg);
  }));
  renderCloudList();
}

async function reopen(e, msg) {
  if (e.path && desk) {
    const st = desk.stat ? await desk.stat(e.path).catch(() => null) : {};
    if (st === null) { msg.textContent = t('recent.gone'); await recents.del(e.id); setTimeout(renderRecent, 1500); return; }
    await openApp(e.app, { paths: [e.path] });
    return;
  }
  if (e.handle) {
    try {
      if (typeof e.handle.queryPermission === 'function') {
        let p = await e.handle.queryPermission({ mode: 'read' });
        if (p === 'prompt') p = await e.handle.requestPermission({ mode: 'read' });
        if (p !== 'granted') { msg.textContent = t('recent.denied'); return; }
      }
      const f = await e.handle.getFile();
      await handTo(e.app, f);
      await recents.put({ ...e, openedAt: Date.now() });
      renderRecent();
    } catch (err) {
      msg.textContent = err && err.name === 'NotFoundError' ? t('recent.gone') : t('recent.denied');
    }
  }
}

function renderCloudList() {
  const sec = $('[data-cloud-files]');
  if (!sec) return;
  sec.hidden = !cloudList;
  if (!cloudList) return;
  const ul = sec.querySelector('ul');
  $('[data-cloud-empty]').hidden = !!cloudList.length;
  const shown = cloudList.filter((d) => APPS.includes(d.app) && (filter === 'all' || d.app === filter)).slice(0, 40);
  ul.replaceChildren(...shown.map((d) => {
    const msg = el('span', { class: 'studio-row-msg', role: 'status' });
    return el('li', { class: 'studio-row layer-' + appBy[d.app].layer },
      el('button', { type: 'button', class: 'studio-row-open', disabled: !d.version, onclick: () => openCloud(d, msg) },
        el('span', { class: 'studio-swatch', 'aria-hidden': 'true' }),
        el('span', { class: 'studio-row-name' }, d.name),
        el('span', { class: 'studio-row-app' }, appBy[d.app].name),
        el('span', { class: 'studio-row-when' }, d.version ? t('cloud.saved', { when: whenText(Date.parse(d.version.saved_at)), n: d.version.no }) : t('cloud.empty.drawing')),
        d.project_name ? el('span', { class: 'studio-row-where' }, d.project_name) : null),
      msg);
  }));
}

async function openCloud(d, msg) {
  msg.textContent = t('cloud.opening');
  try {
    const got = await client.open(d.uuid);
    const ext = { cadcraft: '.dwg', markupcraft: '.pdf', takeoffcraft: '.pdf' }[d.app] || '';
    const name = extOf(d.name) ? d.name : d.name + ext;
    const file = new File([got.bytes], name);
    const id = newHandoffId();
    await putHandoff(id, file, 'studio-cloud');
    if (!(await openApp(d.app, { search: '?handoff=' + id }))) { pending(t('open.pending', { app: appName(d.app), file: name }), () => openApp(d.app, { search: '?handoff=' + id })); }
    msg.textContent = '';
  } catch (e) {
    msg.textContent = cloudMessage(e);
  }
}

// ------------------------------------------------------------------ account card (C.7) + save queue (C.8)

let client = null;
let queue = null;
let acct = { state: 'signed_out' };
let acctRead = false;          // the first read after Studio opens is not "just signed in" (SI.4)
let justSignedIn = false;
let lastAcctRead = 0;
let acctGen = 0;               // refreshAccount calls overlap (sign-out, the shell's change event, focus); the newest one decides
// The shell keeps ONE account listener (bridge.js: account.onChange replaces the previous one), so the hub subscribes once
// and hands the event to each of its parts (the account card, the Join card). Parts never call desk.account.onChange.
const accountListeners = new Set();
if (desk && desk.account && typeof desk.account.onChange === 'function') {
  desk.account.onChange((ev) => { for (const fn of accountListeners) { try { fn(ev); } catch (e) { console.warn('account listener', e); } } });
}
const onAccountChange = (fn) => { accountListeners.add(fn); return () => accountListeners.delete(fn); };
let avatars = null, avatarNow = { big: null, small: null }, avatarUrl = null;
const SITE_URL = 'https://getcadcraft.com';
let model = null;
let lastError = null;

function cloudMessage(e) {
  const code = e && e.code ? e.code : 'error';
  if (SIGN_IN_AGAIN.has(code)) return t('cloud.err.signin');
  if (code === 'sync_closed') return t('cloud.err.closed');
  if (code === 'offline') return t('cloud.err.offline');
  if (code === 'throttled') return t('cloud.err.throttled');
  if (code === 'checksum') return t('cloud.err.checksum');
  return t('cloud.err.other', { code });
}

async function refreshAccount() {
  if (!desk || !desk.account) return;
  const gen = ++acctGen;
  let next;
  try { next = await desk.account.status(); } catch { next = { state: 'signed_out' }; }
  if (gen !== acctGen) return;   // a newer read started meanwhile: it has the newer state and renders
  const was = acct.state;
  acct = next;
  if (acctRead && was !== 'signed_in' && acct.state === 'signed_in') justSignedIn = true;   // SI.4: say who, right away
  if (acct.state !== 'signed_in') justSignedIn = false;
  acctRead = true;
  lastAcctRead = Date.now();
  if (acct.state === 'signed_in') {
    try {
      const status = await client.status();
      // /api/v1/me: the picture (SI.7: whether there is one and when it changed; the bytes come once per change) and the
      // team slugs for the website links (SI.6). Without it the card still shows, links fall back to /account.
      let me = null;
      try { me = await client.me(); } catch { /* offline or refused: the kept picture */ }
      model = cardModel(status, { workspace: ls.get(LS.ws), me });
      try { avatarNow = me && me.user ? await avatars.refresh(me.user.avatar || null) : avatars.cached(); } catch { avatarNow = avatars.cached(); }
      if (avatarUrl) { URL.revokeObjectURL(avatarUrl); avatarUrl = null; }   // made again from the current bytes
      lastError = null;
      queue.resume();
      if (model && model.workspace && model.workspace.open) {
        const r = await client.drawings(model.workspace.uuid);
        cloudList = r.drawings;
      } else cloudList = [];
      queue.flush();
    } catch (e) {
      lastError = e;
      if (e instanceof CloudError && SIGN_IN_AGAIN.has(e.code)) { model = null; cloudList = null; }
    }
  } else { model = null; cloudList = null; if (avatars) avatars.forget(); avatarNow = { big: null, small: null }; if (avatarUrl) { URL.revokeObjectURL(avatarUrl); avatarUrl = null; } }
  if (gen !== acctGen) return;
  await renderAccount();
  renderCloudList();
}

async function renderAccount() {
  const card = $('[data-account]');
  if (!desk || !desk.account) { card.hidden = true; return; }
  const body = card.querySelector('[data-account-body]');
  const q = queue ? await queue.summary() : { waiting: 0, conflict: 0, failed: 0, paused: null };
  const kids = [];
  if (acct.state === 'waiting') {
    kids.push(el('p', {}, t('account.waiting')), acct.code ? el('p', { class: 'studio-code' }, acct.code) : null,
      el('div', { class: 'studio-btnrow' },
        el('button', { type: 'button', class: 'studio-btn', onclick: () => desk.account.open() }, t('account.show')),
        el('button', { type: 'button', class: 'studio-btn studio-btn-line', onclick: async () => { await desk.account.cancel(); refreshAccount(); } }, t('account.cancel'))));
  } else if (acct.state !== 'signed_in' || !model) {
    const why = acct.reason === 'revoked' || (lastError && SIGN_IN_AGAIN.has(lastError.code)) ? t('account.revoked') : null;
    kids.push(why ? el('p', { class: 'studio-warn', role: 'alert' }, why) : null,
      el('p', {}, t('account.pitch')),
      q.waiting ? el('p', {}, t('sync.waiting.signedout', { n: q.waiting })) : null,
      el('div', { class: 'studio-btnrow' }, el('button', { type: 'button', class: 'studio-btn studio-btn-plot', 'data-sign-in': true, onclick: () => desk.account.open() }, t('account.signin'))));
  } else {
    const w = model.workspace;
    if (justSignedIn) {
      // SI.4: right after the browser approved, say whose account this Studio is now on.
      kids.push(el('div', { class: 'studio-signed-notice', role: 'status', 'data-signed-notice': true },
        el('p', {}, t('account.justsigned', { name: model.user.name || model.user.email, email: model.user.email })),
        el('div', { class: 'studio-btnrow' },
          el('button', { type: 'button', class: 'studio-btn studio-btn-sm', 'data-thats-me': true, onclick: () => { justSignedIn = false; renderAccount(); } }, t('account.thatsme')),
          el('button', { type: 'button', class: 'studio-btn studio-btn-sm studio-btn-line', 'data-not-me': true, onclick: () => signOutNow() }, t('account.notyou')))));
    }
    kids.push(el('div', { class: 'studio-who' }, avatarEl(model.user, 'lg'),
      el('div', {}, el('strong', { 'data-who-name': true }, model.user.name || model.user.email), model.user.name ? el('div', { class: 'studio-muted' }, model.user.email) : null)));
    kids.push(el('dl', { class: 'studio-dl' },
      el('dt', {}, t('account.workspace')), el('dd', {}, model.workspaces.length > 1
        ? el('select', { class: 'select-cc studio-select', 'aria-label': t('account.workspace'), onchange: (ev) => { ls.set(LS.ws, ev.target.value); refreshAccount(); } },
          ...model.workspaces.map((x) => el('option', { value: x.uuid, selected: w && x.uuid === w.uuid }, x.name)))
        : (w ? w.name : '—')),
      el('dt', {}, t('account.license')), el('dd', {}, w && w.apps.length ? w.apps.map(appName).join(', ') : t('account.community')),
      el('dt', {}, t('account.storage')), el('dd', {}, w && w.quota ? t('account.storage.used', { used: w.used, quota: w.quota }) : t('account.storage.none'),
        w && w.fraction !== null ? el('span', { class: 'studio-meter', role: 'img', 'aria-label': t('account.storage.used', { used: w.used, quota: w.quota }) }, el('span', { style: 'width:' + Math.round(w.fraction * 100) + '%' })) : null),
      el('dt', {}, t('account.sync')), el('dd', { 'data-sync-state': true }, syncText(q, w))));
    if (q.conflict || q.failed) kids.push(queueList());
    // SI.6: the account, teams and billing live on the website; Studio links there (system browser) and never shows them.
    const team = w && w.kind === 'team' && w.slug ? w.slug : null;
    const site = (label, p, attr) => el('a', { href: SITE_URL + p, target: '_blank', rel: 'noopener noreferrer', class: 'studio-btn studio-btn-sm studio-btn-line', [attr]: true }, label);
    kids.push(el('div', { class: 'studio-btnrow studio-sitelinks' },
      site(t('account.manage'), '/account', 'data-site-account'),
      site(t('account.teams'), team ? '/teams/' + encodeURIComponent(team) : '/account', 'data-site-teams'),
      site(t('account.billing'), team ? '/teams/' + encodeURIComponent(team) + '/licenses' : '/account/add-app', 'data-site-billing')),
      el('p', { class: 'studio-hint' }, t('account.links.hint')));
    kids.push(el('div', { class: 'studio-btnrow' },
      el('button', { type: 'button', class: 'studio-btn studio-btn-line', onclick: () => refreshAccount() }, t('account.refresh')),
      el('button', { type: 'button', class: 'studio-btn studio-btn-line', 'data-sign-out': true, onclick: () => signOutNow() }, t('account.signout'))));
  }
  body.replaceChildren(...kids.filter(Boolean));
  card.hidden = false;   // shown with its content, never as an empty card while the queue is read
  renderBarAvatar();
}

async function signOutNow() {
  const r = await desk.account.signOut().catch(() => null);
  if (r && r.message) say(r.message);
  justSignedIn = false;
  refreshAccount();
}

/** The person's picture (checked as an image in avatar.js), else their initials in a circle — like the site's .avatar-cc. */
function avatarEl(user, size = 'sm') {
  const name = (user && (user.name || user.email)) || '';
  if (avatarNow.big) {
    if (!avatarUrl) avatarUrl = URL.createObjectURL(new Blob([avatarNow.big], { type: 'image/webp' }));
    return el('img', { class: 'studio-avatar is-' + size, src: avatarUrl, alt: '', 'data-avatar': 'picture' });
  }
  const parts = name.split(/[\s@.]+/).filter(Boolean);
  const ini = ((parts[0] || '?')[0] + (parts.length > 1 && user && user.name ? parts[parts.length - 1][0] : '')).toUpperCase();
  return el('span', { class: 'studio-avatar is-' + size, 'aria-hidden': 'true', 'data-avatar': 'initials' }, ini);
}
function renderBarAvatar() {
  const slot = $('[data-bar-avatar]');
  if (!slot) return;
  // Who: the account as the shell keeps it (works offline too), the server's copy when there is one.
  const u = model ? model.user : (acct.user && acct.user.email ? { name: String(acct.user.name || ''), email: String(acct.user.email) } : null);
  const on = !!(desk && desk.account && acct.state === 'signed_in' && u);
  slot.hidden = !on;
  slot.replaceChildren(...(on ? [avatarEl(u, 'sm')] : []));
  if (on) slot.title = t('account.as') + ' ' + (u.name ? u.name + ' (' + u.email + ')' : u.email);
}

function syncText(q, w) {
  if (lastError && lastError.code === 'sync_closed') return t('cloud.err.closed');
  if (w && !w.open) return t('sync.closed.workspace');
  if (!navigator.onLine || (lastError && lastError.code === 'offline')) return q.waiting ? t('sync.offline.waiting', { n: q.waiting }) : t('sync.offline');
  if (q.conflict) return t('sync.conflicts', { n: q.conflict });
  if (q.failed) return t('sync.failed', { n: q.failed });
  if (q.waiting) return t('sync.waiting', { n: q.waiting });
  return t('sync.ok');
}

function queueList() {
  const ul = el('ul', { class: 'studio-queue' });
  queue.list().then((items) => {
    ul.replaceChildren(...items.filter((i) => i.state !== 'waiting').map((i) => el('li', {},
      el('span', {}, i.state === 'conflict' ? t('sync.item.conflict', { file: i.name }) : t('sync.item.failed', { file: i.name, code: i.error || '' })),
      el('button', { type: 'button', class: 'studio-btn studio-btn-sm studio-btn-line', onclick: async () => {
        // Keep it as a copy: a new drawing in the same project, never over the newer version.
        if (i.state === 'conflict' && i.result && i.result.drawing && i.result.drawing.project) {
          await queue.enqueue({ project: i.result.drawing.project, app: i.app, name: t('sync.copyname', { file: i.name }), bytes: i.bytes });
          await queue.remove(i.id);
          queue.flush();
        } else {
          downloadCopy(i);
        }
        renderAccount();
      } }, i.state === 'conflict' ? t('sync.keepcopy') : t('sync.download')),
      el('button', { type: 'button', class: 'studio-btn studio-btn-sm studio-btn-line', onclick: async () => { downloadCopy(i); await queue.remove(i.id); renderAccount(); } }, t('sync.discard')))));
  });
  return ul;
}

/** Local work is never lost: anything leaving the queue is offered as a file first. */
function downloadCopy(i) {
  if (desk && typeof desk.saveDialog === 'function') {
    desk.saveDialog({ defaultPath: i.name, title: t('sync.download') }).then((p) => p && desk.writeFile(p, i.bytes)).catch(() => {});
    return;
  }
  const a = el('a', { href: URL.createObjectURL(new Blob([i.bytes])), download: i.name, hidden: true });
  doc.body.append(a); a.click(); a.remove();
}

/** App windows save to the cloud through the hub (C.8): {drawing | project, app, name, base, bytes, note}. */
function wireCloudChannel() {
  channel.on('cloud.save', async (d, env) => {
    if (!queue || !d || !(d.bytes instanceof Uint8Array)) { channel.post('cloud.refused', { reason: 'unavailable' }, env.from); return; }
    try {
      const item = await queue.enqueue({ drawing: d.drawing || null, project: d.project || null, app: env.app, name: d.name, base: d.base, bytes: d.bytes, note: d.note });
      channel.post('cloud.queued', { id: item.id, saveId: item.saveId }, env.from);
      queue.flush();
    } catch (e) { channel.post('cloud.refused', { reason: 'invalid' }, env.from); }
  });
}

function startCloud() {
  if (!desk || !desk.account || !desk.cloud) return;
  client = cloudClient(desk.cloud);
  avatars = avatarStore({ request: desk.cloud.request });
  avatarNow = avatars.cached();
  // SI.6: back from the website (a new seat, a new team): Studio reads the account again when its window comes forward.
  window.addEventListener('focus', () => { if (acct.state === 'signed_in' && Date.now() - lastAcctRead > 20000) refreshAccount(); });
  queue = new SyncQueue({ client, onChange: (sum, ev) => {
    if (ev && ev.type === 'signin') { lastError = new CloudError(ev.code); refreshAccount(); return; }
    if (ev && ev.type === 'saved' && ev.item) channel.post('cloud.saved', { name: ev.item.name, result: ev.result && ev.result.data });
    if (ev && ev.type === 'conflict' && ev.item) channel.post('cloud.conflict', { name: ev.item.name });
    renderAccount();
  } });
  onAccountChange(() => refreshAccount());
  window.addEventListener('online', () => { lastError = null; queue.flush().then(renderAccount); });
  window.addEventListener('offline', () => renderAccount());
  setInterval(() => { if (acct.state === 'signed_in') queue.flush(); }, 60000);
  wireCloudChannel();
  refreshAccount();
}

// ------------------------------------------------------------------ what's new + updates (H.7)

// News from getcadcraft.com (0.5 SI.5): posts and tutorials first, then the release notes packed into this build. On by
// default; Settings › "Get news from getcadcraft.com" turns it off (nothing is asked of the site then).
const feed = newsFeed();
const newsOn = () => ls.get(LS.news) !== '0';
let studioVersion = null;
// Dismissing the card (owner, 2026-10-15): × in its heading; it stays away until something is newer than what it showed —
// a post published after the dismissal, a newer release, another build (new release notes) — or an update is ready to
// install. Settings › News › "Show What's new again" brings it back. news.js newsDismissal() keeps the mark.
const dismissal = newsDismissal();
const newsBuild = () => String(suite.build || '') + ':' + suite.apps.map((a) => a.slug + '@' + a.release).join(',');
let newsNow = { items: [], latest: null };
let updateReady = false;
function applyNewsCard() {
  const card = $('[data-news-card]');
  if (!card) return;
  const away = !updateReady && dismissal.hidden(newsOn() ? newsNow : { items: [], latest: null }, newsBuild());
  card.hidden = away;
  const back = $('[data-news-show]');
  if (back) back.hidden = !dismissal.get();
}
function wireNewsDismiss() {
  $('[data-news-dismiss]').addEventListener('click', () => {
    dismissal.dismiss(newsOn() ? newsNow : { items: [], latest: null }, newsBuild());
    updateReady = false;
    applyNewsCard();
    say(t('news.dismissed'));
    $('[data-open-settings]').focus();   // the button is gone; Settings is where it comes back
  });
  $('[data-news-show]').addEventListener('click', () => { dismissal.clear(); applyNewsCard(); say(t('settings.news.shown')); });
}
async function renderSiteNews({ force = false } = {}) {
  const box = $('[data-site-news]');
  if (!box) return;
  if (!newsOn()) { box.hidden = true; box.replaceChildren(); newsNow = { items: [], latest: null }; applyNewsCard(); return; }
  if (studioVersion === null) {
    studioVersion = suite.build || '';
    if (desk) { try { studioVersion = String((await desk.info()).version || studioVersion); } catch { /* keep the build */ } }
  }
  const show = (n) => {
    const kids = [];
    if (n.latest && newer(n.latest.version, studioVersion)) {
      kids.push(el('p', { class: 'studio-newer', 'data-newer': n.latest.version }, icon('arrow-up-circle'), ' ', t('news.newer', { v: n.latest.version }), ' ',
        el('a', { href: n.latest.url, target: '_blank', rel: 'noopener noreferrer' }, t('news.newer.link'))));
    }
    if (n.items.length) {
      kids.push(el('ul', { class: 'studio-newslist studio-sitenews', 'data-site-news-list': true }, ...n.items.map((i) => el('li', { class: 'studio-news' + (i.app && appBy[i.app] ? ' layer-' + appBy[i.app].layer : '') },
        el('a', { href: i.url, target: '_blank', rel: 'noopener noreferrer', class: 'studio-news-title' }, i.title), ' ',
        i.kind === 'tutorial' ? el('span', { class: 'studio-news-tag' }, t('news.tutorial')) : null, ' ',
        el('span', { class: 'studio-muted' }, new Date(i.date).toLocaleDateString(locale(), { dateStyle: 'medium' })),
        i.summary ? el('p', {}, i.summary) : null))));
    } else if (!n.at) kids.push(el('p', { class: 'studio-muted' }, n.offline ? t('news.offline.none') : t('news.loading')));
    if (n.offline && n.at) kids.push(el('p', { class: 'studio-hint' }, t('news.offline', { when: whenText(n.at) })));
    kids.push(el('h3', { class: 'studio-h3' }, t('news.notes')));
    box.replaceChildren(...kids);
    box.hidden = false;
    newsNow = n;
    applyNewsCard();
  };
  show(feed.cached());
  show(await feed.load({ force }));
}

async function renderNews() {
  renderSiteNews();
  const ul = $('[data-news]');
  ul.replaceChildren(...suite.apps.map((a) => el('li', { class: 'studio-news layer-' + a.layer },
    el('span', { class: 'studio-swatch', 'aria-hidden': 'true' }),
    el('strong', {}, a.name), ' ', el('span', { class: 'studio-muted' }, a.release === 'dev' ? t('tile.dev') : t('tile.version', { v: a.release })),
    el('p', {}, a.notes ? a.notes : t('news.none')))));
  const box = $('[data-updates]');
  if (!desk) { box.replaceChildren(el('p', {}, t('updates.browser'))); return; }
  let info = {};
  try { info = await desk.info(); } catch { info = {}; }
  if (info.store === true || /^(android|ios|ipados)$/.test(String(info.platform || ''))) { box.replaceChildren(el('p', {}, t('updates.store'))); return; }
  let st = null;
  try { st = desk.updates ? await desk.updates.status() : null; } catch { st = null; }
  if (!st || !st.available) { box.replaceChildren(el('p', {}, t('updates.none'))); return; }
  updateReady = true;   // an update to install brings a dismissed card back
  applyNewsCard();
  const auto = el('input', { type: 'checkbox', id: 'studio-auto-update', checked: !!st.auto, onchange: (e) => desk.updates.setAuto(e.target.checked).catch(() => {}) });
  box.replaceChildren(el('p', {}, t('updates.one')),
    el('div', { class: 'studio-btnrow' }, el('button', { type: 'button', class: 'studio-btn', onclick: async () => {
      say(t('updates.checking'));
      try { const r = await desk.updates.check(); say(r && r.message ? r.message : t('updates.done')); } catch { say(t('updates.failed'), 'error'); }
    } }, t('updates.check'))),
    el('label', { class: 'studio-check', for: 'studio-auto-update' }, auto, ' ', t('updates.auto')));
}

// ------------------------------------------------------------------ offline (browser edition, H.8/H.10)

/** "Save for offline" for the whole suite: one worker (sw.js at the suite's root), a saved copy per key — the hub and
 *  each app — so the apps' own "Save for offline" buttons and this one share the same copies. */
function wireOffline() {
  const card = $('[data-offline]');
  if (desk || !('serviceWorker' in navigator) || !window.caches) { card.hidden = true; return; }
  card.hidden = false;
  const state = card.querySelector('[data-offline-state]');
  const bar = card.querySelector('[data-offline-progress]');
  const saveBtn = card.querySelector('[data-offline-save]');
  const rmBtn = card.querySelector('[data-offline-remove]');
  const jobs = [suite.offline, ...suite.apps.map((a) => ({ key: 'studio/' + a.slug, page: 'apps/' + a.slug + '/', urls: a.offline, name: a.name }))];
  let reg = null;
  const ask = (msg) => new Promise((resolve) => {
    const ch = new MessageChannel();
    const done = [];
    ch.port1.onmessage = (e) => { const m = e.data || {}; if (m.type === 'progress') { bar.hidden = false; bar.max = m.total; bar.value = m.done; return; } done.push(m); resolve(m); };
    reg.active.postMessage(msg, [ch.port2]);
  });
  const status = async () => {
    const st = await Promise.all(jobs.map((j) => ask({ type: 'status', key: j.key })));
    const n = st.filter((x) => x.saved).length;
    rmBtn.hidden = !n;
    state.textContent = n === jobs.length ? t('offline.ready', { when: whenText(Date.parse(st.map((x) => x.when).filter(Boolean).sort()[0])) })
      : n ? t('offline.some', { n: n - (st[0].saved ? 1 : 0), total: jobs.length - 1 }) : t('offline.body');
  };
  // The button waits for the worker: a click before it is ready used to do nothing at all. A worker saved on an earlier visit
  // is used at once: register() checks sw.js on the network first, which can take long (or fail offline) though it is active.
  saveBtn.disabled = true;
  const mine = new URL('./sw.js', location.href).href;
  const use = (r) => { if (reg || !r || !r.active || r.active.scriptURL !== mine) return; reg = r; saveBtn.disabled = false; return status(); };
  navigator.serviceWorker.getRegistration('./').then(use).catch(() => {});
  navigator.serviceWorker.register('./sw.js', { scope: './' }).then(() => navigator.serviceWorker.ready).then(use)
    .catch(() => { if (reg) return; state.textContent = t('offline.unavailable'); saveBtn.disabled = true; });
  saveBtn.addEventListener('click', async () => {
    if (!reg) return;
    saveBtn.disabled = true;
    try {
      for (const j of jobs) {
        state.textContent = t('offline.saving', { what: j.name || t('studio.name') });
        const r = await ask({ type: 'save', key: j.key, page: j.page, urls: j.urls });
        if (r.type !== 'saved') { state.textContent = t('offline.failed', { what: j.name || t('studio.name') }); saveBtn.disabled = false; bar.hidden = true; return; }
      }
      bar.hidden = true;
      await status();
    } finally { saveBtn.disabled = false; }
  });
  rmBtn.addEventListener('click', async () => {
    for (const j of jobs) await ask({ type: 'remove', key: j.key });
    await status();
  });
}

// ------------------------------------------------------------------ settings + help

function setSpace(v) {
  try { if (v === 'system') localStorage.removeItem('cc-space'); else localStorage.setItem('cc-space', v); } catch { /* private */ }
  doc.cookie = v === 'system' ? 'cc_space=; Max-Age=0; Path=/; SameSite=Lax' : 'cc_space=' + v + '; Max-Age=31536000; Path=/; SameSite=Lax';
  const s = v === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'model' : 'paper') : v;
  doc.documentElement.setAttribute('data-space', s);
  channel.post('theme.changed', { space: v });
}

function renderSettingsTypes() {
  const box = $('[data-set-types]');
  const a = always();
  const asks = Object.entries({ pdf: ['markupcraft', 'takeoffcraft'] }).filter(([, apps]) => apps.some((s) => APPS.includes(s)));
  box.replaceChildren(...asks.map(([ext, apps]) => el('label', { class: 'studio-field' },
    el('span', {}, t('settings.types.when', { ext: '.' + ext })),
    el('select', { class: 'select-cc studio-select', 'data-always': ext, onchange: (e) => { const m = always(); if (e.target.value) m[ext] = e.target.value; else delete m[ext]; ls.set(LS.always, JSON.stringify(m)); } },
      el('option', { value: '' }, t('settings.types.ask')),
      ...apps.filter((s) => APPS.includes(s)).map((s) => el('option', { value: s, selected: a[ext] === s }, appName(s)))))));
}

function wireSettings() {
  const dlg = $('[data-settings]');
  const cur = (() => { try { return localStorage.getItem('cc-space') || 'system'; } catch { return 'system'; } })();
  dlg.querySelectorAll('input[name="space"]').forEach((r) => { r.checked = r.value === cur; r.addEventListener('change', () => setSpace(r.value)); });
  const lang = dlg.querySelector('[data-set-lang]');
  const langs = suite.langs || [{ code: 'en', name: 'English' }];
  lang.replaceChildren(...langs.map((l) => el('option', { value: l.code, selected: l.code === locale() }, l.name)));
  lang.disabled = langs.length < 2;
  lang.addEventListener('change', () => { ls.set(LS.lang, lang.value); location.reload(); });
  renderSettingsTypes();
  const news = dlg.querySelector('[data-set-news]');
  news.checked = newsOn();
  news.addEventListener('change', () => { ls.set(LS.news, news.checked ? null : '0'); if (!news.checked) feed.forget(); renderSiteNews({ force: news.checked }); });
  dlg.querySelector('[data-set-forget]').addEventListener('click', () => { ls.set(LS.always, null); renderSettingsTypes(); say(t('settings.types.forgot')); });
  wireInputFamily(dlg);
  wireLayoutReset(dlg);
  wireUiSize(dlg);
  $('[data-open-settings]').addEventListener('click', () => dlg.showModal());
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  doc.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); dlg.open ? dlg.close() : dlg.showModal(); } });
  // Another window changed the theme (the apps share cc-space on this origin).
  window.addEventListener('storage', (e) => { if (e.key === 'cc-space') { const v = e.newValue || 'system'; doc.documentElement.setAttribute('data-space', v === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'model' : 'paper') : v); } });
}

// Menus, keys and mouse in every app (0.5 IP.4; the apps' side is the shell's assets/js/app-input.js): one style family for
// every app, kept in localStorage 'cc-input-family' {family, at} — the hub and every app window share this origin, and an app
// follows a choice made after its own last pick, taking its own member of the family. '' = each app keeps its own style.
const INPUT_FAMILY_KEY = 'cc-input-family';
const INPUT_FAMILIES = ['own', 'menus', 'ribbon', 'classic'];
const INPUT_NAMES = { '': () => t('settings.input.each'), own: () => t('settings.input.own'), menus: () => t('settings.input.menus'), ribbon: () => t('settings.input.ribbon'), classic: () => t('settings.input.classic') };
function readInputFamily() {
  try { const v = JSON.parse(localStorage.getItem(INPUT_FAMILY_KEY) || 'null'); return v && INPUT_FAMILIES.includes(v.family) && Number.isFinite(v.at) ? v.family : ''; } catch { return ''; }
}
function wireInputFamily(dlg) {
  const sel = dlg.querySelector('[data-set-input]');
  if (!sel) return;
  const fill = () => sel.replaceChildren(...['', ...INPUT_FAMILIES].map((f) => el('option', { value: f, selected: f === readInputFamily() }, INPUT_NAMES[f]())));
  fill();
  sel.addEventListener('change', () => {
    if (sel.value) ls.set(INPUT_FAMILY_KEY, JSON.stringify({ family: sel.value, at: Date.now() }));
    else ls.set(INPUT_FAMILY_KEY, null);
    say(t(sel.value ? 'settings.input.on' : 'settings.input.off', { style: INPUT_NAMES[sel.value]() }));
  });
  window.addEventListener('storage', (e) => { if (e.key === INPUT_FAMILY_KEY) fill(); });   // an app chose "Use this style in every app"
}

// Reset the layout in every app (0.6 DF.8; the apps' side is the shell's assets/js/app-settings.js "Reset the layout"):
// localStorage 'cc-layout-reset' {at}. App windows open now follow at once (the storage event); an app opened later resets
// once when it starts. Builds before 0.6 don't read it.
const LAYOUT_RESET_KEY = 'cc-layout-reset';
function wireLayoutReset(dlg) {
  const b = dlg.querySelector('[data-set-layout-reset]');
  if (!b) return;
  b.addEventListener('click', async () => {
    if (!(await confirmBox(t('settings.layout.reset'), t('settings.layout.confirm'), t('settings.layout.go')))) return;
    ls.set(LAYOUT_RESET_KEY, JSON.stringify({ at: Date.now() }));
    say(t('settings.layout.done'));
  });
}

// Interface size of the hub itself (0.6 DF.28): 80–140 %, localStorage 'cadcraft.studio.ui' (index.html applies it before the first
// paint). Each app has its own (Settings › General › Interface size in the app).
const UI_KEY = 'cadcraft.studio.ui';
const UI_SIZES = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4];
function applyUiSize(v) {
  const root = doc.documentElement;
  root.style.setProperty('--studio-ui', String(v));
  root.classList.toggle('studio-ui-sized', v !== 1);
}
function wireUiSize(dlg) {
  const sel = dlg.querySelector('[data-set-ui]');
  if (!sel) return;
  const cur = Number(ls.get(UI_KEY)) || 1;
  sel.replaceChildren(...UI_SIZES.map((v) => el('option', { value: String(v), selected: v === cur }, t(v === 1 ? 'settings.ui.normal' : 'settings.ui.pct', { pct: Math.round(v * 100) }))));
  sel.addEventListener('change', () => {
    const v = Number(sel.value);
    if (!UI_SIZES.includes(v)) return;
    ls.set(UI_KEY, v === 1 ? null : String(v));
    applyUiSize(v);
  });
}

function wireHelp() {
  const dlg = $('[data-help]');
  $('[data-open-help]').addEventListener('click', () => dlg.showModal());
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  doc.addEventListener('keydown', (e) => { if (e.key === 'F1') { e.preventDefault(); dlg.open ? dlg.close() : dlg.showModal(); } });
  const topics = ['start', 'open', 'recent', 'windows', 'live', 'account', 'assistants', 'offline'];
  dlg.querySelector('[data-help-body]').replaceChildren(...topics.filter((k) => k !== 'account' || desk).map((k) => el('section', { class: 'studio-help-topic' },
    el('h3', {}, t('help.' + k + '.title')), el('p', {}, t('help.' + k + '.body')))));
}

// Words that are in the page as data-t attributes (static markup in index.html).
function fillStatic() {
  doc.querySelectorAll('[data-t]').forEach((n) => { const k = n.getAttribute('data-t'); if (k) n.textContent = t(k); });
  doc.querySelectorAll('[data-t-title]').forEach((n) => { n.title = t(n.getAttribute('data-t-title')); });
  doc.querySelectorAll('[data-t-label]').forEach((n) => { n.setAttribute('aria-label', t(n.getAttribute('data-t-label'))); });
  doc.title = t('studio.name');
}

// ------------------------------------------------------------------ start

fillStatic();
if (desk) { const tag = doc.querySelector('[data-t="edition.browser"]'); if (tag) tag.textContent = t('edition.desktop'); }
if (desk && typeof desk.info === 'function') {
  desk.info().then((i) => {
    if (!i || !i.mobile) return;
    tablet = true;
    doc.documentElement.classList.add('is-tablet');
    const tag = doc.querySelector('[data-t="edition.browser"]');
    if (tag) tag.textContent = t('edition.tablet');
    const wt = doc.getElementById('studio-win-h');
    if (wt) wt.textContent = t('windows.title.tablet');
    renderWindows();
  }).catch(() => {});
}
renderTiles();
wireNewsDismiss();
applyNewsCard();
renderNews();
wireDrop();
wireSettings();
wireHelp();
wireOffline();
wireAssistants();
doc.querySelectorAll('[data-open-file]').forEach((b) => b.addEventListener('click', () => pickAndOpen()));
$('[data-drop]').addEventListener('click', (e) => { if (!e.target.closest('button')) pickAndOpen(); });
doc.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); pickAndOpen(); } });
renderRecent();
window.addEventListener('focus', () => renderRecent());
doc.addEventListener('visibilitychange', () => { if (!doc.hidden) { renderRecent(); refreshWindows(); } });
setInterval(() => renderSiteNews(), 3600000);   // the feed itself asks the site at most once a day
refreshWindows();
if (desk && desk.windows && typeof desk.windows.onChange === 'function') desk.windows.onChange(() => refreshWindows());
wireLaunch();
startCloud();
const join = wireJoin({ doc, win: window, desk, onAccountChange, t, say, openApp, askApp, appBy, apps: APPS });
if (!desk || !desk.account) $('[data-account]').hidden = true;
doc.documentElement.classList.add('studio-ready');

// For tests and add-ons: what the hub decided, never the person's files.
window.cadcraftStudioHub = Object.freeze({ suite, route: (name) => route(name, { apps: APPS, always: always() }), channel, openApp, refreshWindows, renderRecent, refreshAccount, queue: () => queue, join: (text) => join && join.go(text) });
