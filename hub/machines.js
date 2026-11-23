/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — protocol; the dialog (window-machines.js, desktop only) words it. */
/**
 * machines.js — send a job to a printer, CNC, laser or layout robot on the local network (0.8 EG.40, studio_PART_2). DOM-free;
 * test/test-machines.mjs runs the drivers against fake machines. Desktop Studio only: a web page cannot reach a device on the
 * person's network (mixed content, CORS, no raw sockets), so the requests below are executed by the desktop shell
 * (desktop-shell/src-tauri/src/machines.rs: `cc_machine_request`), which refuses anything that is not a private-network address.
 *
 * A DRIVER knows one family's upload call, and nothing else:
 *   octoprint  POST /api/files/local (multipart: file, select, print)            test: GET /api/version
 *   moonraker  POST /server/files/upload (multipart: file, root=gcodes, print)   test: GET /server/info        (Klipper)
 *   prusalink  PUT  /api/v1/files/usb/<name> (raw; Print-After-Upload, Overwrite) test: GET /api/version
 *   duet       PUT  /machine/file/gcodes/<name> (raw)                            test: GET /machine/status     (Duet Web Server)
 * The key (OctoPrint / Moonraker / PrusaLink "API key") is never in a machine record and never in a request built here: a request carries
 * the header `X-Api-Key: {{key}}` and the shell fills it in from the OS credential store under the machine's id. The page sets a key once
 * (`cc_machine_key_set`) and can never read it back.
 *
 * Safety (the owner's cut line for 0.8):
 *   - A job is UPLOADED by default. Starting it needs `confirmed: true` (the dialog asks "I am at the machine and it is clear") and only on
 *     `printer` machines. A CNC, a laser or a robot is never started from here: files land on its card / queue and the person starts them there.
 *   - The file must be G-code-like by name (extension list below) and at most MAX_BYTES; the name is cleaned to [A-Za-z0-9._-].
 *   - Only private-network addresses (isLanHost); the shell checks again after name resolution, and refuses redirects.
 *
 *   cleanMachine(raw) → machine | null          { id, name, kind, device, host, port, tls }
 *   isLanHost(host, { loopback }) → boolean     RFC 1918, link-local, ULA / fe80, `.local` / `.lan` / `.home.arpa` / one-label names
 *   jobName(name) → string | null
 *   plan(machine, job) → { steps[], start, notes[] }   job = { name, bytes: Uint8Array, start?: boolean, confirmed?: boolean }
 *   pingPlan(machine) → step ; parsePing(machine, response) → { ok, version }
 *   send(machine, job, transport) → { ok, uploaded, started, status, message }   transport.request(step) → { status, headers, body }
 */

export const KINDS = Object.freeze({
  octoprint: { label: 'OctoPrint', device: ['printer'], port: 80 },
  moonraker: { label: 'Klipper (Moonraker)', device: ['printer'], port: 7125 },
  prusalink: { label: 'PrusaLink', device: ['printer'], port: 80 },
  duet: { label: 'Duet', device: ['printer', 'cnc', 'laser'], port: 80 },
});
export const DEVICES = ['printer', 'cnc', 'laser', 'robot'];
export const MAX_BYTES = 256 * 1024 * 1024;
export const EXTENSIONS = ['gcode', 'gco', 'g', 'nc', 'ngc', 'tap', 'cnc', 'bgcode', 'nc1'];
/** `.nc1` is a steel-fabrication NC file (DetailCraft's DSTV out), not G-code: it is stored on a CNC's file store, never on a printer. */
export const NOT_FOR_PRINTERS = ['nc1'];
export const extOf = (name) => ((/\.([A-Za-z0-9]+)$/.exec(String(name || '')) || [])[1] || '').toLowerCase();

const ID = /^[a-z0-9][a-z0-9-]{2,40}$/;
const enc = new TextEncoder();

/** A machine as stored and shown (no key). Null when it is not one. */
export function cleanMachine(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = typeof raw.kind === 'string' && KINDS[raw.kind] ? raw.kind : null;
  const id = typeof raw.id === 'string' && ID.test(raw.id) ? raw.id : null;
  const host = typeof raw.host === 'string' ? raw.host.trim().toLowerCase() : '';
  if (!kind || !id || !host || !isLanHost(host)) return null;
  const device = DEVICES.includes(raw.device) && KINDS[kind].device.includes(raw.device) ? raw.device : KINDS[kind].device[0];
  const port = Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : KINDS[kind].port;
  const name = String(raw.name || host).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60) || host;
  return { id, name, kind, device, host, port, tls: raw.tls === true };
}

const v4 = (h) => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h); if (!m) return null; const o = m.slice(1).map(Number); return o.every((x) => x <= 255) ? o : null; };

/** Is this a private-network address or a name that can only mean one (the shell resolves and checks again)? */
export function isLanHost(host, { loopback = false } = {}) {
  if (typeof host !== 'string' || !host || host.length > 253) return false;
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const o = v4(h);
  if (o) {
    if (o[0] === 127) return loopback;
    return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) || (o[0] === 169 && o[1] === 254);
  }
  if (h.includes(':')) {   // IPv6 literal
    if (h === '::1') return loopback;
    if (!/^[0-9a-f:]+$/.test(h)) return false;
    return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
  }
  if (/^[0-9.]+$/.test(h)) return false;   // a malformed IPv4 is not a name
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h)) return false;
  if (h === 'localhost') return loopback;
  return !h.includes('.') || /\.(local|lan|home\.arpa)$/.test(h);
}

/** A file name that is safe in a URL and on the machine's card, with a G-code-like extension; else null. */
export function jobName(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80);
  const ext = (/\.([A-Za-z0-9]+)$/.exec(base) || [])[1];
  return base && ext && EXTENSIONS.includes(ext.toLowerCase()) ? base : null;
}

export function baseUrl(m) { return (m.tls ? 'https://' : 'http://') + (m.host.includes(':') ? '[' + m.host + ']' : m.host) + ':' + m.port; }

/** multipart/form-data as bytes: text fields, then one file. */
export function multipart(fields, file) {
  const boundary = '----cc' + Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
  const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.bytes, enc.encode(`\r\n--${boundary}--\r\n`));
  const len = parts.reduce((n, p) => n + p.length, 0), body = new Uint8Array(len);
  let at = 0; for (const p of parts) { body.set(p, at); at += p.length; }
  return { body, contentType: 'multipart/form-data; boundary=' + boundary };
}

const KEY = { 'X-Api-Key': '{{key}}' };

const DRIVERS = {
  octoprint: {
    ping: (m) => ({ method: 'GET', path: '/api/version', headers: { ...KEY } }),
    version: (b) => str(b, 'text') || str(b, 'server'),
    upload: (m, name, bytes, start) => {
      const f = multipart({ select: start ? 'true' : 'false', print: start ? 'true' : 'false' }, { field: 'file', name, bytes });
      return { method: 'POST', path: '/api/files/local', headers: { ...KEY, 'Content-Type': f.contentType }, body: f.body, expect: [200, 201] };
    },
  },
  moonraker: {
    ping: () => ({ method: 'GET', path: '/server/info', headers: { ...KEY } }),
    version: (b) => str(b && b.result, 'moonraker_version'),
    upload: (m, name, bytes, start) => {
      const f = multipart({ root: 'gcodes', print: start ? 'true' : 'false' }, { field: 'file', name, bytes });
      return { method: 'POST', path: '/server/files/upload', headers: { ...KEY, 'Content-Type': f.contentType }, body: f.body, expect: [200, 201] };
    },
  },
  prusalink: {
    ping: () => ({ method: 'GET', path: '/api/version', headers: { ...KEY } }),
    version: (b) => str(b, 'server') || str(b, 'api'),
    upload: (m, name, bytes, start) => ({ method: 'PUT', path: '/api/v1/files/usb/' + encodeURIComponent(name), headers: { ...KEY, 'Content-Type': 'application/octet-stream', 'Print-After-Upload': start ? '?1' : '?0', Overwrite: '?1' }, body: bytes, expect: [200, 201, 204] }),
  },
  duet: {
    ping: () => ({ method: 'GET', path: '/machine/status', headers: {} }),
    version: (b) => str(b && b.boards && b.boards[0], 'firmwareVersion') || (b && b.state ? 'ok' : ''),
    upload: (m, name, bytes) => ({ method: 'PUT', path: '/machine/file/gcodes/' + encodeURIComponent(name), headers: { 'Content-Type': 'application/octet-stream' }, body: bytes, expect: [200, 201, 204] }),
  },
};
function str(o, k) { return o && typeof o === 'object' && typeof o[k] === 'string' ? o[k].slice(0, 60) : ''; }

const full = (m, s) => ({ machine: m.id, method: s.method, url: baseUrl(m) + s.path, headers: s.headers, body: s.body || null, expect: s.expect || [200], timeoutMs: s.timeoutMs || 15000 });

/** The shell (machines.rs) speaks plain http to a local machine only (a LAN machine's certificate is rarely one it could verify), so a
 *  machine marked https is refused here, before a key could go out in the clear (0.11 EG.40). */
const plainOnly = (m) => { if (m.tls) throw coded('tls', 'Studio reaches machines on your network over plain http only. Turn off https for this machine.'); };
export function pingPlan(m) { plainOnly(m); return full(m, DRIVERS[m.kind].ping(m)); }
export function parsePing(m, res) {
  if (!res || res.status < 200 || res.status >= 300) return { ok: false, version: '', status: res ? res.status : 0 };
  let b = null; try { b = JSON.parse(typeof res.body === 'string' ? res.body : new TextDecoder().decode(res.body)); } catch { b = null; }
  return { ok: true, version: DRIVERS[m.kind].version(b), status: res.status };
}

/** What would be sent: the steps (no key in them), and whether it starts. Throws an Error with .code for what is refused. */
export function plan(machineRaw, job) {
  const m = cleanMachine(machineRaw);
  if (!m) throw coded('machine', 'That is not a machine on the local network.');
  plainOnly(m);
  const name = jobName(job && job.name);
  if (!name) throw coded('name', 'The file needs a G-code or NC name (' + EXTENSIONS.map((x) => '.' + x).join(', ') + ').');
  const bytes = job && job.bytes;
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw coded('empty', 'The file is empty.');
  if (bytes.length > MAX_BYTES) throw coded('size', 'The file is over ' + (MAX_BYTES / 1048576) + ' MB.');
  if (m.device === 'printer' && NOT_FOR_PRINTERS.includes(extOf(name))) throw coded('device', 'A .' + extOf(name) + ' file is a steel NC file: it goes to a CNC, not a printer.');
  const notes = [];
  let start = !!(job && job.start);
  if (start && m.device !== 'printer') { start = false; notes.push('device'); }          // a CNC, laser or robot is never started from here
  if (start && !(job && job.confirmed === true)) throw coded('confirm', 'Starting a job needs the person at the machine to confirm.');
  return { machine: m, name, start, notes, steps: [full(m, DRIVERS[m.kind].upload(m, name, bytes, start))] };
}

function coded(code, message) { return Object.assign(new Error(message), { code }); }

/** Run the plan through a transport (the shell's, or a test's). */
export async function send(machineRaw, job, transport) {
  const p = plan(machineRaw, job);
  const out = { ok: false, uploaded: false, started: false, status: 0, message: '', notes: p.notes, name: p.name };
  for (const step of p.steps) {
    let res;
    // The shell says why in its error code ("not_allowed: …", "size: …", "network: …"; bridge.js puts it on e.code): keep the reasons the page
    // words, everything else is the network.
    try { res = await transport.request(step); } catch (e) { out.message = String((e && e.message) || e).slice(0, 200); out.code = ['not_allowed', 'size', 'key'].includes(e && e.code) ? e.code : 'network'; return out; }
    out.status = res.status;
    if (!step.expect.includes(res.status)) { out.message = 'The machine answered ' + res.status + '.'; out.code = res.status === 401 || res.status === 403 ? 'key' : 'refused'; return out; }
  }
  out.ok = true; out.uploaded = true; out.started = p.start;
  return out;
}
