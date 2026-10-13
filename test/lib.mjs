// SPDX-License-Identifier: Apache-2.0
// lib.mjs — what Studio's tests share: a plain static server (the suite at a deep sub-folder, nothing else; requests
// outside it are recorded and refused) and the cached Playwright Chromium.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

export const STUDIO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// The site's checkout and the desktop shell's: not part of this repo, found only through these (unset = '').
export const SITE = process.env.CADCRAFT_SITE || '';
export const SHELL = process.env.CADCRAFT_SHELL || '';
/** Stop with a clear message when a test needs a folder the environment does not name. */
export function need(value, name, what) {
  if (value) return value;
  console.error(`${name} is not set: point it at ${what}`);
  process.exit(1);
}
export const SUITE = (build = 'dev') => path.join(STUDIO, 'out/studio-suite', 'v' + build);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.icc': 'application/octet-stream', '.txt': 'text/plain', '.md': 'text/plain' };

/** Serve `dir` at `prefix` (e.g. /deep/tools/studio/). → {url, close(), seen[], outside[], setDown(bool)} */
export function serve(dir, prefix = '/deep/tools/studio/') {
  const seen = [], outside = [];
  let down = false;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(u.pathname);
    if (down) { req.socket.destroy(); return; }
    if (!u.pathname.startsWith(prefix)) { outside.push(u.pathname); res.writeHead(404); res.end(); return; }
    let rel = decodeURIComponent(u.pathname.slice(prefix.length));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(dir, rel);
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${srv.address().port}${prefix}`, seen, outside,
    setDown(v) { down = !!v; }, close: () => new Promise((r) => srv.close(r)),
  })));
}

export async function chromium() {
  const { chromium: c } = await import('playwright-core');
  const cacheDir = path.join(os.homedir(), '.cache/ms-playwright');
  const cbuild = fs.readdirSync(cacheDir).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => parseInt(b.split('-')[1]) - parseInt(a.split('-')[1]))[0];
  const exe = ['chrome-linux64/chrome', 'chrome-linux/chrome'].map((s) => path.join(cacheDir, cbuild, s)).find((p) => fs.existsSync(p));
  return c.launch({ executablePath: exe, args: ['--no-sandbox'] });
}

let pass = 0, fail = 0;
const VERBOSE = process.argv.includes('--verbose');
export const ok = (c, m) => { if (c) { pass++; if (VERBOSE) console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m); } return !!c; };
export const section = (s) => console.log('\n' + s);
export const done = () => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };
