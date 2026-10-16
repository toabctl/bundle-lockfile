'use strict';
// Next.js' file traces (.nft.json): the files a server loads at runtime, which Next.js writes next to each server
// entry (.next/server/pages/*.js.nft.json, .next/server/app/**/*.nft.json) and for its own server
// (.next/next-server.js.nft.json, .next/next-minimal-server.js.nft.json) - with webpack @vercel/nft's, with Turbopack
// Next's own tracer, in the same format: { version: 1, files: [paths relative to the trace file] } (Turbopack's also
// has fileHashes and symlinks). Next copies these files into .next/standalone; without standalone the server loads
// them from the project's node_modules.
const fs = require('fs');
const path = require('path');

// Directories of distDir that hold no traces of this build: Next's caches, the standalone copy (which has copies of
// the traces), the client output, Turbopack's diagnostics and its links to external packages
const SKIP = new Set(['cache', 'standalone', 'static', 'diagnostics', 'node_modules', 'trace']);

// The files below distDir for which test(path) holds, sorted, but those in its directories `skip` (also adapters/next.cjs:
// the lockfiles of the build's bundles). Throws if a directory cannot be read (that is not gone).
/**
 * @param {string} distDir
 * @param {Set<string>} skip
 * @param {(file: string) => boolean} test
 * @returns {string[]}
 */
function filesBelow(distDir, skip, test) {
  /** @type {string[]} */
  const out = [];
  /** @type {(d: string, top: boolean) => void} */
  const walk = (d, top) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return; throw e; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!(top && skip.has(e.name))) walk(p, false); } else if (e.isFile() && test(p)) out.push(p);
    }
  };
  walk(distDir, true);
  return out.sort();
}

// The trace files below distDir
/** @type {(distDir: string) => string[]} */
const traceFiles = (distDir) => filesBelow(distDir, SKIP, (f) => f.endsWith('.nft.json'));

// The absolute paths of the files one trace lists; throws an Error saying what is wrong with it
/**
 * @param {string} traceFile
 * @returns {string[]}
 */
function filesOf(traceFile) {
  /** @type {any} */
  let j;
  try { j = JSON.parse(fs.readFileSync(traceFile, 'utf8')); } catch (e) {
    throw new Error(`could not read ${traceFile}: ${/** @type {Error} */ (e).message}`, { cause: e });
  }
  if (!j || typeof j !== 'object' || j.version !== 1) throw new Error(`${traceFile} is a trace of a version bundle-lockfile does not know (${j && j.version})`);
  if (!Array.isArray(j.files) || j.files.some(/** @param {unknown} f */ f => typeof f !== 'string')) throw new Error(`${traceFile} has no list of files`);
  const dir = path.dirname(traceFile);
  return j.files.map(/** @param {string} f */ f => path.resolve(dir, f));
}

module.exports = { filesBelow, traceFiles, filesOf };
