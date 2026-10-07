'use strict';
// Serializes packages as package-lock.json (lockfileVersion 3), the format syft's javascript-lock-cataloger reads.
const path = require('path');
const { packagesForFiles } = require('./packages.cjs');

// Keys are the packages' real locations relative to the project, which keeps nested duplicates
// (node_modules/a/node_modules/b), pnpm (.pnpm/...) and Yarn PnP cache paths distinct; syft takes
// the name from the last "node_modules/" segment of the key, so every key must end in node_modules/<name>.
// The root "" entry has no name on purpose: syft only reports it as a package if it has one.
function toPackageLock(pkgs, context) {
  const packages = { '': {} };
  const sorted = [...pkgs].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.path.localeCompare(b.path));
  for (const p of sorted) {
    let key = path.relative(context, p.path).split(path.sep).join('/');
    if (key.split('node_modules/').pop() !== p.name) key = 'node_modules/' + p.name;
    if (packages[key]) key = `node_modules/${key}/node_modules/${p.name}`; // defensive: keep keys unique
    packages[key] = { name: p.name, version: p.version, ...(p.license ? { license: p.license } : {}) };
  }
  return JSON.stringify({ lockfileVersion: 3, requires: true, packages }, null, 2) + '\n';
}

// files: absolute paths of bundled source files; context: project root the keys are relative to.
function lockfileForFiles(files, context) {
  return toPackageLock(packagesForFiles(files), context);
}

module.exports = { toPackageLock, lockfileForFiles };
