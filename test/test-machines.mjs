#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// test-machines.mjs — EG.40: send a job to a printer / CNC / laser on the local network. The drivers (hub/machines.js) against fake
// OctoPrint, Moonraker, PrusaLink and Duet servers on 127.0.0.1, through a Node transport that enforces the same rules the desktop
// shell does (private addresses only, the key filled in from a store the page cannot read, no redirects).   node test/test-machines.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { STUDIO, ok, section, done } from './lib.mjs';

const M = await import(path.join(STUDIO, 'hub/machines.js'));

section('Machines and addresses (EG.40)');
{
  const lan = (h) => M.isLanHost(h);
  ok(lan('192.168.1.40') && lan('10.0.0.5') && lan('172.16.0.1') && lan('172.31.255.254') && lan('169.254.3.4'), 'private IPv4 ranges');
  ok(!lan('172.32.0.1') && !lan('8.8.8.8') && !lan('11.0.0.1') && !lan('192.169.0.1') && !lan('127.0.0.1') && !lan('0.0.0.0'), 'public, near-miss and loopback addresses are not (loopback only with the test flag)');
  ok(M.isLanHost('127.0.0.1', { loopback: true }) && M.isLanHost('localhost', { loopback: true }) && !lan('localhost'), 'loopback is allowed in tests only');
  ok(lan('printer') && lan('ender.local') && lan('cnc.lan') && lan('mill.home.arpa') && !lan('example.com') && !lan('printer.example.com'), 'one-label and local-only names; public names are not');
  ok(lan('fd12:3456::1') && lan('fe80::1') && !lan('2001:db8::1') && !lan('::1'), 'IPv6 ULA and link-local');
  ok(!lan('999.1.1.1') && !lan('1.2.3') && !lan('') && !lan('a'.repeat(300)) && !lan('bad host') && !lan(null), 'malformed → no');
  const m = M.cleanMachine({ id: 'ender-3', name: ' Ender \u0007 3 ', kind: 'octoprint', host: '192.168.1.40', apiKey: 'SECRET', tls: true });
  ok(m && m.name === 'Ender   3', 'a machine; control characters out of the name');
  ok(m.port === 80 && m.device === 'printer' && m.tls === true && !('apiKey' in m) && !JSON.stringify(m).includes('SECRET'), 'defaults; the key is never part of the record');
  ok(M.cleanMachine({ id: 'x', kind: 'octoprint', host: '192.168.1.1' }) === null && M.cleanMachine({ id: 'abc', kind: 'nope', host: '192.168.1.1' }) === null && M.cleanMachine({ id: 'abc', kind: 'duet', host: '8.8.8.8' }) === null, 'bad id, kind or a public address → null');
  ok(M.cleanMachine({ id: 'mill-1', kind: 'duet', host: '192.168.1.9', device: 'cnc' }).device === 'cnc' && M.cleanMachine({ id: 'mill-2', kind: 'octoprint', host: '192.168.1.9', device: 'cnc' }).device === 'printer', 'a device the driver does not serve falls back to its own');
  ok(M.jobName('C:\\jobs\\Part 1 (v2).gcode') === 'Part_1_v2_.gcode' && M.jobName('../../etc/passwd') === null && M.jobName('run.exe') === null && M.jobName('.hidden.nc') === 'hidden.nc' && M.jobName('') === null, 'job names: path stripped, cleaned, G-code extensions only');
}

// ---- fake machines
const seen = [];
function readBody(req) { return new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); }); }
function parseMultipart(buf, ctype) {
  const b = '--' + /boundary=(.+)$/.exec(ctype)[1], text = buf.toString('latin1'), out = { fields: {}, file: null };
  for (const part of text.split(b).slice(1)) {
    if (part.startsWith('--')) break;
    const [head, ...rest] = part.replace(/^\r\n/, '').split('\r\n\r\n'); const body = rest.join('\r\n\r\n').replace(/\r\n$/, '');
    const name = /name="([^"]+)"/.exec(head)[1], fn = /filename="([^"]+)"/.exec(head);
    if (fn) out.file = { name: fn[1], text: body }; else out.fields[name] = body;
  }
  return out;
}
function machine(kind, { key = 'k-123' } = {}) {
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const rec = { method: req.method, url: req.url, headers: req.headers, body };
    seen.push(rec);
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj || {})); };
    const needKey = kind !== 'duet';
    if (needKey && req.headers['x-api-key'] !== key) return send(401, { error: 'bad key' });
    if (kind === 'octoprint') {
      if (req.method === 'GET' && req.url === '/api/version') return send(200, { api: '0.1', server: '1.10.2', text: 'OctoPrint 1.10.2' });
      if (req.method === 'POST' && req.url === '/api/files/local') { rec.mp = parseMultipart(body, req.headers['content-type']); return send(201, { done: true }); }
    }
    if (kind === 'moonraker') {
      if (req.method === 'GET' && req.url === '/server/info') return send(200, { result: { moonraker_version: 'v0.9.3' } });
      if (req.method === 'POST' && req.url === '/server/files/upload') { rec.mp = parseMultipart(body, req.headers['content-type']); return send(201, { result: {} }); }
    }
    if (kind === 'prusalink') {
      if (req.method === 'GET' && req.url === '/api/version') return send(200, { server: '2.1.2' });
      if (req.method === 'PUT' && req.url.startsWith('/api/v1/files/usb/')) return send(201, {});
    }
    if (kind === 'duet') {
      if (req.method === 'GET' && req.url === '/machine/status') return send(200, { state: { status: 'idle' }, boards: [{ firmwareVersion: '3.5.1' }] });
      if (req.method === 'PUT' && req.url.startsWith('/machine/file/gcodes/')) return send(201, {});
    }
    send(404, { error: 'no such call' });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, key })));
}
// the transport the desktop shell implements in Rust: address rule, key from a store, no redirects
const KEYS = new Map();
const transport = {
  async request(step) {
    const u = new URL(step.url);
    if (!M.isLanHost(u.hostname, { loopback: true })) throw new Error('not a local-network address');
    const headers = {};
    for (const [k, v] of Object.entries(step.headers || {})) headers[k] = v === '{{key}}' ? (KEYS.get(step.machine) || '') : v;
    const r = await fetch(step.url, { method: step.method, headers, body: step.body, redirect: 'manual' });
    return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() };
  },
};
const FILE = new TextEncoder().encode('G28\nG1 X10 Y10 F3000\nM84\n');
const mk = (kind, port, extra = {}) => ({ id: kind + '-1', name: kind, kind, host: '127.0.0.1', port, ...extra });

section('Each family: test, upload, upload and start');
const servers = [];
for (const kind of ['octoprint', 'moonraker', 'prusalink', 'duet']) {
  const f = await machine(kind); servers.push(f.srv);
  // cleanMachine refuses loopback: tests build the machine record with a private address and run the plan against loopback by hand
  const rec = { id: kind + '-1', name: kind, kind, host: '192.168.1.50', port: f.port };
  const asLoop = (step) => ({ ...step, url: step.url.replace('192.168.1.50', '127.0.0.1') });
  const tr = { request: (step) => transport.request(asLoop(step)) };
  KEYS.set(kind + '-1', f.key);
  const ping = M.parsePing(rec, await tr.request(M.pingPlan(rec)));
  ok(ping.ok && ping.version.length > 0, `${kind}: the connection test answers (${ping.version})`);
  seen.length = 0;
  const r1 = await M.send(rec, { name: 'Part 1.gcode', bytes: FILE }, tr);
  const put = seen.find((x) => x.method !== 'GET');
  ok(r1.ok && r1.uploaded && !r1.started && r1.status >= 200 && r1.status < 300, `${kind}: uploaded, not started`);
  const text = put.mp ? put.mp.file.text : put.body.toString();
  ok(text === new TextDecoder().decode(FILE) && /Part_1\.gcode/.test(put.mp ? put.mp.file.name : put.url), `${kind}: the file arrived byte for byte under a clean name`);
  if (kind === 'octoprint') ok(put.mp.fields.print === 'false' && put.mp.fields.select === 'false', 'octoprint: select=false print=false');
  if (kind === 'moonraker') ok(put.mp.fields.print === 'false' && put.mp.fields.root === 'gcodes', 'moonraker: root=gcodes print=false');
  if (kind === 'prusalink') ok(put.headers['print-after-upload'] === '?0', 'prusalink: Print-After-Upload ?0');
  if (kind !== 'duet') ok(put.headers['x-api-key'] === f.key, `${kind}: the key was filled in by the transport, not by the page`);
  ok(!JSON.stringify(M.plan(rec, { name: 'a.gcode', bytes: FILE }).steps).includes(f.key), `${kind}: the plan never holds the key`);
  seen.length = 0;
  let needConfirm = ''; try { M.plan(rec, { name: 'a.gcode', bytes: FILE, start: true }); } catch (e) { needConfirm = e.code; }
  ok(needConfirm === 'confirm', `${kind}: starting without the person's confirmation is refused before anything is sent`);
  if (kind !== 'duet') {
    const r2 = await M.send(rec, { name: 'a.gcode', bytes: FILE, start: true, confirmed: true }, tr);
    const p2 = seen.find((x) => x.method !== 'GET');
    ok(r2.ok && r2.started, `${kind}: confirmed → upload and start`);
    if (kind === 'octoprint' || kind === 'moonraker') ok(p2.mp.fields.print === 'true', `${kind}: print=true`);
    if (kind === 'prusalink') ok(p2.headers['print-after-upload'] === '?1', 'prusalink: ?1');
  }
}

section('What is refused or goes wrong');
{
  const rec = { id: 'cnc-1', name: 'Mill', kind: 'duet', device: 'cnc', host: '192.168.1.60', port: 1 };
  const p = M.plan(rec, { name: 'a.nc', bytes: FILE, start: true, confirmed: true });
  ok(p.start === false && p.notes.includes('device'), 'a CNC is never started from here, even confirmed (the note says so)');
  const laser = M.plan({ ...rec, id: 'laser-1', device: 'laser' }, { name: 'a.nc', bytes: FILE, start: true, confirmed: true });
  ok(laser.start === false, 'nor a laser');
  const bad = (job, m = rec) => { try { M.plan(m, job); return ''; } catch (e) { return e.code; } };
  ok(bad({ name: 'a.exe', bytes: FILE }) === 'name' && bad({ name: 'a.gcode', bytes: new Uint8Array(0) }) === 'empty' && bad({ name: 'a.gcode', bytes: 'text' }) === 'empty' && bad({ name: 'a.gcode', bytes: FILE }, { ...rec, host: '8.8.8.8' }) === 'machine', 'bad name, empty file, text instead of bytes, a public address');
  ok(bad({ name: 'a.gcode', bytes: { length: M.MAX_BYTES + 1, __proto__: Uint8Array.prototype } }) !== '', 'a file over the limit is refused');
  const f = await machine('octoprint', { key: 'right' }); servers.push(f.srv);
  const rec2 = { id: 'op-2', name: 'x', kind: 'octoprint', host: '192.168.1.50', port: f.port };
  KEYS.set('op-2', 'wrong');
  const tr = { request: (s) => transport.request({ ...s, url: s.url.replace('192.168.1.50', '127.0.0.1') }) };
  const r = await M.send(rec2, { name: 'a.gcode', bytes: FILE }, tr);
  ok(!r.ok && r.code === 'key' && r.status === 401, 'a wrong key → code key (the dialog says to check the key)');
  const r3 = await M.send(rec2, { name: 'a.gcode', bytes: FILE }, { request: async () => { throw new Error('connect ECONNREFUSED'); } });
  ok(!r3.ok && r3.code === 'network' && /ECONNREFUSED/.test(r3.message), 'a machine that is off → code network');
  let pub = ''; try { await transport.request({ url: 'http://example.com/api/version', method: 'GET', headers: {} }); } catch (e) { pub = e.message; }
  ok(/local-network/.test(pub), 'the transport refuses a public address even when asked');
  const redir = http.createServer((req, res) => { res.writeHead(302, { location: 'http://203.0.113.9/steal' }); res.end(); });
  await new Promise((r) => redir.listen(0, '127.0.0.1', r)); servers.push(redir);
  const rr = await transport.request({ url: `http://127.0.0.1:${redir.address().port}/x`, method: 'GET', headers: {} });
  ok(rr.status === 302, 'a redirect is not followed (it comes back as the answer)');
}
for (const s of servers) s.close();

section('Steel NC files (.nc1) on a CNC, never a printer (EG.40, part-model_PART_4)');
{
  ok(M.jobName('beam 1.NC1') === 'beam_1.NC1', 'an .nc1 name is accepted');
  const cnc = { id: 'mill-1', name: 'Mill', kind: 'duet', device: 'cnc', host: '192.168.1.9' }, pr = { id: 'ender-3', name: 'Ender', kind: 'duet', device: 'printer', host: '192.168.1.8' };
  const job = { name: 'b1.nc1', bytes: new Uint8Array([1, 2, 3]) };
  ok(M.plan(cnc, job).steps.length === 1, 'a CNC takes it');
  let e = null; try { M.plan(pr, job); } catch (x) { e = x; }
  ok(e && e.code === 'device', 'a printer is refused: ' + (e && e.message));
}

// 0.11 EG.40, read against machines.rs: the shell speaks plain http only, and its error codes reach the page
{
  const tlsM = { id: 'secure-1', kind: 'octoprint', host: '192.168.1.41', tls: true };
  let code = null; try { M.pingPlan(M.cleanMachine(tlsM)); } catch (e) { code = e.code; }
  ok(code === 'tls', 'an https machine is refused before a test call (machines.rs refuses https; no key in the clear)');
  code = null; try { M.plan(tlsM, { name: 'a.gcode', bytes: new Uint8Array([1]) }); } catch (e) { code = e.code; }
  ok(code === 'tls', 'and before a job');
  const plain = { id: 'ender-9', kind: 'moonraker', host: '192.168.1.42' };
  const shell = (c) => ({ request: async () => { throw Object.assign(new Error(c + ': x'), { code: c }); } });
  ok((await M.send(plain, { name: 'a.gcode', bytes: new Uint8Array([1]) }, shell('not_allowed'))).code === 'not_allowed', 'the shell\'s not_allowed reaches the page as itself');
  ok((await M.send(plain, { name: 'a.gcode', bytes: new Uint8Array([1]) }, shell('error'))).code === 'network', 'anything else is the network');
  const p = M.plan(plain, { name: 'a.gcode', bytes: new Uint8Array([1]) }).steps[0];
  const PREFIXES = ['/api/version', '/api/files/local', '/api/v1/files/usb/', '/server/info', '/server/files/upload', '/machine/status', '/machine/file/gcodes/'];
  const HEADERS = ['content-type', 'x-api-key', 'print-after-upload', 'overwrite', 'accept'];
  const steps = Object.keys(M.KINDS).flatMap((kind) => { const m = { id: 'm-' + kind, kind, host: '192.168.1.50' }; return [M.pingPlan(M.cleanMachine(m)), ...M.plan(m, { name: 'a.gcode', bytes: new Uint8Array([1]) }).steps]; });
  const rsPath = process.env.CADCRAFT_SHELL ? path.join(process.env.CADCRAFT_SHELL, 'src-tauri/src/machines.rs') : null;
  if (rsPath && fs.existsSync(rsPath)) {
    const rs = fs.readFileSync(rsPath, 'utf8');
    ok(PREFIXES.every((x) => rs.includes('"' + x + '"')) && HEADERS.every((x) => rs.includes('"' + x + '"')), 'the path and header lists here are machines.rs\'s own');
  } else console.log('  (CADCRAFT_SHELL not set: the check against machines.rs is skipped)');
  ok(steps.every((s) => /^http:\/\//.test(s.url) && PREFIXES.some((x) => new URL(s.url).pathname === x || new URL(s.url).pathname.startsWith(x)) && Object.keys(s.headers).every((h) => HEADERS.includes(h.toLowerCase())) && ['GET', 'POST', 'PUT'].includes(s.method)), 'every driver step is one machines.rs lets through (plain http, its paths, its headers, GET/POST/PUT)');
  ok(p.url.startsWith('http://192.168.1.42:7125/server/files/upload'), 'Moonraker upload as machines.rs expects');
}
done();
