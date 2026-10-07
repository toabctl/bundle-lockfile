'use strict';
// Serializes packages as package-lock.json (lockfileVersion 3), the format syft's javascript-lock-cataloger reads.
const fs = require('fs');
const path = require('path');
const { packagesForFiles } = require('./packages.cjs');

// Code-unit order, not localeCompare: the output must not depend on the build machine's locale
// (with LC_ALL=da_DK.UTF-8, "aa-utils" sorts after "zod").
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Keys are the packages' real locations relative to the project, like npm writes them: that keeps nested
// duplicates (node_modules/a/node_modules/b), pnpm (.pnpm/...) and Yarn PnP cache paths distinct.
// Every entry carries "name", so aliases (node_modules/ms-old = ms@2.0.0) work: syft takes the name field
// over the key, as for npm's own lockfiles.
// The root "" entry has no name on purpose: syft only reports it as a package if it has one.
function toPackageLock(pkgs, context) {
  const packages = { '': {} };
  let base = context;
  try { base = fs.realpathSync(context); } catch { /* keep context */ } // package paths are real paths
  const sorted = [...pkgs].sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version) || cmp(a.path, b.path));
  for (const p of sorted) {
    let key = path.relative(base, p.path).split(path.sep).join('/');
    if (!key.includes('node_modules/')) key = `node_modules/${p.name}`; // defensive; bundled packages live under node_modules
    if (packages[key]) key = `${key}@${p.version}`;                      // defensive; paths are unique per package
    packages[key] = { name: p.name, version: p.version, ...(p.license ? { license: p.license } : {}) };
  }
  return JSON.stringify({ lockfileVersion: 3, requires: true, packages }, null, 2) + '\n';
}

// files: absolute paths of bundled source files; context: project root the keys are relative to.
function lockfileForFiles(files, context) {
  return toPackageLock(packagesForFiles(files), context);
}

module.exports = { toPackageLock, lockfileForFiles };
