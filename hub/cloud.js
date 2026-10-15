/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — states and codes only; hub.js words them through the language file. */
/**
 * cloud.js — the hub's account card data (C.7) and the shell half of offline saving (C.8). DOM-free.
 *
 * The desktop shell holds the sign-in; pages never see a token (desktop C.2): `cadcraftDesktop.account.*` gives the
 * state and `cadcraftDesktop.cloud.request({method, path, body})` reaches /api/v1/me and /api/v1/sync/* with the shell
 * adding the bearer. The browser edition has no cloud (D.4), so none of this runs there.
 *
 *   const c = cloudClient(window.cadcraftDesktop.cloud);
 *   await c.status()                 → sync/status data (user, workspaces[{uuid, name, kind, role, apps, cloud_open, storage}])
 *   await c.drawings(workspaceUuid)  → [{uuid, name, app, project_name, version, can_edit, updated_at}]
 *   await c.open(drawingUuid)        → {bytes, version, sha256}  (sha256 checked)
 *   every call throws CloudError {code, status} on failure: invalid_token | token_revoked | token_expired |
 *   account_inactive (→ sign in again) | sync_closed | insufficient_scope | throttled | offline | conflict | …
 *
 * SyncQueue (C.8): saves wait here (IndexedDB "cadcraft-studio-sync", or memory in tests) until they reach the server.
 *   q.enqueue({drawing | project+app+name, base, name, app, bytes, note}) → item (a fresh save_id, kept for retries)
 *   q.flush()  sends in order: 201/200 → done (removed); 409 → state 'conflict' (kept, never overwritten: the person
 *   opens the newer version or saves a copy); 401 sign-in errors → the queue pauses ('signin'); 429 / network /
 *   5xx → stays 'waiting' and retries later with the same save_id (the server answers "replayed", never a duplicate);
 *   403/413/422/507 → 'failed' with the reason (kept until removed: local work is never lost).
 *   q.summary() → {waiting, conflict, failed, paused}
 */

export class CloudError extends Error {
  constructor(code, status = 0, extra = {}) { super(code); this.code = code; this.status = status; Object.assign(this, extra); }
}

export const SIGN_IN_AGAIN = new Set(['invalid_token', 'token_revoked', 'token_expired', 'account_inactive']);

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256Hex(bytes) {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) return null;
  return hex(await s.digest('SHA-256', bytes));
}

const uuid = () => (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16)));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One call → parsed JSON data, or a CloudError. `request` is cadcraftDesktop.cloud.request (or a test stand-in). */
async function call(request, method, path, body, contentType) {
  let res;
  try { res = await request({ method, path, body, contentType }); }
  catch (e) { throw new CloudError(e && e.code === 'not_allowed' ? 'not_allowed' : 'offline', 0, { cause: e }); }
  const status = res.status;
  let json = null;
  try { json = res.json(); } catch { json = null; }
  if (status >= 200 && status < 300) return { status, data: json ? json.data : null, json, res };
  const code = (json && (json.code || json.error)) || (status === 429 ? 'throttled' : status >= 500 ? 'server' : 'error');
  throw new CloudError(String(code), status, { json, retryAfter: Number(res.headers && (res.headers['retry-after'] || res.headers['Retry-After'])) || null });
}

export function cloudClient(cloud) {
  const request = cloud && typeof cloud.request === 'function' ? cloud.request : null;
  if (!request) throw new Error('cloud: no request function');
  const q = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  return {
    async me() { return (await call(request, 'GET', '/api/v1/me')).data; },
    async status() { return (await call(request, 'GET', '/api/v1/sync/status')).data; },
    async drawings(workspace, { app, since } = {}) {
      if (!UUID_RE.test(String(workspace || ''))) throw new CloudError('invalid');
      const d = (await call(request, 'GET', '/api/v1/sync/drawings?' + q({ workspace, app, since }))).data;
      return { drawings: Array.isArray(d && d.drawings) ? d.drawings : [], serverTime: d && d.server_time };
    },
    async open(drawing, version = null) {
      if (!UUID_RE.test(String(drawing || ''))) throw new CloudError('invalid');
      const r = await call(request, 'GET', '/api/v1/sync/open?' + q({ drawing, version }));
      const h = r.res.headers || {};
      const want = h['x-cadcraft-sha256'] || h['X-CadCraft-Sha256'] || null;
      const bytes = r.res.body;
      const got = await sha256Hex(bytes);
      if (want && got && want.toLowerCase() !== got) throw new CloudError('checksum');
      return { bytes, version: Number(h['x-cadcraft-version'] || h['X-CadCraft-Version']) || null, sha256: got };
    },
    /** One save attempt (SyncQueue uses it). */
    async save({ drawing, project, app, name, base = 0, saveId, bytes, note, sha256 }) {
      const qs = drawing ? { drawing, base, save_id: saveId, sha256, note, source: 'desktop-app' }
        : { project, app, name, base: 0, save_id: saveId, sha256, note, source: 'desktop-app' };
      const r = await call(request, 'POST', '/api/v1/sync/save?' + q(qs), bytes, 'application/octet-stream');
      return { status: r.status, data: r.data, message: r.json && r.json.message };
    },
  };
}

const SLUG = /^[a-z0-9-]{1,80}$/;
/** A team's page slug (/teams/<slug>): sync/status's own, else /api/v1/me's organizations[] (0.5 SI.6), by uuid. */
function slugOf(w, me) {
  if (typeof w.slug === 'string' && SLUG.test(w.slug)) return w.slug;
  const orgs = me && Array.isArray(me.organizations) ? me.organizations : [];
  const o = orgs.find((x) => x && x.uuid === w.uuid);
  return o && typeof o.slug === 'string' && SLUG.test(o.slug) ? o.slug : null;
}

/**
 * The account card's view of a sync/status answer: one workspace (the chosen one, else the first with cloud open).
 * `me` = /api/v1/me's data, for what sync/status doesn't carry (team slugs).
 */
export function cardModel(status, { workspace = null, me = null } = {}) {
  if (!status || !status.user) return null;
  const ws = Array.isArray(status.workspaces) ? status.workspaces : [];
  const pick = ws.find((w) => w.uuid === workspace) || ws.find((w) => w.cloud_open) || ws[0] || null;
  return {
    user: { name: String(status.user.name || ''), email: String(status.user.email || ''), verified: !!status.user.email_verified },
    workspaces: ws.map((w) => ({ uuid: w.uuid, name: String(w.name || ''), kind: w.kind, role: w.role, apps: Array.isArray(w.apps) ? w.apps : [], open: !!w.cloud_open })),
    workspace: pick ? {
      uuid: pick.uuid, name: String(pick.name || ''), kind: pick.kind, slug: slugOf(pick, me), apps: Array.isArray(pick.apps) ? pick.apps : [], open: !!pick.cloud_open,
      used: pick.storage ? pick.storage.used_label || null : null, quota: pick.storage ? pick.storage.quota_label || null : null,
      fraction: pick.storage && pick.storage.quota_bytes > 0 ? Math.min(1, pick.storage.used_bytes / pick.storage.quota_bytes) : null,
    } : null,
  };
}

// ------------------------------------------------------------------ the save queue (C.8)

/** A queue store over IndexedDB, or memory. */
export function queueStore(factory = globalThis.indexedDB) {
  if (!factory) {
    const m = new Map();
    return { kind: 'memory', all: async () => [...m.values()].map((x) => ({ ...x })), put: async (x) => { m.set(x.id, { ...x }); }, del: async (id) => { m.delete(id); } };
  }
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((resolve, reject) => {
    const r = factory.open('cadcraft-studio-sync', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('saves', { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { dbp = null; reject(r.error); };
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('saves', mode);
      let out;
      t.oncomplete = () => resolve(out);
      t.onerror = t.onabort = () => reject(t.error);
      const r = fn(t.objectStore('saves'));
      if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
    });
  };
  return { kind: 'idb', all: () => run('readonly', (s) => s.getAll()), put: (x) => run('readwrite', (s) => { s.put(x); }), del: (id) => run('readwrite', (s) => { s.delete(id); }) };
}

export class SyncQueue {
  constructor({ client, store = queueStore(), now = () => Date.now(), onChange = () => {} } = {}) {
    this.client = client;
    this.store = store;
    this.now = now;
    this.onChange = onChange;
    this.paused = null;          // null | 'signin' | 'closed'
    this.busy = null;
    this.retryAt = 0;
  }

  async enqueue({ drawing = null, project = null, app, name, base = 0, bytes, note = '' }) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('queue: bytes must be a Uint8Array');
    if (!drawing && !(project && app && name)) throw new TypeError('queue: a drawing, or project + app + name');
    const item = { id: uuid(), saveId: uuid(), drawing, project, app: String(app || ''), name: String(name || ''), base: Number(base) || 0,
      bytes, note: String(note || '').slice(0, 200), sha256: await sha256Hex(bytes), state: 'waiting', tries: 0, error: null,
      queuedAt: this.now(), lastTry: null, result: null };
    await this.store.put(item);
    this.onChange(await this.summary());
    return item;
  }

  async list() { return (await this.store.all()).sort((a, b) => a.queuedAt - b.queuedAt); }
  async remove(id) { await this.store.del(id); this.onChange(await this.summary()); }

  async summary() {
    const all = await this.store.all();
    const n = (s) => all.filter((x) => x.state === s).length;
    return { waiting: n('waiting'), conflict: n('conflict'), failed: n('failed'), paused: this.paused, total: all.length };
  }

  /** Signed in again (or sync opened): start sending again. */
  resume() { this.paused = null; this.retryAt = 0; }

  /** Send what waits, oldest first. → {sent, kept}. One flush at a time. */
  flush() {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      let sent = 0;
      try {
        if (this.paused || this.now() < this.retryAt) return { sent, kept: (await this.summary()).waiting };
        for (const item of await this.list()) {
          if (item.state !== 'waiting') continue;
          item.tries++;
          item.lastTry = this.now();
          try {
            const r = await this.client.save({ drawing: item.drawing, project: item.project, app: item.app, name: item.name,
              base: item.base, saveId: item.saveId, bytes: item.bytes, note: item.note, sha256: item.sha256 });
            await this.store.del(item.id);
            sent++;
            this.onChange(await this.summary(), { type: 'saved', item: { ...item, bytes: undefined }, result: r });
          } catch (e) {
            const code = e && e.code ? e.code : 'error';
            if (code === 'conflict') { item.state = 'conflict'; item.error = code; item.result = e.json ? { drawing: e.json.drawing || null, current: e.json.current || null } : null; await this.store.put(item); this.onChange(await this.summary(), { type: 'conflict', item: { ...item, bytes: undefined } }); continue; }
            if (SIGN_IN_AGAIN.has(code)) { item.error = code; await this.store.put(item); this.paused = 'signin'; this.onChange(await this.summary(), { type: 'signin', code }); break; }
            if (code === 'sync_closed' || code === 'insufficient_scope') { item.error = code; await this.store.put(item); this.paused = 'closed'; this.onChange(await this.summary(), { type: 'closed', code }); break; }
            if (['offline', 'throttled', 'server', 'storage'].includes(code) || (e.status >= 500 && code !== 'over_quota')) {
              item.error = code; await this.store.put(item);
              this.retryAt = this.now() + (e.retryAfter ? e.retryAfter * 1000 : Math.min(300000, 5000 * 2 ** Math.min(6, item.tries - 1)));
              this.onChange(await this.summary(), { type: 'retry', code });
              break;
            }
            item.state = 'failed'; item.error = code; item.result = e.json ? { reason: e.json.reason || null, message: e.json.message || null } : null;
            await this.store.put(item);
            this.onChange(await this.summary(), { type: 'failed', code, item: { ...item, bytes: undefined } });
          }
        }
        return { sent, kept: (await this.summary()).waiting };
      } finally { this.busy = null; }
    })();
    return this.busy;
  }
}
