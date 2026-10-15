/* SPDX-License-Identifier: Apache-2.0 */
/**
 * hub-join.js — the hub's "Join a live session" card (0.5 LV.7; spec docs/STUDIO-LIVE-SPEC.md §§ 6, 8, 9 in the site repo).
 *
 * What a person can give it (invite.js parseJoin): a short code (Studio looks for its tag on this network over mDNS, at
 * most 1.5 s), the host's QR text (address + port + app + code), a typed address with the code, or an invite link (the
 * site's https link or ccstudio://join/…; Studio first looks for the host on this network by the room's tag, LV.26, then
 * uses the relay). Links the system opened Studio with arrive through cadcraftDesktop.links (desktop's ccstudio://
 * registration) and start the same way.
 *
 * The hub never joins itself: it finds the session, opens the right app in a new window with `?live-join=<id>`, and hands
 * the details over through JoinStore (localStorage, read once, 2 minutes). The app window (window-live.js) joins.
 * The browser edition can only follow invite links (a page can't reach other computers on the network); codes there point
 * to the address shown under the host's code.
 *
 * One box (owner, 2026-10-14): a code or an invite link, and the card says which while you type (a typed address still
 * works, for networks where Studio can't find the host). Your name: signed in, you join as your account (the host sees it
 * checked, LV.19); "Use a different name" joins as a guest under any name, with no account proof sent (rec.guest). Not
 * signed in, any name: guests need no account.
 */
import { parseJoin, socketUrl, relayJoinUrl, urlHost, JoinStore, SLUGS } from './invite.js';

const LS_NAME = 'cadcraft.studio.live.name';
const LS_APP = 'cadcraft.studio.live.lastapp';
const LS_GUEST = 'cadcraft.studio.live.guest';   // '1' = signed in, but joins under another name

export function wireJoin({ doc = document, win = window, desk = null, onAccountChange = null, t, say, openApp, askApp, appBy, apps }) {
  const card = doc.querySelector('[data-live-join]');
  if (!card) return null;
  const form = card.querySelector('form');
  const input = card.querySelector('[data-live-join-input]');
  const nameIn = card.querySelector('[data-live-join-name]');
  const msg = card.querySelector('[data-live-join-msg]');
  const live = desk && desk.live ? desk.live : null;
  const store = new JoinStore(win.localStorage);
  const ls = { get: (k) => { try { return win.localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { win.localStorage.setItem(k, v); } catch { /* private */ } } };
  card.hidden = false;
  card.querySelector('[data-live-join-hint]').textContent = t(live ? 'live.join.hint' : 'live.join.hint.browser');
  card.querySelector('[data-live-join-label]').textContent = t(live ? 'live.join.label' : 'live.join.label.browser');
  const tell = (key, vars = {}, kind = 'info') => { msg.textContent = key ? t(key, vars) : ''; msg.dataset.kind = kind; msg.hidden = !key; };

  // What was pasted, said while typing: only for something whole (no nagging mid-word; Join explains the rest).
  const kindEl = card.querySelector('[data-live-join-kind]');
  const KIND = { code: 'live.join.kind.code', link: 'live.join.kind.link', lan: 'live.join.kind.address', address: 'live.join.kind.address' };
  const showKind = () => {
    const r = parseJoin(input.value);
    const key = KIND[r.kind] && (live || r.kind === 'link') ? KIND[r.kind] : null;
    kindEl.textContent = key ? t(key) : ''; kindEl.dataset.kind = key ? r.kind : ''; kindEl.hidden = !key;
  };
  input.addEventListener('input', showKind);

  // Your name: the account's when signed in (unless you chose another), else any name you type.
  const asBox = card.querySelector('[data-live-join-as]');
  const guestBox = card.querySelector('[data-live-join-guest]');
  const mineBtn = card.querySelector('[data-live-join-mine]');
  let account = null;   // {name, email} while signed in
  const asGuest = () => !account || ls.get(LS_GUEST) === '1';
  const showName = () => {
    const g = asGuest();
    asBox.hidden = g; guestBox.hidden = !g; mineBtn.hidden = !account;
    if (account) card.querySelector('[data-live-join-as-text]').textContent = t('live.join.as', { name: account.name });
    card.querySelector('[data-live-join-namehint]').textContent = t(account ? 'live.join.name.other' : 'live.join.name.guest');
  };
  card.querySelector('[data-live-join-other]').addEventListener('click', () => { ls.set(LS_GUEST, '1'); showName(); nameIn.focus(); });
  mineBtn.addEventListener('click', () => { ls.set(LS_GUEST, ''); showName(); input.focus(); });
  const readAccount = () => desk.account.status().then((a) => {
    account = a && a.state === 'signed_in' && a.user && String(a.user.name || '').trim() ? { name: String(a.user.name).trim().slice(0, 60) } : null;
    showName();
  }).catch(() => { account = null; showName(); });
  nameIn.value = ls.get(LS_NAME) || '';
  showName();
  if (desk && desk.account && typeof desk.account.status === 'function') {
    readAccount();
    // The hub passes its shared subscription (the shell keeps one listener: registering here would unhook the account card).
    if (onAccountChange) onAccountChange(readAccount);
    else if (typeof desk.account.onChange === 'function') desk.account.onChange(readAccount);
  }
  nameIn.addEventListener('change', () => ls.set(LS_NAME, nameIn.value.trim().slice(0, 60)));

  /** Which app is the session in, when nothing told us: ask, the last one first. */
  async function pickApp() {
    const last = ls.get(LS_APP);
    const list = [...apps].sort((a, b) => (b === last) - (a === last));
    return askApp(t('live.join.which'), { ext: '', apps: list, noRemember: true });
  }

  async function lanFind(what) {
    if (!live || typeof live.browse !== 'function') return null;
    try { const found = await live.browse(what, 1500); return (Array.isArray(found) && found.find((f) => f && urlHost(f.addr))) || null; } catch { return null; }   // the first address a URL can carry (urlHost)
  }

  async function go(text) {
    const r = parseJoin(text);
    const guest = asGuest();
    const name = guest ? nameIn.value.trim().slice(0, 60) : account.name;
    if (r.kind === 'bad') return tell('live.join.bad.' + r.reason, {}, 'error');
    if (!name) { nameIn.focus(); return tell('live.join.name', {}, 'error'); }
    if (guest) ls.set(LS_NAME, name);
    let rec = null, slug = null;
    if (r.kind === 'link') {
      tell('live.join.looking');
      const near = await lanFind({ room: r.room });
      if (near) { rec = { kind: 'link', room: r.room, secret: r.secret, host: near.addr, port: near.port, url: socketUrl({ host: near.addr, port: near.port }) }; slug = near.app; }
      else rec = { kind: 'link', room: r.room, secret: r.secret, url: relayJoinUrl(r.room) };
    } else if (!live) {
      return tell('live.join.browser', {}, 'error');
    } else if (r.kind === 'code') {
      tell('live.join.looking');
      const near = await lanFind(r.tag);
      if (!near) return tell('live.join.notfound', {}, 'error');
      rec = { kind: 'code', code: r.code, host: near.addr, port: near.port };
      slug = near.app;
    } else if (r.kind === 'lan') {
      rec = { kind: 'code', code: r.code, host: r.host, port: r.port };
      slug = r.slug;
    } else if (r.kind === 'address') {
      if (!r.code) return tell('live.join.needcode', {}, 'error');
      rec = { kind: 'code', code: r.code, host: r.host, port: r.port };
    }
    if (!slug || !SLUGS.includes(slug) || !appBy[slug]) slug = await pickApp();
    if (!slug) return tell('');
    ls.set(LS_APP, slug);
    rec.name = name;
    if (guest) rec.guest = true;   // no account proof: the host sees this name as typed
    const id = store.put(rec);
    const w = await openApp(slug, { search: '?live-join=' + id });
    if (!w) return tell('live.join.blocked', { app: appBy[slug].name }, 'error');
    input.value = ''; showKind();
    tell('live.join.opened', { app: appBy[slug].name });
    say(t('live.join.opened', { app: appBy[slug].name }));
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); go(input.value); });
  // Invite links the system opened Studio with (ccstudio://join/…): straight in. The link is never shown or logged.
  if (desk && desk.links && typeof desk.links.onOpen === 'function') {
    const take = (url) => { if (typeof url === 'string') go(url); };
    desk.links.onOpen(take);
    if (typeof desk.links.launch === 'function') desk.links.launch().then((urls) => (urls || []).forEach(take)).catch(() => {});
  }
  return { go };
}
