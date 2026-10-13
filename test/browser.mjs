#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// browser.mjs — Studio's browser edition in Chromium (H.10): the packed suite (pack/suite.mjs) served from a deep
// sub-folder by a plain static server. The hub opens every app; files route by type (drop, the PDF question, "always
// use"); handoffs between the apps inside the suite; recent files across apps reopen in the right app; the window
// channel; themes shared by every window; offline (save, then the server goes away). Fails on any console error or any
// request that leaves the suite's folder.
//   CADCRAFT_SITE=<site> node test/browser.mjs [--build dev] [--shots <dir>] [--verbose]
// Needs: the suite (node pack/suite.mjs), playwright-core (node_modules) with its Chromium, and CADCRAFT_SITE for the
// test drawings (the site's fixtures/).
import fs from 'node:fs';
import path from 'node:path';
import { serve, chromium, SUITE, SITE, need, ok, section, done } from './lib.mjs';

const args = process.argv.slice(2);
const BUILD = args.includes('--build') ? args[args.indexOf('--build') + 1] : 'dev';
const SHOTS = args.includes('--shots') ? path.resolve(args[args.indexOf('--shots') + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const DIR = SUITE(BUILD);
if (!fs.existsSync(path.join(DIR, 'index.html'))) { console.error('no suite at ' + DIR + ' (node pack/suite.mjs first)'); process.exit(1); }
need(SITE, 'CADCRAFT_SITE', 'the site\'s folder (the test drawings are its fixtures/)');
const suite = JSON.parse(fs.readFileSync(path.join(DIR, 'release.json'), 'utf8'));
const APPS = suite.apps.map((a) => a.slug);
const DWG = fs.readFileSync(path.join(SITE, 'fixtures/dwg/kitchen-equipment.dwg'));
const PDF = fs.readFileSync(path.join(SITE, 'fixtures/pdf/kitchen-plan-sheet.pdf'));

const srv = await serve(DIR);
const browser = await chromium();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const problems = [];
const watch = (p, label) => {
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*(404|ERR_)/.test(m.text())) problems.push(label + ': ' + m.text()); });
  p.on('pageerror', (e) => problems.push(label + ': ' + e.message));
};
ctx.on('page', (p) => watch(p, 'window'));
const hub = await ctx.newPage();
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: path.join(SHOTS, n + '.png'), fullPage: n.startsWith('hub') }); };

/** Drop files (name → bytes) on the hub, the way a person would. */
async function drop(files) {
  await hub.evaluate(async (list) => {
    const dt = new DataTransfer();
    for (const [name, b64] of list) dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name));
    const ev = (type) => new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev('dragenter'));
    document.body.dispatchEvent(ev('dragover'));
    document.body.dispatchEvent(ev('drop'));
  }, files.map(([n, b]) => [n, Buffer.from(b).toString('base64')]));
}
/** The app window a hub action opens: at once, or (a drop is not a click, so the browser may block the tab) through the
 *  button the hub then shows. */
async function opened(action) {
  const pop = hub.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
  await action();
  let p = await Promise.race([pop, hub.waitForSelector('[data-pending] button', { timeout: 8000 }).then(() => 'pending').catch(() => null)]);
  if (p === 'pending') {
    const pop2 = hub.waitForEvent('popup', { timeout: 8000 });
    await hub.click('[data-pending] button');
    p = await pop2;
  }
  if (p) await p.waitForLoadState('load');
  return p;
}

try {
  section('The hub (H.1)');
  await hub.goto(srv.url + '?space=paper');
  await hub.waitForSelector('html.studio-ready');
  ok((await hub.title()) === 'CadCraft Studio', 'title is the name from the language file');
  const tiles = await hub.$$eval('[data-tiles] [data-app]', (n) => n.map((x) => x.getAttribute('data-app')));
  ok(tiles.join() === APPS.join(), 'one tile per app in the suite, lineup order: ' + tiles.join(', '));
  ok(await hub.$eval('[data-tiles] [data-app="' + APPS[0] + '"] .studio-tile-ver', (n) => n.textContent.length > 0), 'each tile shows its version');
  ok(/SuperCadCraft/.test(await hub.textContent('[data-upcoming]')) && (await hub.$eval('.studio-upcoming', (n) => n.getAttribute('aria-disabled'))) === 'true' && !(await hub.$('.studio-upcoming a, .studio-upcoming button')), 'SuperCadCraft grayed out, nothing to click');
  ok(!(await hub.$eval('[data-account]', (n) => !n.hidden)), 'browser edition: no account card (cloud is desktop only, D.4)');
  ok(await hub.$eval('[data-assist]', (n) => n.hidden), 'browser edition: no "Connect an assistant" card (no local server, X.5)');
  await shot(hub, 'hub-paper');

  section('Every app opens from the hub (H.3) and joins the channel (H.11)');
  const wins = [];
  for (const slug of APPS) {
    const p = await opened(() => hub.click(`[data-open-app="${slug}"]`));
    ok(p && new URL(p.url()).pathname.endsWith(`/apps/${slug}/index.html`), `${slug}: opens in its own window`);
    if (!p) continue;
    await p.waitForSelector('[data-studio-hub]', { timeout: 15000 }).catch(() => {});
    const st = await p.evaluate(() => window.cadcraftStudio && { id: window.cadcraftStudio.id, app: window.cadcraftStudio.app });
    ok(st && st.app === slug && new RegExp('^' + slug + '-').test(st.id), `${slug}: Studio button in the app bar, window id ${st && st.id}`);
    wins.push([slug, p]);
  }
  await hub.bringToFront();
  await hub.evaluate(() => window.cadcraftStudioHub.refreshWindows());
  await hub.waitForFunction((n) => document.querySelectorAll('[data-windows] li').length === n, wins.length, { timeout: 5000 }).catch(() => {});
  ok((await hub.$$('[data-windows] li')).length === wins.length, `the hub lists the ${wins.length} open windows`);
  ok(/1 window open/.test(await hub.textContent(`[data-tile-count="${APPS[0]}"]`)), 'tiles count their windows');
  if (wins.length) {
    const [slug, p] = wins[0];
    const back = hub.context().waitForEvent('page', { timeout: 3000 }).catch(() => null);
    await p.click('[data-studio-hub]');
    ok(!(await back), `${slug}: the Studio button goes back to the hub's own tab (no new one)`);
  }
  await shot(wins[0][1], 'app-in-suite');
  for (const [, p] of wins) await p.close();
  await hub.waitForTimeout(300);

  section('Files go to the right app (H.5)');
  if (APPS.includes('cadcraft')) {
    const p = await opened(() => drop([['Kitchen.dwg', DWG]]));
    ok(p && /apps\/cadcraft\/index\.html$/.test(new URL(p.url()).pathname), '.dwg dropped on the hub → CadCraft');
    if (p) {
      await p.waitForFunction(() => window.cadcraft && window.cadcraft.doc && window.cadcraft.doc.entities && window.cadcraft.doc.entities.size > 50, null, { timeout: 30000 }).catch(() => {});
      const n = await p.evaluate(() => window.cadcraft && window.cadcraft.doc.entities.size);
      ok(n > 50 && !/handoff=/.test(p.url()), `CadCraft opened the handed-over drawing (${n} objects; the address is cleaned)`);
      await p.close();
    }
  }
  if (APPS.includes('markupcraft') && APPS.includes('takeoffcraft')) {
    await drop([['Sheet.pdf', PDF]]);
    await hub.waitForSelector('[data-ask][open]', { timeout: 5000 }).catch(() => {});
    const choices = await hub.$$eval('[data-ask-apps] button', (b) => b.map((x) => x.value));
    {
      ok(choices.join() === 'markupcraft,takeoffcraft', 'a PDF asks: ' + choices.join(' or '));
      await hub.check('[data-ask-always]');
      const p = await opened(() => hub.click('[data-ask-apps] button[value="markupcraft"]'));
      ok(p && /markupcraft/.test(p.url()), 'chosen MarkupCraft opens');
      if (p) await p.close();
    }
  } else if (APPS.includes('markupcraft')) {
    {
      const p = await opened(() => drop([['Sheet.pdf', PDF]]));
      ok(p && /markupcraft/.test(p.url()), '.pdf → MarkupCraft' + (p ? '' : ' — status: ' + await hub.textContent('[data-studio-status]')));
      if (p) {
        await p.waitForFunction(() => window.markupcraft && window.markupcraft.sheets && window.markupcraft.sheets.length > 0, null, { timeout: 30000 }).catch(() => {});
        ok(await p.evaluate(() => window.markupcraft && window.markupcraft.sheets.length > 0), 'MarkupCraft opened the handed-over PDF');
        await p.close();
      }
    }
  }
  await drop([['notes.docx', new Uint8Array([1, 2])]]);
  await hub.waitForFunction(() => /notes\.docx/.test(document.querySelector('[data-studio-status]').textContent), null, { timeout: 3000 }).catch(() => {});
  ok(/None of the apps opens notes\.docx/.test(await hub.textContent('[data-studio-status]')), 'an unknown type: said plainly, nothing opens');
  const r = await hub.evaluate(() => ['a.ccsheets', 'b.ifc', 'c.landxml', 'd.step'].map((n) => window.cadcraftStudioHub.route(n).app));
  ok(r[0] === (APPS.includes('cadcraft') ? 'cadcraft' : null), 'W2.13: .ccsheets routes to CadCraft');
  ok(r[1] === (APPS.includes('bimcraft') ? 'bimcraft' : APPS.includes('detailcraft') ? 'detailcraft' : null) && r[2] === (APPS.includes('civilcraft') ? 'civilcraft' : null), '.ifc → BimCraft, .landxml → CivilCraft (as far as the suite holds them)');

  section('Settings: "always use", theme for every window');
  await hub.click('[data-open-settings]');
  const sel = await hub.$('[data-always="pdf"]');
  if (sel) {
    ok((await sel.inputValue()) === (APPS.includes('takeoffcraft') ? 'markupcraft' : ''), 'Settings shows the remembered PDF choice');
    await hub.click('[data-set-forget]');
    ok((await hub.inputValue('[data-always="pdf"]')) === '', '"Forget my choices" clears it');
  } else ok(!APPS.includes('takeoffcraft'), 'no PDF question in a suite with one PDF app: no PDF setting');
  await hub.check('input[name="space"][value="model"]');
  ok((await hub.getAttribute('html', 'data-space')) === 'model', 'theme Model in the hub');
  await hub.click('[data-settings] [data-close]');
  const pm = await opened(() => hub.click(`[data-open-app="${APPS[0]}"]`));
  ok(pm && (await pm.getAttribute('html', 'data-space')) === 'model', 'an app opened after it is in Model too (one theme for the family)');
  if (pm) await pm.close();
  await shot(hub, 'hub-model');

  section('Handoffs between the apps inside the suite (H.6)');
  if (APPS.includes('bimcraft') && APPS.includes('cadcraft')) {
    const b = await ctx.newPage();
    await b.goto(srv.url + 'apps/bimcraft/index.html');
    ok((await b.getAttribute('main', 'data-edit-url')) === '../cadcraft/index.html', 'BimCraft\'s "Edit in CadCraft" points at the CadCraft beside it');
    await b.setInputFiles('#bc-file', { name: 'Kitchen.dwg', mimeType: 'application/octet-stream', buffer: DWG });
    await b.waitForSelector('[data-edit-drawing]', { timeout: 30000 }).catch(() => {});
    const pop = b.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
    await b.click('[data-edit-drawing]').catch(() => {});
    const c = await pop;
    if (c) {
      await c.waitForFunction(() => window.cadcraft && window.cadcraft.doc.entities.size > 50, null, { timeout: 30000 }).catch(() => {});
      ok(await c.evaluate(() => window.cadcraft && window.cadcraft.doc.entities.size > 50), 'BimCraft → CadCraft: the drawing arrives in the suite\'s CadCraft');
      await c.close();
    } else ok(false, 'BimCraft → CadCraft: no CadCraft window opened');
    await b.close();
  }
  // Every handoff button an app page carries points at an app of this suite, and every app that takes a handoff is offered.
  for (const slug of APPS) {
    const html = fs.readFileSync(path.join(DIR, 'apps', slug, 'index.html'), 'utf8');
    const urls = [...html.matchAll(/data-[a-z0-9-]+-url="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:|\.\/)/.test(u) && !u.includes('assets/'));
    ok(urls.every((u) => /^\.\.\/([a-z]+)\/index\.html$/.test(u) && APPS.includes(u.split('/')[1])), `${slug}: handoff targets ${urls.join(', ') || '(none)'} are apps of the suite`);
    ok(/"handoff":true/.test(html) && /"suite":"studio"/.test(html), `${slug}: edition flags say handoff on, suite studio`);
  }

  section('Recent files across apps (H.4)');
  await hub.evaluate(async (b64) => {
    const { createHost } = await import('./hub/host.js');
    const dir = await navigator.storage.getDirectory();
    const fh = await dir.getFileHandle('Recent.pdf', { create: true });
    const w = await fh.createWritable(); await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); await w.close();
    const f = await fh.getFile();
    const app = ['markupcraft', 'cadcraft'].find((s) => window.cadcraftStudioHub.suite.apps.some((a) => a.slug === s));
    await createHost({ app, window: null, document: null }).recent.add({ name: 'Recent.pdf', size: f.size, lastModified: f.lastModified, handle: fh }, 'open');
    await window.cadcraftStudioHub.renderRecent();
  }, Buffer.from(PDF).toString('base64'));
  const rows = await hub.$$eval('[data-recent-list] .studio-row', (n) => n.map((x) => x.querySelector('.studio-row-name').textContent + '|' + x.querySelector('.studio-row-app').textContent));
  ok(rows.some((r) => r.startsWith('Recent.pdf|')) && rows.some((r) => r.startsWith('Kitchen.dwg|')), 'files from several apps in one list, newest first: ' + rows.slice(0, 4).join(', '));
  ok(!(await hub.$eval('[data-recent-filter]', (n) => n.hidden)), 'filter chips by app once two apps have files');
  if (APPS.includes('markupcraft')) {
    const p = await opened(() => hub.click('[data-recent-list] .studio-row-open:not([disabled]) >> nth=0'));
    ok(p && /markupcraft/.test(p.url()), 'a click reopens it in the app it came from');
    if (p) {
      await p.waitForFunction(() => window.markupcraft && window.markupcraft.sheets && window.markupcraft.sheets.length > 0, null, { timeout: 30000 }).catch(() => {});
      ok(await p.evaluate(() => window.markupcraft && window.markupcraft.sheets.length > 0), 'and the app has the file');
      await p.close();
    }
  }
  ok(await hub.$eval('[data-recent-list] .studio-row', () => true).catch(() => false), 'rows render');
  const dis = await hub.$$eval('[data-recent-list] .studio-row-open[disabled]', (n) => n.map((x) => x.title));
  ok(dis.every((t) => /can't reopen/.test(t)), 'a dropped file without a handle is listed but says it can\'t reopen by itself');

  section('Offline (H.8)');
  await hub.click('[data-offline-save]');
  await hub.waitForFunction(() => /open offline/.test(document.querySelector('[data-offline-state]').textContent), null, { timeout: 120000 }).catch(() => {});
  ok(/open offline/.test(await hub.textContent('[data-offline-state]')), 'Save for offline: the hub and every app');
  srv.setDown(true);
  await hub.reload();
  await hub.waitForSelector('html.studio-ready', { timeout: 15000 }).catch(() => {});
  ok((await hub.$$('[data-tiles] [data-app]')).length === APPS.length, 'server gone: the hub still opens');
  const off = await ctx.newPage();
  await off.goto(srv.url + 'apps/' + APPS[0] + '/', { timeout: 15000 }).catch(() => {});
  await off.waitForSelector('[data-studio-hub]', { timeout: 20000 }).catch(() => {});
  ok(!!(await off.$('[data-studio-hub]')), `server gone: ${APPS[0]} still opens`);
  await off.close();
  srv.setDown(false);
  await hub.reload();
  await hub.click('[data-offline-remove]');
  await hub.waitForFunction(() => !/open offline/.test(document.querySelector('[data-offline-state]').textContent), null, { timeout: 10000 }).catch(() => {});
  ok(!/open offline/.test(await hub.textContent('[data-offline-state]')), 'the offline copy can be removed');

  section('Clean');
  const okProblems = problems.filter((p) => !/ERR_CONNECTION|ERR_EMPTY_RESPONSE|net::|Failed to fetch/.test(p));
  ok(!okProblems.length, 'no console errors' + (okProblems.length ? ': ' + okProblems.slice(0, 5).join(' | ') : ''));
  ok(!srv.outside.length, 'no request left the suite\'s folder' + (srv.outside.length ? ': ' + [...new Set(srv.outside)].slice(0, 5).join(', ') : ''));
} finally {
  await browser.close();
  await srv.close();
}
done();
