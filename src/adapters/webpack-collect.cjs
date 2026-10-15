'use strict';
// The webpack adapter's answer to "which source files are in the output this compilation writes" (see
// webpack-family.cjs, the plugin that asks it at the right moments of a build): from the modules of the shipped chunks
// (also of child compilations), the files their loaders inlined, the files copied into the output, and the output of
// builds that write nothing themselves. Reads the compilation only; what differs between webpack 4/5 and rspack 1/2 is
// asked of webpack-compat.cjs.
/** @import { Package } from '../types' */
const fs = require('fs');
const path = require('path');
const config = require('../core/config.cjs');
const packages = require('../core/packages.cjs');
const problems = require('../core/problems.cjs');
const generated = require('../core/generated.cjs');
const helpers = require('../core/helpers.cjs');
const { posix, packageRoot } = require('../core/paths.cjs');
const {
  kindOf, isRspack, chunkModules, entryModules, issuers, outputDir, hasAsset, assetNames, assetOf,
} = require('./webpack-compat.cjs');

/**
 * Asset name -> the package files it is a copy of; bytes: the names matched by their bytes alone (see core/via.cjs)
 * @typedef {Map<string, string[]> & { bytes: Set<string> }} CopiedAssets
 */
/**
 * Asset name -> the file it was copied from, in the emit hook (copiedInEmit); bytes: as for CopiedAssets
 * @typedef {Map<string, string> & { bytes?: Set<string> }} CopiedInEmit
 */
/**
 * How sourcesOf found the files: modules walked, whether a style module recorded no file dependencies, mark(file, class)
 * @typedef {{ modules: Set<any>, unrecorded: boolean, mark?: (file: string, cls: string) => void }} Walked
 */

const KINDS = Symbol('bundle-lockfile.webpack.kinds');         // compilation: how bundledFiles() found each file (see core/via.cjs)
const HELPERS = Symbol('bundle-lockfile.webpack.helpers');     // compilation: transpilers whose helpers are in its shipped modules
const UNNAMED = Symbol('bundle-lockfile.webpack.unnamed');     // compilation: copiedUnnamed() before the assets were optimized
const JS = /\.[cm]?js$/i;

// Source file of a module: nameForCondition(), webpack's own answer to "which file is this module" (the path
// module.rules match it against; also used for splitChunks tests, rules' issuer condition and webpack 5's stats). For
// a NormalModule it is the resource without query - or the match resource of a "<name>!=!<loaders>!<resource>"
// request: loaders that generate a module from a placeholder file name it that way (vanilla-extract's CSS reads
// @vanilla-extract/webpack-plugin/extracted.js), so the placeholder's package does not count. Modules such as
// mini-css-extract's CssModule implement it without having a resource (CssModule: the resource of the CSS module it
// came from, never its match resource); externals and webpack's runtime modules return null (webpack 4's base Module
// has nameForCondition = null).
// A module without a resource that names its issuer's resource was generated from the issuer - mini-css-extract's
// CssModule for the CSS a module produced - and is the file webpack names the issuer by. That carries a match
// resource over to the CSS (vanilla-extract), while CSS a file @imports keeps its own file.
// rspack before 1.7 has the match resource, but its nameForCondition() ignores it: the match resource first (what
// webpack's nameForCondition() returns then too).
// webpack's resolver (enhanced-resolve) escapes a "#" in a path as "\0#" (so that it is no fragment), rspack's as
// "\u200b#" (a zero-width space): resources and nameForCondition() keep that; the file has a plain "#" (~/c#/app).
const unescaped = (f) => (typeof f === 'string' ? f.replace(/[\0\u200b]#/g, '#') : f);

// A match resource that is no absolute path names no file (Next.js' barrel optimization: __barrel_optimize__?names=X!=!
// <the package file>): the resource then.
function sourceFile(m, issuerOf) {
  const raw = typeof m.matchResource === 'string' && m.matchResource ? unescaped(m.matchResource.split('?')[0]) : null;
  const match = raw && path.isAbsolute(raw) ? raw : null;
  const named = unescaped(typeof m.nameForCondition === 'function' ? m.nameForCondition() || null : m.resource || null);
  // (rspack before 1.7 and webpack name it by the match resource too: then by its resource, without the query)
  const own = match || (raw && named === raw && typeof m.resource === 'string' ? unescaped(m.resource.split('?')[0]) : named);
  if (!own || m.resource) return own;
  const issuer = issuerOf(m);
  if (!issuer || typeof issuer.resource !== 'string' || unescaped(issuer.resource.split('?')[0]) !== own || typeof issuer.nameForCondition !== 'function') return own;
  return unescaped(issuer.nameForCondition()) || own;
}

// Source files of modules, including the inner modules of scope-hoisted ConcatenatedModules (.modules),
// which webpack takes out of the root's chunks (for their JavaScript).
// A module's files also include those its loaders inlined from other files and recorded as file dependencies of the
// module (packages.inlinedFile): Sass partials (sass-loader), Less @imports (less-loader), postcss-import's and
// Tailwind's style sheets (postcss-loader) - of a style sheet, and of any other module whose loaders compile style (a
// Vue single-file component's <style lang="scss"> block, App.vue?vue&type=style, whose file is App.vue; an Angular
// component's styles) -, a shader's #includes (glslify-loader), JSON a loader merges in. They are no modules of their
// own. A style module's also include the images and fonts its CSS embeds: an asset url() inlined as a data: URL by a
// build-time compilation (mini-css-extract-plugin's importModule on webpack 5, its child compiler on webpack 4), whose
// modules are in no chunk. Which package such a file belongs to is up to core/packages.cjs (a first-party one: none, one
// in a vendored copy outside node_modules: that copy).
// webpack 4 keeps them in buildInfo.fileDependencies; webpack 5 moves them into the snapshot it takes of a cacheable
// module's build (also restored from the persistent cache) and keeps them there only for one that is not. A module
// generated from its issuer (mini-css-extract's CssModule) has those of the issuer.
// A relative path (less-loader 7 adds what Less found from the working directory as it found it) is relative to the
// working directory, as for the file system that reads and watches it. null: the module records none at all (rspack
// before 1.3.14 has no buildInfo.fileDependencies, see styleFallback).
function fileDependencies(m, issuerOf) {
  const of = (mod) => {
    const info = mod && mod.buildInfo;
    if (!info) return null;
    if (info.fileDependencies) return info.fileDependencies;
    const s = info.snapshot;
    if (!s) return null;
    if (typeof s.getFileIterable === 'function') return s.getFileIterable();
    // (webpack 5.0 has getFileIterable; files in packages are its managedFiles, a Set)
    return [s.fileTimestamps, s.fileHashes, s.fileTshs, s.managedFiles].flatMap(map => (map ? [...map.keys()] : []));
  };
  return of(m) || (!m.resource && of(issuerOf(m)));
}

function inlinedDependencies(m, issuerOf) {
  const deps = fileDependencies(m, issuerOf);
  if (!deps) return null;
  const out = [];
  for (const f of deps) {
    if (typeof f === 'string' && packages.inlinedFile(f)) out.push(path.resolve(f));
  }
  return out;
}

// A module that is style: its file is a style sheet, or its request asks for the style of a file (vue-loader's
// ?vue&type=style), or it is generated from one (mini-css-extract's CssModule: no resource, its issuer's file)
const isStyle = (m, f) => packages.STYLE.test(f.split('?')[0]) || (typeof m.resource === 'string' && /[?&]type=style\b/.test(m.resource));

// seen (optional): { modules: Set of the modules walked, unrecorded: whether a style module recorded no file
// dependencies at all, mark (optional): mark(file, class) is told how each file was found (see core/via.cjs): cls for
// the modules' files (chunk, child), style or inlined for the files their loaders inlined }
/**
 * @param {any} compilation
 * @param {Iterable<any>} modules
 * @param {Set<string>} [into]
 * @param {Walked | null} [seen]
 * @param {string} [cls]
 * @returns {Set<string>}
 */
function sourcesOf(compilation, modules, into = new Set(), seen = null, cls = 'chunk') {
  const issuerOf = issuers(compilation);
  const mark = (seen && seen.mark) || /** @type {(file: string, cls: string) => void} */ (() => {});
  const walk = (list) => {
    for (const m of list) {
      if (seen) seen.modules.add(m);
      const f = sourceFile(m, issuerOf);
      if (f) {
        into.add(f);
        mark(f, cls);
        const style = isStyle(m, f) || (!m.resource && (() => { const i = issuerOf(m); return !!(i && typeof i.resource === 'string' && isStyle(i, i.resource)); })());
        const deps = inlinedDependencies(m, issuerOf);
        if (deps) for (const d of deps) { into.add(d); mark(d, packages.STYLE.test(d) ? 'style' : 'inlined'); } else if (style && seen) seen.unrecorded = true;
      }
      if (m.modules) walk(m.modules);
    }
  };
  walk(modules);
  return into;
}

// rspack before 1.3.14 does not record per module which style sheets its loaders inlined (buildInfo is empty), nor does
// webpack 5 for a module whose snapshot failed (a file it could not read the time of): those below node_modules among
// the compilation's file dependencies, which has them. A style sheet only a module that is not shipped used is listed
// too - one package too many rather than one missing.
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
// Failing to look is a problem (core/problems.cjs): such a package would be missing from the lockfile.
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
  } catch (e) { problems.problem(`rspack: could not collect the modules whose exports were inlined into ${outputDir(compilation)}`, e); }
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
// Also sets compilation[KINDS]: Map(file -> Set of the classes it was found by, see core/via.cjs), and
// compilation[HELPERS]: the transpiler packages whose helpers are inlined into the shipped modules (core/helpers.cjs).
function bundledFiles(compilation) {
  const files = new Set();
  const kinds = new Map();
  const mark = (f, cls) => { if (!kinds.has(f)) kinds.set(f, new Set()); kinds.get(f).add(cls); };
  compilation[KINDS] = kinds;
  const rspack = isRspack(compilation.compiler);
  const shippedModules = new Map(); // module -> its compilation's issuerOf
  const ship = (c, chunks) => {
    const own = new Set(), seen = { modules: new Set(), unrecorded: false, mark };
    const cls = c === compilation ? 'chunk' : 'child';
    for (const chunk of chunks) sourcesOf(c, chunkModules(c, chunk), own, seen, cls);
    const issuerOf = issuers(c);
    for (const m of seen.modules) if (!shippedModules.has(m)) shippedModules.set(m, issuerOf);
    if (seen.unrecorded) for (const f of styleFallback(c)) { own.add(f); mark(f, 'style'); }
    // (a child compilation none of whose chunks ships - html-webpack-plugin's template - inlines nothing that ships)
    if (rspack && chunks.length) for (const f of inlinedModules(c, seen.modules)) { own.add(f); mark(f, 'inlined-exports'); }
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
  try {
    compilation[HELPERS] = helpers.ofWebpackModules(shippedModules.keys(), (m) => sourceFile(m, shippedModules.get(m)));
  } catch (e) { problems.problem(`${kindOf(compilation.compiler)}: could not look for transpiler helpers in the modules of ${outputDir(compilation)}`, e); compilation[HELPERS] = []; }

  for (const { info } of compilation.getAssets ? compilation.getAssets() : []) {
    if (!info || typeof info.sourceFilename !== 'string' || (rspack && info.copied)) continue;
    const f = path.resolve(compilation.compiler.context, info.sourceFilename);
    files.add(f);
    mark(f, 'copy-source');
  }
  const copies = compilation[UNNAMED] || (rspack ? copiedRspack(compilation) : copiedUnnamed(compilation));
  for (const [name, list] of copies) {
    if (!hasAsset(compilation, name)) continue;
    for (const f of list) { files.add(f); mark(f, copies.bytes && copies.bytes.has(name) ? 'copy-bytes' : 'copy-source'); }
  }
  return files;
}

// Files in packages the compilation depends on, by size: its file dependencies, and the files below its context
// dependencies in node_modules (copy-webpack-plugin 6.2 adds a copied directory only as one; at most MAX_CONTEXT_FILES
// entries are looked at). Empty files are left out: they would equal every empty asset.
const MAX_CONTEXT_FILES = 20000;

const warnedContext = new WeakSet(); // compilers warned about MAX_CONTEXT_FILES (once each, not on every rebuild)

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
  if (entries > MAX_CONTEXT_FILES && !warnedContext.has(compilation.compiler)) {
    warnedContext.add(compilation.compiler);
    config.warn(`more than ${MAX_CONTEXT_FILES} files below the directories in node_modules that ${outputDir(compilation)}'s build depends on: assets copied from them without naming their source were not all compared`);
  }
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
  /** @type {CopiedAssets} */
  const files = Object.assign(new Map(), { bytes: new Set() }); // (bytes: all of them, matched by their bytes)
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
  for (const m of compilation.modules || []) { // webpack 4: emitFile
    if (m && m.buildInfo && m.buildInfo.assets) for (const n of Object.keys(m.buildInfo.assets)) own.add(n);
  }
  unnamed = unnamed.filter(({ a }) => !own.has(a.name));
  if (!unnamed.length) return files;
  const bySize = packageFilesBySize(compilation);
  for (const { a, size } of unnamed) {
    const candidates = bySize.get(size);
    if (!candidates) continue;
    let buf;
    try { const s = a.source.source(); buf = Buffer.isBuffer(s) ? s : Buffer.from(s); } catch { continue; }
    const copy = candidates.find((f) => { try { return buf.equals(fs.readFileSync(f)); } catch { return false; } });
    if (copy) { files.set(a.name, [copy]); files.bytes.add(a.name); config.debug('webpack: asset', a.name, 'is a copy of', copy); }
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
// Returns Map(asset name -> [package files]), with .bytes: the names of the copies matched by their bytes alone.
function copiedRspack(compilation) {
  /** @type {CopiedAssets} */
  const files = Object.assign(new Map(), { bytes: new Set() });
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
  /** @type {Map<number, string[]> | null} */
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
      if (copy) { list = [copy]; files.bytes.add(a.name); }
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

// Files copied into the output in the emit hook, after the lockfile was emitted (copy-webpack-plugin 5, for
// webpack 4). An asset with info.sourceFilename names its file. copy-webpack-plugin 5's do not, but it adds the
// files it copied to the compilation's file dependencies (in its afterEmit): an asset whose bytes are those of
// a dependency in node_modules is a copy of it. Empty assets are skipped, they would equal every empty file.
// On watch rebuilds, copy-webpack-plugin 5 does not add unchanged files again: they stay in the output from
// an earlier build, as long as the plugin still copies them (they are still file dependencies).
// early: asset names when the lockfile was emitted; previous: what this returned for the compiler's previous
// build; readAsset(name) resolves the asset's bytes (or null). Resolves Map(asset name -> absolute path of the file).
/**
 * @param {any} compilation
 * @param {Set<string>} early
 * @param {CopiedInEmit} previous
 * @param {(name: string) => Promise<Buffer | null>} readAsset
 * @returns {Promise<CopiedInEmit>}
 */
async function copiedInEmit(compilation, early, previous, readAsset) {
  /** @type {CopiedInEmit & { bytes: Set<string> }} */
  const files = Object.assign(new Map(), { bytes: new Set() }); // bytes: the names matched by their bytes (see core/via.cjs)
  const unnamed = [];
  for (const name of assetNames(compilation).filter(n => !early.has(n))) {
    const a = assetOf(compilation, name), info = (a && a.info) || {};
    if (typeof info.sourceFilename === 'string') files.set(name, path.resolve(compilation.compiler.context, info.sourceFilename));
    else unnamed.push(name);
  }
  if (!unnamed.length && !previous.size) return files;
  const deps = new Set(compilation.fileDependencies || []);
  for (const [name, f] of previous) {
    if (hasAsset(compilation, name) || !deps.has(f)) continue;
    files.set(name, f);
    if (previous.bytes && previous.bytes.has(name)) files.bytes.add(name);
  }
  const bySize = unnamed.length ? packageFilesBySize(compilation) : new Map();
  if (!bySize.size) return files;
  const bufs = await Promise.all(unnamed.map(readAsset));
  unnamed.forEach((name, i) => {
    const buf = bufs[i];
    const copy = ((buf && bySize.get(buf.length)) || []).find((f) => { try { return !!buf && buf.equals(fs.readFileSync(f)); } catch { return false; } });
    if (copy) { files.set(name, copy); files.bytes.add(name); }
  });
  return files;
}

// Packages of JavaScript assets that are no chunk's file and have the content of a generate-only build's chunk (see
// core/generated.cjs): workbox-webpack-plugin's GenerateSW generates sw.js and workbox-<hash>.js with workbox-build
// (Rollup's generate()) and emits them as assets. Looked at once, when the lockfile is first rendered: after the emit,
// webpack 5 keeps only the sizes of the assets.
function generatedAssets(compilation) {
  const out = [];
  if (generated.any()) { // (else nothing generated in this process: nothing to look up)
    const own = new Set();
    for (const chunk of compilation.chunks || []) for (const f of chunk.files || []) own.add(f);
    for (const name of assetNames(compilation)) {
      if (own.has(name) || !JS.test(name.split('?')[0])) continue;
      let src;
      try { src = assetOf(compilation, name).source.source(); } catch { continue; } // (webpack 5 after emit: size only)
      const pkgs = generated.byContent(src);
      if (pkgs) { out.push(...pkgs); config.debug(`${kindOf(compilation.compiler)}: asset`, name, 'is the output of a generate-only build'); }
    }
  }
  return out;
}

// Packages of the generate-only output among the JavaScript assets added in the emit hook, after the lockfile was
// rendered (workbox-webpack-plugin's GenerateSW on webpack 4; see generatedAssets); readAsset: as for copiedInEmit
/**
 * @param {any} compilation
 * @param {Set<string>} early
 * @param {(name: string) => Promise<Buffer | null>} readAsset
 * @returns {Promise<Package[]>}
 */
async function lateGenerated(compilation, early, readAsset) {
  const names = assetNames(compilation).filter(n => !early.has(n) && JS.test(n.split('?')[0]));
  if (!names.length || !generated.any()) return [];
  const out = [];
  for (const buf of await Promise.all(names.map(readAsset))) {
    const pkgs = buf && generated.byContent(buf);
    if (pkgs) out.push(...pkgs);
  }
  return out;
}

module.exports = {
  KINDS, HELPERS, UNNAMED, sourceFile, bundledFiles, entryFiles, copiedUnnamed, copiedRspack, copiedInEmit, generatedAssets,
  lateGenerated,
};
