/* SPDX-License-Identifier: Apache-2.0 */
/**
 * ask-key-card.js — Studio › Your own AI model (0.8 AC.11, owner 2026-10-29: "keys in the OS credential store"). The person pastes an API key from a
 * model provider (or points at an OpenAI-compatible address, e.g. a local runner) and sets the limits; the Ask box in every app then uses that
 * model directly, with no separate AI app. The key goes in and never comes out: Studio's native commands (desktop-shell ask_keys.rs) keep it in the
 * computer's credential store (Windows Credential Manager, macOS Keychain, Secret Service); this card can set it, ask whether one is stored, and
 * delete it — never read it. The settings (provider, model, address, caps, prices) are plain numbers and words in localStorage; the spending ledger
 * is tools/mcp/byok.mjs's (kept in the same place), so every window of the suite counts against the same caps.
 *
 *   mountAskKey({ box, desk, store, t, el, say }) → { render(), settings() }      desk = window.cadcraftDesktop (desk.ask.keySet/keyHas/keyDelete)
 *   serveAsk({ channel, desk }) → off()    the hub answers 'ask.call' from the app windows (an app window cannot reach the key; only this window can)
 *   readSettings(store) / writeSettings(store, s) · SETTINGS_KEY · LEDGER_KEY
 */
import { DEFAULT_SETTINGS, DEFAULT_PRICES, isLocalUrl } from './byok.mjs';

export const SETTINGS_KEY = 'cadcraft.studio.byok.settings';
export const LEDGER_KEY = 'cadcraft.studio.byok.ledger';
export const PROVIDERS = ['anthropic', 'openai', 'compatible'];
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
const word = (v, d, n = 120) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n) : d);

/** The stored settings, checked: anything odd falls back to the default. */
export function readSettings(store) {
  let raw = null;
  try { raw = JSON.parse(store.getItem(SETTINGS_KEY) || 'null'); } catch { raw = null; }
  const d = DEFAULT_SETTINGS, r = raw && typeof raw === 'object' ? raw : {}, c = r.caps && typeof r.caps === 'object' ? r.caps : {};
  const prices = {};
  for (const [m, p] of Object.entries(r.prices && typeof r.prices === 'object' ? r.prices : {}).slice(0, 40)) {
    if (/^[\w.:\-\/]{1,80}$/.test(m) && p && Number.isFinite(+p.in) && Number.isFinite(+p.out) && +p.in >= 0 && +p.out >= 0) prices[m] = { in: +p.in, out: +p.out };
  }
  return {
    provider: PROVIDERS.includes(r.provider) ? r.provider : d.provider, model: word(r.model, d.model, 80), baseUrl: word(r.baseUrl, '', 200),
    keyName: /^[A-Za-z0-9._-]{1,64}$/.test(r.keyName || '') ? r.keyName : d.keyName,
    maxOutputTokens: Math.round(num(r.maxOutputTokens, 64, 64000, d.maxOutputTokens)), maxToolSteps: Math.round(num(r.maxToolSteps, 1, 40, d.maxToolSteps)),
    caps: { dayAmount: num(c.dayAmount, 0, 1e6, d.caps.dayAmount), monthAmount: num(c.monthAmount, 0, 1e6, d.caps.monthAmount),
      dayTokens: Math.round(num(c.dayTokens, 0, 1e9, d.caps.dayTokens)), callsPerHour: Math.round(num(c.callsPerHour, 1, 10000, d.caps.callsPerHour)) },
    currency: /^[A-Z]{3}$/.test(r.currency || '') ? r.currency : d.currency, prices,
  };
}
export function writeSettings(store, s) { try { store.setItem(SETTINGS_KEY, JSON.stringify(readSettings({ getItem: () => JSON.stringify(s) }))); return true; } catch { return false; } }

/** The hub answers the app windows' provider calls: only here the key can be used. */
export function serveAsk({ channel, desk }) {
  if (!channel || !desk || !desk.ask) return () => {};
  return channel.on('ask.call', async (d, env) => {
    const id = d && typeof d.id === 'string' ? d.id.slice(0, 64) : '';
    if (!id) return;
    let out;
    try {
      const o = d.call || {};
      const r = await desk.ask.call({ provider: o.provider, baseUrl: o.baseUrl, keyName: o.keyName, path: o.request && o.request.path, headers: o.request && o.request.headers, body: o.request && o.request.body });
      out = { status: Number(r && r.status) || 0, json: r && r.json !== undefined ? r.json : null, error: r && r.error ? String(r.error).slice(0, 80) : null };
    } catch { out = { status: 0, json: null, error: 'native_failed' }; }   // never the exception's words: they could hold anything the store said
    channel.post('ask.result', { id, ...out }, env.from);
  });
}

export function mountAskKey({ box, desk, store = globalThis.localStorage, t, el, say }) {
  let s = readSettings(store), stored = null, busy = false;
  const save = () => { writeSettings(store, s); };
  const has = async () => { try { stored = !!(await desk.ask.keyHas(s.keyName)); } catch { stored = null; } };
  const field = (label, input, hint) => el('label', { class: 'studio-field' }, el('span', {}, label), input, hint ? el('small', { class: 'studio-muted' }, hint) : null);
  const numIn = (value, onchange, attrs = {}) => { const i = el('input', { type: 'number', class: 'studio-input', value: String(value), step: 'any', ...attrs }); i.addEventListener('change', () => { onchange(Number(i.value)); save(); render(); }); return i; };
  const local = () => s.provider === 'compatible' && isLocalUrl(s.baseUrl);

  async function setKey(input) {
    const v = input.value.trim();
    if (!v || busy) return;
    busy = true;
    try { await desk.ask.keySet(s.keyName, v); input.value = ''; say(t('askkey.saved')); } catch (e) { say(t('askkey.failed', { why: String((e && e.message) || e).split(v).join('…').slice(0, 160) }), 'error'); }   // the shell's words, never with the key in them
    busy = false; await has(); render();
  }
  async function dropKey() {
    if (busy) return;
    busy = true;
    try { await desk.ask.keyDelete(s.keyName); say(t('askkey.removed')); } catch (e) { say(t('askkey.failed', { why: String((e && e.message) || e).slice(0, 160) }), 'error'); }
    busy = false; await has(); render();
  }

  async function render() {
    if (stored === null) await has();
    const prov = el('select', { class: 'studio-input', 'data-askkey-provider': true }, ...PROVIDERS.map((p) => el('option', { value: p, selected: p === s.provider }, t('askkey.provider.' + p))));
    prov.addEventListener('change', () => { s.provider = prov.value; save(); render(); });
    const model = el('input', { type: 'text', class: 'studio-input', value: s.model, maxlength: '80', placeholder: t('askkey.model.hint'), 'data-askkey-model': true });
    model.addEventListener('change', () => { s.model = word(model.value, '', 80); save(); render(); });
    const base = el('input', { type: 'url', class: 'studio-input', value: s.baseUrl, maxlength: '200', placeholder: 'http://127.0.0.1:11434/v1', 'data-askkey-base': true });
    base.addEventListener('change', () => { s.baseUrl = word(base.value, '', 200); save(); render(); });
    const key = el('input', { type: 'password', class: 'studio-input', autocomplete: 'off', spellcheck: 'false', placeholder: t('askkey.key.hint'), 'data-askkey-key': true });
    const price = s.prices[s.model] || DEFAULT_PRICES[s.model] || null;
    const nodes = [
      el('p', { class: 'studio-lead' }, t('askkey.lead')),
      field(t('askkey.provider'), prov),
      field(t('askkey.model'), model),
      s.provider === 'compatible' ? field(t('askkey.base'), base, t('askkey.base.hint')) : null,
      local() ? el('p', { class: 'studio-muted', 'data-askkey-local': true }, t('askkey.local')) : el('div', { class: 'studio-keyrow' }, field(t('askkey.key'), key),
        el('div', { class: 'studio-keyrow-btns' },
          el('button', { type: 'button', class: 'studio-btn studio-btn-sm', 'data-askkey-save': true, onclick: () => setKey(key) }, t('askkey.save')),
          stored ? el('button', { type: 'button', class: 'studio-btn studio-btn-sm studio-btn-line', 'data-askkey-remove': true, onclick: dropKey }, t('askkey.remove')) : null)),
      el('p', { class: 'studio-muted', 'data-askkey-state': stored === null ? 'unknown' : stored ? 'stored' : 'none' }, local() ? '' : stored === null ? t('askkey.state.unknown') : stored ? t('askkey.state.stored') : t('askkey.state.none')),
      el('h3', { class: 'studio-h studio-h-sm studio-subhead' }, t('askkey.caps')),
      el('div', { class: 'studio-fields' },
        field(t('askkey.cap.day', { cur: s.currency }), numIn(s.caps.dayAmount, (v) => { s.caps.dayAmount = num(v, 0, 1e6, s.caps.dayAmount); }, { min: '0', 'data-askkey-dayamount': true })),
        field(t('askkey.cap.month', { cur: s.currency }), numIn(s.caps.monthAmount, (v) => { s.caps.monthAmount = num(v, 0, 1e6, s.caps.monthAmount); }, { min: '0', 'data-askkey-monthamount': true })),
        field(t('askkey.cap.tokens'), numIn(s.caps.dayTokens, (v) => { s.caps.dayTokens = Math.round(num(v, 0, 1e9, s.caps.dayTokens)); }, { min: '0', 'data-askkey-daytokens': true })),
        field(t('askkey.cap.calls'), numIn(s.caps.callsPerHour, (v) => { s.caps.callsPerHour = Math.round(num(v, 1, 10000, s.caps.callsPerHour)); }, { min: '1', 'data-askkey-calls': true }))),
      local() ? null : el('div', { class: 'studio-fields studio-fields-2' },
        field(t('askkey.price.in', { cur: s.currency }), numIn(price ? price.in : '', (v) => { if (s.model && v >= 0) s.prices[s.model] = { in: v, out: (s.prices[s.model] || price || { out: 0 }).out }; }, { min: '0', 'data-askkey-pricein': true })),
        field(t('askkey.price.out', { cur: s.currency }), numIn(price ? price.out : '', (v) => { if (s.model && v >= 0) s.prices[s.model] = { in: (s.prices[s.model] || price || { in: 0 }).in, out: v }; }, { min: '0', 'data-askkey-priceout': true }))),
      local() || price ? null : el('p', { class: 'studio-muted', 'data-askkey-noprice': true }, t('askkey.noprice')),
      el('p', { class: 'studio-muted' }, t('askkey.note')),
    ];
    box.replaceChildren(...nodes.filter(Boolean));
  }
  return { render, settings: () => readSettings(store) };
}
