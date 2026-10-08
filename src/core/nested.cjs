'use strict';
// Packages inside bundled files that another build produced: e.g. GitLab's Vite-built island (dist/main.js, with
// Vue inlined) that webpack bundles as a first-party file. The inner build recorded, in its lockfile next to its
// output, the sha256 of each JavaScript file it wrote (see toPackageLock's "outputs"); a bundled file that is not in
// node_modules and has the bytes recorded by the nearest such lockfile above it brings that writer's packages.
// Works across processes, separate commands and machines (the record travels with the output) and for the export
// copy (BUNDLE_LOCKFILE_EXPORT_DIR) when the inline lockfile is off. A file changed after it was built does not match.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config.cjs');
const { readMeta } = require('./lockfile.cjs');
const { packageRoot } = require('./packages.cjs');

const S = Symbol.for('bundle-lockfile.nested.v1');
const state = globalThis[S] || (globalThis[S] = { metas: new Map(), hashes: new Map() }); // dir -> meta | null; file -> hash

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

function hashOf(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${file}\0${st.size}\0${st.mtimeMs}`;
  if (!state.hashes.has(key)) {
    try { state.hashes.set(key, `sha256-${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`); } catch { return null; }
  }
  return state.hashes.get(key);
}

// files: absolute paths of bundled source files. Returns the packages ({ name, version, license, path }) recorded for
// the ones another build produced.
function nestedPackages(files) {
  state.metas.clear(); // lockfiles change between builds (watch mode)
  const out = new Map();
  for (const f of files) {
    const file = typeof f === 'string' ? f.split('?')[0] : null;
    if (!file || !path.isAbsolute(file) || packageRoot(file)) continue;
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
      const meta = metaOf(dir);
      const writer = meta && meta.writers.find(w => w.outputs[file]);
      if (writer) {
        if (writer.outputs[file] === hashOf(file)) for (const p of writer.pkgs) out.set(p.path, p);
        else config.debug('built by another build, but changed since:', file);
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
  }
  return [...out.values()];
}

module.exports = { nestedPackages };
