'use strict';
// Maps bundled source files to the npm packages they belong to.
const fs = require('fs');
const path = require('path');
const config = require('./config.cjs');

// Style sheets (CSS, Sass, Less, Stylus, PostCSS): those a style sheet @imports are inlined into it by the bundler's
// CSS handling (Vite's CSS plugin, sass-loader, less-loader, postcss-import, Tailwind) and are no modules of their own
const STYLE = /\.(css|scss|sass|less|styl|stylus|pcss|postcss|sss)$/i;

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
  // a leading byte order mark is valid UTF-8 that JSON.parse rejects; npm strips it too
  try { j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
  if (!j || typeof j.name !== 'string' || !j.name || typeof j.version !== 'string' || !j.version) return null;
  return { name: j.name, version: j.version, path: dir, license: licenseOf(j) };
}

// Bundled code from a package the lockfile cannot list must not go unnoticed. Directories such as
// node_modules/.cache are no packages: tools generate files there, so they are skipped quietly.
const warned = new Set();
function unlisted(root) {
  const msg = `no package.json with name and version in ${root} - its bundled files are not listed`;
  if (path.basename(root).startsWith('.')) { config.debug(msg); return; }
  if (warned.has(root)) return; // once per process, not on every watch rebuild
  warned.add(root);
  config.warn(msg);
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

// A function that gives the package a bundled source file (absolute, query strings allowed) belongs to, or null:
// the package directory below its last node_modules, at its real location; null for files outside node_modules (the
// project itself) and of workspace packages, also when reached through a node_modules symlink - unless this process
// copied the file out of a package and it still has its bytes (core/copies.cjs). Packages are looked up once per
// package directory.
function resolver() {
  const byLinked = new Map(); // package directory as reached -> package | null
  const byReal = new Map();   // real package directory -> package | null
  return (f) => {
    const file = f.split('?')[0];
    if (!path.isAbsolute(file)) return null;
    let linked = packageRoot(file);
    if (!linked) {
      const src = require('./copies.cjs').sourceOf(file);
      if (src) { linked = packageRoot(src); config.debug('a copy of', src, ':', file); }
    }
    if (!linked) return null;
    if (byLinked.has(linked)) return byLinked.get(linked);
    let p = null;
    const root = realRoot(linked);
    if (root !== linked && packageRoot(path.join(root, 'x')) !== root) {
      config.debug('first-party package linked into node_modules:', linked, '->', root, '- skipped');
    } else if (byReal.has(root)) {
      p = byReal.get(root);
    } else {
      p = readPackage(root);
      if (!p) unlisted(root);
      byReal.set(root, p);
    }
    byLinked.set(linked, p);
    return p;
  };
}

// Packages ({ name, version, license, path }) of any number of lists, one per path (the first one).
function unique(...lists) {
  const m = new Map();
  for (const l of lists) for (const p of l) if (!m.has(p.path)) m.set(p.path, p);
  return [...m.values()];
}

// files: absolute paths of source files that ended up in the bundle (query strings allowed). Returns one entry per
// real package directory (see resolver).
function packagesForFiles(files) {
  const of = resolver();
  return unique(Array.from(files, of).filter(Boolean));
}

// The packages of bundled source files (absolute paths, query strings allowed): those the files belong to (see
// resolver) and those inside files another build produced (core/nested.cjs), the former first - a package's own
// package.json over what another build recorded for it. all: each package once; byFile: Map(file -> [packages]) of
// the files (as given) that bring any.
function packagesOfFiles(files) {
  const of = resolver();
  const nested = require('./nested.cjs').nestedByFile(files);
  const own = [], inner = [], byFile = new Map();
  for (const f of files) {
    const p = of(f), n = nested.get(f) || [];
    if (p) own.push(p);
    inner.push(n);
    const pkgs = unique(p ? [p] : [], n);
    if (pkgs.length) byFile.set(f, pkgs);
  }
  return { all: unique(own, ...inner), byFile };
}

module.exports = { STYLE, packageRoot, realRoot, unique, packagesForFiles, packagesOfFiles, unvirtual };
