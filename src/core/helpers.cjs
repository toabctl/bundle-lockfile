'use strict';
// Transpiler helpers inlined into modules. A transpiler that compiles syntax the target does not have (classes, async
// functions, object spread, named capture groups) writes helper functions into the module it compiles - its own code,
// not the module's: Babel's (@babel/helpers: function _classCallCheck(...), CVE-2025-27789 is in its _wrapRegExp),
// swc's (@swc/core: function _class_call_check(...)) and TypeScript's (typescript: var __awaiter = (this &&
// this.__awaiter) || ...). Helpers a module imports instead (@babel/runtime, @swc/helpers, tslib) are modules of
// their packages, listed as any. The lockfile lists the transpiler package whose helpers are in a shipped module:
// - inlined: a helper name the module's code has after its loaders or plugins ran, and its file on disk does not (a
//   package's own dist, compiled before it was published, has its helpers in its file: that is the package's code).
//   Babel and swc tell their helpers by their names (camelCase, snake_case); a one-word name (_extends, _typeof) can be
//   either's.
// - the copy: webpack and rspack: the one the module's loader resolves (babel-loader's @babel/core's @babel/helpers,
//   swc-loader's @swc/core, ts-loader's typescript or its `compiler` option); Rollup, Rolldown, Vite: the copies loaded
//   in this process (the CommonJS hook reports them, see seen), else the one the build's directory resolves. None: a
//   debug message - code shaped like a helper that no transpiler of the build wrote.
// Not covered: transpilers inside a bundler's binary (rspack's builtin:swc-loader, Next.js' SWC: their packages are
// listed as the bundler, core/bundler.cjs), and esbuild's helpers (esbuild is listed as the bundler that ran it). A
// webpack loader in another process (thread-loader) is found all the same: the module's loader chain names it.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const config = require('./config.cjs');
const { readPackage } = require('./manifest.cjs');
const { packageRoot, realRoot } = require('./paths.cjs');
const { isObject, isArray } = require('./values.cjs');
/** @import { Package } from '../types' */
/** @typedef {'babel' | 'swc' | 'typescript'} Transpiler */
/** @typedef {Transpiler | 'either'} Family */
/** @typedef {Record<Family, Set<string>>} Names */

// helper names in code, by family; one-word names of _function helpers are 'either' (Babel or swc)
const FN = /\bfunction _([a-z][A-Za-z0-9]*(?:_[a-z0-9]+)*)\s*\(/g;
const TS = /\bvar (__[A-Za-z]+) = \(this && this\.\1\) \|\|/g;
/**
 * @param {unknown} code
 * @returns {Names}
 */
function names(code) {
  /** @type {Names} */
  const out = { babel: new Set(), swc: new Set(), either: new Set(), typescript: new Set() };
  if (typeof code !== 'string' || !code) return out;
  if (code.includes('function _')) {
    for (const m of code.matchAll(FN)) {
      const n = m[1];
      (n.includes('_') ? out.swc : /[A-Z]/.test(n) ? out.babel : out.either).add(n);
    }
  }
  if (code.includes('this && this.__')) for (const m of code.matchAll(TS)) out.typescript.add(m[1]);
  return out;
}
/** @param {Names} n */
const empty = (n) => !n.babel.size && !n.swc.size && !n.either.size && !n.typescript.size;

// The families whose helpers `code` (a module's code after its loaders or plugins) has and its file (absolute; null:
// a virtual module, which has no file) does not: Set of 'babel', 'swc', 'either', 'typescript'.
/**
 * @param {unknown} code
 * @param {string | null | undefined} file
 * @returns {Set<Family>}
 */
function inlined(code, file) {
  const got = names(code);
  /** @type {Set<Family>} */
  const out = new Set();
  if (empty(got)) return out;
  let original = '';
  if (file) { try { original = fs.readFileSync(file, 'utf8'); } catch { original = ''; } }
  const had = names(original);
  for (const fam of /** @type {Family[]} */ (Object.keys(got))) for (const n of got[fam]) if (!had[fam].has(n)) { out.add(fam); break; }
  return out;
}

// The packages of each family, and what resolves them from a loader or a directory
/** @type {Record<Transpiler, string[]>} */
const PACKAGES = { babel: ['@babel/helpers'], swc: ['@swc/core'], typescript: ['typescript'] };
/** @type {Record<Transpiler, RegExp>} */
const LOADERS = { babel: /[\\/]babel-loader[\\/]/, swc: /[\\/]swc-loader[\\/]/, typescript: /[\\/]ts-loader[\\/]/ };
/** @type {(fam: Family) => Transpiler[]} */
const familiesOf = (fam) => (fam === 'either' ? ['babel', 'swc'] : [fam]);

/** @type {(p: string) => string | null} */
const real = (p) => { const r = packageRoot(p); return r ? realRoot(r) : null; };
/** @type {Map<string, Package | null>} */
const byRoot = new Map(); // package root -> package | null
/**
 * @param {string} file
 * @returns {Package | null}
 */
function packageAtFile(file) {
  const root = real(file);
  if (!root) return null;
  if (!byRoot.has(root)) byRoot.set(root, readPackage(root));
  return /** @type {Package | null} */ (byRoot.get(root));
}
// The package.json of `request` (a package name) as `from` (a file) resolves it, or null
/**
 * @param {string} from
 * @param {string} request
 * @returns {string | null}
 */
function resolveFrom(from, request) {
  try { return createRequire(from).resolve(`${request}/package.json`); } catch { return null; }
}
// The transpiler package of a family that a loader (its file, options) resolves
/**
 * @param {Transpiler} fam
 * @param {string} loader
 * @param {unknown} options
 * @returns {Package | null}
 */
function fromLoader(fam, loader, options) {
  if (fam === 'babel') {
    const core = resolveFrom(loader, '@babel/core');
    const helpers = core && resolveFrom(core, '@babel/helpers');
    return helpers ? packageAtFile(helpers) : null;
  }
  if (fam === 'swc') { const f = resolveFrom(loader, '@swc/core'); return f ? packageAtFile(f) : null; }
  if (fam === 'typescript') {
    const compiler = isObject(options) && typeof options.compiler === 'string' ? options.compiler : 'typescript';
    const f = resolveFrom(loader, compiler);
    return f ? packageAtFile(f) : null;
  }
  return null;
}

// Copies of the transpilers this process loaded (the CommonJS hook reports every module, see hooks.cjs)
/** @type {Record<Transpiler, RegExp>} */
const LOADED = {
  babel: /[\\/]node_modules[\\/]@babel[\\/]helpers[\\/]lib[\\/]index\.js$/,
  swc: /[\\/]node_modules[\\/]@swc[\\/]core[\\/](?:index|binding)\.js$/,
  typescript: /[\\/]node_modules[\\/]typescript[\\/]lib[\\/]typescript\.js$/,
};
/** @type {Record<Transpiler, Set<string>>} */
const loaded = { babel: new Set(), swc: new Set(), typescript: new Set() }; // package roots
/** @param {unknown} filename */
function seen(filename) {
  if (typeof filename !== 'string' || !filename.includes('node_modules')) return;
  for (const fam of /** @type {Transpiler[]} */ (Object.keys(LOADED))) {
    if (!LOADED[fam].test(filename)) continue;
    const root = real(filename);
    if (root) loaded[fam].add(root);
  }
}

/** @type {Set<string>} */
const noted = new Set();
/** @param {string} msg */
const note = (msg) => { if (!noted.has(msg)) { noted.add(msg); config.debug(msg); } };

// webpack and rspack: the transpiler packages whose helpers are inlined into `modules` (modules of shipped chunks,
// also the inner modules of concatenated ones). sourceOf(module): its file (absolute) or null.
/**
 * What is read of a webpack or rspack module (its loaders: checked, a plugin's module may have others)
 * @typedef {{ loaders?: unknown, originalSource?: () => ({ source?: () => unknown } | null), identifier: () => string }} WebpackModule
 */
/**
 * @param {Iterable<WebpackModule>} modules
 * @param {(m: WebpackModule) => string | null | undefined} sourceOf
 * @returns {Package[]}
 */
function ofWebpackModules(modules, sourceOf) {
  /** @type {Map<string, Package>} */
  const out = new Map();
  for (const m of modules) {
    const loaders = isArray(m.loaders) ? m.loaders.flatMap(l => (isObject(l) && typeof l.loader === 'string' ? [{ loader: l.loader, options: l.options }] : [])) : [];
    const used = /** @type {Transpiler[]} */ (Object.keys(LOADERS)).filter(fam => loaders.some(l => LOADERS[fam].test(l.loader)));
    if (!used.length) continue;
    /** @type {unknown} */
    let code;
    try { const s = typeof m.originalSource === 'function' ? m.originalSource() : null; code = s && s.source ? s.source() : null; } catch { code = null; }
    if (code && typeof code !== 'string') code = Buffer.isBuffer(code) ? code.toString('utf8') : null;
    const file = sourceOf(m);
    // the code after the loaders is not there to look at: the transpilers that ran count (a package too many rather than
    // one missing)
    /** @type {Set<Family>} */
    const fams = code === null ? new Set(used) : inlined(code, file && path.isAbsolute(file) ? file.split('?')[0] : null);
    for (const f of fams) {
      for (const fam of familiesOf(f)) {
        if (!used.includes(fam)) continue;
        const l = loaders.find(x => LOADERS[fam].test(x.loader));
        if (!l) continue; // (none: fam is not in used)
        const p = fromLoader(fam, l.loader, l.options);
        if (p) out.set(p.path, p);
        else note(`helpers of ${fam} in ${file || m.identifier()}: ${l.loader} resolves no ${PACKAGES[fam].join(' or ')}`);
      }
    }
  }
  return [...out.values()];
}

// Rollup, Rolldown, Vite: the transpiler packages whose helpers are inlined into the modules `ids` (of shipped
// chunks; also virtual ones, such as @rollup/plugin-babel's \0rollupPluginBabelHelpers.js). infoOf(id): the module's
// info (this.getModuleInfo: its code after the plugins' transforms); fileOf(id): its file or null; cwd: the build's
// directory.
/**
 * @param {Iterable<string>} ids
 * @param {(id: string) => unknown} infoOf
 * @param {(id: string) => string | null | undefined} fileOf
 * @param {string} cwd
 * @returns {Package[]}
 */
function ofModuleIds(ids, infoOf, fileOf, cwd) {
  /** @type {Map<Transpiler, boolean>} */
  const fams = new Map(); // family -> whether only one-word names (Babel's or swc's) brought it
  for (const id of ids) {
    let info;
    try { info = infoOf(id); } catch { info = null; }
    const code = isObject(info) && typeof info.code === 'string' ? info.code : null;
    if (!code) continue;
    for (const f of inlined(code, fileOf(id))) for (const fam of familiesOf(f)) fams.set(fam, f === 'either' && fams.get(fam) !== false);
  }
  /** @type {Map<string, Package>} */
  const out = new Map();
  for (const [fam, either] of fams) {
    let roots = [...loaded[fam]];
    // a one-word name is the helper of the transpiler that ran - one this process loaded, not any the directory has
    if (!roots.length && either) continue;
    if (!roots.length) { const f = resolveFrom(path.join(cwd, 'x'), PACKAGES[fam][0]); const r = f && real(f); if (r) roots = [r]; }
    let any = false;
    for (const r of roots) { const p = byRoot.has(r) ? byRoot.get(r) : packageAtFile(path.join(r, 'package.json')); if (p) { out.set(p.path, p); any = true; } }
    if (!any) note(`helpers of ${fam} in a module of ${cwd}: this process loaded no ${PACKAGES[fam].join(' or ')}, nor does ${cwd} resolve one`);
  }
  return [...out.values()];
}

module.exports = { names, inlined, seen, ofWebpackModules, ofModuleIds };
