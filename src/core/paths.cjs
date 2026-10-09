'use strict';
// Path helpers shared by the core modules and the adapters: directories up to the root, the package directory of a
// file by its path, the export path of a lockfile.
const fs = require('fs');
const path = require('path');
const config = require('./config.cjs');

// A directory and every directory above it, up to the root.
function* ancestors(dir) {
  for (;;) {
    yield dir;
    const up = path.dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}

// A relative path with "/" separators, as the lockfile records paths (the same on every platform).
const posix = (p) => p.split(path.sep).join('/');

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

// The real location of a package directory. Bundlers resolve symlinks by default; with
// resolve.symlinks = false the files keep the symlinked path, e.g. node_modules/@acme/ui for a workspace
// package (-> packages/ui) or node_modules/foo for pnpm (-> node_modules/.pnpm/foo@1/node_modules/foo).
// Paths fs cannot resolve (e.g. Yarn PnP zip paths without the PnP fs patch) stay as they are.
function realRoot(root) {
  let real = root;
  try { real = fs.realpathSync(root); } catch { /* keep root */ }
  return unvirtual(real);
}

// Yarn PnP gives packages with peer dependencies one virtual path per dependent set, and its fs keeps them as
// real paths: <dir>/__virtual__/<name>-virtual-<hash>/<depth>/<subpath> is <dir>/(../ x depth)<subpath>
// (yarn's VirtualFS.resolveVirtual). Resolved, every instance is the one package in the cache.
const VIRTUAL = /^(.*?[\\/](?:__virtual__|\$\$virtual))[\\/][^\\/]+[\\/](\d+)(?:[\\/](.*))?$/;
function unvirtual(p) {
  const m = p.match(VIRTUAL);
  if (!m) return p;
  return unvirtual(path.join(path.dirname(m[1]), '../'.repeat(Number(m[2])), m[3] || '.'));
}

// Where the export copy of the lockfile `target` goes (BUNDLE_LOCKFILE_EXPORT_DIR, or null): the target's path
// mirrored below the export dir - relative to BUNDLE_LOCKFILE_EXPORT_BASE if it is below that, else its absolute
// path without the root (/srv/app/dist/bundle-lockfile/package-lock.json -> <export>/srv/app/dist/bundle-lockfile/
// package-lock.json; Windows: C:\app\... -> <export>/C/app/...). The file name stays package-lock.json, which syft
// requires, and outputs of different builds and processes never collide.
function exportPath(target) {
  if (!config.exportDir) return null;
  const abs = path.resolve(target);
  const rel = config.exportBase && path.relative(config.exportBase, abs);
  const inBase = rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); // also <base>/..cache
  const { root } = path.parse(abs);
  return path.join(config.exportDir, inBase ? rel : path.join(root.replace(/[:\\/]+/g, '') || '.', abs.slice(root.length)));
}

module.exports = { ancestors, posix, packageRoot, realRoot, unvirtual, exportPath };
