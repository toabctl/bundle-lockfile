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

// "license": "MIT", the legacy {"type": "MIT"} or "licenses": [{"type": "MIT"}, "ISC"]
function licenseOf(j) {
  const one = (l) => (typeof l === 'string' ? l : l && typeof l.type === 'string' ? l.type : undefined);
  if (j.license !== undefined) return one(j.license);
  if (!Array.isArray(j.licenses)) return undefined;
  const all = j.licenses.map(one).filter(Boolean);
  return all.length ? all : undefined;
}

function readPackage(dir) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
  if (!j || typeof j.name !== 'string' || typeof j.version !== 'string') return null;
  return { name: j.name, version: j.version, path: dir, license: licenseOf(j) };
}

// The real location of a package directory. Bundlers resolve symlinks by default; with
// resolve.symlinks = false the files keep the symlinked path, e.g. node_modules/@acme/ui for a workspace
// package (-> packages/ui) or node_modules/foo for pnpm (-> node_modules/.pnpm/foo@1/node_modules/foo).
// Paths fs cannot resolve (e.g. Yarn PnP zip paths without the PnP fs patch) stay as they are.
function realRoot(root) {
  try { return fs.realpathSync(root); } catch { return root; }
}

// files: absolute paths of source files that ended up in the bundle (query strings allowed).
// Returns one entry per real package directory; files outside node_modules (the project itself,
// workspace packages, also when reached through a node_modules symlink) are ignored.
function packagesForFiles(files) {
  const pkgs = new Map();
  const seen = new Set();
  for (const f of files) {
    const file = f.split('?')[0];
    if (!path.isAbsolute(file)) continue;
    const linked = packageRoot(file);
    if (!linked || seen.has(linked)) continue;
    seen.add(linked);
    const root = realRoot(linked);
    if (root !== linked && packageRoot(path.join(root, 'x')) !== root) {
      config.debug('first-party package linked into node_modules:', linked, '->', root, '- skipped');
      continue;
    }
    if (pkgs.has(root)) continue;
    const p = readPackage(root);
    if (p) pkgs.set(root, p);
    else config.debug('no name/version in', path.join(root, 'package.json'), '- skipped');
  }
  return [...pkgs.values()];
}

module.exports = { packageRoot, packagesForFiles };
