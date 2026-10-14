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
const fs = require('fs');
const path = require('path');
const config = require('../core/config.cjs');
const packages = require('../core/packages.cjs');
const via = require('../core/via.cjs');
const outputs = require('../core/outputs.cjs');
const problems = require('../core/problems.cjs');
const { portable, exportPath } = require('../core/paths.cjs');
const { createRequire } = require('module');
const { filesOfOutputs, fileOfInput } = require('./esbuild.cjs');
const { bundlerPackage } = require('../core/bundler.cjs');

const PATCHED = Symbol.for('bundle-lockfile.angular.patched');
const EXECUTE_BUILD = /[\\/](@angular[\\/]build|@angular-devkit[\\/]build-angular)[\\/]src[\\/]builders[\\/]application[\\/]execute-build\.js$/;
// Angular's BuildOutputFileType (tools/esbuild/bundler-files): where a file of the result goes
const TYPE = { Browser: 0, ServerApplication: 2, ServerRoot: 3, Root: 4 };
// its metafiles with the stats option: one per side (22 and later), or both sides in one (stats.json: 17 - 21)
const STATS = { browser: 'browser-stats.json', server: 'server-stats.json', both: 'stats.json' };
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
// the version of the builder whose executeBuild() was wrapped (@angular/build, or @angular-devkit/build-angular 17), as
// its package.json says: the record's bundler
let version = null;
// the esbuild the builder bundles with (the one its package resolves): its runtime helpers are in the JavaScript files
// (see core/bundler.cjs); Angular's chunk optimizer (Rolldown) is not listed
let esbuildFile = null;

// The lockfile of one side (browser or server) of a build: its packages, rendered (core/outputs.cjs, the writers of
// that path), and its export copy written; returns the content Angular writes, or null.
function render(side, target, writer, pkgs, context, files, found) {
  const content = outputs.record(target, writer, pkgs, context, files, { disk: true, via: found,
    bundler: { name: 'angular', ...(version ? { version } : {}) } });
  outputs.emitted(target, writer);
  if (exportPath(target)) {
    outputs.rewrite(target, null, (err) => {
      if (err) problems.problem(`angular: could not write the export copy of ${target}`, err);
      else config.debug('angular: wrote', exportPath(target));
    });
  } else if (!config.inline) outputs.nowhere();
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

// The result of executeBuild: the lockfiles added to its output files; problems as its errors
function complete(options, result, forced) {
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
  // the combined metafile of Angular 17 - 21: both sides' outputs, keyed by their paths in their own directory
  // (main.server.mjs, not server/main.server.mjs): each output is the side whose output files have its path - an
  // output of both (the same name) counts for both. One no output file has (none Angular writes) counts for the browser
  // in a build without a server, else for both: a package listed too many beats a missing one.
  if (stats.both && !stats.browser) {
    const sideOf = new Map();
    for (const f of files) {
      if (!f || typeof f.path !== 'string') continue;
      const side = f.type === TYPE.Browser ? 'browser' : f.type === TYPE.ServerApplication || f.type === TYPE.ServerRoot ? 'server' : null;
      if (!side) continue;
      if (!sideOf.has(f.path)) sideOf.set(f.path, new Set());
      sideOf.get(f.path).add(side);
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
  const context = realOr(wd);
  const assets = (Array.isArray(result.assetFiles) ? result.assetFiles : []).map(a => a && a.source).filter(s => typeof s === 'string' && path.isAbsolute(s));
  for (const side of ['browser', 'server']) {
    const metafile = stats[side];
    if (!metafile) continue;
    // a server Angular does not write (outputMode static: prerendering only; no SSR entry) ships nothing: no lockfile
    if (side === 'server' && out.ignoreServer) { config.debug('angular: the server output is not written (ignoreServer): no server lockfile'); continue; }
    // (via, see core/via.cjs: the outputs' inputs are chunks, files they inline style or inlined, Angular's asset copies
    // assets)
    const kinds = new Map();
    const sources = [...new Set([...filesOfOutputs(metafile, wd, undefined, kinds).values()].flat())];
    if (side === 'browser') for (const a of assets) { sources.push(a); kinds.set(a, 'asset'); }
    const entries = Object.values(metafile.outputs || {}).map(o => o && o.entryPoint && fileOfInput(o.entryPoint, wd)).filter(Boolean);
    const collected = packages.packagesOfFiles(sources, { context, entries });
    const dir = path.join(out.base, out[side] || side);
    const target = path.join(dir, config.file);
    const own = files.filter(f => f && f.type === (side === 'browser' ? TYPE.Browser : TYPE.ServerApplication)).map(f => path.join(dir, f.path));
    const found = via.ofFiles(collected, kinds);
    const runtime = own.some(f => /\.[cm]?js$/.test(f))
      ? [esbuildOf(wd)].filter(Boolean) : [];
    found.add('runtime', runtime);
    const all = packages.unique(collected.all, runtime);
    const content = render(side, target, JSON.stringify(['angular', side, portable(context, out.base)]), all, context, own, found);
    // Angular 17 - 21 key the files they write by their path in their side's directory, so a browser and a server file
    // of the same name are one (the one added last): the server's lockfile is a file of the output path's root, at
    // <server>/<file> (written also where Angular skips server files: it is not added for those, see above)
    if (content !== null && config.inline && typeof result.addOutputFile === 'function') {
      if (side === 'browser') result.addOutputFile(config.file, content, TYPE.Browser);
      else result.addOutputFile(path.posix.join(out.server || 'server', config.file.split(path.sep).join('/')), content, TYPE.Root);
    }
  }
}

function wrap(executeBuild) {
  return async function bundleLockfileExecuteBuild(options, ...rest) {
    const forced = !!options && typeof options === 'object' && !options.stats;
    const result = await executeBuild.call(this, forced ? { ...options, stats: true } : options, ...rest);
    if (!result || typeof result !== 'object') return result;
    try { complete(options, result, forced); } catch (e) { problems.problem('angular: could not collect the bundled packages', e); }
    problems.failIfAny((err) => {
      if (typeof result.addError === 'function') result.addError(err.message.replace(/\n$/, ''));
      else throw err;
    });
    return result;
  };
}

module.exports = {
  name: 'angular',
  cjsFiles: [EXECUTE_BUILD],
  onCjsLoad(exp, request, resolve) {
    if (!request.endsWith('execute-build.js') || !EXECUTE_BUILD.test(request) || !exp || typeof exp !== 'object' || exp[PATCHED]) return;
    if (typeof exp.executeBuild !== 'function') {
      problems.problem(`angular: ${resolve()} exports no executeBuild() bundle-lockfile knows: its builds would write no lockfile`);
      return;
    }
    try {
      exp.executeBuild = wrap(exp.executeBuild);
      exp[PATCHED] = true;
      try { version = JSON.parse(fs.readFileSync(path.join(path.dirname(resolve()), '../../../package.json'), 'utf8')).version || null; } catch { /* unknown */ }
      try { esbuildFile = createRequire(resolve()).resolve('esbuild/package.json'); } catch { /* reported when a build writes JavaScript */ }
      config.debug('angular: wrapped executeBuild() of', resolve(), version || '');
    } catch (e) { problems.problem(`angular: could not wrap ${resolve()}`, e); }
  },
  wrap,
};
