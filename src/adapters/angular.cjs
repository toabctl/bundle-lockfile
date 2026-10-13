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
const outputs = require('../core/outputs.cjs');
const problems = require('../core/problems.cjs');
const { portable, exportPath } = require('../core/paths.cjs');
const { filesOfOutputs, fileOfInput } = require('./esbuild.cjs');

const PATCHED = Symbol.for('bundle-lockfile.angular.patched');
const EXECUTE_BUILD = /[\\/](@angular[\\/]build|@angular-devkit[\\/]build-angular)[\\/]src[\\/]builders[\\/]application[\\/]execute-build\.js$/;
// Angular's BuildOutputFileType (tools/esbuild/bundler-files): where a file of the result goes
const TYPE = { Browser: 0, ServerApplication: 2, Root: 4 };
// its metafiles with the stats option: one per side (22 and later), or both sides in one (stats.json: 17 - 21)
const STATS = { browser: 'browser-stats.json', server: 'server-stats.json', both: 'stats.json' };
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

// The lockfile of one side (browser or server) of a build: its packages, rendered (core/outputs.cjs, the writers of
// that path), and its export copy written; returns the content Angular writes, or null.
function render(side, target, writer, pkgs, context, files) {
  const content = outputs.record(target, writer, pkgs, context, files, { disk: true });
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
  // the combined metafile of Angular 17 - 21: the server's outputs below the server directory (out.server/...).
  // UNVERIFIED for SSR builds (no fixture yet): without SSR every output is the browser's.
  if (stats.both && !stats.browser) {
    const server = `${out.server || 'server'}/`, split = { browser: {}, server: {} };
    for (const [k, v] of Object.entries(stats.both.outputs || {})) split[k.startsWith(server) ? 'server' : 'browser'][k] = v;
    stats.browser = { outputs: split.browser };
    if (Object.keys(split.server).length) stats.server = { outputs: split.server };
  }
  if (!stats.browser) { problems.problem('angular: a build without its stats metafile (the stats option): its packages are unknown'); return; }
  const context = realOr(wd);
  const assets = (Array.isArray(result.assetFiles) ? result.assetFiles : []).map(a => a && a.source).filter(s => typeof s === 'string' && path.isAbsolute(s));
  for (const side of ['browser', 'server']) {
    const metafile = stats[side];
    if (!metafile) continue;
    const sources = [...new Set([...filesOfOutputs(metafile, wd).values()].flat())];
    if (side === 'browser') sources.push(...assets);
    const entries = Object.values(metafile.outputs || {}).map(o => o && o.entryPoint && fileOfInput(o.entryPoint, wd)).filter(Boolean);
    const { all } = packages.packagesOfFiles(sources, { context, entries });
    const dir = path.join(out.base, out[side] || side);
    const target = path.join(dir, config.file);
    const own = files.filter(f => f && f.type === (side === 'browser' ? TYPE.Browser : TYPE.ServerApplication)).map(f => path.join(dir, f.path));
    const content = render(side, target, JSON.stringify(['angular', side, portable(context, out.base)]), all, context, own);
    if (content !== null && config.inline && typeof result.addOutputFile === 'function') {
      result.addOutputFile(config.file, content, side === 'browser' ? TYPE.Browser : TYPE.ServerApplication);
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
      config.debug('angular: wrapped executeBuild() of', resolve());
    } catch (e) { problems.problem(`angular: could not wrap ${resolve()}`, e); }
  },
  wrap,
};
