/* SPDX-License-Identifier: Apache-2.0 */
/**
 * window-live.js — Studio Live in an app window (0.5 LV.6 invites, LV.7 joining, LV.23 invite links; spec
 * docs/STUDIO-LIVE-SPEC.md §§ 6–9 in the site repo). window.js loads it in every app window Studio opens; the app's own
 * code is unchanged. What it adds:
 *
 * - A "Live" button in the app bar (only when the app's build has an adapter: `live.js` beside its main module, exporting
 *   `createLiveAdapter({ host })` — session live-apps' files). It opens the Live panel.
 * - Hosting (Share live): host.live.start() on Studio's in-process channel, then the panel shows the short code with its
 *   QR (address + port + code, LIVE-PROTOCOL § 12) and countdown, one-time codes, New code, Stop inviting; the approve card
 *   for each person knocking (Edit / View only / Deny, "on this network" or "through the internet"); the people list
 *   (role, remove); Invite by link (license check, lifetime, one-time, New link, Stop the link); End.
 * - Handing over (LV.17): "Hand over…" on an editor in the people list (after asking) → the session moves to their Studio;
 *   this window becomes an editor there, theirs the host (codes still running go with it; our invite link ends and theirs
 *   replaces it when they can make one); joiners follow by themselves. The result is said in the panel.
 * - Joining: the hub opens this window with `?live-join=<id>` (the code, address or link waits in JoinStore); the panel
 *   shows connecting / waiting for the host / live / the end, and Leave. A window with a file open can also join from here
 *   (LV.8): someone who opened the host's own file then needs no snapshot.
 * - Assistants (LV.18): an assistant connected to this window (Studio's control channel, host.control) joins the session
 *   as its own client (host.live.assistant: role `assistant`, its own undo; the host approves it — the host's own at once)
 *   while it is connected; the window's edits made during its calls go on it. The people list shows it under its person,
 *   "Assistant (via Ana)"; the host's card asks "Ana's assistant…". Denied or removed: the assistant is disconnected here.
 *
 * Words: the packer embeds `window.live.*` from hub/lang/<locale>.json (#studio-window-lang). Names and devices people
 * typed reach the page only as text. The code's secret part and a link's fragment are shown to the host only, never put
 * in a title, a log or a URL.
 */
import { fill, choosePlural } from '../../assets/js/i18n.js';
import { parseJoin, lanUrl, socketUrl, relayJoinUrl, urlHost, inviteLink, newLinkSecret, linkSecretBytes, expiresIn, JoinStore } from './invite.js';
import { peopleRows, joinCard, statusLine, endLine, refuseKey, relayLine, initials, layerFor, canHandOver, LIFETIMES } from './view.js';
import { qrMatrix, qrSvgPath } from './qr.js';
import { decodesAsImage } from '../avatar.js';

const LS_NAME = 'cadcraft.studio.live.name';
const LS_GUEST = 'cadcraft.studio.live.guest';   // hub-join.js: '1' = signed in, but joins under another name
// The link's secret lives as long as the room (docs/LIVE-RELAY.md § Limits: "until ended" has a 7-day ceiling).
const LINK_TTL = { '1h': 3600000, '8h': 8 * 3600000, end: 7 * 24 * 3600000 };
const SVGNS = 'http://www.w3.org/2000/svg';

export async function startLive({ doc = document, win = window, desk = win.cadcraftDesktop || null, slug, words = {}, locale = 'en', channel = null, modules = null } = {}) {
  // ---- words
  const T = (key, vars = {}) => {
    const v = words[key];
    if (v === undefined) return key;
    const s = typeof v === 'string' ? v : choosePlural(v, vars.n, locale);
    return fill(s, vars);
  };

  // ---- the app's adapter and host (same module instances as the app's own: same URLs)
  const main = doc.querySelector('script[type="module"][src*="/assets/apps/"]');
  if (!main && !modules) return null;
  const folder = main ? new URL('.', new URL(main.getAttribute('src'), doc.baseURI)).href : '';
  let mod = null, hostMod = null;
  try {
    [mod, hostMod] = modules ? [modules.live, modules.host] : await Promise.all([import(folder + 'live.js'), import(folder + 'host.js')]);
  } catch { return null; }   // no adapter in this build: no Live here yet
  if (!mod || typeof mod.createLiveAdapter !== 'function' || !hostMod || typeof hostMod.getHost !== 'function') return null;
  const host = hostMod.getHost({ app: slug });
  if (!host || !host.live) return null;
  const live = desk && desk.live ? desk.live : null;
  // Tablets (TB.5): a host shares only while Studio is on screen (iPadOS suspends it; Android may stop it): said plainly.
  let onTablet = false;
  if (desk && typeof desk.info === 'function') desk.info().then((i) => { onTablet = !!(i && i.mobile); }).catch(() => {});
  // live-crypto.js beside the app (the same file host.live loads for codes and links): checks signed-in names (LV.19).
  let LC = modules && modules.crypto ? modules.crypto : null;
  const liveCrypto = async () => LC || (LC = await import(folder + 'live-crypto.js').catch(() => null));

  // ---- DOM helpers
  const el = (tag, attrs = {}, ...kids) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
    return n;
  };
  const icon = (name) => el('i', { class: 'bi bi-' + name, 'aria-hidden': 'true' });
  const btn = (label, onclick, cls = '', attrs = {}) => el('button', Object.assign({ type: 'button', class: 'sl-btn ' + cls, onclick }, attrs), label);

  if (!doc.querySelector('link[data-studio-live-css]')) {
    doc.head.append(el('link', { rel: 'stylesheet', href: new URL('./live.css', import.meta.url).href, 'data-studio-live-css': true }));
  }

  // ---- state
  const st = {
    client: null, mode: 'idle',           // idle | host | join
    code: null, codeNote: '', oneTime: false, inviting: true,
    cards: new Map(),                      // c → join card (waiting for the host)
    who: new Map(),                        // c → { name (signed in, checked), picture (blob: URL, checked) } — LV.19 / SI.8
    link: null,                            // { room, secret, url, lifetime, oneTime, relay: notice, license_ok }
    linkBusy: false, linkMsg: '', linkMsgKind: 'info', noNewLink: false,
    linkCheck: null,                       // may this host make invite links? { state: checking|ok|no|signin|off|unknown, msg }
    lan: null,                             // { addrs, port } of this window's session
    quiet: new Set(),                      // kids we stopped ourselves (New code, New link): their code-gone says nothing
    joinRec: null, endInfo: null, msg: '', msgKind: 'info',
    file: '', adapter: null,
    assistants: new Map(),                 // LV.18: control session id → its LiveClient (null: asking, or none to be had)
  };
  let timer = null;
  // The open file's name from the window title ("Plan.dwg — CadCraft"); a title without a file ("CadCraft dev") → "this file".
  const fileName = () => { const n = (doc.title || '').replace(/\s+[—|]\s+.*$/, '').trim(); return /\.[a-z0-9]{2,5}$/i.test(n) ? n : T('window.live.file.untitled'); };

  // ---- the app bar button + the panel
  const bar = doc.querySelector('.app-bar');
  const button = el('button', { type: 'button', class: 'app-bar-btn app-bar-live', 'data-studio-live': true, 'aria-expanded': 'false', 'aria-controls': 'studio-live-panel', title: T('window.live.button.title') },
    icon('people'), el('span', { class: 'app-bar-btn-label', 'data-live-label': true }, T('window.live.button')), el('span', { class: 'sl-count', 'data-live-count': true, hidden: true }));
  if (bar) { const before = bar.querySelector('[data-studio-hub]') || bar.querySelector('.app-bar-help, [data-help-open]'); if (before) bar.insertBefore(button, before); else bar.append(button); }
  const panel = el('aside', { class: 'sl-panel', id: 'studio-live-panel', role: 'dialog', 'aria-labelledby': 'studio-live-h', 'data-live-panel': true, hidden: true });
  const status = el('p', { class: 'sl-sr', role: 'status', 'aria-live': 'polite' });
  doc.body.append(panel, status);
  const announce = (m) => { status.textContent = ''; setTimeout(() => { status.textContent = m; }, 30); };
  const open = (on) => {
    panel.hidden = !on;
    button.setAttribute('aria-expanded', String(on));
    if (on) { render(); const f = panel.querySelector('[data-autofocus]') || panel.querySelector('button, input, select'); if (f) f.focus(); }
  };
  button.addEventListener('click', () => open(panel.hidden));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); open(false); button.focus(); } });
  // Keys typed in the panel never reach the app's own shortcuts or command line.
  for (const t of ['keydown', 'keyup', 'keypress']) panel.addEventListener(t, (e) => e.stopPropagation());

  const myName = () => { try { return (win.localStorage.getItem(LS_NAME) || '').slice(0, 60); } catch { return ''; } };
  const setName = (v) => { try { win.localStorage.setItem(LS_NAME, String(v).trim().slice(0, 60)); } catch { /* private */ } };
  let accountName = '';
  const readAccount = () => desk.account.status().then((a) => {
    accountName = a && a.state === 'signed_in' && a.user ? String(a.user.name || '').slice(0, 60) : '';
    st.linkCheck = null;   // signed in or out: whether invite links are allowed is asked again
    render();
  }).catch(() => {});
  if (desk && desk.account && typeof desk.account.status === 'function') {
    readAccount();
    if (typeof desk.account.onChange === 'function') desk.account.onChange(readAccount);
  }
  // Signed in, you are your account (owner, 2026-10-14), unless you chose another name (the hub's Join card, LS_GUEST).
  const guestChosen = () => { try { return win.localStorage.getItem(LS_GUEST) === '1'; } catch { return false; } };
  const nameNow = () => (accountName && !guestChosen() ? accountName : myName() || accountName);
  const deviceName = () => { const p = (win.navigator && (win.navigator.userAgentData?.platform || win.navigator.platform)) || ''; return String(p).slice(0, 40); };

  // ---- counting people for the button
  const updateButton = () => {
    const c = st.client;
    const cnt = button.querySelector('[data-live-count]');
    const label = button.querySelector('[data-live-label]');
    button.classList.toggle('is-live', !!c && !c.final);
    if (!c || c.final) { cnt.hidden = true; label.textContent = T('window.live.button'); return; }
    const people = peopleRows(c).filter((r) => r.state !== 'gone' && !r.of).length;
    const waiting = st.cards.size;
    const line = statusLine(c.status, { role: c.role, people });
    label.textContent = T(line.key, line.vars);
    cnt.hidden = !waiting;
    cnt.textContent = waiting ? String(waiting) : '';
    if (waiting) cnt.setAttribute('aria-label', T('window.live.waiting.count', { n: waiting }));
  };

  // ---- hosting
  async function share() {
    const name = nameNow();
    if (!name) { st.msg = T('window.live.name.needed'); st.msgKind = 'error'; render(); return; }
    let adapter = null;
    try { adapter = mod.createLiveAdapter({ host }); } catch { adapter = null; }
    if (!adapter) { st.msg = T('window.live.share.nodoc'); st.msgKind = 'error'; render(); return; }
    st.msg = ''; st.mode = 'host'; st.adapter = adapter; st.file = fileName();
    let c;
    try { c = await host.live.start({ adapter, name, role: 'host', roomUrl: relayJoinUrl, newRoom }); }
    catch (e) { st.mode = 'idle'; st.msg = T('window.live.share.failed'); st.msgKind = 'error'; render(); return; }
    attach(c);
    let first = true;
    c.on('welcome', () => {
      if (!first || c.relocated) return;   // a rejoin, or (after handing over) the new host's session: nothing to set up again
      first = false;
      try { const h = typeof mod.liveFileHash === 'function' ? mod.liveFileHash() : null; if (h) c.savedFile(String(h)); } catch { /* no hash: joiners get a snapshot */ }
      if (st.inviting) c.invite({ oneTime: st.oneTime });
      lanInfo();
    });
    hostHooks(c);
    render();
  }

  /** What a host's window listens to: codes, knocks, the relay. Also for a window that becomes the host by a handoff. */
  function hostHooks(c) {
    if (c.__studioHost) return;
    c.__studioHost = true;
    c.on('code', (b) => {
      if (st.mode !== 'host') return;
      if (st.code && st.code.tag !== b.tag && live && live.unadvertise) live.unadvertise(st.code.tag).catch(() => {});
      // `expires` is the code's lifetime in ms from now (session.rs make_code); a time since 1970 is taken as it is.
      const ex = Number(b.expires) || 0;
      st.code = { code: String(b.code || ''), tag: String(b.tag || ''), expires: ex > 1e12 ? ex : Date.now() + ex, oneTime: !!b.one_time };
      st.codeNote = b.reason === 'wrong-tries' ? T('window.live.code.rotated') : b.carried ? T('window.live.code.carried') : '';
      if (b.reason === 'wrong-tries') announce(st.codeNote);
      if (live && live.advertise) live.advertise(st.code.tag, { app: slug }).catch(() => {});
      render();
    });
    c.on('code-gone', (b) => {
      if (st.mode !== 'host') return;
      if (b.reason === 'stopped' && st.quiet.delete(b.kid)) return;
      if (st.link && b.kid === st.link.room) { st.link = null; st.linkMsg = T('window.live.link.gone.' + (['used', 'expired', 'stopped'].includes(b.reason) ? b.reason : 'other')); render(); return; }
      if (!st.code || (b.kid && b.kid !== st.code.tag)) return;
      if (live && live.unadvertise) live.unadvertise(st.code.tag).catch(() => {});
      st.code = null;
      st.codeNote = T('window.live.code.gone.' + (['used', 'expired', 'stopped', 'wrong-tries'].includes(b.reason) ? b.reason : 'other'));
      render();
    });
    c.on('join', (b) => {
      if (st.mode !== 'host') return;
      const card = joinCard(b);
      st.cards.set(card.c, card);
      checkSignedIn(card).then(() => render());
      announce(card.assistant ? T('window.live.assistant.knock', { name: card.assistant.ofName || T('window.live.noname') }) : T('window.live.knock', { name: card.name || T('window.live.noname') }));
      if (panel.hidden) open(true); else render();
      updateButton();
    });
    // The host's relay socket (LIVE-PROTOCOL § 4.5): live-client.js passes unknown types by; read them on the way in.
    const orig = c.message.bind(c);
    c.message = (m) => { if (m && m.t === 'relay') onRelay(m.b || {}); return orig(m); };
  }

  async function lanInfo() {
    if (!live || typeof live.session !== 'function') { st.lan = null; render(); return; }
    try { const s = await live.session(); st.lan = s && s.running && s.port ? { addrs: (s.addrs || []).map(String).filter((x) => urlHost(x)), port: Number(s.port) } : null; }
    catch { st.lan = null; }
    render();
  }

  function newCode() {
    const c = st.client;
    if (!c || c.final) return;
    if (st.code) { st.quiet.add(st.code.tag); c.stopInviting(st.code.tag); if (live && live.unadvertise) live.unadvertise(st.code.tag).catch(() => {}); }
    st.inviting = true; st.codeNote = '';
    c.invite({ oneTime: st.oneTime });
  }
  function stopInviting() {
    const c = st.client;
    if (!c) return;
    if (st.code) { st.quiet.add(st.code.tag); c.stopInviting(st.code.tag); if (live && live.unadvertise) live.unadvertise(st.code.tag).catch(() => {}); }
    st.code = null; st.inviting = false; st.codeNote = T('window.live.code.stopped');
    render();
  }

  // ---- invite links (LV.23; the relay: session live-relay, docs/LIVE-RELAY.md)
  const site = (method, path, body) => desk.cloud.request({ method, path, body: body ? new TextEncoder().encode(JSON.stringify(body)) : undefined, contentType: body ? 'application/json' : undefined })
    .then((r) => { let j = null; try { j = r.json(); } catch { j = null; } return { status: r.status, json: j }; });
  // Whether this host may make invite links, asked once when the section first shows (and again after signing in or
  // out), so a host without a commercial license sees the code and a plain sentence, not a button that then refuses.
  async function checkLink() {
    st.linkCheck = { state: 'checking' };
    if (!desk || !desk.cloud || !live || typeof live.relay !== 'function') {
      st.linkCheck = { state: 'off', msg: T(desk && desk.cloud ? 'window.live.link.noshell' : 'window.live.link.signin.first') };
      return render();
    }
    let r;
    try { r = await site('GET', '/api/v1/live/check?app=' + encodeURIComponent(slug)); }
    catch { st.linkCheck = { state: 'unknown' }; return render(); }   // offline: keep the button; making a link says why
    const ck = r.json && r.json.data ? r.json.data : r.json || {};
    if (r.status === 401) st.linkCheck = { state: 'signin', msg: T('window.live.link.signin.first') };
    else if (r.status >= 400 || !ck.allowed) st.linkCheck = { state: 'no', msg: String(ck.message || (r.json && r.json.message) || T('window.live.link.refused')) };
    else st.linkCheck = { state: 'ok' };
    render();
  }

  async function makeLink(lifetime, oneTime) {
    if (st.linkBusy || !st.client || st.client.final) return;
    st.linkBusy = true; st.linkMsg = T('window.live.link.making'); st.linkMsgKind = 'info'; render();
    const done = (msg, kind = 'error') => { st.linkBusy = false; st.linkMsg = msg; st.linkMsgKind = kind; render(); };
    if (!desk || !desk.cloud || !live || typeof live.relay !== 'function') return done(T(desk && desk.cloud ? 'window.live.link.noshell' : 'window.live.link.signin'));
    let r;
    try { r = await site('GET', '/api/v1/live/check?app=' + encodeURIComponent(slug)); } catch { return done(T('window.live.link.offline')); }
    if (r.status === 401) return done(T('window.live.link.signin'));
    const ck = r.json && r.json.data ? r.json.data : r.json || {};
    if (r.status >= 400 || !ck.allowed) {
      // The site's own words, as they are ("Invite links need a commercial license for CadCraft. Sessions on your own network are free.").
      return done(String(ck.message || (r.json && r.json.message) || T('window.live.link.refused')));
    }
    try { r = await site('POST', '/api/v1/live/rooms', { app: slug, lifetime }); } catch { return done(T('window.live.link.offline')); }
    const data = r.json && r.json.data ? r.json.data : {};
    if (r.status !== 201 || !data.room || !data.host_ticket) return done(String((r.json && r.json.message) || T('window.live.link.refused')));
    const room = data.room;
    const secret = newLinkSecret();
    const ttl = LINK_TTL[lifetime] || LINK_TTL['8h'];
    st.client.addLink(room.room, linkSecretBytes(secret), room.room, { oneTime, ttl });
    try { await live.relay(room.relay_url, data.host_ticket); } catch { st.client.stopInviting(room.room); return done(T('window.live.link.relayfailed')); }
    if (live.advertise) live.advertise({ room: room.room }, { app: slug }).catch(() => {});   // LV.26: same network first
    st.link = { room: room.room, secret, url: inviteLink(room.room, secret), lifetime, oneTime, ttl, expires: room.expires_at || null };
    st.linkBusy = false; st.linkMsg = ''; st.noNewLink = false;
    render();
  }
  /**
   * LV.17: this window is taking a session over and people came through the relay: open a room of our own (the old host's
   * room was theirs and ends with them), so `moved` can send those people here. They come back with their rejoin tickets;
   * the new link (with a new secret) is for anyone joining later. No sign-in, no licence, a store build: null, and they are
   * told the session moved out of reach (window.live.end.moved).
   */
  async function newRoom() {
    if (!desk || !desk.cloud || !live || typeof live.relay !== 'function') return null;
    const r1 = await site('GET', '/api/v1/live/check?app=' + encodeURIComponent(slug)).catch(() => null);
    const ck = r1 && r1.json ? (r1.json.data || r1.json) : null;
    if (!r1 || r1.status !== 200 || !ck || !ck.allowed) return null;
    const r2 = await site('POST', '/api/v1/live/rooms', { app: slug, lifetime: '8h' }).catch(() => null);
    const data = r2 && r2.json && r2.json.data ? r2.json.data : null;
    if (!r2 || r2.status !== 201 || !data || !data.room || !data.host_ticket) return null;
    const room = data.room;
    try { await live.relay(room.relay_url, data.host_ticket); } catch { return null; }
    const secret = newLinkSecret();
    st.pendingLink = { room: room.room, secret, url: inviteLink(room.room, secret), lifetime: '8h', oneTime: false, ttl: LINK_TTL['8h'], expires: room.expires_at || null };
    return room.room;
  }

  /** LV.17: hand the session over to someone in it (after asking). The result comes back as `moved` or `handover-off`. */
  async function handOver(row) {
    const c = st.client;
    if (!c || c.final || st.mode !== 'host') return;
    const name = row.name || T('window.live.noname');
    if (!(await confirm(T('window.live.handover.ask', { name }), T('window.live.handover.yes')))) return;
    st.handover = { c: row.c, name };
    st.msg = T('window.live.handover.sending', { name }); st.msgKind = 'info';
    c.handover(row.c);
    render();
  }

  /** New link: the same room, a new secret; the old link stops working at once. */
  function renewLink() {
    const l = st.link, c = st.client;
    if (!l || !c || st.noNewLink) return;
    st.quiet.add(l.room);
    c.stopInviting(l.room);
    const secret = newLinkSecret();
    c.addLink(l.room, linkSecretBytes(secret), l.room, { oneTime: l.oneTime, ttl: l.ttl });
    st.link = Object.assign({}, l, { secret, url: inviteLink(l.room, secret) });
    st.linkMsg = T('window.live.link.renewed'); st.linkMsgKind = 'info';
    render();
  }
  async function stopLink() {
    const l = st.link;
    if (!l) return;
    st.link = null;
    if (st.client) { st.quiet.add(l.room); st.client.stopInviting(l.room); }
    if (live && live.relayStop) live.relayStop().catch(() => {});
    if (live && live.unadvertise) live.unadvertise({ room: l.room }).catch(() => {});
    if (desk && desk.cloud) site('POST', '/api/v1/live/end', { room: l.room }).catch(() => {});
    st.linkMsg = T('window.live.link.stopped'); st.linkMsgKind = 'info';
    render();
  }
  function onRelay(b) {
    const line = relayLine(b);
    if (!line) return;
    if (line.noNewLink !== undefined) st.noNewLink = !!line.noNewLink;
    if (b.state === 'ready' && b.license_ok === false) st.noNewLink = true;
    if (line.linkDead && st.link) { st.link = null; }
    st.linkMsg = T(line.key, line.vars); st.linkMsgKind = line.linkDead || st.noNewLink ? 'warn' : 'info';
    render();
  }

  // ---- joining (the hub's Join card opened this window)
  async function join(rec) {
    st.joinRec = rec;
    const name = rec.name || nameNow();
    let adapter = null;
    try { adapter = mod.createLiveAdapter({ host, joining: true }); } catch { adapter = null; }
    if (!adapter) { st.mode = 'join'; st.endInfo = { key: 'window.live.end.noadapter', vars: {} }; open(true); return; }
    st.mode = 'join'; st.adapter = adapter;
    const opts = { adapter, name, device: deviceName(), roomUrl: relayJoinUrl, newRoom };
    // LV.8: the file open here, if the app offers its hash (opened and unchanged since): the host's own file → no snapshot.
    const hash = fileHash();
    if (hash) opts.hash = hash;
    if (rec.guest) opts.signIn = async () => null;   // joining under another name: the host sees it as typed, unchecked
    if (rec.kind === 'link') { opts.link = { room: rec.room, secret: linkSecretBytes(rec.secret) }; opts.url = rec.url || relayJoinUrl(rec.room); }
    else { opts.code = rec.code; if (!rec.page) opts.url = socketUrl(rec); }   // a LAN page: host.live uses the page's own host
    let c;
    try { c = await host.live.join(opts); }
    catch { st.endInfo = { key: 'window.live.end.failed', vars: {} }; open(true); return; }
    attach(c);
    c.on('ended', () => render());
    open(true);
  }

  /** The hash of the file open in this window (the app's optional `liveFileHash()`), or ''. */
  function fileHash() {
    try { const h = typeof mod.liveFileHash === 'function' ? mod.liveFileHash() : ''; return typeof h === 'string' && /^[0-9a-f]{16,128}$/.test(h) ? h : ''; } catch { return ''; }
  }

  /**
   * LV.8: join from this window, with the drawing open here — someone who opened the same file as the host joins without a
   * snapshot (only the edits since travel). Offered only while the app says the file is unchanged since it was opened, so
   * nothing is lost if the host's drawing turns out to be another one (it then replaces this one here, as a join does).
   * The same codes, addresses and links as the hub's Join card; a code is looked up on this network.
   */
  async function joinHere(text) {
    const r = parseJoin(text);
    const say = (key, kind = 'error') => { st.msg = T(key); st.msgKind = kind; render(); };
    if (r.kind === 'bad') return say('window.live.here.bad');
    const name = nameNow();
    if (!name) return say('window.live.name.needed');
    const find = async (what) => {
      if (!live || typeof live.browse !== 'function') return null;
      try { const f = await live.browse(what, 1500); return (Array.isArray(f) && f.find((x) => x && urlHost(x.addr))) || null; } catch { return null; }
    };
    let rec = null;
    if (r.kind === 'link') {
      say('window.live.here.looking', 'info');
      const near = await find({ room: r.room });
      rec = near ? { kind: 'link', room: r.room, secret: r.secret, url: socketUrl({ host: near.addr, port: near.port }) } : { kind: 'link', room: r.room, secret: r.secret, url: relayJoinUrl(r.room) };
    } else if (!live) {
      return say('window.live.here.nostudio');
    } else if (r.kind === 'code') {
      say('window.live.here.looking', 'info');
      const near = await find(r.tag);
      if (!near) return say('window.live.here.notfound');
      if (near.app && near.app !== slug) return say('window.live.here.otherapp');
      rec = { kind: 'code', code: r.code, host: near.addr, port: near.port };
    } else if (r.kind === 'lan') {
      if (r.slug !== slug) return say('window.live.here.otherapp');
      rec = { kind: 'code', code: r.code, host: r.host, port: r.port };
    } else if (r.kind === 'address') {
      if (!r.code) return say('window.live.here.needcode');
      rec = { kind: 'code', code: r.code, host: r.host, port: r.port };
    }
    if (!rec) return say('window.live.here.bad');
    st.msg = ''; st.endInfo = null;
    rec.name = name;
    return join(rec);
  }

  function sectionHere() {
    if (!fileHash()) return null;
    const inp = el('input', { class: 'sl-input', id: 'sl-here', autocomplete: 'off', spellcheck: 'false', 'data-live-here-input': true });
    const form = el('form', { class: 'sl-sec', 'data-live-here': true },
      el('h3', { class: 'sl-h3' }, icon('box-arrow-in-right'), ' ', T('window.live.here.title')),
      el('p', { class: 'sl-hint' }, T('window.live.here.hint')),
      el('label', { class: 'sl-field', for: 'sl-here' }, el('span', {}, T('window.live.here.label')), inp),
      el('div', { class: 'sl-row' }, el('button', { type: 'submit', class: 'sl-btn sl-btn-line', 'data-live-here-join': true }, T('window.live.here.join'))));
    form.addEventListener('submit', (e) => { e.preventDefault(); joinHere(inp.value); });
    return form;
  }

  // ---- one client, whichever side
  function attach(c) {
    st.client = c;
    if (c.__studioPanel) return;     // host.live.on already handed it over
    c.__studioPanel = true;
    let apart = null;
    c.on('status', ({ status: s, reason }) => {
      // A joiner who never got in and keeps failing to connect: say what usually causes it (spec § 8).
      if (st.mode === 'join' && !c.everWelcomed && s === 'reconnecting' && !apart) {
        apart = win.setTimeout(() => { if (!c.everWelcomed && !c.final) { st.msg = T(st.joinRec && st.joinRec.kind === 'link' ? 'window.live.unreachable.link' : 'window.live.apart'); st.msgKind = 'warn'; render(); } }, 6000);
      }
      if (c.everWelcomed && apart) { win.clearTimeout(apart); apart = null; if (st.msg === T('window.live.apart')) st.msg = ''; }
      if (c.final) finish(c, s, reason);
      else if (s === 'live' && st.mode === 'join') announce(T('window.live.joined', { host: c.hostName() || T('window.live.noname') }));
      render(); updateButton();
    });
    c.on('peer', (p) => {
      if (p.state === 'in' || p.state === 'gone' || p.state === 'removed') st.cards.delete(p.c);
      if (p.state === 'in' && st.mode === 'host') {
        const of = p.of ? c.peers.get(p.of) : null;
        announce(p.of ? T('window.live.assistant.in', { name: (of && of.name) || (p.of === c.c ? c.o.name : '') || T('window.live.noname') }) : T('window.live.peer.in', { name: p.name || T('window.live.noname') }));
      }
      render(); updateButton();
    });
    c.on('refused', (x) => { st.msg = T(refuseKey(x && x.reason), { name: (x && x.byName) || T('window.live.noname') }); st.msgKind = 'warn'; announce(st.msg); render(); });
    c.on('undo-skipped', (x) => { st.msg = T('window.live.undo.skipped', { name: (x && x.byName) || T('window.live.noname') }); st.msgKind = 'info'; render(); });
    c.on('warn', () => { st.msg = T('window.live.flood'); st.msgKind = 'warn'; render(); });
    c.on('saved', () => { if (st.mode === 'join') { st.msg = T('window.live.saved', { host: c.hostName() || T('window.live.noname') }); st.msgKind = 'info'; render(); } });
    c.on('locks', () => render());
    // LV.17 host handoff.
    c.on('handover', (b) => { st.handoverFrom = b && b.from; });
    c.on('handover-off', (b) => {
      if (st.mode !== 'host') return;
      const name = (st.handover && st.handover.name) || T('window.live.noname');
      st.handover = null;
      st.msg = T('window.live.handover.off.' + (['unknown', 'gone', 'start'].includes(b && b.reason) ? b.reason : 'other'), { name });
      st.msgKind = 'warn'; announce(st.msg); render();
    });
    c.on('moved', (m) => {
      const who = (id) => { const p = c.peers.get(id); return (p && p.name) || T('window.live.noname'); };
      if (m.self) {
        // This window is the host now: its Studio runs the session from the old host's state.
        st.mode = 'host'; st.cards.clear(); st.inviting = false; st.code = null;
        st.msg = T('window.live.handover.youhost', { name: who(st.handoverFrom) });
        hostHooks(c);
        c.on('welcome', () => {
          lanInfo();
          const l = st.pendingLink;
          if (!l) return;
          st.pendingLink = null;
          c.addLink(l.room, linkSecretBytes(l.secret), l.room, { oneTime: false, ttl: l.ttl });
          st.link = l;
          if (live && live.advertise) live.advertise({ room: l.room }, { app: slug }).catch(() => {});
          render();
        });
      } else if (st.mode === 'host') {
        // We handed it over: an editor from here on, in the new host's session.
        const name = (st.handover && st.handover.name) || who(m.host);
        st.handover = null; st.mode = 'join'; st.cards.clear();
        if (st.code && live && live.unadvertise) live.unadvertise(st.code.tag).catch(() => {});
        st.code = null;
        // The room was ours: it ends, a moment later, so `moved` reaches the people who came through it first.
        if (st.link) { const l = st.link; win.setTimeout(() => { if (st.link === l) stopLink(); }, 3000); }
        st.msg = T('window.live.handover.moved', { name });
      } else {
        st.msg = T('window.live.moved.follow', { name: who(m.host) });
      }
      st.movedTo = m.self ? '' : who(m.host);
      st.msgKind = 'info'; announce(st.msg); render();
    });
    // LV.18: an assistant connected to this window (Studio's control channel, host.control) joins the session as its own
    // client while it is connected (assistantClients below); the window's steps during its calls go on that client. Where
    // the session gives it no client (an older host), it works through this person's connection, as before: the presence
    // says so, and everyone's people list shows "Assistant (via <name>)".
    const setP = c.setPresence.bind(c);
    c.setPresence = (p) => { const { assistant, ...rest } = p || {}; return setP(Object.assign(rest, assistantMark())); };   // eslint-disable-line no-unused-vars
    c.route = () => {
      const id = host.control && host.control.acting;
      const a = id ? st.assistants.get(id) : null;
      return a && !a.final ? a : null;
    };
    c.on('welcome', () => assistantClients());
    if (host.control && typeof host.control.on === 'function' && !st.controlHooked) {
      st.controlHooked = true;
      host.control.on('change', () => { const cl = st.client; if (cl && !cl.final) { cl.setPresence(cl.lastPresence || {}); assistantClients(); render(); } });
      host.control.on('disconnect', ({ id } = {}) => assistantGone(id));
    }
    // Once a second while the panel is open: the code's countdown, and the people list when someone's assistant came or went
    // (presence reaches only the adapter's drawPresence, so it is compared here).
    if (!timer) timer = win.setInterval(() => {
      if (panel.hidden) return;
      if (st.code) renderCode();
      if (st.client && !st.client.final && presenceKey(st.client) !== st.lastPeoplePresence) render();
    }, 1000);
    updateButton();
  }

  function finish(c, s, reason) {
    st.msg = '';
    for (const a of st.assistants.values()) if (a && !a.final) a.leave();   // LV.18: an assistant's client goes with the session
    st.assistants.clear();
    if (st.mode === 'host') {
      if (st.code && live && live.unadvertise) live.unadvertise(st.code.tag).catch(() => {});
      if (st.link) stopLink();
      st.code = null; st.cards.clear();
      st.endInfo = { key: 'window.live.end.hosted', vars: {} };
    } else {
      st.endInfo = endLine({ status: s, reason, host: (reason === 'moved' && st.movedTo) || c.hostName(), file: fileName() });
    }
    if (timer) { win.clearInterval(timer); timer = null; }
    if (panel.hidden) open(true);
  }

  async function end() {
    const c = st.client;
    if (!c || c.final) return;
    if (!(await confirm(T('window.live.end.ask'), T('window.live.end.yes')))) return;
    if (st.link) await stopLink();
    try { await c.whenSettled(3000); } catch { /* end anyway: everyone keeps a copy */ }
    c.end();
  }
  function leave() {
    const c = st.client;
    if (c && !c.final) c.leave();
  }

  /** The small in-panel question (no window.confirm in the apps). */
  function confirm(text, yes) {
    return new Promise((resolve) => {
      const box = el('div', { class: 'sl-ask', role: 'alertdialog', 'aria-label': text },
        el('p', {}, text),
        el('div', { class: 'sl-row' },
          btn(yes, () => { box.remove(); resolve(true); }, 'sl-btn-danger', { 'data-ask-yes': true }),
          btn(T('window.live.cancel'), () => { box.remove(); resolve(false); }, 'sl-btn-line', { 'data-ask-no': true })));
      panel.append(box);
      box.querySelector('[data-ask-no]').focus();
    });
  }

  /**
   * LV.19 / SI.8: a joiner's signed-in name. The assertion must verify against getcadcraft.com's pinned key for THIS
   * connection (`aud`, from the session server); only then is the name ticked, and a picture shown — and only if its sha256 is
   * the one the assertion names and it decodes as an image. Guests, unsigned people and anything that fails: initials.
   */
  async function checkSignedIn(card) {
    if (!card.assertion || !card.aud) return;
    const C = await liveCrypto();
    if (!C || typeof C.verifyAssertion !== 'function') return;
    const r = C.verifyAssertion(card.assertion, { aud: card.aud });
    if (!r || !r.ok) return;
    const who = { name: String(r.name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60), picture: null };
    if (card.picture && r.pic && C.pictureMatches(card.picture, r.pic) && await decodesAsImage(card.picture)) {
      who.picture = URL.createObjectURL(new Blob([card.picture], { type: 'image/webp' }));
    }
    st.who.set(card.c, who);
  }

  // ---- drawing the panel
  function avatar(c, name) {
    const w = st.who.get(c);
    if (w && w.picture) return el('img', { class: 'sl-avatar', src: w.picture, alt: '', 'data-live-picture': c });
    return el('span', { class: 'sl-avatar layer-' + layerFor(c), 'aria-hidden': 'true' }, initials(name));
  }
  function tick(c) {
    const w = st.who.get(c);
    return w ? el('span', { class: 'sl-tick', title: T('window.live.verified', { name: w.name }), 'data-live-tick': c }, icon('patch-check-fill'), el('span', { class: 'sl-sr' }, T('window.live.verified', { name: w.name }))) : null;
  }
  function renderCode() {
    const box = panel.querySelector('[data-live-countdown]');
    if (!box || !st.code) return;
    const e = expiresIn(st.code.expires);
    box.textContent = e.over ? T('window.live.code.expired') : T('window.live.code.expires', { time: e.minutes + ':' + String(e.seconds).padStart(2, '0') });
  }
  function qrFigure(text) {
    let q;
    try { q = qrMatrix(text, { ecl: 'M' }); } catch { return null; }
    const { d, size } = qrSvgPath(q, 4);
    const svg = doc.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('class', 'sl-qr');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', T('window.live.qr.label'));
    svg.setAttribute('shape-rendering', 'crispEdges');
    const bg = doc.createElementNS(SVGNS, 'rect');
    bg.setAttribute('width', size); bg.setAttribute('height', size); bg.setAttribute('fill', '#fff');
    const p = doc.createElementNS(SVGNS, 'path');
    p.setAttribute('d', d); p.setAttribute('fill', '#000');
    svg.append(bg, p);
    return svg;
  }

  function sectionCode() {
    const kids = [el('h3', { class: 'sl-h3' }, icon('wifi'), ' ', T('window.live.code.title'))];
    if (st.code) {
      const lan = st.lan && st.lan.addrs.length ? st.lan : null;
      const url = lan ? lanUrl({ host: lan.addrs[0], port: lan.port, slug, code: st.code.code }) : null;
      kids.push(el('div', { class: 'sl-codebox' },
        el('div', {},
          el('p', { class: 'sl-code', 'data-live-code': true, 'aria-label': T('window.live.code.label', { code: st.code.code.split('').join(' ') }) }, st.code.code),
          el('p', { class: 'sl-muted', 'data-live-countdown': true }),
          st.code.oneTime ? el('p', { class: 'sl-muted' }, T('window.live.code.onetime.on')) : null,
          lan ? el('p', { class: 'sl-muted sl-addr' }, T('window.live.code.address', { address: urlHost(lan.addrs[0]) + ':' + lan.port })) : el('p', { class: 'sl-muted' }, T('window.live.code.noaddress'))),
        url ? qrFigure(url) : null));
      kids.push(el('p', { class: 'sl-hint' }, T('window.live.code.how')));
    } else {
      kids.push(el('p', { class: 'sl-muted', 'data-live-nocode': true }, st.codeNote || T('window.live.code.none')));
    }
    if (st.code && st.codeNote) kids.push(el('p', { class: 'sl-note', role: 'alert' }, st.codeNote));
    const one = el('input', { type: 'checkbox', id: 'sl-onetime', checked: st.oneTime, onchange: (e) => { st.oneTime = e.target.checked; } });
    kids.push(el('label', { class: 'sl-check', for: 'sl-onetime' }, one, ' ', T('window.live.code.onetime')));
    kids.push(el('div', { class: 'sl-row' },
      btn(T('window.live.code.new'), newCode, 'sl-btn-line', { 'data-live-newcode': true }),
      st.code ? btn(T('window.live.code.stop'), stopInviting, 'sl-btn-line', { 'data-live-stopcode': true }) : null));
    return el('section', { class: 'sl-sec' }, kids);
  }

  function sectionLink() {
    const kids = [el('h3', { class: 'sl-h3' }, icon('globe'), ' ', T('window.live.link.title'))];
    // Store builds sell nothing and have no sign-in (0.4 decision 11 open): same-network sessions only, no purchase link.
    if (desk && !desk.account) {
      kids.push(el('p', { class: 'sl-hint', 'data-live-link-store': true }, T('window.live.link.store')));
      return el('section', { class: 'sl-sec' }, kids);
    }
    if (st.link) {
      const inp = el('input', { class: 'sl-input sl-linkurl', readonly: true, value: st.link.url, 'aria-label': T('window.live.link.label'), 'data-live-link': true, onfocus: (e) => e.target.select() });
      kids.push(inp, el('div', { class: 'sl-row' },
        btn(T('window.live.link.copy'), async () => {
          try { await win.navigator.clipboard.writeText(st.link.url); st.linkMsg = T('window.live.link.copied'); }
          catch { inp.select(); st.linkMsg = T('window.live.link.copyhand'); }
          st.linkMsgKind = 'info'; render();
        }, '', { 'data-live-copylink': true }),
        btn(T('window.live.link.new'), renewLink, 'sl-btn-line', { disabled: st.noNewLink, 'data-live-newlink': true }),
        btn(T('window.live.link.stop'), stopLink, 'sl-btn-line', { 'data-live-stoplink': true })),
      el('p', { class: 'sl-hint' }, T(st.link.oneTime ? 'window.live.link.how.onetime' : 'window.live.link.how', { lifetime: T((LIFETIMES.find((x) => x.key === st.link.lifetime) || LIFETIMES[1]).word) })));
    } else if (!st.linkCheck || st.linkCheck.state === 'checking') {
      if (!st.linkCheck) checkLink();
      kids.push(el('p', { class: 'sl-hint', 'data-live-linkcheck': 'checking' }, T('window.live.link.checking')));
    } else if (['no', 'signin', 'off'].includes(st.linkCheck.state)) {
      // Free on your network, the commercial license over the internet: the code above is how this host invites.
      kids.push(el('p', { class: 'sl-hint', 'data-live-linkcheck': st.linkCheck.state }, st.linkCheck.msg),
        el('p', { class: 'sl-hint' }, T('window.live.link.usecode')));
      if (st.linkCheck.state === 'no') kids.push(el('p', {}, el('a', { href: 'https://getcadcraft.com/pricing', target: '_blank', rel: 'noopener', 'data-live-pricing': true }, T('window.live.link.pricing'))));
    } else {
      const sel = el('select', { class: 'sl-select', id: 'sl-lifetime', 'data-live-lifetime': true },
        ...LIFETIMES.map((x) => el('option', { value: x.key, selected: !!x.default }, T(x.word))));
      const one = el('input', { type: 'checkbox', id: 'sl-link-onetime' });
      kids.push(el('p', { class: 'sl-hint' }, T('window.live.link.pitch')),
        el('label', { class: 'sl-field', for: 'sl-lifetime' }, el('span', {}, T('window.live.link.lifetime')), sel),
        el('label', { class: 'sl-check', for: 'sl-link-onetime' }, one, ' ', T('window.live.link.onetime')),
        el('div', { class: 'sl-row' }, btn(T('window.live.link.make'), () => makeLink(sel.value, one.checked), '', { disabled: st.linkBusy || st.noNewLink, 'data-live-makelink': true })));
    }
    if (st.linkMsg) kids.push(el('p', { class: 'sl-note is-' + st.linkMsgKind, role: 'status', 'data-live-linkmsg': true }, st.linkMsg));
    return el('section', { class: 'sl-sec' }, kids);
  }

  function sectionCards() {
    if (!st.cards.size) return null;
    const c = st.client;
    return el('section', { class: 'sl-sec sl-cards', 'aria-label': T('window.live.waiting.title') },
      ...[...st.cards.values()].map((k) => (k.assistant ? assistantCard(c, k) : el('div', { class: 'sl-card', 'data-live-card': k.c },
        el('div', { class: 'sl-card-who' }, avatar(k.c, k.name),
          el('div', {},
            el('p', { class: 'sl-card-name' }, T('window.live.knock.card', { name: k.name || T('window.live.noname'), device: k.device || T('window.live.nodevice') })),
            st.who.get(k.c) ? el('p', { class: 'sl-verified', 'data-live-verified': k.c }, T('window.live.verified', { name: st.who.get(k.c).name })) : el('p', { class: 'sl-muted' }, T('window.live.unverified')),
            el('p', { class: 'sl-muted' }, T(k.via === 'relay' ? 'window.live.via.relay' : 'window.live.via.lan')))),
        el('div', { class: 'sl-row' },
          btn(T('window.live.approve.edit'), () => { c.approve(k.c, 'editor'); st.cards.delete(k.c); render(); updateButton(); }, '', { 'data-live-approve': 'editor' }),
          btn(T('window.live.approve.view'), () => { c.approve(k.c, 'viewer'); st.cards.delete(k.c); render(); updateButton(); }, 'sl-btn-line', { 'data-live-approve': 'viewer' }),
          btn(T('window.live.approve.deny'), () => { c.deny(k.c); st.cards.delete(k.c); render(); updateButton(); }, 'sl-btn-line', { 'data-live-deny': true }))))));
  }
  /** LV.18: someone's assistant asks to work in the session (approved separately from its person). */
  function assistantCard(c, k) {
    const who = k.assistant.ofName || T('window.live.noname');
    return el('div', { class: 'sl-card', 'data-live-card': k.c, 'data-live-card-assistant': k.assistant.of },
      el('div', { class: 'sl-card-who' }, el('span', { class: 'sl-avatar sl-avatar-bot', 'aria-hidden': 'true' }, icon('robot')),
        el('div', {},
          el('p', { class: 'sl-card-name' }, T('window.live.assistant.knock', { name: who })),
          el('p', { class: 'sl-muted' }, T('window.live.assistant.knock.hint', { name: who })))),
      el('div', { class: 'sl-row' },
        btn(T('window.live.assistant.allow'), () => { c.approve(k.c, 'assistant'); st.cards.delete(k.c); render(); updateButton(); }, '', { 'data-live-approve': 'assistant' }),
        btn(T('window.live.approve.deny'), () => { c.deny(k.c); st.cards.delete(k.c); render(); updateButton(); }, 'sl-btn-line', { 'data-live-deny': true })));
  }

  function sectionPeople() {
    const c = st.client;
    const rows = peopleRows(c);
    st.lastPeoplePresence = presenceKey(c);
    const roleWord = (r) => T('window.live.role.' + (['host', 'editor', 'viewer', 'assistant'].includes(r) ? r : 'editor'));
    const people = rows.filter((r) => !r.of);
    return el('section', { class: 'sl-sec' },
      el('h3', { class: 'sl-h3' }, icon('people'), ' ', T('window.live.people.title', { n: people.length })),
      el('ul', { class: 'sl-people', 'data-live-people': true }, ...rows.map((r) => (r.of ? helperRow(c, r, rows) : el('li', { class: 'sl-person' + (r.state === 'gone' ? ' is-gone' : ''), 'data-live-person': r.c },
        avatar(r.c, r.name),
        el('span', { class: 'sl-person-name' }, r.name || T('window.live.noname'), ' ', tick(r.c), r.self ? el('span', { class: 'sl-muted' }, ' ' + T('window.live.people.you')) : null),
        el('span', { class: 'sl-muted sl-person-via' }, r.self ? '' : r.state === 'gone' ? T('window.live.people.gone') : T(r.via === 'relay' ? 'window.live.via.relay.short' : 'window.live.via.lan.short')),
        st.mode === 'host' && !r.self
          ? el('span', { class: 'sl-person-actions' },
            el('select', { class: 'sl-select sl-select-sm', 'aria-label': T('window.live.people.role', { name: r.name }), 'data-live-role': r.c,
              onchange: (e) => c.setRole(r.c, e.target.value) },
            ...['editor', 'viewer'].map((x) => el('option', { value: x, selected: r.role === x }, roleWord(x)))),
            canHandOver(r) ? btn(T('window.live.handover'), () => handOver(r), 'sl-btn-line sl-btn-sm', { 'data-live-handover': r.c, title: T('window.live.handover.title', { name: r.name || T('window.live.noname') }), disabled: !!st.handover }) : null,
            btn(T('window.live.people.remove'), async () => {
              if (await confirm(T('window.live.people.remove.ask', { name: r.name || T('window.live.noname') }), T('window.live.people.remove'))) c.remove(r.c);
            }, 'sl-btn-line sl-btn-sm', { 'data-live-remove': r.c }))
          : el('span', { class: 'sl-muted sl-person-role' }, roleWord(r.host ? 'host' : r.role)))))
        // an assistant working through its person's connection (no client of its own): from the presence
        .flatMap((li, i) => { const a = !rows[i].of && !rows.some((h) => h.of === rows[i].c && h.state !== 'gone') ? assistantOf(c, rows[i]) : null; return a ? [li, assistantRow(rows[i], a)] : [li]; })),
      c.locks.size ? el('p', { class: 'sl-muted' }, icon('lock'), ' ', T('window.live.locks', { n: c.locks.size })) : null);
  }

  /**
   * LV.18: every assistant connected to this window gets its own session client while this window is in a session as the
   * host or an editor. Asked once per control session; a session that ended takes its client along.
   */
  async function assistantClients() {
    const c = st.client, ctl = host.control;
    if (!c || c.final || !c.welcomed || !ctl || typeof ctl.sessions !== 'function' || typeof host.live.assistant !== 'function') return;
    const now = ctl.enabled ? ctl.sessions().map((x) => x.id) : [];
    for (const [id, a] of st.assistants) if (!now.includes(id) && a && !a.final) assistantGone(id);
    if (!['host', 'editor'].includes(c.role)) return;
    for (const s of ctl.enabled ? ctl.sessions() : []) {
      if (st.assistants.has(s.id)) continue;
      st.assistants.set(s.id, null);   // asking (and if there is no key to be had, it keeps working through this connection)
      let a = null;
      try { a = await host.live.assistant({ person: c, name: (s.client && s.client.name) || '', device: deviceName() }); } catch { a = null; }
      if (!a) continue;
      st.assistants.set(s.id, a);
      // Never reached the session (not even the host's question) in 10 s: give up; it works through this connection.
      win.setTimeout(() => { if (!a.everWelcomed && a.status !== 'waiting' && !a.final) a.leave(); }, 10000);
      a.on('status', ({ status: x, reason }) => {
        if (a.final && ['denied', 'removed'].includes(x)) {
          // The host said no (or took it out): the assistant is cut off in this window too.
          try { ctl.disconnect(s.id); } catch { /* gone */ }
          st.msg = T(x === 'denied' ? 'window.live.assistant.denied' : reason === 'person' ? 'window.live.assistant.went' : 'window.live.assistant.removed');
          st.msgKind = 'warn'; announce(st.msg);
        } else if (x === 'waiting') { st.msg = T('window.live.assistant.waiting'); st.msgKind = 'info'; }
        else if (x === 'live' && st.msg === T('window.live.assistant.waiting')) st.msg = '';
        render();
      });
      a.on('refused', (r) => {
        if (r && r.reason === 'gone') return;
        st.msg = T('window.live.assistant.refused', { why: T(refuseKey(r && r.reason), { name: (r && r.byName) || T('window.live.noname') }) });
        st.msgKind = 'warn'; render();
      });
    }
  }
  /** The assistant disconnected (or its control session ended): its client leaves once its edits are decided. */
  function assistantGone(id) {
    const a = st.assistants.get(id);
    if (!a || a.final) return;
    a.whenSettled(2000).catch(() => {}).finally(() => { if (!a.final) a.leave(); render(); });
  }

  /** What this window's assistants may do, for the presence (empty when none is connected). */
  function assistantMark() {
    const ctl = host.control;
    if (!ctl || !ctl.enabled || typeof ctl.sessions !== 'function') return {};
    const n = ctl.sessions().length;
    return n ? { assistant: { n: Math.min(n, 9), groups: ctl.groups.filter((g) => ['read', 'edit', 'save', 'export'].includes(g)) } } : {};
  }
  function assistantOf(c, row) {
    const p = row.self ? assistantMark() : (c.presence.get(row.c) || {});
    const a = p && p.assistant;
    return a && typeof a === 'object' ? { groups: Array.isArray(a.groups) ? a.groups.filter((g) => ['read', 'edit', 'save', 'export'].includes(g)) : [] } : null;
  }
  const presenceKey = (c) => [...c.presence.entries()].map(([k, p]) => k + ':' + (p && p.assistant ? 'a' : '')).join(',');
  /** LV.18: an assistant's own client in the people list, under its person; the host may take it out. */
  function helperRow(c, r, rows) {
    const person = rows.find((x) => x.c === r.of);
    // what it may do: the groups its person allowed (their presence; ours from Settings › Assistants)
    const can = (p) => { const a = p ? assistantOf(c, p) : null; const w = a ? a.groups.map((g) => T('window.live.assistant.group.' + g)).join(', ') : ''; return w ? T('window.live.assistant.can', { what: w }) : ''; };
    const pname = person ? (person.self ? null : person.name || T('window.live.noname')) : T('window.live.noname');
    return el('li', { class: 'sl-person sl-assistant' + (r.state === 'gone' ? ' is-gone' : ''), 'data-live-assistant': r.of, 'data-live-person': r.c },
      el('span', { class: 'sl-avatar sl-avatar-bot', 'aria-hidden': 'true' }, icon('robot')),
      el('span', { class: 'sl-person-name' }, pname === null ? T('window.live.assistant.you') : T('window.live.assistant.via', { name: pname }),
        r.name ? el('span', { class: 'sl-muted' }, ' ' + r.name) : null),
      el('span', { class: 'sl-muted sl-person-via' }, r.role === 'viewer' ? T('window.live.role.viewer') : can(person)),
      st.mode === 'host' && !(person && person.self)
        ? el('span', { class: 'sl-person-actions' }, btn(T('window.live.people.remove'), async () => {
          if (await confirm(T('window.live.assistant.remove.ask', { name: pname || T('window.live.noname') }), T('window.live.people.remove'))) c.remove(r.c);
        }, 'sl-btn-line sl-btn-sm', { 'data-live-remove': r.c }))
        : el('span', { class: 'sl-muted sl-person-role' }, T('window.live.role.assistant')));
  }
  function assistantRow(row, a) {
    const can = a.groups.map((g) => T('window.live.assistant.group.' + g)).join(', ');
    return el('li', { class: 'sl-person sl-assistant', 'data-live-assistant': row.c },
      el('span', { class: 'sl-avatar sl-avatar-bot', 'aria-hidden': 'true' }, icon('robot')),
      el('span', { class: 'sl-person-name' }, row.self ? T('window.live.assistant.you') : T('window.live.assistant.via', { name: row.name || T('window.live.noname') })),
      el('span', { class: 'sl-muted sl-person-via' }, can ? T('window.live.assistant.can', { what: can }) : ''),
      el('span', { class: 'sl-muted sl-person-role' }, T('window.live.role.assistant')));
  }

  function nameField() {
    const inp = el('input', { class: 'sl-input', id: 'sl-name', value: nameNow(), maxlength: 60, autocomplete: 'name', 'data-live-name': true, 'data-autofocus': true,
      onchange: (e) => { setName(e.target.value); } });
    return el('label', { class: 'sl-field', for: 'sl-name' }, el('span', {}, T('window.live.name')), inp,
      el('span', { class: 'sl-hint' }, accountName && !guestChosen() ? T('window.live.name.account') : T('window.live.name.hint')));
  }

  // A redraw can blur a focused field whose change handler asks for another redraw: run that one after.
  let drawing = false, again = false;
  function render() {
    if (drawing) { again = true; return; }
    drawing = true;
    try { draw(); } finally {
      drawing = false;
      if (again) { again = false; queueMicrotask(render); }
    }
  }
  function draw() {
    const c = st.client;
    const kids = [el('div', { class: 'sl-head' },
      el('h2', { class: 'sl-h', id: 'studio-live-h' }, T('window.live.title')),
      el('button', { type: 'button', class: 'sl-x', 'aria-label': T('window.live.close'), title: T('window.live.close'), onclick: () => { open(false); button.focus(); } }, icon('x-lg')))];
    if (st.msg) kids.push(el('p', { class: 'sl-note is-' + st.msgKind, role: st.msgKind === 'error' ? 'alert' : 'status', 'data-live-msg': true }, st.msg));
    if (!c || c.final) {
      if (st.endInfo) kids.push(el('p', { class: 'sl-end', role: 'status', 'data-live-end': true }, T(st.endInfo.key, st.endInfo.vars)));
      if (st.mode !== 'join' || c?.final) {
        kids.push(el('p', {}, T('window.live.share.pitch')), nameField(),
          el('div', { class: 'sl-row' }, btn(T('window.live.share'), () => { st.endInfo = null; st.mode = 'idle'; share(); }, 'sl-btn-plot', { 'data-live-share': true })),
          el('p', { class: 'sl-hint' }, T(live ? 'window.live.share.free' : 'window.live.share.nostudio')),
          onTablet && live ? el('p', { class: 'sl-note is-warn', 'data-live-tablet': true }, T('window.live.tablet.host')) : null,
          el('p', { class: 'sl-hint' }, T('window.live.join.where')),
          sectionHere());
      }
    } else if (st.mode === 'host') {
      const line = statusLine(c.status, { role: c.role, people: peopleRows(c).length });
      kids.push(el('p', { class: 'sl-state', 'data-live-state': c.status }, el('span', { class: 'sl-dot' }), T(line.key, line.vars)));
      const cards = sectionCards();
      if (cards) kids.push(cards);
      if (onTablet) kids.push(el('p', { class: 'sl-note is-warn', 'data-live-tablet': true }, T('window.live.tablet.onscreen')));
      kids.push(sectionCode(), sectionLink(), sectionPeople(),
        el('div', { class: 'sl-row sl-foot' }, btn(T('window.live.end'), end, 'sl-btn-danger', { 'data-live-end-session': true })),
        el('p', { class: 'sl-hint' }, T('window.live.end.hint')));
    } else {
      const line = statusLine(c.status, { role: c.role, people: peopleRows(c).length });
      kids.push(el('p', { class: 'sl-state', 'data-live-state': c.status }, el('span', { class: 'sl-dot' }), T(line.key, line.vars)));
      if (c.status === 'waiting') kids.push(el('p', { class: 'sl-hint' }, T('window.live.waiting.hint')));
      if (c.everWelcomed) kids.push(sectionPeople());
      kids.push(el('div', { class: 'sl-row sl-foot' }, btn(T('window.live.leave'), leave, 'sl-btn-line', { 'data-live-leave': true })),
        el('p', { class: 'sl-hint' }, T('window.live.leave.hint')));
    }
    const ask = panel.querySelector('.sl-ask');
    panel.replaceChildren(...kids.filter(Boolean));
    if (ask) panel.append(ask);
    renderCode();
    updateButton();
  }

  // ---- a join handed over by the hub
  let joinId = null;
  try { joinId = new URLSearchParams(win.location.search).get('live-join'); } catch { joinId = null; }
  if (joinId) {
    try { const u = new URL(win.location.href); u.searchParams.delete('live-join'); win.history.replaceState(null, '', u.pathname + u.search + u.hash); } catch { /* no history */ }
    let rec = null;
    try { rec = new JoinStore(win.localStorage).take(joinId); } catch { rec = null; }
    if (rec) join(rec);
    else { st.mode = 'join'; st.endInfo = { key: 'window.live.end.stale', vars: {} }; open(true); }
  }
  // A session the app started by itself (a browser joiner on the host's LAN page, LIVE-PROTOCOL § 12, or an invite
  // link's "Join in the browser": the app's live.js reads those addresses): the panel follows it too.
  if (typeof host.live.on === 'function') {
    host.live.on((c) => {
      if (!c || c === st.client) return;
      st.mode = c.o && c.o.role === 'host' ? 'host' : 'join';
      st.endInfo = null; st.msg = '';
      attach(c);
      render();
    });
  }

  const api = { open: () => open(true), close: () => open(false), get client() { return st.client; }, state: () => ({ mode: st.mode, code: st.code && { tag: st.code.tag, oneTime: st.code.oneTime }, cards: st.cards.size, link: !!st.link }), share, join, parseJoin };
  if (channel) channel.on('live.open', () => open(true));
  return api;
}
