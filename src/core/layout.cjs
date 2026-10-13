'use strict';
// Package directories that are not node_modules/<name>: Yarn's pnpm linker (nodeLinker: pnpm) puts every package into
// node_modules/.store/<slug>/package/ and links node_modules/<name> to it - the package's files are below
// .store/<slug>/package/, which bundlers and Node.js see (they resolve links). No dependencies of its own: the ESM loader
// thread uses it too (esm-wrap.cjs).
const fs = require('fs');
const path = require('path');

// .../node_modules/.store/<slug>/package (the last one in a path), either separator
const STORE = /([\\/])node_modules\1\.store\1[^\\/]+\1package(?=[\\/]|$)/g;

// The index in `parts` (a path split at its separator) of the last directory of a package root in Yarn's store
// (.store/<slug>/package below the last node_modules), or -1
function storeRoot(parts) {
  const i = parts.lastIndexOf('node_modules');
  return i >= 0 && parts[i + 1] === '.store' && parts[i + 2] && parts[i + 3] === 'package' ? i + 3 : -1;
}

const names = new Map(); // package directory in the store -> its name, or null
// The file's path as if every package in Yarn's store were at node_modules/<name> (its package.json's name):
// /p/node_modules/.store/rollup-npm-4.64.2-36b8bf9eab/package/dist/es/rollup.js -> /p/node_modules/rollup/dist/es/rollup.js.
// What adapters recognize bundler files by (their paths in a package). Other paths as they are.
function logical(file) {
  if (typeof file !== 'string' || !file.includes('.store')) return file;
  let out = file, m;
  STORE.lastIndex = 0;
  const found = [];
  while ((m = STORE.exec(file))) found.push(m);
  for (const hit of found.reverse()) { // from the end: the indices before it stay valid
    const dir = file.slice(0, hit.index + hit[0].length);
    if (!names.has(dir)) {
      let name = null;
      try { const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); if (typeof j.name === 'string' && j.name) name = j.name; } catch { /* none */ }
      names.set(dir, name);
    }
    const name = names.get(dir);
    if (!name) continue;
    const sep = hit[1];
    out = `${out.slice(0, hit.index)}${sep}node_modules${sep}${name.split('/').join(sep)}${out.slice(hit.index + hit[0].length)}`;
  }
  return out;
}

module.exports = { storeRoot, logical };
