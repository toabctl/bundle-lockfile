'use strict';
// A package directory's package.json: its name, version and license; and lists of packages, each once. Shared by the
// modules that map files to packages (packages.cjs, vendored.cjs, nested.cjs), the ones that check a recorded package is
// still where it was (outputs.cjs) and the adapters. No dependencies but Node's: the ESM loader thread uses it too
// (core/layout.cjs).
/** @import { LocatedPackage, Manifest, Package } from '../types' */
const fs = require('fs');
const path = require('path');

// "license": "MIT", the legacy {"type": "MIT"} or "licenses": [{"type": "MIT"}, "ISC"]
/**
 * @param {Manifest} j
 * @returns {string | string[] | undefined}
 */
function licenseOf(j) {
  /** @type {(l: any) => string | undefined} */
  const one = (l) => (typeof l === 'string' ? l : l && typeof l.type === 'string' ? l.type : undefined);
  if (j.license !== undefined) return one(j.license);
  if (!Array.isArray(j.licenses)) return undefined;
  const all = /** @type {string[]} */ (j.licenses.map(one).filter(Boolean));
  return all.length ? all : undefined;
}

// The content of dir/package.json, or null. A leading byte order mark is valid UTF-8 that JSON.parse rejects; npm
// strips it too.
/**
 * @param {string} dir
 * @returns {Manifest | null}
 */
function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

// { name, version, path: dir, license } of package.json content j, or null without name and version
/**
 * @param {Manifest | null} j
 * @param {string} dir
 * @returns {LocatedPackage | null}
 */
function packageOf(j, dir) {
  if (!j || typeof j.name !== 'string' || !j.name || typeof j.version !== 'string' || !j.version) return null;
  return { name: j.name, version: j.version, path: dir, license: licenseOf(j) };
}

/** @type {(dir: string) => LocatedPackage | null} */
const readPackage = (dir) => packageOf(readManifest(dir), dir);

// The "version" of dir/package.json, or null
/** @type {(dir: string) => string | null} */
const versionIn = (dir) => { const j = readManifest(dir); return j && typeof j.version === 'string' && j.version ? j.version : null; };

// The packages of any number of lists, each once (by path: the first one). lists: an iterable of them, of any length -
// unique(...lists) for a few; uniqueOf(lists) for one per file, which as arguments would exceed what a call can take.
/** @param {Iterable<Iterable<Package>>} lists @returns {Package[]} */
function uniqueOf(lists) {
  /** @type {Map<string, Package>} */
  const m = new Map();
  for (const l of lists) for (const p of l) if (!m.has(p.path)) m.set(p.path, p);
  return [...m.values()];
}
/** @param {...Iterable<Package>} lists @returns {Package[]} */
const unique = (...lists) => uniqueOf(lists);

module.exports = { readPackage, readManifest, packageOf, licenseOf, versionIn, unique, uniqueOf };
