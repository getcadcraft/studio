#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// test-live.mjs — Studio Live's DOM-free modules in Studio (0.5 LV.6 / LV.7 / LV.23): what Join accepts (codes, the QR,
// addresses, invite links, ccstudio:// links), the join hand-over between the hub and an app window, the link secret
// (checked against live-crypto.js when CADCRAFT_SITE is set), the QR encoder (checked against zxing-cpp when
// test/venv has it: python3 -m venv test/venv && test/venv/bin/pip install zxing-cpp pillow), what the panels show,
// and the Live words in every hub language.   node test/test-live.mjs [--verbose]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { STUDIO, SITE, ok, section, done } from './lib.mjs';

const I = await import(path.join(STUDIO, 'hub/live/invite.js'));
const V = await import(path.join(STUDIO, 'hub/live/view.js'));
const Q = await import(path.join(STUDIO, 'hub/live/qr.js'));

section('What Join accepts (LV.7, LV.23)');
{
  const p = I.parseJoin;
  ok(p('K7-Q4M2X').kind === 'code' && p('K7-Q4M2X').code === 'K7-Q4M2X' && p('K7-Q4M2X').tag === 'K7', 'a code');
  ok(p('  k7 q4m2x ').code === 'K7-Q4M2X' && p('k7q4m2x').code === 'K7-Q4M2X', 'a code in lower case, with spaces or no dash');
  ok(p('KO-QIMLX').code === 'K0-Q1M1X', 'O → 0, I and L → 1 (Crockford)');
  ok(p('K7-Q4M2').kind === 'bad' && p('K7-Q4M2').reason === 'code' && p('K7-Q4M2XX').kind === 'bad' && p('K7-Q4MUX').kind === 'bad', 'a short, long or misspelled (U) code is refused as a code');
  ok(p('').reason === 'empty' && p('   ').reason === 'empty', 'nothing typed');
  const l = p('https://getcadcraft.com/live/K7QX9M2B#a3FvQ2xpZW50U2VjcmV0MTI');
  ok(l.kind === 'link' && l.room === 'K7QX9M2B' && l.secret === 'a3FvQ2xpZW50U2VjcmV0MTI', 'an invite link');
  ok(p('ccstudio://join/K7QX9M2B#a3FvQ2xpZW50U2VjcmV0MTI').kind === 'link', 'a ccstudio:// link (from the link page)');
  ok(p('https://www.getcadcraft.com/live/k7qx9m2b/#a3FvQ2xpZW50U2VjcmV0MTI').room === 'K7QX9M2B', 'www., a trailing slash and a lower-case room');
  ok(p('https://getcadcraft.com/live/K7QX9M2B').reason === 'link' && p('https://getcadcraft.com/live/K7QX9M2B#short').reason === 'link', 'a link without its secret, or a cut-off one');
  ok(p('https://getcadcraft.com/live/K7QX9M2U#a3FvQ2xpZW50U2VjcmV0MTI').reason === 'link', 'a room with a letter outside the alphabet');
  ok(p('https://evil.example/live/K7QX9M2B#a3FvQ2xpZW50U2VjcmV0MTI').kind === 'bad' && p('ccstudio://other/K7QX9M2B#a3FvQ2xpZW50U2VjcmV0MTI').kind === 'bad', 'another site, another ccstudio:// action');
  const q = p('http://192.168.1.20:4545/apps/cadcraft/#live=K7-Q4M2X');
  ok(q.kind === 'lan' && q.host === '192.168.1.20' && q.port === 4545 && q.slug === 'cadcraft' && q.code === 'K7-Q4M2X', 'the host\'s QR text');
  ok(p('http://[fd00::1]:4545/apps/markupcraft/index.html#live=k7q4m2x').host === '[fd00::1]', 'the QR text with an IPv6 address and index.html');
  ok(p('http://[fe80::1]:4545/apps/markupcraft/index.html#live=k7q4m2x').kind === 'bad', 'not with a link-local IPv6 one (no zone id fits in a URL)');
  ok(p('http://192.168.1.20:4545/apps/evilcraft/#live=K7-Q4M2X').kind === 'bad' && p('http://192.168.1.20:99999/apps/cadcraft/#live=K7-Q4M2X').kind === 'bad' && p('http://999.1.1.1:4545/apps/cadcraft/#live=K7-Q4M2X').kind === 'bad', 'an unknown app, a bad port or address');
  const a = p('192.168.1.20:4545 K7-Q4M2X');
  ok(a.kind === 'address' && a.host === '192.168.1.20' && a.port === 4545 && a.code === 'K7-Q4M2X', 'a typed address and code');
  ok(p('studio-pc.local:4545').kind === 'address' && !p('studio-pc.local:4545').code, 'a typed address alone (the code asked next)');
  ok(p('192.168.1.20:4545 nonsense').reason === 'code', 'an address with a bad code');
  ok(p('hello there, friend').reason === 'unknown' && p('javascript:alert(1)').kind === 'bad', 'anything else');
  ok(I.lanUrl({ host: '10.0.0.5', port: 51234, slug: 'cadcraft', code: 'K7-Q4M2X' }) === 'http://10.0.0.5:51234/apps/cadcraft/#live=K7-Q4M2X'
    && p(I.lanUrl({ host: '10.0.0.5', port: 51234, slug: 'cadcraft', code: 'K7-Q4M2X' })).kind === 'lan', 'lanUrl → parseJoin round trip');
  ok(I.socketUrl({ host: '10.0.0.5', port: 51234 }) === 'ws://10.0.0.5:51234/live' && I.relayJoinUrl('K7QX9M2B') === 'wss://getcadcraft.com/live/relay/join/K7QX9M2B', 'socket and relay URLs');
}

section('IPv6 addresses in URLs');
{
  ok(I.urlHost('192.168.1.20') === '192.168.1.20' && I.urlHost('fd00::5') === '[fd00::5]' && I.urlHost('[2001:db8::1]') === '[2001:db8::1]', 'IPv4 as it is, IPv6 in brackets');
  ok(I.urlHost('fe80::1') === null && I.urlHost('fe80::1%eth0') === null && I.urlHost('fd00::1%25eth0') === null, 'link-local IPv6 and zone ids: skipped (a URL can\'t carry a zone)');
  ok(I.socketUrl({ host: 'fd00::5', port: 4000 }) === 'ws://[fd00::5]:4000/live' && I.socketUrl({ host: 'fe80::1', port: 4000 }) === null, 'socketUrl brackets IPv6 and refuses link-local');
  const u = I.lanUrl({ host: '2001:db8::7', port: 51234, slug: 'cadcraft', code: 'K7-Q4M2X' });
  ok(u === 'http://[2001:db8::7]:51234/apps/cadcraft/#live=K7-Q4M2X' && I.parseJoin(u).kind === 'lan' && I.parseJoin(u).host === '[2001:db8::7]', 'an IPv6 QR link round-trips through Join');
  ok(new URL(u).hostname === '[2001:db8::7]', 'and is a URL a browser takes');
  ok(I.parseJoin('[fe80::1]:4000 K7-Q4M2X').kind === 'bad' && I.parseJoin('[fd00::1]:4000 K7-Q4M2X').kind === 'address', 'a typed link-local address is refused, a routable one taken');
}

section('The link secret (LV.23)');
{
  let seed = 7;
  const rnd = (n) => Uint8Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) & 0xff));
  const s = I.newLinkSecret(rnd);
  ok(/^[A-Za-z0-9_-]{22}$/.test(s), '128 bits as 22 base64url characters');
  const b = I.linkSecretBytes(s);
  ok(b && b.length === 16, 'and back to 16 bytes');
  const real = I.newLinkSecret();
  ok(I.linkSecretBytes(real).length === 16 && I.newLinkSecret() !== real, 'from crypto.getRandomValues, a new one each time');
  ok(I.linkSecretBytes('abc') === null && I.linkSecretBytes('a'.repeat(23)) === null && I.linkSecretBytes('a3FvQ2xpZW50U2VjcmV0MT+') === null, 'too short, a dangling character, a non-url character');
  if (SITE) {
    await import(path.join(SITE, 'tools/live-crypto/node-hook.mjs'));
    const LC = await import(path.join(SITE, 'public_html/assets/js/live-crypto.js'));
    let same = true;
    for (let i = 0; i < 200; i++) {
      const x = I.newLinkSecret();
      const y = LC.newLinkSecret();
      const a1 = LC.parseLinkSecret(x), a2 = I.linkSecretBytes(y);
      if (!a1 || !a2 || Buffer.compare(Buffer.from(a1), Buffer.from(I.linkSecretBytes(x))) !== 0 || Buffer.compare(Buffer.from(a2), Buffer.from(LC.parseLinkSecret(y))) !== 0) same = false;
    }
    ok(same, 'the same bytes as live-crypto.js both ways (200 secrets)');
    ok(I.normalizeCode(LC.newCode()) !== null && LC.parseCode(I.normalizeCode('k7 q4m2x')).tag === 'K7', 'codes: our normalizing agrees with parseCode');
    ok(I.CODE_ALPHABET === LC.CODE_ALPHABET, 'the same code alphabet');
  } else console.log('  (CADCRAFT_SITE not set: the live-crypto.js comparison is skipped)');
}

section('Handing a join to the app window');
{
  const mem = () => { const m = new Map(); return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
  let now = 1000000;
  const s = mem();
  const st = new I.JoinStore(s, { now: () => now });
  const id = st.put({ kind: 'link', room: 'K7QX9M2B', secret: 'x'.repeat(22), name: 'Ana' });
  ok(/^[a-z0-9]{4,32}$/.test(id), 'an id for the window\'s address');
  const r = st.take(id);
  ok(r && r.room === 'K7QX9M2B' && r.name === 'Ana' && r.at === undefined, 'the window reads it');
  ok(st.take(id) === null && s.length === 0, 'once');
  const id2 = st.put({ kind: 'code', code: 'K7-Q4M2X' });
  now += 121000;
  ok(st.take(id2) === null, 'gone after 2 minutes');
  st.put({ kind: 'code', code: 'K7-Q4M2X' });
  now += 121000;
  st.put({ kind: 'code', code: 'K7-Q4M2Y' });
  ok(s.length === 1, 'old ones are swept when a new one is put');
  ok(st.take('../etc') === null && st.take('') === null, 'a malformed id is refused');
}

section('The QR (LV.6)');
{
  const texts = ['http://192.168.1.20:4545/apps/cadcraft/#live=K7-Q4M2X', 'http://[fe80::1234:5678:9abc:def0]:65535/apps/takeoffcraft/#live=K7-Q4M2X', 'K7-Q4M2X', 'é✓'.repeat(20), 'x'.repeat(200)];
  const qs = texts.flatMap((t) => ['L', 'M'].map((ecl) => ({ t, ecl, q: Q.qrMatrix(t, { ecl }) })));
  ok(qs.every(({ q }) => q.size === q.version * 4 + 17), 'sizes follow the version');
  ok(qs.find((x) => x.t.startsWith('http://192') && x.ecl === 'M').q.version <= 4, 'a LAN link fits a small code (version ≤ 4 at level M)');
  ok(qs.some(({ q }) => q.version === 10) || Q.qrMatrix('y'.repeat(200), { ecl: 'M' }).version >= 9, 'long texts reach the larger versions');
  let threw = false;
  try { Q.qrMatrix('z'.repeat(400)); } catch { threw = true; }
  ok(threw, 'too long → an error, never a broken code');
  const svg = Q.qrSvgPath(qs[0].q, 4);
  ok(svg.size === qs[0].q.size + 8 && /^(M\d+ \d+h1v1h-1z)+$/.test(svg.d), 'the SVG path and its quiet zone');
  const py = path.join(STUDIO, 'test/venv/bin/python');
  if (fs.existsSync(py)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-qr-'));
    const list = qs.map(({ t, ecl, q }, i) => {
      const s = 4, n = (q.size + 8) * s, buf = Buffer.alloc(n * n, 255);
      for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.dark(x, y)) for (let dy = 0; dy < s; dy++) buf.fill(0, ((y + 4) * s + dy) * n + (x + 4) * s, ((y + 4) * s + dy) * n + (x + 5) * s);
      const f = path.join(dir, `${i}${ecl}.pgm`);
      fs.writeFileSync(f, Buffer.concat([Buffer.from(`P5 ${n} ${n} 255\n`), buf]));
      return { f, t };
    });
    fs.writeFileSync(path.join(dir, 'list.json'), JSON.stringify(list));
    const r = spawnSync(py, ['-I', '-c', 'import json,sys,zxingcpp\nfrom PIL import Image\nfor it in json.load(open(sys.argv[1])):\n  r=zxingcpp.read_barcodes(Image.open(it["f"]))\n  print(json.dumps(r[0].text if r else None))', path.join(dir, 'list.json')], { encoding: 'utf8' });
    const got = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const bad = list.filter((it, i) => got[i] !== it.t);
    ok(r.status === 0 && got.length === list.length && !bad.length, `zxing-cpp reads every code back (${list.length}: versions ${[...new Set(qs.map((x) => x.q.version))].sort((a, b) => a - b).join(', ')}; all eight masks seen: ${new Set(qs.map((x) => x.q.mask)).size})` + (bad.length ? ': ' + bad.map((b) => b.t.slice(0, 20)).join(', ') : ''));
    fs.rmSync(dir, { recursive: true, force: true });
  } else console.log('  (test/venv has no zxing-cpp: the independent QR read is skipped)');
}

section('What the panels show');
{
  const peers = new Map([[2, { c: 2, name: 'Ben‮', role: 'editor', via: 'relay', state: 'in' }], [3, { c: 3, name: 'Ana', role: 'viewer', via: 'lan', state: 'gone' }],
    [4, { c: 4, name: 'Replica', role: 'replica', state: 'in' }], [5, { c: 5, name: 'Gone for good', role: 'editor', state: 'removed' }]]);
  const rows = V.peopleRows({ c: 1, role: 'host', o: { name: 'Host  Person' }, peers });
  ok(rows.map((r) => r.c).join() === '1,3,2', 'the host first, then by name; replicas and removed people left out');
  ok(rows[0].self && rows[0].host && rows[0].name === 'Host Person', 'the host row is "you"');
  ok(rows[2].name === 'Ben' && rows[2].via === 'relay' && rows[1].state === 'gone', 'names cleaned of control and direction characters; via and state kept');
  const card = V.joinCard({ c: 9, name: '  Ana\nB  ', device: 'x'.repeat(80), via: 'relay', kid: 'K7QX9M2B', picture: 'not bytes' });
  ok(card.name === 'Ana B' && card.device.length === 40 && card.via === 'relay' && card.picture === null, 'the approve card: trimmed name and device, a picture only as bytes');
  ok(V.joinCard({ c: 1, via: 'whatever' }).via === 'lan', 'via is lan unless the server said relay');
  // LV.18: assistants as their own clients
  const ap = new Map([...peers, [6, { c: 6, name: 'helper', role: 'assistant', via: 'lan', state: 'in', of: 2 }], [7, { c: 7, name: 'mine', role: 'assistant', via: 'local', state: 'in', of: 1 }],
    [8, { c: 8, name: 'left', role: 'assistant', via: 'lan', state: 'gone', of: 2 }], [9, { c: 9, name: 'orphan', role: 'assistant', via: 'lan', state: 'in', of: 42 }]]);
  const ar = V.peopleRows({ c: 1, role: 'host', o: { name: 'Host' }, peers: ap });
  ok(ar.map((r) => r.c).join() === '1,7,3,2,6,9', 'an assistant right after its person (yours after you); one whose person isn\'t listed last; one that left is gone', ar.map((r) => r.c).join());
  ok(ar.find((r) => r.c === 6).of === 2 && !ar.find((r) => r.c === 2).of, 'rows carry whose assistant it is');
  const acard = V.joinCard({ c: 6, name: 'helper', via: 'lan', assistant: { of: 2, of_name: ' Ben‮ ' } });
  ok(acard.assistant && acard.assistant.of === 2 && acard.assistant.ofName === 'Ben', 'an assistant\'s approve card: whose, its person\'s name cleaned');
  ok(V.joinCard({ c: 6, assistant: { of: 0 } }).assistant === null && V.joinCard({ c: 6, assistant: 'x' }).assistant === null, 'no person, no assistant card');
  ok(!V.canHandOver(ar.find((r) => r.c === 6)), 'the session is never handed to an assistant');
  ok(V.statusLine('live', { role: 'editor', people: 3 }).key === 'window.live.status.live' && V.statusLine('live', { role: 'viewer' }).key === 'window.live.status.viewing' && V.statusLine('waiting').key === 'window.live.status.waiting', 'status lines');
  ok(V.endLine({ status: 'failed', reason: 'wrong-code' }).key === 'window.live.end.wrongcode' && V.endLine({ status: 'failed', reason: 'room-closed' }).key === 'window.live.end.roomclosed'
    && V.endLine({ status: 'denied', reason: 'app' }).key === 'window.live.end.denied.app' && V.endLine({ status: 'denied', reason: '??' }).key === 'window.live.end.denied.other'
    && V.endLine({ status: 'ended', host: 'Ana', file: 'Plan' }).key === 'window.live.end.copy' && V.endLine({ status: 'ended' }).key === 'window.live.end.copy.nohost', 'how a session ends, for a joiner');
  ok(V.refuseKey('locked') === 'window.live.refused.locked' && V.refuseKey('x') === 'window.live.refused.other', 'refusals');
  ok(V.relayLine({ state: 'license', ok: false }).noNewLink === true && V.relayLine({ state: 'closed', code: 4005 }).linkDead && V.relayLine({ state: 'ready', license_ok: true }).key === 'window.live.relay.ready' && V.relayLine({ state: '?' }) === null, 'relay notices');
  ok(V.initials('ana maría lópez') === 'AL' && V.initials('ben') === 'B' && V.initials('') === '?' && V.initials('  ') === '?', 'initials');
  ok(V.layerFor(1) !== V.layerFor(2) && V.LAYERS.includes(V.layerFor(-3)), 'a colour per person');
  ok(V.LIFETIMES.filter((x) => x.default).map((x) => x.key).join() === '8h', 'links last 8 hours unless the host picks (spec § 13.7, recommended)');
  const e = I.expiresIn(1000 + 9 * 60000 + 5000, 1000);
  ok(e.minutes === 9 && e.seconds === 5 && !e.over && I.expiresIn(0, 5).over, 'the countdown');
}

section('Handing over (LV.17)');
{
  const row = (o) => Object.assign({ c: 4, name: 'Ben', role: 'editor', state: 'in', self: false, host: false }, o);
  ok(V.canHandOver(row()) && !V.canHandOver(row({ role: 'viewer' })) && !V.canHandOver(row({ self: true })) && !V.canHandOver(row({ state: 'gone' })) && !V.canHandOver(row({ host: true, role: 'host' })), 'only to an editor who is here, never yourself');
  ok(V.endLine({ status: 'lost', reason: 'moved', host: 'Ben', file: 'a.dwg' }).key === 'window.live.end.moved' && V.endLine({ status: 'lost', host: 'Ben' }).key === 'window.live.end.lost', 'moved out of reach has its own words');
}

section('Live words in every hub language');
{
  const langs = fs.readdirSync(path.join(STUDIO, 'hub/lang')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(STUDIO, 'hub/lang', f), 'utf8')));
  const en = langs.find((l) => l['@locale'] === 'en');
  const src = fs.readdirSync(path.join(STUDIO, 'hub/live')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(STUDIO, 'hub/live', f), 'utf8')).join('\n');
  const html = fs.readFileSync(path.join(STUDIO, 'hub/index.html'), 'utf8');
  const lits = [...src.matchAll(/'((?:window\.live|live\.join)\.[a-z0-9.-]*)'/g), ...html.matchAll(/data-t="((?:window\.live|live\.join)\.[a-z0-9.-]*)"/g)].map((m) => m[1]);
  const exact = lits.filter((k) => !k.endsWith('.'));
  const prefixes = lits.filter((k) => k.endsWith('.'));
  const missing = exact.filter((k) => !(k in en));
  ok(!missing.length, `every Live key the code names exists (${new Set(exact).size})` + (missing.length ? ': ' + [...new Set(missing)].join(', ') : ''));
  const live = Object.keys(en).filter((k) => k.startsWith('window.live.') || k.startsWith('live.join.'));
  const unused = live.filter((k) => !exact.includes(k) && !prefixes.some((p) => k.startsWith(p)));
  ok(!unused.length, 'no unused Live keys' + (unused.length ? ': ' + unused.join(', ') : ''));
  const I18N = SITE ? await import(path.join(SITE, 'public_html/assets/js/i18n.js')) : null;
  for (const l of langs.filter((x) => x !== en)) {
    const miss = live.filter((k) => !(k in l));
    ok(!miss.length, `${l['@locale']}: every Live key` + (miss.length ? ': ' + miss.join(', ') : ''));
    if (I18N) {
      const fills = live.filter((k) => k in l && I18N.fillsOf(l[k]).join() !== I18N.fillsOf(en[k]).join());
      ok(!fills.length, `${l['@locale']}: the same {fills} as English` + (fills.length ? ': ' + fills.join(', ') : ''));
      const forms = live.filter((k) => typeof en[k] === 'object' && (typeof l[k] !== 'object' || !l[k].one || !l[k].other));
      ok(!forms.length, `${l['@locale']}: plurals have one and other` + (forms.length ? ': ' + forms.join(', ') : ''));
    }
  }
  const text = live.map((k) => (typeof en[k] === 'string' ? en[k] : Object.values(en[k]).join(' '))).join('\n');
  ok(!/\bcrafts\b/i.test(text) && !/→/.test(text) && !/\bnine\b/i.test(text) && !/AutoCAD|Revit|SketchUp|Bluebeam/.test(text), 'copy rules');
}

done();
