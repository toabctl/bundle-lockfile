'use strict';
// Entry point. Activate in a build with:
//   NODE_OPTIONS="--require /path/to/bundle-lockfile/src/register.cjs"
// Every supported bundler that runs in that process (or its child processes, which inherit NODE_OPTIONS)
// then writes <output dir>/bundle-lockfile/package-lock.json listing the npm packages in its output.
const fs = require('fs');
const path = require('path');
const config = require('./core/config.cjs'); // (also applies the settings file to process.env)

// Node's own loader thread, which runs --require preloads too: nothing to hook or check there - the main thread (and each
// worker thread) reports the settings and installs the hooks. Node.js 22.14 and later mark it (isInternalThread); before,
// it is the thread that is neither the main thread nor a user's worker, which always has a parentPort.
{
  const wt = require('worker_threads');
  if (wt.isInternalThread || (!wt.isMainThread && !wt.parentPort)) return;
}

const ADAPTERS = ['./adapters/webpack.cjs', './adapters/rollup.cjs', './adapters/rspack.cjs', './adapters/esbuild.cjs', './adapters/parcel.cjs', './adapters/angular.cjs', './adapters/next.cjs'];
// yarn's own entry point (process.argv[1]): yarn 1's bin/yarn.js (npm's and distributions' package, corepack's copy
// <COREPACK_HOME>/v1/yarn/1.x/bin/yarn.js) or a bin/yarn link to it, a yarn 2+ release (.yarn/releases/yarn-4.x.cjs),
// corepack's yarn (dist/yarn.js) and its copies of releases (<COREPACK_HOME>/v1/yarn/4.x/yarn.js) - not other scripts
// named after yarn (yarn-deduplicate.js, scripts/yarn-audit-fix.js, tools/yarn.js)
const YARN = /[\\/]bin[\\/]yarn(pkg)?(\.c?js)?$|[\\/]yarn-\d[^\\/]*\.c?js$|[\\/]corepack[\\/]dist[\\/]yarn(pkg)?\.js$|[\\/]yarn[\\/]\d[^\\/]*[\\/]yarn\.js$/;

// the scripts the node shim passed through to start this process (see bin/node): processes this one starts look anew
delete process.env.BUNDLE_LOCKFILE_NODE_SEEN;

// The register.cjs files of other copies of bundle-lockfile that this process preloads (--require / -r in NODE_OPTIONS
// or on the command line): every release's register.cjs names bundle-lockfile in its first lines (as bin/node checks).
// The same file through another path (a symlinked install directory) is this one.
function otherCopies() {
  const own = real(__filename), out = new Set();
  for (const f of preloads()) {
    if (path.basename(f) !== 'register.cjs' || real(f) === own) continue;
    try { if (fs.readFileSync(f, 'utf8').slice(0, 512).includes('bundle-lockfile')) out.add(real(f)); } catch { /* not there: Node fails to start then */ }
  }
  return [...out];
}
function real(f) { try { return fs.realpathSync(f); } catch { return path.resolve(f); } }
// The files preloaded with --require / -r: in NODE_OPTIONS (split as Node does: spaces, "..." quoting a value with
// spaces, backslash escapes inside it) and in process.execArgv
function preloads() {
  const words = [], opts = process.env.NODE_OPTIONS || '';
  let w = null, quoted = false;
  for (let i = 0; i < opts.length; i++) {
    const c = opts[i];
    if (quoted && c === '\\' && i + 1 < opts.length) { w = (w || '') + opts[++i]; continue; }
    if (c === '"') { quoted = !quoted; w = w || ''; continue; }
    if (!quoted && /\s/.test(c)) { if (w !== null) words.push(w); w = null; continue; }
    w = (w || '') + c;
  }
  if (w !== null) words.push(w);
  const out = [];
  for (const args of [words, process.execArgv]) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if ((a === '--require' || a === '-r') && i + 1 < args.length) out.push(args[++i]);
      else if (a.startsWith('--require=')) out.push(a.slice('--require='.length));
    }
  }
  return out;
}

if (!config.isDisabled('all')) {
  // a settings file that is there but cannot be used: its settings (an export directory) would be missing - a problem
  // (the first build fails with it, or the process, see core/problems.cjs)
  // Reported by the main thread of each process, once: worker threads run the preload too
  if (require('worker_threads').isMainThread) {
    const problems = require('./core/problems.cjs');
    const { file: settings, error } = config.settingsFile;
    if (error) problems.problem(`could not read the settings file ${settings}`, error);
    else if (settings) config.debug('settings from', settings);
    // settings that are set but not recognized, or cannot work: the build would not do what was asked of it
    for (const msg of config.invalid) problems.problem(msg);
    // another copy of bundle-lockfile preloaded too: only the first one runs (hooks.cjs), whose settings and version
    // may not be the ones meant. Each new copy reports the others, whichever comes first.
    for (const other of otherCopies()) problems.problem(`another copy of bundle-lockfile is preloaded too: ${other} (only the first one runs; preload one)`);
  }
  // With the node shim (bin/node), yarn still runs scripts with a temporary `node` first in PATH that runs yarn's
  // own process.execPath, bypassing the shim. In yarn's process, and only there (others derive paths from it, e.g.
  // node-gyp's headers), process.execPath is the shim, which runs the real node.
  const shim = process.env.BUNDLE_LOCKFILE_NODE_SHIM;
  if (shim && YARN.test(process.argv[1] || '')) {
    try { if (fs.statSync(shim).isFile()) { process.execPath = shim; config.debug('yarn: process.execPath is the node shim', shim); } } catch { /* no shim */ }
  }

  const hooks = require('./hooks.cjs');
  let enabled = 0;
  for (const file of ADAPTERS) {
    const adapter = require(file);
    // an adapter for several bundlers (rollup: rollup, rolldown, vite) is skipped only if all of them are disabled
    if ((adapter.names || [adapter.name]).every(n => config.isDisabled(n))) { config.debug('adapter disabled:', adapter.name); continue; }
    hooks.register(adapter);
    enabled++;
  }
  if (enabled) {
    // builds of bundlers it recognizes but does not hook (Turbopack, Parcel, the rolldown command line, ncc)
    const unsupported = require('./core/unsupported.cjs');
    hooks.register(unsupported.adapter);
    if (require('worker_threads').isMainThread) unsupported.check();
    hooks.install(); // nothing to do: leave Node's module loading alone
    require('./core/copies.cjs').install(); // fs copies out of packages, see there
    require('./core/children.cjs').install(); // node processes and workers started without the preload, see there
  }
}
