'use strict';
// Angular's application builder (@angular/build 18+, also the copy @angular-devkit/build-angular 17 has): ng build and
// ng serve bundle with esbuild into memory (write: false) and Angular writes the files itself, after its own steps
// (the chunk optimizer re-bundles chunks with Rolldown, i18n inlines translations into copies per locale). So the
// esbuild level cannot place the lockfile: executeBuild() - the function that runs one build and returns its output
// files - is wrapped. It runs with the stats option on (its browser-stats.json and server-stats.json are Angular's
// final metafiles, after the optimizer; taken out of the output again unless the build asked for them), the inputs of
// their outputs and the build's asset files (copied from node_modules too) are mapped to packages, and the lockfile is
// added to the build's output files: <outputPath>/<browser>/<BUNDLE_LOCKFILE_FILE>, and with SSR
// <outputPath>/<server>/<BUNDLE_LOCKFILE_FILE>, which Angular writes with the rest (after it cleaned the output path).
// A problem is an error of the build.
const path = require('path');
const config = require('../core/config.cjs');
const packages = require('../core/packages.cjs');
const outputs = require('../core/outputs.cjs');
const problems = require('../core/problems.cjs');
const { portable, exportPath, real, JS } = require('../core/paths.cjs');
const { versionIn } = require('../core/manifest.cjs');
const { getOr } = require('../core/maps.cjs');
const { createRequire } = require('module');
const { collect: collectMetafile, entryFiles } = require('./esbuild.cjs');
const { bundlerPackage } = require('../core/bundler.cjs');
const { stubsOf } = require('../core/tree.cjs');

const PATCHED = Symbol.for('bundle-lockfile.angular.patched');
const EXECUTE_BUILD = /[\\/](@angular[\\/]build|@angular-devkit[\\/]build-angular)[\\/]src[\\/]builders[\\/]application[\\/]execute-build\.js$/;
// Angular's BuildOutputFileType (tools/esbuild/bundler-files): where a file of the result goes
const TYPE = { Browser: 0, Media: 1, ServerApplication: 2, ServerRoot: 3, Root: 4 };
// a file's side: Browser and Media files Angular writes in the browser's directory, ServerApplication and ServerRoot
// files in the server's (generateFullPath, builders/application/index.js)
const sideOfType = (t) => (t === TYPE.Browser || t === TYPE.Media ? 'browser' : t === TYPE.ServerApplication || t === TYPE.ServerRoot ? 'server' : null);
// its metafiles with the stats option: one per side (22 and later), or both sides in one (stats.json: 17 - 21)
const STATS = { browser: 'browser-stats.json', server: 'server-stats.json', both: 'stats.json' };
// the version of the builder whose executeBuild() was wrapped (@angular/build, or @angular-devkit/build-angular 17), as
// its package.json says: the record's bundler
/** @type {string | null} */
let version = null;
// the esbuild the builder bundles with (the one its package resolves): its runtime helpers are in the JavaScript files
// (see core/bundler.cjs); Angular's chunk optimizer (Rolldown) is not listed
/** @type {string | null} */
let esbuildFile = null;

// The lockfile of one side (browser or server) of a build: its packages, rendered (core/outputs.cjs, the writers of
// that path); what lands it (its export copy written) added to `lands`, for once the build is known not to fail.
// Returns the content Angular writes, or null.
/** @param {(() => Promise<void> | void)[]} lands */
function render(side, target, writer, pkgs, context, files, found, lands) {
  const content = outputs.record(target, writer, pkgs, context, files, { disk: true, via: found,
    bundler: { name: 'angular', ...(version ? { version } : {}) } });
  // Angular writes the lockfile in the output; bundle-lockfile its export copy
  if (exportPath(target)) lands.push(() => outputs.land(target, writer, 'angular', { writeFile: null, prune: false }));
  else {
    lands.push(() => {
      outputs.emitted(target, writer);
      if (!config.inline) outputs.nowhere();
    });
  }
  config.debug(`angular: the ${side} lockfile`, target, 'with', pkgs.length, 'packages');
  return content;
}

// The esbuild package of the builder (as its package resolves it), else of the workspace (an executeBuild wrapped by
// hand); none: a problem
function esbuildOf(wd) {
  let file = esbuildFile;
  if (!file) try { file = createRequire(path.join(wd, 'x')).resolve('esbuild/package.json'); } catch { /* none */ }
  if (file) return bundlerPackage('angular', file, ['esbuild']);
  problems.problem(`angular: neither its builder nor ${wd} resolves esbuild: the lockfile would miss it, whose code is in the output`);
  return null;
}

// The result of executeBuild: the lockfiles added to its output files; problems as its errors. lands: what lands them
// (writes the export copies) is added to it.
/** @param {(() => Promise<void> | void)[]} lands */
function complete(options, result, forced, lands) {
  const files = Array.isArray(result.outputFiles) ? result.outputFiles : [];
  const stats = {};
  for (const [side, name] of Object.entries(STATS)) {
    const i = files.findIndex(f => f && f.path === name && f.type === TYPE.Root);
    if (i < 0) continue;
    try { stats[side] = JSON.parse(files[i].text); } catch (e) { problems.problem(`angular: could not read its ${name}`, e); }
    if (forced) files.splice(i, 1); // the build did not ask for it
  }
  if ((result.errors && result.errors.length) || !files.length) return; // a failed build writes nothing
  const out = options.outputOptions;
  const wd = options.workspaceRoot;
  if (!out || typeof out.base !== 'string' || typeof wd !== 'string') {
    problems.problem('angular: a build without outputOptions and workspaceRoot bundle-lockfile knows: its lockfile would be missing');
    return;
  }
  // i18n (localize): Angular inlines the translations into a copy of each side's output per locale, in <subPath>/ of
  // its directory (unless flatOutput): every copy gets the lockfile. The metafile is the one before inlining - the same
  // packages for every locale.
  const i18n = options.i18nOptions;
  let locales = [''];
  if (i18n && i18n.shouldInline && i18n.flatOutput !== true) {
    locales = [...(i18n.inlineLocales || [])].map(l => i18n.locales && i18n.locales[l] && i18n.locales[l].subPath);
    if (!locales.length || locales.some(s => typeof s !== 'string')) {
      problems.problem('angular: an i18n build whose locales have no subPath bundle-lockfile knows: its lockfiles would be missing');
      return;
    }
  }
  const unlocalized = (p) => { for (const l of locales) if (l && p.startsWith(`${l}/`)) return p.slice(l.length + 1); return p; };
  // the side's directory in the output path: its name, '' for the output path itself (browser: '', as the browser-esbuild
  // builder of @angular-devkit/build-angular always has it; Angular fills in the defaults, browser and server)
  /** @param {string} side */
  const dirName = (side) => (typeof out[side] === 'string' ? out[side] : side);
  // the combined metafile of Angular 17 - 21: both sides' outputs, keyed by their paths in their own directory
  // (main.server.mjs, not server/main.server.mjs): each output is the side whose output files have its path - an
  // output of both (the same name) counts for both. One no output file has (none Angular writes) counts for the browser
  // in a build without a server, else for both: a package listed too many beats a missing one.
  if (stats.both && !stats.browser) {
    const sideOf = new Map();
    for (const f of files) {
      if (!f || typeof f.path !== 'string') continue;
      const side = sideOfType(f.type);
      if (!side) continue;
      const key = unlocalized(f.path); // (with i18n: <subPath>/main.js is main.js of the metafile)
      getOr(sideOf, key, () => new Set()).add(side);
    }
    const ssr = [...sideOf.values()].some(s => s.has('server'));
    const split = { browser: {}, server: {} };
    for (const [k, v] of Object.entries(stats.both.outputs || {})) {
      const sides = sideOf.get(k) || (ssr ? ['browser', 'server'] : ['browser']);
      if (!sideOf.has(k)) config.debug('angular: an output of its metafile without an output file:', k, '- counted for', [...sides].join(' and '));
      for (const side of sides) split[side][k] = v;
    }
    stats.browser = { outputs: split.browser };
    if (Object.keys(split.server).length) stats.server = { outputs: split.server };
  }
  if (!stats.browser) { problems.problem('angular: a build without its stats metafile (the stats option): its packages are unknown'); return; }
  const context = real(wd);
  const assets = (Array.isArray(result.assetFiles) ? result.assetFiles : []).map(a => a && a.source).filter(s => typeof s === 'string' && path.isAbsolute(s));
  for (const side of ['browser', 'server']) {
    const metafile = stats[side];
    if (!metafile) continue;
    // a server Angular does not write (outputMode static: prerendering only; no SSR entry) ships nothing: no lockfile
    if (side === 'server' && out.ignoreServer) { config.debug('angular: the server output is not written (ignoreServer): no server lockfile'); continue; }
    // (via, see core/via.cjs: the outputs' inputs are chunks, files they inline style or inlined, Angular's asset copies
    // assets)
    // the side's files, by their path in its directory: the browser's also its media (fonts and images of its style
    // sheets), the server's are the application's and its SSR entry bundle's (ServerRoot: server.mjs and its chunks,
    // which i18n writes once, not per locale)
    const sideFiles = files.filter(f => f && typeof f.path === 'string' && sideOfType(f.type) === side);
    // The packages, via and all of the outputs `keys` of the side's metafile (with its asset copies: browser)
    const collect = (keys, withAssets) => {
      const sub = { ...metafile, outputs: Object.fromEntries(Object.entries(metafile.outputs || {}).filter(([k]) => keys.has(k))) };
      const { all, found } = collectMetafile(sub, wd, entryFiles(sub, wd), undefined, withAssets ? assets : []);
      // the bundler's own code (esbuild's runtime helpers) in every output that has JavaScript (see core/bundler.cjs)
      const runtime = [...keys].some(k => JS.test(k)) ? [esbuildOf(wd)].filter(p => p !== null) : [];
      found.add('runtime', runtime);
      return { all: packages.unique(all, runtime), found };
    };
    const file = config.file.split(path.sep).join('/');
    const write = (label, dir, writer, own, { all, found }, locale) => {
      const content = render(label, path.join(dir, config.file), JSON.stringify(writer), all, context, own, found, lands);
      // Angular 17 - 21 key the files they write by their path in their side's directory, so a browser and a server
      // file of the same name are one (the one added last): the server's lockfile is a file of the output path's root,
      // at <server>/<file> (written also where Angular skips server files: it is not added for those, see above). With
      // the server's files in the output path itself (server: ''), that is <file>, the browser's path in its directory:
      // the browser's lockfile is then a root file too, at <browser>/<file> (Angular requires the two to differ).
      if (content !== null && config.inline && typeof result.addOutputFile === 'function') {
        const root = side === 'server' || (dirName('server') === '' && !!stats.server && !out.ignoreServer);
        const at = root ? path.posix.join(dirName(side), locale, file) : path.posix.join(locale, file);
        const type = root ? TYPE.Root : TYPE.Browser;
        result.addOutputFile(at, content, type);
        // its package.json tree (BUNDLE_LOCKFILE_TREE, core/tree.cjs): Angular writes it with the lockfile
        if (config.tree !== 'off') {
          try {
            for (const [rel, stub] of stubsOf(content)) result.addOutputFile(path.posix.join(path.posix.dirname(at), rel), stub, type);
          } catch (e) { problems.problem(`angular: could not write the package.json tree of ${path.join(dir, config.file)}`, e); }
        }
      }
    };
    const sideDir = path.join(out.base, dirName(side));
    const keys = new Set(Object.keys(metafile.outputs || {}));
    if (locales.length === 1 && !locales[0]) {
      write(side, sideDir, ['angular', side, portable(context, out.base)], sideFiles.map(f => path.join(sideDir, f.path)), collect(keys, side === 'browser'), '');
      continue;
    }
    // i18n: the outputs Angular writes once, in the side's own directory (with server-side rendering: the server's
    // entry, server.mjs, and its chunks), get a lockfile there; those it copies per locale one in each locale's. An
    // output of the metafile no file names counts for both: a package listed too many beats a missing one.
    // A locale whose subPath is '' has its copy in the side's own directory: one lockfile there, for both.
    const atRoot = new Set(sideFiles.filter(f => !locales.some(l => l && f.path.startsWith(`${l}/`))).map(f => f.path));
    const perLocale = new Set(sideFiles.map(f => unlocalized(f.path)).filter((p, i) => sideFiles[i].path !== p));
    const rootKeys = new Set([...keys].filter(k => atRoot.has(k) || !perLocale.has(k)));
    const localeKeys = new Set([...keys].filter(k => perLocale.has(k) || !atRoot.has(k)));
    const rootLocale = locales.includes('');
    if (atRoot.size && (rootKeys.size || rootLocale)) {
      write(rootLocale ? `${side} (and its locale at the root)` : side, sideDir, ['angular', side, portable(context, out.base)], [...atRoot].map(p => path.join(sideDir, p)),
        rootLocale ? collect(new Set([...rootKeys, ...localeKeys]), side === 'browser') : collect(rootKeys, false), '');
    }
    const ofLocales = collect(localeKeys, side === 'browser');
    for (const locale of locales) {
      if (!locale) continue; // (its lockfile is the side's, above)
      const own = sideFiles.filter(f => f.path.startsWith(`${locale}/`)).map(f => path.join(sideDir, f.path));
      write(`${side} (${locale})`, path.join(sideDir, locale), ['angular', side, locale, portable(context, out.base)], own, ofLocales, locale);
    }
  }
}

// The builders that run the application build for output nobody ships: the dev server (ng serve) serves it from memory
// (as vite dev), extract-i18n only reads its messages, karma (ng test) writes it to a temporary directory and removes it,
// unit-test (Vitest) keeps it in memory. Their builds get no lockfile, nor stats (which the dev server turns off: they
// would make it reload instead of replacing modules). Known by the name of the builder the build runs for
// (context.builder.builderName, "<package>:<builder>"; also the same builders of other packages, as
// @angular-builders/custom-esbuild's dev-server); a build without one (executeBuild called by hand) writes.
const NOT_SHIPPED = new Set(['dev-server', 'extract-i18n', 'karma', 'unit-test']);
/** @returns {string | null} */
function notShipped(context) {
  const name = context && typeof context === 'object' && context.builder && context.builder.builderName;
  return typeof name === 'string' && NOT_SHIPPED.has(name.slice(name.lastIndexOf(':') + 1)) ? name : null;
}

function wrap(executeBuild) {
  const owner = {}; // the builds and rebuilds of this builder (core/problems.cjs within)
  return /** @this {unknown} */ function bundleLockfileExecuteBuild(options, context, ...rest) {
    return problems.within(owner, () => build.call(this, options, context, ...rest));
  };
  /** @this {unknown} */
  async function build(options, context, ...rest) {
    const skip = notShipped(context);
    if (skip) {
      config.debug(`angular: a build of ${skip}, whose output nobody ships: no lockfile`);
      return executeBuild.call(this, options, context, ...rest);
    }
    const forced = !!options && typeof options === 'object' && !options.stats;
    const result = await executeBuild.call(this, forced ? { ...options, stats: true } : options, context, ...rest);
    if (!result || typeof result !== 'object') return result;
    /** @param {Error} err */
    const fail = (err) => {
      if (typeof result.addError === 'function') result.addError(err.message.replace(/\n$/, ''));
      else throw err;
    };
    /** @type {(() => Promise<void> | void)[]} */
    const lands = [];
    try { complete(options, result, forced, lands); } catch (e) { problems.problem('angular: could not collect the bundled packages', e); }
    // a build that fails writes nothing (Angular writes no output files then): nor the export copies
    if (problems.failIfAny(fail)) return result;
    await Promise.all(lands.map(l => l())); // (never reject) the export copies written: what went wrong there fails the build too
    problems.failIfAny(fail);
    return result;
  }
}

module.exports = {
  name: 'angular',
  cjsFiles: [EXECUTE_BUILD],
  // processes that build with Angular's builder: ng build (@angular/cli), the builder's packages (see hooks.cjs installCjs)
  cjsPackages: ['@angular/cli', '@angular/build', '@angular-devkit/build-angular'],
  onCjsLoad(exp, request, resolve) {
    if (!request.endsWith('execute-build.js') || !EXECUTE_BUILD.test(request) || !exp || typeof exp !== 'object' || exp[PATCHED]) return;
    if (typeof exp.executeBuild !== 'function') {
      problems.problem(`angular: ${resolve()} exports no executeBuild() bundle-lockfile knows: its builds would write no lockfile`);
      return;
    }
    try {
      exp.executeBuild = wrap(exp.executeBuild);
      exp[PATCHED] = true;
      version = versionIn(path.join(path.dirname(resolve()), '../../..'));
      try { esbuildFile = createRequire(resolve()).resolve('esbuild/package.json'); } catch { /* reported when a build writes JavaScript */ }
      config.debug('angular: wrapped executeBuild() of', resolve(), version || '');
    } catch (e) { problems.problem(`angular: could not wrap ${resolve()}`, e); }
  },
  wrap,
};
