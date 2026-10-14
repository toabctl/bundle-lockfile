'use strict';
// The Rollup adapter's answer to "which source files and packages are in the output this build writes" (see rollup.cjs,
// the plugin that asks it in a build's hooks): from a bundle (the generateBundle hook's) and the plugin context, for
// Rollup, Rolldown and Vite alike. Reads the bundle and the files on disk only; what the plugin keeps across a build's
// hooks (the modules of each output, the files Rolldown's plugins inlined) it is given.
/** @import { Package } from '../types' */
const fs = require('fs');
const path = require('path');
const packages = require('../core/packages.cjs');
const via = require('../core/via.cjs');
const helpers = require('../core/helpers.cjs');
const generated = require('../core/generated.cjs');
const { sha256 } = require('../core/hashes.cjs');

const JS = /\.[cm]?js$/i;
const { STYLE } = packages;

const moduleIds = (chunk) => chunk.moduleIds || Object.keys(chunk.modules || {});

// Source file of a module id: virtual modules (\0vite/..., \0commonjsHelpers.js, virtual:...) have none; a
// \0-prefixed absolute id (rollup's commonjs proxies) and ids with queries (?vue&type=style, ?inline, ?worker) are
// the file before them. Directories and files can have a "#" in their name (~/c#/app): a "#" in the last part of the
// path is a fragment only if the file with it is not there.
function fileOf(id) {
  if (typeof id !== 'string') return null;
  let f = id.replace(/^\0/, '').split('?')[0];
  const hash = f.lastIndexOf('#');
  if (hash > Math.max(f.lastIndexOf('/'), f.lastIndexOf('\\')) && !fs.existsSync(f)) f = f.slice(0, hash);
  return path.isAbsolute(f) ? path.normalize(f) : null;
}

// The build's watch files: its modules, and the files its plugins read and inlined into a module (this.addWatchFile:
// Vite's CSS plugin adds the style sheets a style sheet @imports, and from Vite 6.1 on the images and fonts it inlines
// as data: URLs). Rollup has them in the plugin context; Rolldown only on the RolldownBuild that rolldown() returned.
async function watchFilesOf(ctx, build) {
  try { if (typeof ctx.getWatchFiles === 'function') return ctx.getWatchFiles(); } catch { /* none */ }
  try { if (build) { const w = await build.watchFiles; if (Array.isArray(w)) return w; } } catch { /* none */ }
  return [];
}

// The files among the build's watch files that its plugins inlined (packages.inlinedFile), absolute: those that are no
// module of the build (also not one that was tree-shaken: modules are bundled or not, never inlined).
function inlinedFiles(watchFiles, ctx) {
  let ids;
  try { ids = new Set([...ctx.getModuleIds()].map(fileOf).filter(Boolean)); } catch { ids = new Set(); }
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
function generatedIn(bundle, ids) {
  const out = new Map();
  const add = (pkgs) => { if (pkgs) for (const p of pkgs) out.set(p.path, p); };
  for (const f of Object.values(bundle)) {
    if (f.type === 'chunk') add(generated.byContent(f.code));
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
function outputContents(bundle, dir, ids, originals, inlined, byFile) {
  const hashes = {}, contents = {};
  const all = Object.values(bundle);
  const css = all.filter(f => f.type !== 'chunk' && /\.css$/i.test(f.fileName));
  const isStyle = (id) => STYLE.test(fileOf(id) || '');
  const extracted = (id) => css.length > 0 && isStyle(id) && !/[?&](inline|raw|url)\b/.test(id);
  const add = (into, pkgs) => { if (pkgs) for (const p of pkgs) into.add(p.path); };
  const ofFiles = (into, list) => { for (const f of list) add(into, byFile.get(f)); };
  for (const f of all) {
    const file = path.join(dir, f.fileName);
    const into = new Set();
    if (f.type === 'chunk') {
      const own = moduleIds(f).filter(id => !extracted(id));
      ofFiles(into, own.map(fileOf).filter(Boolean));
      ofFiles(into, inlined.filter(i => !STYLE.test(i)));
      for (const p of generatedIn({ [f.fileName]: f }, own).values()) into.add(p.path);
      hashes[file] = sha256(f.code);
    } else if (css.includes(f)) {
      const importers = all.filter(c => c.type === 'chunk' && c.viteMetadata && c.viteMetadata.importedCss && c.viteMetadata.importedCss.has(f.fileName));
      const from = importers.length ? importers.flatMap(moduleIds) : [...ids];
      ofFiles(into, from.filter(extracted).map(fileOf));
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
function entryDirs(bundle) {
  const dirs = new Set();
  for (const f of Object.values(bundle)) {
    const entry = f.type === 'chunk' && f.isEntry && fileOf(f.facadeModuleId);
    for (let d = entry && path.dirname(entry); d && !dirs.has(d); d = path.dirname(d) === d ? null : path.dirname(d)) dirs.add(d);
  }
  return [...dirs];
}

// The file has these bytes (a string as Rollup writes it, or a Buffer / Uint8Array).
function hasBytes(file, data) {
  if (data == null) return false;
  try {
    const buf = Buffer.from(data);
    return fs.statSync(file).size === buf.length && fs.readFileSync(file).equals(buf);
  } catch { return false; }
}

const once = (fn) => { let v; return () => (v === undefined ? (v = fn()) : v); };

// The file an asset was emitted from, given its originalFileName (or null). Rollup leaves the name's base to the plugin
// that emits the asset: Vite's are relative to its root, which is not always the working directory (root: 'web',
// `vite build web`) and which this plugin, added to the build by bundle-lockfile, does not see. The asset is the file
// with its bytes: the name relative to the working directory, else to an entry module's directory or one above it
// (Vite's root holds its entries); without one, the file relative to the working directory if it exists (an asset
// transformed on the way, e.g. a style sheet). bases(): those directories.
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
function buildOf(bundle, cwd) {
  return { context: cwd, entries: Object.values(bundle).filter(f => f.type === 'chunk' && f.isEntry).map(f => fileOf(f.facadeModuleId)).filter(Boolean) };
}

// A generate-only output (Vite's workers and legacy polyfills, write: false, workbox-build, Vite 8 bundling its config)
// writes nothing itself: its packages are kept in memory for the build that uses it (core/generated.cjs) - each chunk's
// by its content, those of each asset emitted from a package file (a worker's font or wasm, which the build that uses it
// emits again without naming the file) by its bytes, all of them by the bundle's entry files. ctx: a plugin context;
// bundlers: the bundler packages, whose code is in every chunk. Returns all of them.
/**
 * @param {any} ctx
 * @param {Record<string, any>} bundle
 * @param {{ cwd: string, bundlers: Package[] }} opts
 * @returns {Package[]}
 */
function keepGenerated(ctx, bundle, { cwd, bundlers }) {
  const all = [];
  const bases = once(() => entryDirs(bundle));
  for (const f of Object.values(bundle)) {
    let pkgs;
    if (f.type === 'chunk') {
      const own = packages.packagesOfFiles(moduleIds(f).map(fileOf).filter(Boolean), buildOf(bundle, cwd)).all;
      const inl = helpers.ofModuleIds(moduleIds(f), (id) => ctx.getModuleInfo(id), fileOf, cwd);
      pkgs = packages.unique(own, generatedIn({ [f.fileName]: f }, moduleIds(f)).values(), bundlers, inl);
      generated.addChunk(f.code, pkgs);
    } else {
      const names = f.originalFileNames || (f.originalFileName ? [f.originalFileName] : []);
      const sources = names.map(n => originalFile(n, f.source, cwd, bases)).filter(Boolean);
      pkgs = sources.length ? packages.packagesForFiles(sources) : [];
      generated.addAsset(f.source, pkgs);
    }
    all.push(pkgs);
  }
  const pkgs = packages.unique(...all);
  for (const f of Object.values(bundle)) if (f.type === 'chunk' && f.isEntry) generated.addEntry(fileOf(f.facadeModuleId), pkgs);
  return pkgs;
}

// What an output a build writes into `dir` has: its files; its packages - of its modules (`ids`: also those of chunks a
// plugin removed), of the files its assets were emitted from, of the files the build's plugins inlined (among
// `watched`, the build's watch files), of generate-only builds whose output is in it, the bundlers, the transpilers whose
// helpers are inlined -, how each was found (core/via.cjs), and the record of its JavaScript and CSS files for nested
// bundles (core/nested.cjs). ctx: a plugin context.
/**
 * @param {any} ctx
 * @param {Record<string, any>} bundle
 * @param {{ dir: string, cwd: string, ids: Set<string>, watched: Iterable<unknown>, bundlers: Package[] }} opts
 */
function collectOutput(ctx, bundle, { dir, cwd, ids, watched, bundlers }) {
  const sources = [], files = [], originals = new Map(); // asset -> its source files
  const bases = once(() => entryDirs(bundle));
  for (const f of Object.values(bundle)) {
    files.push(path.join(dir, f.fileName));
    if (f.type === 'chunk') continue;
    // assets emitted from a file (see originalFile)
    const own = [];
    for (const n of f.originalFileNames || (f.originalFileName ? [f.originalFileName] : [])) {
      const p = originalFile(n, f.source, cwd, bases);
      if (p) own.push(p);
    }
    originals.set(f, own);
    sources.push(...own);
  }
  // how each source file was found (core/via.cjs): a module (chunk), a file an asset was emitted from (asset), a
  // file a plugin inlined (style, inlined)
  /** @type {Map<string, Set<string>>} */
  const kinds = new Map();
  const mark = (f, cls) => { if (!kinds.has(f)) kinds.set(f, new Set()); /** @type {Set<string>} */ (kinds.get(f)).add(cls); };
  for (const f of sources) mark(f, 'asset');
  for (const id of ids) { const file = fileOf(id); if (file) { sources.push(file); mark(file, 'chunk'); } }
  const inlined = inlinedFiles(watched, ctx);
  sources.push(...inlined);
  for (const f of inlined) mark(f, STYLE.test(f) ? 'style' : 'inlined');
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
    const c = f.type === 'chunk' && contents[path.join(dir, f.fileName)];
    if (c) for (const p of [...bundlers, ...inl]) if (!c.includes(p.path)) c.push(p.path);
  }
  return { files, pkgs, found, hashes, contents };
}


module.exports = { moduleIds, fileOf, watchFilesOf, keepGenerated, collectOutput };
