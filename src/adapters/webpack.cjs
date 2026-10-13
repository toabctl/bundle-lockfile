'use strict';
// webpack 4 and 5, including the copy Next.js vendors (next/dist/compiled/webpack).
// Patches Compiler.prototype.compile so every top-level compiler (not child compilers such as
// html-webpack-plugin's) gets BundleLockfilePlugin (webpack-family.cjs), which emits <output>/<BUNDLE_LOCKFILE_FILE>
// listing the packages in its output.
const config = require('../core/config.cjs');
const problems = require('../core/problems.cjs');
const { APPLIED, BundleLockfilePlugin, bundledFiles, sourceFile, isRspack, attach } = require('./webpack-family.cjs');

const PATCHED = Symbol.for('bundle-lockfile.webpack.patched');
const SEEN = Symbol.for('bundle-lockfile.webpack.seen');       // compiler: listeners have run
const NEXT_WEBPACK = /[\\/]next[\\/]dist[\\/]compiled[\\/]webpack[\\/]webpack(\.js)?$/;

// Called once for every top-level compiler, before its first compilation. Tools can add their own (test/compare).
const listeners = [(compiler, where) => {
  if (isRspack(compiler)) return; // rspack.cjs's (Next.js with next-rspack also loads its webpack, with rspack's exports)
  if (compiler[APPLIED]) { config.debug('webpack: plugin already in the config of compiler', compiler.name || '(unnamed)'); return; }
  config.debug('webpack: applying to compiler', compiler.name || '(unnamed)', 'output', compiler.outputPath, 'via', where);
  new BundleLockfilePlugin(config.file, where).apply(compiler);
}];
const onCompiler = (fn) => { listeners.push(fn); };

// Returns whether Compiler looks like webpack's Compiler (and is patched now, or was already), not any class called
// "Compiler" (e.g. snapdragon's).
function patchCompiler(Compiler, where) {
  if (typeof Compiler !== 'function') return false; // check first: reading props of a circular partial export warns
  const p = Compiler.prototype;
  if (!p || !['compile', 'run', 'watch', 'newCompilation', 'isChild'].every(k => typeof p[k] === 'function')) return false;
  if (p[PATCHED]) return true;
  p[PATCHED] = true;
  const orig = p.compile;
  p.compile = function (...args) {
    // compile() runs for run(), watch() and child compilers
    if (!this[SEEN] && !this.isChild()) {
      this[SEEN] = true;
      if (this.hooks && this.hooks.thisCompilation) {
        if (attach(this, listeners, where, args, 'webpack')) return undefined;
      } else {
        // webpack before 4 (plugin() instead of hooks): its build writes no lockfile - the process fails at exit
        problems.problem(`webpack before 4 is not supported (a Compiler without hooks, from ${where}): its builds write no lockfile`);
      }
    }
    return orig.apply(this, args);
  };
  config.debug('webpack: patched Compiler from', where);
  return true;
}

// The Compiler of a module that is webpack's (its lib/Compiler.js, Next.js' copy) but not of the shape webpack.cjs
// knows: a version whose builds would write no lockfile - a problem (in strict mode its require() fails, see hooks.cjs)
function unknownCompiler(where) {
  problems.problem(`webpack: ${where} has no Compiler bundle-lockfile knows (compile, run, watch, newCompilation, isChild): its builds would write no lockfile`);
}

// In Next 12-15, next/dist/compiled/webpack/webpack.js only exports init() when it is loaded; init() then fills
// in exports.webpack (Object.assign(exports, require('./bundle5')())). Next 16 fills the exports when the module
// is loaded (no init()). Patch an already filled copy right away, and otherwise right after init().
// With next-rspack, Next.js fills its webpack with rspack's exports (rspackVersion): rspack.cjs hooks that Compiler.
function patchNext(exp, where) {
  const patch = () => {
    const w = exp.webpack;
    if (!w || !w.Compiler || typeof w.rspackVersion === 'string') return;
    if (!patchCompiler(w.Compiler, where)) unknownCompiler(where);
  };
  patch();
  if (typeof exp.init !== 'function' || exp.init[PATCHED]) return;
  const init = exp.init;
  exp.init = function (...args) {
    const r = init.apply(this, args);
    try { patch(); } catch (e) { problems.problem(`webpack: could not patch Next.js' webpack (${where})`, e); }
    return r;
  };
  exp.init[PATCHED] = true;
}

module.exports = {
  name: 'webpack',
  // the modules onCjsLoad patches: webpack's Compiler and Next's vendored webpack
  cjsFiles: [/[\\/]webpack[\\/]lib[\\/]Compiler\.js$/, NEXT_WEBPACK],
  BundleLockfilePlugin, // usable directly in a webpack config, without injection
  bundledFiles,
  sourceFile,
  onCompiler,
  onCjsLoad(exp, request, resolve) {
    // recognizing a module only reads it (a failure there is hooks.cjs's warning); failing to patch one that is webpack
    // means its builds write no lockfile: a problem (core/problems.cjs). request: the path as webpack's files are
    // recognized by (see hooks.cjs), resolve(): the real one
    let patch = null;
    if (typeof exp === 'function') {
      // only probe functions: probing plain objects can trigger circular-dependency warnings
      if (exp.name === 'Compiler') { // webpack/lib/Compiler.js - or another class called Compiler, elsewhere
        patch = () => { if (!patchCompiler(exp, resolve()) && module.exports.cjsFiles[0].test(request)) unknownCompiler(resolve()); };
      } else if (exp.Compiler && exp.Compilation && exp.version && !exp.rspackVersion) patch = () => patchCompiler(exp.Compiler, resolve()); // webpack namespace (not rspack's: rspack.cjs)
    } else if (request.includes('webpack') && exp && typeof exp === 'object' && Object.prototype.hasOwnProperty.call(exp, 'webpack')
      && typeof exp.webpack === 'function' && !NEXT_WEBPACK.test(request)) {
      // a vendored copy exported as a plain object around webpack's namespace (umi's @umijs/bundler-webpack/compiled/webpack).
      // Only an own property is read: the exports of a module in a require() cycle have a prototype that warns about
      // reading one they do not have ("Accessing non-existent property ... inside circular dependency", webpack 5.0's)
      const w = exp.webpack;
      if (w.Compiler && w.Compilation && w.version && !w.rspackVersion) patch = () => { if (!patchCompiler(w.Compiler, resolve())) unknownCompiler(resolve()); };
    } else if (request.includes('webpack')) {
      if (exp && typeof exp === 'object' && NEXT_WEBPACK.test(request)) patch = () => patchNext(exp, resolve());
      else if (module.exports.cjsFiles[0].test(request)) patch = () => unknownCompiler(resolve()); // webpack's lib/Compiler.js exports no class
    }
    if (patch) try { patch(); } catch (e) { problems.problem(`webpack: could not patch ${resolve()}`, e); }
  },
};
