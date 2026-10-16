'use strict';
// Path helpers shared by the core modules and the adapters: directories up to the root, a path inside another, real
// paths, the package directory of a file by its path, the export path of a lockfile, output files by their names.
const fs = require('fs');
const path = require('path');
const config = require('./config.cjs');
const { storeRoot, logical } = require('./layout.cjs');

// A directory and every directory above it, up to the root.
/** @param {string} dir @returns {Generator<string, void, unknown>} */
function* ancestors(dir) {
  for (;;) {
    yield dir;
    const up = path.dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}

// A relative path with "/" separators, as the lockfile records paths (the same on every platform).
const posix = (/** @type {string} */ p) => p.split(path.sep).join('/');

// p is dir or a path inside it
/** @type {(dir: string, p: string) => boolean} */
const within = (dir, p) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

// The real path of p (symbolic links resolved), or p as it is if it cannot be resolved (not there)
/** @type {(p: string) => string} */
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

// A file path that may end with a fragment ("#..."), as module ids and metafile keys have them: a "#" in the last part
// of the path is a fragment only if the file with it is not there (directories and files can have one: ~/c#/app).
/** @param {string} f @returns {string} */
function withoutFragment(f) {
  const hash = f.lastIndexOf('#');
  return hash > Math.max(f.lastIndexOf('/'), f.lastIndexOf('\\')) && !fs.existsSync(f) ? f.slice(0, hash) : f;
}

// Output files by their names: JavaScript; JavaScript and CSS, the files another build may bundle (core/nested.cjs)
const JS = /\.[cm]?js$/i;
const JS_CSS = /\.([cm]?js|css)$/i;

// The package a file belongs to is the directory directly below its LAST node_modules segment:
// node_modules/<name> or node_modules/@scope/<name>. That is how npm, yarn (incl. PnP zip paths
// .../x.zip/node_modules/<name>) and pnpm (.pnpm/<id>/node_modules/<name>) lay packages out, and it
// ignores package.json files inside a package - e.g. dist/esm/package.json = {"type":"module"} or
// preact/hooks/package.json = {"name": "preact-hooks", ...}, which are not packages. Yarn's pnpm linker:
// node_modules/.store/<slug>/package (see core/layout.cjs). No package's name starts with a dot: a directory such as
// node_modules/.cache, .vite or .prisma holds what tools generate there - no package, but files as outside
// node_modules (a nested build's output below node_modules/.cache is found by its lockfile, see core/nested.cjs).
/** @param {string} file @returns {string | null} */
function packageRoot(file) {
  const parts = file.split(path.sep);
  const s = storeRoot(parts);
  if (s >= 0) return s < parts.length - 1 ? parts.slice(0, s + 1).join(path.sep) : null;
  const i = parts.lastIndexOf('node_modules');
  if (i < 0 || (parts[i + 1] || '').startsWith('.')) return null;
  const n = parts[i + 1] && parts[i + 1].startsWith('@') ? 2 : 1;
  if (i + n >= parts.length - 1) return null; // the file must be inside the package directory
  return parts.slice(0, i + 1 + n).join(path.sep);
}

// The real location of a package directory. Bundlers resolve symlinks by default; with
// resolve.symlinks = false the files keep the symlinked path, e.g. node_modules/@acme/ui for a workspace
// package (-> packages/ui) or node_modules/foo for pnpm (-> node_modules/.pnpm/foo@1/node_modules/foo).
// Paths fs cannot resolve (e.g. Yarn PnP zip paths without the PnP fs patch) stay as they are.
/** @param {string} root @returns {string} */
const realRoot = (root) => unvirtual(real(root));

// Yarn PnP gives packages with peer dependencies one virtual path per dependent set, and its fs keeps them as
// real paths: <dir>/__virtual__/<name>-virtual-<hash>/<depth>/<subpath> is <dir>/(../ x depth)<subpath>
// (yarn's VirtualFS.resolveVirtual). Resolved, every instance is the one package in the cache. Only Yarn's virtual
// folder (.yarn/__virtual__, in the project), never a directory of that name in a package: a package's own
// __virtual__/x/2/node_modules/react would put its files onto the project's react. A depth beyond the root ends there.
const VIRTUAL = /^(.*?[\\/](?:__virtual__|\$\$virtual))[\\/][^\\/]+[\\/](\d+)(?:[\\/](.*))?$/;
/** @param {string} p @returns {string} */
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
/**
 * @template T
 * @param {string | null | undefined} base
 * @param {T} v
 * @returns {T | string}
 */
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
/** @param {string} target @returns {string | null} */
function exportPath(target) {
  if (!config.exportDir) return null;
  const abs = path.resolve(target);
  if (!config.exportBase) return path.join(config.exportDir, mirrored(abs));
  const rel = below(config.exportBase, abs) || below(realish(config.exportBase), realish(abs));
  return rel ? path.join(config.exportDir, rel) : path.join(config.exportDir, OUTSIDE_BASE, mirrored(abs));
}
// an absolute path as a relative one: without its root, a drive letter as a directory
/** @param {string} abs */
function mirrored(abs) {
  const { root } = path.parse(abs);
  return path.join(root.replace(/[:\\/]+/g, '') || '.', abs.slice(root.length));
}
// p relative to dir if it is below it (also <dir>/..cache), else null
/** @param {string} dir @param {string} p */
function below(dir, p) {
  const rel = path.relative(dir, p);
  return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : null;
}
// The real path of p (absolute), also of one that is not there (yet): of its nearest ancestor that is, and the rest as it
// is (a lockfile's directory, a copy's destination)
/** @param {string} p @returns {string} */
function realish(p) {
  /** @type {string[]} */
  const rest = [];
  for (let d = path.resolve(p); ; d = path.dirname(d)) {
    try { return path.join(fs.realpathSync(d), ...rest.reverse()); } catch { /* not there */ }
    if (path.dirname(d) === d) return path.resolve(p);
    rest.push(path.basename(d));
  }
}

// An output directory below node_modules is a tool's cache (Vite's dependency pre-bundling in node_modules/.vite, a
// library's own build): no output of the project's - except below node_modules/.cache/, where tools build what ships
// (`nuxi build` into node_modules/.cache/nuxt/.nuxt, which Nitro copies into .output/public). Every adapter decides by
// this, so that a bundler choice does not decide whether a lockfile is written.
/** @param {string} dir */
function inToolCache(dir) {
  const parts = path.resolve(dir).split(path.sep);
  const i = parts.lastIndexOf('node_modules');
  return i >= 0 && parts[i + 1] !== '.cache';
}

module.exports = {
  ancestors, posix, within, real, withoutFragment, JS, JS_CSS, packageRoot, realRoot, unvirtual, portable, exportPath, inToolCache, realish, OUTSIDE_BASE,
};
