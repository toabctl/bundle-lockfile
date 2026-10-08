'use strict';
// webpack 4 and 5, including the copy Next.js vendors (next/dist/compiled/webpack).
// Patches Compiler.prototype.compile so every top-level compiler (not child compilers such as
// html-webpack-plugin's) emits <output>/<BUNDLE_LOCKFILE_FILE> listing the packages in its output.
const fs = require('fs');
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
const CLOSED = Symbol.for('bundle-lockfile.webpack.closed');   // compiler: its shutdown hook has run
const SOURCE = Symbol('bundle-lockfile.webpack.source');       // compilation: { src: lockfile content, early: asset names then, disk, asset }
const BUNDLED = Symbol('bundle-lockfile.webpack.bundled');     // compilation: its bundledFiles()
const COPIED = Symbol('bundle-lockfile.webpack.copied');       // compiler: files its latest build copied in the emit hook
const NEXT_WEBPACK = /[\\/]next[\\/]dist[\\/]compiled[\\/]webpack[\\/]webpack(\.js)?$/;

// Source file of a module: nameForCondition(), webpack's own answer to "which file is this module" (the path
// module.rules match it against; also used for splitChunks tests, rules' issuer condition and webpack 5's stats). For a NormalModule it is the resource without query - or the match
// resource of a "<name>!=!<loaders>!<resource>" request: loaders that generate a module from a placeholder
// file name it that way (vanilla-extract's CSS reads @vanilla-extract/webpack-plugin/extracted.js), so the
// placeholder's package does not count. Modules such as mini-css-extract's CssModule implement it without
// having a resource (CssModule: the resource of the CSS module it came from, never its match resource); externals and webpack's runtime modules return null (webpack 4's base Module has
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
// which webpack takes out of the root's chunks (for their JavaScript).
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
//   compiler's context (webpack >= 4.40 has asset info). webpack's asset modules set it too; those are in a chunk anyway.
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
// (a build restarted in the same process, or run again by another process) replaces the previous one's packages
// instead of adding to them - in this process once the previous one is done: closed (webpack >= 5.17 has a shutdown
// hook), on older versions not running. Until then it is another writer: configs that differ only in what is not
// compared here (resolve.alias, loader options) can be built side by side into one directory, e.g. with
// [contenthash] file names. The id has no paths (the lockfile records it, and must be the same on every machine);
// the claims are per output directory.
const writers = globalThis[Symbol.for('bundle-lockfile.webpack.writers.v2')] ||
  (globalThis[Symbol.for('bundle-lockfile.webpack.writers.v2')] = { claims: new Map() }); // dir + id -> ref(compiler)
const ref = (o) => (typeof WeakRef === 'function' ? new WeakRef(o) : { deref: () => o }); // Node < 14.6: no WeakRef
const busy = (c) => (c.hooks && c.hooks.shutdown ? !c[CLOSED] : !!c.running);
function writerOf(compiler) {
  if (compiler[WRITER]) return compiler[WRITER];
  const o = compiler.options || {}, out = o.output || {};
  const plain = (v) => (typeof v === 'function' ? '(function)' : v === undefined ? null : v);
  let base;
  try { base = JSON.stringify([compiler.name || null, plain(o.entry), plain(o.target), plain(out.filename), plain(out.chunkFilename)]); }
  catch { base = JSON.stringify([compiler.name || null, '(not comparable)']); } // e.g. a BigInt in an entry option
  let id = base;
  for (let n = 2; ; n++) {
    const claim = `${compiler.outputPath}\0${id}`;
    const prev = writers.claims.has(claim) && writers.claims.get(claim).deref();
    if (!prev || prev === compiler || !busy(prev)) { writers.claims.set(claim, ref(compiler)); break; }
    id = `${base}#${n}`;
  }
  if (compiler.hooks && compiler.hooks.shutdown) compiler.hooks.shutdown.tap(NAME, () => { compiler[CLOSED] = true; });
  return (compiler[WRITER] = id);
}

// The output is on the real disk, where other processes may write the same lockfile: webpack's own Node file system
// (webpack 5: graceful-fs, in whatever copy - webpack's dependency, the one Next.js bundles; webpack 4:
// NodeOutputFileSystem), or Node's fs; not e.g. webpack-dev-middleware's in-memory one (memfs). graceful-fs is known
// by its gracefulify(): a plugin configured by hand does not know where webpack is to resolve webpack's graceful-fs.
function onDisk(compiler) {
  const fsys = compiler.outputFileSystem;
  if (!fsys) return false;
  if (fsys.constructor && fsys.constructor.name === 'NodeOutputFileSystem') return true;
  return fsys === fs || typeof fsys.gracefulify === 'function';
}

// The directory webpack writes a compilation's assets to: output.path can hold placeholders, e.g. [fullhash].
const outputDir = (compilation) =>
  (typeof compilation.getPath === 'function' ? compilation.getPath(compilation.compiler.outputPath, {}) : compilation.compiler.outputPath);

// The files webpack writes assets to: the name without a query string. webpack >= 5.104 also cuts at a
// fragment ("#"), older versions keep it: both names are listed, either one being there counts (see prune).
function assetFiles(dir, names) {
  const files = [];
  for (const n of names) {
    const name = n.split('?')[0], hash = name.indexOf('#');
    files.push(path.join(dir, name));
    if (hash >= 0) files.push(path.join(dir, name.slice(0, hash)));
  }
  return files;
}

const assetNames = (compilation) => (compilation.getAssets ? compilation.getAssets().map(a => a.name) : Object.keys(compilation.assets || {}));
const assetOf = (compilation, name) => (compilation.getAsset ? compilation.getAsset(name)
  : compilation.assets[name] && { name, source: compilation.assets[name], info: {} }); // webpack < 4.40: no asset info

// Files copied into the output in the emit hook, after the lockfile was emitted (copy-webpack-plugin 5, for
// webpack 4). An asset with info.sourceFilename names its file. copy-webpack-plugin 5's do not, but it adds the
// files it copied to the compilation's file dependencies (in its afterEmit): an asset whose bytes are those of
// a dependency in node_modules is a copy of it. Empty assets are skipped, they would equal every empty file.
// On watch rebuilds, copy-webpack-plugin 5 does not add unchanged files again: they stay in the output from
// an earlier build, as long as the plugin still copies them (they are still file dependencies).
// early: asset names when the lockfile was emitted; previous: what this returned for the compiler's previous
// build; readAsset(name, callback(Buffer | null)); done(files) gets Map(asset name -> absolute path of the file).
function lateFiles(compilation, early, previous, readAsset, done) {
  const files = new Map(), unnamed = [];
  for (const name of assetNames(compilation).filter(n => !early.has(n))) {
    const a = assetOf(compilation, name), info = (a && a.info) || {};
    if (typeof info.sourceFilename === 'string') files.set(name, path.resolve(compilation.compiler.context, info.sourceFilename));
    else unnamed.push(name);
  }
  if (!unnamed.length && !previous.size) return done(files);
  const deps = new Set(compilation.fileDependencies || []);
  for (const [name, f] of previous) if (!hasAsset(compilation, name) && deps.has(f)) files.set(name, f);
  const bySize = new Map(); // size -> dependencies in node_modules
  for (const f of unnamed.length ? deps : []) {
    let size;
    try { size = packages.packageRoot(f) && fs.statSync(f).size; } catch { continue; }
    if (size) bySize.set(size, [...(bySize.get(size) || []), f]);
  }
  if (!bySize.size) return done(files);
  let pending = unnamed.length;
  for (const name of unnamed) {
    readAsset(name, (buf) => {
      const copy = ((buf && bySize.get(buf.length)) || []).find((f) => { try { return buf.equals(fs.readFileSync(f)); } catch { return false; } });
      if (copy) files.set(name, copy);
      if (--pending === 0) done(files);
    });
  }
}

class BundleLockfilePlugin {
  // compilerFile: path of the Compiler module, used to find webpack-sources for webpack < 5.1
  constructor(file, compilerFile) { this.file = file; this.compilerFile = compilerFile; }

  // Content of the lockfile this compilation emits: its packages, plus those of other compilers that write
  // the same lockfile (see core/outputs.cjs). extra: more files in the output (see lateFiles).
  lockfile(compilation, extra = []) {
    const compiler = compilation.compiler, dir = outputDir(compilation);
    const bundled = compilation[BUNDLED] || (compilation[BUNDLED] = bundledFiles(compilation));
    return outputs.record(path.join(dir, this.file), writerOf(compiler), packages.packagesOfOutput([...bundled, ...extra]),
      compiler.context, assetFiles(dir, assetNames(compilation).filter(n => n !== this.file)), { disk: onDisk(compiler) });
  }

  emit(compilation, write) {
    try { write(this.lockfile(compilation)); } catch (e) { config.warn('webpack: could not write lockfile:', e); }
  }

  apply(compiler) {
    compiler[APPLIED] = true;
    let RawSource = compiler.webpack && compiler.webpack.sources.RawSource; // webpack >= 5.1
    if (!RawSource) try { RawSource = createRequire(this.compilerFile || __filename)('webpack-sources').RawSource; } catch { /* fallback below */ }
    const add = (compilation, src) => {
      if (compilation.emitAsset) compilation.emitAsset(this.file, src); else compilation.assets[this.file] = src;
    };
    compiler.hooks.thisCompilation.tap(NAME, (compilation) => {
      // After processAssets: its taps with additionalAssets: true also get the assets added in any later stage,
      // so compression-webpack-plugin with deleteOriginalAssets would replace the lockfile by a .gz no SBOM
      // tool reads. webpack 4's afterOptimizeAssets (in webpack 5 the same hook) runs after every plugin's
      // additionalAssets, whatever the plugin order (copy-webpack-plugin 6 adds its files there).
      (compilation.hooks.afterProcessAssets || compilation.hooks.afterOptimizeAssets).tap(NAME, () => {
        this.emit(compilation, (json) => {
          const src = RawSource ? new RawSource(json) : { source: () => json, size: () => Buffer.byteLength(json) };
          // On the real disk the lockfile is no asset: other processes may write it too, and webpack would write the
          // asset - rendered now, before they have written theirs - over the packages they put there since, without
          // the lock. It is written in afterEmit, under the lock, like every other write of it (see rewrite).
          // In memory (webpack-dev-server) it is an asset, which only this process writes.
          const disk = onDisk(compiler);
          compilation[SOURCE] = { src, early: new Set([...assetNames(compilation), this.file]), disk, asset: config.inline && !disk };
          if (compilation[SOURCE].asset) add(compilation, src); // else written in afterEmit (inline and export copy)
        });
      });
    });
    // Plugins that delete assets in the emit hook (compression-webpack-plugin <= 6 with deleteOriginalAssets
    // on webpack 4): put the lockfile back, after them.
    compiler.hooks.emit.tap({ name: NAME, stage: 1000 }, (compilation) => {
      if (!compilation[SOURCE] || !compilation[SOURCE].asset || hasAsset(compilation, this.file)) return;
      config.debug('webpack: lockfile asset was deleted by another plugin, emitting it again:', this.file);
      add(compilation, compilation[SOURCE].src);
    });
    // Once this compiler's output has landed (after other plugins' afterEmit, where copy-webpack-plugin 5 adds
    // its file dependencies): write the lockfile again if files copied in the emit hook add packages, or if it
    // is shared with other compilers - without the compilers whose files are gone (deleted by this one's
    // output.clean, which ran before its emit).
    compiler.hooks.afterEmit.tapAsync({ name: NAME, stage: 1000 }, (compilation, callback) => {
      const dir = outputDir(compilation), file = path.join(dir, this.file);
      const writer = writerOf(compiler);
      const fsys = compiler.outputFileSystem;
      const readAsset = (name, cb) => {
        try { const s = assetOf(compilation, name).source.source(); return cb(Buffer.isBuffer(s) ? s : Buffer.from(s)); } catch { /* see below */ }
        // webpack 5 keeps only the size of an emitted asset: read the file
        if (typeof fsys.readFile !== 'function') return cb(null);
        try { fsys.readFile(path.join(dir, name.split('?')[0]), (err, buf) => cb(err ? null : buf)); } catch { cb(null); }
      };
      let landed = false;
      const land = (copied) => {
        if (landed) return; // once, also if lateFiles fails after calling it
        landed = true;
        compiler[COPIED] = copied;
        let write = false;
        if (copied.size) {
          try { this.lockfile(compilation, [...copied.values()]); write = true; } catch (e) { config.warn('webpack: could not write lockfile:', e); }
        }
        outputs.emitted(file, writer);
        // the inline file on the real disk after every build; in memory again if late copies added packages or
        // other compilers write it too; the export copy (BUNDLE_LOCKFILE_EXPORT_DIR) after every build
        const disk = compilation[SOURCE] ? compilation[SOURCE].disk : onDisk(compiler);
        const inline = config.inline && (disk || write || outputs.isShared(file));
        if (!inline && !outputs.exportPath(file)) {
          if (!config.inline) outputs.nowhere();
          return callback();
        }
        // lstat: a symbolic link asset (webpack >= 5.111) is there also if what it points at is not.
        // webpack 4's output file system has neither (nor output.clean). Anything but "not found" counts as
        // there: when in doubt, keep the packages
        const stat = ['lstat', 'stat'].find(m => typeof fsys[m] === 'function');
        const exists = (f, cb) => {
          if (!stat) return cb(true);
          try { fsys[stat](f, (err) => cb(!err || err.code !== 'ENOENT')); } catch { cb(true); }
        };
        outputs.prune(file, writer, exists, () => {
          const writeFile = !inline ? null : disk ? outputs.writeDisk(file) : (json, done) => fsys.writeFile(file, json, done);
          outputs.rewrite(file, writeFile, (err) => {
            if (err) config.warn('webpack: could not write lockfile:', err);
            else if (inline) config.debug('webpack: wrote', file);
            callback();
          });
        });
      };
      if (!compilation[SOURCE]) return land(new Map());
      try { lateFiles(compilation, compilation[SOURCE].early, compiler[COPIED] || new Map(), readAsset, land); } catch (e) {
        config.warn('webpack: could not check files copied in the emit hook:', e);
        land(new Map());
      }
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

// In Next 12-15, next/dist/compiled/webpack/webpack.js only exports init() when it is loaded; init() then fills
// in exports.webpack (Object.assign(exports, require('./bundle5')())). Next 16 fills the exports when the module
// is loaded (no init()). Patch an already filled copy right away, and otherwise right after init().
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
