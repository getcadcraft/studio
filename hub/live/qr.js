/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — no words. */
/**
 * qr.js — a small QR code encoder for Studio Live's code panel (0.5 LV.6: the host's address, port and code as a QR the
 * joiner scans). Own code, written from ISO/IEC 18004 (byte mode, versions 1–10, error correction L or M, all eight masks
 * tried, the lowest penalty kept). DOM-free and import-free.
 *
 *   qrMatrix(text, { ecl: 'M' }) → { size, dark(x, y) → bool, version, mask }   (throws when the text is too long)
 *   qrSvgPath(matrix, quiet = 4) → { d, size }   one SVG path ("M x y h1v1h-1z…") over a size × size viewBox
 *
 * Checked against an independent decoder (zxing-cpp) in test/test-live.mjs.
 */

const ECC = { L: { bits: 1, per: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18], blocks: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4] },
  M: { bits: 0, per: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26], blocks: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5] } };

function rawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
const dataCodewords = (ver, e) => Math.floor(rawModules(ver) / 8) - e.per[ver - 1] * e.blocks[ver - 1];

// GF(256), polynomial 0x11D
function mul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z & 255;
}
function rsDivisor(d) {
  const r = new Array(d).fill(0); r[d - 1] = 1;
  let root = 1;
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < d; j++) { r[j] = mul(r[j], root); if (j + 1 < d) r[j] ^= r[j + 1]; }
    root = mul(root, 2);
  }
  return r;
}
function rsRemainder(data, div) {
  const r = new Array(div.length).fill(0);
  for (const b of data) {
    const f = b ^ r.shift(); r.push(0);
    for (let i = 0; i < div.length; i++) r[i] ^= mul(div[i], f);
  }
  return r;
}

function alignments(ver, size) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let p = size - 7; out.length < n; p -= step) out.splice(1, 0, p);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

function build(ver, eclKey, codewords, mask) {
  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, d) => { m[y][x] = d; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  }
  const al = alignments(ver, size);
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // format bits (reserved now, written with the mask below)
  const format = () => {
    const data = (ECC[eclKey].bits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const b = (i) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, b(i));
    set(8, 7, b(6)); set(8, 8, b(7)); set(7, 8, b(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, b(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, b(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, b(i));
    set(8, size - 8, true);
  };
  format();
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const d = ((bits >>> i) & 1) !== 0, a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, d); set(b, a, d);
    }
  }
  // data, in the zigzag
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
      if (!fn[y][x] && i < codewords.length * 8) { m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
    }
  }
  const f = MASKS[mask];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && f(x, y)) m[y][x] = !m[y][x];
  return { m, size };
}

function penalty({ m, size }) {
  let p = 0;
  const line = (get) => {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) { run++; continue; }
      if (run >= 5) p += 3 + (run - 5);
      run = 1;
    }
    for (let i = 0; i + 7 <= size; i++) {
      const pat = [1, 0, 1, 1, 1, 0, 1].every((v, k) => get(i + k) === !!v);
      if (!pat) continue;
      const light = (a, b) => { for (let k = a; k < b; k++) if (k >= 0 && k < size && get(k)) return false; return true; };
      if (light(i - 4, i) || light(i + 7, i + 11)) p += 40;
    }
  };
  for (let y = 0; y < size; y++) line((x) => m[y][x]);
  for (let x = 0; x < size; x++) line((y) => m[y][x]);
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (m[y][x]) dark++;
    if (x < size - 1 && y < size - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
  }
  const total = size * size;
  p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return p;
}

export function qrMatrix(text, { ecl = 'M' } = {}) {
  const e = ECC[ecl];
  if (!e) throw new Error('qr: level L or M');
  const bytes = new TextEncoder().encode(String(text));
  let ver = 0;
  for (let v = 1; v <= 10; v++) {
    const need = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
    if (need <= dataCodewords(v, e) * 8) { ver = v; break; }
  }
  if (!ver) throw new Error('qr: text too long');
  const cap = dataCodewords(ver, e);
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);
  // blocks + error correction, interleaved
  const nb = e.blocks[ver - 1], eccLen = e.per[ver - 1], raw = Math.floor(rawModules(ver) / 8);
  const short = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const len = shortLen - eccLen + (i < short ? 0 : 1);
    const d = data.slice(k, k + len); k += len;
    blocks.push({ d, ecc: rsRemainder(d, div) });
  }
  const cw = [];
  for (let i = 0; i < shortLen - eccLen + 1; i++) for (const b of blocks) if (i < b.d.length) cw.push(b.d[i]);
  for (let i = 0; i < eccLen; i++) for (const b of blocks) cw.push(b.ecc[i]);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const q = build(ver, ecl, cw, mask);
    const p = penalty(q);
    if (!best || p < best.p) best = { p, q, mask };
  }
  const { m, size } = best.q;
  return { size, version: ver, mask: best.mask, dark: (x, y) => x >= 0 && y >= 0 && x < size && y < size && m[y][x] };
}

/** One path for every dark module, in a viewBox of size + 2 × quiet (the quiet zone the standard asks for). */
export function qrSvgPath(q, quiet = 4) {
  let d = '';
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.dark(x, y)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  return { d, size: q.size + quiet * 2 };
}
