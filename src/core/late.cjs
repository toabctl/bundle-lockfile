'use strict';
// Files another plugin writes into a build's output directory after the build has written its own, e.g.
// vite-plugin-pwa's sw.js and workbox-<hash>.js (workbox-build generates them with Rollup and writes them with fs in
// closeBundle), vite-plugin-static-copy's copies, filemanager-webpack-plugin's copies in webpack's afterEmit: their
// packages, or none. Used by the adapters once the build has landed (rollup.cjs closeBundle, webpack-family.cjs afterEmit).
/** @import { LateFile, Package } from '../types' */
const fs = require('fs');
const path = require('path');
const config = require('./config.cjs');
const packages = require('./packages.cjs');
const generated = require('./generated.cjs');
const { inTree } = require('./tree.cjs');
const copies = require('./copies.cjs');
const lru = require('./lru.cjs');
const { ancestors, packageRoot, posix, within, JS } = require('./paths.cjs');

const MAX_SCAN = 20000;           // entries of an output directory looked at
const MAX_LATE = 20 * 1024 * 1024; // larger files are not compared
// what was not checked is said (a warning, once per directory or file): a package it would add may be missing
/** @type {Set<string>} */
const warned = new Set();
/** @type {(key: string, msg: string) => void} */
const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); config.warn(msg); } };
// the late files found in this process (watch rebuilds): file -> its size and time then, and its packages
/** @type {Map<string, { mtimeMs: number, size: number, pkgs: Package[] }>} */
const earlier = new Map();
const MAX_EARLIER = 20000;

// The package a file copied into the output comes from: one this process copied out of a package with fs (see
// core/copies.cjs), or dist/vendor/node_modules/normalize.css/normalize.css (e.g. vite-plugin-static-copy with a
// node_modules path) is node_modules/normalize.css/normalize.css with the same bytes, looked up like Node does from
// the working directory upwards (the copy may have been made by another process).
/**
 * @param {string} file
 * @param {string} rel
 * @param {string} cwd
 * @returns {Package[] | null}
 */
function copiedFrom(file, rel, cwd) {
  const copy = copies.sourceOf(file);
  if (copy) { const pkgs = packages.packagesForFiles([copy]); if (pkgs.length) return pkgs; }
  if (!packageRoot(rel)) return null;
  const parts = rel.split(path.sep);
  const sub = parts.slice(parts.lastIndexOf('node_modules') + 1).join(path.sep);
  try {
    if (fs.statSync(file).size > MAX_LATE) {
      warnOnce(file, `${file} is larger than ${MAX_LATE / 1024 / 1024} MiB: not compared with node_modules/${posix(sub)}, whose package it may be a copy of`);
      return null;
    }
  } catch { return null; }
  for (const dir of ancestors(cwd)) {
    const src = path.join(dir, 'node_modules', sub);
    if (copies.sameBytes(src, file)) { const pkgs = packages.packagesForFiles([src]); if (pkgs.length) return pkgs; }
  }
  return null;
}

// The files in `dir` changed since `since` (ms) that are none of `known` (the build's own files, and those of the other
// writers of this process there) and not below `skip` (the lockfile's directory), with the packages each brings:
// [{ file, pkgs }]. A JavaScript file with the content of a generate-only build's chunk (core/generated.cjs) brings its
// packages; any file copied out of a package (copiedFrom) that package. Nothing if dir is the working directory or above
// it (it would be the whole project), or one of `roots` (the build's context).
/**
 * @param {string} dir
 * @param {{ since: number, known: Set<string>, skip: string, cwd: string, roots?: string[] }} opts
 * @returns {LateFile[]}
 */
function filesWrittenAfter(dir, { since, known, skip, cwd, roots = [] }) {
  /** @type {LateFile[]} */
  const found = [];
  for (const r of [cwd, ...roots]) if (r && within(dir, r)) return found;
  let seen = 0;
  /** @param {string} d */
  const walk = (d) => {
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (++seen > MAX_SCAN) return;
      const file = path.join(d, e.name);
      if (e.isDirectory()) { if (file !== skip) walk(file); continue; }
      if (!e.isFile() || known.has(file) || inTree(file)) continue; // (a copied lockfile's package.json tree: no package's)
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      /** @type {Package[] | null} */
      let pkgs = null;
      if (st.mtimeMs < since) {
        // older than the build: a copy this process made with fs (also one that kept its source's time, fs.cp's
        // preserveTimestamps), or a late file of an earlier build of this process still as it was then (a plugin that
        // copies once in watch mode: its file still ships, with its packages)
        const before = earlier.get(file);
        if (before && before.mtimeMs === st.mtimeMs && before.size === st.size) pkgs = before.pkgs;
        else { const src = copies.sourceOf(file); if (src) pkgs = packages.packagesForFiles([src]); }
        if (!pkgs || !pkgs.length) continue;
      } else {
        if (JS.test(file) && st.size <= MAX_LATE) { try { pkgs = generated.byContent(fs.readFileSync(file)); } catch { /* gone */ } }
        if (!pkgs) pkgs = copiedFrom(file, path.relative(dir, file), cwd);
      }
      if (pkgs) { found.push({ file, pkgs }); lru.set(earlier, file, { mtimeMs: st.mtimeMs, size: st.size, pkgs }, MAX_EARLIER); }
    }
  };
  walk(dir);
  if (seen > MAX_SCAN) warnOnce(dir, `more than ${MAX_SCAN} entries in ${dir}: the files written there after the build were not all checked for packages`);
  return found;
}

module.exports = { filesWrittenAfter, copiedFrom, MAX_SCAN, MAX_LATE };
