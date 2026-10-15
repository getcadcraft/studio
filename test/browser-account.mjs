#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * browser-account.mjs — the hub's account card in Chromium (0.5 SI.4 "who is signed in", SI.6 links to the website,
 * SI.7 the profile picture), with the desktop shell's account and cloud bridge stood in for by a page script (the real
 * shell is test/desktop.mjs). Checks: no notice for a sign-in Studio already had; "Signed in as … Not you? Sign out" right
 * after a new sign-in; the picture from /api/v1/me/avatar shown only when it decodes as an image (else initials), in the
 * card and the bar, kept for the next start and replaced when updated_at changes; the website links (system browser);
 * Not you signs out and forgets the picture.
 *
 *   node test/browser-account.mjs [--suite <packed suite>] [--shots <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { serve, chromium, SUITE, ok, section, done } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = path.resolve(arg('--suite', SUITE('dev')));
const SHOTS = arg('--shots', null);
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
if (!fs.existsSync(path.join(DIR, 'hub/avatar.js'))) { console.error('the suite at ' + DIR + ' has no hub/avatar.js (repack it)'); process.exit(1); }

// The shell's account + cloud, stood in for. window.__acct drives the state; __avatar: 'webp' | 'junk' | 'none'.
const stub = () => {
  window.__calls = [];
  const st = JSON.parse(sessionStorage.getItem('__acct') || '{"state":"signed_out"}');
  let listener = null;
  const save = () => sessionStorage.setItem('__acct', JSON.stringify(st));
  const user = { name: 'Ana Example', email: 'ana@example.test' };
  const ws = '11111111-2222-4333-8444-555555555555';
  let webp = null;
  const picture = async (size) => {
    if (!webp) { const c = new OffscreenCanvas(size, size); const g = c.getContext('2d'); g.fillStyle = '#1f6fd1'; g.fillRect(0, 0, size, size); webp = new Uint8Array(await (await c.convertToBlob({ type: 'image/webp' })).arrayBuffer()); }
    return webp;
  };
  const json = (status, data) => ({ status, headers: {}, body: new Uint8Array(0), json: () => ({ status: status < 400 ? 'success' : 'error', data }) });
  window.__setState = (s) => { st.state = s; save(); if (listener) listener({ state: s }); };
  Object.defineProperty(window, 'cadcraftDesktop', { enumerable: true, value: Object.freeze({
    version: 1,
    info: async () => ({ shell: 'test', platform: 'linux', suite: true, store: false, version: '0.5.0', windowId: 'main' }),
    account: Object.freeze({
      status: async () => (st.state === 'signed_in' ? { state: 'signed_in', user } : { state: st.state }),
      open: async () => { window.__calls.push('open'); },
      signOut: async () => { window.__calls.push('signOut'); st.state = 'signed_out'; save(); return { message: 'Signed out.' }; },
      cancel: async () => {},
      onChange: (cb) => { listener = cb; },
    }),
    cloud: Object.freeze({
      request: async (o) => {
        window.__calls.push(o.method + ' ' + o.path);
        if (sessionStorage.getItem('__offline') === '1') throw Object.assign(new Error('offline'), { code: 'error' });
        if (o.path === '/api/v1/sync/status') return json(200, { user: { ...user, email_verified: true }, workspaces: [{ uuid: ws, name: 'Ana Example’s workspace', kind: 'team', role: 'owner', apps: ['cadcraft'], cloud_open: true, storage: null }] });
        if (o.path.startsWith('/api/v1/sync/drawings')) return json(200, { drawings: [], server_time: new Date().toISOString() });
        if (o.path === '/api/v1/me') {
          const kind = sessionStorage.getItem('__avatar') || 'webp';
          return json(200, { user: { id: 7, ...user, email_verified: true, avatar: kind === 'none' ? null : { url: 'https://getcadcraft.com/avatar/7?v=1', url_64: '…', updated_at: sessionStorage.getItem('__avatar_at') || '2026-10-14T10:00:00Z' } }, organizations: [{ uuid: ws, name: 'Ana Example’s workspace', kind: 'team', role: 'owner', slug: 'ana-studio' }] });
        }
        if (o.path.startsWith('/api/v1/me/avatar')) {
          const kind = sessionStorage.getItem('__avatar') || 'webp';
          if (kind === 'junk') return { status: 200, headers: {}, body: new TextEncoder().encode('<svg onload=alert(1)></svg>'), json: () => null };
          return { status: 200, headers: { 'content-type': 'image/webp' }, body: await picture(o.path.includes('size=64') ? 64 : 256), json: () => null };
        }
        return json(404, null);
      },
    }),
  }) });
};

const srv = await serve(DIR);
const browser = await chromium();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
await ctx.addInitScript(`(${stub})();`);
await ctx.route((u) => u.origin !== new URL(srv.url).origin, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"data":{"items":[]}}' }));
const errors = [];
const hub = await ctx.newPage();
hub.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
hub.on('pageerror', (e) => errors.push(e.message));
const shot = async (n) => { if (SHOTS) await hub.screenshot({ path: path.join(SHOTS, n + '.png') }); };
const ready = async () => { await hub.waitForSelector('html.studio-ready'); await hub.waitForTimeout(300); };

try {
  section('Signed in already: no notice (SI.4)');
  await hub.goto(srv.url);
  await hub.evaluate(() => { sessionStorage.setItem('__acct', '{"state":"signed_in"}'); });
  await hub.reload();
  await ready();
  await hub.waitForSelector('[data-who-name]');
  ok(!(await hub.$('[data-signed-notice]')), 'opening Studio already signed in shows no "just signed in" notice');
  ok((await hub.textContent('[data-who-name]')) === 'Ana Example', 'the card says who');

  section('The picture (SI.7)');
  await hub.waitForSelector('[data-account] img[data-avatar="picture"]', { timeout: 5000 }).catch(() => {});
  ok(await hub.$eval('[data-account] img[data-avatar="picture"]', (i) => i.src.startsWith('blob:') && i.naturalWidth > 0).catch(() => false), 'the picture from /api/v1/me/avatar, drawn from checked bytes (blob:)');
  ok(await hub.$eval('[data-bar-avatar]', (s) => !s.hidden && !!s.querySelector('img') && /Ana Example \(ana@example\.test\)/.test(s.title)), 'and in the bar, with who it is');
  const fetched = (await hub.evaluate(() => window.__calls)).filter((c) => c.startsWith('GET /api/v1/me/avatar'));
  ok(fetched.length === 2 && fetched.some((c) => c.endsWith('size=64')), 'both sizes fetched once (256 for Studio, 64 for live sessions)');
  await hub.evaluate(() => { window.__calls.length = 0; });
  await hub.reload();
  await ready();
  await hub.waitForSelector('[data-account] img[data-avatar="picture"]');
  ok(!(await hub.evaluate(() => window.__calls)).some((c) => c.startsWith('GET /api/v1/me/avatar')), 'the next start: from the kept copy (same updated_at), not fetched again');
  await hub.evaluate(() => { sessionStorage.setItem('__offline', '1'); });
  await hub.reload();
  await ready();
  await hub.waitForSelector('[data-bar-avatar] img', { timeout: 5000 }).catch(() => {});
  ok(await hub.$('[data-bar-avatar] img'), 'offline: the kept picture still shows (in the bar, from the shell\'s account)');
  await hub.evaluate(() => { sessionStorage.removeItem('__offline'); sessionStorage.setItem('__avatar', 'junk'); sessionStorage.setItem('__avatar_at', '2026-10-14T11:00:00Z'); });
  await hub.reload();
  await ready();
  await hub.waitForSelector('[data-who-name]');
  await hub.waitForTimeout(500);
  ok(await hub.$eval('[data-account] [data-avatar]', (n) => n.getAttribute('data-avatar') === 'picture'), 'a new updated_at whose bytes are not an image: refused, the last good picture stays');
  ok(!(await hub.$('svg[onload]')) && !errors.some((e) => /alert/.test(e)), 'nothing from those bytes reached the page');
  await hub.evaluate(() => { sessionStorage.setItem('__avatar', 'none'); });
  await hub.click('[data-account] button:has-text("Refresh")');
  await hub.waitForSelector('[data-account] [data-avatar="initials"]');
  ok((await hub.textContent('[data-account] [data-avatar="initials"]')) === 'AE', 'no picture on the site: initials (AE), the kept one forgotten');
  await hub.evaluate(() => { sessionStorage.setItem('__avatar', 'webp'); sessionStorage.setItem('__avatar_at', '2026-10-14T12:00:00Z'); });
  await hub.click('[data-account] button:has-text("Refresh")');
  await hub.waitForSelector('[data-account] img[data-avatar="picture"]');
  ok(true, 'a new picture on the site shows after Refresh');

  section('Links to the website (SI.6)');
  const href = (sel) => hub.$eval(sel, (a) => [a.href, a.target, a.rel].join(' '));
  ok((await href('[data-site-account]')) === 'https://getcadcraft.com/account _blank noopener noreferrer', 'Manage account → /account, in the system browser');
  ok((await href('[data-site-teams]')).startsWith('https://getcadcraft.com/teams/ana-studio '), 'Teams → the workspace\'s team page (slug from /api/v1/me, as the site sends it)');
  ok((await href('[data-site-billing]')).startsWith('https://getcadcraft.com/teams/ana-studio/licenses '), 'License and billing → the team\'s licenses');
  ok(!/password|card|billing address/i.test(await hub.textContent('[data-account]')), 'Studio itself shows no billing or password fields');

  section('Just signed in (SI.4)');
  await hub.click('[data-sign-out]');
  await hub.waitForSelector('[data-sign-in]');
  ok((await hub.evaluate(() => window.__calls)).includes('signOut') && !(await hub.$('[data-bar-avatar] img')), 'Sign out: the picture leaves the bar');
  ok(await hub.evaluate(() => !localStorage.getItem('cadcraft.studio.avatar')), 'and the kept picture is forgotten');
  await hub.evaluate(() => window.__setState('signed_in'));
  await hub.waitForSelector('[data-signed-notice]');
  ok((await hub.textContent('[data-signed-notice]')).includes('Signed in as Ana Example (ana@example.test).'), 'right after signing in: "Signed in as Ana Example (ana@example.test)."');
  ok(await hub.$('[data-not-me]') && (await hub.textContent('[data-not-me]')) === 'Not you? Sign out', 'with "Not you? Sign out"');
  // The shell keeps one account listener: the account card and the Join card must both hear the same change.
  ok(await hub.$eval('[data-live-join-as-text]', (n) => /Ana Example/.test(n.textContent) && !n.closest('[hidden]')).catch(() => false), 'the Join card heard the same sign-in ("Joining as Ana Example")');
  await shot('account-signed');
  await hub.click('[data-thats-me]');
  await hub.waitForSelector('[data-signed-notice]', { state: 'detached', timeout: 5000 }).catch(() => {});
  ok(!(await hub.$('[data-signed-notice]')), '"That\'s me" puts it away');
  await hub.evaluate(() => window.__setState('signed_out'));
  await hub.waitForSelector('[data-sign-in]');
  await hub.evaluate(() => window.__setState('signed_in'));
  await hub.waitForSelector('[data-signed-notice]');
  await hub.click('[data-not-me]');
  await hub.waitForSelector('[data-sign-in]');
  ok((await hub.evaluate(() => window.__calls.filter((c) => c === 'signOut').length)) === 2, '"Not you? Sign out" signs this Studio out');

  section('Clean');
  ok(!errors.length, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 4).join(' | ') : ''));
} finally {
  await browser.close();
  await srv.close();
}
done();
