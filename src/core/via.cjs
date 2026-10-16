'use strict';
// How a writer found each of its packages (the "via" of its record, see docs/format.md): the routes by which a
// package reached the output. A package can have several (a module of a chunk, and a style sheet a style sheet
// @imports from it), and the record lists it under each.
// - chunk: a module of a chunk (bundle) the build writes belongs to the package
// - child: a module of a shipped webpack or rspack child compilation (a worker, a service worker)
// - asset: a file an asset of a Rollup, Rolldown or Vite build was emitted from (a font, an image)
// - copy-source: a file copied into the output whose asset names its source (copy-webpack-plugin's sourceFilename)
// - copy-bytes: a file copied into the output that names no source, matched by its bytes
// - style: a style sheet a loader or plugin inlined into a module (a style sheet's @imports, Sass partials)
// - inlined: another file a loader or plugin inlined into a module (an image or font as a data: URL, a shader's
//   #includes, JSON)
// - inlined-exports: a module in no chunk whose exports rspack inlined where they are used
// - generated: the output of a build that writes nothing itself, found by its bytes or its entry (Vite's workers)
// - late: a file another plugin wrote into the output after the build
// - fs-copy: a file copied out of a package with fs, in this process
// - nested: a file another build wrote, as its lockfile records
// - vendored: a vendored copy, inside a package or outside node_modules
// - traced: a file Next.js traced for its server, which loads it from node_modules at runtime (adapters/next.cjs)
// - runtime: the bundler itself, whose code (runtime, chunk wrappers, helpers) is in the JavaScript it writes
// - helpers: a transpiler whose helpers it inlined into a shipped module (Babel's, swc's, TypeScript's: core/helpers.cjs)
/** @import { FilePackages, ViaCollector } from '../types' */
const { getOr } = require('./maps.cjs');

const CLASSES = ['chunk', 'child', 'asset', 'copy-source', 'copy-bytes', 'style', 'inlined', 'inlined-exports', 'generated',
  'late', 'fs-copy', 'nested', 'vendored', 'traced', 'runtime', 'helpers'];
const KNOWN = new Set(CLASSES);

// A collector: add(cls, packages) records that the packages were found that way; byPath: package path -> Set(cls).
/** @returns {ViaCollector} */
function collector() {
  /** @type {ViaCollector['byPath']} */
  const byPath = new Map();
  /** @type {ViaCollector['add']} */
  const add = (cls, pkgs) => {
    if (!KNOWN.has(cls)) throw new Error(`unknown via class ${cls}`);
    for (const p of pkgs || []) getOr(byPath, p.path, () => new Set()).add(cls);
  };
  // the classes of another collector (or a Map(path -> iterable of classes))
  /** @type {ViaCollector['merge']} */
  const merge = (other) => {
    for (const [p, list] of /** @type {Iterable<[string, Iterable<string>]>} */ ((other && /** @type {ViaCollector} */ (other).byPath) || other || []))
      for (const cls of list) add(cls, [{ path: p }]);
  };
  return { add, merge, byPath };
}

// The classes of packagesOfFiles' result (core/packages.cjs): each file's own packages by the classes kindOf gives the
// file (a class or a Set of them; default: chunk), and what the resolver found (fs-copy, vendored, nested).
/**
 * @param {Pick<FilePackages, 'ownByFile' | 'via'>} result
 * @param {Map<string, string | Set<string>>} [kindOf]
 * @param {string} [def]
 * @returns {ViaCollector}
 */
function ofFiles(result, kindOf = new Map(), def = 'chunk') {
  const c = collector();
  for (const [f, pkgs] of result.ownByFile) {
    const k = kindOf.get(f);
    for (const cls of k instanceof Set ? (k.size ? k : [def]) : [k || def]) c.add(cls, pkgs);
  }
  c.merge(result.via);
  return c;
}

module.exports = { CLASSES, KNOWN, collector, ofFiles };
