'use strict';
// rspack 1.1 and later, also as Rsbuild's, Next.js' (next-rspack) or any other tool's bundler. rspack implements
// webpack's plugin API, so every top-level compiler gets the same BundleLockfilePlugin as webpack's
// (webpack-family.cjs), which tells rspack's compilations apart where they differ (copies, style sheets before 1.3.14,
// inlined constants). This module only hooks rspack:
// - @rspack/core is one bundled file, dist/index.js, whose export has the Compiler class. rspack 1 is CommonJS
//   (require(), and import() of it, load it through the CommonJS hook: onCjsLoad); rspack 2 is an ES module (@rspack/cli 2 and
//   Rsbuild 2 import it: the ESM entry wrapper, esmWrap; require() of it, require(esm), goes through the CommonJS hook too).
// - Compiler.prototype.compile is patched, as webpack's (webpack.cjs): it runs for run(), watch() and child compilers;
//   every top-level compiler gets the plugin on its first compile(). The prototype is marked, so a copy of @rspack/core
//   seen on several paths (the in-thread ESM hooks and the CommonJS hook) is patched once; every copy loaded (OHIF
//   loads rspack 1 and 2) gets its own patch.
// rspack 1.0 lacks what the plugin needs (the inner modules of concatenated modules): its builds fail (strict mode,
// core/problems.cjs). rspack 0.x fails its builds too.
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const config = require('../core/config.cjs');
const problems = require('../core/problems.cjs');
const { APPLIED, BUNDLER_FILE, BundleLockfilePlugin, attach, versionOf } = require('./webpack-family.cjs');

const PATCHED = Symbol.for('bundle-lockfile.rspack.patched'); // Compiler.prototype
const SEEN = Symbol.for('bundle-lockfile.rspack.seen');       // compiler: listeners have run

// Called once for every top-level compiler, before its first compilation. Tools can add their own (onCompiler).
const listeners = [(compiler, where) => {
  const version = compiler.webpack && compiler.webpack.rspackVersion;
  const [major] = versionOf(version);
  // rspack 0.x: its builds would write no lockfile - a problem (the compilation fails, see attach)
  if (!(major >= 1)) { problems.problem(`rspack ${version} is not supported (it needs 1.1 or later): its builds write no lockfile`); return; }
  // (rspack 1.0: the plugin records that it is not supported, see webpack-family.cjs)
  if (compiler[APPLIED]) { config.debug('rspack: plugin already in the config of compiler', compiler.name || '(unnamed)'); return; }
  config.debug('rspack: applying to compiler', compiler.name || '(unnamed)', 'rspack', version, 'output', compiler.outputPath, 'via', where);
  new BundleLockfilePlugin(config.file, where).apply(compiler);
}];
const onCompiler = (fn) => { listeners.push(fn); };

// Returns whether Compiler looks like rspack's Compiler (it has no newCompilation, which webpack.cjs requires), patched
// now or before.
function patchCompiler(Compiler, where) {
  if (typeof Compiler !== 'function') return false;
  const p = Compiler.prototype;
  if (!p || !['compile', 'run', 'watch', 'isChild', 'runAsChild', 'createChildCompiler'].every(k => typeof p[k] === 'function')) return false;
  if (p[PATCHED]) return true;
  p[PATCHED] = true;
  p[BUNDLER_FILE] = where; // the bundler's package is the one around it (core/bundler.cjs)
  const orig = p.compile;
  p.compile = function (...args) {
    if (!this[SEEN] && this.hooks && !this.isChild()) {
      this[SEEN] = true;
      if (attach(this, listeners, where, args, 'rspack')) return undefined;
    }
    return orig.apply(this, args);
  };
  config.debug('rspack: patched Compiler from', where);
  return true;
}

// The version in dir/package.json, or null
function versionIn(dir) {
  try { const v = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; return typeof v === 'string' ? v : null; } catch { return null; }
}

// @rspack/core's Compiler, of a version from 1.0 on, that is not of the shape rspack.cjs knows: its builds would write no
// lockfile - a problem (in strict mode loading it fails, see hooks.cjs). rspack 0.x fails when it compiles.
function patchRspack(Compiler, version, where) {
  if (patchCompiler(Compiler, where) || !(versionOf(version)[0] >= 1)) return;
  problems.problem(`rspack: the Compiler of rspack ${version} (${where}) is not one bundle-lockfile knows (compile, run, watch, isChild, runAsChild, createChildCompiler): its builds would write no lockfile`);
}

module.exports = {
  name: 'rspack',
  // rspack 1's dist/index.js, when Node.js evaluates it without the CommonJS hook (a loader hook provided its source: Yarn
  // Plug'n'Play on recent Node.js versions); rspack 2's is an ES module, which esm-wrap.cjs's cjsSource leaves alone
  cjsFiles: [/[\\/]@rspack[\\/]core[\\/]dist[\\/]index\.js$/],
  // rspack 2: only ES modules are wrapped (esm-wrap.cjs), so rspack 1's file at the same path is not
  esmEntries: [{ id: 'rspack', suffixes: ['/@rspack/core/dist/index.js'], wrap: ['Compiler'] }],
  // processes that get the loader-thread ESM hooks on older Node.js (see hooks.cjs esmMode): @rspack/cli 2 and
  // Rsbuild 2 import rspack, as may a build script of a project using it
  esmPackages: ['@rspack/core', '@rspack/cli', '@rsbuild/core'],
  // the CommonJS file rspack 2's ES module loads (hooks.cjs esmCompanions): its binding, from dist/index.js - rspack 1's
  // and require(esm) of rspack 2's load that through the CommonJS hook first
  esmCompanions: [{ id: 'rspack', names: ['rspack'], file: /[\\/]node_modules[\\/]@rspack[\\/]binding[\\/]binding\.js$/ }],
  BundleLockfilePlugin, // usable directly in an rspack config, without injection
  onCompiler,
  esmWrap(id, name, value, url) {
    // (an entry without a Compiler: hooks.cjs found() reports it)
    if (id !== 'rspack' || name !== 'Compiler' || typeof value !== 'function') return null;
    // the ES module entry is rspack 2's (or later)
    try { patchRspack(value, '2', typeof url === 'string' && url.startsWith('file:') ? fileURLToPath(url) : '@rspack/core (ES module)'); } catch (e) { problems.problem('rspack: could not patch @rspack/core', e); }
    return value; // the class itself, patched
  },
  onCjsLoad(exp, request, resolve) {
    // only the export of @rspack/core: a function (rspack()) with its version and Compiler (webpack's says version) -
    // or, for require() of rspack 2's ES module on a Node.js that does not take its "module.exports" export, its namespace
    // (the path first: reading a missing property of a module in a circular require() makes Node warn)
    const own = module.exports.cjsFiles[0].test(request);
    const api = typeof exp === 'function' || (own && exp && exp[Symbol.toStringTag] === 'Module') ? exp : null;
    if (!api || typeof api.rspackVersion !== 'string' || typeof api.Compiler !== 'function') {
      // @rspack/core's own dist/index.js of another shape, from 1.0 on (its package.json says which): its builds would
      // write no lockfile - a problem (in strict mode its require() fails, see hooks.cjs). rspack 0.x fails when it
      // compiles (listeners).
      if (!own) return;
      const version = exp && typeof exp.rspackVersion === 'string' ? exp.rspackVersion : versionIn(path.join(path.dirname(resolve()), '..'));
      if (version && versionOf(version)[0] >= 1) {
        problems.problem(`rspack: ${resolve()} (rspack ${version}) exports no rspack() with rspackVersion and Compiler, as bundle-lockfile knows it: its builds would write no lockfile`);
      }
      return;
    }
    try { patchRspack(api.Compiler, api.rspackVersion, resolve()); } catch (e) { problems.problem(`rspack: could not patch ${resolve()}`, e); }
  },
};
