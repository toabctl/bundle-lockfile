'use strict';
// Serializes packages as package-lock.json (lockfileVersion 3, npm's format: docs.npmjs.com/cli/configuring-npm/
// package-lock-json), in the subset that syft's javascript-lock-cataloger and Trivy's npm analyzer both read.
const fs = require('fs');
const path = require('path');
const { posix } = require('./paths.cjs');

// Code-unit order, not localeCompare: the output must not depend on the build machine's locale
// (with LC_ALL=da_DK.UTF-8, "aa-utils" sorts after "zod").
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A package's location relative to the context, like npm writes it: node_modules/a, nested duplicates as
// node_modules/a/node_modules/b, pnpm's node_modules/.pnpm/..., Yarn PnP's .yarn/cache/<zip>/node_modules/...,
// and ../node_modules/c for a context below the project root. null for a location outside the context that
// is not in an ancestor's node_modules either (Yarn's global cache, a shared store): that path differs
// between machines and must not end up in the lockfile.
function locationKey(base, dir) {
  const rel = posix(path.relative(base, dir));
  if (path.isAbsolute(rel)) return null; // another drive
  const down = rel.replace(/^(\.\.\/)+/, '');
  if (down !== rel && !down.startsWith('node_modules/')) return null;
  return /(^|\/)node_modules\/[^/.]/.test(down) ? rel : null; // also null for '' and '..' (a context inside the package)
}

// The key of a package at `location` (see locationKey) as npm lays packages out, where the key starts with
// node_modules/ - Trivy skips every other key (syft reads any): the location if it is in the context's node_modules,
// without its leading ../ if it is in an ancestor's (the project's, for a context below the project root); null for
// any other place (Yarn PnP's .yarn/cache/<zip>/node_modules/..., a workspace's own packages/<ws>/node_modules/...).
const isNpmKey = (k) => !!k && k.startsWith('node_modules/');
const npmKey = (location) => { const k = location.replace(/^(\.\.\/)+/, ''); return isNpmKey(k) ? k : null; };

// One string, the only form both syft (a string or an array of strings) and Trivy (a string or {type} objects) read:
// several licenses (the legacy "licenses" array) as the SPDX expression npm's documentation gives for them.
function licenseString(l) {
  if (!Array.isArray(l)) return typeof l === 'string' ? l : undefined; // also from an edited lockfile (readMeta)
  const all = [...new Set(l.filter(x => typeof x === 'string' && x))];
  if (all.length < 2) return all[0];
  return `(${all.map(x => (/\s/.test(x) && !/^\(.*\)$/.test(x) ? `(${x})` : x)).join(' OR ')})`;
}

// Every entry carries "name", so aliases (node_modules/ms-old = ms@2.0.0) and keys that are not the package's
// location work: syft and Trivy take the name field over the key, as for npm's own lockfiles.
// The root "" entry has no name on purpose: syft only reports it as a package if it has one.
//
// meta (optional): { dir, writers: [{ id, files, paths }] } adds the "bundle-lockfile" field: which writer (a
// compiler, see core/outputs.cjs) put which packages and files there, so that another process writing the same
// lockfile can keep them. Paths in it are relative to dir (the lockfile's directory) and ids carry no paths, so the
// same build writes the same bytes on every machine. Tools that read package-lock.json ignore unknown fields (syft,
// npm). files: absolute paths of the writer's output files (count: their number, if files is a sample); paths: its
// packages' paths; outputs (optional): { absolute path: "sha256-<hex>" } of its JavaScript and CSS output files, so
// that a build that bundles one of them adds the packages in it (see core/nested.cjs); contents (optional):
// { absolute path: [package paths] } of those files, the packages in each - recorded as indices into the writer's
// "packages" (a file without them brings all of the writer's packages). The field also has "self": the lockfile's
// directory relative to the context, so that a reader can tell a copy elsewhere (whose "context" points elsewhere)
// from the lockfile itself; "locations": { key: location relative to the context } of the packages whose key is not
// their location (see npmKey); "outside": the keys of packages outside the project, which have no location in it; and
// "unknown": the keys of packages whose location is not known (p.unknown: read from a copy, or no longer where a
// record said, see core/outputs.cjs), which are the same package as any other one with that name and version.
const MAX_FILES = 20; // enough to tell whether the writer's output is still there
const MAX_OUTPUTS = 500;
const entry = (p) => { const license = licenseString(p.license); return { name: p.name, version: p.version, ...(license ? { license } : {}) }; };
// A writer's "packages", "outputs" and "contents" (see toPackageLock).
function outputsOf(w, keyOf, rel) {
  const packages = [...new Set([...w.paths].map(p => keyOf.get(p)).filter(Boolean))].sort(cmp);
  const files = Object.entries(w.outputs || {}).map(([f, h]) => [f, rel(f), h]).sort((a, b) => cmp(a[1], b[1])).slice(0, MAX_OUTPUTS);
  if (!files.length) return { packages };
  const index = new Map(packages.map((k, i) => [k, i]));
  const contents = [];
  for (const [f, r] of files) {
    const paths = w.contents && w.contents[f];
    if (!paths) continue;
    contents.push([r, [...new Set(paths.map(p => index.get(keyOf.get(p))).filter(i => i !== undefined))].sort((a, b) => a - b)]);
  }
  return { packages, outputs: Object.fromEntries(files.map(([, r, h]) => [r, h])), ...(contents.length ? { contents: Object.fromEntries(contents) } : {}) };
}

function toPackageLock(pkgs, context, meta) {
  const packages = { '': {} };
  const keyOf = new Map();
  let base = context;
  try { base = fs.realpathSync(context); } catch { /* keep context */ } // package paths are real paths
  const sorted = [...pkgs].sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version) || cmp(a.path, b.path));
  // p.outside: a package outside the project that another writer's lockfile listed (readMeta): its real path is not
  // known, only its key; p.unknown: a package whose location is not known
  const keyed = sorted.filter(p => !p.unknown).map(p => [p, p.outside ? null : locationKey(base, p.path)]);
  // Keys (see npmKey): a location in the context's node_modules is its own key (real locations are unique per
  // package); one in an ancestor's node_modules is without its ../ if no other package has that key (a context with a
  // node_modules of its own can have both node_modules/a and ../node_modules/a); every other package, and a package
  // outside the project, is node_modules/<name>, else node_modules/<name>@<version>, else ...@<version>-2, ...
  const taken = new Set(keyed.map(([, l]) => l).filter(isNpmKey));
  const nextKey = (p) => {
    const candidates = (n) => (n === 0 ? `node_modules/${p.name}` : `node_modules/${p.name}@${p.version}${n > 1 ? `-${n}` : ''}`);
    let n = 0;
    while (taken.has(candidates(n))) n++;
    taken.add(candidates(n));
    return candidates(n);
  };
  const entryOf = new Map();  // key -> its entry
  const locations = {};       // key -> the package's location, where that is not the key
  const set = (p, key, location) => {
    entryOf.set(key, entry(p));
    keyOf.set(p.path, key);
    if (location && location !== key) locations[key] = location;
  };
  const named = [];
  for (const [p, location] of keyed) {
    if (isNpmKey(location)) { set(p, location); continue; }
    const key = location && npmKey(location);
    if (key && !taken.has(key)) { taken.add(key); set(p, key, location); } else named.push([p, location]);
  }
  const outside = new Map(); // name@version -> { real: [package], listed: [package] }
  for (const [p, location] of named) {
    if (location) { set(p, nextKey(p), location); continue; }
    const id = `${p.name}@${p.version}`;
    if (!outside.has(id)) outside.set(id, { real: [], listed: [] });
    outside.get(id)[p.outside ? 'listed' : 'real'].push(p);
  }
  // One key per real copy outside the project; a copy another writer listed is one of those (the same package, seen
  // from another process), not one more
  const outsideKeys = [];
  for (const { real, listed } of outside.values()) {
    listed.sort((x, y) => cmp(x.outside, y.outside));
    for (let i = 0; i < Math.max(real.length, listed.length); i++) {
      const key = nextKey(real[i] || listed[i]);
      outsideKeys.push(key);
      entryOf.set(key, entry(real[i] || listed[i])); // this process read the real one's package.json
      for (const q of [real[i], listed[i]]) if (q) keyOf.set(q.path, key);
    }
  }
  // A package whose location is not known is the one with its name and version that has a key (the first key in
  // code-unit order), else one more, kept as unknown: the same in every process that has the same packages, whichever
  // writes last
  const keysOf = new Map(); // name@version -> keys
  for (const [p] of keyed) {
    const id = `${p.name}@${p.version}`;
    if (!keysOf.has(id)) keysOf.set(id, new Set());
    keysOf.get(id).add(keyOf.get(p.path));
  }
  const unknownKeys = [];
  const unknown = sorted.filter(p => p.unknown);
  for (const p of unknown) {
    const id = `${p.name}@${p.version}`;
    if (!keysOf.has(id)) {
      const key = nextKey(p);
      unknownKeys.push(key);
      entryOf.set(key, entry(p));
      keysOf.set(id, new Set([key]));
    }
    keyOf.set(p.path, [...keysOf.get(id)].sort(cmp)[0]);
  }
  // by name, version and key
  const order = (a, b) => cmp(a[1].name, b[1].name) || cmp(a[1].version, b[1].version) || cmp(a[0], b[0]);
  for (const [k, e] of [...entryOf].sort(order)) packages[k] = e;
  const doc = { lockfileVersion: 3, requires: true, packages };
  if (meta) {
    const rel = (p) => posix(path.relative(meta.dir, p)) || '.';
    doc['bundle-lockfile'] = {
      v: 1,
      context: rel(context), // as given, like dir: through the same symlinks both, never a real path of this machine
      self: posix(path.relative(context, meta.dir)) || '.',
      ...(Object.keys(locations).length ? { locations: Object.fromEntries(Object.entries(locations).sort((a, b) => cmp(a[0], b[0]))) } : {}),
      ...(outsideKeys.length ? { outside: outsideKeys.sort(cmp) } : {}),
      ...(unknownKeys.length ? { unknown: unknownKeys.sort(cmp) } : {}),
      writers: meta.writers.map(w => ({
        id: w.id,
        count: typeof w.count === 'number' ? w.count : w.files.length, // other processes: only a sample of files
        files: w.files.map(rel).sort(cmp).slice(0, MAX_FILES),
        ...outputsOf(w, keyOf, rel),
      })).sort((a, b) => cmp(a.id, b.id)),
    };
  }
  return JSON.stringify(doc, null, 2) + '\n';
}

// The record was written where it is read: "self" from its "context" leads back to dir. Both are as the writer had
// them (through the same symbolic links), so this holds where the lockfile was written, also in a project moved as a
// whole, and not in a copy at another depth or in another directory, whose "context" is not the project. A copy
// whose place mirrors the lockfile's (island/dist copied to vendor/island/dist, as if the project had moved to
// vendor/) is told by its packages not being where it says (see core/outputs.cjs).
const anchoredAt = (dir, context, self) => path.resolve(dir, context, self) === path.resolve(dir);

// The "bundle-lockfile" field of a lockfile's content (see toPackageLock), with absolute paths again (dir: the
// lockfile's directory): { context, anchored, writers: [{ id, files, count, outputs, contents: { file: [package] },
// pkgs: [{ name, version, license, path }] }] }, or null. anchored: true if the record was written in dir, false for
// a copy of one written elsewhere - its packages' locations are then not known (p.unknown) -, null for a record without
// "self" (v0.0.3 and earlier). files and outputs are paths in the output, relative to dir in a copy too (a copy of
// the output keeps them where they were relative to the lockfile).
function readMeta(json, dir) {
  let doc;
  try { doc = JSON.parse(json); } catch { return null; }
  const m = doc && doc['bundle-lockfile'];
  const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const strings = (v) => (Array.isArray(v) ? v.filter(s => typeof s === 'string') : []);
  // a lockfile of another shape (edited, another tool's) is no record: it must not stop this one from being written
  if (!isObject(m) || m.v !== 1 || !Array.isArray(m.writers) || typeof m.context !== 'string' || !isObject(doc.packages)) return null;
  let context = path.resolve(dir, m.context);
  try { context = fs.realpathSync(context); } catch { /* keep it */ } // package paths are real paths
  const outside = new Set(strings(m.outside));
  const anchored = typeof m.self === 'string' ? anchoredAt(dir, m.context, m.self) : null;
  const unknown = new Set(strings(m.unknown));
  // a key is the package's location unless "locations" gives it (no "locations": written by v0.0.3 or earlier, whose
  // keys were all locations)
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const locations = isObject(m.locations) ? m.locations : {};
  const locationOf = (k) => (own(locations, k) && typeof locations[k] === 'string' ? locations[k] : k);
  // a package outside the project has no path here: an id of its own, never a real path that could be another package
  const pkgOf = (k) => {
    const p = own(doc.packages, k) && doc.packages[k];
    if (!isObject(p) || typeof p.name !== 'string' || !p.name || typeof p.version !== 'string' || !p.version) return null;
    if (outside.has(k)) return { ...p, path: `\0outside:${k}`, outside: k };
    if (unknown.has(k) || anchored === false) return unknownPackage(p);
    return { ...p, path: path.resolve(context, locationOf(k)) };
  };
  return {
    context,
    anchored,
    writers: m.writers.filter(w => isObject(w) && typeof w.id === 'string').map(w => {
      const keys = strings(w.packages);
      const contents = {};
      for (const [f, list] of Object.entries(isObject(w.contents) ? w.contents : {})) {
        if (!Array.isArray(list)) continue;
        contents[path.resolve(dir, f)] = list.filter(i => Number.isInteger(i) && i >= 0 && i < keys.length).map(i => pkgOf(keys[i])).filter(Boolean);
      }
      return {
        id: w.id,
        files: strings(w.files).map(f => path.resolve(dir, f)),
        count: typeof w.count === 'number' ? w.count : undefined,
        outputs: isObject(w.outputs)
          ? Object.fromEntries(Object.entries(w.outputs).filter(([, h]) => typeof h === 'string').map(([f, h]) => [path.resolve(dir, f), h])) : {},
        contents,
        pkgs: keys.map(pkgOf).filter(Boolean),
      };
    }),
  };
}

// A package whose location is not known: identified by its name and version only (see toPackageLock).
const unknownPackage = (p) => ({ ...p, path: `\0unknown:${p.name}@${p.version}`, unknown: true });

// The content of a copy of a lockfile, for its directory `to`: the record of the lockfile (anchored in `from`, see
// readMeta) with "context" and "self" for `to`; the paths relative to the context and to the lockfile stay as they
// are (a copy of the output has its files where they were relative to the lockfile). null if the content has no
// record anchored in `from`.
function reanchor(json, from, to) {
  const meta = readMeta(json, from);
  if (!meta || meta.anchored !== true) return null;
  const doc = JSON.parse(json);
  const m = doc['bundle-lockfile'];
  const context = path.resolve(from, m.context); // as given, through the same symbolic links as the writer's
  m.context = posix(path.relative(to, context)) || '.';
  m.self = posix(path.relative(context, to)) || '.';
  return JSON.stringify(doc, null, 2) + '\n';
}

module.exports = { cmp, toPackageLock, readMeta, reanchor, unknownPackage };
