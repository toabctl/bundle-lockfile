'use strict';
// What webpack 4 and 5 (also Next.js' copy) and rspack share: which source files are in a compiler's emitted output,
// and BundleLockfilePlugin, which writes <output>/<BUNDLE_LOCKFILE_FILE> for every top-level compiler. The adapters
// (webpack.cjs, rspack.cjs) only hook the bundler and apply the plugin.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const config = require('../core/config.cjs');
const packages = require('../core/packages.cjs');
const outputs = require('../core/outputs.cjs');
const problems = require('../core/problems.cjs');
const { posix, packageRoot, exportPath } = require('../core/paths.cjs');

const NAME = 'bundle-lockfile';
const APPLIED = Symbol.for('bundle-lockfile.webpack.applied'); // compiler: has a BundleLockfilePlugin
const WRITER = Symbol.for('bundle-lockfile.webpack.writer');
const CLOSED = Symbol.for('bundle-lockfile.webpack.closed');   // compiler: its shutdown hook has run
const SOURCE = Symbol('bundle-lockfile.webpack.source');       // compilation: { src: lockfile content, early: asset names then, disk, asset }
const BUNDLED = Symbol('bundle-lockfile.webpack.bundled');     // compilation: its bundledFiles()
const COPIED = Symbol('bundle-lockfile.webpack.copied');       // compiler: files its latest build copied in the emit hook
const UNNAMED = Symbol('bundle-lockfile.webpack.unnamed');     // compilation: copiedUnnamed() before the assets were optimized

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
// rspack before 1.7 has the match resource, but its nameForCondition() ignores it: the match resource first (what
// webpack's nameForCondition() returns then too).
function sourceFile(m, issuerOf) {
  const match = typeof m.matchResource === 'string' && m.matchResource ? m.matchResource.split('?')[0] : null;
  const own = match || (typeof m.nameForCondition === 'function' ? m.nameForCondition() || null : m.resource || null);
  if (!own || m.resource) return own;
  const issuer = issuerOf(m);
  if (!issuer || typeof issuer.resource !== 'string' || issuer.resource.split('?')[0] !== own || typeof issuer.nameForCondition !== 'function') return own;
  return issuer.nameForCondition() || own;
}

// A hook of a hooks object, or undefined: rspack 2's hooks objects throw on reading a hook they do not have (a Proxy;
// `in` has no trap there), rspack 1's and webpack's return undefined.
function hook(hooks, name) {
  try { return hooks && name in hooks ? hooks[name] : undefined; } catch { return undefined; }
}
// webpack or rspack, for messages
const kindOf = (compiler) => (isRspack(compiler) ? 'rspack' : 'webpack');

const chunkModules = (compilation, chunk) =>
  compilation.chunkGraph ? compilation.chunkGraph.getChunkModulesIterable(chunk) : chunk.modulesIterable; // webpack 5 : 4
const entryModules = (compilation, chunk) =>
  compilation.chunkGraph ? compilation.chunkGraph.getChunkEntryModulesIterable(chunk) : [chunk.entryModule].filter(Boolean);
const hasAsset = (compilation, name) => (compilation.getAsset ? compilation.getAsset(name) : compilation.assets[name]) !== undefined;

const issuers = (compilation) => (m) => (compilation.moduleGraph ? compilation.moduleGraph.getIssuer(m) : m.issuer); // webpack 5 : 4

// Source files of modules, including the inner modules of scope-hoisted ConcatenatedModules (.modules),
// which webpack takes out of the root's chunks (for their JavaScript).
// A style module's style sheets also include those its loaders inlined from other files and recorded as file
// dependencies of the module: Sass partials (sass-loader), Less @imports (less-loader), postcss-import's and Tailwind's
// style sheets (postcss-loader). They are no modules of their own. webpack 4 keeps them in buildInfo.fileDependencies;
// webpack 5 moves them into the snapshot it takes of a cacheable module's build (also restored from the persistent
// cache) and keeps them there only for one that is not. A module generated from its issuer (mini-css-extract's CssModule) has those of the issuer.
// A relative path (less-loader 7 adds what Less found from the working directory as it found it) is relative to the
// working directory, as for the file system that reads and watches it. null: the module records none at all (rspack
// before 1.3.14 has no buildInfo.fileDependencies, see styleFallback).
function styleDependencies(m, issuerOf) {
  const of = (mod) => {
    const info = mod && mod.buildInfo;
    if (!info) return null;
    if (info.fileDependencies) return info.fileDependencies;
    const s = info.snapshot;
    if (!s) return null;
    if (typeof s.getFileIterable === 'function') return s.getFileIterable();
    return [s.fileTimestamps, s.fileHashes, s.fileTshs].flatMap(map => (map ? [...map.keys()] : []));
  };
  const deps = of(m) || (!m.resource && of(issuerOf(m)));
  if (!deps) return null;
  const out = [];
  for (const f of deps) if (typeof f === 'string' && packages.STYLE.test(f)) out.push(path.resolve(f));
  return out;
}

// seen (optional): { modules: Set of the modules walked, unrecorded: whether a style module recorded no style sheets at all }
function sourcesOf(compilation, modules, into = new Set(), seen = null) {
  const issuerOf = issuers(compilation);
  const walk = (list) => {
    for (const m of list) {
      if (seen) seen.modules.add(m);
      const f = sourceFile(m, issuerOf);
      if (f) {
        into.add(f);
        if (packages.STYLE.test(f.split('?')[0])) {
          const deps = styleDependencies(m, issuerOf);
          if (deps) for (const d of deps) into.add(d); else if (seen) seen.unrecorded = true;
        }
      }
      if (m.modules) walk(m.modules);
    }
  };
  walk(modules);
  return into;
}

// rspack before 1.3.14 does not record per module which style sheets its loaders inlined (buildInfo is empty): those
// below node_modules among the compilation's file dependencies, which has them. A style sheet only a module that is not
// shipped used is listed too - one package too many rather than one missing.
function styleFallback(compilation) {
  const out = [];
  for (const f of new Set(compilation.fileDependencies || [])) if (typeof f === 'string' && packages.STYLE.test(f) && packageRoot(f)) out.push(f);
  return out;
}

// rspack inlines constant exports (optimization.inlineExports: production in rspack 2, with experiments.inlineConst in
// 1.7): `export const A = 1` used elsewhere becomes the value 1 there, and a module whose used exports are all inlined is
// in no chunk - its values are in the bundle, its file no module of it. Such a module of a package is listed: not in a
// chunk, but used (its exports info says so, unlike one that was tree-shaken). Only when exports were inlined at all: in
// a build without usage analysis (development, usedExports: false) every module counts as used. The options are read
// here, after rspack filled in the defaults (not yet when plugins are applied). shipped: the modules in its chunks.
function inlinedModules(compilation, shipped) {
  const o = (compilation.compiler && compilation.compiler.options && compilation.compiler.options.optimization) || {};
  const out = [];
  if (o.inlineExports !== true || !o.usedExports) return out;
  try {
    const ids = new Set([...shipped].map(m => m.identifier()));
    const issuerOf = issuers(compilation);
    for (const m of compilation.modules || []) {
      if (ids.has(m.identifier())) continue;
      const f = sourceFile(m, issuerOf);
      if (!f || !path.isAbsolute(f) || !packageRoot(f.split('?')[0])) continue;
      if (compilation.moduleGraph.getExportsInfo(m).isModuleUsed(undefined) === true) out.push(f);
    }
  } catch (e) { config.debug('rspack: could not look for modules whose exports were inlined:', e); }
  return out;
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
//   Copies that do not name their source: see copiedUnnamed.
// - rspack: the style sheets of styleFallback before 1.3.14, the modules whose exports were inlined (inlinedModules), and
//   the files CopyRspackPlugin copied (copiedRspack: its sourceFilename is relative to the copy pattern, not the context).
function bundledFiles(compilation) {
  const files = new Set();
  const rspack = isRspack(compilation.compiler);
  const ship = (c, chunks) => {
    const own = new Set(), seen = { modules: new Set(), unrecorded: false };
    for (const chunk of chunks) sourcesOf(c, chunkModules(c, chunk), own, seen);
    if (rspack) {
      if (seen.unrecorded) for (const f of styleFallback(c)) own.add(f);
      for (const f of inlinedModules(c, seen.modules)) own.add(f);
    }
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
    if (!info || typeof info.sourceFilename !== 'string' || (rspack && info.copied)) continue;
    files.add(path.resolve(compilation.compiler.context, info.sourceFilename));
  }
  const copies = compilation[UNNAMED] || (rspack ? copiedRspack(compilation) : copiedUnnamed(compilation));
  for (const [name, list] of copies) if (hasAsset(compilation, name)) for (const f of list) files.add(f);
  return files;
}

// Files in packages the compilation depends on, by size: its file dependencies, and the files below its context
// dependencies in node_modules (copy-webpack-plugin 6.2 adds a copied directory only as one; at most MAX_CONTEXT_FILES
// entries are looked at). Empty files are left out: they would equal every empty asset.
const MAX_CONTEXT_FILES = 20000;
function packageFilesBySize(compilation) {
  const bySize = new Map(), seen = new Set();
  const add = (f) => {
    if (typeof f !== 'string' || seen.has(f)) return;
    seen.add(f);
    let size;
    try { size = packageRoot(f) && fs.statSync(f).size; } catch { return; }
    if (size) bySize.set(size, [...(bySize.get(size) || []), f]);
  };
  for (const f of compilation.fileDependencies || []) add(f);
  let entries = 0;
  const walk = (dir) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (++entries > MAX_CONTEXT_FILES) return;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f); else if (e.isFile()) add(f);
    }
  };
  for (const d of compilation.contextDependencies || []) if (typeof d === 'string' && d.split(path.sep).includes('node_modules')) walk(d);
  return bySize;
}

// Files copied into the output before the lockfile is rendered, without naming their source: copy-webpack-plugin
// 6.0 - 6.2 add them while webpack processes the assets (additionalAssets), without info.sourceFilename (6.1, 6.2:
// only info.copied; 6.3 names it). An asset that is no chunk's file and no module's, whose bytes are those of a
// package file the compilation depends on (see packageFilesBySize), is a copy of it. webpack 5 then minimizes such
// copies like any asset (they are not marked as minimized): the plugin looks at them before the optimize stages.
// Returns Map(asset name -> [package file]). The modules (a webpack 4 module's emitFile assets are its own) are looked at
// only if there are such assets: compilation.modules is costly in rspack.
function copiedUnnamed(compilation) {
  const files = new Map();
  let unnamed = [];
  for (const name of assetNames(compilation)) {
    const a = assetOf(compilation, name);
    if (!a || (a.info && typeof a.info.sourceFilename === 'string')) continue;
    let size;
    try { size = a.source.size(); } catch { continue; }
    if (size) unnamed.push({ a, size });
  }
  if (!unnamed.length) return files;
  const own = new Set();
  for (const chunk of compilation.chunks || []) for (const f of [...(chunk.files || []), ...(chunk.auxiliaryFiles || [])]) own.add(f);
  for (const m of compilation.modules || []) if (m && m.buildInfo && m.buildInfo.assets) for (const n of Object.keys(m.buildInfo.assets)) own.add(n); // webpack 4: emitFile
  unnamed = unnamed.filter(({ a }) => !own.has(a.name));
  if (!unnamed.length) return files;
  const bySize = packageFilesBySize(compilation);
  for (const { a, size } of unnamed) {
    const candidates = bySize.get(size);
    if (!candidates) continue;
    let buf;
    try { const s = a.source.source(); buf = Buffer.isBuffer(s) ? s : Buffer.from(s); } catch { continue; }
    const copy = candidates.find((f) => { try { return buf.equals(fs.readFileSync(f)); } catch { return false; } });
    if (copy) { files.set(a.name, [copy]); config.debug('webpack: asset', a.name, 'is a copy of', copy); }
  }
  return files;
}

// Files CopyRspackPlugin copied into the output (assets with info.copied, also those of copy-webpack-plugin if it ran):
// their info.sourceFilename is relative to the copy pattern's context (a copied file: its name; a directory: the path in
// it), not to the compiler's. Every copied file is among the compilation's file dependencies, as it was given (through
// a symbolic link, not its real path): those whose path ends with the name are the candidates, the same file reached
// by several paths once (the one below the context first). The candidate with the asset's bytes - before the optimize
// stages, which minimize copies (the plugin looks at them then) - is its source: a package file, or a first-party
// file (public/config.js copied as app-config.js), which lists nothing. Without one (a copy transformed on the way),
// every package file with that name: one package too many rather than one missing. A copy whose name no file ends
// with is matched by its bytes alone, as copiedUnnamed does. The candidates are looked up by their file name, so the
// cost is that of one pass over the dependencies (OHIF copies hundreds of files, and depends on thousands).
// Returns Map(asset name -> [package files]).
function copiedRspack(compilation) {
  const files = new Map();
  const copied = [];
  for (const name of assetNames(compilation)) {
    const a = assetOf(compilation, name);
    if (a && a.info && a.info.copied && typeof a.info.sourceFilename === 'string') copied.push(a);
  }
  if (!copied.length) return files;
  const context = compilation.compiler.context;
  const byName = new Map(); // file name -> [{ file, path: posix }] of the file dependencies
  for (const f of new Set(compilation.fileDependencies || [])) {
    if (typeof f !== 'string') continue;
    const p = posix(f), name = p.slice(p.lastIndexOf('/') + 1);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ file: f, path: p });
  }
  const realOf = (f) => { try { return fs.realpathSync(f); } catch { return f; } };
  const bytesOf = (a) => { try { const s = a.source.source(); return Buffer.isBuffer(s) ? s : Buffer.from(s); } catch { return null; } };
  let bySize = null; // packageFilesBySize, if needed
  for (const a of copied) {
    const rel = posix(a.info.sourceFilename.split('?')[0]), tail = `/${rel}`;
    const byReal = new Map();
    for (const { file: f, path: p } of byName.get(rel.slice(rel.lastIndexOf('/') + 1)) || []) {
      if (!p.endsWith(tail)) continue;
      const r = realOf(f), prev = byReal.get(r);
      if (!prev || (!prev.startsWith(context + path.sep) && f.startsWith(context + path.sep))) byReal.set(r, f);
    }
    const candidates = [...byReal.values()];
    const buf = bytesOf(a);
    const same = (f) => { try { return buf && fs.statSync(f).size === buf.length && buf.equals(fs.readFileSync(f)); } catch { return false; } };
    const sources = candidates.filter(same);
    let list = (sources.length ? sources : candidates).filter(f => packageRoot(f));
    if (!candidates.length && buf && buf.length) {
      if (!bySize) bySize = packageFilesBySize(compilation);
      const copy = (bySize.get(buf.length) || []).find(f => same(f));
      if (copy) list = [copy];
    }
    if (list.length) { files.set(a.name, list); config.debug('rspack: asset', a.name, 'is a copy of', list.join(' ')); }
  }
  return files;
}

// The source files of the compilation's entry modules (the package they are in is first-party, see core/vendored.cjs)
function entryFiles(compilation) {
  const files = new Set(), issuerOf = issuers(compilation);
  for (const chunk of compilation.chunks) for (const m of entryModules(compilation, chunk)) { const f = sourceFile(m, issuerOf); if (f) files.add(f.split('?')[0]); }
  return [...files];
}

// Compilers that write the same files are one writer of a shared lockfile: a new compiler for the same config
// (a build restarted in the same process, or run again by another process) replaces the previous one's packages
// instead of adding to them - in this process once the previous one is done: closed (webpack >= 5.17 has a shutdown
// hook), on older versions not running. Until then it is another writer: configs that differ only in what is not
// compared here (resolve.alias, loader options) can be built side by side into one directory, e.g. with
// [contenthash] file names. The id has no paths of this machine (the lockfile records it, and must be the same on
// every machine): absolute paths in the options (entry: path.resolve(__dirname, ...)) are relative to the context.
// The claims are per output directory.
const writers = globalThis[Symbol.for('bundle-lockfile.webpack.writers.v2')] ||
  (globalThis[Symbol.for('bundle-lockfile.webpack.writers.v2')] = { claims: new Map() }); // dir + id -> ref(compiler)
const busy = (c) => (hook(c.hooks, 'shutdown') ? !c[CLOSED] : !!c.running);
function compilerWriter(compiler) {
  if (compiler[WRITER]) return compiler[WRITER];
  const o = compiler.options || {}, out = o.output || {};
  const plain = (v) => (typeof v === 'function' ? '(function)' : v === undefined ? null : v);
  let base;
  const portable = (k, v) => (typeof v === 'string' && path.isAbsolute(v) && compiler.context
    ? posix(path.relative(compiler.context, v)) : v);
  try { base = JSON.stringify([compiler.name || null, plain(o.entry), plain(o.target), plain(out.filename), plain(out.chunkFilename)], portable); }
  catch { base = JSON.stringify([compiler.name || null, '(not comparable)']); } // e.g. a BigInt in an entry option
  let id = base;
  for (let n = 2; ; n++) {
    const claim = `${compiler.outputPath}\0${id}`;
    const prev = writers.claims.has(claim) && writers.claims.get(claim).deref();
    if (!prev || prev === compiler || !busy(prev)) { writers.claims.set(claim, new WeakRef(compiler)); break; }
    id = `${base}#${n}`;
  }
  const shutdown = hook(compiler.hooks, 'shutdown');
  if (shutdown) shutdown.tap(NAME, () => { compiler[CLOSED] = true; });
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

// Fails the compilation with what core/problems.cjs has recorded, in strict mode: as a compilation error, also after
// emit - webpack (4, 5), rspack, Rsbuild and Next.js report it like any other, the build fails (exit code 1,
// stats.hasErrors()), before emit with emitOnErrors: false (the production default) nothing is written, and watch mode
// keeps running and recovers. Not as a callback error (webpack-cli and rspack-cli exit with 2 and stop watching, the
// watch API stops rebuilding) and never as a throw from a tap (webpack 4 exits 0 then, Next.js 16 hangs).
// webpack >= 5.1 and rspack have WebpackError (hideStack: no stack in the output, the message says where); webpack 4
// and 5.0 (no compiler.webpack) take any Error.
function compilationError(compiler, err) {
  const E = compiler && compiler.webpack && compiler.webpack.WebpackError;
  if (typeof E !== 'function') return err;
  try { const e = new E(err.message); e.hideStack = true; e.stack = err.stack; return e; } catch { return err; }
}
const failCompilation = (compilation) => problems.failIfAny((err) => compilation.errors.push(compilationError(compilation.compiler, err)));

// Files copied into the output in the emit hook, after the lockfile was emitted (copy-webpack-plugin 5, for
// webpack 4). An asset with info.sourceFilename names its file. copy-webpack-plugin 5's do not, but it adds the
// files it copied to the compilation's file dependencies (in its afterEmit): an asset whose bytes are those of
// a dependency in node_modules is a copy of it. Empty assets are skipped, they would equal every empty file.
// On watch rebuilds, copy-webpack-plugin 5 does not add unchanged files again: they stay in the output from
// an earlier build, as long as the plugin still copies them (they are still file dependencies).
// early: asset names when the lockfile was emitted; previous: what this returned for the compiler's previous
// build; readAsset(name, callback(Buffer | null)); done(files) gets Map(asset name -> absolute path of the file).
function copiedInEmit(compilation, early, previous, readAsset, done) {
  const files = new Map(), unnamed = [];
  for (const name of assetNames(compilation).filter(n => !early.has(n))) {
    const a = assetOf(compilation, name), info = (a && a.info) || {};
    if (typeof info.sourceFilename === 'string') files.set(name, path.resolve(compilation.compiler.context, info.sourceFilename));
    else unnamed.push(name);
  }
  if (!unnamed.length && !previous.size) return done(files);
  const deps = new Set(compilation.fileDependencies || []);
  for (const [name, f] of previous) if (!hasAsset(compilation, name) && deps.has(f)) files.set(name, f);
  const bySize = unnamed.length ? packageFilesBySize(compilation) : new Map();
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
  // the same lockfile (see core/outputs.cjs). extra: more files in the output (see copiedInEmit).
  lockfile(compilation, extra = []) {
    const compiler = compilation.compiler, dir = outputDir(compilation);
    const bundled = compilation[BUNDLED] || (compilation[BUNDLED] = bundledFiles(compilation));
    const build = { context: compiler.context, entries: entryFiles(compilation) }; // for vendored copies
    return outputs.record(path.join(dir, this.file), compilerWriter(compiler), packages.packagesOfFiles([...bundled, ...extra], build).all,
      compiler.context, assetFiles(dir, assetNames(compilation).filter(n => n !== this.file)), { disk: onDisk(compiler) });
  }

  apply(compiler) {
    compiler[APPLIED] = true;
    let RawSource = compiler.webpack && compiler.webpack.sources.RawSource; // webpack >= 5.1
    if (!RawSource) try { RawSource = createRequire(this.compilerFile || __filename)('webpack-sources').RawSource; } catch { /* fallback below */ }
    const add = (compilation, src) => {
      if (compilation.emitAsset) compilation.emitAsset(this.file, src); else compilation.assets[this.file] = src;
    };
    compiler.hooks.thisCompilation.tap(NAME, (compilation) => {
      // webpack 5 and rspack: copied files, before the optimize stages change their bytes (copiedUnnamed, copiedRspack)
      const C = compiler.webpack && compiler.webpack.Compilation;
      const processAssets = hook(compilation.hooks, 'processAssets');
      if (processAssets && C && typeof C.PROCESS_ASSETS_STAGE_OPTIMIZE === 'number') {
        processAssets.tap({ name: NAME, stage: C.PROCESS_ASSETS_STAGE_OPTIMIZE - 1 }, () => {
          try { compilation[UNNAMED] = isRspack(compiler) ? copiedRspack(compilation) : copiedUnnamed(compilation); } catch (e) {
            problems.problem(`${kindOf(compiler)}: could not check the files copied into ${outputDir(compilation)}`, e);
          }
        });
      }
      // After processAssets: its taps with additionalAssets: true also get the assets added in any later stage,
      // so compression-webpack-plugin with deleteOriginalAssets would replace the lockfile by a .gz no SBOM
      // tool reads. webpack 4's afterOptimizeAssets (in webpack 5 the same hook) runs after every plugin's
      // additionalAssets, whatever the plugin order (copy-webpack-plugin 6 adds its files there).
      (hook(compilation.hooks, 'afterProcessAssets') || hook(compilation.hooks, 'afterOptimizeAssets')).tap(NAME, () => {
        try {
          const json = this.lockfile(compilation);
          const src = RawSource ? new RawSource(json) : { source: () => json, size: () => Buffer.byteLength(json) };
          // On the real disk the lockfile is no asset: other processes may write it too, and webpack would write the
          // asset - rendered now, before they have written theirs - over the packages they put there since, without
          // the lock. It is written in afterEmit, under the lock, like every other write of it (see rewrite).
          // In memory (webpack-dev-server) it is an asset, which only this process writes.
          const disk = onDisk(compiler);
          compilation[SOURCE] = { src, early: new Set([...assetNames(compilation), this.file]), disk, asset: config.inline && !disk };
          if (compilation[SOURCE].asset) add(compilation, src); // else written in afterEmit (inline and export copy)
        } catch (e) { problems.problem(`${kindOf(compiler)}: could not collect the packages of ${outputDir(compilation)}`, e); }
        failCompilation(compilation);
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
      const writer = compilerWriter(compiler);
      // the end of this hook: what went wrong fails the build (a compilation error, see failCompilation)
      const done = () => { failCompilation(compilation); callback(); };
      const fsys = compiler.outputFileSystem;
      const readAsset = (name, cb) => {
        try { const s = assetOf(compilation, name).source.source(); return cb(Buffer.isBuffer(s) ? s : Buffer.from(s)); } catch { /* see below */ }
        // webpack 5 keeps only the size of an emitted asset: read the file
        if (typeof fsys.readFile !== 'function') return cb(null);
        try { fsys.readFile(path.join(dir, name.split('?')[0]), (err, buf) => cb(err ? null : buf)); } catch { cb(null); }
      };
      let landed = false;
      const land = (copied) => {
        if (landed) return; // once, also if copiedInEmit fails after calling it
        landed = true;
        compiler[COPIED] = copied;
        let write = false;
        if (copied.size) {
          try { this.lockfile(compilation, [...copied.values()]); write = true; } catch (e) { problems.problem(`${kindOf(compiler)}: could not collect the packages of ${dir}`, e); }
        }
        // the files webpack wrote: assets the emit hook deleted or added (compression-webpack-plugin <= 6 with
        // deleteOriginalAssets on webpack 4 replaces main.js by main.js.gz) were not known when the lockfile was rendered
        if (!write) outputs.setFiles(file, writer, assetFiles(dir, assetNames(compilation).filter(n => n !== this.file)));
        outputs.emitted(file, writer);
        // the inline file on the real disk after every build; in memory again if late copies added packages or
        // other compilers write it too; the export copy (BUNDLE_LOCKFILE_EXPORT_DIR) after every build
        const disk = compilation[SOURCE] ? compilation[SOURCE].disk : onDisk(compiler);
        // an output directory on disk that is gone by now was removed by another plugin's afterEmit after it took the
        // files away (Metabase's embed build: copied into app/, then rm -rf): the lockfile is not put back there, which
        // would recreate the directory with only it (and ship it in Metabase's jar); the export copy is still written
        const gone = disk && config.inline && !fs.existsSync(dir);
        if (gone) config.debug(`${kindOf(compiler)}: ${dir} was removed after the build wrote it: its lockfile is not written there`);
        const inline = config.inline && !gone && (disk || write || outputs.isShared(file));
        if (!inline && !exportPath(file)) {
          if (!config.inline) outputs.nowhere();
          return done();
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
            if (err) problems.problem(`${kindOf(compiler)}: could not write ${file}`, err);
            else if (inline || exportPath(file)) config.debug(`${kindOf(compiler)}: wrote`, [inline && file, exportPath(file)].filter(Boolean).join(' and '));
            done();
          });
        });
      };
      if (!compilation[SOURCE]) return land(new Map());
      try { copiedInEmit(compilation, compilation[SOURCE].early, compiler[COPIED] || new Map(), readAsset, land); } catch (e) {
        problems.problem(`${kindOf(compiler)}: could not check the files copied into ${dir} in the emit hook`, e);
        land(new Map());
      }
    });
  }
}

// The compiler is rspack's (rspack.cjs), not webpack's: it names its version. Decided per compiler, as both can be loaded
// in one process (Next.js with next-rspack loads its webpack too, OHIF loads rspack 1 and 2).
const isRspack = (compiler) => !!(compiler && compiler.webpack && typeof compiler.webpack.rspackVersion === 'string');

// On a top-level compiler's first compile (see webpack.cjs, rspack.cjs): runs the listeners (the default one applies
// BundleLockfilePlugin). Without the plugin the compiler would write no lockfile, so if one fails, its compilations
// fail (strict mode, core/problems.cjs): an error in each of them (see failCompilation) - or, if not even that can be
// tapped, compile()'s callback gets it, and true is returned: the compiler must not compile.
function attach(compiler, listeners, where, args, kind) {
  for (const fn of listeners) {
    try { fn(compiler, where); } catch (e) { problems.problem(`${kind}: could not attach to the compiler of ${compiler.outputPath || '(no output path)'}`, e); }
  }
  let failed = false;
  problems.failIfAny((err) => {
    try { compiler.hooks.thisCompilation.tap(NAME, (c) => { c.errors.push(compilationError(compiler, err)); }); } catch {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') { failed = true; callback(err); }
    }
  });
  return failed;
}

module.exports = { NAME, APPLIED, BundleLockfilePlugin, bundledFiles, sourceFile, compilationError, isRspack, attach };
