'use strict';
// Parcel 2: every Parcel instance - the parcel command line (build, watch, serve) and the programmatic API - gets
// bundle-lockfile's reporter (parcel-reporter/), through the option Parcel's own command line adds its reporters with
// (additionalReporters): @parcel/core's lib/Parcel.js exports the class as its default, which is replaced by a subclass
// that adds the reporter to the options. Reporters run in the main process, after the bundles are written
// (buildSuccess); they are no part of Parcel's cache. The reporter lists the packages of the assets of every bundle,
// except those the scope-hoisting packager leaves out (no side effects, no used symbols, not referenced), and writes
// <target's distDir>/<BUNDLE_LOCKFILE_FILE>. A problem is thrown from the reporter: Parcel fails the build with it.
/** @import { Adapter, Package } from '../types' */
/**
 * What is read of Parcel's objects (@parcel/types BundleGraph, Bundle, Asset; @parcel/core's RequestTracker), as far as
 * every Parcel 2 has it; the rest is checked where it is read (skipped: an API that fails counts as not there).
 * @typedef {{ filePath?: unknown, type?: unknown, sideEffects?: unknown }} Asset
 * @typedef {{ type?: unknown, env?: { shouldScopeHoist?: unknown }, target?: { distDir?: unknown, name?: unknown }, bundleBehavior?: unknown,
 *   filePath?: unknown, getMainEntry?: () => Asset | null | undefined, traverseAssets(visit: (asset: Asset) => void): void }} Bundle
 * @typedef {{ getBundles(opts: { includeInline: boolean }): Bundle[], getUsedSymbols(asset: Asset): { size: number } | null | undefined,
 *   isAssetReferenced(bundle: Bundle, asset: Asset): boolean }} BundleGraph
 * @typedef {{ hasContentKey(key: string): boolean, getNodeIdByContentKey(key: string): number,
 *   getNodeIdsConnectedTo(id: number, edge: number): Iterable<number>, getNode(id: number): unknown,
 *   getInvalidations(id: number): Iterable<unknown> }} RequestGraph
 * @typedef {{ graph?: RequestGraph, options?: { projectRoot?: unknown } }} RequestTracker
 * @typedef {{ toProjectPath(root: string, file: string): string, fromProjectPath(root: string, file: string): string }} ProjectPath
 * @typedef {Bundle & { filePath: string }} WrittenBundle a bundle written to a file of its own
 * @typedef {{ dir: string, target: string, writer: string, files: Set<string>, sources: Set<string>, entries: Set<string>,
 *   bundles: WrittenBundle[], kinds: Map<string, string>, inlineJs: boolean }} Write
 */
const path = require('path');
const config = require('../core/config.cjs');
const packages = require('../core/packages.cjs');
const via = require('../core/via.cjs');
const outputs = require('../core/outputs.cjs');
const problems = require('../core/problems.cjs');
const { hashOf } = require('../core/hashes.cjs');
const { portable, inToolCache, real, JS, JS_CSS } = require('../core/paths.cjs');
const { versionIn } = require('../core/manifest.cjs');
const { createRequire } = require('module');
const { bundlerPackage } = require('../core/bundler.cjs');
const { isObject, isArray } = require('../core/values.cjs');

const PATCHED = Symbol.for('bundle-lockfile.parcel.patched');
const PARCEL = /[\\/]@parcel[\\/]core[\\/]lib[\\/]Parcel\.js$/;
const TRACKER = /[\\/]@parcel[\\/]core[\\/]lib[\\/]RequestTracker\.js$/;
const REPORTER = path.join(__dirname, 'parcel-reporter');
const CODE_TYPES = new Set(['js', 'jsx', 'ts', 'tsx', 'css', 'html', 'json']); // Parcel's asset types that are code
// @parcel/core's version, as the patched copy's package.json says (the record's bundler)
/** @type {string | null} */
let version = null;

// Files a transformer inlines into an asset - a Sass partial, a Less @import - are no assets of their own: the
// transformer records them as invalidations of the asset's request (asset.invalidateOnFileChange), which Parcel keeps
// in its request graph, also across builds (.parcel-cache: a cached asset is not transformed again). Each RequestTracker
// of this process (one per Parcel) is remembered when it runs a request; the reporter reads, for every bundled asset's
// file, the asset requests that file invalidates and the other files those requests depend on. (Weakly: the tracker of
// a Parcel that is gone, with its request graph, is no longer read nor kept.)
/** @type {Set<WeakRef<RequestTracker>>} */
const trackers = new Set();
/** @type {WeakSet<RequestTracker>} */
const tracked = new WeakSet();
/** @type {{ edge: number, projectPath: ProjectPath, isAsset: (node: unknown) => boolean } | null} */
let trackerApi = null; // of the RequestTracker module, see patchTracker
/** @param {unknown} exp @param {() => string} resolve */
function patchTracker(exp, resolve) {
  if (!isObject(exp) || exp[PATCHED]) return;
  const RT = exp.default;
  const proto = typeof RT === 'function' ? /** @type {{ prototype: unknown }} */ (RT).prototype : undefined;
  const edge = isObject(exp.requestGraphEdgeTypes) ? exp.requestGraphEdgeTypes.invalidated_by_update : undefined;
  /** @type {unknown} */
  let projectPath = null;
  try { projectPath = require(path.join(path.dirname(resolve()), 'projectPath.js')); } catch { /* checked below */ }
  if (!isObject(proto) || typeof proto.runRequest !== 'function' || typeof edge !== 'number'
    || !isObject(projectPath) || typeof projectPath.toProjectPath !== 'function' || typeof projectPath.fromProjectPath !== 'function') {
    problems.problem(`parcel: ${resolve()} is no RequestTracker bundle-lockfile knows (runRequest, requestGraphEdgeTypes, projectPath): the style sheets Parcel's transformers inline (Sass partials, Less @imports) would be missing`);
    return;
  }
  // an asset request: 2.0 - 2.8 keep the request in the node (type 'request', value.type 'asset_request'); later ones
  // its type (requestType, one of requestTypes)
  const assetType = isObject(exp.requestTypes) ? exp.requestTypes.asset_request : undefined;
  // (projectPath: its functions checked above)
  trackerApi = { edge, projectPath: /** @type {ProjectPath} */ (projectPath), isAsset: (n) => isObject(n) && (assetType != null ? n.requestType === assetType
    : n.type === 'request' && isObject(n.value) && n.value.type === 'asset_request') };
  const run = /** @type {(this: RequestTracker, ...args: unknown[]) => unknown} */ (proto.runRequest);
  /** @type {(this: RequestTracker, ...args: unknown[]) => unknown} */
  proto.runRequest = function (...args) {
    if (!tracked.has(this)) { tracked.add(this); trackers.add(new WeakRef(this)); }
    return run.apply(this, args);
  };
  exp[PATCHED] = true;
  config.debug('parcel: patched', resolve());
}

// Map(file -> the bundled asset's file it was inlined into) of the files Parcel's transformers inlined into the assets
// `sources` (absolute paths): the other files their asset requests depend on that core/packages.cjs inlinedFile counts
// (no code, no build tool's settings). null: no request graph of this project to read.
/**
 * @param {string} projectRoot
 * @param {Set<string>} sources
 * @returns {Map<string, string> | null}
 */
function inlinedOf(projectRoot, sources) {
  if (!trackerApi) return null;
  const { edge, projectPath, isAsset } = trackerApi;
  /** @type {RequestGraph[]} */
  const mine = [];
  for (const ref of trackers) {
    const t = ref.deref();
    if (!t) trackers.delete(ref);
    else if (t.graph && t.options && t.options.projectRoot === projectRoot) mine.push(t.graph);
  }
  if (!mine.length) return null;
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const graph of mine) {
    for (const src of sources) {
      const key = projectPath.toProjectPath(projectRoot, src);
      if (!graph.hasContentKey(key)) continue;
      for (const id of graph.getNodeIdsConnectedTo(graph.getNodeIdByContentKey(key), edge)) {
        if (!isAsset(graph.getNode(id))) continue;
        for (const inv of graph.getInvalidations(id)) {
          if (!isObject(inv) || inv.type !== 'file' || typeof inv.filePath !== 'string') continue;
          const f = projectPath.fromProjectPath(projectRoot, inv.filePath);
          if (f !== src && !sources.has(f) && !out.has(f) && packages.inlinedFile(f)) out.set(f, src);
        }
      }
    }
  }
  return out;
}

// The options of a new Parcel(), with the reporter (Parcel's own command line passes its reporters this way; one
// there already - configured by hand - is not added again). Resolved by its absolute path from the project (its root,
// or the working directory, as Parcel's), whose resolver Parcel uses: Yarn Plug'n'Play's resolves nothing from a
// directory outside the project.
/** @param {unknown} options @returns {unknown} */
function withReporter(options) {
  if (!isObject(options)) return options;
  const list = isArray(options.additionalReporters) ? options.additionalReporters : [];
  if (list.some(r => isObject(r) && r.packageName === REPORTER)) return options;
  config.debug('parcel: adding the reporter to a Parcel');
  const from = path.join(typeof options.projectRoot === 'string' ? options.projectRoot : process.cwd(), 'index');
  return { ...options, additionalReporters: [...list, { packageName: REPORTER, resolveFrom: from }] };
}

// The bundle leaves the asset out: the scope-hoisting packager of JavaScript bundles skips an asset without side
// effects, of which no symbol is used and that the bundle does not reference (ScopeHoistingPackager) - as listed by the
// public BundleGraph. No other packager skips assets (a style sheet of a package without side effects that another one
// @imports is in the CSS bundle). When in doubt (an API that is not there, or fails), it counts.
/** @param {BundleGraph} graph @param {Bundle} bundle @param {Asset} asset */
function skipped(graph, bundle, asset) {
  try {
    if (bundle.type !== 'js' || asset.sideEffects !== false || !bundle.env || !bundle.env.shouldScopeHoist) return false;
    const used = graph.getUsedSymbols(asset);
    if (!used || used.size !== 0) return false;
    return graph.isAssetReferenced(bundle, asset) === false;
  } catch { return false; }
}

// The writes of one buildSuccess, per distDir: { dir, target, writer, files (its bundles' files), sources (their
// assets' files), entries, bundles }. Inline bundles' assets are in the bundle they are inlined into.
/** @param {BundleGraph} graph @param {string} projectRoot @returns {Write[]} */
function collect(graph, projectRoot) {
  /** @type {Map<string, Write>} */
  const byDir = new Map();
  for (const bundle of graph.getBundles({ includeInline: true })) {
    const target = bundle.target;
    if (!target || typeof target.distDir !== 'string') continue;
    const dir = target.distDir;
    if (inToolCache(dir)) continue; // a tool's cache (core/paths.cjs)
    let w = byDir.get(dir);
    if (!w) {
      w = { dir, target: path.join(dir, config.file), writer: JSON.stringify(['parcel', target.name || null, portable(projectRoot, dir)]), files: new Set(), sources: new Set(), entries: new Set(), bundles: [], kinds: new Map(), inlineJs: false };
      byDir.set(dir, w);
    }
    if (bundle.bundleBehavior !== 'inline' && written(bundle)) { w.files.add(bundle.filePath); w.bundles.push(bundle); }
    else if (bundle.type === 'js') w.inlineJs = true;
    const main = typeof bundle.getMainEntry === 'function' && bundle.getMainEntry();
    if (main && typeof main.filePath === 'string') w.entries.add(main.filePath);
    bundle.traverseAssets((asset) => {
      if (typeof asset.filePath === 'string' && path.isAbsolute(asset.filePath) && !skipped(graph, bundle, asset)) {
        w.sources.add(asset.filePath);
        // (via, see core/via.cjs: an image or font is an asset of its own; code is a module of a bundle)
        if (typeof asset.type === 'string' && !CODE_TYPES.has(asset.type)) w.kinds.set(asset.filePath, 'asset');
      }
    });
  }
  return [...byDir.values()];
}
/** @param {Bundle} b @returns {b is WrittenBundle} */
function written(b) { return typeof b.filePath === 'string'; }

/**
 * @param {Write} w
 * @param {Package[]} pkgs
 * @param {string} context
 * @param {Parameters<typeof outputs.record>[5]} opts
 */
async function write(w, pkgs, context, opts) {
  try {
    outputs.record(w.target, w.writer, pkgs, context, [...w.files], { disk: true, ...opts });
  } catch (e) { problems.problem(`parcel: could not write ${w.target}`, e); return; }
  await outputs.land(w.target, w.writer, 'parcel');
}

// The package whose code Parcel writes into JavaScript bundles, around their assets' code (the prelude, parcelRequire,
// the module wrappers; see core/bundler.cjs): @parcel/packager-js, as Parcel resolves its plugins - from the default
// config (@parcel/config-default, which names it; pnpm installs it there only), else from the project, else from
// @parcel/core's copy. A problem without one.
/** @param {string} projectRoot */
function packagerOf(projectRoot) {
  const project = path.join(projectRoot, 'index');
  /** @type {string[]} */
  const froms = [];
  try { froms.push(createRequire(project).resolve('@parcel/config-default/package.json')); } catch { /* none */ }
  froms.push(project);
  if (parcelFile) froms.push(parcelFile);
  for (const from of froms) {
    try { return bundlerPackage('parcel', createRequire(from).resolve('@parcel/packager-js/package.json'), ['@parcel/packager-js']); } catch { /* next */ }
  }
  problems.problem(`parcel: ${projectRoot} resolves no @parcel/packager-js: the lockfile would miss the code Parcel writes into its JavaScript bundles`);
  return null;
}
/** @type {string | null} */
let parcelFile = null; // @parcel/core's lib/Parcel.js, as patched

// The reporter (parcel-reporter/index.cjs). Throws the problems (strict mode): Parcel fails the build. Each report is
// the build's own (core/problems.cjs within): problems of another Parcel of the process do not fail it.
/** @param {{ event: unknown, options: unknown }} opts */
const report = (opts) => problems.within({}, () => reportBuild(opts));
/** @param {{ event: unknown, options: unknown }} opts */
async function reportBuild({ event, options }) {
  if (!isObject(event) || event.type !== 'buildSuccess') return;
  const graph = /** @type {BundleGraph} */ (event.bundleGraph); // (a buildSuccess event's; what it lacks: a problem below)
  const root = isObject(options) ? options.projectRoot : undefined;
  const projectRoot = (typeof root === 'string' && root) || process.cwd();
  const context = real(projectRoot);
  /** @type {Write[]} */
  let writes = [];
  try { writes = collect(graph, projectRoot); } catch (e) { problems.problem('parcel: could not collect the bundled packages of the build', e); }
  for (const w of writes) {
    try {
      // the files transformers inlined into the bundled assets (Sass partials, Less @imports): with style sheets among
      // the assets, a build whose request graph cannot be read would miss them
      /** @type {Map<string, string> | null} */
      let graphInlined = null;
      try { graphInlined = inlinedOf(projectRoot, w.sources); } catch (e) { problems.problem(`parcel: could not read the request graph of ${projectRoot}`, e); }
      const inlined = graphInlined || /** @type {Map<string, string>} */ (new Map());
      if (!graphInlined && [...w.sources].some(f => packages.STYLE.test(f))) {
        problems.problem(`parcel: no request graph of ${projectRoot}: the style sheets Parcel's transformers inlined into ${w.dir} (Sass partials, Less @imports) would be missing`);
      }
      for (const [f] of inlined) { w.sources.add(f); w.kinds.set(f, packages.STYLE.test(f) ? 'style' : 'inlined'); }
      const result = packages.packagesOfFiles([...w.sources], { context, entries: [...w.entries] });
      const { byFile } = result;
      // (also a bundle inlined into one of them: a <script type="module"> in the HTML has Parcel's code around it too)
      const js = w.bundles.some(b => JS.test(b.filePath)) || w.inlineJs;
      const runtime = js ? [packagerOf(projectRoot)].filter(p => p !== null) : [];
      const all = packages.unique(result.all, runtime);
      const found = via.ofFiles(result, w.kinds);
      found.add('runtime', runtime);
      /** @type {Record<string, string>} */
      const hashes = {};
      /** @type {Record<string, string[]>} */
      const contents = {};
      for (const b of w.bundles) {
        if (!JS_CSS.test(b.filePath)) continue;
        const h = hashOf(b.filePath);
        if (!h) continue;
        hashes[b.filePath] = h;
        /** @type {Package[][]} */
        const own = []; // the packages of each asset's file (one list each)
        /** @type {Set<string>} */
        const into = new Set();
        b.traverseAssets((a) => {
          if (typeof a.filePath !== 'string' || skipped(graph, b, a)) return;
          into.add(a.filePath);
          own.push(byFile.get(a.filePath) || []);
        });
        for (const [f, src] of inlined) if (into.has(src)) own.push(byFile.get(f) || []);
        if (JS.test(b.filePath)) own.push(runtime);
        contents[b.filePath] = packages.uniqueOf(own).map(p => p.path);
      }
      // run: the Parcel's plugin options, one object per Parcel (its ReporterRunner's), the same in its rebuilds: another
      // Parcel of the process that wrote into the directory before is another run of the writer (core/outputs.cjs)
      await write(w, all, context, { outputs: hashes, contents, via: found, run: isObject(options) ? options : undefined,
        bundler: { name: 'parcel', ...(version ? { version } : {}) } });
    } catch (e) { problems.problem(`parcel: could not collect the bundled packages of ${w.dir}`, e); }
  }
  problems.failIfAny((err) => {
    // Parcel before 2.13 prints a reporter's error and goes on, the build succeeds (parcel#9735): the process fails at
    // its exit then
    if (!failsWithReporters()) problems.failAtExit(err.problems);
    throw err;
  });
}
// Parcel fails the build with a reporter's error from 2.13 on (an unknown version: as before)
function failsWithReporters() {
  const m = /^(\d+)\.(\d+)\./.exec(version || '');
  return !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 13));
}

// for the reporter (parcel-reporter/index.cjs)
/** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (globalThis))[Symbol.for('bundle-lockfile.parcel')] = { report };

module.exports = /** @satisfies {Adapter & Record<string, unknown>} */ ({
  name: 'parcel',
  cjsFiles: [PARCEL, TRACKER],
  cjsPackages: ['parcel', '@parcel/core'], // processes that build with it (see hooks.cjs installCjs)
  onCjsLoad(exp, request, resolve) {
    if (request.endsWith('RequestTracker.js') && TRACKER.test(request)) return patchTracker(exp, resolve);
    if (!request.endsWith('Parcel.js') || !PARCEL.test(request) || !isObject(exp) || exp[PATCHED]) return;
    const proto = typeof exp.default === 'function' ? /** @type {{ prototype: unknown }} */ (exp.default).prototype : undefined;
    if (!isObject(proto) || typeof proto.run !== 'function' || typeof proto.watch !== 'function') {
      problems.problem(`parcel: ${resolve()} exports no Parcel class bundle-lockfile knows (run, watch): its builds would write no lockfile`);
      return;
    }
    const Parcel = /** @type {new (options: unknown, ...rest: unknown[]) => object} */ (exp.default); // (a class: checked above)
    try {
      class BundleLockfileParcel extends Parcel {
        /** @param {unknown} options @param {unknown[]} rest */
        constructor(options, ...rest) { super(withReporter(options), ...rest); }
      }
      Object.defineProperty(BundleLockfileParcel, 'name', { value: Parcel.name });
      exp.default = BundleLockfileParcel;
      parcelFile = resolve();
      if (exp.Parcel === Parcel) exp.Parcel = BundleLockfileParcel;
      exp[PATCHED] = true;
      version = versionIn(path.join(path.dirname(resolve()), '..'));
      config.debug('parcel: patched', resolve(), version || '');
    } catch (e) { problems.problem(`parcel: could not patch ${resolve()}`, e); }
  },
  report,
  withReporter,
  inlinedOf,
  patchTracker,
  skipped,
  REPORTER,
});
