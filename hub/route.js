/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — no words here; the hub words every result through its language file. */
/**
 * route.js — which app opens a file (docs/0.4-PART2.md H.5, W2.13). DOM-free; the hub (hub.js) and the tests use it.
 *
 *   route('Level 1.dwg', { apps: ['cadcraft', …], always: { pdf: 'markupcraft' } })
 *     → { ext: 'dwg', known: true, apps: ['cadcraft', 'bimcraft', …], app: 'cadcraft', ask: false }
 *   route('Plans.pdf', { apps }) → { ext: 'pdf', apps: ['markupcraft', 'takeoffcraft'], app: null, ask: true }
 *
 * `apps` = the apps this suite holds (an app left out of a build is never offered). `always` = the person's "always use"
 * choices, by extension. `app` is who opens it now; `ask` = the hub asks first (PDF: review or takeoff) unless an
 * "always use" choice answers. The other apps in `apps` are offered as "Open in …".
 */

/** Extension → apps that open it, the first being the default. ask: the hub asks (no sensible default). */
export const ROUTES = Object.freeze({
  dwg: { apps: ['cadcraft', 'bimcraft', 'modelcraft', 'civilcraft'] },
  dxf: { apps: ['cadcraft', 'bimcraft', 'modelcraft', 'civilcraft'] },
  ccsheets: { apps: ['cadcraft'] },                                           // W2.13: CadCraft sheet sets
  pln: { apps: ['bimcraft', 'cadcraft'] }, pla: { apps: ['bimcraft', 'cadcraft'] },   // Archicad (track N)
  tpl: { apps: ['bimcraft', 'cadcraft'] }, bpn: { apps: ['bimcraft', 'cadcraft'] },
  ifc: { apps: ['bimcraft', 'detailcraft'] }, ifczip: { apps: ['bimcraft'] },
  rvt: { apps: ['bimcraft'] }, rfa: { apps: ['bimcraft'] }, rte: { apps: ['bimcraft'] }, rft: { apps: ['bimcraft'] },
  bcf: { apps: ['bimcraft'] }, bcfzip: { apps: ['bimcraft'] },
  modelcraft: { apps: ['modelcraft'] }, dae: { apps: ['modelcraft'] }, obj: { apps: ['modelcraft'] },
  glb: { apps: ['modelcraft'] }, gltf: { apps: ['modelcraft'] }, stl: { apps: ['modelcraft', 'partcraft'] },
  pdf: { apps: ['markupcraft', 'takeoffcraft'], ask: true },
  'takeoff.json': { apps: ['takeoffcraft'] },
  landxml: { apps: ['civilcraft'] }, xml: { apps: ['civilcraft'] }, geojson: { apps: ['civilcraft'] },
  kml: { apps: ['civilcraft'] }, kmz: { apps: ['civilcraft'] }, shp: { apps: ['civilcraft'] }, gpkg: { apps: ['civilcraft'] },
  las: { apps: ['civilcraft'] }, laz: { apps: ['civilcraft'] }, tif: { apps: ['civilcraft'] }, tiff: { apps: ['civilcraft'] },
  nc1: { apps: ['detailcraft'] }, nc: { apps: ['detailcraft'] },
  step: { apps: ['partcraft'] }, stp: { apps: ['partcraft'] }, craft: { apps: ['partcraft'] },
});

/** "Plan.DWG" → "dwg"; "Job.takeoff.json" → "takeoff.json" (a known two-part type wins); no dot → "". */
export function extOf(name) {
  const n = String(name || '').trim().toLowerCase().split(/[\\/]/).pop() || '';
  const parts = n.split('.');
  if (parts.length < 2 || (parts.length === 2 && parts[0] === '')) return '';
  if (parts.length >= 3) {
    const two = parts.slice(-2).join('.');
    if (Object.prototype.hasOwnProperty.call(ROUTES, two)) return two;
  }
  return parts[parts.length - 1];
}

/** Every extension the suite's apps open (for the open dialog's filter and the drop zone). */
export function knownExtensions(apps = null) {
  return Object.keys(ROUTES).filter((e) => !apps || ROUTES[e].apps.some((a) => apps.includes(a)));
}

/** Who opens `name`. */
export function route(name, { apps = null, always = {} } = {}) {
  const ext = extOf(name);
  const r = Object.prototype.hasOwnProperty.call(ROUTES, ext) ? ROUTES[ext] : null;
  if (!r) return { ext, known: false, apps: [], app: null, ask: false };
  const list = r.apps.filter((a) => !apps || apps.includes(a));
  if (!list.length) return { ext, known: true, apps: [], app: null, ask: false };
  const pick = always && typeof always[ext] === 'string' && list.includes(always[ext]) ? always[ext] : null;
  if (pick) return { ext, known: true, apps: [pick, ...list.filter((a) => a !== pick)], app: pick, ask: false };
  const ask = !!r.ask && list.length > 1;
  return { ext, known: true, apps: list, app: ask ? null : list[0], ask };
}

/** Split several files into one batch per app (files that need a question are returned apart). */
export function group(names, opts = {}) {
  const byApp = new Map();
  const ask = [];
  const unknown = [];
  names.forEach((n, i) => {
    const r = route(n, opts);
    if (r.ask) ask.push({ i, name: n, route: r });
    else if (!r.app) unknown.push({ i, name: n, route: r });
    else { if (!byApp.has(r.app)) byApp.set(r.app, []); byApp.get(r.app).push(i); }
  });
  return { byApp, ask, unknown };
}

/** Validate a stored "always use" map (localStorage is the person's own, but still a string). */
export function cleanAlways(raw, apps = null) {
  let o = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { o = null; } }
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const [ext, app] of Object.entries(o)) {
    if (!Object.prototype.hasOwnProperty.call(ROUTES, ext) || typeof app !== 'string') continue;
    if (!ROUTES[ext].apps.includes(app) || (apps && !apps.includes(app))) continue;
    out[ext] = app;
  }
  return out;
}
