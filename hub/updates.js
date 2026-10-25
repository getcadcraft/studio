/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — data only; hub.js words it through the keys below. */
/**
 * updates.js — what the shell's update check answered, and what Settings › Updates shows, as language keys (0.7 D7.54; 0.7
 * MSIX + one update endpoint). DOM-free.
 *
 * The shell (desktop-shell src-tauri/src/updates.rs) answers a check with a plain string when it went through —
 * 'current' | 'declined' | 'busy' | 'off' | 'download' (the portable copy opened the download page) | 'installing' (Windows
 * is installing a package update) — and rejects with an error whose `code` says what went wrong (bridge.js reads it from the
 * "code: text" the shell sends): 'no_build', 'network', 'feed', 'signature', 'install', 'not_store' (a package installed from a
 * file: nothing can update it).
 *
 * `cc_updates_status` → {available, auto, autoAllowed, source (feed | notify | package), route (store | appinstaller |
 * sideloaded, packages only), edition, version, platform, busy, last {at, outcome, latest, notes, asked}}.
 *
 *   updateOutcome(result, error) → { key, kind: 'info' | 'error' }
 *   updatesView(status)          → what Settings › Updates shows (keys + values; hub.js renders it)
 *   KEYS                         → every key it can answer (the language test counts them as used)
 */
const OK = { current: 'updates.current', declined: 'updates.declined', busy: 'updates.busy', off: 'updates.none', download: 'updates.download', installing: 'updates.installing' };
const BAD = new Set(['no_build', 'network', 'feed', 'signature', 'install', 'not_store']);
const EDITION = {
  installer: 'updates.edition.installer', portable: 'updates.edition.portable', 'msix-web': 'updates.edition.msix-web',
  'msix-store': 'updates.edition.msix-store', deb: 'updates.edition.deb', appimage: 'updates.edition.appimage', dmg: 'updates.edition.dmg',
};
const PLATFORM = { windows: 'updates.platform.windows', linux: 'updates.platform.linux', macos: 'updates.platform.macos' };
/** Where this copy's updates come from. */
const FROM = { feed: 'updates.from.site', notify: 'updates.from.notify', store: 'updates.from.store', appinstaller: 'updates.from.appinstaller', sideloaded: 'updates.from.sideloaded' };
/** The last check's result, as Settings words it. */
const LAST = { current: 'updates.last.current', available: 'updates.last.available', declined: 'updates.last.declined', download: 'updates.last.download', installing: 'updates.last.installing', installed: 'updates.last.installed' };

export const KEYS = ['updates.none', 'updates.done', 'updates.failed', ...Object.values(OK), ...[...BAD].map((c) => 'updates.err.' + c),
  ...Object.values(EDITION), ...Object.values(PLATFORM), ...Object.values(FROM), ...Object.values(LAST),
  'updates.edition.unknown', 'updates.never', 'updates.latest.same', 'updates.latest.unknown', 'updates.install', 'updates.install.download',
  'updates.install.store', 'updates.why.busy', 'updates.why.none', 'updates.auto.windows', 'updates.auto.daily'];

export function updateOutcome(result, error) {
  if (error) {
    const code = error && typeof error.code === 'string' ? error.code : '';
    if (BAD.has(code)) return { key: 'updates.err.' + code, kind: code === 'no_build' ? 'info' : 'error' };
    return { key: 'updates.failed', kind: 'error' };
  }
  return { key: (typeof result === 'string' && OK[result]) || 'updates.done', kind: 'info' };
}

/** The words for a last check's outcome (a success word, or the failure code's words). */
export function lastKey(outcome) {
  if (LAST[outcome]) return LAST[outcome];
  if (BAD.has(outcome)) return 'updates.err.' + outcome;
  return 'updates.failed';
}

/**
 * Settings › Updates from cc_updates_status (null = no status: the browser edition or an old shell).
 * → { edition: key, version, platform: key, from: key | null, last: {at, key} | null, latest: {same, version, notes} | null,
 *     check: {disabled, why: key | null}, install: {key} | null, auto: {shown, on} , autoNote: key | null }
 */
export function updatesView(st) {
  if (!st) return null;
  const from = st.source === 'package' ? FROM[st.route] || FROM.sideloaded : FROM[st.source] || null;
  const last = st.last && st.last.at ? st.last : null;
  const v = String(st.version || '');
  let latest = null;
  if (last) {
    const lv = String(last.latest || '');
    // The latest version for this edition is the one installed: the endpoint said 204 (outcome current) or named this version.
    if (last.outcome === 'current' || last.outcome === 'installed' || (lv && lv === v)) latest = { same: true, version: v, notes: '' };
    else if (lv) latest = { same: false, version: lv, notes: String(last.notes || '') };
  }
  const offer = latest && !latest.same && ['available', 'declined', 'install', 'network'].includes(last.outcome);
  const installKey = st.source === 'notify' ? 'updates.install.download' : st.route === 'store' ? 'updates.install.store' : 'updates.install';
  return {
    edition: EDITION[st.edition] || 'updates.edition.unknown',
    version: v,
    platform: PLATFORM[st.platform] || null,
    from,
    last: last ? { at: last.at, key: lastKey(last.outcome) } : null,
    latest,
    check: { disabled: !st.available || !!st.busy, why: !st.available ? 'updates.why.none' : st.busy ? 'updates.why.busy' : null },
    install: offer && st.available && !st.busy ? { key: installKey } : null,
    auto: { shown: !!st.autoAllowed, on: !!st.auto, hint: 'updates.auto.daily' },
    autoNote: st.available && !st.autoAllowed && st.source === 'package' && st.route === 'store' ? 'updates.auto.windows' : null,
  };
}
