#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * suite.mjs — the suite packer (docs/0.4-PART2.md H.2, H.8): CadCraft Studio = the hub + the eight apps in one folder,
 * served from one origin, built from the eight browser editions the site's own packer makes (devshell/pack.php
 * --edition browser, session `edition` D.1). Run as root on the site (it runs PHP as www-data). CADCRAFT_SITE names the
 * site's folder (required; the site is not part of this repo).
 *
 *   CADCRAFT_SITE=<site> node pack/suite.mjs [--build dev|x.y] [--apps a,b,…] [--editions <dir>] [--out <dir>] [--zip] [--allow-gate]
 *
 *   --build      the app builds to pack (default dev). Every app at the same build.
 *   --apps       a subset (default: the whole lineup, Catalog order)
 *   --editions   reuse editions packed already: <dir>/<slug>/browser-edition/v<build>/ (default: pack each one now)
 *   --out        where the suite goes (default out/ in this repo): <out>/studio-suite/v<build>/
 *   --zip        also <out>/cadcraft-studio-browser-v<build>.zip (reproducible: sorted, fixed dates) + <out>/SHA256SUMS
 *   --allow-gate keep an app whose edition fails the license/secrets gate (spikes only; the result must never ship)
 *
 * Layout of <out>/studio-suite/v<build>/ (H.2):
 *   index.html, hub/            the hub (hub/index.html filled in; hub/*.js, hub.css; host.js from the site)
 *   apps/<slug>/index.html      each app's page, rendered again so the apps beside it count (H.6 handoffs), its paths
 *                               moved to the shared folders, the Studio button + channel (hub/window.js) added
 *   apps/<slug>/assets/apps/…   each app's own build;  apps/<slug>/{LICENSE,NOTICE,THIRD_PARTY.md,…,release.json}
 *   apps/<slug>/assets/vendor/  only libraries that app's own code finds by path (PartCraft's script engines)
 *   assets/css, assets/js       the shared shell, stored once (byte-identical in every edition, else kept per app)
 *   assets/vendor/<lib>/<ver>/  every library stored once by version (with LICENSE + SOURCE.txt)
 *   sw.js                       one "Save for offline" worker for the whole folder (a cache per app)
 *   release.json, LICENSE, NOTICE, THIRD_PARTY.md, TRADEMARKS.md, README.md, INSTALL.md, .htaccess, web.config, favicon.*
 * An app whose edition fails to pack (or fails the gate) is left out and listed in release.json "left_out" — never
 * shipped half-built. The finished folder goes through the same license/secrets gate (bin/test-licenses.mjs --tree).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUDIO = path.dirname(HERE);
const SITE = process.env.CADCRAFT_SITE;
if (!SITE) { console.error('suite: CADCRAFT_SITE is not set: point it at the site\'s folder (its packer, Catalog and license gate)'); process.exit(1); }
const PUB = path.join(SITE, 'public_html');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv.splice(i, 1), true) : false; };
const BUILD = opt('--build', 'dev');
const ONLY = opt('--apps', null);
const EDITIONS = opt('--editions', null);
const OUT = path.resolve(opt('--out', path.join(STUDIO, 'out')));
const ZIP = flag('--zip');
const ALLOW_GATE = flag('--allow-gate');
if (!/^(dev|\d{1,3}\.\d{1,3}(\.\d{1,3})?)$/.test(BUILD)) die('--build takes dev or x.y');

function die(m) { console.error('suite: ' + m); process.exit(1); }
// sudo drops the environment: CADCRAFT_SITE goes along explicitly (catalog.php and render-suite.php need it).
const asWww = process.getuid && process.getuid() === 0 ? (cmd, args, o = {}) => spawnSync('sudo', ['-u', 'www-data', 'env', `CADCRAFT_SITE=${SITE}`, cmd, ...args], { encoding: 'utf8', ...o })
  : (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...o });
const read = (f) => fs.readFileSync(f, 'utf8');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const exists = (f) => fs.existsSync(f);
const walk = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
});
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
const copyDir = (from, to) => { for (const r of walk(from)) copy(path.join(from, r), path.join(to, r)); };
const jsonEmbed = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/'/g, '\\u0027');

// ------------------------------------------------------------------ the lineup and the editions

const cat = asWww('php', [path.join(HERE, 'catalog.php')]);
if (cat.status !== 0) die('catalog.php failed: ' + cat.stderr);
const CATALOG = JSON.parse(cat.stdout);
const SLUGS = ONLY ? ONLY.split(',').map((s) => s.trim()).filter(Boolean) : CATALOG.apps.map((a) => a.slug);
for (const s of SLUGS) if (!CATALOG.apps.some((a) => a.slug === s)) die('unknown app ' + s);

const WORK = path.join(STUDIO, 'work');
fs.mkdirSync(WORK, { recursive: true });
try { spawnSync('chown', ['www-data:www-data', WORK]); } catch { /* not root */ }

const leftOut = [];
const eds = {};
for (const slug of SLUGS) {
  let dir;
  if (EDITIONS) {
    dir = path.join(path.resolve(EDITIONS), slug, 'browser-edition', 'v' + BUILD);
    if (!exists(path.join(dir, 'index.html'))) { leftOut.push({ slug, reason: 'no edition at ' + dir }); continue; }
    // pack.php leaves a gate-failed edition on disk for inspection: check each one again here.
    const g = spawnSync('node', [path.join(SITE, 'bin/test-licenses.mjs'), '--tree', dir], { encoding: 'utf8' });
    if (g.status !== 0 && !ALLOW_GATE) { leftOut.push({ slug, reason: 'license/secrets gate: ' + (g.stdout.match(/✗ .*/) || [lastLine(g.stdout)])[0] }); console.log(`-- ${slug}: left out (gate)`); continue; }
  } else {
    const out = path.join(WORK, 'editions', slug);
    const r = asWww('php', [path.join(SITE, 'devshell/pack.php'), slug, out, '--edition', 'browser', '--build', BUILD, '--force']);
    dir = path.join(out, 'browser-edition', 'v' + BUILD);
    if (r.status === 2 && !ALLOW_GATE) { leftOut.push({ slug, reason: 'license/secrets gate: ' + lastLine(r.stdout + r.stderr) }); console.log(`-- ${slug}: left out (gate)`); continue; }
    if (r.status !== 0 && r.status !== 2) { leftOut.push({ slug, reason: 'pack failed: ' + lastLine(r.stderr || r.stdout) }); console.log(`-- ${slug}: left out (${lastLine(r.stderr || r.stdout)})`); continue; }
  }
  eds[slug] = dir;
  console.log(`== ${slug}: edition ${path.relative(STUDIO, dir) || dir}`);
}
function lastLine(s) { return String(s || '').trim().split('\n').filter(Boolean).pop() || ''; }
const INCLUDED = SLUGS.filter((s) => eds[s]);
if (!INCLUDED.length) die('no app could be packed: ' + JSON.stringify(leftOut));

const manifestOf = (slug) => JSON.parse(read(path.join(eds[slug], 'assets/apps', slug, BUILD, 'manifest.json')));
const releaseOf = (slug) => JSON.parse(read(path.join(eds[slug], 'release.json')));

// ------------------------------------------------------------------ the suite folder

const DEST = path.join(OUT, 'studio-suite', 'v' + BUILD);
fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

// Shared shell + libraries: a path is shared when every edition that has it has the same bytes.
const shared = new Map();       // rel path (assets/css/x, assets/js/x, assets/vendor/lib/ver/...) → sha
const conflict = new Set();
const isSharable = (r) => /^assets\/(css|js)\/[^/]+$/.test(r) || /^assets\/js\/compute\/[^/]+$/.test(r) || /^assets\/vendor\/[a-z0-9._-]+\/[^/]+\//.test(r) || /^favicon[^/]*$/.test(r);
for (const slug of INCLUDED) {
  for (const r of walk(eds[slug])) {
    if (!isSharable(r)) continue;
    const h = sha256(fs.readFileSync(path.join(eds[slug], r)));
    if (shared.has(r) && shared.get(r) !== h) conflict.add(r);
    else shared.set(r, h);
  }
}
const libOf = (r) => (r.match(/^assets\/vendor\/([a-z0-9._-]+\/[^/]+)\//) || [])[1] || null;
const badLibs = new Set([...conflict].map(libOf).filter(Boolean));     // a library differing anywhere stays per app

/** Libraries an app's own code finds by a path (not through the page's import map): those stay inside the app. */
function localLibs(slug) {
  const out = new Set();
  const dir = path.join(eds[slug], 'assets/apps', slug, BUILD);
  for (const r of walk(dir)) {
    if (!/\.js$/.test(r)) continue;
    for (const line of read(path.join(dir, r)).split('\n')) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      for (const m of line.matchAll(/vendor\/([a-z0-9._-]+)\/(current|\d[^/'"`]*)\//g)) out.add(m[1]);
    }
  }
  return out;
}

// The hub's languages (also the app windows' Studio words, suitePage below).
const langs = {};
for (const f of fs.readdirSync(path.join(STUDIO, 'hub/lang')).filter((f) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f))) {
  const j = JSON.parse(read(path.join(STUDIO, 'hub/lang', f)));
  langs[j['@locale']] = { name: j['@name'], strings: Object.fromEntries(Object.entries(j).filter(([k]) => !k.startsWith('@'))) };
}
// The lineup's descriptions (each app's role, tagline, short: catalog.<slug>.<field>) in every language the hub speaks,
// from the site's assets/lang/catalog/<locale>.json (Catalog reads the English there; session lang owns these files).
for (const [loc, l] of Object.entries(langs)) {
  const f = path.join(PUB, 'assets/lang/catalog', loc + '.json');
  if (!exists(f)) continue;
  for (const [k, v] of Object.entries(JSON.parse(read(f)))) if (k.startsWith('catalog.')) l.strings[k] = v;
}
const suiteApps = [];
const siblingsFor = (slug) => Object.fromEntries(INCLUDED.filter((s) => s !== slug).map((s) => [s, { accepts: manifestOf(s).accepts || [] }]));
const hubWords = JSON.parse(read(path.join(STUDIO, 'hub/lang/en.json')));
const fillWords = (s) => String(s).replace(/\{name\}/g, hubWords['studio.name']).replace(/\{short\}/g, hubWords['studio.short']);

for (const slug of INCLUDED) {
  const ed = eds[slug];
  const local = localLibs(slug);
  const keepLocal = (r) => { const l = libOf(r); return !!l && (local.has(l.split('/')[0]) || badLibs.has(l)); };
  const appDir = path.join(DEST, 'apps', slug);
  // Files: the build, its local libraries, its notices; shared files once at the root.
  for (const r of walk(ed)) {
    if (/^(index\.html|sw\.js|\.htaccess|web\.config|INSTALL\.md|README\.md|\.edition-notes\.json)$/.test(r)) continue;
    const from = path.join(ed, r);
    if (isSharable(r) && !conflict.has(r) && !keepLocal(r)) { if (!exists(path.join(DEST, r))) copy(from, path.join(DEST, r)); continue; }
    copy(from, path.join(appDir, r));
  }
  // The page: rendered again with its siblings (after checking a plain render still equals the edition's own page).
  const plain = path.join(WORK, `sib-${slug}-0.json`), sib = path.join(WORK, `sib-${slug}.json`);
  const o0 = path.join(WORK, `page-${slug}-0.html`), o1 = path.join(WORK, `page-${slug}.html`);
  fs.writeFileSync(plain, '{}');
  fs.writeFileSync(sib, JSON.stringify(siblingsFor(slug)));
  for (const f of [plain, sib]) try { fs.chownSync(f, 33, 33); } catch { /* not root */ }
  const r0 = asWww('php', [path.join(HERE, 'render-suite.php'), slug, BUILD, ed, plain, o0]);
  if (r0.status !== 0) die(`${slug}: render failed: ${r0.stderr}`);
  if (read(o0) !== read(path.join(ed, 'index.html'))) die(`${slug}: a plain re-render differs from the edition's index.html — the app's source changed since this edition was packed (run without --editions), or devshell/edition.php changed how it stages the page (update pack/render-suite.php)`);
  const r1 = asWww('php', [path.join(HERE, 'render-suite.php'), slug, BUILD, ed, sib, o1]);
  if (r1.status !== 0) die(`${slug}: suite render failed: ${r1.stderr}`);
  const page = suitePage(slug, read(o1), (r) => isSharable(r) && !conflict.has(r) && !keepLocal(r));
  fs.writeFileSync(path.join(appDir, 'index.html'), page.html);
  const rel = releaseOf(slug);
  const app = CATALOG.apps.find((a) => a.slug === slug);
  suiteApps.push({ ...app, release: String(rel.release), packed_at: rel.packed_at, notes: rel.notes || null,
    libs: rel.libs || {}, accepts_handoff: (manifestOf(slug).accepts || []).includes('handoff'), offline: page.offline, local_libs: [...local].sort() });
  console.log(`   ${slug}: page rewritten (${page.moved} shared paths, ${Object.keys(siblingsFor(slug)).length} siblings, local libs: ${[...local].join(', ') || 'none'})`);
}

/** An app page inside the suite: shared paths moved up two folders, handoff URLs to the sibling folders, the edition
 *  flags updated, the offline list relative to the suite's folder, and the Studio window script added. */
function suitePage(slug, html, isShared) {
  let moved = 0;
  const up = (u) => {                                   // "./assets/vendor/three/0.186.1/x.js" → "../../assets/…" when shared
    const m = /^\.\/(.*)$/.exec(u);
    if (!m) return u;
    const r = m[1].split(/[?#]/)[0];
    const asFile = r.endsWith('/') ? r + '__dir__' : r;
    if (isShared(asFile) || (r.endsWith('/') && [...shared.keys()].some((k) => k.startsWith(r) && isShared(k)))) { moved++; return '../../' + m[1]; }
    return u;
  };
  // Attributes and import-map / JSON strings that start with ./ (the edition writes every URL that way).
  let out = html.replace(/((?:src|href|data-[a-z0-9-]+)=")(\.\/[^"]*)"/g, (all, a, u) => a + up(u) + '"');
  out = out.replace(/<script type="importmap">([\s\S]*?)<\/script>/, (all, j) => {
    const map = JSON.parse(j);
    for (const k of Object.keys(map.imports || {})) map.imports[k] = up(map.imports[k]);
    return '<script type="importmap">' + JSON.stringify(map) + '</script>';
  });
  // Handoffs between apps: render.php writes "/<slug>" (the edition area has no path); the sibling is ../<slug>/.
  out = out.replace(/(data-[a-z0-9-]+-url)="\/([a-z0-9-]+)"/g, (all, a, s) => (INCLUDED.includes(s) ? `${a}="../${s}/index.html"` : all));
  // Edition flags: handoff on (the apps sit side by side), and say it is the suite.
  out = out.replace(/(<script type="application\/json" id="cc-edition">)([\s\S]*?)(<\/script>)/, (all, a, j, b) => {
    const d = JSON.parse(j);
    d.handoff = true;
    d.suite = 'studio';
    return a + jsonEmbed(d) + b;
  });
  // Offline: one worker for the suite; URLs relative to the suite's folder.
  let offline = [];
  out = out.replace(/(<script type="application\/json" id="cc-offline">)([\s\S]*?)(<\/script>)/, (all, a, j, b) => {
    const d = JSON.parse(j);
    const toRoot = (u) => { const r = String(u).replace(/^\.\//, ''); return (isShared(r) ? '' : `apps/${slug}/`) + r; };
    d.urls = [...new Set((d.urls || []).map(toRoot))];
    d.page = `apps/${slug}/`;
    d.sw = '../../sw.js';
    d.scope = '../../';
    d.key = 'studio/' + slug;
    offline = d.urls;
    return a + jsonEmbed(d) + b;
  });
  // Every window.* word in every hub language (window.js picks the page's), {{…}} fills done here.
  const words = Object.fromEntries(Object.entries(langs).map(([loc, l]) => [loc, Object.fromEntries(Object.entries(l.strings)
    .filter(([k]) => k.startsWith('window.')).map(([k, v]) => [k, k.startsWith('window.live.') ? v : typeof v === 'string' ? fillWords(v) : Object.fromEntries(Object.entries(v).map(([f, x]) => [f, fillWords(x)]))]))]));
  // (window.live.* keep their {fills}: {name} there is a person, filled in the window.)
  out = out.replace('</head>', `  <script type="application/json" id="studio-window-lang">${jsonEmbed(words)}</script>\n  <script type="module" src="../../hub/window.js"></script>\n</head>`);
  return { html: out, moved, offline };
}

// ------------------------------------------------------------------ the hub

const HUB_FILES = ['hub.js', 'hub.css', 'route.js', 'channel.js', 'handoff.js', 'cloud.js', 'news.js', 'updates.js', 'avatar.js', 'window.js'];
for (const f of HUB_FILES) copy(path.join(STUDIO, 'hub', f), path.join(DEST, 'hub', f));
// Studio Live's window and hub modules (0.5 LV.6 / LV.7 / LV.23).
for (const f of fs.readdirSync(path.join(STUDIO, 'hub/live')).filter((f) => /\.(js|css)$/.test(f))) copy(path.join(STUDIO, 'hub/live', f), path.join(DEST, 'hub/live', f));
copy(path.join(PUB, 'assets/js/host.js'), path.join(DEST, 'hub/host.js'));
if (!exists(path.join(DEST, 'assets/js/i18n.js'))) copy(path.join(PUB, 'assets/js/i18n.js'), path.join(DEST, 'assets/js/i18n.js'));
const icons = (shared.size && [...shared.keys()].map((k) => (k.match(/^assets\/vendor\/bootstrap-icons\/([^/]+)\//) || [])[1]).find(Boolean)) || null;
if (!icons) die('no Bootstrap Icons in the editions');
const hubFiles = ['index.html', 'favicon.svg', 'assets/css/tokens.css', 'assets/js/i18n.js', ...HUB_FILES.map((f) => 'hub/' + f), 'hub/host.js',
  ...fs.readdirSync(path.join(DEST, 'hub/live')).map((f) => 'hub/live/' + f),
  ...walk(path.join(DEST, 'assets/vendor/bootstrap-icons', icons)).filter((r) => /\.(css|woff2?)$/.test(r)).map((r) => `assets/vendor/bootstrap-icons/${icons}/${r}`),
  ...walk(path.join(DEST, 'assets/vendor')).filter((r) => r.startsWith('archivo/') && r.endsWith('.woff2')).map((r) => 'assets/vendor/' + r)];
const suiteJson = {
  format: 'cadcraft-suite', version: 1, name: hubWords['studio.name'], build: BUILD,
  apps: suiteApps.map(({ libs, local_libs, ...a }) => a),
  upcoming: CATALOG.upcoming,
  left_out: leftOut,
  langs: Object.entries(langs).map(([code, l]) => ({ code, name: l.name })),
  offline: { key: 'studio/hub', page: './', urls: hubFiles.filter((r) => r !== 'index.html') },
};
let hub = read(path.join(STUDIO, 'hub/index.html'));
const fill = {
  LOCALE: 'en', TITLE: hubWords['studio.name'], ICONS: icons, VERSION: BUILD === 'dev' ? hubWords['tile.dev'] : BUILD,
  VERSION_KEY: BUILD === 'dev' ? 'tile.dev' : '', EDITION_KEY: 'edition.browser', NOSCRIPT: hubWords.noscript,
  LANG: jsonEmbed({ locale: 'en', chain: ['en'], strings: langs.en.strings }),
  LANGS: jsonEmbed(Object.fromEntries(Object.entries(langs).map(([k, l]) => [k, l.strings]))),
  SUITE: jsonEmbed(suiteJson),
};
hub = hub.replace(/\{\{([A-Z_]+)\}\}/g, (all, k) => (k in fill ? (/^(LANG|LANGS|SUITE)$/.test(k) ? fill[k] : escapeHtml(fill[k])) : die('hub template: unknown {{' + k + '}}')));
fs.writeFileSync(path.join(DEST, 'index.html'), hub);
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
copy(path.join(HERE, 'sw.js'), path.join(DEST, 'sw.js'));

// ------------------------------------------------------------------ notices, docs, release.json

const first = eds[INCLUDED[0]];
for (const f of ['LICENSE', 'TRADEMARKS.md', '.htaccess', 'web.config']) if (exists(path.join(first, f))) copy(path.join(first, f), path.join(DEST, f));
const sharedLibs = [...new Set([...shared.keys()].map(libOf).filter(Boolean))].filter((l) => exists(path.join(DEST, 'assets/vendor', l))).sort();
fs.writeFileSync(path.join(DEST, 'NOTICE'), `CadCraft Studio and the CadCraft apps\nCopyright the CadCraft authors. Licensed under the Apache License, Version 2.0 (LICENSE).\n\n` +
  `CadCraft and the app names are trademarks of the CadCraft project; see TRADEMARKS.md.\nEach app's own notice: apps/<app>/NOTICE.\n`);
fs.writeFileSync(path.join(DEST, 'THIRD_PARTY.md'), ['# Third-party software in CadCraft Studio', '',
  'Studio itself (index.html, hub/, sw.js) is Apache-2.0 and uses no library of its own beyond the ones below.', '',
  '## Shared by the apps (stored once)', '',
  ...sharedLibs.map((l) => `- \`${l}\` — license: \`assets/vendor/${l}/LICENSE\`, source: \`assets/vendor/${l}/SOURCE.txt\``), '',
  '## Each app', '', ...INCLUDED.map((s) => `- ${CATALOG.apps.find((a) => a.slug === s).name}: \`apps/${s}/THIRD_PARTY.md\``), ''].join('\n'));
const tmpl = read(path.join(HERE, 'INSTALL.md'));
fs.writeFileSync(path.join(DEST, 'INSTALL.md'), tmpl.replace(/\{\{NAME\}\}/g, hubWords['studio.name']).replace(/\{\{BUILD\}\}/g, BUILD)
  .replace(/\{\{APPS\}\}/g, suiteApps.map((a) => `- ${a.name} (${a.release === 'dev' ? 'development build' : 'version ' + a.release}): \`apps/${a.slug}/\``).join('\n')));
fs.writeFileSync(path.join(DEST, 'README.md'), `# ${hubWords['studio.name']} — browser edition\n\nThe hub and ${INCLUDED.length === 8 ? 'all eight' : INCLUDED.length} CadCraft apps in one folder. ` +
  `Put the folder on any web server and open it; see INSTALL.md.\n` + (leftOut.length ? `\nNot in this build: ${leftOut.map((l) => l.slug).join(', ')} (see release.json).\n` : ''));
const files = walk(DEST).filter((r) => r !== 'release.json');
const bytes = files.reduce((n, r) => n + fs.statSync(path.join(DEST, r)).size, 0);
const release = {
  format: 'cadcraft-suite', version: 1, app: 'studio', name: hubWords['studio.name'], edition: 'browser', release: BUILD,
  packed_at: suiteApps.map((a) => a.packed_at).filter(Boolean).sort().pop() || null, license: 'Apache-2.0',   // the newest edition's: same editions → same zip
  apps: suiteApps.map((a) => ({ slug: a.slug, name: a.name, release: a.release, packed_at: a.packed_at, libs: a.libs, local_libs: a.local_libs })),
  left_out: leftOut, shared_libs: sharedLibs, files: files.length, bytes_before_this_file: bytes,
  sizes: { suite: bytes, apps_if_separate: INCLUDED.reduce((n, s) => n + walk(eds[s]).reduce((m, r) => m + fs.statSync(path.join(eds[s], r)).size, 0), 0) },
};
fs.writeFileSync(path.join(DEST, 'release.json'), JSON.stringify(release, null, 2) + '\n');
console.log(`== suite: ${path.relative(STUDIO, DEST)} — ${INCLUDED.length} apps, ${files.length + 1} files, ${(bytes / 1048576).toFixed(1)} MB ` +
  `(the editions separately: ${(release.sizes.apps_if_separate / 1048576).toFixed(1)} MB)` + (leftOut.length ? `; left out: ${leftOut.map((l) => l.slug).join(', ')}` : ''));

// ------------------------------------------------------------------ checks: every local URL resolves; the gate

const problems = [];
for (const page of ['index.html', ...INCLUDED.map((s) => `apps/${s}/index.html`)]) {
  const html = read(path.join(DEST, page));
  const urls = [...html.matchAll(/(?:src|href|data-[a-z0-9-]+)="(\.{1,2}\/[^"#?]*)/g)].map((m) => m[1]);
  const im = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  if (im) urls.push(...Object.values(JSON.parse(im[1]).imports || {}));
  for (const u of urls) {
    if (/^\.\.\/[a-z0-9-]+\/index\.html$/.test(u)) { if (!exists(path.join(DEST, path.dirname(page), u))) problems.push(`${page}: ${u} (no such app)`); continue; }
    const f = path.join(DEST, path.dirname(page), u);
    if (!f.startsWith(DEST)) problems.push(`${page}: ${u} leaves the suite`);
    else if (!exists(f)) problems.push(`${page}: ${u} missing`);
  }
  // an import map's KEYS stay absolute on purpose (the apps' layout adapters import '/assets/js/app-workspace-input.js'); only keys are skipped
  if (/(?:src|href)="\/(?!\/)|"\/assets\//.test(html.replace(/"\/assets\/[^"]*"\s*:/g, '"":'))) problems.push(`${page}: an absolute URL`);
}
for (const a of suiteApps) for (const u of a.offline) if (!exists(path.join(DEST, u))) problems.push(`offline list of ${a.slug}: ${u} missing`);
if (problems.length) die('broken suite:\n  ' + problems.slice(0, 20).join('\n  '));
const gate = spawnSync('node', [path.join(SITE, 'bin/test-licenses.mjs'), '--tree', DEST], { encoding: 'utf8' });
if (gate.status !== 0 && !ALLOW_GATE) die('license/secrets gate failed:\n' + (gate.stdout + gate.stderr).trim().split('\n').slice(-15).join('\n'));
console.log('== gate: ' + (gate.status === 0 ? 'clean' : 'FAILED (allowed by --allow-gate: never ship this)'));

// ------------------------------------------------------------------ zip (H.8)

if (ZIP) {
  // A reproducible zip (one top folder, sorted, the pack date on every entry), written here: no zip tool needed.
  const top = `cadcraft-studio-v${BUILD}`;
  const zipFile = path.join(OUT, `cadcraft-studio-browser-v${BUILD}.zip`);
  const when = new Date((release.packed_at || '2026-01-01').slice(0, 10) + 'T00:00:00Z');
  const dosTime = 0;
  const dosDate = (((when.getUTCFullYear() - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate()) & 0xffff;
  const parts = [], central = [];
  const all = walk(DEST).sort();
  let offset = 0;
  for (const f of all) {
    const data = fs.readFileSync(path.join(DEST, f));
    const name = Buffer.from(`${top}/${f}`, 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(store ? 0 : 8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x0314, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(store ? 0 : 8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  if (all.length > 0xffff || offset > 0xffffffff) die('too big for a plain zip (no Zip64 here)');
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(all.length, 8); end.writeUInt16LE(all.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const buf = Buffer.concat([...parts, cd, end]);
  fs.writeFileSync(zipFile, buf);
  const t = spawnSync('unzip', ['-tq', zipFile], { encoding: 'utf8' });
  if (t.status !== 0) die('the zip does not test clean: ' + (t.stdout + t.stderr).trim());
  const z = spawnSync('node', [path.join(SITE, 'bin/test-licenses.mjs'), '--zip', zipFile], { encoding: 'utf8' });
  if (z.status !== 0 && !ALLOW_GATE) die('license/secrets gate failed on the zip:\n' + (z.stdout + z.stderr).trim().split('\n').slice(-10).join('\n'));
  const sums = fs.readdirSync(OUT).filter((f) => f.endsWith('.zip')).sort().map((f) => `${sha256(fs.readFileSync(path.join(OUT, f)))}  ${f}`);
  fs.writeFileSync(path.join(OUT, 'SHA256SUMS'), sums.join('\n') + '\n');
  console.log(`== zip: ${path.relative(STUDIO, zipFile)} (${(buf.length / 1048576).toFixed(1)} MB, ${all.length} files) sha256 ${sha256(buf)}`);
}
