#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// desktop.mjs — Studio inside the real desktop shell (session `desktop`'s debug build, WebKitGTK via WebKitWebDriver),
// signed in to the live getcadcraft.com with the site's own test member (set up by a helper that stays with the site:
// $CADCRAFT_SITE/tools/studio-test/cloud-helper.php).
// Checks C.7 (the account card: who, workspace, license, storage, sync state; cloud drawings beside recent files),
// C.8 (saves from an app window go through the hub's queue: sent; a conflict is kept, never overwritten, and can be
// saved as a copy; signed out on the website → the hub says so and the save waits; signed in again → sent), and,
// when the shell has suite mode (cadcraftDesktop.windows), H.3/H.5 windows.
//   dbus-run-session -- xvfb-run -a node test/desktop.mjs [--shots <dir>] [--verbose]
// Needs: the suite (node pack/suite.mjs), CADCRAFT_SHELL = the desktop shell's folder with its debug build
// (src-tauri/target/debug/cadcraft-desktop), CADCRAFT_SITE = the site's folder, WebKitWebDriver, gnome-keyring (the
// shell keeps its sign-in in the OS credential store).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { SUITE, SITE, SHELL, need, ok, section, done } from './lib.mjs';

need(SHELL, 'CADCRAFT_SHELL', 'the desktop shell\'s folder (its debug build runs Studio)');
need(SITE, 'CADCRAFT_SITE', 'the site\'s folder (its test helper signs the shell in)');
const HELPER = path.join(SITE, 'tools/studio-test/cloud-helper.php');
if (!fs.existsSync(HELPER)) { console.error('no site helper at ' + HELPER); process.exit(1); }
const BIN = path.join(SHELL, 'src-tauri/target/debug/cadcraft-desktop');
const SHOTS = process.argv.includes('--shots') ? path.resolve(process.argv[process.argv.indexOf('--shots') + 1]) : null;
if (!fs.existsSync(BIN)) { console.error('no shell build at ' + BIN); process.exit(1); }
const helper = (...a) => JSON.parse(execFileSync('sudo', ['-u', 'www-data', 'php', HELPER, ...a]).toString());

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-studio-desktop-'));
// The shell's credential store needs a Secret Service: a private gnome-keyring, as desktop's own e2e does.
let keyring = [];
if (process.env.DBUS_SESSION_BUS_ADDRESS && fs.existsSync('/usr/bin/gnome-keyring-daemon')) {
  const env = { ...process.env, XDG_DATA_HOME: path.join(tmp, 'keyring') };
  const pids = () => { try { return execFileSync('pgrep', ['-x', 'gnome-keyring-d']).toString().split('\n').filter(Boolean); } catch { return []; } };
  const before = new Set(pids());
  execFileSync('/usr/bin/gnome-keyring-daemon', ['--login'], { env, input: 'e2e', stdio: ['pipe', 'ignore', 'ignore'] });
  execFileSync('/usr/bin/gnome-keyring-daemon', ['--start', '--components=secrets'], { env, stdio: 'ignore' });
  keyring = pids().filter((p) => !before.has(p));
  await new Promise((r) => setTimeout(r, 1500));
  try { execFileSync('gdbus', ['call', '--session', '--dest', 'org.freedesktop.secrets', '--object-path', '/org/freedesktop/secrets',
    '--method', 'org.freedesktop.Secret.Service.SetAlias', 'default', '/org/freedesktop/secrets/collection/login'], { stdio: 'ignore' }); } catch { /* default already */ }
}

// Stage: the suite as the shell's app/ folder, shell.json beside it (suite: true).
const stage = path.join(tmp, 'stage');
fs.cpSync(SUITE('dev'), path.join(stage, 'app'), { recursive: true });
for (const f of ['sw.js', '.htaccess', 'web.config']) fs.rmSync(path.join(stage, 'app', f), { force: true });
fs.writeFileSync(path.join(stage, 'shell.json'), JSON.stringify({ app: 'studio', name: 'CadCraft Studio', version: 'dev', suite: true, headers: {} }));

let PORT = 4900 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const wd = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(`${url}: ${j.value.error}: ${j.value.message}`);
  return j.value;
};
const driver = spawn('WebKitWebDriver', [`--port=${PORT}`], { stdio: 'ignore', env: { ...process.env, TAURI_WEBVIEW_AUTOMATION: 'true',
  CADCRAFT_DESKTOP_ROOT: path.join(stage, 'app'), XDG_DATA_HOME: path.join(tmp, 'data'), XDG_CONFIG_HOME: path.join(tmp, 'config'), XDG_CACHE_HOME: path.join(tmp, 'cache') } });
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 250)); } return false; };

const fx = helper('up');
let id = null;
try {
  await waitFor(async () => (await fetch(BASE + '/status')).ok, 30000);
  id = (await wd('POST', '/session', { capabilities: { alwaysMatch: { 'webkitgtk:browserOptions': { binary: BIN, args: [] } } } })).sessionId;
  await wd('POST', `/session/${id}/timeouts`, { script: 90000 });
  const run = async (body, ...a) => {
    const script = `const __done = arguments[arguments.length - 1];
      (async (...args) => { ${body} })(...Array.prototype.slice.call(arguments, 0, -1))
        .then((r) => __done({ ok: true, r }), (e) => __done({ ok: false, e: String((e && e.message) || e) }));`;
    const v = await wd('POST', `/session/${id}/execute/async`, { script, args: a });
    if (!v.ok) throw new Error(v.e);
    return v.r;
  };
  const text = (sel) => run(`return (document.querySelector(args[0]) || {}).textContent || '';`, sel);
  const shot = async (n) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, n + '.png'), Buffer.from(await wd('GET', `/session/${id}/screenshot`), 'base64')); } };

  section('The hub in the desktop shell');
  ok(await waitFor(() => run(`return document.documentElement.classList.contains('studio-ready');`)), 'the hub starts in the shell');
  const env = await run(`return {bridge: !!window.cadcraftDesktop, windows: !!(window.cadcraftDesktop && window.cadcraftDesktop.windows), href: location.href,
    tag: document.querySelector('.studio-bar-tag').textContent, offline: document.querySelector('[data-offline]').hidden, acct: document.querySelector('[data-account]').hidden};`);
  ok(env.bridge && env.href.startsWith('cadcraft://localhost/'), 'served by the shell, with the bridge');
  ok(env.tag === 'Desktop' && env.offline === true, 'the bar says Desktop; no "Save for offline" (the desktop app is local already)');
  ok(env.acct === false && /Sign in/.test(await text('[data-account]')), 'the account card offers to sign in');
  ok(/no update feed|new installer/.test(await text('[data-updates]')), 'updates: says plainly this build has no feed');
  await shot('desktop-01-signed-out');

  section('Signing in (C.7)');
  const w = await run(`return await window.cadcraftDesktop.account.signIn();`);
  ok(w.state === 'waiting' && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(w.code || ''), 'a short code (the shell\'s own flow)');
  await run(`await window.cadcraftStudioHub.refreshAccount(); return true;`);
  ok(/Approve the code/.test(await text('[data-account]')) && (await text('[data-account] .studio-code')) === w.code, 'the card shows it is waiting, with the code');
  ok(helper('approve', w.code).code === 'ok', 'approved on the website');
  ok(await waitFor(async () => (await run(`return (await window.cadcraftDesktop.account.status()).state;`)) === 'signed_in', 30000), 'signed in');
  await run(`await window.cadcraftStudioHub.refreshAccount(); return true;`);
  await waitFor(async () => /Signed in as/.test(await text('[data-account]')), 15000);
  const card = await text('[data-account]');
  ok(card.includes('Studio Test') && card.includes(fx.email), 'card: signed in as (name + email)');
  ok(/License\s*CadCraft/.test(card), 'card: the license (CadCraft)');
  ok(/of .* used/.test(card) && /Up to date/.test(card), 'card: storage used of the pool, sync up to date: ' + card.replace(/\s+/g, ' ').slice(0, 200));
  ok(await waitFor(async () => /Studio plan\.dxf/.test(await text('[data-cloud-files]'))), 'cloud drawings sit next to recent files');
  await shot('desktop-02-signed-in');

  section('Saving through the hub (C.8)');
  const v0 = helper('versions', fx.drawing).versions[0];
  const save = (base, name = 'Studio plan.dxf') => run(`
    const { openChannel } = await import('./hub/channel.js');
    const ch = openChannel({ app: 'cadcraft', id: 'cadcraft-test' + Math.random().toString(36).slice(2, 8) });
    const reply = new Promise((res) => { ch.on('cloud.queued', (d) => res(d)); ch.on('cloud.refused', (d) => res({ refused: d })); setTimeout(() => res(null), 5000); });
    ch.post('cloud.save', { drawing: args[0], base: args[1], name: args[2], bytes: new TextEncoder().encode('0\\nEOF\\n' + Date.now()) });
    const r = await reply; ch.close(); return r;`, fx.drawing, base, name);
  const q1 = await save(v0);
  ok(q1 && q1.saveId, 'an app window\'s save is queued by the hub (message channel)');
  ok(await waitFor(async () => helper('versions', fx.drawing).versions[0] === v0 + 1, 20000), `sent: version ${v0 + 1} on the website`);
  helper('bump', fx.drawing);                                         // someone else saves meanwhile
  await save(v0 + 1);                                                 // started from the old version
  ok(await waitFor(async () => /meet|newer version/.test(await text('[data-account]')), 20000), 'a conflict: the card says so');
  const vs = helper('versions', fx.drawing).versions;
  ok(vs[0] === v0 + 2, 'nothing was overwritten (the newer version is still the latest)');
  await shot('desktop-03-conflict');
  await run(`[...document.querySelectorAll('[data-account] button')].find((b) => /as a copy/.test(b.textContent)).click(); return true;`);
  ok(await waitFor(async () => /Studio plan\.dxf \(my copy\)/.test(await run(`const r = await window.cadcraftDesktop.cloud.request({path: '/api/v1/sync/drawings?workspace=' + args[0]}); return JSON.stringify(r.json().data.drawings.map((d) => d.name));`, fx.workspace)), 20000),
    '"Save mine as a copy": a new drawing beside it');
  ok(await waitFor(async () => /Up to date/.test(await text('[data-account]')), 20000), 'and the card is up to date again');

  section('Signed out on the website (C.8)');
  helper('revoke');
  await save(helper('versions', fx.drawing).versions[0]);
  ok(await waitFor(async () => /signed out on the website/i.test(await text('[data-account]')), 20000), 'the hub says so and asks to sign in again');
  ok(/waiting for you to sign in/.test(await text('[data-account]')), 'the save waits on this computer');
  await shot('desktop-04-revoked');
  const w2 = await run(`return await window.cadcraftDesktop.account.signIn();`);
  helper('approve', w2.code);
  const vBefore = helper('versions', fx.drawing).versions[0];
  ok(await waitFor(async () => (await run(`return (await window.cadcraftDesktop.account.status()).state;`)) === 'signed_in', 30000), 'signed in again');
  await run(`await window.cadcraftStudioHub.refreshAccount(); return true;`);
  ok(await waitFor(async () => helper('versions', fx.drawing).versions[0] === vBefore + 1, 20000), 'the waiting save is sent');

  section('Windows (H.3) — needs the shell\'s suite mode');
  if (env.windows) {
    const opened = await run(`await window.cadcraftStudioHub.openApp('cadcraft'); await new Promise((r) => setTimeout(r, 1500)); return await window.cadcraftDesktop.windows.list();`);
    ok(opened.some((x) => x.app === 'cadcraft'), 'Open → a CadCraft window of its own');
    ok(await waitFor(async () => (await run(`return document.querySelectorAll('[data-windows] li').length;`)) >= 1, 10000), 'the hub lists it under open windows');
    const cad = opened.find((x) => x.app === 'cadcraft');
    ok(await run(`await window.cadcraftDesktop.windows.focus(args[0]); return true;`, cad.id), 'Show → the shell brings that window forward');
  } else {
    console.log('  · skipped: the shell has no cadcraftDesktop.windows yet (asked of `desktop`)');
  }

  section('Connect an assistant (X.5)');
  if (env.windows && await run(`return !!window.cadcraftDesktop.control;`)) {
    ok(/Settings › Assistants/.test(await text('[data-assist]')) && !(await run(`return (await window.cadcraftDesktop.control.server()).running;`)),
      'no window takes assistants: the card says how, and the local server is off');
    // A stand-in app window that takes assistants (host.control's side of the channel): one tool, answers each request.
    await run(`
      const { openChannel } = await import('./hub/channel.js');
      const ch = openChannel({ app: 'cadcraft', id: 'cadcraft-assist' + Math.random().toString(36).slice(2, 8), title: 'Plan.dxf — CadCraft' });
      const status = (to) => ch.post('control.status', { app: 'cadcraft', title: 'Plan.dxf — CadCraft', enabled: true, groups: ['read'], tools: 1, focusedAt: Date.now() }, to);
      ch.on('control.who', (d, e) => status(e.from));
      ch.on('control.request', (d, e) => {
        const m = d.message;
        const answer = m.method === 'tools/list' ? { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'drawing_info', title: 'Drawing info', description: 'x', inputSchema: { type: 'object', properties: {} } }] } }
          : { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'Plan.dxf: 1 line' }] } };
        ch.post('control.response', { rid: d.rid, answer }, e.from);
      });
      status(null);
      window.__assistWin = ch; return true;`);
    ok(await waitFor(async () => (await run(`return (await window.cadcraftDesktop.control.server()).running;`)), 10000), 'a window takes assistants → the server starts');
    const srv = await run(`return await window.cadcraftDesktop.control.server();`);
    ok(await waitFor(async () => (await text('[data-assist-url]')) === srv.url), 'the card shows the address');
    const card = await text('[data-assist]');
    ok(!card.includes(srv.token) && /Plan\.dxf/.test(card) && /"mcpServers"/.test(card) && !/mcp add/.test(card), 'the token stays hidden until Show; the window and the MCP settings are listed');
    await run(`document.querySelector('[data-assist-show]').click(); return true;`);
    ok(await waitFor(async () => (await text('[data-assist-token]')) === srv.token), 'Show reveals the token');
    await shot('desktop-05-assistant');
    const mcp = async (body, sid) => {
      const r = await fetch(srv.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + srv.token, ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
      return { status: r.status, sid: r.headers.get('mcp-session-id'), json: r.status === 200 ? await r.json() : null };
    };
    const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'studiotest', version: '1' } } });
    ok(init.status === 200 && init.sid && init.json.result.serverInfo.name === 'cadcraft-studio', 'an assistant connects (initialize, through the hub)');
    const list = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, init.sid);
    const names = (list.json?.result?.tools || []).map((x) => x.name);
    ok(names.includes('windows_list') && names.includes('drawing_info'), 'tools/list: Studio\'s windows_list + the window\'s own tools: ' + names.join(', '));
    const call = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'drawing_info', arguments: {} } }, init.sid);
    ok(call.json?.result?.content?.[0]?.text === 'Plan.dxf: 1 line', 'a tool call reaches the app window and its answer comes back');
    ok((await fetch(srv.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: '{}' })).status === 401, 'a wrong token is refused');
    await run(`document.querySelector('[data-assist-disconnect]').click(); return true;`);
    ok(await waitFor(async () => (await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, init.sid)).status === 404, 10000), 'Disconnect all: the session is gone');
    await run(`document.querySelector('[data-assist-new-token]').click(); return true;`);
    ok(await waitFor(async () => (await run(`return (await window.cadcraftDesktop.control.server()).token;`)) !== srv.token, 10000), 'New token: the old one stops working');
    await run(`window.__assistWin.close(); return true;`);
    ok(await waitFor(async () => !(await run(`return (await window.cadcraftDesktop.control.server()).running;`)), 10000), 'the window closes → the server stops');
  } else {
    console.log('  · skipped: the shell has no cadcraftDesktop.control (X.5)');
  }

  section('Sign out');
  await run(`[...document.querySelectorAll('[data-account] button')].find((b) => b.hasAttribute('data-sign-out')).click(); return true;`);
  ok(await waitFor(async () => helper('tokens').active === 0, 15000) && await waitFor(async () => /Sign in/.test(await text('[data-account]'))), 'sign out ends it on the website too; the card offers sign-in again');
} catch (e) {
  ok(false, e.message);
} finally {
  if (id) await wd('DELETE', `/session/${id}`).catch(() => {});
  driver.kill();
  for (const p of keyring) { try { process.kill(Number(p)); } catch { /* gone */ } }
  helper('down');
  fs.rmSync(tmp, { recursive: true, force: true });
}
done();
