'use strict';
// Packages inside bundled files that another build produced: e.g. GitLab's Vite-built island (dist/main.js, with
// Vue inlined) that webpack bundles as a first-party file. The inner build recorded, in its lockfile next to its
// output, the sha256 of each JavaScript and CSS file it wrote and the packages in each (see toPackageLock's "outputs"
// and "contents"); a bundled file that is not in node_modules and has the bytes recorded by the nearest such lockfile
// above it brings the packages in it.
// Works across processes, separate commands and machines (the record travels with the output) and for the export
// copy (BUNDLE_LOCKFILE_EXPORT_DIR) when the inline lockfile is off. A file changed after it was built does not match.
// A first-party package linked into node_modules (a workspace package that another build wrote, e.g. a library built
// by Vite) is looked at where it really is, also when the bundler reached it through the link (webpack's
// resolve.symlinks: false, Vite's resolve.preserveSymlinks).
const fs = require('fs');
const path = require('path');
const config = require('./config.cjs');
const { readMeta } = require('./lockfile.cjs');
const { packageRoot, realRoot } = require('./packages.cjs');
const { hashOf } = require('./hashes.cjs');

const S = Symbol.for('bundle-lockfile.nested.v1');
const state = globalThis[S] || (globalThis[S] = { metas: new Map() }); // dir -> meta | null

// The lockfile meta (readMeta) of the build whose output dir is `dir`, or null.
function metaOf(dir) {
  if (state.metas.has(dir)) return state.metas.get(dir);
  let meta = null;
  const target = path.join(dir, config.file);
  const exp = require('./outputs.cjs').exportPath(target);
  for (const f of exp ? [target, exp] : [target]) {
    try { meta = readMeta(fs.readFileSync(f, 'utf8'), path.dirname(target)); } catch { meta = null; }
    if (meta && meta.writers.some(w => Object.keys(w.outputs).length)) break;
    meta = null;
  }
  state.metas.set(dir, meta);
  return meta;
}

// The real path of a bundled file that is no file of a package: the file itself outside node_modules, the file in
// the package's real directory for a first-party package linked into node_modules (as packagesForFiles tells them
// apart); null for a file of a package. roots: package root -> real directory of a linked first-party package, or null.
function ownFile(file, roots) {
  const root = packageRoot(file);
  if (!root) return file;
  if (!roots.has(root)) {
    const real = realRoot(root);
    roots.set(root, real !== root && packageRoot(path.join(real, 'x')) !== real ? real : null);
  }
  const real = roots.get(root);
  return real && path.join(real, path.relative(root, file));
}

// files: absolute paths of bundled source files. Returns Map(file -> [packages]) ({ name, version, license, path }) of
// the ones another build produced: the packages that build recorded for that file, or - recorded by a version without
// them - all packages of its output.
function nestedByFile(files) {
  state.metas.clear(); // lockfiles change between builds (watch mode)
  const out = new Map();
  const roots = new Map();
  for (const f of files) {
    const bundled = typeof f === 'string' ? f.split('?')[0] : null;
    const file = bundled && path.isAbsolute(bundled) && ownFile(bundled, roots);
    if (!file) continue;
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
      const meta = metaOf(dir);
      const writer = meta && meta.writers.find(w => w.outputs[file]);
      if (writer) {
        if (writer.outputs[file] === hashOf(file)) out.set(f, writer.contents[file] || writer.pkgs);
        else config.debug('built by another build, but changed since:', file);
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
  }
  return out;
}

// The packages of nestedByFile, once each.
function nestedPackages(files) {
  const out = new Map();
  for (const pkgs of nestedByFile(files).values()) for (const p of pkgs) out.set(p.path, p);
  return [...out.values()];
}

module.exports = { nestedPackages, nestedByFile };
