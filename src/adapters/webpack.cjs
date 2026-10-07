'use strict';
// webpack 4 and 5, including the copy Next.js vendors (next/dist/compiled/webpack).
// Patches Compiler.prototype.compile so every top-level compiler (not child compilers such as
// html-webpack-plugin's) emits <output>/<BUNDLE_LOCKFILE_FILE> listing the packages in its chunks.
const { createRequire } = require('module');
const config = require('../core/config.cjs');
const { lockfileForFiles } = require('../core/lockfile.cjs');

const NAME = 'bundle-lockfile';
const PATCHED = Symbol.for('bundle-lockfile.webpack.patched');
const APPLIED = Symbol.for('bundle-lockfile.webpack.applied');
const NEXT_WEBPACK = /[\\/]next[\\/]dist[\\/]compiled[\\/]webpack[\\/]webpack(\.js)?$/;

// Source file of a module: NormalModule.resource, else nameForCondition() - webpack's API for "which
// file is this module from" (used by splitChunks), which modules such as mini-css-extract's CssModule
// implement without having a resource. In webpack 4 the base Module has nameForCondition = null.
function sourceFile(m) {
  if (m.resource) return m.resource;
  return typeof m.nameForCondition === 'function' ? m.nameForCondition() : null;
}

// Source files of all modules in emitted chunks. Scope-hoisted ConcatenatedModules carry their
// inner modules in .modules; those inner modules are not in any chunk themselves.
function bundledFiles(compilation) {
  const files = new Set();
  const walk = (m) => { const f = sourceFile(m); if (f) files.add(f); for (const im of m.modules || []) walk(im); };
  for (const chunk of compilation.chunks) {
    const mods = compilation.chunkGraph ? compilation.chunkGraph.getChunkModulesIterable(chunk) : chunk.modulesIterable; // webpack 5 : 4
    for (const m of mods) walk(m);
  }
  return files;
}

class BundleLockfilePlugin {
  // compilerFile: path of the Compiler module, used to find webpack-sources for webpack 4
  constructor(file, compilerFile) { this.file = file; this.compilerFile = compilerFile; }

  lockfile(compilation) {
    if (config.fault === 'collect') throw new Error('injected fault (BUNDLE_LOCKFILE_TEST_FAULT=collect)');
    return lockfileForFiles(bundledFiles(compilation), compilation.compiler.context);
  }

  apply(compiler) {
    if (compiler.webpack) { // webpack 5
      const { Compilation, sources } = compiler.webpack;
      compiler.hooks.thisCompilation.tap(NAME, (compilation) => {
        compilation.hooks.processAssets.tap({ name: NAME, stage: Compilation.PROCESS_ASSETS_STAGE_REPORT }, () => {
          try {
            compilation.emitAsset(this.file, new sources.RawSource(this.lockfile(compilation)));
          } catch (e) { config.warn('webpack: could not write lockfile:', e); }
        });
      });
      return;
    }
    // webpack 4
    let RawSource;
    try { RawSource = createRequire(this.compilerFile || __filename)('webpack-sources').RawSource; } catch { /* fallback below */ }
    compiler.hooks.thisCompilation.tap(NAME, (compilation) => {
      compilation.hooks.additionalAssets.tap(NAME, () => {
        try {
          const json = this.lockfile(compilation);
          const src = RawSource ? new RawSource(json) : { source: () => json, size: () => Buffer.byteLength(json) };
          if (compilation.emitAsset) compilation.emitAsset(this.file, src); else compilation.assets[this.file] = src;
        } catch (e) { config.warn('webpack: could not write lockfile:', e); }
      });
    });
  }
}

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
    if (!this[APPLIED] && this.hooks && this.hooks.thisCompilation && !this.isChild()) {
      this[APPLIED] = true;
      config.debug('webpack: applying to compiler', this.name || '(unnamed)', 'output', this.outputPath, 'via', where);
      try { new BundleLockfilePlugin(config.file, where).apply(this); } catch (e) { config.warn('webpack: could not apply plugin:', e); }
    }
    return orig.apply(this, args);
  };
  config.debug('webpack: patched Compiler from', where);
}

module.exports = {
  name: 'webpack',
  BundleLockfilePlugin, // usable directly in a webpack config, without injection
  onCjsLoad(exp, request, resolve) {
    if (typeof exp === 'function') {
      // only probe functions: probing plain objects can trigger circular-dependency warnings
      if (exp.name === 'Compiler') patchCompiler(exp, resolve());                                    // webpack/lib/Compiler.js
      else if (exp.Compiler && exp.Compilation && exp.version) patchCompiler(exp.Compiler, resolve()); // webpack namespace
    } else if (exp && typeof exp === 'object' && request.includes('webpack')) {
      // Next.js vendors webpack: next/dist/compiled/webpack/webpack.js is a plain object with a .webpack function
      const where = resolve();
      if (NEXT_WEBPACK.test(where) && exp.webpack && exp.webpack.Compiler) patchCompiler(exp.webpack.Compiler, where);
    }
  },
};
