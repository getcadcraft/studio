#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * browser-undo.mjs — "Undo last step" across Studio's windows (0.9 EG.77) in a real browser, on the packed suite: the hub and two app windows
 * (DetailCraft, TakeoffCraft) of one origin. Each app tells its finished steps (its own undo hook), window.js puts them on the channel, the hub's journal
 * names the newest, asks before it acts, then asks that one window to probe and run its OWN next undo. A closed window is skipped, a window that moved on is
 * never forced. Dragging between two real desktop windows and the desktop shell's own windows are hand checks.
 *   node test/browser-undo.mjs [--suite <folder>]
 */
import path from 'node:path';
import { chromium, serve, SUITE, ok, section, done } from './lib.mjs';

const i = process.argv.indexOf('--suite');
const suite = path.resolve(i > 0 ? process.argv[i + 1] : SUITE('dev'));
const srv = await serve(suite);
const browser = await chromium();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const problems = [];
ctx.on('page', (p) => { p.on('pageerror', (e) => problems.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|404|ERR_/.test(m.text())) problems.push(m.text()); }); });
await ctx.route((u) => !/^http:\/\/127\.0\.0\.1[:/]/.test(u.href) && !/^(data|blob|about):/.test(u.protocol), (r) => r.abort());
const ready = async (p, slug, model) => { await p.goto(srv.url + 'apps/' + slug + '/index.html'); await p.waitForFunction((m) => { try { return !!eval(m) && !!window.ccUndoReporter && !!window.cadcraftStudio; } catch (e) { return false; } }, model, { timeout: 40000 }); };
try {
  section('Undo across windows (EG.77): the hub and two apps');
  const hub = await ctx.newPage();
  await hub.goto(srv.url + '?space=paper');
  await hub.waitForSelector('[data-windows]', { state: 'attached' });
  const D = await ctx.newPage(), T = await ctx.newPage();
  await ready(D, 'detailcraft', 'window.detailcraft.model');
  await ready(T, 'takeoffcraft', 'window.takeoffcraft.model');
  ok(true, 'both app windows carry the reporter and the Studio channel');
  const box = hub.locator('[data-undo-across]');
  ok(await box.isHidden(), 'before any step the hub offers no undo');
  await D.evaluate(() => window.detailcraft.model.change('Rename the model', (tx) => tx.setName('undo-across-D')));
  await hub.waitForSelector('[data-undo-across]:not([hidden])', { timeout: 8000 }).catch(() => {});
  const what1 = await hub.textContent('[data-undo-what]').catch(() => '');
  ok(/Rename the model/.test(what1) && /DetailCraft/.test(what1), 'after a step in DetailCraft the hub names it: "' + what1.trim() + '"');
  await T.evaluate(() => window.takeoffcraft.model.change('Rename the takeoff', (s) => { s.name = 'undo-across-T'; }));
  await hub.waitForFunction(() => /Rename the takeoff/.test(document.querySelector('[data-undo-what]')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  const what2 = await hub.textContent('[data-undo-what]');
  ok(/Rename the takeoff/.test(what2) && /TakeoffCraft/.test(what2), 'the newest step, in the other window, is the one named: "' + what2.trim() + '"');
  // asks first; No changes nothing
  await hub.click('[data-undo-run]');
  await hub.waitForSelector('[data-confirm][open]');
  const q = await hub.textContent('[data-confirm-title]');
  ok(/Rename the takeoff/.test(q) && /TakeoffCraft/.test(q), 'it asks first: "' + q.trim() + '"');
  await hub.click('[data-confirm-cancel]');
  ok((await T.evaluate(() => window.takeoffcraft.model.state.name)) === 'undo-across-T', 'No: nothing is undone');
  // Yes: that window's own undo runs
  await hub.click('[data-undo-run]');
  await hub.waitForSelector('[data-confirm][open]');
  await hub.click('[data-confirm-go]');
  await T.waitForFunction(() => window.takeoffcraft.model.state.name !== 'undo-across-T', null, { timeout: 8000 }).catch(() => {});
  ok((await T.evaluate(() => window.takeoffcraft.model.state.name)) !== 'undo-across-T', 'Yes: TakeoffCraft\'s own undo ran');
  ok((await D.evaluate(() => window.detailcraft.model.state.name)) === 'undo-across-D', 'DetailCraft was not touched');
  await hub.waitForFunction(() => /Rename the model/.test(document.querySelector('[data-undo-what]')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  ok(/Rename the model/.test(await hub.textContent('[data-undo-what]')), 'the hub now names the step before it: DetailCraft\'s');
  const status = await hub.textContent('[data-studio-status]');
  ok(/Undid/.test(status) && /TakeoffCraft/.test(status), 'the hub says what it did: "' + status.trim() + '"');
  // a window that moved on is never forced: edit in DetailCraft BEHIND the reporter (stack changed with no report), then ask
  await D.evaluate(() => { const m = window.detailcraft.model; m.undoStack.push({ label: 'unreported', before: JSON.stringify(m.state) }); });
  await hub.click('[data-undo-run]');
  await hub.waitForSelector('[data-confirm][open]');
  await hub.click('[data-confirm-go]');
  await hub.waitForFunction(() => /changed since|Nothing was undone/.test(document.querySelector('[data-studio-status]')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  ok(/Nothing was undone/.test(await hub.textContent('[data-studio-status]')), 'a window that changed behind the reporter is skipped, not forced');
  ok((await D.evaluate(() => window.detailcraft.model.state.name)) === 'undo-across-D', 'its model was left as it was');
  // a closed window: its entry is forgotten
  await T.evaluate(() => window.takeoffcraft.model.change('Another takeoff step', (s) => { s.name = 'T2'; }));
  await hub.waitForFunction(() => /Another takeoff step/.test(document.querySelector('[data-undo-what]')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  await T.close();
  await hub.waitForFunction(() => !/Another takeoff step/.test(document.querySelector('[data-undo-what]')?.textContent || 'x'), null, { timeout: 8000 }).catch(() => {});
  const left = await hub.evaluate(() => { const n = window.cadcraftStudioHub.journal.next(); return n ? n.label + ' / ' + n.app : ''; });
  ok(!/Another takeoff step/.test(left), 'closing a window takes its steps off the hub (the journal now offers: ' + left + ')');
  ok(problems.length === 0, 'no console or page errors' + (problems.length ? ': ' + problems.slice(0, 3).join(' | ') : ''));
} catch (err) { ok(false, 'threw: ' + (err && err.message || err)); }
await browser.close(); await srv.close();
done();
