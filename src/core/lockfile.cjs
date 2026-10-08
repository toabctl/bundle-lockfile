'use strict';
// Serializes packages as package-lock.json (lockfileVersion 3), the format syft's javascript-lock-cataloger reads.
const fs = require('fs');
const path = require('path');
const { packagesForFiles } = require('./packages.cjs');

// Code-unit order, not localeCompare: the output must not depend on the build machine's locale
// (with LC_ALL=da_DK.UTF-8, "aa-utils" sorts after "zod").
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A package's location relative to the context, like npm writes it: node_modules/a, nested duplicates as
// node_modules/a/node_modules/b, pnpm's node_modules/.pnpm/..., Yarn PnP's .yarn/cache/<zip>/node_modules/...,
// and ../node_modules/c for a context below the project root. null for a location outside the context that
// is not in an ancestor's node_modules either (Yarn's global cache, a shared store): that path differs
// between machines and must not end up in the lockfile.
function locationKey(base, dir) {
  const rel = path.relative(base, dir).split(path.sep).join('/');
  if (path.isAbsolute(rel)) return null; // another drive
  const down = rel.replace(/^(\.\.\/)+/, '');
  if (down !== rel && !down.startsWith('node_modules/')) return null;
  return /(^|\/)node_modules\/[^/.]/.test(down) ? rel : null; // also null for '' and '..' (a context inside the package)
}

// Every entry carries "name", so aliases (node_modules/ms-old = ms@2.0.0) work: syft takes the name field
// over the key, as for npm's own lockfiles.
// The root "" entry has no name on purpose: syft only reports it as a package if it has one.
//
// meta (optional): { dir, writers: [{ id, files, paths }] } adds the "bundle-lockfile" field: which writer (a
// compiler, see core/outputs.cjs) put which packages and files there, so that another process writing the same
// lockfile can keep them. Paths in it are relative to dir (the lockfile's directory) and ids carry no paths, so the
// same build writes the same bytes on every machine. Tools that read package-lock.json ignore unknown fields (syft,
// npm). files: absolute paths of the writer's output files (count: their number, if files is a sample); paths: its
// packages' paths; outputs (optional): { absolute path: "sha256-<hex>" } of its JavaScript output files, so that a
// build that bundles one of them adds the packages in it (see core/nested.cjs).
const MAX_FILES = 20; // enough to tell whether the writer's output is still there
const MAX_OUTPUTS = 500;
const posix = (p) => p.split(path.sep).join('/');
const entry = (p) => ({ name: p.name, version: p.version, ...(p.license ? { license: p.license } : {}) });
function toPackageLock(pkgs, context, meta) {
  const packages = { '': {} };
  const keyOf = new Map();
  let base = context;
  try { base = fs.realpathSync(context); } catch { /* keep context */ } // package paths are real paths
  const sorted = [...pkgs].sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version) || cmp(a.path, b.path));
  // p.outside: a package outside the project that another writer's lockfile listed (readMeta): its real path is not
  // known, only its key
  const keyed = sorted.map(p => [p, p.outside ? null : locationKey(base, p.path)]);
  const taken = new Set(keyed.map(([, k]) => k).filter(Boolean)); // real locations are unique per package
  const outside = new Map(); // name@version -> { real: [package], listed: [package] }
  const entryOf = new Map();  // key -> its entry
  for (const [p, location] of keyed) {
    if (location) { entryOf.set(location, entry(p)); keyOf.set(p.path, location); continue; }
    const id = `${p.name}@${p.version}`;
    if (!outside.has(id)) outside.set(id, { real: [], listed: [] });
    outside.get(id)[p.outside ? 'listed' : 'real'].push(p);
  }
  // node_modules/<name>, else node_modules/<name>@<version>, else node_modules/<name>@<version>-2, ... One key per real
  // copy; a copy another writer listed is one of those (the same package, seen from another process), not one more
  const outsideKeys = [];
  for (const { real, listed } of outside.values()) {
    const p = real[0] || listed[0];
    const candidates = (n) => (n === 0 ? `node_modules/${p.name}` : `node_modules/${p.name}@${p.version}${n > 1 ? `-${n}` : ''}`);
    listed.sort((x, y) => cmp(x.outside, y.outside));
    for (let i = 0, n = 0; i < Math.max(real.length, listed.length); i++) {
      while (taken.has(candidates(n))) n++;
      const key = candidates(n);
      taken.add(key);
      outsideKeys.push(key);
      entryOf.set(key, entry(real[i] || listed[i])); // this process read the real one's package.json
      for (const q of [real[i], listed[i]]) if (q) keyOf.set(q.path, key);
    }
  }
  for (const [p] of keyed) { const key = keyOf.get(p.path); if (!(key in packages)) packages[key] = entryOf.get(key); } // in sorted order
  const doc = { lockfileVersion: 3, requires: true, packages };
  if (meta) {
    const rel = (p) => posix(path.relative(meta.dir, p)) || '.';
    doc['bundle-lockfile'] = {
      v: 1,
      context: rel(base),
      ...(outsideKeys.length ? { outside: outsideKeys.sort(cmp) } : {}),
      writers: meta.writers.map(w => ({
        id: w.id,
        count: typeof w.count === 'number' ? w.count : w.files.length, // other processes: only a sample of files
        files: w.files.map(rel).sort(cmp).slice(0, MAX_FILES),
        packages: [...new Set([...w.paths].map(p => keyOf.get(p)).filter(Boolean))].sort(cmp),
        ...(w.outputs && Object.keys(w.outputs).length
          ? { outputs: Object.fromEntries(Object.entries(w.outputs).map(([f, h]) => [rel(f), h]).sort((a, b) => cmp(a[0], b[0])).slice(0, MAX_OUTPUTS)) }
          : {}),
      })).sort((a, b) => cmp(a.id, b.id)),
    };
  }
  return JSON.stringify(doc, null, 2) + '\n';
}

// The "bundle-lockfile" field of a lockfile's content (see toPackageLock), with absolute paths again (dir: the
// lockfile's directory): { context, writers: [{ id, files, pkgs: [{ name, version, license, path }] }] }, or null.
function readMeta(json, dir) {
  let doc;
  try { doc = JSON.parse(json); } catch { return null; }
  const m = doc && doc['bundle-lockfile'];
  const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const strings = (v) => (Array.isArray(v) ? v.filter(s => typeof s === 'string') : []);
  // a lockfile of another shape (edited, another tool's) is no record: it must not stop this one from being written
  if (!isObject(m) || m.v !== 1 || !Array.isArray(m.writers) || typeof m.context !== 'string' || !isObject(doc.packages)) return null;
  const context = path.resolve(dir, m.context);
  const outside = new Set(strings(m.outside));
  // a package outside the project has no path here: an id of its own, never a real path that could be another package
  const pkgOf = (k) => {
    const p = Object.prototype.hasOwnProperty.call(doc.packages, k) && doc.packages[k];
    if (!isObject(p) || typeof p.name !== 'string' || !p.name || typeof p.version !== 'string' || !p.version) return null;
    return outside.has(k) ? { ...p, path: `\0outside:${k}`, outside: k } : { ...p, path: path.resolve(context, k) };
  };
  return {
    context,
    writers: m.writers.filter(w => isObject(w) && typeof w.id === 'string').map(w => ({
      id: w.id,
      files: strings(w.files).map(f => path.resolve(dir, f)),
      count: typeof w.count === 'number' ? w.count : undefined,
      outputs: isObject(w.outputs)
        ? Object.fromEntries(Object.entries(w.outputs).filter(([, h]) => typeof h === 'string').map(([f, h]) => [path.resolve(dir, f), h])) : {},
      pkgs: strings(w.packages).map(pkgOf).filter(Boolean),
    })),
  };
}

// files: absolute paths of bundled source files; context: project root the keys are relative to.
function lockfileForFiles(files, context) {
  return toPackageLock(packagesForFiles(files), context);
}

module.exports = { cmp, toPackageLock, readMeta, lockfileForFiles };
