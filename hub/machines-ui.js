/* SPDX-License-Identifier: Apache-2.0 */
/**
 * machines-ui.js — the two screens of "Send to a machine" (0.8 EG.40, studio_PART_3). Desktop Studio only: a page cannot reach a
 * printer on the person's network, so the shell does the request (desktop-shell machines.rs); drivers and rules are machines.js.
 *
 *   loadMachines() / saveMachines(list)           the machine records (no key) in this origin's localStorage, shared by every Studio window
 *   machinesSettings({ doc, T, desk, canSetKey })   → element: the list, "Test the connection", add / remove, and (hub only) the key
 *   sendDialog({ doc, T, desk, name, bytes, device })  → Promise<result | null>: pick a machine; "Upload only" or (printers) "Upload and start"
 *                                                  with "I am at the machine and it is clear"; a CNC, a laser or a robot is never started
 *
 * Words are `window.machines.*` in hub/lang/<locale>.json (the packer embeds window.* into every app window). A key is typed once, goes
 * to the OS credential store and is never shown, stored or read back here.
 */
import { KINDS, DEVICES, cleanMachine, isLanHost, pingPlan, parsePing, send, jobName, NOT_FOR_PRINTERS, extOf } from './machines.js';

const STORE = 'cadcraft.studio.machines';

export function loadMachines(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage.getItem(STORE) || '[]');
    return (Array.isArray(raw) ? raw : []).map(cleanMachine).filter(Boolean).slice(0, 40);
  } catch { return []; }
}
export function saveMachines(list, storage = globalThis.localStorage) {
  const clean = (list || []).map(cleanMachine).filter(Boolean).slice(0, 40);
  try { storage.setItem(STORE, JSON.stringify(clean)); } catch { /* private mode: the list lives only until the window closes */ }
  return clean;
}
export const newMachineId = (name, taken = []) => {
  const base = String(name || 'machine').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'machine';
  let id = base.length >= 3 ? base : base + '-1', n = 2;
  while (taken.includes(id)) id = base.slice(0, 30) + '-' + n++;
  return id;
};

const fill = (s, v = {}) => String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] === undefined ? m : v[k]));
function maker(doc) {
  return (tag, attrs = {}, ...kids) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
    return n;
  };
}
const transport = (desk) => ({ request: (step) => desk.machines.request(step) });
const errWord = (T, r) => ({ network: T('window.machines.err.network'), key: T('window.machines.err.key'), refused: T('window.machines.err.refused'), tls: T('window.machines.err.tls'), not_allowed: T('window.machines.err.notallowed') }[r.code] || r.message || T('window.machines.err.refused'));

/** Settings: Studio › Machines. */
export function machinesSettings({ doc = document, T, desk, canSetKey = true, say = () => {} }) {
  const el = maker(doc), t = (k, v) => fill(T(k), v);
  const box = el('div', { 'data-machines-box': true });
  let list = loadMachines();
  const state = new Map();   // id → text of the last test
  const draw = async () => {
    const rows = [];
    for (const m of list) {
      const hasKey = canSetKey && desk.machines.keyHas ? await desk.machines.keyHas(m.id).catch(() => false) : false;
      const keyIn = el('input', { type: 'password', autocomplete: 'off', class: 'form-control form-control-sm', 'data-machine-key': m.id, placeholder: t('window.machines.key.placeholder'), 'aria-label': t('window.machines.key') });
      rows.push(el('li', { class: 'studio-machines-row', 'data-machine': m.id },
        el('strong', {}, m.name), ' ', el('span', { class: 'studio-muted' }, `${KINDS[m.kind].label} · ${t('window.machines.device.' + m.device)} · ${m.host}:${m.port}`),
        el('div', { class: 'studio-btnrow' },
          el('button', { type: 'button', class: 'studio-btn studio-btn-sm studio-btn-line', 'data-machine-test': m.id, onclick: async () => {
            state.set(m.id, t('window.machines.testing')); await draw();
            let r;
            try { r = parsePing(m, await transport(desk).request(pingPlan(m))); } catch (e) { r = { ok: false, error: e }; }
            state.set(m.id, r.ok ? t('window.machines.test.ok', { version: r.version || '' }).trim() : t('window.machines.test.fail'));
            await draw();
          } }, t('window.machines.test')),
          el('button', { type: 'button', class: 'studio-btn studio-btn-sm studio-btn-line', 'data-machine-remove': m.id, onclick: async () => {
            list = saveMachines(list.filter((x) => x.id !== m.id)); try { await desk.machines.keyForget(m.id); } catch { /* none */ }
            say(t('window.machines.removed', { name: m.name })); await draw();
          } }, t('window.machines.remove'))),
        canSetKey ? el('div', { class: 'studio-btnrow' }, keyIn,
          el('button', { type: 'button', class: 'studio-btn studio-btn-sm', 'data-machine-key-save': m.id, onclick: async () => {
            const v = keyIn.value.trim(); keyIn.value = '';
            if (!v) return;
            try { await desk.machines.keySet(m.id, v); say(t('window.machines.key.saved')); } catch { say(t('window.machines.key.failed'), 'error'); }
            await draw();
          } }, t('window.machines.key.save')),
          hasKey ? el('span', { class: 'studio-muted', 'data-machine-key-state': m.id }, t('window.machines.key.stored')) : null) : null,
        state.has(m.id) ? el('div', { class: 'studio-hint', 'data-machine-state': m.id, role: 'status' }, state.get(m.id)) : null));
    }
    const name = el('input', { class: 'form-control form-control-sm', 'data-machine-new-name': true, 'aria-label': t('window.machines.name'), placeholder: t('window.machines.name') });
    const host = el('input', { class: 'form-control form-control-sm', 'data-machine-new-host': true, 'aria-label': t('window.machines.host'), placeholder: '192.168.1.40' });
    const kind = el('select', { class: 'form-select form-select-sm', 'data-machine-new-kind': true, 'aria-label': t('window.machines.kind') }, ...Object.entries(KINDS).map(([k, v]) => el('option', { value: k }, v.label)));
    const device = el('select', { class: 'form-select form-select-sm', 'data-machine-new-device': true, 'aria-label': t('window.machines.device') }, ...DEVICES.map((d) => el('option', { value: d }, t('window.machines.device.' + d))));
    const msg = el('div', { class: 'studio-hint', 'data-machine-new-msg': true, role: 'status' });
    const add = el('button', { type: 'button', class: 'studio-btn', 'data-machine-add': true, onclick: () => {
      const h = host.value.trim().toLowerCase();
      if (!isLanHost(h)) { msg.textContent = t('window.machines.add.public'); return; }
      const m = cleanMachine({ id: newMachineId(name.value || h, list.map((x) => x.id)), name: name.value, kind: kind.value, device: device.value, host: h });
      if (!m) { msg.textContent = t('window.machines.add.bad'); return; }
      list = saveMachines([...list, m]); say(t('window.machines.added', { name: m.name })); draw();
    } }, t('window.machines.add'));
    box.replaceChildren(
      el('p', {}, t('window.machines.lead')),
      list.length ? el('ul', { class: 'studio-machines-list' }, ...rows) : el('p', { class: 'studio-hint', 'data-machines-none': true }, t('window.machines.none')),
      el('div', { class: 'studio-machines-add' }, el('strong', {}, t('window.machines.add.title')), name, kind, device, host, add, msg),
      el('p', { class: 'studio-hint' }, t('window.machines.safety')));
  };
  draw();
  return box;
}

/** The dialog an app opens. bytes = the G-code; device = what the file is for ('printer' | 'cnc' | 'laser' | 'robot') so the list shows the machines that fit. */
export function sendDialog({ doc = document, T, desk, name, bytes, device = null, files = null }) {
  const el = maker(doc), t = (k, v) => fill(T(k), v);
  return new Promise((resolve) => {
    // several files (an app's whole program set) go to the one machine picked here, one after the other; `name`/`bytes` stay for a single file
    const jobs = Array.isArray(files) && files.length ? files.map((f) => ({ name: f.name, bytes: f.bytes })) : [{ name, bytes }];
    const fitting = loadMachines().filter((m) => !device || m.device === device).filter((m) => !(m.device === 'printer' && jobs.some((j) => NOT_FOR_PRINTERS.includes(extOf(jobName(j.name))))));
    const jn = jobs.every((j) => jobName(j.name)) ? jobName(jobs[0].name) : null;
    const dlg = el('dialog', { class: 'studio-machines-dialog', 'data-machines-dialog': true, 'aria-labelledby': 'studio-machines-dlg-h' });
    const done = (v) => { try { dlg.close(); } catch { /* closed */ } dlg.remove(); resolve(v); };
    const body = el('div', {});
    const status = el('div', { class: 'studio-hint', role: 'status', 'data-machines-status': true });
    let pick = fitting[0] || null, start = false, sure = false, busy = false;
    const draw = () => {
      const canStart = pick && pick.device === 'printer';
      body.replaceChildren(
        el('h2', { id: 'studio-machines-dlg-h', class: 'h5' }, t('window.machines.send.title')),
        el('p', {}, jn ? (jobs.length > 1 ? t('window.machines.send.files', { n: jobs.length, kb: Math.max(1, Math.round(jobs.reduce((n, j) => n + j.bytes.length, 0) / 1024)) }) : t('window.machines.send.file', { name: jn, kb: Math.max(1, Math.round(jobs[0].bytes.length / 1024)) })) : t('window.machines.err.name')),
        !fitting.length ? el('p', { 'data-machines-empty': true }, t('window.machines.send.none')) : el('select', { class: 'form-select', 'data-machines-pick': true, 'aria-label': t('window.machines.send.pick'), onchange: (e) => { pick = fitting.find((m) => m.id === e.target.value) || null; start = false; sure = false; draw(); } },
          ...fitting.map((m) => el('option', { value: m.id, selected: pick && pick.id === m.id }, `${m.name} (${KINDS[m.kind].label})`))),
        canStart ? el('label', { class: 'form-check' }, el('input', { type: 'checkbox', class: 'form-check-input', 'data-machines-start': true, checked: start, onchange: (e) => { start = e.target.checked; if (!start) sure = false; draw(); } }), ' ', t('window.machines.send.start')) : (pick ? el('p', { class: 'studio-hint', 'data-machines-nostart': true }, t('window.machines.send.nostart')) : null),
        canStart && start ? el('label', { class: 'form-check' }, el('input', { type: 'checkbox', class: 'form-check-input', 'data-machines-sure': true, checked: sure, onchange: (e) => { sure = e.target.checked; draw(); } }), ' ', t('window.machines.send.sure')) : null,
        status,
        el('div', { class: 'studio-btnrow' },
          el('button', { type: 'button', class: 'studio-btn', 'data-machines-go': true, disabled: !pick || !jn || busy || (start && !sure), onclick: async () => {
            busy = true; status.textContent = t('window.machines.sending'); draw();
            let r = { ok: false, message: '' }, sent = 0;
            for (const j of jobs) {
              r = await send(pick, { name: j.name, bytes: j.bytes, start: start && sure && jobs.length === 1, confirmed: start && sure }, transport(desk)).catch((e) => ({ ok: false, message: String(e && e.message || e), code: e && e.code }));
              if (!r.ok) break;
              sent++;
            }
            busy = false;
            if (r.ok) { done({ ...r, sent }); return; }
            draw(); status.textContent = errWord(T, r);
          } }, start ? t('window.machines.send.go.start') : t('window.machines.send.go')),
          el('button', { type: 'button', class: 'studio-btn studio-btn-line', 'data-machines-cancel': true, onclick: () => done(null) }, t('window.machines.cancel'))));
    };
    dlg.addEventListener('cancel', () => done(null));
    dlg.append(body);
    doc.body.append(dlg);
    draw();
    try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
  });
}
