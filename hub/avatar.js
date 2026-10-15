/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — no words. */
/**
 * avatar.js — the signed-in person's profile picture in Studio (0.5 SI.7; SI.8 takes the 64 × 64 one into live sessions).
 *
 * The site sends it to its owner only: `/api/v1/me` → user.avatar {url, url_64, updated_at} | null, and
 * `GET /api/v1/me/avatar[?size=64]` (Bearer, through the shell's cloud.request) → image/webp. Studio keeps both sizes in
 * localStorage with their updated_at, so the picture shows offline and a new one replaces it on the next Refresh.
 * Nothing the site sends is put into the page as HTML: the bytes must decode as an image (`decode(bytes)` → true) before
 * they are kept, and the page shows them through a blob: URL in an <img>.
 *
 *   const a = avatarStore({ request, storage, decode });
 *   await a.refresh(user.avatar)   → { big: Uint8Array | null, small: Uint8Array | null, at }   (null avatar = forget)
 *   a.cached()                     → the same from storage
 *   a.forget()                     (signing out)
 */

const KEY = 'cadcraft.studio.avatar';
const MAX = 512 * 1024;
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** In a page: the bytes decode as an image (a WebP, PNG or JPEG the browser can draw), else false. */
export async function decodesAsImage(bytes) {
  try {
    if (typeof createImageBitmap !== 'function') return false;
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
    const ok = bmp.width > 0 && bmp.height > 0 && bmp.width <= 1024 && bmp.height <= 1024;
    if (bmp.close) bmp.close();
    return ok;
  } catch { return false; }
}

export function avatarStore({ request, storage = globalThis.localStorage, decode = decodesAsImage } = {}) {
  const read = () => { try { return JSON.parse(storage.getItem(KEY) || 'null'); } catch { return null; } };
  const view = (c) => ({ big: c && c.big ? unb64(c.big) : null, small: c && c.small ? unb64(c.small) : null, at: (c && c.at) || '' });
  const get = async (path) => {
    const r = await request({ method: 'GET', path });
    if (!r || r.status !== 200 || !(r.body instanceof Uint8Array) || !r.body.length || r.body.length > MAX) return null;
    return (await decode(r.body)) ? r.body : null;
  };
  return {
    cached: () => view(read()),
    forget() { try { storage.removeItem(KEY); } catch { /* nothing kept */ } },
    async refresh(info) {
      if (!info || typeof info !== 'object' || !info.updated_at) { this.forget(); return view(null); }
      const c = read();
      if (c && c.at === String(info.updated_at) && c.big) return view(c);
      let big = null, small = null;
      try { big = await get('/api/v1/me/avatar'); small = await get('/api/v1/me/avatar?size=64'); } catch { return view(c); }   // offline / not allowed: keep what we had
      if (!big) return view(c);
      const keep = { at: String(info.updated_at), big: b64(big), small: small ? b64(small) : null };
      try { storage.setItem(KEY, JSON.stringify(keep)); } catch { /* too big for storage: shown this run only */ }
      return view(keep);
    },
  };
}
