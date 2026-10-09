'use strict';
// Maps bundled source files to the npm packages they belong to.
const fs = require('fs');
const path = require('path');
const config = require('./config.cjs');
const copies = require('./copies.cjs');
const nested = require('./nested.cjs');
const vendored = require('./vendored.cjs');
const { readPackage, readManifest } = require('./manifest.cjs');
const { packageRoot, realRoot, unvirtual } = require('./paths.cjs');

// Style sheets (CSS, Sass, Less, Stylus, PostCSS): those a style sheet @imports are inlined into it by the bundler's
// CSS handling (Vite's CSS plugin, sass-loader, less-loader, postcss-import, Tailwind) and are no modules of their own
const STYLE = /\.(css|scss|sass|less|styl|stylus|pcss|postcss|sss)$/i;

// Bundled code from a package the lockfile cannot list as itself must not go unnoticed. Directories such as
// node_modules/.cache are no packages: tools generate files there, so they are skipped quietly.
const warned = new Set();
function unlisted(root, container) {
  const msg = `no package.json with name and version in ${root} - its bundled files are ${container ? `listed as ${container.name}@${container.version}, the package around it` : 'not listed'}`;
  if (path.basename(root).startsWith('.')) { config.debug(msg); return; }
  if (warned.has(root)) return; // once per process, not on every watch rebuild
  warned.add(root);
  config.warn(msg);
}

// The real path of a file (symbolic links and Yarn PnP's virtual paths resolved), or the file as it is
const realFile = (file) => { try { return unvirtual(fs.realpathSync(file)); } catch { return unvirtual(file); } };

// A function that gives the package a bundled source file (absolute, query strings allowed) belongs to, or null:
// - in node_modules: the package directory below its last node_modules, at its real location - a package root
//   without a usable package.json counts as the package around it (VS Code's stripped node_modules inside
//   @gitlab/web-ide), and a vendored copy nested in the package counts for its files (see core/vendored.cjs)
// - a file this process copied out of a package that still has its bytes (core/copies.cjs): as that file
// - any other file, and a workspace package reached through a node_modules symlink: first-party (null), unless the
//   build's scope (where, see core/vendored.cjs scope()) finds it in a vendored copy outside node_modules
// Packages are looked up once per package directory.
function resolver(where = null) {
  const byLinked = new Map(); // package directory as reached -> { root: its real location, told: debug message written }
  const byReal = new Map();   // real package directory -> package | null
  const inside = new Map();   // real directory inside a package -> the vendored copy there | null
  const manifests = new Map();
  const manifest = where ? where.manifest : (d) => { if (!manifests.has(d)) manifests.set(d, readManifest(d)); return manifests.get(d); };
  const packageAt = (root) => {
    if (byReal.has(root)) return byReal.get(root);
    let p = readPackage(root);
    if (!p) {
      let container = null;
      for (let c = vendored.containerOf(root); c && !container; c = vendored.containerOf(c)) container = readPackage(realRoot(c));
      unlisted(root, container);
      p = container;
    }
    byReal.set(root, p);
    return p;
  };
  return (f) => {
    const file = f.split('?')[0];
    if (!path.isAbsolute(file)) return null;
    let at = file, linked = packageRoot(file);
    if (!linked) {
      const src = copies.sourceOf(file);
      if (src) { linked = packageRoot(src); at = src; config.debug('a copy of', src, ':', file); }
    }
    if (!linked) return where ? where.ownerOf(realFile(file)) : null;
    if (!byLinked.has(linked)) byLinked.set(linked, { root: realRoot(linked) });
    const entry = byLinked.get(linked), { root } = entry;
    if (root !== linked && packageRoot(path.join(root, 'x')) !== root) {
      if (!entry.told) { entry.told = true; config.debug('first-party package linked into node_modules:', linked, '->', root); }
      return where ? where.ownerOf(path.join(root, path.relative(linked, at))) : null;
    }
    const p = packageAt(root);
    if (!p) return null;
    const dir = path.dirname(path.join(root, path.relative(linked, at)));
    if (!inside.has(dir)) inside.set(dir, vendored.nestedIn(p, p.path, path.join(dir, 'x'), manifest)); // also in the package around a root without one
    return inside.get(dir) || p;
  };
}

// Packages ({ name, version, license, path }) of any number of lists, one per path (the first one).
function unique(...lists) {
  const m = new Map();
  for (const l of lists) for (const p of l) if (!m.has(p.path)) m.set(p.path, p);
  return [...m.values()];
}

// files: absolute paths of source files that ended up in the bundle (query strings allowed); build (optional): the
// build's { context, entries }, for vendored copies outside node_modules (see core/vendored.cjs). Returns one entry
// per real package directory (see resolver).
function packagesForFiles(files, build) {
  const of = resolver(build ? vendored.scope(build) : null);
  return unique(Array.from(files, of).filter(Boolean));
}

// The packages of bundled source files (absolute paths, query strings allowed): those the files belong to (see
// resolver) and those inside files another build produced (core/nested.cjs), the former first - a package's own
// package.json over what another build recorded for it. A file another build produced is that build's output, no
// vendored copy. build (optional): see packagesForFiles. all: each package once; byFile: Map(file -> [packages]) of
// the files (as given) that bring any.
function packagesOfFiles(files, build) {
  const of = resolver(build ? vendored.scope(build) : null);
  const nestedOf = nested.nestedByFile(files);
  const own = [], inner = [], byFile = new Map();
  for (const f of files) {
    const p = nestedOf.has(f) ? null : of(f), n = nestedOf.get(f) || [];
    if (p) own.push(p);
    inner.push(n);
    const pkgs = unique(p ? [p] : [], n);
    if (pkgs.length) byFile.set(f, pkgs);
  }
  return { all: unique(own, ...inner), byFile };
}

module.exports = { STYLE, unique, packagesForFiles, packagesOfFiles };
