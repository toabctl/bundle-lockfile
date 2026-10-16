'use strict';
// Serializes packages as package-lock.json (lockfileVersion 3, npm's format: docs.npmjs.com/cli/configuring-npm/
// package-lock-json), in the subset that syft's javascript-lock-cataloger and Trivy's npm analyzer both read.
/** @import { BundlerId, LocatedPackage, LockRecord, MetaWriter, OutsidePackage, Package, RecordedWriter, UnknownPackage, Via } from '../types' */
const fs = require('fs');
const path = require('path');
const { posix, within, realish } = require('./paths.cjs');
const { hex } = require('./hashes.cjs');
const { getOr } = require('./maps.cjs');
const { CLASSES, KNOWN } = require('./via.cjs');
const { isObject, isArray, strings, parseJson } = require('./values.cjs');

// Code-unit order, not localeCompare: the output must not depend on the build machine's locale
// (with LC_ALL=da_DK.UTF-8, "aa-utils" sorts after "zod").
/** @type {(a: string, b: string) => number} */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A package's location relative to the context, like npm writes it: node_modules/a, nested duplicates as
// node_modules/a/node_modules/b, pnpm's node_modules/.pnpm/..., Yarn PnP's .yarn/cache/<zip>/node_modules/...,
// and ../node_modules/c for a context below the project root, and a vendored copy in the context's tree (see
// core/vendored.cjs: vendor/left-pad). null for a location outside the context that is not in an ancestor's
// node_modules either (Yarn's global cache, a shared store, a vendored copy above the context): that path differs
// between machines and must not end up in the lockfile.
// a package directory in node_modules: node_modules/<name> (not a tool's node_modules/.cache), also in Yarn's store
// (node_modules/.store/<slug>/package, see core/layout.cjs)
const PACKAGE_DIR = /(^|\/)node_modules\/([^/.]|\.store\/[^/]+\/package(\/|$))/;
/**
 * @param {string} base
 * @param {string} dir
 * @returns {string | null}
 */
function locationKey(base, dir) {
  const rel = posix(path.relative(base, dir));
  if (path.isAbsolute(rel)) return null; // another drive
  const down = rel.replace(/^(\.\.\/)+/, '');
  if (down !== rel) return down.startsWith('node_modules/') && PACKAGE_DIR.test(down) ? rel : null;
  if (!rel || rel === '..') return null; // a context inside the package
  return /(^|\/)node_modules\//.test(rel) && !PACKAGE_DIR.test(rel) ? null : rel; // not node_modules/.cache
}

// The key of a package at `location` (see locationKey) as npm lays packages out, where the key starts with
// node_modules/ - Trivy skips every other key (syft reads any): the location if it is in the context's node_modules,
// without its leading ../ if it is in an ancestor's (the project's, for a context below the project root); null for
// any other place (Yarn PnP's .yarn/cache/<zip>/node_modules/..., a workspace's own packages/<ws>/node_modules/...).
/** @type {(k: string | null | undefined) => boolean} */
const isNpmKey = (k) => !!k && k.startsWith('node_modules/');
/** @type {(location: string) => string | null} */
const npmKey = (location) => { const k = location.replace(/^(\.\.\/)+/, ''); return isNpmKey(k) ? k : null; };

// One string, the only form both syft (a string or an array of strings) and Trivy (a string or {type} objects) read:
// several licenses (the legacy "licenses" array) as the SPDX expression npm's documentation gives for them.
/**
 * @param {unknown} l
 * @returns {string | undefined}
 */
function licenseString(l) {
  if (!isArray(l)) return typeof l === 'string' ? l : undefined; // also from an edited lockfile (readMeta)
  const all = [...new Set(strings(l).filter(x => x))];
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
// "packages" (a file without them brings all of the writer's packages); outputCount (optional): the number of output
// files, if outputs has only some of them (MAX_OUTPUTS; a reader then attributes a file it does not find to all of the
// writer's packages, see core/nested.cjs); bundler (optional): { name, version } of the bundler that ran, as it reports
// itself; via (optional): Map(package path -> its classes, see core/via.cjs), recorded as { class: [indices into
// "packages"] }. The field also has "self": the lockfile's
// directory relative to the context, so that a reader can tell a copy elsewhere (whose "context" points elsewhere)
// from the lockfile itself; "locations": { key: location relative to the context } of the packages whose key is not
// their location (see npmKey); "outside": the keys of packages outside the project, which have no location in it; and
// "unknown": the keys of packages whose location is not known (p.unknown: read from a copy, or no longer where a
// record said, see core/outputs.cjs), which are the same package as any other one with that name and version.
const VERSION = 2; // of the record: 2 has "bundler" and "via"; a record of another version is not read (see readMeta)
const MAX_FILES = 20; // enough to tell whether the writer's output is still there
const MAX_OUTPUTS = 500;
/** @typedef {{ name: string, version: string, license?: string }} Entry */
/** @type {(p: Package) => Entry} */
const entry = (p) => { const license = licenseString(p.license); return { name: p.name, version: p.version, ...(license ? { license } : {}) }; };
// A writer's "packages" (sorted keys) and, for each package path, its index there (see toPackageLock)
/**
 * @param {MetaWriter} w
 * @param {Map<string, string>} keyOf
 * @returns {{ packages: string[], indexOf: (p: string) => number | undefined }}
 */
function packagesOf(w, keyOf) {
  const packages = /** @type {string[]} */ ([...new Set([...w.paths].map(p => keyOf.get(p)).filter(Boolean))]).sort(cmp);
  /** @type {Map<string | undefined, number>} */
  const index = new Map(packages.map((k, i) => [k, i]));
  return { packages, indexOf: (p) => index.get(keyOf.get(p)) };
}
// A writer's "outputs" and "contents" (see toPackageLock). indexOf: see packagesOf.
/**
 * @param {MetaWriter} w
 * @param {(p: string) => number | undefined} indexOf
 * @param {(p: string) => string} rel
 * @returns {{ outputs?: Record<string, string>, outputCount?: number, contents?: Record<string, number[]> }}
 */
function outputsOf(w, indexOf, rel) {
  const all = Object.entries(w.outputs || {});
  const files = all.map(([f, h]) => [f, rel(f), h]).sort((a, b) => cmp(a[1], b[1])).slice(0, MAX_OUTPUTS);
  if (!files.length) return {};
  // (a writer of another process: its record had only some of them already)
  const total = Math.max(all.length, typeof w.outputCount === 'number' ? w.outputCount : 0);
  /** @type {[string, number[]][]} */
  const contents = [];
  for (const [f, r] of files) {
    const paths = w.contents && w.contents[f];
    if (!paths) continue;
    contents.push([r, [...new Set(paths.map(indexOf).filter(i => i !== undefined))].sort((a, b) => a - b)]);
  }
  return { outputs: Object.fromEntries(files.map(([, r, h]) => [r, h])), ...(total > files.length ? { outputCount: total } : {}),
    ...(contents.length ? { contents: Object.fromEntries(contents) } : {}) };
}
// A writer's "bundler" and "via" (see toPackageLock): the classes in core/via.cjs order, each with the sorted indices
// of its packages in "packages" (indexOf: see packagesOf).
/**
 * @param {MetaWriter} w
 * @param {(p: string) => number | undefined} indexOf
 * @returns {{ bundler?: BundlerId, via?: Record<string, number[]> }}
 */
function provenanceOf(w, indexOf) {
  /** @type {{ bundler?: BundlerId, via?: Record<string, number[]> }} */
  const out = {};
  const bid = w.bundler;
  if (bid && typeof bid.name === 'string' && bid.name) out.bundler = { name: bid.name, ...(typeof bid.version === 'string' && bid.version ? { version: bid.version } : {}) };
  if (!w.via) return out;
  /** @type {Map<string, Set<number>>} */
  const by = new Map();
  for (const [p, classes] of w.via) {
    const i = indexOf(p);
    if (i === undefined) continue;
    for (const c of classes) if (KNOWN.has(c)) getOr(by, c, () => new Set()).add(i);
  }
  const via = CLASSES.flatMap(/** @returns {[string, number[]][]} */ (c) => { const s = by.get(c); return s ? [[c, [...s].sort((a, b) => a - b)]] : []; });
  if (via.length) out.via = Object.fromEntries(via);
  return out;
}

/**
 * @param {Iterable<Package>} pkgs
 * @param {string} context
 * @param {{ dir: string, writers: MetaWriter[] }} [meta]
 * @returns {string}
 */
function toPackageLock(pkgs, context, meta) {
  /** @type {Record<string, object>} */
  const packages = { '': {} };
  /** @type {Map<string, string>} */
  const keyOf = new Map();
  let base = context;
  try { base = fs.realpathSync(context); } catch { /* keep context */ } // package paths are real paths
  const sorted = [...pkgs].sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version) || cmp(a.path, b.path));
  // p.outside: a package outside the project that another writer's lockfile listed (readMeta): its real path is not
  // known, only its key; p.unknown: a package whose location is not known
  /** @type {[Package, string | null][]} */
  const keyed = sorted.filter(p => !p.unknown).map(p => [p, located(p) ? locationKey(base, p.path) : null]);
  // Keys (see npmKey): a location in the context's node_modules is its own key (real locations are unique per
  // package); one in an ancestor's node_modules is without its ../ if no other package has that key (a context with a
  // node_modules of its own can have both node_modules/a and ../node_modules/a); every other package, and a package
  // outside the project, is node_modules/<name>, else node_modules/<name>@<version>, else ...@<version>-2, ...
  const taken = new Set(keyed.map(([, l]) => l).filter(isNpmKey));
  /** @type {(p: Package) => string} */
  const nextKey = (p) => {
    /** @type {(n: number) => string} */
    const candidates = (n) => (n === 0 ? `node_modules/${p.name}` : `node_modules/${p.name}@${p.version}${n > 1 ? `-${n}` : ''}`);
    let n = 0;
    while (taken.has(candidates(n))) n++;
    taken.add(candidates(n));
    return candidates(n);
  };
  /** @type {Map<string, Entry>} */
  const entryOf = new Map();  // key -> its entry
  /** @type {Record<string, string>} */
  const locations = {};       // key -> the package's location, where that is not the key
  /** @type {(p: Package, key: string, location?: string | null) => void} */
  const set = (p, key, location) => {
    entryOf.set(key, entry(p));
    keyOf.set(p.path, key);
    if (location && location !== key) locations[key] = location;
  };
  /** @type {[Package, string | null][]} */
  const named = [];
  for (const [p, location] of keyed) {
    if (isNpmKey(location)) { set(p, /** @type {string} */ (location)); continue; }
    const key = location && npmKey(location);
    if (key && !taken.has(key)) { taken.add(key); set(p, key, location); } else named.push([p, location]);
  }
  /** @type {Map<string, { real: Package[], listed: Package[] }>} */
  const outside = new Map(); // name@version -> { real: [package], listed: [package] }
  for (const [p, location] of named) {
    if (location) { set(p, nextKey(p), location); continue; }
    getOr(outside, `${p.name}@${p.version}`, () => ({ real: [], listed: [] }))[p.outside ? 'listed' : 'real'].push(p);
  }
  // One key per real copy outside the project; a copy another writer listed is one of those (the same package, seen
  // from another process), not one more
  /** @type {string[]} */
  const outsideKeys = [];
  for (const { real, listed } of outside.values()) {
    listed.sort((x, y) => cmp(/** @type {string} */ (x.outside), /** @type {string} */ (y.outside)));
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
  /** @type {Map<string, Set<string>>} */
  const keysOf = new Map(); // name@version -> keys
  for (const [p] of keyed) getOr(keysOf, `${p.name}@${p.version}`, () => new Set()).add(/** @type {string} */ (keyOf.get(p.path)));
  /** @type {string[]} */
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
    keyOf.set(p.path, [.../** @type {Set<string>} */ (keysOf.get(id))].sort(cmp)[0]);
  }
  // by name, version and key
  /** @type {(a: [string, Entry], b: [string, Entry]) => number} */
  const order = (a, b) => cmp(a[1].name, b[1].name) || cmp(a[1].version, b[1].version) || cmp(a[0], b[0]);
  for (const [k, e] of [...entryOf].sort(order)) packages[k] = e;
  /** @type {{ lockfileVersion: number, requires: boolean, packages: Record<string, object>, 'bundle-lockfile'?: object }} */
  const doc = { lockfileVersion: 3, requires: true, packages };
  if (meta) {
    /** @type {(p: string) => string} */
    const rel = (p) => posix(path.relative(meta.dir, p)) || '.';
    doc['bundle-lockfile'] = {
      v: VERSION,
      ...anchorOf(context, meta.dir),
      ...(Object.keys(locations).length ? { locations: Object.fromEntries(Object.entries(locations).sort((a, b) => cmp(a[0], b[0]))) } : {}),
      ...(outsideKeys.length ? { outside: outsideKeys.sort(cmp) } : {}),
      ...(unknownKeys.length ? { unknown: unknownKeys.sort(cmp) } : {}),
      writers: meta.writers.map((w) => {
        const { packages: keys, indexOf } = packagesOf(w, keyOf);
        return {
          id: w.id,
          count: typeof w.count === 'number' ? w.count : w.files.length, // other processes: only a sample of files
          files: w.files.map(rel).sort(cmp).slice(0, MAX_FILES),
          packages: keys,
          ...outputsOf(w, indexOf, rel),
          ...provenanceOf(w, indexOf),
        };
      }).sort((a, b) => cmp(a.id, b.id)),
    };
  }
  return JSON.stringify(doc, null, 2) + '\n';
}

// Where a record is anchored (see readMeta): "context", the context relative to the lockfile's directory dir, and
// "self", dir relative to the context - both as given (through the same symbolic links), never a real path of this
// machine. A lockfile outside the context's project (the outermost directory with a package.json among the context
// and those above it; an absolute outDir elsewhere) would spell out the directories on the way there (../../home/
// builder/out): it gets "contextId" and "selfId" instead, hashes that only a process with the same context can match
// (see readMeta). They are of the context's real path and its device and inode numbers, so a guessed path cannot be
// checked against them, and of dir relative to the context.
/**
 * @param {string} context
 * @param {string} dir
 */
function anchorOf(context, dir) {
  const plain = { context: posix(path.relative(dir, context)) || '.', self: posix(path.relative(context, dir)) || '.' };
  const real = realish(context);
  if (within(projectOf(real), realish(dir))) return plain;
  const secret = secretOf(context);
  return secret ? { contextId: contextIdOf(secret), selfId: selfIdOf(secret, context, dir) } : plain;
}
// The outermost directory with a package.json among dir and those above it, else dir
/**
 * @param {string} dir
 * @returns {string}
 */
function projectOf(dir) {
  let root = dir;
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'package.json'))) root = d;
    if (path.dirname(d) === d) return root;
  }
}
/**
 * @param {string} context
 * @returns {string | null}
 */
function secretOf(context) {
  try { const real = fs.realpathSync(context), st = fs.statSync(real); return hex(`bundle-lockfile\0${real}\0${st.dev}\0${st.ino}`); } catch { return null; }
}
/** @type {(secret: string) => string} */
const contextIdOf = (secret) => hex(`context\0${secret}`).slice(0, 16);
/** @type {(secret: string, context: string, dir: string) => string} */
const selfIdOf = (secret, context, dir) => hex(`self\0${secret}\0${posix(path.relative(realish(context), realish(dir)))}`).slice(0, 16);

// The record was written where it is read: "self" from its "context" leads back to dir. Both are as the writer had
// them (through the same symbolic links), so this holds where the lockfile was written, also in a project moved as a
// whole, and not in a copy at another depth or in another directory, whose "context" is not the project. A copy
// whose place mirrors the lockfile's (island/dist copied to vendor/island/dist, as if the project had moved to
// vendor/) is told by its packages not being where it says (see core/outputs.cjs).
/** @type {(dir: string, context: string, self: string) => boolean} */
const anchoredAt = (dir, context, self) => path.resolve(dir, context, self) === path.resolve(dir);

// The "bundle-lockfile" field of a lockfile's content (see toPackageLock), with absolute paths again (dir: the
// lockfile's directory): { context, anchored, writers: [{ id, files, count, outputs, contents: { file: [package path] },
// pkgs: [{ name, version, license, path }], bundler, via: Map(package path -> Set(class)) }] }, or null (also for a record
// of another version than VERSION). anchored: true if the record was written in dir, false for
// a copy of one written elsewhere - its packages' locations are then not known (p.unknown) -, null for a record without
// "self" (v0.0.3 and earlier). files and outputs are paths in the output, relative to dir in a copy too (a copy of
// the output keeps them where they were relative to the lockfile).
/**
 * @param {string} json
 * @param {string} dir
 * @param {string[]} [contexts]
 * @returns {LockRecord | null}
 */
function readMeta(json, dir, contexts = []) {
  let doc;
  try { doc = parseJson(json); } catch { return null; }
  const m = isObject(doc) ? doc['bundle-lockfile'] : undefined;
  // a lockfile of another shape (edited, another tool's) is no record: it must not stop this one from being written
  if (!isObject(doc) || !isObject(m) || m.v !== VERSION || !isArray(m.writers) || !isObject(doc.packages)) return null;
  const entries = doc.packages;
  let context, anchored;
  if (typeof m.context === 'string') {
    context = path.resolve(dir, m.context);
    try { context = fs.realpathSync(context); } catch { /* keep it */ } // package paths are real paths
    anchored = typeof m.self === 'string' ? anchoredAt(dir, m.context, m.self) : null;
  } else if (typeof m.contextId === 'string') {
    // a record without its paths (see anchorOf): anchored where one of the reader's contexts has its id and leads to
    // dir; else its packages' locations are not known (a copy elsewhere, or a writer of another project)
    const c = contexts.find(x => { const sec = typeof x === 'string' && secretOf(x); return sec && contextIdOf(sec) === m.contextId; });
    context = c ? realish(c) : null;
    anchored = !!c && typeof m.selfId === 'string' && selfIdOf(/** @type {string} */ (secretOf(c)), c, dir) === m.selfId;
  } else return null;
  const outside = new Set(strings(m.outside));
  const unknown = new Set(strings(m.unknown));
  // a key is the package's location unless "locations" gives it (no "locations": written by v0.0.3 or earlier, whose
  // keys were all locations)
  const locations = isObject(m.locations) ? m.locations : {};
  /** @type {(k: string) => string} */
  const locationOf = (k) => { const l = Object.hasOwn(locations, k) ? locations[k] : undefined; return typeof l === 'string' ? l : k; };
  // a package outside the project has no path here: an id of its own, never a real path that could be another package
  /** @type {(k: string) => Package | null} */
  const pkgOf = (k) => {
    const p = Object.hasOwn(entries, k) ? entries[k] : undefined;
    if (!isObject(p) || typeof p.name !== 'string' || !p.name || typeof p.version !== 'string' || !p.version) return null;
    // only the fields of a package: an entry's other fields (an edited lockfile's "unknown", "outside", "dev") are not
    // what the record says about where it is
    const base = { name: p.name, version: p.version, ...(typeof p.license === 'string' || Array.isArray(p.license) ? { license: p.license } : {}) };
    if (outside.has(k)) {
      /** @type {OutsidePackage} */
      const o = { ...base, path: `\0outside:${k}`, outside: k };
      return o;
    }
    if (unknown.has(k) || anchored === false || !context) return unknownPackage({ ...base, path: path.resolve(dir, locationOf(k)) });
    return { ...base, path: path.resolve(context, locationOf(k)) };
  };
  /** @type {Map<string, Package | null>} */
  const byKey = new Map(); // key -> pkgOf(key), made once
  return {
    context,
    anchored,
    writers: m.writers.flatMap((w) => {
      if (!isObject(w) || typeof w.id !== 'string') return [];
      // the writer's packages, one object per key (also of any other writer's), and the one an index names, or null
      const keys = strings(w.packages);
      const byIndex = keys.map(k => getOr(byKey, k, () => pkgOf(k)));
      /** @type {(i: unknown) => Package | null} */
      const at = (i) => (Number.isInteger(i) && /** @type {number} */ (i) >= 0 ? byIndex[/** @type {number} */ (i)] || null : null);
      /** @type {Record<string, string[]>} */
      const contents = {};
      for (const [f, list] of Object.entries(isObject(w.contents) ? w.contents : {})) {
        if (!isArray(list)) continue;
        contents[path.resolve(dir, f)] = list.map(at).filter(p => p !== null).map(p => p.path);
      }
      /** @type {Via} */
      const via = new Map(); // package path -> Set(class)
      for (const [c, list] of Object.entries(isObject(w.via) ? w.via : {})) {
        if (!KNOWN.has(c) || !isArray(list)) continue;
        for (const i of list) { const p = at(i); if (p) getOr(via, p.path, () => new Set()).add(c); }
      }
      const b = w.bundler;
      /** @type {Record<string, string>} */
      const outputs = {};
      for (const [f, h] of Object.entries(isObject(w.outputs) ? w.outputs : {})) if (typeof h === 'string') outputs[path.resolve(dir, f)] = h;
      /** @type {RecordedWriter} */
      const out = {
        id: w.id,
        bundler: isObject(b) && typeof b.name === 'string' ? { name: b.name, ...(typeof b.version === 'string' ? { version: b.version } : {}) } : undefined,
        via,
        files: strings(w.files).map(f => path.resolve(dir, f)),
        count: typeof w.count === 'number' ? w.count : undefined,
        outputs,
        outputCount: typeof w.outputCount === 'number' ? w.outputCount : undefined,
        contents,
        pkgs: byIndex.filter(p => p !== null),
      };
      return [out];
    }),
  };
}

// Why a lockfile's content that readMeta returned null for has no record it can use, if it is one of bundle-lockfile's
// that cannot be read (not JSON, a record of another version or shape); null for a lockfile without a record (another
// tool's, e.g. the project's own).
const NOT_JSON = 'is not JSON';
/**
 * @param {string} json
 * @returns {string | null}
 */
function unreadableRecord(json) {
  let doc;
  try { doc = parseJson(json); } catch { return NOT_JSON; }
  const m = isObject(doc) ? doc['bundle-lockfile'] : undefined;
  if (m === undefined) return null;
  if (isObject(m) && m.v !== VERSION) return `has a record of version ${JSON.stringify(m.v)}, which this bundle-lockfile does not read (it reads version ${VERSION}): build it again with this one`;
  return 'has a bundle-lockfile record of a shape it does not read';
}

// A package whose location is not known: identified by its name and version only (see toPackageLock).
/** @type {(p: LocatedPackage) => UnknownPackage} */
const unknownPackage = (p) => ({ ...p, path: `\0unknown:${p.name}@${p.version}`, unknown: true });
// The package is at its path, a directory (neither outside the project nor of a location not known).
/** @param {Package} p @returns {p is LocatedPackage} */
function located(p) { return !p.outside && !p.unknown; }

// The content of a copy of a lockfile, for its directory `to`: the record of the lockfile (anchored in `from`, see
// readMeta; contexts: as for readMeta) anchored at `to` (see anchorOf); the paths relative to the context and to the
// lockfile stay as they are (a copy of the output has its files where they were relative to the lockfile). null if
// the content has no record anchored in `from`.
/**
 * @param {string} json
 * @param {string} from
 * @param {string} to
 * @param {string[]} [contexts]
 * @returns {string | null}
 */
function reanchor(json, from, to, contexts = []) {
  const meta = readMeta(json, from, contexts);
  if (!meta || meta.anchored !== true || !meta.context) return null;
  const doc = parseJson(json);
  const record = isObject(doc) ? doc['bundle-lockfile'] : undefined;
  if (!isObject(doc) || !isObject(record)) return null; // (readMeta read it)
  const { context: c, self, contextId, selfId, v, ...rest } = record;
  // as given, through the same symbolic links as the writer's (a record without its paths: the reader's context)
  const context = typeof c === 'string' ? path.resolve(from, c) : contexts.find(x => realish(x) === meta.context) || meta.context;
  doc['bundle-lockfile'] = { v, ...anchorOf(context, to), ...rest };
  return JSON.stringify(doc, null, 2) + '\n';
}

module.exports = { cmp, toPackageLock, readMeta, unreadableRecord, NOT_JSON, reanchor, unknownPackage, located, VERSION };
