'use strict';
// Packages in the output of builds that write nothing themselves (generate-only: Rollup's bundle.generate(),
// write: false): another build or tool puts that output into its own. Vite bundles each worker with a nested build
// and emits its chunks as assets of the parent build (or inlines a ?worker&inline one as a string into the module
// that imports it); @vitejs/plugin-legacy builds the polyfills and adds the chunk to the parent bundle; workbox-build
// (vite-plugin-pwa's generateSW) generates sw.js and workbox-<hash>.js and writes them into dist/ with fs after the
// build. In-process only: these builds run in the process of the build that uses their output.
const crypto = require('crypto');
const config = require('./config.cjs');
const lru = require('./lru.cjs');

const S = Symbol.for('bundle-lockfile.generated.v1');
const MAX = 10000; // entries of each map; a long dev or watch session must not grow them forever
// hash of the content -> packages of that chunk; entry file -> packages of its whole build; hash of an asset's content ->
// packages of the files it was emitted from
const state = globalThis[S] || (globalThis[S] = { content: new Map(), entries: new Map() });
if (!state.assets) state.assets = new Map();
// content hash -> packages of the generate-only chunks no written output had the bytes of (yet): looked at when the
// process ends (see unlanded)
if (!state.unmatched) state.unmatched = new Map();

// Every bounded map that drops its oldest entries warns once per process: their packages are no longer listed where
// their bytes end up
function bounded(map, key, value) {
  if (lru.set(map, key, value, MAX) && !state.warned) {
    state.warned = true;
    config.warn(`more than ${MAX} chunks of builds that write nothing themselves (generate(), write: false) in this process: the oldest are forgotten, their packages are no longer listed where their bytes end up`);
  }
}

// When the process ends: the packages of generate-only chunks whose bytes reached no written output and that no
// lockfile of this process lists - a generate() build whose output its caller put somewhere bundle-lockfile does not
// look (or nowhere: a build that only analyses). A warning (a debug line for the rest), not a problem: a build that
// generates only to look at the output ships nothing.
function unlanded() {
  if (!state.unmatched.size) return;
  const listed = require('./outputs.cjs').listedPaths();
  const missing = new Map();
  for (const pkgs of state.unmatched.values()) for (const p of pkgs) if (!listed.has(p.path)) missing.set(p.path, p);
  config.debug(`${state.unmatched.size} chunk(s) of builds that write nothing themselves reached no written output`);
  if (!missing.size) return;
  const names = [...missing.values()].map(p => `${p.name}@${p.version}`).sort();
  config.warn(`the output of a build that writes nothing itself (generate(), write: false) reached no output this process wrote, so no lockfile lists ${names.slice(0, 10).join(', ')}${names.length > 10 ? `, and ${names.length - 10} more` : ''} (if that output ships, it ships without them)`);
}

// workbox-build appends "//# sourceMappingURL=<file>.map" to the code it writes when it generates source maps
const SOURCE_MAP = /\n?\/\/# sourceMappingURL=[^\n]*\n?$/;

// The hash of a chunk's or an asset's content: of its text without a trailing source map comment, the same for a string
// and its UTF-8 bytes; of the bytes themselves for a binary asset (a font, wasm), which is no UTF-8 text.
function hash(code) {
  let data = null;
  if (typeof code === 'string') data = code.replace(SOURCE_MAP, '');
  else if (Buffer.isBuffer(code) || code instanceof Uint8Array) {
    const buf = Buffer.from(code.buffer, code.byteOffset, code.byteLength), text = buf.toString('utf8');
    data = Buffer.from(text, 'utf8').equals(buf) ? text.replace(SOURCE_MAP, '') : buf;
  }
  return data == null ? null : crypto.createHash('sha256').update(data).digest('hex');
}

// A chunk of a generate-only build with its packages ([{ name, version, license, path }]).
function addChunk(code, pkgs) {
  const h = hash(code);
  if (!h || !pkgs.length) return;
  bounded(state.content, h, pkgs);
  if (!state.exit) { state.exit = true; process.on('exit', () => { try { unlanded(); } catch (e) { config.debug('generated: could not check', e); } }); }
  if (state.unmatched.size < MAX) state.unmatched.set(h, pkgs);
}

// An asset of a generate-only build emitted from package files (a worker's font or wasm) with their packages: the build
// that uses the worker emits its bytes again, without naming the files.
function addAsset(source, pkgs) {
  const h = hash(source);
  if (h && pkgs.length) bounded(state.assets, h, pkgs);
}

// The entry file of a generate-only build with the packages of all its chunks.
function addEntry(file, pkgs) {
  if (file && pkgs.length) bounded(state.entries, file, pkgs);
}

// Whether any generate-only chunk is known (else there is nothing to look up).
const any = () => state.content.size > 0;

// Packages of a generate-only chunk whose content (string, Buffer or Uint8Array) this is, or null.
function byContent(code) {
  if (!state.content.size) return null;
  const h = hash(code);
  const pkgs = (h && state.content.get(h)) || null;
  if (pkgs) state.unmatched.delete(h);
  return pkgs;
}

// Packages of a generate-only asset whose content this is, or null.
function byAsset(source) {
  if (!state.assets.size) return null;
  const h = hash(source);
  return (h && state.assets.get(h)) || null;
}

// Packages of the generate-only build with this entry file, or null.
function byEntry(file) {
  const pkgs = state.entries.get(file) || null;
  // a ?worker&inline build: its chunks are inlined as strings into the importing module
  if (pkgs) {
    const paths = new Set(pkgs.map(p => p.path));
    for (const [h, chunk] of state.unmatched) if (chunk.every(p => paths.has(p.path))) state.unmatched.delete(h);
  }
  return pkgs;
}

module.exports = { addChunk, addAsset, addEntry, any, byContent, byAsset, byEntry, hash };
