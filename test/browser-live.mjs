#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * browser-live.mjs — Studio Live in Studio's windows, in Chromium, against the real session server (0.5 LV.6 invites,
 * LV.7 joining, LV.23 invite links). The server is live-core's headless `live-server` (the Rust code Studio runs), which
 * also serves the packed suite on the session's port, as Studio does (LIVE-PROTOCOL § 12). Studio's Rust side
 * (cadcraftDesktop.live: the in-process channel, sockets, mDNS, the relay) is stood in for by a small page script, so
 * this checks everything above it: the Live button and panel, the code + QR + countdown, the approve card, the people
 * list, roles, remove, one-time codes, three wrong codes rotating the code, the hub's Join card, invite links (the site's
 * licence message shown as it is; a link made, joined over the LAN with its secret, renewed, stopped), End and Leave;
 * assistants as their own session clients (LV.18: the host's own in at once, its edit and its own undo, an editor's
 * approved by the host, disconnect), and joining from a window that has the host's file open (LV.8: no snapshot).
 *
 *   CADCRAFT_SITE=<site> node test/browser-live.mjs [--suite <packed suite folder>] [--shots <dir>] [--verbose]
 *
 * Needs: a packed suite with CadCraft's live.js (default out/studio-suite/vdev), playwright-core + Chromium, and
 * <site>/tools/live-test/server/target/release/live-server (cargo build --release there).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, SUITE, SITE, need, ok, section, done } from './lib.mjs';

need(SITE, 'CADCRAFT_SITE', "the getcadcraft.com site's folder");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const suite = path.resolve(arg('--suite', SUITE('dev')));
const shots = arg('--shots', null);
if (shots) fs.mkdirSync(shots, { recursive: true });
const bin = path.join(SITE, 'tools/live-test/server/target/release/live-server');
if (!fs.existsSync(bin)) { console.error('no live-server: cargo build --release in ' + path.join(SITE, 'tools/live-test/server')); process.exit(1); }
if (!fs.existsSync(path.join(suite, 'apps/cadcraft/index.html'))) { console.error('no packed suite at ' + suite); process.exit(1); }
const devDir = fs.readdirSync(path.join(suite, 'apps/cadcraft/assets/apps/cadcraft'))[0];
if (!fs.existsSync(path.join(suite, 'apps/cadcraft/assets/apps/cadcraft', devDir, 'live.js'))) { console.error('the suite\'s CadCraft has no live.js (repack it)'); process.exit(1); }

await import(path.join(SITE, 'tools/live-crypto/node-hook.mjs'));
const Crypto = await import(path.join(SITE, 'public_html/assets/js/live-crypto.js'));
const { LiveClient, webSocketTransport } = await import(path.join(SITE, 'public_html/assets/js/live-client.js'));
const { toyAdapter } = await import(path.join(SITE, 'tools/live-test/toy-adapter.mjs'));

const TOKEN = 'studio-test-' + Math.random().toString(36).slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = spawn(bin, ['--bind', '127.0.0.1:0', '--app', 'cadcraft', '--token', TOKEN, '--www', suite], { stdio: ['pipe', 'pipe', 'inherit'] });
const { addr } = JSON.parse(await new Promise((res) => readline.createInterface({ input: srv.stdout }).once('line', res)));
const PORT = Number(addr.split(':').pop());
const base = `http://127.0.0.1:${PORT}/`;
const appUrl = base + 'apps/cadcraft/index.html';
const clientMod = `/apps/cadcraft/assets/apps/cadcraft/${devDir}/live-client.js`;

// The stand-in for Studio's Rust side (cadcraftDesktop.live; contract in docs/0.5-sessions/desktop.md, 2026-10-14).
const bridge = ({ token, clientMod, store = false }) => {
  window.__liveLog = [];
  window.__cloudCalls = [];
  addEventListener('DOMContentLoaded', () => { import(location.origin + clientMod).then((m) => { window.__lc = m; }); });
  const fixHello = (b) => { const m = window.__lc.unpack(b); if (m.t === 'hello') { m.b.token = token; return window.__lc.pack(m); } return b; };
  const live = {
    transport(kind, opts) {
      const url = kind === 'local' ? (window.__localUrl || 'ws://' + location.host + '/live') : opts.url;
      window.__liveLog.push(['transport', kind, kind === 'local' ? '' : url]);
      return (h) => {
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        let first = kind === 'local';
        ws.onopen = () => h.open();
        ws.onmessage = (e) => { if (typeof e.data !== 'string') h.message(new Uint8Array(e.data)); };
        ws.onclose = (e) => h.close('closed', e.code);
        return { send(b) { if (ws.readyState !== 1) return; if (first) { first = false; b = fixHello(b); } ws.send(b); }, close() { try { ws.close(); } catch { /* closed */ } } };
      };
    },
    session: async () => ({ running: true, port: window.__localUrl ? Number(new URL(window.__localUrl).port) : Number(location.port), addrs: ['127.0.0.1'], app: 'cadcraft' }),
    // LV.17: the test starts `live-server --from <state>` for this page (Studio starts it in-process).
    startFrom: async (bytes) => {
      window.__liveLog.push(['startFrom', bytes.length]);
      const r = await window.__startFrom(Array.from(bytes));
      window.__localUrl = 'ws://127.0.0.1:' + r.port + '/live';
      return { running: true, port: r.port, addrs: ['127.0.0.1'], app: 'cadcraft' };
    },
    advertise: async (what, o) => { window.__liveLog.push(['advertise', what, o && o.app]); },
    unadvertise: async (what) => { window.__liveLog.push(['unadvertise', what]); },
    browse: async (what, ms) => { window.__liveLog.push(['browse', what, ms]); return window.__browse ? window.__browse(what) : []; },
    relay: async (url, ticket) => { window.__liveLog.push(['relay', url, !!ticket]); },
    relayStop: async () => { window.__liveLog.push(['relayStop']); },
  };
  const cloud = {
    request: async (o) => {
      window.__cloudCalls.push([o.method, o.path, o.body ? new TextDecoder().decode(o.body) : null]);
      const r = window.__cloud ? window.__cloud(o) : { status: 401, json: { code: 'invalid_token' } };
      return { status: r.status, headers: {}, body: new Uint8Array(0), json: () => r.json };
    },
  };
  // A store build has no account and no cloud (bridge.js deletes them: shell.json account:false).
  // window.__acct switches the account mid-test; window.__acctChanged() is what the shell's onChange would fire.
  const acctCbs = [];
  window.__acctChanged = () => acctCbs.forEach((f) => f());
  const account = { status: async () => window.__acct || ({ state: 'signed_out' }), onChange(f) { acctCbs.push(f); } };
  Object.defineProperty(window, 'cadcraftDesktop', { value: Object.freeze({ version: 1, info: async () => ({ shell: 'test', platform: 'linux', suite: true, store, windowId: 'w-' + Math.random().toString(36).slice(2) }), live, ...(store ? {} : { cloud, account }) }), enumerable: true });
};

const browser = await chromium();
// The hub's news (SI.5) would ask the real getcadcraft.com: answered here instead (the test runs offline from the site).
const offSite = (ctx) => ctx.route((u) => u.hostname !== '127.0.0.1', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"data":{"items":[]}}' }));
const errors = [];
const extraServers = [];
async function page(name, extra = '', { store = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await offSite(ctx);
  await ctx.addInitScript(`(${bridge})(${JSON.stringify({ token: TOKEN, clientMod, store })});${extra}`);
  await ctx.exposeFunction('__startFrom', async (arr) => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-live-state-')), 'state.bin');
    fs.writeFileSync(f, Buffer.from(arr));
    const p = spawn(bin, ['--bind', '127.0.0.1:0', '--app', 'cadcraft', '--token', TOKEN, '--www', suite, '--from', f], { stdio: ['pipe', 'pipe', 'inherit'] });
    extraServers.push(p);
    const a = JSON.parse(await new Promise((res) => readline.createInterface({ input: p.stdout }).once('line', res))).addr;
    return { port: Number(a.split(':').pop()) };
  });
  const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error') errors.push(name + ': ' + m.text()); });
  p.on('pageerror', (e) => errors.push(name + ': ' + e.message));
  return p;
}
const shot = async (p, n) => { if (shots) await p.screenshot({ path: path.join(shots, n + '.png') }); };
const until = async (p, fn, arg, what, ms = 10000) => { try { await p.waitForFunction(fn, arg, { timeout: ms }); return true; } catch { console.log('  (timed out: ' + what + ')'); return false; } };
const nodeClients = [];
function nodeJoin(name, opts) {
  const c = new LiveClient(Object.assign({ transport: webSocketTransport(`ws://127.0.0.1:${PORT}/live`), adapter: toyAdapter(name), name, device: 'node', crypto: Crypto, secure: true }, opts));
  c.seen = [];
  c.on('status', (s) => c.seen.push(s.status + (s.reason ? ':' + s.reason : '')));
  nodeClients.push(c);
  c.connect();
  return c;
}
const nodeUntil = async (c, cond, ms = 8000) => { const t0 = Date.now(); while (!cond(c)) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };

try {
  section('Hosting: Share live, the code, the QR (LV.6)');
  const A = await page('host');
  await A.goto(appUrl);
  await until(A, () => window.cadcraft && window.cadcraft.doc && document.querySelector('[data-studio-live]'), null, 'CadCraft + the Live button', 20000);
  ok(await A.$('[data-studio-live]'), 'the Live button is in the app bar (CadCraft has an adapter)');
  await A.click('[data-studio-live]');
  ok(await A.isVisible('[data-live-panel]'), 'it opens the Live panel');
  ok(await A.isVisible('[data-live-share]') && (await A.textContent('[data-live-panel]')).includes('Local codes are free. Invite links need a commercial license'), 'Share live, with the free / licensed note');
  await A.fill('[data-live-name]', 'Ana Host');
  await A.dispatchEvent('[data-live-name]', 'change');
  await A.evaluate(() => { const d = window.cadcraft.doc; d.change('LINE', () => d.add({ type: 'line', layer: '0', x1: 0, y1: 0, x2: 100, y2: 0 })); });
  await A.click('[data-live-share]');
  await until(A, () => document.querySelector('[data-live-code]'), null, 'a code');
  const code = (await A.textContent('[data-live-code]')).trim();
  ok(/^[0-9A-HJKMNP-TV-Z]{2}-[0-9A-HJKMNP-TV-Z]{5}$/.test(code), 'a short code is shown: ' + code.slice(0, 2) + '-•••••');
  ok(await A.$('svg.sl-qr path'), 'with its QR');
  const cd = await A.textContent('[data-live-countdown]');
  ok(/Expires in (9|10):\d\d/.test(cd), 'and the countdown: ' + cd);
  ok((await A.textContent('[data-live-panel]')).includes('127.0.0.1:' + PORT), 'and the address it holds');
  const log = await A.evaluate(() => window.__liveLog);
  ok(log.some((l) => l[0] === 'advertise' && l[1] === code.slice(0, 2) && l[2] === 'cadcraft'), 'the code\'s tag is advertised on the network (the tag only, with the app)');
  ok(!JSON.stringify(log).includes(code.slice(3)), 'the code\'s secret part never goes to the bridge');
  ok((await A.title()).indexOf(code.slice(3)) < 0, 'nor into the window title');
  await shot(A, '01-host-code');

  section('Signed-in names on the approve card (LV.19, SI.8)');
  // The session server will pass `aud` (asked of live-core); until then the cards are fed here as the server would send them.
  const helper = path.join(SITE, 'tools/studio-test/account-helper.php');
  const sh = (...a) => JSON.parse(spawnSync('sudo', ['-u', 'www-data', 'php', helper, ...a], { encoding: 'utf8' }).stdout.trim().split('\n').pop());
  sh('session');
  const AUD = 'test-aud-' + Math.random().toString(36).slice(2, 14);
  const signed = sh('assertion', AUD);
  ok(signed.ok && /^v1\./.test(signed.assertion), 'the site signs a name for this session binding');
  const forged = signed.assertion.slice(0, -3) + (signed.assertion.endsWith('AAA') ? 'BBB' : 'AAA');
  const junkPic = [137, 80, 78, 71, 1, 2, 3, 4];
  await A.evaluate(({ a, f, aud, pic }) => {
    const c = window.cadcraftStudioLive.client;
    const u8 = Uint8Array.from(pic);
    c.emit('join', { c: 9001, name: 'Signed Sam', device: 'laptop', via: 'relay', kid: 'K7QX9M2B', assertion: a, aud, picture: u8 });
    c.emit('join', { c: 9002, name: 'Forged Fay', device: 'laptop', via: 'lan', kid: 'K7', assertion: f, aud });
    c.emit('join', { c: 9003, name: 'Other Ola', device: 'laptop', via: 'lan', kid: 'K7', assertion: a, aud: aud + 'x' });
    c.emit('join', { c: 9004, name: 'Guest Gus', device: 'phone', via: 'lan', kid: 'K7', picture: u8 });
  }, { a: signed.assertion, f: forged, aud: AUD, pic: junkPic });
  await until(A, () => document.querySelectorAll('[data-live-card]').length >= 4 && document.querySelector('[data-live-verified="9001"]'), null, 'four cards, one ticked');
  ok((await A.textContent('[data-live-verified="9001"]').catch(() => '')).includes('Signed in to getcadcraft.com as Studio <Tester> & Co'), 'a valid assertion: "Signed in to getcadcraft.com as <the account\'s name>" (as text)');
  ok(!(await A.$('[data-live-picture="9001"]')), 'its picture isn\'t the one the assertion names (none here): initials, not the picture');
  ok(!(await A.$('[data-live-verified="9002"]')) && (await A.textContent('[data-live-card="9002"]')).includes('Not signed in'), 'a forged signature: no tick, "Not signed in"');
  ok(!(await A.$('[data-live-verified="9003"]')), 'a real assertion from another session (wrong aud): no tick');
  ok(!(await A.$('[data-live-picture="9004"]')) && !(await A.$('[data-live-verified="9004"]')), 'a guest\'s picture is never shown: initials');
  await shot(A, '01b-host-signed-names');
  for (const n of [9001, 9002, 9003, 9004]) await A.click(`[data-live-card="${n}"] [data-live-deny]`);
  ok(!(await A.$('[data-live-card]')), 'denied: the cards go');
  sh('down');

  section('Joining from the hub (LV.7)');
  const B = await page('joiner', `window.__browse = (tag) => tag === ${JSON.stringify(code.slice(0, 2))} ? [{ addr: '127.0.0.1', port: ${PORT}, app: 'cadcraft' }] : [];`);
  await B.goto(base + 'index.html');
  await until(B, () => document.documentElement.classList.contains('studio-ready') && !document.querySelector('[data-live-join]').hidden, null, 'the Join card');
  ok(await B.isVisible('[data-live-join]'), 'the hub has a Join a live session card');
  // One box for a code or an invite link; the card names what was pasted (owner, 2026-10-14).
  ok((await B.textContent('[data-live-join] label span')).trim() === 'Code or invite link', 'the box says "Code or invite link"');
  await B.fill('[data-live-join-input]', 'K7-Q4M2X');
  ok(/A local code: works on this network only/.test(await B.textContent('[data-live-join-kind]')), 'a code is named as a code (this network)');
  await B.fill('[data-live-join-input]', 'https://getcadcraft.com/live/K7QX9M2B#AAAAAAAAAAAAAAAAAAAAAA');
  ok(/An invite link: works from anywhere/.test(await B.textContent('[data-live-join-kind]')), 'a link is named as an invite link (the internet)');
  await B.fill('[data-live-join-input]', 'K7');
  ok(await B.isHidden('[data-live-join-kind]'), 'nothing is said about half a code while typing');
  // Your name: signed out = any name (guests need no account); signed in = your account, or another name if you choose.
  ok(await B.isVisible('[data-live-join-name]') && /No account needed/.test(await B.textContent('[data-live-join-namehint]')), 'signed out: a name box, no account needed');
  await B.evaluate(() => { window.__acct = { state: 'signed_in', user: { name: 'Ana Ruiz', email: 'ana@example.test' } }; window.__acctChanged(); });
  await until(B, () => !document.querySelector('[data-live-join-as]').hidden, null, 'joining as the account');
  ok(/Joining as Ana Ruiz, from your account/.test(await B.textContent('[data-live-join-as]')) && await B.isHidden('[data-live-join-name]'), 'signed in: joins as the account, no name box');
  await B.click('[data-live-join-other]');
  ok(await B.isVisible('[data-live-join-name]') && await B.isVisible('[data-live-join-mine]'), 'Use a different name: the name box, and a way back');
  await B.click('[data-live-join-mine]');
  ok(await B.isHidden('[data-live-join-name]'), 'Use my account name: back to the account');
  await B.click('[data-live-join-other]');   // the rest of this test joins as the guest "Ben"
  await B.evaluate(() => { window.__acct = null; window.__acctChanged(); });
  await B.fill('[data-live-join-input]', 'not a code!');
  await B.fill('[data-live-join-name]', 'Ben');
  await B.click('[data-live-join-go]');
  ok((await B.textContent('[data-live-join-msg]')).includes('doesn\'t recognize'), 'nonsense gets a plain answer');
  await B.fill('[data-live-join-input]', code.toLowerCase().replace('-', ' '));
  await Promise.all([B.waitForURL(/apps\/cadcraft\/index\.html/, { timeout: 15000 }).catch(() => null), B.click('[data-live-join-go]')]);
  await until(B, () => document.querySelector('[data-live-state="waiting"]'), null, 'waiting');
  ok(/apps\/cadcraft\/index\.html$/.test(B.url()), 'the code opens CadCraft (the app the session is in) and the join id leaves the address: ' + B.url().replace(base, ''));
  ok(await B.$('[data-live-state="waiting"]'), 'the joiner waits for the host');
  await shot(B, '02-joiner-waiting');

  section('The approve card');
  await until(A, () => document.querySelector('[data-live-card]'), null, 'the approve card');
  const card = await A.textContent('[data-live-card]');
  ok(card.includes('Ben') && card.includes('wants to join') && card.includes('On this network'), 'Ben wants to join, on this network: ' + card);
  ok((await A.textContent('[data-live-count]')).trim() === '1', 'the Live button counts one waiting');
  await shot(A, '03-host-card');
  await A.click('[data-live-approve="editor"]');
  await until(B, () => document.querySelector('[data-live-state="live"]'), null, 'B live', 20000);
  ok(await B.$('[data-live-state="live"]'), 'approved: the joiner is live');
  await until(B, () => window.cadcraft && window.cadcraft.doc && [...window.cadcraft.doc.model.values()].some((e) => e.type === 'line' && e.x2 === 100), null, 'the host\'s line');
  ok(await B.evaluate(() => [...window.cadcraft.doc.model.values()].some((e) => e.type === 'line' && e.x2 === 100)), 'the joiner has the host\'s drawing');
  const people = await A.textContent('[data-live-people]');
  ok(people.includes('Ana Host') && people.includes('(you)') && people.includes('Ben'), 'the people list: the host (you) and Ben');
  ok((await B.textContent('[data-live-people]')).includes('Ana Host'), 'the joiner sees the host in the list');
  await B.evaluate(() => { const d = window.cadcraft.doc; d.change('CIRCLE', () => d.add({ type: 'circle', layer: '0', cx: 5, cy: 5, r: 2 })); });
  await until(A, () => [...window.cadcraft.doc.model.values()].some((e) => e.type === 'circle' && e.r === 2), null, 'Ben\'s circle at the host');
  ok(await A.evaluate(() => [...window.cadcraft.doc.model.values()].some((e) => e.type === 'circle' && e.r === 2)), 'Ben\'s edit reaches the host');
  await shot(A, '04-host-people');
  await shot(B, '05-joiner-live');

  section('An assistant on the bus (LV.18)');
  const hostCtl = `(async () => { const src = document.querySelector('script[type="module"][src*="/assets/apps/"]').src; return (await import(new URL('host.js', src).href)).getHost({ app: 'cadcraft' }).control; })()`;
  await A.evaluate(async (expr) => {
    const ctl = await eval(expr);
    ctl.configure({ enabled: true, groups: ['read', 'edit'] });
    await ctl.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test-assistant', version: '1' }, capabilities: {} } }, { id: 'sess-1' });
  }, hostCtl);
  await until(B, () => document.querySelector('[data-live-assistant]') && document.querySelector('[data-live-assistant]').textContent.includes('May'), null, 'the assistant row at the joiner, with what it may do', 8000);
  ok((await B.textContent('[data-live-assistant]').catch(() => '')).includes('Assistant (via Ana Host)') && (await B.textContent('[data-live-assistant]')).includes('May read, edit'), 'everyone sees "Assistant (via Ana Host)" and what it may do');
  await until(A, () => document.querySelector('[data-live-assistant]'), null, 'the assistant row at the host');
  ok((await A.textContent('[data-live-assistant]').catch(() => '')).includes('Assistant (via you)'), 'the person whose assistant it is sees "Assistant (via you)"');
  await shot(B, '05b-joiner-assistant');
  // LV.18 (final sweep): it is its own session client — the host's own, in at once — and its edits have their own undo
  await until(A, () => [...window.cadcraftStudioLive.client.assistants].some((a) => a.status === 'live'), null, 'the host\'s assistant client in', 8000);
  ok(await A.evaluate(() => { const c = window.cadcraftStudioLive.client; const a = [...c.assistants][0]; return !!a && a.role === 'assistant' && a.c !== c.c; }), 'the assistant has a session client of its own (role assistant), in without a card');
  ok(await B.evaluate(() => [...window.cadcraftStudioLive.client.peers.values()].some((p) => p.role === 'assistant' && p.of === [...window.cadcraftStudioLive.client.peers.values()].find((x) => x.role === 'host').c)), 'others see it as the host\'s assistant (peer.of)');
  const hostUndo0 = await A.evaluate(() => window.cadcraftStudioLive.client.undoStack.length);
  const call = (p, sid, id, name, args) => p.evaluate(async ([expr, sid, id, name, args]) => {
    const ctl = await eval(expr);
    const r = await ctl.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, sid);
    return r && r.result && !r.result.isError;
  }, [hostCtl, sid, id, name, args]);
  ok(await call(A, { id: 'sess-1' }, 2, 'command_run', { input: ['LINE', '300,300', '340,330', ''] }), 'the assistant draws a line (command_run)');
  await until(B, () => [...window.cadcraft.doc.model.values()].some((e) => e.type === 'line' && e.x1 === 300 && e.y1 === 300), null, 'the assistant\'s line at the joiner');
  ok(await B.evaluate(() => [...window.cadcraft.doc.model.values()].some((e) => e.type === 'line' && e.x1 === 300 && e.y1 === 300)), 'its line reaches the joiner');
  await until(A, () => [...window.cadcraftStudioLive.client.assistants].some((a) => a.undoStack.length >= 1), null, 'the commit back at the host');
  ok(await A.evaluate((n) => { const c = window.cadcraftStudioLive.client; const a = [...c.assistants][0]; return c.undoStack.length === n && a.undoStack.length >= 1; }, hostUndo0), 'it went on its own client: the host\'s undo stack is unchanged, the assistant\'s has it');
  ok(await call(A, { id: 'sess-1' }, 3, 'undo', {}), 'the assistant undoes (its own undo)');
  await until(B, () => ![...window.cadcraft.doc.model.values()].some((e) => e.type === 'line' && e.x1 === 300 && e.y1 === 300), null, 'the line gone at the joiner');
  ok(await B.evaluate(() => ![...window.cadcraft.doc.model.values()].some((e) => e.type === 'line' && e.x1 === 300) && [...window.cadcraft.doc.model.values()].some((e) => e.type === 'circle' && e.r === 2)), 'its line is gone everywhere; Ben\'s circle stays');
  // an editor's assistant: approved by the host separately
  await B.evaluate(async (expr) => {
    const ctl = await eval(expr);
    ctl.configure({ enabled: true, groups: ['read', 'edit'] });
    await ctl.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'ben-helper', version: '1' }, capabilities: {} } }, { id: 'sess-b' });
  }, hostCtl);
  await until(A, () => document.querySelector('[data-live-card-assistant]'), null, 'the host\'s card for Ben\'s assistant', 8000);
  ok((await A.textContent('[data-live-card-assistant]').catch(() => '')).includes('Ben\'s assistant asks to work in the session'), 'the host is asked: "Ben\'s assistant asks to work in the session"');
  await shot(A, '05c-host-assistant-card');
  await A.click('[data-live-card-assistant] [data-live-approve="assistant"]');
  await until(B, () => [...window.cadcraftStudioLive.client.assistants].some((a) => a.status === 'live' && a.role === 'assistant'), null, 'Ben\'s assistant in', 8000);
  await until(A, () => [...document.querySelectorAll('[data-live-assistant]')].some((x) => x.textContent.includes('Assistant (via Ben)')), null, 'its row at the host', 8000);
  ok((await A.evaluate(() => [...document.querySelectorAll('[data-live-assistant]')].map((x) => x.textContent).join('|'))).includes('Assistant (via Ben)'), 'approved: the host sees "Assistant (via Ben)"');
  await B.evaluate(async (expr) => { const ctl = await eval(expr); ctl.disconnect(); ctl.configure({ enabled: false }); }, hostCtl);
  await until(A, () => ![...document.querySelectorAll('[data-live-assistant]')].some((x) => x.textContent.includes('via Ben')), null, 'Ben\'s assistant row gone', 8000);
  ok(!(await A.evaluate(() => [...document.querySelectorAll('[data-live-assistant]')].some((x) => x.textContent.includes('via Ben')))), 'Ben disconnects it: it leaves the session');
  // (the control object first, then a plain call: Chromium dropped the promise of one async evaluate doing both)
  await A.evaluate(async (expr) => { window.__ctl = await eval(expr); }, hostCtl);
  await A.evaluate(() => { window.__ctl.disconnect(); window.__ctl.configure({ enabled: false }); });
  await until(B, () => !document.querySelector('[data-live-assistant]'), null, 'the assistant row gone', 8000);
  ok(!(await B.$('[data-live-assistant]')), 'disconnected: the row goes');
  ok(await A.evaluate(() => [...window.cadcraftStudioLive.client.assistants].every((a) => a.final)), 'and its session client has left');

  section('Roles and refusals');
  const benC = await A.evaluate(() => [...window.cadcraftStudioLive.client.peers.values()].find((p) => p.name === 'Ben').c);
  await A.selectOption(`[data-live-role="${benC}"]`, 'viewer');
  await until(B, () => window.cadcraftStudioLive.client.role === 'viewer', null, 'viewer role');
  ok(await B.evaluate(() => window.cadcraftStudioLive.client.role === 'viewer'), 'the host makes Ben view only');
  await B.evaluate(() => { const d = window.cadcraft.doc; d.change('LINE', () => d.add({ type: 'line', layer: '0', x1: 0, y1: 9, x2: 9, y2: 9 })); });
  await until(B, () => document.querySelector('[data-live-msg]'), null, 'the refusal');
  ok((await B.textContent('[data-live-msg]').catch(() => '')).includes('viewing only'), 'his edit is taken back, and he is told why');
  await A.selectOption(`[data-live-role="${benC}"]`, 'editor');

  section('Three wrong codes rotate the code; one-time codes');
  const wrong = code.slice(0, 3) + [...'0123456789ABCDEFGHJKMNPQRSTVWXYZ'].find((ch) => ch !== code[3]) + code.slice(4);
  for (let i = 0; i < 3; i++) { const w = nodeJoin('Mallory', { code: wrong }); await nodeUntil(w, (c) => c.final, 5000); }
  await until(A, () => document.querySelector('[data-live-panel] .sl-note') && /3 wrong codes/.test(document.querySelector('[data-live-panel]').textContent), null, 'rotation note');
  const code2 = (await A.textContent('[data-live-code]').catch(() => '')).trim();
  ok(/3 wrong codes/.test(await A.textContent('[data-live-panel]')) && code2 && code2 !== code, 'after 3 wrong codes the host sees a new code and why');
  await A.check('#sl-onetime');
  await A.click('[data-live-newcode]');
  await until(A, (old) => document.querySelector('[data-live-code]') && document.querySelector('[data-live-code]').textContent.trim() !== old, code2, 'one-time code');
  const once = (await A.textContent('[data-live-code]')).trim();
  ok(once !== code2 && (await A.textContent('[data-live-panel]')).includes('One-time: it works for one person.'), 'New code, one-time: ' + [code2, once].map((x) => x.slice(0, 2)).join(' → ') + ' / ' + (await A.textContent('[data-live-panel]')).slice(0, 400));
  const cy = nodeJoin('Cy', { code: once });
  await until(A, () => [...document.querySelectorAll('[data-live-card]')].some((x) => x.textContent.includes('Cy')), null, 'Cy\'s card');
  ok(/used/.test(await A.textContent('[data-live-panel]')), 'the one-time code is used up by Cy and the panel says so');
  await A.click('[data-live-card] [data-live-deny]');
  ok(await nodeUntil(cy, (c) => c.final), 'Deny: Cy is turned away (' + cy.status + ')');

  section('Invite links (LV.23): asked up front (owner, 2026-10-14)');
  await until(A, () => document.querySelector('[data-live-linkcheck="signin"]'), null, 'signed-out link note');
  ok(!(await A.$('[data-live-makelink]')) && /sign in to getcadcraft\.com/i.test(await A.textContent('[data-live-linkcheck]')), 'signed out: no Invite by link button, a sentence saying how (the code still invites on this network)');
  await A.evaluate(() => {
    window.__acct = { state: 'signed_in', user: { name: 'Ana Ruiz', email: 'ana@example.test' } };
    window.__cloud = (o) => (o.path.startsWith('/api/v1/live/check') ? { status: 200, json: { status: 'success', data: { allowed: false, reason: 'no_license', message: 'Invite links need a commercial license for CadCraft. Sessions on your own network are free.' } } } : { status: 500, json: {} });
    window.__acctChanged();
  });
  await until(A, () => document.querySelector('[data-live-linkcheck="no"]'), null, 'licence message');
  ok((await A.textContent('[data-live-linkcheck="no"]')).trim() === 'Invite links need a commercial license for CadCraft. Sessions on your own network are free.'
    && !(await A.$('[data-live-makelink]')) && !!(await A.$('[data-live-pricing]')), 'no license: the site\'s message as it is, a pricing link, and no button that would only refuse');
  await A.evaluate(() => {
    window.__cloud = (o) => (o.path.startsWith('/api/v1/live/check') ? { status: 200, json: { data: { allowed: true, reason: 'ok', message: '' } } } : { status: 500, json: {} });
    window.__acctChanged();
  });
  await until(A, () => document.querySelector('[data-live-makelink]'), null, 'Invite by link button');
  ok(true, 'with a commercial license the Invite by link controls show');
  await A.evaluate(() => {
    window.__cloud = (o) => {
      if (o.path.startsWith('/api/v1/live/check')) return { status: 200, json: { data: { allowed: true, reason: 'ok', message: '' } } };
      if (o.path === '/api/v1/live/rooms') return { status: 201, json: { data: { room: { room: 'K7QX9M2B', app: 'cadcraft', lifetime: '8h', link: 'https://getcadcraft.com/live/K7QX9M2B', relay_url: 'wss://getcadcraft.com/live/relay/host/K7QX9M2B', join_url: 'wss://getcadcraft.com/live/relay/join/K7QX9M2B', expires_at: null }, host_ticket: 'ticket-xyz' } } };
      if (o.path === '/api/v1/live/end') return { status: 200, json: { data: {} } };
      return { status: 404, json: {} };
    };
  });
  await A.selectOption('[data-live-lifetime]', '1h');
  await A.click('[data-live-makelink]');
  await until(A, () => document.querySelector('[data-live-link]'), null, 'the link');
  const link = await A.inputValue('[data-live-link]');
  ok(/^https:\/\/getcadcraft\.com\/live\/K7QX9M2B#[A-Za-z0-9_-]{22}$/.test(link), 'the invite link: room + a 128-bit secret in the fragment');
  const calls = await A.evaluate(() => window.__cloudCalls);
  const roomCall = calls.find((c) => c[1] === '/api/v1/live/rooms');
  ok(roomCall && JSON.parse(roomCall[2]).lifetime === '1h' && JSON.parse(roomCall[2]).app === 'cadcraft', 'the room is opened for this app with the chosen lifetime');
  ok(!JSON.stringify(calls).includes(link.split('#')[1]), 'the secret never goes to getcadcraft.com');
  const llog = await A.evaluate(() => window.__liveLog);
  ok(llog.some((l) => l[0] === 'relay' && l[1].endsWith('/host/K7QX9M2B') && l[2]) && llog.some((l) => l[0] === 'advertise' && l[1] && l[1].room === 'K7QX9M2B'), 'the host connects to the relay with its ticket and is findable on the LAN by the room (LV.26)');
  await shot(A, '06-host-link');
  // A joiner with the link, here on the same network (the server takes the link's secret on its LAN socket too).
  const secret = Crypto.parseLinkSecret(link.split('#')[1]);
  const dee = nodeJoin('Dee', { link: { room: 'K7QX9M2B', secret } });
  await until(A, () => [...document.querySelectorAll('[data-live-card]')].some((x) => x.textContent.includes('Dee')), null, 'Dee\'s card');
  ok(await A.evaluate(() => [...document.querySelectorAll('[data-live-card]')].some((x) => x.textContent.includes('Dee'))), 'the link gets Dee to the approve card');
  await A.click('[data-live-card] [data-live-approve="viewer"]');
  ok(await nodeUntil(dee, (c) => c.status === 'live') && dee.role === 'viewer', 'View only: Dee is in as a viewer');
  await A.click('[data-live-newlink]');
  const link2 = await A.inputValue('[data-live-link]');
  ok(link2 !== link && link2.startsWith('https://getcadcraft.com/live/K7QX9M2B#'), 'New link: the same room, a new secret');
  const eve = nodeJoin('Eve', { link: { room: 'K7QX9M2B', secret } });
  ok(await nodeUntil(eve, (c) => c.final) && eve.status === 'failed', 'the old link no longer works (' + eve.seen.join(' ') + ')');
  if (!(await A.$('[data-live-stoplink]'))) console.log('  (no link shown: ' + (await A.textContent('[data-live-panel]')).slice(0, 600) + ')');
  await A.click('[data-live-stoplink]', { timeout: 3000 });
  ok(!(await A.$('[data-live-link]')) && (await A.evaluate(() => window.__cloudCalls.some((c) => c[1] === '/api/v1/live/end'))) && (await A.evaluate(() => window.__liveLog.some((l) => l[0] === 'relayStop'))), 'Stop the link: the room ends and the relay socket closes');
  ok(dee.status === 'live', 'people already in stay');

  section('Remove, End, Leave');
  const deeC = dee.c;
  await A.click(`[data-live-remove="${deeC}"]`);
  await A.click('[data-ask-yes]');
  ok(await nodeUntil(dee, (c) => c.final) && dee.status === 'removed', 'Remove (after asking): Dee is out');
  await A.uncheck('#sl-onetime');
  await A.click('[data-live-newcode]');
  await until(A, () => document.querySelector('[data-live-stopcode]'), null, 'a code again');
  ok(!/One-time: it works/.test(await A.textContent('[data-live-panel]')), 'a new code that isn\'t one-time');
  const codeNow = (await A.textContent('[data-live-code]')).trim();

  section('Hand over (LV.17)');
  const meC = await A.evaluate(() => window.cadcraftStudioLive.client.c);
  ok(await A.$(`[data-live-handover="${benC}"]`) && !(await A.$(`[data-live-handover="${meC}"]`)), 'the people list offers "Hand over…" on Ben (an editor), not on yourself');
  await A.click(`[data-live-handover="${benC}"]`);
  ok((await A.textContent('.sl-ask')).includes('Hand the session over to Ben?') && (await A.textContent('.sl-ask')).includes('you stay as an editor'), 'it asks first, and says what you become');
  await A.click('[data-ask-yes]');
  await until(B, () => window.cadcraftStudioLive.client.role === 'host' && window.cadcraftStudioLive.client.status === 'live' && document.querySelector('[data-live-code]'), null, 'Ben hosts, with the code', 30000);
  ok(await B.evaluate(() => window.__liveLog.some((l) => l[0] === 'startFrom' && l[1] > 0)), 'Ben\'s Studio starts a session server from the state (startFrom)');
  ok((await B.textContent('[data-live-code]')).trim() === codeNow && (await B.textContent('[data-live-panel]')).includes('came with the session'), 'the code still running came with the session, shown at the new host');
  ok((await B.textContent('[data-live-panel]')).includes('Ana Host handed the session over to you'), 'Ben is told he hosts now');
  await until(A, () => window.cadcraftStudioLive.client.role === 'editor' && window.cadcraftStudioLive.client.status === 'live', null, 'Ana an editor in Ben\'s session', 20000);
  const amsg = await A.textContent('[data-live-msg]').catch(() => '');
  ok(amsg.includes('moved to Ben\'s Studio') && amsg.includes('You\'re an editor now'), 'Ana is told where it went and what she is now: ' + amsg);
  ok(!(await A.$('[data-live-code]')) && !(await A.$('[data-live-handover]')) && !(await A.$('[data-live-end-session]')), 'Ana\'s panel no longer offers host actions');
  ok(await A.evaluate(() => window.__liveLog.some((l) => l[0] === 'transport' && l[1] === 'join' && /^ws:\/\/127\.0\.0\.1:\d+\/live$/.test(l[2]))), 'Ana follows through Studio\'s join transport');
  await A.evaluate(() => { const d = window.cadcraft.doc; d.change('LINE', () => d.add({ type: 'line', layer: '0', x1: 1, y1: 2, x2: 3, y2: 77 })); });
  await until(B, () => [...window.cadcraft.doc.model.values()].some((e) => e.type === 'line' && e.y2 === 77), null, 'Ana\'s line at Ben');
  ok(await B.evaluate(() => [...window.cadcraft.doc.model.values()].some((e) => e.type === 'line' && e.y2 === 77)), 'an edit after the move reaches the new host');
  await shot(A, '06b-old-host-moved');
  await shot(B, '06c-new-host');

  section('End, by the new host');
  await B.click('[data-live-stopcode]');
  ok((await B.textContent('[data-live-nocode]')).includes('Inviting stopped'), 'Stop inviting: no code, people already in stay');
  await B.click('[data-live-end-session]');
  await B.click('[data-ask-yes]');
  await until(A, () => document.querySelector('[data-live-end]'), null, 'end at Ana');
  ok((await A.textContent('[data-live-end]')).includes('keeps a copy') && (await A.textContent('[data-live-end]')).includes('Ben'), 'End: Ana keeps an unsaved copy, from Ben');
  ok(await A.evaluate(() => [...window.cadcraft.doc.model.values()].some((e) => e.type === 'circle')), 'and the drawing is still on screen');
  await until(B, () => document.querySelector('[data-live-end]'), null, 'end at the host');
  ok((await B.textContent('[data-live-end]')).includes('The file is still open here'), 'the host is told the session has ended');
  await shot(A, '07-joiner-ended');

  section('A store build: on this network only');
  // Its own session server: the first session has ended (a window hosts one session; another window would get its own).
  const srv2 = spawn(bin, ['--bind', '127.0.0.1:0', '--app', 'cadcraft', '--token', TOKEN, '--www', suite], { stdio: ['pipe', 'pipe', 'inherit'] });
  const addr2 = JSON.parse(await new Promise((res) => readline.createInterface({ input: srv2.stdout }).once('line', res))).addr;
  const S = await page('store', '', { store: true });
  try {
    await S.goto(`http://${addr2}/apps/cadcraft/index.html`);
    await until(S, () => document.querySelector('[data-studio-live]'), null, 'Live button (store)', 20000);
    await S.click('[data-studio-live]');
    await S.fill('[data-live-name]', 'Store Host');
    await S.dispatchEvent('[data-live-name]', 'change');
    await S.click('[data-live-share]');
    await until(S, () => document.querySelector('[data-live-code]'), null, 'store share');
    ok(await S.$('[data-live-code]'), 'sharing on the network works in a store build');
    ok(await S.$('[data-live-link-store]') && !(await S.$('[data-live-makelink]')) && !/license|buy|price/i.test(await S.textContent('[data-live-link-store]')), 'no invite links, and no purchase wording');
  } finally { await S.close(); srv2.stdin.end(); srv2.kill(); }

  section('The same file: join from the window that has it open (LV.8)');
  {
    const srv3 = spawn(bin, ['--bind', '127.0.0.1:0', '--app', 'cadcraft', '--token', TOKEN, '--www', suite], { stdio: ['pipe', 'pipe', 'inherit'] });
    const addr3 = JSON.parse(await new Promise((res) => readline.createInterface({ input: srv3.stdout }).once('line', res))).addr;
    const plan = path.join(SITE, 'fixtures/dwg/base-plan.dxf');
    const H3 = await page('same-host', `window.__localUrl = 'ws://${addr3}/live';`), J3 = await page('same-joiner');
    try {
      for (const p of [H3, J3]) {
        await p.goto(`http://${addr3}/apps/cadcraft/index.html`);
        await until(p, () => window.cadcraft && window.cadcraft.doc && document.querySelector('[data-studio-live]'), null, 'CadCraft (same file)', 20000);
        await p.setInputFiles('[data-file]', plan);
        await until(p, () => window.cadcraft.doc.count() > 0 && window.cadcraft.doc.fileHash, null, 'the file open, its hash kept', 20000);
      }
      ok(await H3.evaluate(() => /^[0-9a-f]{64}$/.test(window.cadcraft.doc.fileHash.hash)), 'CadCraft keeps the hash of the bytes it opened');
      await H3.click('[data-studio-live]');
      await H3.fill('[data-live-name]', 'Hana Host');
      await H3.dispatchEvent('[data-live-name]', 'change');
      await H3.click('[data-live-share]');
      await until(H3, () => document.querySelector('[data-live-code]'), null, 'same-file share');
      const code = (await H3.textContent('[data-live-code]')).trim();
      await J3.click('[data-studio-live]');
      ok(await J3.$('[data-live-here]'), 'a window with the file open (unchanged) offers "Join with the drawing open here"');
      await J3.fill('[data-live-here-input]', 'nonsense');
      await J3.click('[data-live-here-join]');
      await until(J3, () => document.querySelector('[data-live-msg]'), null, 'an answer');
      ok((await J3.textContent('[data-live-msg]')).includes('isn\'t a code'), 'nonsense gets a plain answer');
      await J3.fill('[data-live-name]', 'Jo');
      await J3.dispatchEvent('[data-live-name]', 'change');
      await J3.evaluate(() => { window.__first = [...window.cadcraft.doc.model.values()][0]; });
      await J3.fill('[data-live-here-input]', `${addr3.replace(/:\d+$/, '')}:${addr3.split(':').pop()} ${code}`);
      await J3.click('[data-live-here-join]');
      await until(H3, () => document.querySelector('[data-live-card] [data-live-approve="editor"]'), null, 'the host\'s card');
      await H3.click('[data-live-card] [data-live-approve="editor"]');
      await until(J3, () => window.cadcraftStudioLive.client && window.cadcraftStudioLive.client.status === 'live', null, 'joined with the file', 10000);
      ok(await J3.evaluate(() => window.cadcraft.doc.model.get(window.__first.id) === window.__first), 'no snapshot: the joiner\'s own drawing (the same file) stayed, objects and all');
      await H3.evaluate(() => { const d = window.cadcraft.doc; d.change('CIRCLE', () => d.add({ type: 'circle', layer: '0', cx: 1, cy: 2, r: 3 })); });
      await until(J3, () => [...window.cadcraft.doc.model.values()].some((e) => e.type === 'circle' && e.r === 3), null, 'the host\'s edit after joining');
      ok(await J3.evaluate(() => [...window.cadcraft.doc.model.values()].some((e) => e.type === 'circle' && e.r === 3)), 'and the edits since follow');
      // changed since it was opened: no longer offered
      const K3 = await page('same-changed');
      await K3.goto(`http://${addr3}/apps/cadcraft/index.html`);
      await until(K3, () => window.cadcraft && window.cadcraft.doc && document.querySelector('[data-studio-live]'), null, 'CadCraft (changed)', 20000);
      await K3.setInputFiles('[data-file]', plan);
      await until(K3, () => window.cadcraft.doc.fileHash, null, 'hash kept', 20000);
      await K3.evaluate(() => { const d = window.cadcraft.doc; d.change('CIRCLE', () => d.add({ type: 'circle', layer: '0', cx: 0, cy: 0, r: 1 })); });
      await K3.click('[data-studio-live]');
      ok(!(await K3.$('[data-live-here]')), 'a drawing changed since it was opened: not offered');
      await K3.close();
    } finally { await H3.close(); await J3.close(); srv3.stdin.end(); srv3.kill(); }
  }

  section('Both themes, no console errors');
  await A.evaluate(() => document.documentElement.setAttribute('data-space', 'model'));
  await shot(A, '08-host-model');
  const bad = errors.filter((e) => !/favicon|ERR_FILE_NOT_FOUND|live\.js.*404/.test(e));
  ok(!bad.length, 'no console errors' + (bad.length ? ':\n    ' + bad.slice(0, 8).join('\n    ') : ''));
} finally {
  for (const c of nodeClients) try { c.stop(); } catch { /* done */ }
  await browser.close();
  srv.stdin.end(); srv.kill();
  for (const p of extraServers) { try { p.stdin.end(); p.kill(); } catch { /* gone */ } }
}
done();
