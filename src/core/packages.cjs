'use strict';
// Maps bundled source files to the npm packages they belong to.
const fs = require('fs');
const path = require('path');
const config = require('./config.cjs');

// The package a file belongs to is the directory directly below its LAST node_modules segment:
// node_modules/<name> or node_modules/@scope/<name>. That is how npm, yarn (incl. PnP zip paths
// .../x.zip/node_modules/<name>) and pnpm (.pnpm/<id>/node_modules/<name>) lay packages out, and it
// ignores package.json files inside a package - e.g. dist/esm/package.json = {"type":"module"} or
// preact/hooks/package.json = {"name": "preact-hooks", ...}, which are not packages.
function packageRoot(file) {
  const parts = file.split(path.sep);
  const i = parts.lastIndexOf('node_modules');
  if (i < 0) return null;
  const n = parts[i + 1] && parts[i + 1].startsWith('@') ? 2 : 1;
  if (i + n >= parts.length - 1) return null; // the file must be inside the package directory
  return parts.slice(0, i + 1 + n).join(path.sep);
}

function readPackage(dir) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
  if (typeof j.name !== 'string' || typeof j.version !== 'string') return null;
  const license = typeof j.license === 'string' ? j.license
    : Array.isArray(j.licenses) ? j.licenses.map(l => (l && l.type) || l).filter(x => typeof x === 'string') : undefined;
  return { name: j.name, version: j.version, path: dir, license };
}

// files: absolute paths of source files that ended up in the bundle (query strings allowed).
// Returns one entry per package directory; files outside node_modules (the project itself,
// workspace packages) are ignored.
function packagesForFiles(files) {
  const pkgs = new Map();
  const seen = new Set();
  for (const f of files) {
    const file = f.split('?')[0];
    if (!path.isAbsolute(file)) continue;
    const root = packageRoot(file);
    if (!root || seen.has(root)) continue;
    seen.add(root);
    const p = readPackage(root);
    if (p) pkgs.set(root, p);
    else config.debug('no name/version in', path.join(root, 'package.json'), '- skipped');
  }
  return [...pkgs.values()];
}

module.exports = { packageRoot, packagesForFiles };
