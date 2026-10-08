'use strict';
// Files copied out of a package: a tool that copies a package's files somewhere else and bundles or ships the copy
// hides where they come from. @sveltejs/adapter-node 5 copies its own files/ into .svelte-kit/adapter-node/entries and
// bundles them from there (so that node_modules resolve from the project); copy plugins put a package's file into the
// output under another name. fs's copy functions are wrapped to remember, in this process, destination -> source for
// copies from a package directory to outside of node_modules; sourceOf() gives the source of a file that still has
// the source's bytes. fs.copyFile* and fs.cp* only: a copy made with readFile + writeFile is not seen.
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const S = Symbol.for('bundle-lockfile.copies.v1');
const MAX = 50000; // entries; a long-running process must not grow them forever
// files: destination file -> source file; dirs: destination dir -> source dir (fs.cp of a directory)
const state = globalThis[S] || (globalThis[S] = { files: new Map(), dirs: new Map(), installed: false });

const inPackage = (p) => p.split(path.sep).includes('node_modules');

function abs(p) {
  try {
    if (p instanceof URL) return path.resolve(fileURLToPath(p));
    if (Buffer.isBuffer(p)) return path.resolve(p.toString());
    return typeof p === 'string' ? path.resolve(p) : null;
  } catch { return null; }
}

function put(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX) map.delete(map.keys().next().value);
}

function record(src, dest, dir) {
  const s = abs(src), d = abs(dest);
  if (!s || !d || !inPackage(s) || inPackage(d)) return;
  put(dir ? state.dirs : state.files, d, s);
}

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
  for (let dir = path.dirname(f); ; dir = path.dirname(dir)) {
    const src = state.dirs.get(dir);
    if (src) { const s = path.join(src, path.relative(dir, f)); return sameBytes(f, s) ? s : null; }
    if (path.dirname(dir) === dir) return null;
  }
}

// Wraps fs.copyFile, fs.copyFileSync, fs.cp, fs.cpSync and their fs.promises versions (also what fs-extra and
// graceful-fs call: they take them from fs). Recording never makes a copy fail.
function install() {
  if (state.installed) return;
  state.installed = true;
  const wrap = (obj, name, dirAware) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    const wrapped = function (src, dest, ...rest) {
      try {
        let dir = false;
        if (dirAware) { try { dir = fs.statSync(src).isDirectory(); } catch { /* the copy reports it */ } }
        record(src, dest, dir);
      } catch { /* never in the way */ }
      return orig.call(this, src, dest, ...rest);
    };
    Object.defineProperty(wrapped, 'name', { value: orig.name });
    obj[name] = wrapped;
  };
  wrap(fs, 'copyFile'); wrap(fs, 'copyFileSync'); wrap(fs, 'cp', true); wrap(fs, 'cpSync', true);
  wrap(fs.promises, 'copyFile'); wrap(fs.promises, 'cp', true);
  try { require('module').syncBuiltinESMExports(); } catch { /* named ESM imports keep the originals */ }
}

module.exports = { install, sourceOf, record };
