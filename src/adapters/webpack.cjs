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

function patchCompiler(Compiler, where) {
  if (typeof Compiler !== 'function') return; // check first: reading props of a circular partial export warns
  const p = Compiler.prototype;
  // must look like webpack's Compiler, not any class called "Compiler" (e.g. snapdragon's)
  if (!p || !['compile', 'run', 'watch', 'newCompilation', 'isChild'].every(k => typeof p[k] === 'function')) return;
  if (p[PATCHED]) return;
  p[PATCHED] = true;
  const orig = p.compile;
  p.compile = function (...args) {
    // compile() runs for run(), watch() and child compilers; webpack < 4 has no hooks and is ignored
    if (!this[SEEN] && this.hooks && this.hooks.thisCompilation && !this.isChild()) {
      this[SEEN] = true;
      if (attach(this, listeners, where, args, 'webpack')) return undefined;
    }
    return orig.apply(this, args);
  };
  config.debug('webpack: patched Compiler from', where);
}

// In Next 12-15, next/dist/compiled/webpack/webpack.js only exports init() when it is loaded; init() then fills
// in exports.webpack (Object.assign(exports, require('./bundle5')())). Next 16 fills the exports when the module
// is loaded (no init()). Patch an already filled copy right away, and otherwise right after init().
function patchNext(exp, where) {
  if (exp.webpack && exp.webpack.Compiler) patchCompiler(exp.webpack.Compiler, where);
  if (typeof exp.init !== 'function' || exp.init[PATCHED]) return;
  const init = exp.init;
  exp.init = function (...args) {
    const r = init.apply(this, args);
    try { if (exp.webpack) patchCompiler(exp.webpack.Compiler, where); } catch (e) { problems.problem(`webpack: could not patch Next.js' webpack (${where})`, e); }
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
    // means its builds write no lockfile: a problem (core/problems.cjs)
    let patch = null;
    if (typeof exp === 'function') {
      // only probe functions: probing plain objects can trigger circular-dependency warnings
      if (exp.name === 'Compiler') patch = () => patchCompiler(exp, resolve());                                    // webpack/lib/Compiler.js
      else if (exp.Compiler && exp.Compilation && exp.version && !exp.rspackVersion) patch = () => patchCompiler(exp.Compiler, resolve()); // webpack namespace (not rspack's: rspack.cjs)
    } else if (exp && typeof exp === 'object' && request.includes('webpack')) {
      const where = resolve();
      if (NEXT_WEBPACK.test(where)) patch = () => patchNext(exp, where);
    }
    if (patch) try { patch(); } catch (e) { problems.problem(`webpack: could not patch ${resolve()}`, e); }
  },
};
