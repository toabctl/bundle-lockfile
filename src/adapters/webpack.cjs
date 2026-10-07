'use strict';
// webpack 4 and 5, including the copy Next.js vendors (next/dist/compiled/webpack).
// Patches Compiler.prototype.compile so every top-level compiler (not child compilers such as
// html-webpack-plugin's) emits <output>/<BUNDLE_LOCKFILE_FILE> listing the packages in its output.
const path = require('path');
const { createRequire } = require('module');
const config = require('../core/config.cjs');
const lockfile = require('../core/lockfile.cjs');

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

const chunkModules = (compilation, chunk) =>
  compilation.chunkGraph ? compilation.chunkGraph.getChunkModulesIterable(chunk) : chunk.modulesIterable; // webpack 5 : 4

// Source files of everything this compilation emits:
// - modules in its chunks. Scope-hoisted ConcatenatedModules carry their inner modules in .modules;
//   those inner modules are not in any chunk themselves.
// - modules in chunks of child compilations whose files reached this compilation's assets (worker-loader,
//   workbox's InjectManifest). runAsChild copies a child's assets into the parent; child compilations that
//   only run at build time (html-webpack-plugin's template, mini-css-extract's loader) delete theirs first.
// - files copied into the output verbatim (copy-webpack-plugin): asset info.sourceFilename, relative to the
//   context. webpack's asset modules set it too; those are in a chunk anyway.
function bundledFiles(compilation) {
  const files = new Set();
  const walk = (m) => { const f = sourceFile(m); if (f) files.add(f); for (const im of m.modules || []) walk(im); };
  for (const chunk of compilation.chunks) for (const m of chunkModules(compilation, chunk)) walk(m);

  const emitted = (name) => (compilation.getAsset ? compilation.getAsset(name) : compilation.assets[name]) !== undefined;
  const children = (c) => {
    for (const child of c.children || []) {
      for (const chunk of child.chunks) {
        if ([...chunk.files].some(emitted)) for (const m of chunkModules(child, chunk)) walk(m);
      }
      children(child); // grandchildren's assets are copied up through every level
    }
  };
  children(compilation);

  for (const { info } of compilation.getAssets ? compilation.getAssets() : []) {
    if (info && typeof info.sourceFilename === 'string') files.add(path.resolve(compilation.compiler.context, info.sourceFilename));
  }
  return files;
}

class BundleLockfilePlugin {
  // compilerFile: path of the Compiler module, used to find webpack-sources for webpack 4
  constructor(file, compilerFile) { this.file = file; this.compilerFile = compilerFile; }

  lockfile(compilation) {
    return lockfile.lockfileForFiles(bundledFiles(compilation), compilation.compiler.context);
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

// next/dist/compiled/webpack/webpack.js only exports init() when it is loaded; init() then fills in
// exports.webpack (Object.assign(exports, require('./bundle5')())). Patch right after init(), and also
// when an already initialized copy is required.
function patchNext(exp, where) {
  if (exp.webpack && exp.webpack.Compiler) patchCompiler(exp.webpack.Compiler, where);
  if (typeof exp.init !== 'function' || exp.init[PATCHED]) return;
  const init = exp.init;
  exp.init = function (...args) {
    const r = init.apply(this, args);
    try { if (exp.webpack) patchCompiler(exp.webpack.Compiler, where); } catch (e) { config.warn('webpack: could not patch Next.js webpack:', e); }
    return r;
  };
  exp.init[PATCHED] = true;
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
      const where = resolve();
      if (NEXT_WEBPACK.test(where)) patchNext(exp, where);
    }
  },
};
