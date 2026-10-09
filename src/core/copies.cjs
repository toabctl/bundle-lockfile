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
const { ancestors } = require('./paths.cjs');

const S = Symbol.for('bundle-lockfile.copies.v2'); // v2: listeners; a copy of v1 has its own wrappers
const MAX = 50000; // entries; a long-running process must not grow them forever
// files: destination file -> source file; dirs: destination dir -> source dir (fs.cp of a directory)
const state = globalThis[S] || (globalThis[S] = { files: new Map(), dirs: new Map(), installed: false });
if (!state.listeners) state.listeners = []; // fn(src, dest, isDirectory) after a copy that worked

// fn(src, dest, isDirectory): called after every copy that worked (absolute paths), before the copy returns to its
// caller (its callback, its promise); what fn throws is ignored.
function onCopy(fn) { state.listeners.push(fn); }
function copied(src, dest, dir) {
  const s = abs(src), d = abs(dest);
  if (!s || !d) return;
  for (const fn of state.listeners) { try { fn(s, d, dir); } catch { /* never in the way */ } }
}

const inPackage = (p) => p.split(path.sep).includes('node_modules');

function abs(p) {
  try {
    if (p instanceof URL) return path.resolve(fileURLToPath(p));
    if (Buffer.isBuffer(p)) return path.resolve(p.toString());
    return typeof p === 'string' ? path.resolve(p) : null;
  } catch { return null; }
}

function record(src, dest, dir) {
  const s = abs(src), d = abs(dest);
  if (!s || !d || !inPackage(s) || inPackage(d)) return;
  lru.set(dir ? state.dirs : state.files, d, s, MAX);
}

// Both are files with the same bytes.
function sameBytes(a, b) {
  try {
    const sa = fs.statSync(a), sb = fs.statSync(b);
    return sa.isFile() && sb.isFile() && sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch { return false; }
}

// The package file `file` is a copy of, if it still has its bytes; else null.
function sourceOf(file) {
  if (!state.files.size && !state.dirs.size) return null;
  const f = path.resolve(file);
  const direct = state.files.get(f);
  if (direct) return sameBytes(f, direct) ? direct : null;
  for (const dir of ancestors(path.dirname(f))) {
    const src = state.dirs.get(dir);
    if (src) { const s = path.join(src, path.relative(dir, f)); return sameBytes(f, s) ? s : null; }
  }
  return null;
}

// Wraps fs.copyFile, fs.copyFileSync, fs.cp, fs.cpSync and their fs.promises versions (also what fs-extra and
// graceful-fs call: they take them from fs). Recording never makes a copy fail.
function install() {
  if (state.installed) return;
  state.installed = true;
  // kind: 'sync' (returns when done), 'callback' (the last argument is called when done), 'promise'
  const wrap = (obj, name, dirAware, kind) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    const wrapped = function (src, dest, ...rest) {
      let dir = false;
      try {
        if (dirAware) { try { dir = fs.statSync(src).isDirectory(); } catch { /* the copy reports it */ } }
        record(src, dest, dir);
      } catch { /* never in the way */ }
      const done = () => copied(src, dest, dir);
      if (kind === 'callback' && typeof rest[rest.length - 1] === 'function') {
        const cb = rest[rest.length - 1];
        rest[rest.length - 1] = function (err, ...more) { if (!err) done(); return cb.call(this, err, ...more); };
        return orig.call(this, src, dest, ...rest);
      }
      const result = orig.call(this, src, dest, ...rest);
      if (kind === 'promise' && result && typeof result.then === 'function') return result.then((v) => { done(); return v; });
      if (kind === 'sync') done();
      return result;
    };
    Object.defineProperty(wrapped, 'name', { value: orig.name });
    obj[name] = wrapped;
  };
  wrap(fs, 'copyFile', false, 'callback'); wrap(fs, 'copyFileSync', false, 'sync');
  wrap(fs, 'cp', true, 'callback'); wrap(fs, 'cpSync', true, 'sync');
  wrap(fs.promises, 'copyFile', false, 'promise'); wrap(fs.promises, 'cp', true, 'promise');
  try { require('module').syncBuiltinESMExports(); } catch { /* named ESM imports keep the originals */ }
}

module.exports = { install, sourceOf, record, sameBytes, onCopy };
