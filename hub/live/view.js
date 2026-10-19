/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — language keys and states only; window-live.js words them. */
/**
 * view.js — what Studio Live's panels show, worked out from a LiveClient's state (0.5 LV.6 / LV.7 / LV.23). DOM-free and
 * import-free: window-live.js draws it, test/test-live.mjs checks it.
 *
 *   peopleRows(client)       → [{ c, name, role, via, state, self, host, of }]   the host first, then by name; replicas left
 *                              out; an assistant's own client (LV.18, `of` = its person) right after its person
 *   joinCard(b)              → the approve card's data from a `join` message (name trimmed, device, via, kid, assistant)
 *   statusLine(status, info) → { key, vars }   the session line in the app bar (window.live.status.*)
 *   endLine(info)            → { key, vars }   what a joiner reads when the session is over
 *   canHandOver(row)         → whether the host may hand the session to that person (an editor who is here; LV.17)
 *   refuseKey(reason)        → window.live.refused.* key for a refused edit
 *   relayLine(b)             → { key, vars, linkDead }   the host's relay socket (`relay` notices, LIVE-PROTOCOL § 4.5)
 *   initials(name), colorIndex(c)   the person's initials and one of eight layer colours (no picture: guests, SI.8)
 *   LIFETIMES                → the invite link's lifetimes (spec § 9): 1h, 8h (default, decision 13.7 recommended), end
 *   editRows(client, opts)   → the edit log's rows (0.6 DC.23): [{ q, c, self, name, assistant: null | { of, ofName, self },
 *                              label, count, age: { key, vars }, gap }], newest first; opts { limit, keys, now }
 *   editRow(client, entry, now) → one such row from a LiveClient.editLog() / lastEdit() entry
 *   ageLine(at, now)         → { key, vars }   how long ago an edit was (null `at`: decided before this window was there)
 */

export const ROLES = ['editor', 'viewer'];
export const LIFETIMES = [{ key: '1h', word: 'window.live.link.1h' }, { key: '8h', word: 'window.live.link.8h', default: true }, { key: 'end', word: 'window.live.link.end' }];
export const LAYERS = ['red', 'blue', 'orange', 'magenta', 'ochre', 'green', 'violet', 'cyan'];

const clean = (s, max = 60) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function peopleRows(client) {
  const rows = [];
  const me = { c: client.c, name: clean(client.o && client.o.name), role: client.role || 'host', via: 'local', state: 'in', self: true, host: client.role === 'host' };
  if (client.c) rows.push(me);
  for (const p of client.peers.values()) {
    if (p.c === client.c || p.role === 'replica') continue;
    if (p.state === 'removed') continue;
    if (p.of && p.state === 'gone') continue;   // an assistant that left (LV.18)
    rows.push({ c: p.c, name: clean(p.name), role: p.role || 'editor', via: p.via || 'lan', state: p.state || 'in', self: false, host: p.role === 'host', of: Number(p.of) || 0 });
  }
  rows.sort((a, b) => (b.host - a.host) || (b.self - a.self) || a.name.localeCompare(b.name) || a.c - b.c);
  // Assistants (LV.18) right after their person; one whose person isn't listed goes last.
  const people = rows.filter((r) => !r.of), helpers = rows.filter((r) => r.of);
  const out = [];
  for (const r of people) out.push(r, ...helpers.filter((h) => h.of === r.c));
  out.push(...helpers.filter((h) => !people.some((r) => r.c === h.of)));
  return out;
}

export function joinCard(b) {
  return { c: b.c, name: clean(b.name) || '', device: clean(b.device, 40), via: b.via === 'relay' ? 'relay' : 'lan', kid: clean(b.kid, 16),
    assertion: typeof b.assertion === 'string' && b.assertion ? b.assertion : '', picture: b.picture instanceof Uint8Array ? b.picture : null,
    aud: typeof b.aud === 'string' ? b.aud : '',
    // LV.18: an assistant asking in — whose (its person's id and name).
    assistant: b.assistant && Number(b.assistant.of) > 0 ? { of: Number(b.assistant.of), ofName: clean(b.assistant.of_name) } : null,
    // DEC-2-5: letting this person in goes over the session's people limit ({limit, people} = with them), so the host is
    // shown what that costs before choosing.
    over: b.over && Number(b.over.limit) > 0 ? { limit: Number(b.over.limit), people: Number(b.over.people) || 0 } : null };
}

/** status: LiveClient.status; info: { role, people, reason } */
export function statusLine(status, info = {}) {
  switch (status) {
    case 'connecting': return { key: 'window.live.status.connecting', vars: {} };
    case 'handshake': return { key: 'window.live.status.connecting', vars: {} };
    case 'waiting': return { key: 'window.live.status.waiting', vars: {} };
    case 'catching-up': return { key: 'window.live.status.catchup', vars: {} };
    case 'reconnecting': return { key: 'window.live.status.reconnecting', vars: {} };
    case 'live': return info.role === 'viewer' ? { key: 'window.live.status.viewing', vars: { n: info.people || 1 } } : { key: 'window.live.status.live', vars: { n: info.people || 1 } };
    default: return { key: 'window.live.status.off', vars: {} };
  }
}

export function endLine({ status, reason, host, file }) {
  if (status === 'denied') {
    const known = ['app', 'schema', 'full', 'protocol', 'resume', 'host-taken', 'role', 'host'];
    return { key: 'window.live.end.denied.' + (known.includes(reason) ? reason : 'other'), vars: {} };
  }
  if (status === 'removed') return { key: reason === 'flood' ? 'window.live.end.flood' : 'window.live.end.removed', vars: { host, file } };
  if (status === 'failed') {
    const k = { 'wrong-code': 'wrongcode', 'unknown-code': 'unknowncode', full: 'full', 'room-closed': 'roomclosed' }[reason] || 'failed';
    return { key: 'window.live.end.' + k, vars: {} };
  }
  if (status === 'lost') return { key: reason === 'moved' ? 'window.live.end.moved' : 'window.live.end.lost', vars: { host, file } };
  return { key: host ? 'window.live.end.copy' : 'window.live.end.copy.nohost', vars: { host, file } };
}

/** LV.17: the host may hand the session to an editor who is here (not a viewer, not someone gone, not themselves). */
export function canHandOver(row) {
  return !!row && !row.self && !row.host && row.role === 'editor' && row.state !== 'gone';
}

export function refuseKey(reason) {
  const known = ['held', 'changed', 'role', 'schema', 'locked', 'invalid', 'deleted', 'flood'];
  return 'window.live.refused.' + (known.includes(reason) ? reason : 'other');
}

export function relayLine(b = {}) {
  switch (b.state) {
    case 'ready': return { key: b.license_ok === false ? 'window.live.relay.nolicense' : 'window.live.relay.ready', vars: {}, linkDead: false };
    case 'license': return { key: b.ok ? 'window.live.relay.licenseback' : 'window.live.relay.nolicense', vars: {}, linkDead: false, noNewLink: !b.ok };
    case 'reconnecting': return { key: 'window.live.relay.reconnecting', vars: {}, linkDead: false };
    case 'closing': case 'closed': case 'stopped': return { key: 'window.live.relay.closed', vars: { reason: clean(b.reason, 40) }, linkDead: true };
    default: return null;
  }
}

export function initials(name) {
  const parts = clean(name).split(' ').filter(Boolean);
  if (!parts.length) return '?';
  const a = [...parts[0]][0] || '';
  const b = parts.length > 1 ? [...parts[parts.length - 1]][0] || '' : '';
  return (a + b).toUpperCase();
}
export const colorIndex = (c) => ((Number(c) || 0) % LAYERS.length + LAYERS.length) % LAYERS.length;
export const layerFor = (c) => LAYERS[colorIndex(c)];

/** How long ago (0.6 DC.23). `at` is this window's clock when the edit arrived; null = before it joined or while away. */
export function ageLine(at, now) {
  if (typeof at !== 'number') return { key: 'window.live.edits.earlier', vars: {} };
  const s = Math.max(0, (now - at) / 1000);
  if (s < 45) return { key: 'window.live.edits.now', vars: {} };
  if (s < 3600) return { key: 'window.live.edits.min', vars: { n: Math.max(1, Math.round(s / 60)) } };
  return { key: 'window.live.edits.hour', vars: { n: Math.round(s / 3600) } };
}

/** The edit log as the panel shows it (0.6 DC.23): who (you, a person, or someone's assistant), what (the app's own label,
 *  as the author's window named it), how many things it changed, and when. Names and labels are text only. */
export function editRows(client, { limit = 6, keys = null, now = Date.now() } = {}) {
  if (!client || typeof client.editLog !== 'function') return [];
  return client.editLog({ limit, keys }).map((e) => editRow(client, e, now));
}

/** One entry of LiveClient.editLog() as a row (editRows). */
export function editRow(client, e, now = Date.now()) {
  if (e.gap) return { q: e.q, c: 0, self: false, name: '', assistant: null, label: '', count: 0, age: ageLine(null, now), gap: true };
  const self = e.c === client.c;
  let assistant = null;
  if (e.of) {
    const p = client.peers.get(e.of);
    assistant = { of: e.of, self: e.of === client.c, ofName: e.of === client.c ? '' : clean(p && p.name) };
  }
  return { q: e.q, c: e.c, self, name: clean(e.name), assistant, label: clean(e.label, 80), count: e.keys.length + (e.more || 0), age: ageLine(e.at, now), gap: false };
}
