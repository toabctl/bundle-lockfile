'use strict';
// What differs between the compilers webpack-family.cjs and webpack-collect.cjs handle - webpack 4 and 5 (also Next.js'
// copy), rspack 1 and 2 -, each in one place, named after what it asks: the rest of the webpack adapter asks these
// instead of testing versions or the shape of an object itself.
const path = require('path');
const { createRequire } = require('module');

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

// The directory webpack writes a compilation's assets to: output.path can hold placeholders, e.g. [fullhash].
const outputDir = (compilation) =>
  (typeof compilation.getPath === 'function' ? compilation.getPath(compilation.compiler.outputPath, {}) : compilation.compiler.outputPath);

const assetNames = (compilation) => (compilation.getAssets ? compilation.getAssets().map(a => a.name) : Object.keys(compilation.assets || {}));

const assetOf = (compilation, name) => (compilation.getAsset ? compilation.getAsset(name)
  : compilation.assets[name] && { name, source: compilation.assets[name], info: {} }); // webpack < 4.40: no asset info

// [major, minor] of a version
const versionOf = (v) => String(v || '').split('.').map(Number);

// The compiler is rspack's (rspack.cjs), not webpack's: it names its version. Decided per compiler, as both can be loaded
// in one process (Next.js with next-rspack loads its webpack too, OHIF loads rspack 1 and 2).
const isRspack = (compiler) => !!(compiler && compiler.webpack && typeof compiler.webpack.rspackVersion === 'string');

// The class webpack-sources' RawSource, for an asset: compiler.webpack.sources (webpack >= 5.1, rspack), else the
// webpack-sources next to the Compiler module (webpack 4: compilerFile), else null (an asset of a plain object then).
function rawSourceOf(compiler, compilerFile) {
  const own = compiler.webpack && compiler.webpack.sources && compiler.webpack.sources.RawSource;
  if (own) return own;
  try { return createRequire(compilerFile || __filename)('webpack-sources').RawSource; } catch { return null; }
}
// An asset with the content `text`
function sourceOf(RawSource, text) {
  return RawSource ? new RawSource(text) : { source: () => text, size: () => Buffer.byteLength(text) };
}

// Adds (or replaces) an asset: emitAsset (webpack >= 4.40, rspack), else the assets object.
function emitAsset(compilation, name, src) {
  if (compilation.emitAsset) compilation.emitAsset(name, src); else compilation.assets[name] = src;
}

// The bytes of an asset while webpack still has its source, else null: webpack 5 keeps only the size of an emitted
// asset (its source then throws or is gone).
function assetBytes(compilation, name) {
  try { const s = assetOf(compilation, name).source.source(); return Buffer.isBuffer(s) ? s : Buffer.from(s); } catch { return null; }
}
// The bytes of an asset, also after the emit: from its source, else from the output file system (the file webpack wrote:
// the name without a query string). null if neither has them.
/** @returns {Promise<Buffer | null>} */
async function readAsset(compilation, dir, name) {
  const buf = assetBytes(compilation, name);
  if (buf) return buf;
  const fsys = compilation.compiler.outputFileSystem;
  if (!fsys || typeof fsys.readFile !== 'function') return null;
  return new Promise((resolve) => {
    try { fsys.readFile(path.join(dir, name.split('?')[0]), (err, b) => resolve(err ? null : b)); } catch { resolve(null); }
  });
}

// Whether a file is there in the output file system: lstat (a symbolic link asset, webpack >= 5.111, is there also if
// what it points at is not), else stat; webpack 4's output file system has neither (nor output.clean): there, then.
// Anything but "not found" counts as there: when in doubt, keep the packages.
/** @returns {(file: string) => Promise<boolean>} */
function existsIn(fsys) {
  const stat = fsys && ['lstat', 'stat'].find(m => typeof fsys[m] === 'function');
  return (file) => new Promise((resolve) => {
    if (!stat) return resolve(true);
    try { fsys[stat](file, (err) => resolve(!err || err.code !== 'ENOENT')); } catch { resolve(true); }
  });
}
// Writes a file through the output file system (an in-memory one: webpack-dev-middleware's memfs)
/** @returns {(content: string) => Promise<void>} */
const writeIn = (fsys, file) => (content) => new Promise((resolve, reject) => {
  fsys.writeFile(file, content, (err) => (err ? reject(err) : resolve()));
});

module.exports = {
  hook, kindOf, isRspack, versionOf, chunkModules, entryModules, issuers, outputDir, hasAsset, assetNames, assetOf, assetBytes,
  readAsset, emitAsset, rawSourceOf, sourceOf, existsIn, writeIn,
};
