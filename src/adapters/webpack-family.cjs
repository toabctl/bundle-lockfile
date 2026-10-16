'use strict';
// BundleLockfilePlugin, shared by webpack 4 and 5 (also Next.js' copy) and rspack: writes <output>/<BUNDLE_LOCKFILE_FILE>
// for every top-level compiler, at the right moments of its builds. Which source files are in the output is
// webpack-collect.cjs's part, what differs between the compilers webpack-compat.cjs's. The adapters (webpack.cjs,
// rspack.cjs) only hook the bundler and apply the plugin.
/** @import { LateFile, Package } from '../types' */
/** @import { Compilation as Collected, Copies } from './webpack-collect.cjs' */
/** @import { Compiler as BaseCompiler, Hook, InputFileSystem, OutputFileSystem, Source } from './webpack-types' */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const config = require('../core/config.cjs');
const packages = require('../core/packages.cjs');
const outputs = require('../core/outputs.cjs');
const problems = require('../core/problems.cjs');
const via = require('../core/via.cjs');
const { filesWrittenAfter } = require('../core/late.cjs');
const { portable, exportPath, inToolCache, ancestors, real, JS } = require('../core/paths.cjs');
const { bundlerPackage, packageOnStack } = require('../core/bundler.cjs');
const { readManifest } = require('../core/manifest.cjs');
const { isObject, isArray, perProcess } = require('../core/values.cjs');
const {
  hook, kindOf, isRspack, versionOf, outputDir, hasAsset, assetNames, readAsset, emitAsset, rawSourceOf, sourceOf, existsIn, writeIn,
  onDisk, optimizeStage,
} = require('./webpack-compat.cjs');
const {
  KINDS, HELPERS, UNNAMED, sourceFile, bundledFiles, entryFiles, copiedUnnamed, copiedRspack, copiedInEmit, copiedLate,
  generatedAssets, lateGenerated,
} = require('./webpack-collect.cjs');

const NAME = 'bundle-lockfile';
const APPLIED = Symbol.for('bundle-lockfile.webpack.applied'); // compiler: has a BundleLockfilePlugin
const WRITER = Symbol.for('bundle-lockfile.webpack.writer');
const CLOSED = Symbol.for('bundle-lockfile.webpack.closed');   // compiler: its shutdown hook has run
const SOURCE = Symbol('bundle-lockfile.webpack.source');       // compilation: { src: lockfile content, early: asset names then, disk, asset }
const BUNDLED = Symbol('bundle-lockfile.webpack.bundled');     // compilation: its bundledFiles()
const COPIED = Symbol('bundle-lockfile.webpack.copied');       // compiler: files its latest build copied in the emit hook
const STARTED = Symbol('bundle-lockfile.webpack.started');     // compilation: when it started (ms; see filesWrittenAfter)
const GENERATED = Symbol('bundle-lockfile.webpack.generated'); // compilation: its generatedAssets() (before emit: sources)
const READS = Symbol('bundle-lockfile.webpack.reads');         // compiler: the files read while its compilation's assets are processed (readsOf)
const LATE = Symbol('bundle-lockfile.webpack.late');           // compilation: its copiedLate()
const SKIP = Symbol('bundle-lockfile.webpack.skip');           // compilation: writes into a tool's cache, no lockfile
const READING = Symbol.for('bundle-lockfile.webpack.reading.v1'); // input file system: the sets readsOf notes its reads in
const BUNDLER_FILE = Symbol.for('bundle-lockfile.webpack.bundler-file'); // Compiler.prototype: the file it was patched in
/**
 * A compiler and a compilation, with what this module notes on them
 * @typedef {BaseCompiler & { [APPLIED]?: boolean, [WRITER]?: string, [CLOSED]?: boolean, [COPIED]?: Copies, [READS]?: Reads | null,
 *   [BUNDLER_FILE]?: string }} Compiler
 * @typedef {Collected & { compiler: Compiler, [SOURCE]?: { src: Source, early: Set<string>, disk: boolean, asset: boolean },
 *   [BUNDLED]?: Set<string>, [STARTED]?: number, [GENERATED]?: Package[], [LATE]?: Copies, [SKIP]?: boolean }} Compilation
 * @typedef {{ files: Set<string>, stop: () => void }} Reads the files read meanwhile (readsOf)
 * @typedef {NonNullable<BaseCompiler['options']>} Options
 */

// Compilers that write the same files are one writer of a shared lockfile: a new compiler for the same config
// (a build restarted in the same process, or run again by another process) replaces the previous one's packages
// instead of adding to them - in this process once the previous one is done: closed (webpack >= 5.17 has a shutdown
// hook), on older versions not running. Until then it is another writer: configs that differ only in what is not
// compared here (resolve.alias, loader options) can be built side by side into one directory, e.g. with
// [contenthash] file names. The id has no paths of this machine (the lockfile records it, and must be the same on
// every machine): absolute paths in the options (entry: path.resolve(__dirname, ...)) are relative to the context, those
// in a package from its node_modules (see core/paths.cjs portable).
// The claims are per output directory.
/** @type {{ claims: Map<string, WeakRef<Compiler>> }} */
const writers = perProcess(Symbol.for('bundle-lockfile.webpack.writers.v2'), () => ({ claims: new Map() })); // dir + id -> ref(compiler)
/** @param {Compiler} c */
const busy = (c) => (hook(c.hooks, 'shutdown') ? !c[CLOSED] : !!c.running);
/** @param {Compiler} compiler @returns {string} */
function compilerWriter(compiler) {
  if (compiler[WRITER]) return compiler[WRITER];
  /** @type {Options} */
  const o = compiler.options || {};
  const out = o.output || {};
  /** @type {(v: unknown) => unknown} */
  const plain = (v) => (typeof v === 'function' ? '(function)' : v === undefined ? null : v);
  /** @type {string} */
  let base;
  try {
    const parts = [compiler.name || null, plain(o.entry), plain(o.target), plain(out.filename), plain(out.chunkFilename)];
    base = JSON.stringify(parts, (k, /** @type {unknown} */ v) => portable(compiler.context, v));
  } catch { base = JSON.stringify([compiler.name || null, '(not comparable)']); } // e.g. a BigInt in an entry option
  let id = base;
  for (let n = 2; ; n++) {
    const claim = `${compiler.outputPath}\0${id}`;
    const ref = writers.claims.get(claim), prev = ref && ref.deref();
    if (!prev || prev === compiler || !busy(prev)) { writers.claims.set(claim, new WeakRef(compiler)); break; }
    id = `${base}#${n}`;
  }
  const shutdown = hook(compiler.hooks, 'shutdown');
  if (shutdown) shutdown.tap(NAME, () => { compiler[CLOSED] = true; });
  return (compiler[WRITER] = id);
}

// The files webpack writes assets to: the name without a query string. webpack >= 5.104 also cuts at a
// fragment ("#"), older versions keep it: both names are listed, either one being there counts (see prune).
/** @param {string} dir @param {string[]} names */
function assetFiles(dir, names) {
  /** @type {string[]} */
  const files = [];
  for (const n of names) {
    const name = n.split('?')[0], hash = name.indexOf('#');
    files.push(path.join(dir, name));
    if (hash >= 0) files.push(path.join(dir, name.slice(0, hash)));
  }
  return files;
}

// Fails the compilation with what core/problems.cjs has recorded, in strict mode: as a compilation error, also after
// emit - webpack (4, 5), rspack, Rsbuild and Next.js report it like any other, the build fails (exit code 1,
// stats.hasErrors()), before emit with emitOnErrors: false (the production default) nothing is written, and watch mode
// keeps running and recovers. Not as a callback error (webpack-cli and rspack-cli exit with 2 and stop watching, the
// watch API stops rebuilding) and never as a throw from a tap (webpack 4 exits 0 then, Next.js 16 hangs).
// webpack >= 5.1 and rspack have WebpackError (hideStack: no stack in the output, the message says where); webpack 4
// and 5.0 (no compiler.webpack) take any Error.
/** @param {Compiler | undefined} compiler @param {Error} err @returns {Error} */
function compilationError(compiler, err) {
  const E = compiler && compiler.webpack && compiler.webpack.WebpackError;
  if (typeof E !== 'function') return err;
  try { const e = new E(err.message); e.hideStack = true; e.stack = err.stack; return e; } catch { return err; }
}
/** @param {Compilation} compilation */
const failCompilation = (compilation) => problems.failIfAny((err) => compilation.errors.push(compilationError(compilation.compiler, err)));

// Why the plugin cannot work in this compiler, or null: rspack before 1.1 lacks what it needs (the inner modules of
// concatenated modules)
/** @param {Compiler} compiler @returns {string | null} */
function unsupported(compiler) {
  if (!isRspack(compiler)) return null;
  const v = compiler.webpack.rspackVersion, [major, minor] = versionOf(v);
  return major > 1 || (major === 1 && minor >= 1) ? null : `rspack ${v} is not supported (it needs 1.1 or later): no lockfile for ${compiler.outputPath || 'the compiler'}`;
}

// The bundler package of a compiler whose output has JavaScript the bundler wrote (its runtime, chunk wrappers; see
// core/bundler.cjs): webpack, Next.js' copy of it (next/dist/compiled/webpack, at the version the compiler says), or
// @rspack/core - the copy whose Compiler webpack.cjs or rspack.cjs patched. A plugin in the config of a build without the
// preload: the copy that applied it (`applier`: its package.json, a file on the stack of apply()), else the one the
// compiler's context resolves, if it is of the compiler's version - else a problem: the copy that ran is not known.
/** @param {Compiler} compiler */
const bundlerName = (compiler) => (isRspack(compiler) ? '@rspack/core' : 'webpack');
/** @param {Compiler} compiler @param {string | null | undefined} applier @returns {Package | null} */
function bundlerOf(compiler, applier) {
  const rspack = isRspack(compiler), kind = rspack ? 'rspack' : 'webpack', name = bundlerName(compiler);
  const version = compiler.webpack ? (rspack ? compiler.webpack.rspackVersion : compiler.webpack.version) : undefined;
  const file = compiler[BUNDLER_FILE] || applier;
  if (file) return bundlerPackage(kind, file, [name], version);
  /** @type {string | null} */
  let found = null;
  try { found = createRequire(path.join(compiler.context, 'x')).resolve(`${name}/package.json`); } catch { /* none */ }
  const p = found ? bundlerPackage(kind, found, [name], version) : null;
  if (!found || (p && version && p.version !== version)) {
    problems.problem(`${kind}: the compiler of ${compiler.outputPath || '(no output path)'} is ${name}${version ? `@${version}` : ''}, which was not loaded with the preload, and ${found ? `${found} is another copy` : `${compiler.context} resolves no ${name}`}: the lockfile would miss the bundler, whose code is in the output`);
    return null;
  }
  return p;
}
// The compilation writes JavaScript chunks (not only style sheets or assets).
/** @param {Compilation} compilation */
const writesJs = (compilation) => [...(compilation.chunks || [])].some(c => [...(c.files || [])].some(f => JS.test(f.split('?')[0])));

// Notes the files in node_modules read through the compiler's input file system from now until stop(): the files
// plugins read to emit them as assets while the assets are processed (see copiedLate). readFile is wrapped once per
// file system (compilers can share one); it notes into the sets of the compilations that are looking.
/** @param {Compiler} compiler @returns {Reads} */
function readsOf(compiler) {
  /** @type {Set<string>} */
  const files = new Set();
  /** @type {(InputFileSystem & { [READING]?: Set<Set<string>> }) | null | undefined} */
  const fsys = compiler.inputFileSystem;
  if (!fsys || typeof fsys.readFile !== 'function') return { files, stop: () => {} };
  let sets = fsys[READING];
  if (!sets) {
    /** @type {Set<Set<string>>} */
    const all = new Set();
    const orig = fsys.readFile, inPackages = `${path.sep}node_modules${path.sep}`;
    try {
      fsys.readFile = function (/** @type {unknown} */ file, /** @type {unknown[]} */ ...rest) {
        if (all.size && typeof file === 'string' && file.includes(inPackages)) for (const s of all) s.add(file);
        return orig.call(this, file, ...rest);
      };
      Object.defineProperty(fsys, READING, { value: all });
      sets = all;
    } catch { return { files, stop: () => {} }; } // (a file system whose readFile cannot be replaced)
  }
  sets.add(files);
  return { files, stop: () => { sets.delete(files); } };
}

// The files rspack's built-in HtmlRspackPlugin reads in Rust (no input file system sees it): its favicon, relative to
// the context
/** @param {Compiler} compiler @returns {string[]} */
function builtinFavicons(compiler) {
  /** @type {string[]} */
  const out = [];
  for (const p of (compiler.options && compiler.options.plugins) || []) {
    const o = isObject(p) && p.name === 'HtmlRspackPlugin' && isArray(p._args) && p._args[0];
    if (isObject(o) && typeof o.favicon === 'string') out.push(path.resolve(compiler.context, o.favicon));
  }
  return out;
}

// The version of the webpack package a file of it is in (lib/Compiler.js, its package.json), or null
/** @param {string | null | undefined} file @returns {string | null} */
function webpackVersionOf(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  for (const d of ancestors(path.dirname(file))) {
    const j = readManifest(d);
    if (j && typeof j.name === 'string') return j.name === 'webpack' && typeof j.version === 'string' ? j.version : null;
  }
  return null;
}

// The lockfile is BUNDLE_LOCKFILE_FILE in the output directory: bundle-lockfile finds an output's lockfile by that name
// (a build that bundles the output, copies of it). A plugin added to a config by hand may name the file too: another
// name than the setting's is a problem - the lockfile would not be where the build was asked to write it. Returns the
// problem, or null.
/** @param {unknown} file @returns {string | null} */
function misnamed(file) {
  if (file === undefined || file === null) return null;
  const norm = (/** @type {string} */ f) => path.posix.normalize(f.trim().split(path.sep).join('/'));
  // (with BUNDLE_LOCKFILE_TREE=only the setting names the package-lock.json whose record.json is written instead)
  const named = [config.file, config.tree === 'only' ? config.file.replace(/record\.json$/, 'package-lock.json') : config.file].map(norm);
  if (typeof file === 'string' && named.includes(norm(file))) return null;
  return `BundleLockfilePlugin(${JSON.stringify(file)}) names another file than BUNDLE_LOCKFILE_FILE (${named[1]}), where the lockfile is written: set BUNDLE_LOCKFILE_FILE instead (or leave the argument out)`;
}

class BundleLockfilePlugin {
  // file: BUNDLE_LOCKFILE_FILE's, or left out (see misnamed); compilerFile: path of the Compiler module, used to find
  // webpack-sources and the version of webpack < 5.1 (else that of the patched Compiler or the copy that applied the
  // plugin)
  /** @param {unknown} [file] @param {string} [compilerFile] */
  constructor(file, compilerFile) { this.file = config.file; this.misnamed = misnamed(file); this.compilerFile = compilerFile; }

  // Content of the lockfile this compilation emits: its packages, plus those of other compilers that write
  // the same lockfile (see core/outputs.cjs). copied: files copied into the output in the emit hook (see copiedInEmit);
  // late: { generated, late } packages of generate-only output emitted late and of files written into the output after
  // the build
  /**
   * @param {Compilation} compilation
   * @param {Copies} [copied]
   * @param {{ generated?: Package[], late?: Package[] }} [late]
   * @returns {string}
   */
  lockfile(compilation, copied = new Map(), late = {}) {
    const compiler = compilation.compiler, dir = outputDir(compilation);
    const bundled = compilation[BUNDLED] || (compilation[BUNDLED] = bundledFiles(compilation));
    const kinds = new Map(compilation[KINDS] || []);
    // the files copied while the assets were processed (copiedLate; still assets: not deleted in the emit hook), and in
    // the emit hook
    /** @type {Copies} */
    const lateCopies = compilation[LATE] || new Map();
    /** @type {Copies} */
    const all = new Map([...[...lateCopies].filter(([name]) => hasAsset(compilation, name)), ...copied]);
    const copiedFiles = [...all.values()].flatMap(c => c.files);
    for (const { files, bytes } of all.values()) for (const f of files) kinds.set(f, new Set([...(kinds.get(f) || []), bytes ? 'copy-bytes' : 'copy-source']));
    const build = { context: compiler.context, entries: entryFiles(compilation) }; // for vendored copies
    const gen = compilation[GENERATED] || (compilation[GENERATED] = generatedAssets(compilation));
    const result = packages.packagesOfFiles([...bundled, ...copiedFiles], build);
    const found = via.ofFiles(result, kinds);
    found.add('generated', gen); found.add('generated', late.generated); found.add('late', late.late);
    // the bundler, whose runtime and chunk wrappers are in the JavaScript it writes (see bundlerOf)
    const own = writesJs(compilation) ? [bundlerOf(compiler, this.applier)].filter(p => p !== null) : [];
    found.add('runtime', own);
    // the transpilers whose helpers they inlined into shipped modules (core/helpers.cjs)
    const inl = compilation[HELPERS] || [];
    found.add('helpers', inl);
    const pkgs = packages.unique(result.all, gen, late.generated || [], late.late || [], own, inl);
    return outputs.record(path.join(dir, this.file), compilerWriter(compiler), pkgs,
      compiler.context, assetFiles(dir, assetNames(compilation).filter(n => n !== this.file)),
      { disk: onDisk(compiler), bundler: this.bundler(compiler), via: found, run: compiler });
  }

  // { name, version } of the bundler of a compiler (core/lockfile.cjs): rspack's version, webpack 5's, or webpack 4's
  // from the package.json of the Compiler module's package
  /** @param {Compiler} compiler @returns {{ name: string, version?: string }} */
  bundler(compiler) {
    if (isRspack(compiler)) return { name: 'rspack', version: compiler.webpack.rspackVersion };
    if (compiler.webpack && typeof compiler.webpack.version === 'string') return { name: 'webpack', version: compiler.webpack.version };
    if (this.bundlerVersion === undefined) {
      this.bundlerVersion = webpackVersionOf(this.compilerFile || compiler[BUNDLER_FILE]) || webpackVersionOf(this.applier);
    }
    return { name: 'webpack', ...(this.bundlerVersion ? { version: this.bundlerVersion } : {}) };
  }

  /** @param {Compiler} compiler */
  apply(compiler) {
    compiler[APPLIED] = true;
    // every hook of the plugin runs as part of this compiler's builds: the problems it records fail this compiler's
    // compilations, never another compiler's (core/problems.cjs within)
    /** @type {<A extends unknown[]>(h: Hook<A>) => Hook<A>} */
    const own = (h) => h && {
      tap: (opts, fn) => h.tap(opts, (...args) => problems.within(compiler, () => fn(...args))),
      tapAsync: (opts, fn) => h.tapAsync(opts, (...args) => problems.within(compiler, () => fn(...args))),
    };
    // a plugin from the config, in a build without the preload: the bundler that applies it (see bundlerOf)
    if (!compiler[BUNDLER_FILE]) this.applier = packageOnStack([bundlerName(compiler)]);
    const why = unsupported(compiler);
    if (why) { // each compilation fails (strict mode), or a warning once
      own(compiler.hooks.thisCompilation).tap(NAME, (/** @type {Compilation} */ compilation) => {
        problems.problem(why, null, { once: why });
        failCompilation(compilation);
      });
      return;
    }
    const RawSource = rawSourceOf(compiler, this.compilerFile);
    own(compiler.hooks.thisCompilation).tap(NAME, (/** @type {Compilation} */ compilation) => {
      if (this.misnamed) problems.problem(this.misnamed, null, { once: this.misnamed });
      // an output below node_modules is a tool's cache (core/paths.cjs inToolCache): no lockfile, as for every bundler
      if (inToolCache(outputDir(compilation))) {
        compilation[SKIP] = true;
        config.debug(`${kindOf(compiler)}: ${outputDir(compilation)} is below node_modules (a tool's cache): no lockfile`);
        failCompilation(compilation);
        return;
      }
      compilation[STARTED] = Date.now() - 2000; // (file systems with coarse timestamps)
      // a plugin that makes webpack seal the compilation again (needAdditionalSeal): new chunks and assets
      const unseal = hook(compilation.hooks, 'unseal');
      const marks = /** @type {const} */ ([BUNDLED, KINDS, HELPERS, UNNAMED, SOURCE, GENERATED, LATE]);
      if (unseal) unseal.tap(NAME, () => { for (const k of marks) delete compilation[k]; });
      // webpack 5 and rspack: copied files, before the optimize stages change their bytes (copiedUnnamed, copiedRspack)
      const processAssets = hook(compilation.hooks, 'processAssets');
      const optimize = optimizeStage(compiler, compilation);
      if (processAssets && optimize !== undefined) {
        own(processAssets).tap({ name: NAME, stage: optimize - 1 }, () => {
          try { compilation[UNNAMED] = isRspack(compiler) ? copiedRspack(compilation) : copiedUnnamed(compilation); } catch (e) {
            problems.problem(`${kindOf(compiler)}: could not check the files copied into ${outputDir(compilation)}`, e);
          }
          // the files plugins read from now on, to emit them as assets (copiedLate); the previous compilation's reads
          // end here if it never got to afterProcessAssets (it failed)
          if (compiler[READS]) compiler[READS].stop();
          compiler[READS] = readsOf(compiler);
        });
      }
      // After processAssets: its taps with additionalAssets: true also get the assets added in any later stage,
      // so compression-webpack-plugin with deleteOriginalAssets would replace the lockfile by a .gz no SBOM
      // tool reads. webpack 4's afterOptimizeAssets (in webpack 5 the same hook) runs after every plugin's
      // additionalAssets, whatever the plugin order (copy-webpack-plugin 6 adds its files there).
      // (webpack 4 has the one, webpack 5 and rspack both)
      own(/** @type {Hook} */ (hook(compilation.hooks, 'afterProcessAssets') || hook(compilation.hooks, 'afterOptimizeAssets'))).tap(NAME, () => {
        const reads = compiler[READS];
        if (reads) { reads.stop(); compiler[READS] = null; }
        try {
          const read = [...(reads ? reads.files : []), ...(isRspack(compiler) ? builtinFavicons(compiler) : [])];
          if (read.length) compilation[LATE] = copiedLate(compilation, read, compilation[UNNAMED]);
        } catch (e) { problems.problem(`${kindOf(compiler)}: could not check the files copied into ${outputDir(compilation)}`, e); }
        try {
          const json = this.lockfile(compilation);
          const src = sourceOf(RawSource, json);
          // On the real disk the lockfile is no asset: other processes may write it too, and webpack would write the
          // asset - rendered now, before they have written theirs - over the packages they put there since, without
          // the lock. It is written in afterEmit, under the lock, like every other write of it (see rewrite).
          // In memory (webpack-dev-server) it is an asset, which only this process writes.
          const disk = onDisk(compiler);
          compilation[SOURCE] = { src, early: new Set([...assetNames(compilation), this.file]), disk, asset: config.inline && !disk };
          if (compilation[SOURCE].asset) emitAsset(compilation, this.file, src); // else written in afterEmit (inline and export copy)
        } catch (e) { problems.problem(`${kindOf(compiler)}: could not collect the packages of ${outputDir(compilation)}`, e); }
        failCompilation(compilation);
      });
    });
    // Plugins that delete assets in the emit hook (compression-webpack-plugin <= 6 with deleteOriginalAssets
    // on webpack 4): put the lockfile back, after them.
    own(compiler.hooks.emit).tap({ name: NAME, stage: 1000 }, (/** @type {Compilation} */ compilation) => {
      if (!compilation[SOURCE] || !compilation[SOURCE].asset || hasAsset(compilation, this.file)) return;
      config.debug('webpack: lockfile asset was deleted by another plugin, emitting it again:', this.file);
      emitAsset(compilation, this.file, compilation[SOURCE].src);
    });
    // Once this compiler's output has landed (after other plugins' afterEmit, where copy-webpack-plugin 5 adds
    // its file dependencies): write the lockfile again if files copied in the emit hook add packages, or if it
    // is shared with other compilers - without the compilers whose files are gone (deleted by this one's
    // output.clean, which ran before its emit).
    own(compiler.hooks.afterEmit).tapAsync({ name: NAME, stage: 1000 }, (/** @type {Compilation} */ compilation, callback) => {
      if (compilation[SKIP]) { problems.outside(callback); return; }
      // the end of this hook: what went wrong fails the build (a compilation error, see failCompilation) - outside the
      // promise and outside this compiler's builds (core/problems.cjs outside): callback() continues webpack's work, which
      // may start another compiler (a config array's dependencies)
      void this.afterEmit(compilation)
        .catch((e) => { problems.problem(`${kindOf(compiler)}: could not write the lockfile of ${outputDir(compilation)}`, e); })
        .then(() => setImmediate(() => {
          // (a failure that cannot even be recorded must not lose the callback: webpack would wait forever)
          try { failCompilation(compilation); } catch (e) { config.error(`${kindOf(compiler)}: could not fail the build of ${outputDir(compilation)}:`, e); process.exitCode = 1; }
          problems.outside(callback);
        }));
    });
  }

  // The compilation's output has landed (see apply): the files copied into it in the emit hook, the generate-only
  // output emitted there, the files other plugins wrote into it, then the lockfile written.
  /** @param {Compilation} compilation @returns {Promise<void>} */
  async afterEmit(compilation) {
    const compiler = compilation.compiler, kind = kindOf(compiler);
    const dir = outputDir(compilation), file = path.join(dir, this.file);
    const writer = compilerWriter(compiler);
    /** @type {Copies} */
    let copied = new Map();
    /** @type {Package[]} */
    let late = [];
    if (compilation[SOURCE]) {
      const early = compilation[SOURCE].early;
      const bytes = (/** @type {string} */ name) => readAsset(compilation, dir, name);
      try { late = await lateGenerated(compilation, early, bytes); } catch (e) {
        problems.problem(`${kind}: could not look for the output of generate-only builds among the assets of ${dir}`, e);
      }
      try { copied = await copiedInEmit(compilation, early, compiler[COPIED] || new Map(), bytes); } catch (e) {
        problems.problem(`${kind}: could not check the files copied into ${dir} in the emit hook`, e);
      }
    }
    compiler[COPIED] = copied;
    let write = false;
    const disk = compilation[SOURCE] ? compilation[SOURCE].disk : onDisk(compiler);
    // files other plugins wrote into the output directory since the build started (filemanager-webpack-plugin's
    // copies in afterEmit; see core/late.cjs)
    /** @type {LateFile[]} */
    let after = [];
    if (disk && compilation[STARTED] && fs.existsSync(dir)) {
      try {
        const known = new Set([...assetFiles(dir, assetNames(compilation)), ...outputs.filesOf(file)]);
        after = filesWrittenAfter(dir, { since: compilation[STARTED], cwd: real(process.cwd()), roots: [compiler.context], skip: path.dirname(file), known });
        if (after.length) config.debug(`${kind}: files written into`, dir, 'after the build:', after.map(l => path.relative(dir, l.file)).join(' '));
      } catch (e) { problems.problem(`${kind}: could not check the files written into ${dir} after the build`, e); }
    }
    const more = { generated: late, late: after.flatMap(l => l.pkgs) };
    if (copied.size || more.generated.length || more.late.length) {
      try { this.lockfile(compilation, copied, more); write = true; } catch (e) { problems.problem(`${kind}: could not collect the packages of ${dir}`, e); }
    }
    // the files webpack wrote: assets the emit hook deleted or added (compression-webpack-plugin <= 6 with
    // deleteOriginalAssets on webpack 4 replaces main.js by main.js.gz) were not known when the lockfile was rendered
    if (!write) outputs.setFiles(file, writer, assetFiles(dir, assetNames(compilation).filter(n => n !== this.file)));
    // landed now, before isShared() looks (land() below finds it landed already)
    outputs.emitted(file, writer);
    // the inline file on the real disk after every build; in memory again if late copies added packages or
    // other compilers write it too; the export copy (BUNDLE_LOCKFILE_EXPORT_DIR) after every build
    // an output directory on disk that is gone by now was removed by another plugin's afterEmit after it took the
    // files away (Metabase's embed build: copied into app/, then rm -rf): the lockfile is not put back there, which
    // would recreate the directory with only it (and ship it in Metabase's jar); the export copy is still written
    const gone = disk && config.inline && !fs.existsSync(dir);
    if (gone) config.debug(`${kind}: ${dir} was removed after the build wrote it: its lockfile is not written there`);
    const inline = config.inline && !gone && (disk || write || outputs.isShared(file));
    if (!inline && !exportPath(file)) {
      if (!config.inline) outputs.nowhere();
      return;
    }
    const fsys = compiler.outputFileSystem;
    // (an output file system: webpack sets one before it compiles)
    const writeFile = !inline ? null : disk ? outputs.writeDisk(file) : writeIn(/** @type {OutputFileSystem} */ (fsys), file);
    await outputs.land(file, writer, kind, { writeFile, exists: existsIn(fsys) });
  }
}

// Patches Compiler.prototype.compile (webpack.cjs, rspack.cjs: of a Compiler of the shape they know) of the bundler
// file `where`: every top-level compiler (not child compilers such as html-webpack-plugin's) runs the listeners on its
// first compile() (see attach), which run() and watch() call. seen: the compiler property that marks it as done;
// noHooks(): what a compiler without the hooks the plugin needs (webpack before 4) records, as a problem.
/**
 * A compiler as patchCompile's compile() sees it: of webpack before 4 too (no hooks)
 * @typedef {{ isChild(): boolean, hooks?: { thisCompilation?: unknown }, [mark: symbol]: unknown }} AnyCompiler
 */
/**
 * @param {Record<PropertyKey, unknown>} proto
 * @param {string} where
 * @param {string} kind
 * @param {((compiler: Compiler, where: string) => void)[]} listeners
 * @param {symbol} seen
 * @param {() => void} noHooks
 */
function patchCompile(proto, where, kind, listeners, seen, noHooks) {
  proto[BUNDLER_FILE] = where; // the bundler's package is the one around it (core/bundler.cjs)
  const orig = /** @type {(this: unknown, ...args: unknown[]) => unknown} */ (proto.compile); // (a function: see the callers)
  proto.compile = /** @this {AnyCompiler} @param {unknown[]} args */ function (...args) {
    if (!this[seen] && !this.isChild()) {
      this[seen] = true;
      if (this.hooks && this.hooks.thisCompilation) {
        if (attach(/** @type {Compiler} */ (/** @type {unknown} */ (this)), listeners, where, args, kind)) return undefined;
      } else noHooks();
    }
    return orig.apply(this, args);
  };
  config.debug(`${kind}: patched Compiler from`, where);
}

// On a top-level compiler's first compile (see patchCompile): runs the listeners (the default one applies
// BundleLockfilePlugin). Without the plugin the compiler would write no lockfile, so if one fails, its compilations
// fail (strict mode, core/problems.cjs): an error in each of them (see failCompilation) - or, if not even that can be
// tapped, compile()'s callback gets it, and true is returned: the compiler must not compile. Runs as part of the
// compiler's builds (core/problems.cjs within).
/**
 * @param {Compiler} compiler
 * @param {((compiler: Compiler, where: string) => void)[]} listeners
 * @param {string} where
 * @param {unknown[]} args
 * @param {string} kind
 * @returns {boolean}
 */
function attach(compiler, listeners, where, args, kind) {
  return problems.within(compiler, () => attachListeners(compiler, listeners, where, args, kind));
}
/** @type {typeof attach} */
function attachListeners(compiler, listeners, where, args, kind) {
  for (const fn of listeners) {
    try { fn(compiler, where); } catch (e) { problems.problem(`${kind}: could not attach to the compiler of ${compiler.outputPath || '(no output path)'}`, e); }
  }
  let failed = false;
  problems.failIfAny((err) => {
    try { compiler.hooks.thisCompilation.tap(NAME, (c) => { c.errors.push(compilationError(compiler, err)); }); } catch {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') { failed = true; /** @type {(err: Error) => void} */ (callback)(err); }
    }
  });
  return failed;
}

module.exports = {
  NAME,
  // (as unique symbols: the compilers' marks, see Compiler)
  APPLIED: /** @type {typeof APPLIED} */ (APPLIED), BUNDLER_FILE: /** @type {typeof BUNDLER_FILE} */ (BUNDLER_FILE),
  BundleLockfilePlugin, bundledFiles, sourceFile, compilationError, isRspack, attach, patchCompile, versionOf,
};
