'use strict';
// Parcel 2: every Parcel instance - the parcel command line (build, watch, serve) and the programmatic API - gets
// bundle-lockfile's reporter (parcel-reporter/), through the option Parcel's own command line adds its reporters with
// (additionalReporters): @parcel/core's lib/Parcel.js exports the class as its default, which is replaced by a subclass
// that adds the reporter to the options. Reporters run in the main process, after the bundles are written
// (buildSuccess); they are no part of Parcel's cache. The reporter lists the packages of the assets of every bundle,
// except those the scope-hoisting packager leaves out (no side effects, no used symbols, not referenced), and writes
// <target's distDir>/<BUNDLE_LOCKFILE_FILE>. A problem is thrown from the reporter: Parcel fails the build with it.
const fs = require('fs');
const path = require('path');
const config = require('../core/config.cjs');
const packages = require('../core/packages.cjs');
const via = require('../core/via.cjs');
const outputs = require('../core/outputs.cjs');
const problems = require('../core/problems.cjs');
const { hashOf } = require('../core/hashes.cjs');
const { portable, inToolCache } = require('../core/paths.cjs');
const { createRequire } = require('module');
const { bundlerPackage } = require('../core/bundler.cjs');

const PATCHED = Symbol.for('bundle-lockfile.parcel.patched');
const PARCEL = /[\\/]@parcel[\\/]core[\\/]lib[\\/]Parcel\.js$/;
const TRACKER = /[\\/]@parcel[\\/]core[\\/]lib[\\/]RequestTracker\.js$/;
const REPORTER = path.join(__dirname, 'parcel-reporter');
const JS_CSS = /\.([cm]?js|css)$/i;
const CODE_TYPES = new Set(['js', 'jsx', 'ts', 'tsx', 'css', 'html', 'json']); // Parcel's asset types that are code
// @parcel/core's version, as the patched copy's package.json says (the record's bundler)
let version = null;

// Files a transformer inlines into an asset - a Sass partial, a Less @import - are no assets of their own: the
// transformer records them as invalidations of the asset's request (asset.invalidateOnFileChange), which Parcel keeps
// in its request graph, also across builds (.parcel-cache: a cached asset is not transformed again). Each RequestTracker
// of this process (one per Parcel) is remembered when it runs a request; the reporter reads, for every bundled asset's
// file, the asset requests that file invalidates and the other files those requests depend on.
const trackers = new Set();
/** @type {{ edge: number, projectPath: any, isAsset: (node: any) => boolean } | null} */
let trackerApi = null; // of the RequestTracker module, see patchTracker
function patchTracker(exp, resolve) {
  if (!exp || typeof exp !== 'object' || exp[PATCHED]) return;
  const RT = exp.default;
  const edge = exp.requestGraphEdgeTypes && exp.requestGraphEdgeTypes.invalidated_by_update;
  /** @type {any} */
  let projectPath = null;
  try { projectPath = require(path.join(path.dirname(resolve()), 'projectPath.js')); } catch { /* checked below */ }
  if (typeof RT !== 'function' || !RT.prototype || typeof RT.prototype.runRequest !== 'function' || typeof edge !== 'number'
    || !projectPath || typeof projectPath.toProjectPath !== 'function' || typeof projectPath.fromProjectPath !== 'function') {
    problems.problem(`parcel: ${resolve()} is no RequestTracker bundle-lockfile knows (runRequest, requestGraphEdgeTypes, projectPath): the style sheets Parcel's transformers inline (Sass partials, Less @imports) would be missing`);
    return;
  }
  // an asset request: 2.0 - 2.8 keep the request in the node (type 'request', value.type 'asset_request'); later ones
  // its type (requestType, one of requestTypes)
  const assetType = exp.requestTypes && exp.requestTypes.asset_request;
  trackerApi = { edge, projectPath, isAsset: (n) => !!n && (assetType != null ? n.requestType === assetType
    : n.type === 'request' && !!n.value && n.value.type === 'asset_request') };
  const run = RT.prototype.runRequest;
  RT.prototype.runRequest = function () { trackers.add(this); return run.apply(this, arguments); };
  exp[PATCHED] = true;
  config.debug('parcel: patched', resolve());
}

// Map(file -> the bundled asset's file it was inlined into) of the files Parcel's transformers inlined into the assets
// `sources` (absolute paths): the other files their asset requests depend on that core/packages.cjs inlinedFile counts
// (no code, no build tool's settings). null: no request graph of this project to read.
function inlinedOf(projectRoot, sources) {
  if (!trackerApi) return null;
  const { edge, projectPath, isAsset } = trackerApi;
  const mine = [...trackers].filter(t => t && t.graph && t.options && t.options.projectRoot === projectRoot);
  if (!mine.length) return null;
  const out = new Map();
  for (const { graph } of mine) {
    for (const src of sources) {
      const key = projectPath.toProjectPath(projectRoot, src);
      if (!graph.hasContentKey(key)) continue;
      for (const id of graph.getNodeIdsConnectedTo(graph.getNodeIdByContentKey(key), edge)) {
        if (!isAsset(graph.getNode(id))) continue;
        for (const inv of graph.getInvalidations(id)) {
          if (!inv || inv.type !== 'file' || typeof inv.filePath !== 'string') continue;
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
function withReporter(options) {
  if (!options || typeof options !== 'object') return options;
  const list = Array.isArray(options.additionalReporters) ? options.additionalReporters : [];
  if (list.some(r => r && r.packageName === REPORTER)) return options;
  config.debug('parcel: adding the reporter to a Parcel');
  const from = path.join(typeof options.projectRoot === 'string' ? options.projectRoot : process.cwd(), 'index');
  return { ...options, additionalReporters: [...list, { packageName: REPORTER, resolveFrom: from }] };
}

// The bundle leaves the asset out: the scope-hoisting packager skips an asset without side effects, of which no symbol
// is used and that the bundle does not reference (ScopeHoistingPackager) - as listed by the public BundleGraph. When in
// doubt (an API that is not there, or fails), it counts.
function skipped(graph, bundle, asset) {
  try {
    if (asset.sideEffects !== false || !bundle.env || !bundle.env.shouldScopeHoist) return false;
    const used = graph.getUsedSymbols(asset);
    if (!used || used.size !== 0) return false;
    return graph.isAssetReferenced(bundle, asset) === false;
  } catch { return false; }
}

// The writes of one buildSuccess, per distDir: { dir, target, writer, files (its bundles' files), sources (their
// assets' files), entries, bundles }. Inline bundles' assets are in the bundle they are inlined into.
function collect(graph, projectRoot) {
  const byDir = new Map();
  for (const bundle of graph.getBundles({ includeInline: true })) {
    const dir = bundle.target && bundle.target.distDir;
    if (typeof dir !== 'string') continue;
    if (inToolCache(dir)) continue; // a tool's cache (core/paths.cjs)
    let w = byDir.get(dir);
    if (!w) {
      w = { dir, target: path.join(dir, config.file), writer: JSON.stringify(['parcel', bundle.target.name || null, portable(projectRoot, dir)]), files: new Set(), sources: new Set(), entries: new Set(), bundles: [], kinds: new Map() };
      byDir.set(dir, w);
    }
    if (bundle.bundleBehavior !== 'inline' && typeof bundle.filePath === 'string') { w.files.add(bundle.filePath); w.bundles.push(bundle); }
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
function packagerOf(projectRoot) {
  const project = path.join(projectRoot, 'index');
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
let parcelFile = null; // @parcel/core's lib/Parcel.js, as patched

// The reporter (parcel-reporter/index.cjs). Throws the problems (strict mode): Parcel fails the build. Each report is
// the build's own (core/problems.cjs within): problems of another Parcel of the process do not fail it.
/** @param {{ event: any, options: any }} opts */
const report = (opts) => problems.within({}, () => reportBuild(opts));
async function reportBuild({ event, options }) {
  if (!event || event.type !== 'buildSuccess') return;
  const projectRoot = (options && options.projectRoot) || process.cwd();
  let context = projectRoot;
  try { context = fs.realpathSync(projectRoot); } catch { /* as it is */ }
  let writes = [];
  try { writes = collect(event.bundleGraph, projectRoot); } catch (e) { problems.problem('parcel: could not collect the bundled packages of the build', e); }
  for (const w of writes) {
    try {
      // the files transformers inlined into the bundled assets (Sass partials, Less @imports): with style sheets among
      // the assets, a build whose request graph cannot be read would miss them
      /** @type {Map<string, string> | null} */
      let graphInlined = null;
      try { graphInlined = inlinedOf(projectRoot, w.sources); } catch (e) { problems.problem(`parcel: could not read the request graph of ${projectRoot}`, e); }
      const inlined = graphInlined || new Map();
      if (!graphInlined && [...w.sources].some(f => packages.STYLE.test(f))) {
        problems.problem(`parcel: no request graph of ${projectRoot}: the style sheets Parcel's transformers inlined into ${w.dir} (Sass partials, Less @imports) would be missing`);
      }
      for (const [f] of inlined) { w.sources.add(f); w.kinds.set(f, packages.STYLE.test(f) ? 'style' : 'inlined'); }
      const result = packages.packagesOfFiles([...w.sources], { context, entries: [...w.entries] });
      const { byFile } = result;
      const js = w.bundles.some(b => /\.[cm]?js$/i.test(b.filePath));
      const runtime = js ? [packagerOf(projectRoot)].filter(p => p !== null) : [];
      const all = packages.unique(result.all, runtime);
      const found = via.ofFiles(result, w.kinds);
      found.add('runtime', runtime);
      const hashes = {}, contents = {};
      for (const b of w.bundles) {
        if (!JS_CSS.test(b.filePath)) continue;
        const h = hashOf(b.filePath);
        if (!h) continue;
        hashes[b.filePath] = h;
        const own = [];
        const into = new Set();
        b.traverseAssets((a) => {
          if (typeof a.filePath !== 'string' || skipped(event.bundleGraph, b, a)) return;
          into.add(a.filePath);
          own.push(...(byFile.get(a.filePath) || []));
        });
        for (const [f, src] of inlined) if (into.has(src)) own.push(...(byFile.get(f) || []));
        contents[b.filePath] = packages.unique(own, /\.[cm]?js$/i.test(b.filePath) ? runtime : []).map(p => p.path);
      }
      await write(w, all, context, { outputs: hashes, contents, via: found,
        bundler: { name: 'parcel', ...(version ? { version } : {}) } });
    } catch (e) { problems.problem(`parcel: could not collect the bundled packages of ${w.dir}`, e); }
  }
  problems.failIfAny((err) => { throw err; });
}

// for the reporter (parcel-reporter/index.cjs)
globalThis[Symbol.for('bundle-lockfile.parcel')] = { report };

module.exports = {
  name: 'parcel',
  cjsFiles: [PARCEL, TRACKER],
  cjsPackages: ['parcel', '@parcel/core'], // processes that build with it (see hooks.cjs installCjs)
  onCjsLoad(exp, request, resolve) {
    if (request.endsWith('RequestTracker.js') && TRACKER.test(request)) return patchTracker(exp, resolve);
    if (!request.endsWith('Parcel.js') || !PARCEL.test(request) || !exp || typeof exp !== 'object' || exp[PATCHED]) return;
    const Parcel = exp.default;
    if (typeof Parcel !== 'function' || !Parcel.prototype || typeof Parcel.prototype.run !== 'function' || typeof Parcel.prototype.watch !== 'function') {
      problems.problem(`parcel: ${resolve()} exports no Parcel class bundle-lockfile knows (run, watch): its builds would write no lockfile`);
      return;
    }
    try {
      class BundleLockfileParcel extends Parcel { constructor(options, ...rest) { super(withReporter(options), ...rest); } }
      Object.defineProperty(BundleLockfileParcel, 'name', { value: Parcel.name });
      exp.default = BundleLockfileParcel;
      parcelFile = resolve();
      if (exp.Parcel === Parcel) exp.Parcel = BundleLockfileParcel;
      exp[PATCHED] = true;
      try { version = JSON.parse(fs.readFileSync(path.join(path.dirname(resolve()), '../package.json'), 'utf8')).version || null; } catch { /* unknown */ }
      config.debug('parcel: patched', resolve(), version || '');
    } catch (e) { problems.problem(`parcel: could not patch ${resolve()}`, e); }
  },
  report,
  withReporter,
  inlinedOf,
  patchTracker,
  skipped,
  REPORTER,
};
