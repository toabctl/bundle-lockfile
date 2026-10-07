'use strict';
// webpack 4 and 5, including the copy Next.js vendors (next/dist/compiled/webpack).
// Patches Compiler.prototype.compile so every top-level compiler (not child compilers such as
// html-webpack-plugin's) emits <output>/<BUNDLE_LOCKFILE_FILE> listing the packages in its output.
const path = require('path');
const { createRequire } = require('module');
const config = require('../core/config.cjs');
const packages = require('../core/packages.cjs');
const outputs = require('../core/outputs.cjs');

const NAME = 'bundle-lockfile';
const PATCHED = Symbol.for('bundle-lockfile.webpack.patched');
const SEEN = Symbol.for('bundle-lockfile.webpack.seen');       // compiler: listeners have run
const APPLIED = Symbol.for('bundle-lockfile.webpack.applied'); // compiler: has a BundleLockfilePlugin
const WRITER = Symbol.for('bundle-lockfile.webpack.writer');
const NEXT_WEBPACK = /[\\/]next[\\/]dist[\\/]compiled[\\/]webpack[\\/]webpack(\.js)?$/;
let writers = 0;

// Source file of a module: nameForCondition(), webpack's own answer to "which file is this module" (used for
// module.rules, splitChunks and stats). For a NormalModule it is the resource without query - or the match
// resource of a "<name>!=!<loaders>!<resource>" request: loaders that generate a module from a placeholder
// file name it that way (vanilla-extract's CSS reads @vanilla-extract/webpack-plugin/extracted.js), so the
// placeholder's package does not count. Modules such as mini-css-extract's CssModule implement it without
// having a resource; externals and webpack's runtime modules return null (webpack 4's base Module has
// nameForCondition = null).
// A module without a resource that names its issuer's resource was generated from the issuer - mini-css-extract's
// CssModule for the CSS a module produced - and is the file webpack names the issuer by. That carries a match
// resource over to the CSS (vanilla-extract), while CSS a file @imports keeps its own file.
function sourceFile(m, issuerOf) {
  const own = typeof m.nameForCondition === 'function' ? m.nameForCondition() || null : m.resource || null;
  if (!own || m.resource) return own;
  const issuer = issuerOf(m);
  if (!issuer || typeof issuer.resource !== 'string' || issuer.resource.split('?')[0] !== own || typeof issuer.nameForCondition !== 'function') return own;
  return issuer.nameForCondition() || own;
}

const chunkModules = (compilation, chunk) =>
  compilation.chunkGraph ? compilation.chunkGraph.getChunkModulesIterable(chunk) : chunk.modulesIterable; // webpack 5 : 4
const entryModules = (compilation, chunk) =>
  compilation.chunkGraph ? compilation.chunkGraph.getChunkEntryModulesIterable(chunk) : [chunk.entryModule].filter(Boolean);
const hasAsset = (compilation, name) => (compilation.getAsset ? compilation.getAsset(name) : compilation.assets[name]) !== undefined;

const issuers = (compilation) => (m) => (compilation.moduleGraph ? compilation.moduleGraph.getIssuer(m) : m.issuer); // webpack 5 : 4

// Source files of modules, including the inner modules of scope-hoisted ConcatenatedModules (.modules),
// which are not in any chunk themselves.
function sourcesOf(compilation, modules, into = new Set()) {
  const issuerOf = issuers(compilation);
  const walk = (list) => {
    for (const m of list) {
      const f = sourceFile(m, issuerOf);
      if (f) into.add(f);
      if (m.modules) walk(m.modules);
    }
  };
  walk(modules);
  return into;
}

// Source files of everything this compilation emits:
// - modules in its chunks
// - modules in chunks of child compilations whose output is shipped. Either the chunk's files reached this
//   compilation's assets (worker-loader, workbox's InjectManifest: runAsChild copies a child's assets into
//   its parent, grandchildren's through every level), or they were taken out of the parent again but the
//   child kept them and its entry file is a module in a shipped chunk of the parent - that module embeds the
//   child's output (worker-loader's inline: 'no-fallback'). Child compilations that only run at build time
//   delete their own output (html-webpack-plugin 5, mini-css-extract-plugin, vanilla-extract) or compile a
//   file that is no module of the parent (html-webpack-plugin 4's template).
// - files copied into the output verbatim (copy-webpack-plugin): asset info.sourceFilename, relative to the
//   context. webpack's asset modules set it too; those are in a chunk anyway.
function bundledFiles(compilation) {
  const files = new Set();
  const ship = (c, chunks) => {
    const own = new Set();
    for (const chunk of chunks) sourcesOf(c, chunkModules(c, chunk), own);
    for (const f of own) files.add(f);
    return own;
  };
  const children = (parent, shipped) => { // shipped: source files of the parent's shipped modules
    for (const child of parent.children || []) {
      const chunks = [...child.chunks].filter((chunk) => {
        const out = [...chunk.files];
        if (out.some(f => hasAsset(compilation, f))) return true;
        if (!out.some(f => hasAsset(child, f))) return false;
        return [...sourcesOf(child, entryModules(child, chunk))].some(f => shipped.has(f));
      });
      children(child, ship(child, chunks));
    }
  };
  children(compilation, ship(compilation, compilation.chunks));

  for (const { info } of compilation.getAssets ? compilation.getAssets() : []) {
    if (info && typeof info.sourceFilename === 'string') files.add(path.resolve(compilation.compiler.context, info.sourceFilename));
  }
  return files;
}

// Compilers that write the same files are one writer of a shared lockfile: a new compiler for the same config
// (a build restarted in the same process) replaces the previous one's packages instead of adding to them.
// Without a comparable entry (a function), each compiler is a writer of its own.
function writerOf(compiler) {
  if (compiler[WRITER]) return compiler[WRITER];
  const o = compiler.options || {}, out = o.output || {};
  const plain = (v) => (typeof v === 'function' || v === undefined ? null : v);
  const id = plain(o.entry) === null ? `#${++writers}`
    : JSON.stringify([compiler.name || null, o.entry, plain(o.target), plain(out.filename), plain(out.chunkFilename)]);
  return (compiler[WRITER] = id);
}

// webpack's output.clean removes everything else in the output directory, including what other compilers
// wrote there; dry runs and kept files do not.
function cleans(compilation) {
  const clean = compilation.outputOptions && compilation.outputOptions.clean;
  return clean === true || (!!clean && typeof clean === 'object' && !clean.dry && !clean.keep);
}

class BundleLockfilePlugin {
  // compilerFile: path of the Compiler module, used to find webpack-sources for webpack 4
  constructor(file, compilerFile) { this.file = file; this.compilerFile = compilerFile; }

  // Content of the lockfile this compilation emits: its packages, plus those of other compilers that write
  // the same lockfile (see core/outputs.cjs).
  lockfile(compilation) {
    const compiler = compilation.compiler;
    return outputs.record(path.join(compiler.outputPath, this.file), writerOf(compiler),
      packages.packagesForFiles(bundledFiles(compilation)), compiler.context, { replace: cleans(compilation) });
  }

  emit(compilation, write) {
    try { write(this.lockfile(compilation)); } catch (e) { config.warn('webpack: could not write lockfile:', e); }
  }

  apply(compiler) {
    compiler[APPLIED] = true;
    if (compiler.webpack) { // webpack 5
      const { Compilation, sources } = compiler.webpack;
      compiler.hooks.thisCompilation.tap(NAME, (compilation) => {
        compilation.hooks.processAssets.tap({ name: NAME, stage: Compilation.PROCESS_ASSETS_STAGE_REPORT }, () => {
          this.emit(compilation, (json) => compilation.emitAsset(this.file, new sources.RawSource(json)));
        });
      });
    } else { // webpack 4
      let RawSource;
      try { RawSource = createRequire(this.compilerFile || __filename)('webpack-sources').RawSource; } catch { /* fallback below */ }
      compiler.hooks.thisCompilation.tap(NAME, (compilation) => {
        // after every plugin's additionalAssets, whatever the plugin order (copy-webpack-plugin 6 adds its files there)
        compilation.hooks.afterOptimizeAssets.tap(NAME, () => {
          this.emit(compilation, (json) => {
            const src = RawSource ? new RawSource(json) : { source: () => json, size: () => Buffer.byteLength(json) };
            if (compilation.emitAsset) compilation.emitAsset(this.file, src); else compilation.assets[this.file] = src;
          });
        });
      });
    }
    // a lockfile shared with other compilers: write it again once this compiler's output has landed
    compiler.hooks.afterEmit.tapAsync(NAME, (compilation, callback) => {
      const file = path.join(compiler.outputPath, this.file);
      if (!outputs.isShared(file)) return callback();
      outputs.rewrite(file, (json, done) => compiler.outputFileSystem.writeFile(file, json, done), (err) => {
        if (err) config.warn('webpack: could not write lockfile:', err);
        callback();
      });
    });
  }
}

// Called once for every top-level compiler, before its first compilation. Tools can add their own (test/compare).
const listeners = [(compiler, where) => {
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
      for (const fn of listeners) {
        try { fn(this, where); } catch (e) { config.warn('webpack: could not apply plugin:', e); }
      }
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
  bundledFiles,
  sourceFile,
  onCompiler,
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
