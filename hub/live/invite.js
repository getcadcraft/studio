/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — codes, addresses and states only; the UI words them through the language file. */
/**
 * invite.js — Studio Live's ways in, as data (0.5 LV.6, LV.7, LV.23; spec docs/STUDIO-LIVE-SPEC.md §§ 6, 8, 9 in the site
 * repo). DOM-free and import-free, so the hub, every app window and Node tests share it.
 *
 *   parseJoin(text)          → what a person typed or pasted into Join:
 *     { kind: 'code', code, tag }                         a short code "K7-Q4M2X" (found on the LAN by its tag)
 *     { kind: 'lan', host, port, slug, code }             the host's QR / browser link http://<host>:<port>/apps/<slug>/#live=<code>
 *     { kind: 'address', host, port, code? }              a typed address "192.168.1.20:4545" (+ the code after a space)
 *     { kind: 'link', room, secret }                      an invite link https://getcadcraft.com/live/<ROOM>#<secret>,
 *                                                         or ccstudio://join/<ROOM>#<secret> (the same, from the link page)
 *     { kind: 'bad', reason: 'empty' | 'code' | 'link' | 'address' | 'unknown' }
 *   lanUrl({host, port, slug, code})   → the QR's text (and a browser joiner's link); null for an address no URL can carry
 *   socketUrl({host, port})            → ws://<host>:<port>/live (Studio's bridge opens it; LIVE-PROTOCOL § 12); null likewise
 *   urlHost(addr)                      → the address as a URL's host: IPv6 in brackets; null for link-local IPv6 (fe80::/10) or
 *                                        any zone id ("%eth0"): browsers don't take zone ids in URLs (WHATWG URL), so those
 *                                        addresses are skipped, never guessed
 *   relayJoinUrl(room)                 → wss://getcadcraft.com/live/relay/join/<ROOM>
 *   newLinkSecret(random?) / linkSecretBytes(fragment)   → the 128-bit link secret as 22 base64url characters, and back
 *   JoinStore(storage)       → the hub hands a join to the app window it opens: put(rec) → id; take(id) → rec once (2 min)
 *   expiresIn(ms, now)       → { minutes, seconds, over } for the code's countdown
 *
 * The secret parts (a code's last five characters, a link's fragment) are never logged, put in a title or sent to a server.
 */

export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford base32 (live-crypto.js)
export const SITE = 'https://getcadcraft.com';
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const ROOM_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{22,43}$/;
export const SLUGS = ['cadcraft', 'bimcraft', 'modelcraft', 'markupcraft', 'takeoffcraft', 'civilcraft', 'detailcraft', 'partcraft'];

/** "k7 q4m2x", "K7-Q4M2X", "k7q4m2x" → "K7-Q4M2X" (O → 0, I/L → 1), or null. */
export function normalizeCode(text) {
  let s = '';
  for (const ch of String(text || '').toUpperCase()) {
    if (ch === ' ' || ch === '-') continue;
    const c = ch === 'O' ? '0' : ch === 'I' || ch === 'L' ? '1' : ch;
    if (!CODE_ALPHABET.includes(c)) return null;
    s += c;
  }
  return s.length === 7 ? s.slice(0, 2) + '-' + s.slice(2) : null;
}

/** base64url (no padding) → bytes (16–32), or null. */
export function linkSecretBytes(fragment) {
  const f = String(fragment || '').replace(/^#/, '');
  if (!SECRET_RE.test(f)) return null;
  let bits = 0, n = 0;
  const out = [];
  for (const ch of f) {
    bits = (bits << 6) | B64.indexOf(ch); n += 6;
    if (n >= 8) { n -= 8; out.push((bits >> n) & 255); bits &= (1 << n) - 1; }
  }
  if (bits !== 0 || f.length % 4 === 1 || out.length < 16 || out.length > 32) return null;
  return Uint8Array.from(out);
}

/** 16 random bytes → 22 base64url characters. `random(n)` → Uint8Array (tests pass their own). */
export function newLinkSecret(random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  const b = random(16);
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const c = b.subarray(i, i + 3);
    const v = (c[0] << 16) | ((c[1] ?? 0) << 8) | (c[2] ?? 0);
    for (let k = 0; k <= c.length; k++) s += B64[(v >> (18 - 6 * k)) & 63];
  }
  return s;
}

const linkLocal6 = (a) => /^fe[89ab][0-9a-f]?:/i.test(a);
const hostOk = (h) => /^(\d{1,3}\.){3}\d{1,3}$/.test(h) ? h.split('.').every((x) => +x <= 255)
  : (/^\[[0-9a-f:.]+\]$/i.test(h) && !linkLocal6(h.slice(1))) || /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(h);
const portOk = (p) => /^\d{1,5}$/.test(p) && +p > 0 && +p < 65536;

/** What was typed or pasted into Join. Whitespace around it is ignored. */
export function parseJoin(text) {
  const s = String(text || '').trim();
  if (!s) return { kind: 'bad', reason: 'empty' };
  // An invite link, from the site's page or as Studio's own link.
  let m = /^(?:https:\/\/(?:www\.)?getcadcraft\.com\/live\/|ccstudio:\/\/join\/)([^#?/\s]*)\/?(?:\?[^#\s]*)?(?:#(\S*))?$/i.exec(s);
  if (m) {
    const room = m[1].toUpperCase();
    const secret = m[2] || '';
    if (!ROOM_RE.test(room) || !linkSecretBytes(secret)) return { kind: 'bad', reason: 'link' };
    return { kind: 'link', room, secret };
  }
  if (/^(https?:|ccstudio:)/i.test(s) && !/^http:\/\//i.test(s)) return { kind: 'bad', reason: 'link' };
  // The host's QR: http://<host>:<port>/apps/<slug>/#live=<code>
  m = /^http:\/\/([^/:\s]+|\[[^\]]+\]):(\d{1,5})\/apps\/([a-z]+)\/(?:index\.html)?#(?:.*&)?live=([0-9A-Za-z-]{7,9})(?:&.*)?$/.exec(s);
  if (m) {
    const code = normalizeCode(m[4]);
    if (!hostOk(m[1]) || !portOk(m[2]) || !SLUGS.includes(m[3]) || !code) return { kind: 'bad', reason: 'address' };
    return { kind: 'lan', host: m[1], port: +m[2], slug: m[3], code };
  }
  if (/^http:/i.test(s)) return { kind: 'bad', reason: 'address' };
  // A typed address, maybe followed by the code: "192.168.1.20:4545 K7-Q4M2X"
  m = /^([^\s:]+|\[[^\]]+\]):(\d{1,5})(?:\s+(.+))?$/.exec(s);
  if (m) {
    if (!hostOk(m[1]) || !portOk(m[2])) return { kind: 'bad', reason: 'address' };
    const code = m[3] ? normalizeCode(m[3]) : null;
    if (m[3] && !code) return { kind: 'bad', reason: 'code' };
    return code ? { kind: 'address', host: m[1], port: +m[2], code } : { kind: 'address', host: m[1], port: +m[2] };
  }
  const code = normalizeCode(s);
  if (code) return { kind: 'code', code, tag: code.slice(0, 2) };
  return { kind: 'bad', reason: /^[0-9a-z -]{5,12}$/i.test(s) ? 'code' : 'unknown' };
}

export function urlHost(addr) {
  let a = String(addr || '').trim();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  if (!a || a.includes('%')) return null;
  if (!a.includes(':')) return hostOk(a) ? a : null;
  if (!/^[0-9a-f:.]+$/i.test(a) || linkLocal6(a)) return null;
  return '[' + a + ']';
}
export const lanUrl = ({ host, port, slug, code }) => { const h = urlHost(host); return h ? `http://${h}:${port}/apps/${slug}/#live=${code}` : null; };
export const socketUrl = ({ host, port }) => { const h = urlHost(host); return h ? `ws://${h}:${port}/live` : null; };
export const relayJoinUrl = (room) => `wss://getcadcraft.com/live/relay/join/${room}`;
export const inviteLink = (room, secret) => `${SITE}/live/${room}#${secret}`;

/** The countdown under a code. */
export function expiresIn(expires, now = Date.now()) {
  const left = Math.max(0, Math.round((expires - now) / 1000));
  return { minutes: Math.floor(left / 60), seconds: left % 60, over: left === 0 };
}

/**
 * The hub opens the app window and hands it the join through this origin's localStorage (both windows share it; a URL
 * would put the secret in history). One record per id, read once, gone after 2 minutes.
 */
export class JoinStore {
  constructor(storage, { now = () => Date.now(), prefix = 'cadcraft.studio.livejoin.' } = {}) { this.s = storage; this.now = now; this.p = prefix; }
  sweep() {
    try {
      for (let i = this.s.length - 1; i >= 0; i--) {
        const k = this.s.key(i);
        if (!k || !k.startsWith(this.p)) continue;
        let r = null;
        try { r = JSON.parse(this.s.getItem(k)); } catch { r = null; }
        if (!r || !(r.at > this.now() - 120000)) this.s.removeItem(k);
      }
    } catch { /* storage unavailable */ }
  }
  put(rec, id = Math.random().toString(36).slice(2, 12)) {
    this.sweep();
    this.s.setItem(this.p + id, JSON.stringify(Object.assign({}, rec, { at: this.now() })));
    return id;
  }
  take(id) {
    if (!/^[a-z0-9]{4,32}$/.test(String(id || ''))) return null;
    const k = this.p + id;
    let r = null;
    try { r = JSON.parse(this.s.getItem(k)); } catch { r = null; }
    try { this.s.removeItem(k); } catch { /* gone */ }
    if (!r || !(r.at > this.now() - 120000)) return null;
    delete r.at;
    return r;
  }
}
