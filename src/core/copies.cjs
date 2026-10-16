'use strict';
// Files copied out of a package: a tool that copies a package's files somewhere else and bundles or ships the copy
// hides where they come from. @sveltejs/adapter-node 5 copies its own files/ into .svelte-kit/adapter-node/entries and
// bundles them from there (so that node_modules resolve from the project); copy plugins put a package's file into the
// output under another name. fs's copy functions are wrapped to remember, in this process, destination -> source for
// copies from a package directory to outside of node_modules; sourceOf() gives the source of a file that still has
// the source's bytes. fs.copyFile* and fs.cp* only: a copy made with readFile + writeFile is not seen. Listeners
// (onCopy) learn of every copy once it is done, before the caller does: core/outputs.cjs re-anchors copied lockfiles.
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const lru = require('./lru.cjs');
const { inTree } = require('./tree.cjs');
const { ancestors, packageRoot, realish } = require('./paths.cjs');
const { perProcess } = require('./values.cjs');
/** @typedef {(src: string, dest: string, isDirectory: boolean) => void} CopyListener */
/**
 * @typedef {{ files: Map<string, string>, dirs: Map<string, string>, installed: boolean, listeners: CopyListener[], warned?: boolean }} State
 */

const S = Symbol.for('bundle-lockfile.copies.v2'); // v2: listeners; a copy of v1 has its own wrappers
const MAX = 50000; // entries; a long-running process must not grow them forever
// files: destination file -> source file; dirs: destination dir -> source dir (fs.cp of a directory)
/** @type {State} */
const state = perProcess(S, () => ({ files: new Map(), dirs: new Map(), installed: false, listeners: [] }));
if (!state.listeners) state.listeners = []; // fn(src, dest, isDirectory) after a copy that worked (a state an earlier release made)

// fn(src, dest, isDirectory): called after every copy that worked (absolute paths), before the copy returns to its
// caller (its callback, its promise); what fn throws is ignored.
/** @param {CopyListener} fn */
function onCopy(fn) { state.listeners.push(fn); }
/**
 * @param {unknown} src
 * @param {unknown} dest
 * @param {boolean} dir
 */
function copied(src, dest, dir) {
  const s = abs(src), d = abs(dest);
  if (!s || !d) return;
  for (const fn of state.listeners) { try { fn(s, d, dir); } catch { /* never in the way */ } }
}

// p is below node_modules, not in a tool's directory there (node_modules/.cache: no package, see core/paths.cjs
// packageRoot - a copy into it is followed, as one into the output)
/** @param {string} p */
const inPackage = (p) => {
  const parts = p.split(path.sep), i = parts.lastIndexOf('node_modules');
  return i >= 0 && (!(parts[i + 1] || '').startsWith('.') || packageRoot(path.join(p, 'x')) !== null);
};

/**
 * @param {unknown} p
 * @returns {string | null}
 */
function abs(p) {
  try {
    if (p instanceof URL) return path.resolve(fileURLToPath(p));
    if (Buffer.isBuffer(p)) return path.resolve(p.toString());
    return typeof p === 'string' ? path.resolve(p) : null;
  } catch { return null; }
}

/**
 * @param {unknown} src
 * @param {unknown} dest
 * @param {boolean} dir
 */
function record(src, dest, dir) {
  const s = abs(src), d = abs(dest);
  // (a lockfile's package.json tree, core/tree.cjs, is no package's: copied with its output, not out of a package)
  if (!s || !d || !inPackage(s) || inPackage(d) || inTree(s)) return;
  // also by the real path, which bundlers name a file by (a destination through a symbolic link: macOS /tmp)
  const real = realish(d);
  if (real !== d) lru.set(dir ? state.dirs : state.files, real, s, MAX);
  if (lru.set(dir ? state.dirs : state.files, d, s, MAX) && !state.warned) {
    // the oldest copies are forgotten: a bundled copy of one of them counts as first-party from now on
    state.warned = true;
    require('./config.cjs').warn(`more than ${MAX} ${dir ? 'directories' : 'files'} copied out of packages in this process: the oldest copies are forgotten, a bundled copy of them is no longer listed as its package`);
  }
}

// Both are files with the same bytes.
/**
 * @param {string} a
 * @param {string} b
 */
function sameBytes(a, b) {
  try {
    const sa = fs.statSync(a), sb = fs.statSync(b);
    return sa.isFile() && sb.isFile() && sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch { return false; }
}

// The file has these bytes (a string as a bundler writes it, a Buffer or a Uint8Array): the adapters' test of which file
// an asset was copied or emitted from.
/**
 * @param {string} file
 * @param {string | Uint8Array | null | undefined} data
 */
function hasBytes(file, data) {
  if (data == null) return false;
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(/** @type {any} */ (data));
    return fs.statSync(file).size === buf.length && fs.readFileSync(file).equals(buf);
  } catch { return false; }
}

// The package file `file` is a copy of, if it still has its bytes; else null.
/**
 * @param {string} file
 * @returns {string | null}
 */
function sourceOf(file) {
  if (!state.files.size && !state.dirs.size) return null;
  const f = path.resolve(file);
  // a file copied by itself, then (overwritten since) as part of a directory: the copy whose bytes it has
  const direct = state.files.get(f);
  if (direct && sameBytes(f, direct)) return direct;
  for (const dir of ancestors(path.dirname(f))) {
    const src = state.dirs.get(dir);
    if (src) { const s = path.join(src, path.relative(dir, f)); if (sameBytes(f, s)) return s; }
  }
  return null;
}


// Wraps fs.copyFile, fs.copyFileSync, fs.cp, fs.cpSync and their fs.promises versions (also what fs-extra and
// graceful-fs call: they take them from fs). Recording never makes a copy fail.
function install() {
  if (state.installed) return;
  state.installed = true;
  // kind: 'sync' (returns when done), 'callback' (the last argument is called when done), 'promise'
  /** @typedef {(this: unknown, ...args: unknown[]) => unknown} Fn */
  /** @type {(obj: object, name: string, dirAware: boolean, kind: 'sync' | 'callback' | 'promise') => void} */
  const wrap = (obj, name, dirAware, kind) => {
    const fns = /** @type {Record<string, unknown>} */ (obj);
    const orig = /** @type {Fn} */ (fns[name]);
    if (typeof orig !== 'function') return;
    /** @type {(this: unknown, src: unknown, dest: unknown, ...rest: unknown[]) => unknown} */
    const wrapped = function (src, dest, ...rest) {
      let dir = false;
      try {
        if (dirAware) { try { dir = fs.statSync(/** @type {import('fs').PathLike} */ (src)).isDirectory(); } catch { /* the copy reports it */ } }
        record(src, dest, dir);
      } catch { /* never in the way */ }
      const done = () => copied(src, dest, dir);
      const cb = rest.at(-1);
      if (kind === 'callback' && typeof cb === 'function') {
        const callback = /** @type {Fn} */ (cb);
        /** @type {Fn} */
        rest[rest.length - 1] = function (err, ...more) { if (!err) done(); return callback.call(this, err, ...more); };
        return orig.call(this, src, dest, ...rest);
      }
      const result = /** @type {{ then?: unknown } | null | undefined} */ (orig.call(this, src, dest, ...rest));
      if (kind === 'promise' && result && typeof result.then === 'function') return /** @type {Promise<unknown>} */ (result).then((v) => { done(); return v; });
      if (kind === 'sync') done();
      return result;
    };
    Object.defineProperty(wrapped, 'name', { value: orig.name });
    fns[name] = wrapped;
  };
  wrap(fs, 'copyFile', false, 'callback'); wrap(fs, 'copyFileSync', false, 'sync');
  wrap(fs, 'cp', true, 'callback'); wrap(fs, 'cpSync', true, 'sync');
  wrap(fs.promises, 'copyFile', false, 'promise'); wrap(fs.promises, 'cp', true, 'promise');
  try { require('module').syncBuiltinESMExports(); } catch { /* named ESM imports keep the originals */ }
}

module.exports = { install, sourceOf, record, sameBytes, hasBytes, onCopy };
