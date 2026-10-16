'use strict';
// The Rollup adapter's answer to "which source files and packages are in the output this build writes" (see rollup.cjs,
// the plugin that asks it in a build's hooks): from a bundle (the generateBundle hook's) and the plugin context, for
// Rollup, Rolldown and Vite alike. Reads the bundle and the files on disk only; what the plugin keeps across a build's
// hooks (the modules of each output, the files Rolldown's plugins inlined) it is given.
/** @import { Package, ViaCollector } from '../types' */
/** @import { OutputAsset, OutputBundle, OutputChunk, OutputFile, PluginContext } from './rollup-types' */
const fs = require('fs');
const path = require('path');
const packages = require('../core/packages.cjs');
const via = require('../core/via.cjs');
const helpers = require('../core/helpers.cjs');
const generated = require('../core/generated.cjs');
const { sha256 } = require('../core/hashes.cjs');
const { hasBytes } = require('../core/copies.cjs');
const { getOr } = require('../core/maps.cjs');
const { withoutFragment, JS } = require('../core/paths.cjs');
const { isObject, isArray } = require('../core/values.cjs');

const { STYLE } = packages;

/** @type {(chunk: OutputChunk) => string[]} */
const moduleIds = (chunk) => chunk.moduleIds || Object.keys(chunk.modules || {});
/** @param {OutputFile} f @returns {f is OutputChunk} */
function isChunk(f) { return f.type === 'chunk'; }
// the files of a list, without the nulls (fileOf: a virtual module)
/** @param {(string | null)[]} list @returns {string[]} */
function present(list) {
  /** @type {string[]} */
  const out = [];
  for (const f of list) if (f) out.push(f);
  return out;
}

// Source file of a module id: virtual modules (\0vite/..., \0commonjsHelpers.js, virtual:...) have none; a
// \0-prefixed absolute id (rollup's commonjs proxies) and ids with queries (?vue&type=style, ?inline, ?worker) are
// the file before them, and without a fragment (see core/paths.cjs withoutFragment).
/** @param {unknown} id @returns {string | null} */
function fileOf(id) {
  if (typeof id !== 'string') return null;
  const f = withoutFragment(id.replace(/^\0/, '').split('?')[0]);
  return path.isAbsolute(f) ? path.normalize(f) : null;
}

// The build's watch files: its modules, and the files its plugins read and inlined into a module (this.addWatchFile:
// Vite's CSS plugin adds the style sheets a style sheet @imports, and from Vite 6.1 on the images and fonts it inlines
// as data: URLs). Rollup has them in the plugin context; Rolldown only on the RolldownBuild that rolldown() returned.
/** @param {PluginContext} ctx @param {unknown} build @returns {Promise<unknown[]>} */
async function watchFilesOf(ctx, build) {
  try { if (typeof ctx.getWatchFiles === 'function') return ctx.getWatchFiles(); } catch { /* none */ }
  try { if (isObject(build)) { const w = /** @type {unknown} */ (await build.watchFiles); if (isArray(w)) return w; } } catch { /* none */ }
  return [];
}

// The files among the build's watch files that its plugins inlined (packages.inlinedFile), absolute: those that are no
// module of the build (also not one that was tree-shaken: modules are bundled or not, never inlined).
/** @param {Iterable<unknown>} watchFiles @param {PluginContext} ctx @returns {string[]} */
function inlinedFiles(watchFiles, ctx) {
  /** @type {Set<string>} */
  let ids;
  try { ids = new Set(present([...ctx.getModuleIds()].map(fileOf))); } catch { ids = new Set(); }
  /** @type {string[]} */
  const out = [];
  for (const f of watchFiles) {
    if (typeof f !== 'string' || !path.isAbsolute(f) || !packages.inlinedFile(f)) continue;
    const file = path.normalize(f);
    if (!ids.has(file)) out.push(file);
  }
  return out;
}

// Packages of the output of generate-only builds that ends up in this bundle (see core/generated.cjs): chunks and
// JavaScript assets with the content of a generate-only chunk (Vite's worker chunks, legacy polyfills), and modules
// with a query on the entry file of a generate-only build (Vite's /src/w.js?worker&inline, which inlines the worker).
/** @param {OutputBundle} bundle @param {Iterable<string>} ids @returns {Map<string, Package>} */
function generatedIn(bundle, ids) {
  /** @type {Map<string, Package>} */
  const out = new Map();
  /** @param {Package[] | null} pkgs */
  const add = (pkgs) => { if (pkgs) for (const p of pkgs) out.set(p.path, p); };
  for (const f of Object.values(bundle)) {
    if (isChunk(f)) add(generated.byContent(f.code));
    else { if (JS.test(f.fileName)) add(generated.byContent(f.source)); add(generated.byAsset(f.source)); }
  }
  for (const id of ids) if (typeof id === 'string' && id.includes('?')) add(generated.byEntry(fileOf(id)));
  return out;
}

// The JavaScript and CSS files of a written bundle that another build may bundle (see core/nested.cjs): hashes
// { absolute path: "sha256-<hex>" } and contents { absolute path: [package paths] }, the packages in each.
// - a chunk: its modules' packages and those of generate-only builds in it - not those of style sheets Vite took out
//   of it into CSS files (a style module without ?inline, ?raw or ?url, if the bundle has CSS files)
// - a CSS file: the style modules of the chunks that import it (Vite's viteMetadata.importedCss; if no chunk does,
//   all of the bundle's), the files the build's plugins inlined (inlined: watch files, not known per CSS file), the
//   files it was emitted from
// - a chunk also: the files the build's plugins inlined that are no style sheets (a shader's #includes: not known per
//   chunk either)
// - a JavaScript asset (Vite's worker chunks): the generate-only chunk it is, the files it was emitted from
// ids: the bundle's module ids; originals: asset -> files it was emitted from; byFile: packagesOfFiles(sources).byFile.
/**
 * @param {OutputBundle} bundle
 * @param {string} dir
 * @param {Set<string>} ids
 * @param {Map<OutputAsset, string[]>} originals
 * @param {string[]} inlined
 * @param {Map<string, Package[]>} byFile
 */
function outputContents(bundle, dir, ids, originals, inlined, byFile) {
  /** @type {Record<string, string>} */
  const hashes = {};
  /** @type {Record<string, string[]>} */
  const contents = {};
  const all = Object.values(bundle);
  const css = all.filter(f => !isChunk(f) && /\.css$/i.test(f.fileName));
  // (also a single-file component's style block: App.vue?vue&type=style&index=0&lang.scss, X.svelte?svelte&type=style)
  /** @param {string} id */
  const isStyle = (id) => STYLE.test(fileOf(id) || '') || /[?&]type=style(&|$)/.test(id);
  /** @param {string} id */
  const extracted = (id) => css.length > 0 && isStyle(id) && !/[?&](inline|raw|url)\b/.test(id);
  /** @type {(into: Set<string>, pkgs: Package[] | null | undefined) => void} */
  const add = (into, pkgs) => { if (pkgs) for (const p of pkgs) into.add(p.path); };
  /** @type {(into: Set<string>, list: Iterable<string>) => void} */
  const ofFiles = (into, list) => { for (const f of list) add(into, byFile.get(f)); };
  const chunks = all.filter(isChunk);
  const inChunks = new Set(chunks.flatMap(moduleIds));
  const cssFiles = new Set(css), inlinedCode = inlined.filter(i => !STYLE.test(i)); // (the same for every chunk)
  for (const f of all) {
    const file = path.join(dir, f.fileName);
    /** @type {Set<string>} */
    const into = new Set();
    if (isChunk(f)) {
      const own = moduleIds(f).filter(id => !extracted(id));
      ofFiles(into, present(own.map(fileOf)));
      ofFiles(into, inlinedCode);
      for (const p of generatedIn({ [f.fileName]: f }, own).values()) into.add(p.path);
      hashes[file] = sha256(f.code);
    } else if (cssFiles.has(f)) {
      const importers = chunks.filter(c => c.viteMetadata && c.viteMetadata.importedCss && c.viteMetadata.importedCss.has(f.fileName));
      // and the style modules of chunks no longer in the bundle (Vite removes a chunk of style only, and hands its CSS
      // files to the chunks that imported it, not its modules)
      const from = importers.length ? [...importers.flatMap(moduleIds), ...[...ids].filter(id => !inChunks.has(id))] : [...ids];
      ofFiles(into, present(from.filter(extracted).map(fileOf)));
      ofFiles(into, inlined);
      ofFiles(into, originals.get(f) || []);
      hashes[file] = sha256(f.source);
    } else if (JS.test(f.fileName)) {
      add(into, generated.byContent(f.source));
      ofFiles(into, originals.get(f) || []);
      hashes[file] = sha256(f.source);
    } else continue; // (another asset - a worker's font or wasm (core/generated.cjs) - is no file another build bundles)
    contents[file] = [...into];
  }
  return { hashes, contents };
}

// The directories of the bundle's entry modules and the ones above them, nearest first.
/** @param {OutputBundle} bundle @returns {string[]} */
function entryDirs(bundle) {
  /** @type {Set<string>} */
  const dirs = new Set();
  for (const f of Object.values(bundle)) {
    const entry = isChunk(f) && f.isEntry && fileOf(f.facadeModuleId);
    for (let d = entry && path.dirname(entry); d && !dirs.has(d); d = path.dirname(d) === d ? null : path.dirname(d)) dirs.add(d);
  }
  return [...dirs];
}

/** @template T @param {() => T} fn @returns {() => T} */
function once(fn) {
  /** @type {T | undefined} */
  let v;
  return () => (v === undefined ? (v = fn()) : v);
}

// The file an asset was emitted from, given its originalFileName (or null). Rollup leaves the name's base to the plugin
// that emits the asset: Vite's are relative to its root, which is not always the working directory (root: 'web',
// `vite build web`) and which this plugin, added to the build by bundle-lockfile, does not see. The asset is the file
// with its bytes: the name relative to the working directory, else to an entry module's directory or one above it
// (Vite's root holds its entries); without one, the file relative to the working directory if it exists (an asset
// transformed on the way, e.g. a style sheet). bases(): those directories.
/**
 * @param {unknown} name
 * @param {string | Uint8Array} source
 * @param {string} cwd
 * @param {() => string[]} bases
 * @returns {string | null}
 */
function originalFile(name, source, cwd, bases) {
  if (typeof name !== 'string') return null;
  const own = path.resolve(cwd, name);
  if (hasBytes(own, source)) return own;
  for (const base of bases()) {
    const file = path.resolve(base, name);
    if (file !== own && hasBytes(file, source)) return file;
  }
  return fs.existsSync(own) ? own : null;
}

// The build's scope for vendored copies outside node_modules (core/vendored.cjs): the working directory and the
// bundle's entry files
/** @param {OutputBundle} bundle @param {string} cwd */
function buildOf(bundle, cwd) {
  return { context: cwd, entries: present(Object.values(bundle).filter(isChunk).filter(f => f.isEntry).map(f => fileOf(f.facadeModuleId))) };
}
// The files an asset was emitted from (see originalFile)
/** @type {(f: OutputAsset, cwd: string, bases: () => string[]) => string[]} */
const originalsOf = (f, cwd, bases) => {
  const names = f.originalFileNames || (f.originalFileName ? [f.originalFileName] : []);
  return present(names.map(n => originalFile(n, f.source, cwd, bases)));
};

// A generate-only output (Vite's workers and legacy polyfills, write: false, workbox-build, Vite 8 bundling its config)
// writes nothing itself: its packages are kept in memory for the build that uses it (core/generated.cjs) - each chunk's
// by its content, those of each asset emitted from a package file (a worker's font or wasm, which the build that uses it
// emits again without naming the file) by its bytes, all of them by the bundle's entry files. ctx: a plugin context;
// bundlers: the bundler packages, whose code is in every chunk. Returns all of them.
/**
 * @param {PluginContext} ctx
 * @param {OutputBundle} bundle
 * @param {{ cwd: string, bundlers: Package[], watched?: Iterable<unknown> }} opts
 * @returns {Package[]}
 */
function keepGenerated(ctx, bundle, { cwd, bundlers, watched = [] }) {
  /** @type {Package[][]} */
  const all = [];
  const bases = once(() => entryDirs(bundle));
  const build = buildOf(bundle, cwd);
  // the files the build's plugins inlined (watch files: not known per chunk): in each chunk and CSS file
  const inlined = inlinedFiles(watched, ctx);
  const inl = inlined.length ? packages.packagesForFiles(inlined, build) : [];
  for (const f of Object.values(bundle)) {
    /** @type {Package[]} */
    let pkgs;
    if (isChunk(f)) {
      const own = packages.packagesOfFiles(present(moduleIds(f).map(fileOf)), build).all;
      const helped = helpers.ofModuleIds(moduleIds(f), (id) => ctx.getModuleInfo(id), fileOf, cwd);
      pkgs = packages.unique(own, generatedIn({ [f.fileName]: f }, moduleIds(f)).values(), bundlers, helped, inl);
      generated.addChunk(f.code, pkgs);
    } else {
      const sources = originalsOf(f, cwd, bases);
      pkgs = packages.unique(sources.length ? packages.packagesForFiles(sources, build) : [], /\.css$/i.test(f.fileName) ? inl : []);
      generated.addAsset(f.source, pkgs);
    }
    all.push(pkgs);
  }
  const pkgs = packages.uniqueOf(all);
  for (const f of Object.values(bundle)) if (isChunk(f) && f.isEntry) generated.addEntry(fileOf(f.facadeModuleId), pkgs);
  return pkgs;
}

// What an output a build writes into `dir` has: its files; its packages - of its modules (`ids`: also those of chunks a
// plugin removed), of the files its assets were emitted from, of the files the build's plugins inlined (among
// `watched`, the build's watch files), of generate-only builds whose output is in it, the bundlers, the transpilers whose
// helpers are inlined -, how each was found (core/via.cjs), and the record of its JavaScript and CSS files for nested
// bundles (core/nested.cjs). ctx: a plugin context.
/**
 * @param {PluginContext} ctx
 * @param {OutputBundle} bundle
 * @param {{ dir: string, cwd: string, ids: Set<string>, watched: Iterable<unknown>, bundlers: Package[] }} opts
 * @returns {{ files: string[], pkgs: Package[], found: ViaCollector, hashes: Record<string, string>, contents: Record<string, string[]> }}
 */
function collectOutput(ctx, bundle, { dir, cwd, ids, watched, bundlers }) {
  /** @type {string[]} */
  const sources = [];
  /** @type {string[]} */
  const files = [];
  /** @type {Map<OutputAsset, string[]>} */
  const originals = new Map(); // asset -> its source files
  const bases = once(() => entryDirs(bundle));
  for (const f of Object.values(bundle)) {
    files.push(path.join(dir, f.fileName));
    if (isChunk(f)) continue;
    // assets emitted from a file (see originalFile)
    const own = originalsOf(f, cwd, bases);
    originals.set(f, own);
    sources.push(...own);
  }
  // how each source file was found (core/via.cjs): a module (chunk), a file an asset was emitted from (asset), a
  // file a plugin inlined (style, inlined)
  /** @type {Map<string, Set<string>>} */
  const kinds = new Map();
  /** @type {(f: string, cls: string) => void} */
  const mark = (f, cls) => { getOr(kinds, f, () => new Set()).add(cls); };
  for (const f of sources) mark(f, 'asset');
  for (const id of ids) { const file = fileOf(id); if (file) { sources.push(file); mark(file, 'chunk'); } }
  const inlined = inlinedFiles(watched, ctx);
  for (const f of inlined) { sources.push(f); mark(f, STYLE.test(f) ? 'style' : 'inlined'); }
  const result = packages.packagesOfFiles(sources, buildOf(bundle, cwd));
  const { all, byFile } = result;
  const gen = [...generatedIn(bundle, ids).values()];
  // the transpilers whose helpers their plugins inlined into this output's modules (core/helpers.cjs)
  const inl = helpers.ofModuleIds(ids, (id) => ctx.getModuleInfo(id), fileOf, cwd);
  const pkgs = packages.unique(all, gen, bundlers, inl);
  const found = via.ofFiles(result, kinds);
  found.add('generated', gen);
  found.add('runtime', bundlers);
  found.add('helpers', inl);
  const { hashes, contents } = outputContents(bundle, dir, ids, originals, inlined, byFile);
  // the bundler's code is in every chunk: its JavaScript files bring it too (core/nested.cjs)
  for (const f of Object.values(bundle)) {
    const c = isChunk(f) && contents[path.join(dir, f.fileName)];
    if (c) for (const p of [...bundlers, ...inl]) if (!c.includes(p.path)) c.push(p.path);
  }
  return { files, pkgs, found, hashes, contents };
}


module.exports = { moduleIds, fileOf, watchFilesOf, keepGenerated, collectOutput };
