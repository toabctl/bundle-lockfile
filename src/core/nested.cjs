'use strict';
// Packages inside bundled files that another build produced: e.g. GitLab's Vite-built island (dist/main.js, with
// Vue inlined) that webpack bundles as a first-party file. The inner build recorded, in its lockfile next to its
// output, the sha256 of each JavaScript and CSS file it wrote and the packages in each (see toPackageLock's "outputs"
// and "contents"); a bundled file that is not in node_modules and has the bytes recorded by the nearest such lockfile
// above it brings the packages in it. A writer that records no hashes (webpack, rspack, Angular: its files only) brings
// all its packages for a JavaScript or CSS file among its files.
// Works across processes, separate commands and machines (the record travels with the output) and for the export
// copy (BUNDLE_LOCKFILE_EXPORT_DIR) when the inline lockfile is off. A file at a path the record has whose bytes changed
// after it was built (post-processed, minified again) still brings that build's packages, with a warning: the record
// says by path that the build wrote it - one package too many rather than the packages inlined into it missing. A
// lockfile of the inner build that cannot be read (permissions, not JSON, a record of another version) is a problem:
// its packages would be missing.
// A first-party package linked into node_modules (a workspace package that another build wrote, e.g. a library built
// by Vite) is looked at where it really is, also when the bundler reached it through the link (webpack's
// resolve.symlinks: false, Vite's resolve.preserveSymlinks).
/** @import { LockRecord, Package, RecordedWriter } from '../types' */
const fs = require('fs');
const path = require('path');
const config = require('./config.cjs');
const problems = require('./problems.cjs');
const { readMeta, unreadableRecord } = require('./lockfile.cjs');
const { hashOf } = require('./hashes.cjs');
const { unique } = require('./manifest.cjs');
const { ancestors, packageRoot, realRoot, exportPath, JS_CSS } = require('./paths.cjs');
const { codeOf, perProcess } = require('./values.cjs');

const S = Symbol.for('bundle-lockfile.nested.v1');
/** @type {{ metas: Map<string, LockRecord | null>, changed: Set<string> }} */
const state = perProcess(S, () => ({ metas: new Map(), changed: new Set() })); // dir -> meta | null; files warned about

// The record's file below an output dir, under both names it can have: package-lock.json, and record.json next to it
// (BUNDLE_LOCKFILE_TREE=only) - the inner build may have run with another setting than this one.
/**
 * @param {string} dir
 * @returns {string[]}
 */
function recordFiles(dir) {
  const target = path.join(dir, config.file);
  const base = path.basename(target) === 'record.json' ? 'package-lock.json' : 'record.json';
  return [target, path.join(path.dirname(target), base)];
}

// The lockfile meta (readMeta) of the build whose output dir is `dir`, or null. Of the records there (each name, and
// the export copy of each), the most recently written one that records outputs: a build that switched its
// BUNDLE_LOCKFILE_TREE setting leaves the other name's file behind.
/**
 * @param {string} dir
 * @returns {LockRecord | null}
 */
function metaOf(dir) {
  if (state.metas.has(dir)) return /** @type {LockRecord | null} */ (state.metas.get(dir));
  /** @type {LockRecord | null} */
  let meta = null, newest = -Infinity;
  /** @type {(why: string) => string} */
  const missing = (why) => `the packages of the build that wrote ${dir} would be missing (${why})`;
  for (const target of recordFiles(dir)) {
    const exp = exportPath(target);
    for (const f of exp ? [target, exp] : [target]) {
      let text, mtime;
      try { text = fs.readFileSync(f, 'utf8'); mtime = fs.statSync(f).mtimeMs; } catch (e) {
        if (codeOf(e) !== 'ENOENT' && codeOf(e) !== 'ENOTDIR') problems.problem(`could not read ${f}: ${missing('a bundled file there may be its output')}`, e, { once: f });
        continue;
      }
      const m = readMeta(text, path.dirname(target), [process.cwd()]); // (a record without its paths: anchored if it is this project's)
      if (!m) {
        const why = unreadableRecord(text);
        if (why) problems.problem(`${f} ${why}: ${missing('a bundled file there may be its output')}`, null, { once: f });
        continue;
      }
      if (!m.writers.some(w => Object.keys(w.outputs).length || w.files.length)) continue; // (then the export copy)
      if (mtime > newest) { meta = m; newest = mtime; }
      break; // the inline file over its export copy
    }
  }
  state.metas.set(dir, meta);
  return meta;
}

// The real path of a bundled file that is no file of a package: the file itself outside node_modules, the file in
// the package's real directory for a first-party package linked into node_modules (as packagesForFiles tells them
// apart); null for a file of a package. roots: package root -> real directory of a linked first-party package, or null.
/**
 * @param {string} file
 * @param {Map<string, string | null>} roots
 * @returns {string | null}
 */
function ownFile(file, roots) {
  const root = packageRoot(file);
  if (!root) return file;
  if (!roots.has(root)) {
    const real = realRoot(root);
    roots.set(root, real !== root && packageRoot(path.join(real, 'x')) !== real ? real : null);
  }
  const real = /** @type {string | null} */ (roots.get(root));
  return real && path.join(real, path.relative(root, file));
}

// The packages a writer's record has for its output file `file` (its contents, by package path), else all of its packages
/** @type {WeakMap<RecordedWriter, Map<string, Package>>} */
const byPathOf = new WeakMap(); // writer -> its packages by their paths
/** @param {RecordedWriter} w @param {string} file @returns {Package[]} */
function packagesIn(w, file) {
  const paths = w.contents[file];
  if (!paths) return w.pkgs;
  let byPath = byPathOf.get(w);
  if (!byPath) byPathOf.set(w, (byPath = new Map(w.pkgs.map(p => [p.path, p]))));
  return paths.map(p => byPath.get(p)).filter(p => p !== undefined);
}

// files: absolute paths of bundled source files. Returns Map(file -> [packages]) ({ name, version, license, path }) of
// the ones another build produced: the packages that build recorded for that file, or - recorded by a version without
// them - all packages of its output. A JavaScript or CSS file in the output of a writer whose record has only some of
// its outputs (outputCount) that is none of those it has may be one of the others: all packages of the writers whose
// record was cut - one package too many rather than the packages inlined into it missing.
/**
 * @template F
 * @param {Iterable<F>} files
 * @returns {Map<F, Package[]>}
 */
function nestedByFile(files) {
  state.metas.clear(); // lockfiles change between builds (watch mode)
  /** @type {Map<F, Package[]>} */
  const out = new Map();
  /** @type {Map<string, string | null>} */
  const roots = new Map();
  for (const f of files) {
    const bundled = typeof f === 'string' ? f.split('?')[0] : null;
    const file = bundled && path.isAbsolute(bundled) && ownFile(bundled, roots);
    if (!file) continue;
    for (const dir of ancestors(path.dirname(file))) {
      const meta = metaOf(dir);
      if (!meta) continue;
      const writer = meta.writers.find(w => w.outputs[file]);
      if (writer) {
        if (writer.outputs[file] !== hashOf(file) && !state.changed.has(file)) {
          state.changed.add(file);
          config.warn(`${file} changed after the build that wrote it into ${dir}: listed with that build's packages`);
        }
        out.set(f, packagesIn(writer, file));
        break;
      }
      // a writer that records no hashes (webpack, rspack, Angular) but the file among its files (or only some of its
      // files, see count): all its packages
      const by = JS_CSS.test(file) && meta.writers.filter(w => !Object.keys(w.outputs).length
        && (w.files.includes(file) || /** @type {number} */ (w.count) > w.files.length));
      if (by && by.length) {
        out.set(f, unique(...by.map(w => w.pkgs)));
        break;
      }
      const cut = meta.writers.filter(w => /** @type {number} */ (w.outputCount) > Object.keys(w.outputs).length);
      if (cut.length && JS_CSS.test(file)) {
        config.debug('maybe built by another build whose record has only some of its outputs:', file);
        out.set(f, unique(...cut.map(w => w.pkgs)));
        break;
      }
    }
  }
  return out;
}

module.exports = { nestedByFile };
