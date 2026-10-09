'use strict';
// Maps bundled source files to the npm packages they belong to.
const path = require('path');
const config = require('./config.cjs');
const copies = require('./copies.cjs');
const nested = require('./nested.cjs');
const { readPackage } = require('./manifest.cjs');
const { packageRoot, realRoot } = require('./paths.cjs');

// Style sheets (CSS, Sass, Less, Stylus, PostCSS): those a style sheet @imports are inlined into it by the bundler's
// CSS handling (Vite's CSS plugin, sass-loader, less-loader, postcss-import, Tailwind) and are no modules of their own
const STYLE = /\.(css|scss|sass|less|styl|stylus|pcss|postcss|sss)$/i;

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
      const src = copies.sourceOf(file);
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
  const nestedOf = nested.nestedByFile(files);
  const own = [], inner = [], byFile = new Map();
  for (const f of files) {
    const p = of(f), n = nestedOf.get(f) || [];
    if (p) own.push(p);
    inner.push(n);
    const pkgs = unique(p ? [p] : [], n);
    if (pkgs.length) byFile.set(f, pkgs);
  }
  return { all: unique(own, ...inner), byFile };
}

module.exports = { STYLE, unique, packagesForFiles, packagesOfFiles };
