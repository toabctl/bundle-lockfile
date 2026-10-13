'use strict';
// Path helpers shared by the core modules and the adapters: directories up to the root, the package directory of a
// file by its path, the export path of a lockfile.
const fs = require('fs');
const path = require('path');
const config = require('./config.cjs');
const { storeRoot, logical } = require('./layout.cjs');

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
// preact/hooks/package.json = {"name": "preact-hooks", ...}, which are not packages. Yarn's pnpm linker:
// node_modules/.store/<slug>/package (see core/layout.cjs).
function packageRoot(file) {
  const parts = file.split(path.sep);
  const s = storeRoot(parts);
  if (s >= 0) return s < parts.length - 1 ? parts.slice(0, s + 1).join(path.sep) : null;
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
// (yarn's VirtualFS.resolveVirtual). Resolved, every instance is the one package in the cache. Only Yarn's virtual
// folder (.yarn/__virtual__, in the project), never a directory of that name in a package: a package's own
// __virtual__/x/2/node_modules/react would put its files onto the project's react. A depth beyond the root ends there.
const VIRTUAL = /^(.*?[\\/](?:__virtual__|\$\$virtual))[\\/][^\\/]+[\\/](\d+)(?:[\\/](.*))?$/;
function unvirtual(p) {
  const m = p.match(VIRTUAL);
  if (!m) return p;
  const above = path.dirname(m[1]).split(/[\\/]/).filter(Boolean);
  if (above.includes('node_modules')) return p;
  return unvirtual(path.join(path.dirname(m[1]), '../'.repeat(Math.min(Number(m[2]), above.length)), m[3] || '.'));
}

// An option value as a writer id records it (core/outputs.cjs: the same on every machine): an absolute path in a package
// as from its last node_modules (node_modules/pkg/x.js - Yarn's global cache, pnpm's global store and a store layout
// as node_modules/<name>, see core/layout.cjs), any other absolute path relative to base, other values as they are.
function portable(base, v) {
  if (typeof v !== 'string' || !path.isAbsolute(v)) return v;
  const parts = logical(unvirtual(v)).split(path.sep);
  const i = parts.lastIndexOf('node_modules');
  if (i >= 0 && i < parts.length - 1) return parts.slice(i).join('/');
  return base ? posix(path.relative(base, v)) : v;
}

// Where the export copy of the lockfile `target` goes (BUNDLE_LOCKFILE_EXPORT_DIR, or null): the target's path
// mirrored below the export dir. Without BUNDLE_LOCKFILE_EXPORT_BASE: its absolute path without the root
// (/srv/app/dist/bundle-lockfile/package-lock.json -> <export>/srv/app/dist/bundle-lockfile/package-lock.json; Windows:
// C:\app\... -> <export>/C/app/...). With it: relative to the base if it is below it (also through symbolic links: the
// base and the target are compared as given and by their real paths), else the absolute path below <export>/_outside_base/,
// so that no target outside the base lands where one inside it does (/w/tmp/dist and /tmp/dist with the base /w). The
// file name stays package-lock.json, which syft requires.
const OUTSIDE_BASE = '_outside_base';
function exportPath(target) {
  if (!config.exportDir) return null;
  const abs = path.resolve(target);
  if (!config.exportBase) return path.join(config.exportDir, mirrored(abs));
  const rel = below(config.exportBase, abs) || below(realish(config.exportBase), realish(abs));
  return rel ? path.join(config.exportDir, rel) : path.join(config.exportDir, OUTSIDE_BASE, mirrored(abs));
}
// an absolute path as a relative one: without its root, a drive letter as a directory
function mirrored(abs) {
  const { root } = path.parse(abs);
  return path.join(root.replace(/[:\\/]+/g, '') || '.', abs.slice(root.length));
}
// p relative to dir if it is below it (also <dir>/..cache), else null
function below(dir, p) {
  const rel = path.relative(dir, p);
  return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : null;
}
// the real path of p, as far as it exists (a lockfile's directory may not be there yet)
function realish(p) {
  const rest = [];
  for (let d = p; ; d = path.dirname(d)) {
    try { return path.join(fs.realpathSync(d), ...rest.reverse()); } catch { /* not there */ }
    if (path.dirname(d) === d) return p;
    rest.push(path.basename(d));
  }
}

module.exports = { ancestors, posix, packageRoot, realRoot, unvirtual, portable, exportPath, OUTSIDE_BASE };
