'use strict';
// Files another plugin writes into a build's output directory after the build has written its own, e.g.
// vite-plugin-pwa's sw.js and workbox-<hash>.js (workbox-build generates them with Rollup and writes them with fs in
// closeBundle), vite-plugin-static-copy's copies, filemanager-webpack-plugin's copies in webpack's afterEmit: their
// packages, or none. Used by the adapters once the build has landed (rollup.cjs closeBundle, webpack-family.cjs afterEmit).
const fs = require('fs');
const path = require('path');
const config = require('./config.cjs');
const packages = require('./packages.cjs');
const generated = require('./generated.cjs');
const copies = require('./copies.cjs');
const { ancestors, packageRoot, posix } = require('./paths.cjs');

const JS = /\.[cm]?js$/i;
const MAX_SCAN = 20000;           // entries of an output directory looked at
const MAX_LATE = 20 * 1024 * 1024; // larger files are not compared
// what was not checked is said (a warning, once per directory or file): a package it would add may be missing
const warned = new Set();
const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); config.warn(msg); } };

// The package a file copied into the output comes from: one this process copied out of a package with fs (see
// core/copies.cjs), or dist/vendor/node_modules/normalize.css/normalize.css (e.g. vite-plugin-static-copy with a
// node_modules path) is node_modules/normalize.css/normalize.css with the same bytes, looked up like Node does from
// the working directory upwards (the copy may have been made by another process).
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
function filesWrittenAfter(dir, { since, known, skip, cwd, roots = [] }) {
  const found = [];
  for (const r of [cwd, ...roots]) if (r && (dir === r || r.startsWith(dir + path.sep))) return found;
  let seen = 0;
  const walk = (d) => {
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (++seen > MAX_SCAN) return;
      const file = path.join(d, e.name);
      if (e.isDirectory()) { if (file !== skip) walk(file); continue; }
      if (!e.isFile() || known.has(file)) continue;
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < since) continue;
      let pkgs = null;
      if (JS.test(file) && st.size <= MAX_LATE) { try { pkgs = generated.byContent(fs.readFileSync(file)); } catch { /* gone */ } }
      if (!pkgs) pkgs = copiedFrom(file, path.relative(dir, file), cwd);
      if (pkgs) found.push({ file, pkgs });
    }
  };
  walk(dir);
  if (seen > MAX_SCAN) warnOnce(dir, `more than ${MAX_SCAN} entries in ${dir}: the files written there after the build were not all checked for packages`);
  return found;
}

module.exports = { filesWrittenAfter, copiedFrom, MAX_SCAN, MAX_LATE };
