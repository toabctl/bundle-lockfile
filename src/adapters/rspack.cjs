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
//   seen on several paths (in-thread ESM hooks and the CommonJS hook on Node.js 24.12+) is patched once; every copy loaded
//   (OHIF loads rspack 1 and 2) gets its own patch.
// rspack 1.0 lacks what the plugin needs (the inner modules of concatenated modules): its builds fail (strict mode,
// core/problems.cjs). rspack 0.x is left alone.
const config = require('../core/config.cjs');
const problems = require('../core/problems.cjs');
const { APPLIED, BundleLockfilePlugin, attach } = require('./webpack-family.cjs');

const PATCHED = Symbol.for('bundle-lockfile.rspack.patched'); // Compiler.prototype
const SEEN = Symbol.for('bundle-lockfile.rspack.seen');       // compiler: listeners have run

// [major, minor] of an rspack version
const versionOf = (v) => String(v || '').split('.').map(Number);

// Called once for every top-level compiler, before its first compilation. Tools can add their own (onCompiler).
const listeners = [(compiler, where) => {
  const version = compiler.webpack && compiler.webpack.rspackVersion;
  const [major, minor] = versionOf(version);
  if (!(major >= 1)) { config.debug('rspack: version', version, 'is not supported, left alone'); return; }
  if (major === 1 && minor < 1) {
    problems.problem(`rspack ${version} is not supported (it needs 1.1 or later): no lockfile for ${compiler.outputPath || 'the compiler'}`);
    return;
  }
  if (compiler[APPLIED]) { config.debug('rspack: plugin already in the config of compiler', compiler.name || '(unnamed)'); return; }
  config.debug('rspack: applying to compiler', compiler.name || '(unnamed)', 'rspack', version, 'output', compiler.outputPath, 'via', where);
  new BundleLockfilePlugin(config.file, where).apply(compiler);
}];
const onCompiler = (fn) => { listeners.push(fn); };

function patchCompiler(Compiler, where) {
  if (typeof Compiler !== 'function') return;
  const p = Compiler.prototype;
  // rspack's Compiler (it has no newCompilation, which webpack.cjs requires)
  if (!p || !['compile', 'run', 'watch', 'isChild', 'runAsChild', 'createChildCompiler'].every(k => typeof p[k] === 'function')) return;
  if (p[PATCHED]) return;
  p[PATCHED] = true;
  const orig = p.compile;
  p.compile = function (...args) {
    if (!this[SEEN] && this.hooks && !this.isChild()) {
      this[SEEN] = true;
      if (attach(this, listeners, where, args, 'rspack')) return undefined;
    }
    return orig.apply(this, args);
  };
  config.debug('rspack: patched Compiler from', where);
}

module.exports = {
  name: 'rspack',
  // rspack 1's dist/index.js, when Node.js evaluates it without the CommonJS hook (a loader hook provided its source: Yarn
  // Plug'n'Play on recent Node.js versions); rspack 2's is an ES module, which esm-wrap.cjs's cjsSource leaves alone
  cjsFiles: [/[\\/]@rspack[\\/]core[\\/]dist[\\/]index\.js$/],
  // rspack 2: only ES modules are wrapped (esm-wrap.cjs), so rspack 1's file at the same path is not
  esmEntries: [{ id: 'rspack', suffixes: ['/@rspack/core/dist/index.js'], wrap: ['Compiler'] }],
  // processes that get the loader-thread ESM hooks on Node.js before 24.12 (see hooks.cjs esmMode): @rspack/cli 2 and
  // Rsbuild 2 import rspack, as may a build script of a project using it
  esmPackages: ['@rspack/core', '@rspack/cli', '@rsbuild/core'],
  BundleLockfilePlugin, // usable directly in an rspack config, without injection
  onCompiler,
  esmWrap(id, name, value) {
    if (id !== 'rspack' || name !== 'Compiler') return null;
    try { patchCompiler(value, '@rspack/core (ES module)'); } catch (e) { problems.problem('rspack: could not patch @rspack/core', e); }
    return value; // the class itself, patched
  },
  onCjsLoad(exp, request, resolve) {
    // only the export of @rspack/core: a function (rspack()) with its version and Compiler (webpack's says version)
    if (typeof exp !== 'function' || typeof exp.rspackVersion !== 'string' || typeof exp.Compiler !== 'function') return;
    try { patchCompiler(exp.Compiler, resolve()); } catch (e) { problems.problem(`rspack: could not patch ${resolve()}`, e); }
  },
};
