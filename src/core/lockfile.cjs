'use strict';
// Serializes packages as package-lock.json (lockfileVersion 3), the format syft's javascript-lock-cataloger reads.
const fs = require('fs');
const path = require('path');
const { packagesForFiles } = require('./packages.cjs');

// Code-unit order, not localeCompare: the output must not depend on the build machine's locale
// (with LC_ALL=da_DK.UTF-8, "aa-utils" sorts after "zod").
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A package's location relative to the context, like npm writes it: node_modules/a, nested duplicates as
// node_modules/a/node_modules/b, pnpm's node_modules/.pnpm/..., Yarn PnP's .yarn/cache/<zip>/node_modules/...,
// and ../node_modules/c for a context below the project root. null for a location outside the context that
// is not in an ancestor's node_modules either (Yarn's global cache, a shared store): that path differs
// between machines and must not end up in the lockfile.
function locationKey(base, dir) {
  const rel = path.relative(base, dir).split(path.sep).join('/');
  if (path.isAbsolute(rel)) return null; // another drive
  const down = rel.replace(/^(\.\.\/)+/, '');
  if (down !== rel && !down.startsWith('node_modules/')) return null;
  return /(^|\/)node_modules\/[^/.]/.test(down) ? rel : null; // also null for '' and '..' (a context inside the package)
}

// Every entry carries "name", so aliases (node_modules/ms-old = ms@2.0.0) work: syft takes the name field
// over the key, as for npm's own lockfiles.
// The root "" entry has no name on purpose: syft only reports it as a package if it has one.
function toPackageLock(pkgs, context) {
  const packages = { '': {} };
  let base = context;
  try { base = fs.realpathSync(context); } catch { /* keep context */ } // package paths are real paths
  const sorted = [...pkgs].sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version) || cmp(a.path, b.path));
  const keyed = sorted.map(p => [p, locationKey(base, p.path)]);
  const taken = new Set(keyed.map(([, k]) => k).filter(Boolean)); // real locations are unique per package
  for (const [p, location] of keyed) {
    let key = location;
    if (!key) { // node_modules/<name>, else node_modules/<name>@<version>, else node_modules/<name>@<version>-2, ...
      const candidates = (n) => (n === 0 ? `node_modules/${p.name}` : `node_modules/${p.name}@${p.version}${n > 1 ? `-${n}` : ''}`);
      let n = 0;
      while (taken.has(candidates(n))) n++;
      key = candidates(n);
      taken.add(key);
    }
    packages[key] = { name: p.name, version: p.version, ...(p.license ? { license: p.license } : {}) };
  }
  return JSON.stringify({ lockfileVersion: 3, requires: true, packages }, null, 2) + '\n';
}

// files: absolute paths of bundled source files; context: project root the keys are relative to.
function lockfileForFiles(files, context) {
  return toPackageLock(packagesForFiles(files), context);
}

module.exports = { cmp, toPackageLock, lockfileForFiles };
