#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// test-hub.mjs — Studio's DOM-free modules (H.5 routing + W2.13, H.11 channel, C.7/C.8 cloud client and save queue,
// the handoff record format) and the language file.   node test/test-hub.mjs [--verbose]
import fs from 'node:fs';
import path from 'node:path';
import { STUDIO, SITE, SHELL, ok, section, done } from './lib.mjs';

const R = await import(path.join(STUDIO, 'hub/route.js'));
const C = await import(path.join(STUDIO, 'hub/channel.js'));
const Q = await import(path.join(STUDIO, 'hub/cloud.js'));

section('Routing by type (H.5, W2.13)');
const ALL = ['cadcraft', 'bimcraft', 'modelcraft', 'markupcraft', 'takeoffcraft', 'civilcraft', 'detailcraft', 'partcraft'];
ok(R.extOf('Level 1.DWG') === 'dwg' && R.extOf('C:\\Jobs\\a.b\\Plan.dxf') === 'dxf' && R.extOf('Job.takeoff.json') === 'takeoff.json' && R.extOf('x.json') === 'json' && R.extOf('README') === '' && R.extOf('.hidden') === '', 'extOf: case, folders with dots, two-part types, none');
const r1 = R.route('Plan.dwg', { apps: ALL });
ok(r1.app === 'cadcraft' && !r1.ask && r1.apps.includes('bimcraft'), '.dwg → CadCraft (others offered)');
ok(R.route('Plan.dxf', { apps: ALL }).app === 'cadcraft', '.dxf → CadCraft');
ok(R.route('Tower.ccsheets', { apps: ALL }).app === 'cadcraft', 'W2.13: .ccsheets → CadCraft');
ok(R.route('Model.ifc', { apps: ALL }).app === 'bimcraft', '.ifc → BimCraft');
ok(R.route('a.rvt', { apps: ALL }).app === 'bimcraft' && R.route('a.step', { apps: ALL }).app === 'partcraft' && R.route('s.landxml', { apps: ALL }).app === 'civilcraft' && R.route('h.obj', { apps: ALL }).app === 'modelcraft', '.rvt BimCraft, .step PartCraft, .landxml CivilCraft, .obj ModelCraft');
const pdf = R.route('Plans.pdf', { apps: ALL });
ok(pdf.ask && pdf.app === null && pdf.apps.join() === 'markupcraft,takeoffcraft', '.pdf asks: MarkupCraft or TakeoffCraft');
ok(R.route('Plans.pdf', { apps: ALL, always: { pdf: 'takeoffcraft' } }).app === 'takeoffcraft', '"always use" answers the question');
ok(R.route('Plans.pdf', { apps: ['cadcraft', 'markupcraft'] }).app === 'markupcraft', 'only one PDF app in the suite → no question');
ok(R.route('Plans.pdf', { apps: ['markupcraft'], always: { pdf: 'takeoffcraft' } }).app === 'markupcraft', 'an "always" app missing from the suite is ignored');
ok(R.route('a.dwg', { apps: ['bimcraft', 'markupcraft'] }).app === 'bimcraft', 'without CadCraft, .dwg → the next app that reads it');
ok(!R.route('notes.docx', { apps: ALL }).known && R.route('notes.docx', { apps: ALL }).app === null, 'an unknown type → known false');
const g = R.group(['a.dwg', 'b.pdf', 'c.dwg', 'd.zzz', 'e.ifc'], { apps: ALL });
ok(g.byApp.get('cadcraft').join() === '0,2' && g.ask.length === 1 && g.unknown.length === 1 && g.byApp.get('bimcraft').join() === '4', 'group(): batches per app, questions and unknowns apart');
ok(JSON.stringify(R.cleanAlways('{"pdf":"takeoffcraft","dwg":"evil","zzz":"cadcraft","ifc":"partcraft"}', ALL)) === '{"pdf":"takeoffcraft"}' && JSON.stringify(R.cleanAlways('not json')) === '{}', 'cleanAlways drops apps that cannot open the type, unknown types, junk');
ok(R.knownExtensions(['markupcraft']).join() === 'pdf', 'knownExtensions for a suite');
// Every type the desktop installer associates is routed (the desktop shell's apps.json; CADCRAFT_SHELL, else skipped).
if (SHELL) {
  const deskApps = JSON.parse(fs.readFileSync(path.join(SHELL, 'apps.json'), 'utf8'));
  const unrouted = [];
  for (const [slug, d] of Object.entries(deskApps)) if (!slug.startsWith('_')) for (const e of [...d.files.own, ...d.files.polite, ...d.files.openWith]) if (!R.ROUTES[e] || !R.ROUTES[e].apps.includes(slug)) unrouted.push(slug + ':' + e);
  ok(!unrouted.length, 'every file type the desktop installers register reaches its app' + (unrouted.length ? ': ' + unrouted.join(', ') : ''));
} else console.log('  (CADCRAFT_SHELL not set: the desktop file-type check is skipped)');

section('The window channel (H.11)');
{
  // An in-memory BroadcastChannel shared by "windows".
  const subs = new Set();
  class FakeBC { constructor() { subs.add(this); } postMessage(m) { const c = structuredClone(m); for (const s of subs) if (s !== this) queueMicrotask(() => s.onmessage && s.onmessage({ data: c })); } close() { subs.delete(this); } }
  const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };
  const s1 = mem();
  const id1 = C.windowId('cadcraft', { storage: s1 });
  ok(/^cadcraft-[a-z0-9]+$/.test(id1) && C.windowId('cadcraft', { storage: s1 }) === id1, 'window id: per app, kept across reloads of the tab');
  ok(C.windowId('cadcraft', { storage: s1, desktopId: 'app-cadcraft-2' }) === 'app-cadcraft-2', 'the desktop shell\'s window id wins');
  const hub = C.openChannel({ app: 'studio', id: 'main', title: 'Studio', BC: FakeBC });
  const got = [];
  hub.on('hello', (d, e) => got.push(['hello', e.from, e.app]));
  const cad = C.openChannel({ app: 'cadcraft', id: 'cadcraft-x1', title: 'Plan.dwg — CadCraft', BC: FakeBC });
  const mk = C.openChannel({ app: 'markupcraft', id: 'markupcraft-y2', BC: FakeBC });
  await new Promise((r) => setTimeout(r, 5));
  ok(got.length === 2 && got[0][1] === 'cadcraft-x1' && got[0][2] === 'cadcraft', 'a new window says hello with its id and app');
  const peers = await hub.peers(30);
  ok(peers.length === 2 && peers.find((p) => p.id === 'cadcraft-x1').title === 'Plan.dwg — CadCraft', 'peers(): every window answers with its title');
  const toCad = [], toMk = [];
  cad.on('window.focus', (d, e) => toCad.push(e.from));
  mk.on('window.focus', () => toMk.push(1));
  hub.post('window.focus', null, 'cadcraft-x1');
  await new Promise((r) => setTimeout(r, 5));
  ok(toCad.join() === 'main' && !toMk.length, 'a message to one window reaches only it');
  const all = [];
  cad.on('theme.changed', (d) => all.push(d.space)); mk.on('theme.changed', (d) => all.push(d.space));
  hub.post('theme.changed', { space: 'model' });
  await new Promise((r) => setTimeout(r, 5));
  ok(all.join() === 'model,model', 'a message to everyone reaches every window, not the sender');
  ok(C.cleanEnvelope({ v: 1, id: 'x', from: 'Bad Id!', type: 'a', at: 1 }) === null && C.cleanEnvelope({ v: 2, id: 'x', from: 'a', type: 'a' }) === null && C.cleanEnvelope({ v: 1, id: 'x', from: 'a', type: '<script>' }) === null, 'malformed envelopes are dropped');
  let threw = false; try { hub.post('Not A Type'); } catch { threw = true; }
  ok(threw, 'post() refuses a malformed type');
  const bye = [];
  hub.on('bye', (d, e) => bye.push(e.from));
  mk.close();
  await new Promise((r) => setTimeout(r, 5));
  ok(bye.join() === 'markupcraft-y2', 'close() says bye');
  const lone = C.openChannel({ app: 'x', id: 'x-1', BC: null, storage: null, win: null });
  ok(lone.kind === 'none' && (await lone.peers(5)).length === 0, 'no transport: a lone window, no errors');
  hub.close(); cad.close();
}

section('Cloud client and the save queue (C.7, C.8)');
{
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
  const reply = (status, json, headers = {}) => ({ status, headers, body: json instanceof Uint8Array ? json : enc(json), json: () => JSON.parse(new TextDecoder().decode(json instanceof Uint8Array ? json : enc(json))) });
  const server = { saves: [], mode: 'ok', calls: [] };
  const request = async (o) => {
    server.calls.push(o.method + ' ' + o.path);
    if (server.mode === 'offline') throw Object.assign(new Error('net'), { code: 'error' });
    if (server.mode === 'revoked') return reply(401, { status: 'error', error: 'Signed out', code: 'token_revoked' });
    if (o.path === '/api/v1/sync/status') return reply(200, { status: 'success', data: { user: { id: 1, name: 'Ana', email: 'a@x.test', email_verified: true },
      workspaces: [{ uuid: '11111111-1111-4111-8111-111111111111', name: "Ana's workspace", kind: 'personal', role: 'owner', apps: [], cloud_open: false, storage: null },
        { uuid: '22222222-2222-4222-8222-222222222222', name: 'Studio Nord', kind: 'team', role: 'member', apps: ['cadcraft'], cloud_open: true, storage: { used_bytes: 5e11, quota_bytes: 1e12, used_label: '0.5 TB', quota_label: '1 TB' } }] } });
    if (o.path.startsWith('/api/v1/sync/drawings?')) return reply(200, { status: 'success', data: { drawings: [{ uuid: '33333333-3333-4333-8333-333333333333', name: 'Plan', app: 'cadcraft', version: { no: 2 } }], server_time: 't' } });
    if (o.path.startsWith('/api/v1/sync/open?')) {
      const bytes = new Uint8Array([1, 2, 3]);
      const sha = server.badSha ? '00' : await Q.sha256Hex(bytes);
      return { status: 200, headers: { 'x-cadcraft-version': '2', 'x-cadcraft-sha256': sha }, body: bytes, json: () => { throw new Error('binary'); } };
    }
    if (o.path.startsWith('/api/v1/sync/save?')) {
      const q = new URLSearchParams(o.path.split('?')[1]);
      server.saves.push(Object.fromEntries(q));
      if (server.mode === 'conflict') return reply(409, { status: 'error', error: 'newer', code: 'conflict', drawing: { uuid: 'd', project: '44444444-4444-4444-8444-444444444444' }, current: { no: 3 } });
      if (server.mode === 'throttled') return reply(429, { status: 'error', code: 'throttled' }, { 'retry-after': '60' });
      if (server.mode === 'quota') return reply(507, { status: 'error', code: 'over_quota', error: 'full' });
      return reply(201, { status: 'success', data: { version: { no: 3 } } });
    }
    return reply(404, { status: 'error', code: 'not_found' });
  };
  const client = Q.cloudClient({ request });
  const st = await client.status();
  const m = Q.cardModel(st);
  ok(m.user.name === 'Ana' && m.workspace.name === 'Studio Nord' && m.workspace.open && m.workspace.used === '0.5 TB' && m.workspace.fraction === 0.5, 'card: the first workspace with cloud open, storage used/quota from the server\'s words');
  ok(Q.cardModel(st, { workspace: '11111111-1111-4111-8111-111111111111' }).workspace.open === false && m.workspaces.length === 2, 'card: a chosen workspace; every workspace listed');
  ok(Q.cardModel(null) === null && Q.cardModel({}) === null, 'card: nothing without a user');
  {
    // SI.6: a team's page slug from /api/v1/me when sync/status has none; never an unsafe one; a personal workspace has none.
    const nord = st.workspaces.find((w) => w.name === 'Studio Nord');
    const bare = { ...st, workspaces: st.workspaces.map((w) => ({ ...w, slug: undefined })) };
    const me = { organizations: [{ uuid: nord.uuid, kind: nord.kind, slug: 'studio-nord' }] };
    ok(Q.cardModel(bare, { workspace: nord.uuid, me }).workspace.slug === 'studio-nord', 'card: the team slug from /api/v1/me (sync/status has none)');
    ok(Q.cardModel(bare, { workspace: nord.uuid }).workspace.slug === null, 'card: no /me → no slug (links fall back to /account)');
    ok(Q.cardModel(bare, { workspace: nord.uuid, me: { organizations: [{ uuid: nord.uuid, slug: '../admin' }] } }).workspace.slug === null, 'card: a slug that isn\'t [a-z0-9-] is ignored');
  }
  ok((await client.drawings('22222222-2222-4222-8222-222222222222')).drawings[0].name === 'Plan', 'drawings of a workspace');
  let bad = null; try { await client.drawings('../me'); } catch (e) { bad = e.code; }
  ok(bad === 'invalid', 'a workspace id that is not a UUID never reaches the server');
  const o1 = await client.open('33333333-3333-4333-8333-333333333333');
  ok(o1.bytes.length === 3 && o1.version === 2, 'open: bytes + version');
  server.badSha = true;
  bad = null; try { await client.open('33333333-3333-4333-8333-333333333333'); } catch (e) { bad = e.code; }
  ok(bad === 'checksum', 'open: a SHA-256 that does not match is refused');
  server.badSha = false;
  server.mode = 'revoked';
  bad = null; try { await client.status(); } catch (e) { bad = e.code; }
  ok(bad === 'token_revoked' && Q.SIGN_IN_AGAIN.has(bad), '401 token_revoked → "sign in again"');
  server.mode = 'offline';
  bad = null; try { await client.status(); } catch (e) { bad = e.code; }
  ok(bad === 'offline', 'no connection → offline');

  let t = 1000;
  const events = [];
  const q = new Q.SyncQueue({ client, store: Q.queueStore(null), now: () => t, onChange: (s, ev) => ev && events.push(ev.type) });
  const a = await q.enqueue({ drawing: '33333333-3333-4333-8333-333333333333', app: 'cadcraft', name: 'Plan.dwg', base: 2, bytes: new Uint8Array([9, 9]) });
  ok(a.saveId && a.sha256 && (await q.summary()).waiting === 1, 'enqueue: a save_id and the bytes\' SHA-256, waiting');
  server.mode = 'offline';
  await q.flush();
  ok((await q.summary()).waiting === 1 && events.at(-1) === 'retry', 'offline: the save stays, a retry is planned');
  server.mode = 'ok';
  await q.flush();
  ok((await q.summary()).waiting === 1, 'before the retry time nothing is sent');
  t += 10000;
  const saveIdBefore = a.saveId;
  await q.flush();
  ok((await q.summary()).total === 0 && server.saves.at(-1).save_id === saveIdBefore && server.saves.at(-1).base === '2' && server.saves.at(-1).source === 'desktop-app', 'the connection returns: sent once, with the same save_id (the server answers "replayed" to a repeat), base and source');
  ok(server.saves.length === 1, 'the offline attempt never reached the server');
  server.mode = 'conflict';
  const c = await q.enqueue({ drawing: '33333333-3333-4333-8333-333333333333', app: 'cadcraft', name: 'Plan.dwg', base: 2, bytes: new Uint8Array([1]) });
  await q.flush();
  const cl = await q.list();
  ok(cl.length === 1 && cl[0].state === 'conflict' && cl[0].result.drawing.project && cl[0].bytes.length === 1, '409: kept as a conflict with the newer version\'s facts, bytes kept, nothing overwritten');
  await q.flush();
  ok(server.saves.length === 2, 'a conflict is never re-sent by itself');
  await q.remove(c.id);
  server.mode = 'revoked';
  await q.enqueue({ project: '44444444-4444-4444-8444-444444444444', app: 'cadcraft', name: 'New.dwg', bytes: new Uint8Array([2]) });
  await q.flush();
  ok(q.paused === 'signin' && (await q.summary()).waiting === 1 && events.includes('signin'), 'signed out on the website: the queue pauses, the save waits');
  server.mode = 'ok';
  await q.flush();
  ok((await q.summary()).waiting === 1, 'paused: nothing is sent until sign-in');
  q.resume();
  await q.flush();
  ok((await q.summary()).total === 0 && server.saves.at(-1).project && server.saves.at(-1).name === 'New.dwg' && server.saves.at(-1).base === '0', 'signed in again: a new drawing is created (project + app + name, base 0)');
  server.mode = 'quota';
  await q.enqueue({ drawing: '33333333-3333-4333-8333-333333333333', app: 'cadcraft', name: 'Big.dwg', base: 3, bytes: new Uint8Array([3]) });
  await q.flush();
  ok((await q.list())[0].state === 'failed' && (await q.list())[0].error === 'over_quota', '507: failed with the reason, kept (never lost)');
  let typeErr = false; try { await q.enqueue({ app: 'cadcraft', name: 'x', bytes: new Uint8Array() }); } catch { typeErr = true; }
  ok(typeErr, 'a save names a drawing, or a project + app + name');
}

section('Handoff record (the hub writes what the apps read)');
if (!SITE) console.log('  (CADCRAFT_SITE not set: the comparison with the apps\' handoff.js is skipped)');
else {
  const hub = fs.readFileSync(path.join(STUDIO, 'hub/handoff.js'), 'utf8');
  const app = fs.readFileSync(path.join(SITE, 'public_html/assets/apps/bimcraft/dev/handoff.js'), 'utf8');
  const v = (s, re) => (s.match(re) || [])[1];
  ok(v(hub, /const DB = '([^']+)'/) === v(app, /const DB = '([^']+)'/) && v(hub, /const STORE = '([^']+)'/) === v(app, /const STORE = '([^']+)'/), 'same database and store as bimcraft/dev/handoff.js');
  ok(/s\.put\(\{ file, name: file\.name, from: String\(from \|\| ''\), at: Date\.now\(\) \}, id/.test(hub) && /s\.put\(\{ file, name: file\.name, from: String\(from \|\| ''\), at: Date\.now\(\) \}, id\.toLowerCase\(\)\)/.test(app), 'same record {file, name, from, at} under the lower-case id');
  ok(/MAX_AGE_MS = 10 \* 60 \* 1000/.test(hub) && /MAX_AGE_MS = 10 \* 60 \* 1000/.test(app), 'same expiry (10 minutes)');
}

section('News from getcadcraft.com (SI.5)');
{
  const N = await import(path.join(STUDIO, 'hub/news.js'));
  ok(N.newer('0.5', '0.4.1') && N.newer('0.4.1', '0.4') && !N.newer('0.4', '0.4.0') && !N.newer('0.4', '0.5') && !N.newer('0.5', 'dev') && !N.newer('junk', '0.1'), 'newer(): x.y[.z], a dev build is never compared');
  const items = N.cleanItems([
    { kind: 'news', title: 'CadCraft 0.5', summary: 'Live\u0000 sessions', app: null, published_at: '2026-10-20T10:00:00Z', url: 'https://getcadcraft.com/news/cadcraft-0-5' },
    { kind: 'tutorial', title: 'Share live', summary: 'x'.repeat(900), app: 'cadcraft', published_at: '2026-10-21T10:00:00Z', url: 'https://getcadcraft.com/tutorials/cadcraft/live' },
    { kind: 'news', title: 'Evil', published_at: '2026-10-22T00:00:00Z', url: 'javascript:alert(1)' },
    { kind: 'news', title: 'Elsewhere', published_at: '2026-10-22T00:00:00Z', url: 'https://evil.example/news' },
    { kind: 'news', title: '', published_at: '2026-10-22T00:00:00Z', url: 'https://getcadcraft.com/news/x' },
    { kind: 'news', title: 'No date', url: 'https://getcadcraft.com/news/y' }, null, 'junk',
    { kind: 'odd', title: 'Odd app', app: 'ninthcraft', published_at: '2026-10-01T00:00:00Z', url: 'https://getcadcraft.com/news/z' },
  ]);
  ok(items.map((i) => i.title).join('|') === 'Share live|CadCraft 0.5|Odd app', 'only site links with a title and a date, newest first');
  ok(items[0].kind === 'tutorial' && items[0].app === 'cadcraft' && items[0].summary.length === 400 && items[1].summary === 'Live sessions' && items[2].kind === 'news' && items[2].app === null, 'kinds, apps, summaries cleaned and capped');
  ok(N.cleanLatest({ downloads: { version: '0.4', url: 'https://getcadcraft.com/download', studio: { version: '0.4.1' } } }).version === '0.4.1' && N.cleanLatest({ downloads: { version: '0.5' } }).url === 'https://getcadcraft.com/download' && N.cleanLatest({}) === null && N.cleanLatest({ downloads: { version: '<b>' } }) === null, 'the newest release from the catalog (Studio\'s first)');
  const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  let now = Date.parse('2026-10-22T12:00:00Z'), calls = [], down = false;
  const fetch = async (url, o) => {
    calls.push([url, o && o.credentials]);
    if (down) throw new TypeError('Failed to fetch');
    const body = url.includes('/news') ? { data: { items: [{ kind: 'news', title: 'CadCraft 0.5', summary: 's', published_at: '2026-10-20T10:00:00Z', url: 'https://getcadcraft.com/news/cadcraft-0-5' }] } } : { data: { downloads: { version: '0.5', url: 'https://getcadcraft.com/download' } } };
    return { ok: true, status: 200, json: async () => body };
  };
  const st = mem();
  const f = N.newsFeed({ fetch, storage: st, now: () => now });
  ok(f.cached().items.length === 0 && f.cached().at === 0, 'nothing kept before the first fetch');
  const a = await f.load();
  ok(a.items.length === 1 && a.latest.version === '0.5' && !a.offline && calls.length === 2, 'the first open asks the site: news + catalog');
  ok(calls.every(([u, cr]) => u.startsWith('https://getcadcraft.com/api/v1/') && cr === 'omit') && !calls.some(([u]) => /app=|since=|name|email/.test(u)), 'anonymous: no cookies, nothing about the person in the request');
  now += 3600000;
  await f.load();
  ok(calls.length === 2, 'within a day: from the kept copy, no request');
  now += N.DAY;
  down = true;
  const b = await f.load();
  ok(calls.length === 4 && b.offline && b.items.length === 1 && b.items[0].title === 'CadCraft 0.5', 'a day later offline: the kept copy, marked offline');
  ok(N.newsFeed({ fetch, storage: st, now: () => now }).cached().items[0].url === 'https://getcadcraft.com/news/cadcraft-0-5', 'kept across restarts');
  down = false;
  await f.load({ force: true });
  ok(calls.length === 6, 'force asks again');
  f.forget();
  ok(f.cached().items.length === 0, 'turning news off forgets the copy');
  // Dismissing What's new (owner, 2026-10-15): remembered by what was newest, back only when something is newer.
  {
    const ds = mem();
    let t0 = Date.parse('2026-10-22T12:00:00Z');
    const d = N.newsDismissal({ storage: ds, now: () => t0 });
    const seen = { items: [{ date: Date.parse('2026-10-20T10:00:00Z') }], latest: { version: '0.5' } };
    ok(!d.hidden(seen, 'b1') && d.get() === null, 'not dismissed: shown');
    d.dismiss(seen, 'b1');
    ok(d.hidden(seen, 'b1') && d.get().version === '0.5' && d.get().at === t0, 'dismissed: hidden, remembered with when and the newest release');
    ok(N.newsDismissal({ storage: ds }).hidden(seen, 'b1'), 'still hidden after a restart');
    ok(d.hidden({ items: [{ date: Date.parse('2026-10-21T10:00:00Z') }], latest: { version: '0.5' } }, 'b1'), 'a post published before the dismissal does not bring it back (even one not seen yet)');
    ok(!d.hidden({ items: [...seen.items, { date: t0 + 60000 }], latest: { version: '0.5' } }, 'b1'), 'a post published after it: back');
    ok(!d.hidden({ items: seen.items, latest: { version: '0.5.1' } }, 'b1') && d.hidden({ items: seen.items, latest: { version: '0.4' } }, 'b1'), 'a newer release: back (an older one is not newer)');
    ok(!d.hidden(seen, 'b2'), 'another build (new release notes): back');
    t0 = Date.parse('2026-10-22T12:00:00Z');
    const ahead = { items: [{ date: t0 + 3 * 86400000 }], latest: null };
    d.dismiss(ahead, 'b1');
    ok(d.hidden(ahead, 'b1') && !d.hidden({ items: [{ date: t0 + 4 * 86400000 }], latest: null }, 'b1'), 'a post dated ahead of this computer\'s clock: dismissing still holds; a later one brings it back');
    d.dismiss(seen, 'b1');
    ok(d.hidden({ items: [], latest: null }, 'b1'), 'news off or offline with nothing kept: stays away');
    ds.setItem('cadcraft.studio.news.dismissed', '{"at":"soon"}');
    ok(!d.hidden(seen, 'b1') && d.get() === null, 'a damaged mark counts as not dismissed');
    d.dismiss(seen, 'b1'); d.clear();
    ok(!d.hidden(seen, 'b1') && d.get() === null, 'clear(): shown again');
  }
  const hubSrc = fs.readFileSync(path.join(STUDIO, 'hub/hub.js'), 'utf8');
  ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(hubSrc), 'the hub never builds HTML from strings (news text goes in through el())');
}

section('Language file');
{
  const en = JSON.parse(fs.readFileSync(path.join(STUDIO, 'hub/lang/en.json'), 'utf8'));
  // window.js (packed into every app page) looks its window.* words up with T().
  const src = ['hub.js', 'index.html', 'window.js'].map((f) => fs.readFileSync(path.join(STUDIO, 'hub', f), 'utf8')).join('\n');
  // Studio Live's words (hub/live/*.js, window.live.* and live.join.*) are checked by test-live.mjs.
  const liveKey = (k) => k.startsWith('window.live.') || k.startsWith('live.join.');
  const used = new Set([...src.matchAll(/\b[tT]\('([a-z0-9.]+)'[,)]/g), ...src.matchAll(/\? '([a-z0-9]+\.[a-z0-9.]+)' : '([a-z0-9.]+)'/g), ...src.matchAll(/data-t(?:-title|-label)?="([a-z0-9.]+)"/g)].flatMap((m) => m.slice(1).filter(Boolean)));
  for (const k of ['open', 'start', 'recent', 'windows', 'live', 'account', 'assistants', 'offline']) { used.add(`help.${k}.title`); used.add(`help.${k}.body`); }
  for (const k of ['edition.browser', 'edition.desktop', 'noscript', 'studio.short', 'window.hub', 'window.hub.title']) used.add(k);
  const missing = [...used].filter((k) => !liveKey(k) && !(k in en));
  ok(!missing.length, 'every key the hub uses exists' + (missing.length ? ': ' + missing.join(', ') : ''));
  const unused = Object.keys(en).filter((k) => !k.startsWith('@') && !used.has(k) && !liveKey(k));
  ok(!unused.length, 'no unused keys' + (unused.length ? ': ' + unused.join(', ') : ''));
  const text = Object.entries(en).filter(([k]) => !k.startsWith('@')).map(([, v]) => (typeof v === 'string' ? v : Object.values(v).join(' '))).join('\n');
  ok(!/\bcrafts\b/i.test(text) && !/→/.test(text) && !/\bnine\b/i.test(text), 'copy rules: never "crafts", no arrows, never "nine"');
  ok(!/AutoCAD|Revit|SketchUp|Bluebeam|PlanSwift|Tekla|SolidWorks|Civil 3D/.test(text), 'no other companies\' product names');
  const name = en['studio.name'];
  const hardcoded = ['hub.js', 'route.js', 'channel.js', 'cloud.js', 'window.js', 'handoff.js'].filter((f) => fs.readFileSync(path.join(STUDIO, 'hub', f), 'utf8').split('\n').some((l) => l.includes("'" + name + "'") || l.includes('"' + name + '"')));
  ok(!hardcoded.length, 'the working name lives only in the language file (decision 13)' + (hardcoded.length ? ': ' + hardcoded.join(', ') : ''));
}

section('SPDX');
{
  const files = ['hub', 'hub/live', 'pack', 'test'].flatMap((d) => fs.readdirSync(path.join(STUDIO, d)).filter((f) => /\.(m?js|css|php|html)$/.test(f)).map((f) => path.join(d, f)));
  const missing = files.filter((f) => !/SPDX-License-Identifier: Apache-2\.0/.test(fs.readFileSync(path.join(STUDIO, f), 'utf8').slice(0, 400)));
  ok(!missing.length, `every source file carries the Apache-2.0 SPDX line (${files.length})` + (missing.length ? ': ' + missing.join(', ') : ''));
}

done();
