'use strict';
// Packages in the output of builds that write nothing themselves (generate-only: Rollup's bundle.generate(),
// write: false): another build or tool puts that output into its own. Vite bundles each worker with a nested build
// and emits its chunks as assets of the parent build (or inlines a ?worker&inline one as a string into the module
// that imports it); @vitejs/plugin-legacy builds the polyfills and adds the chunk to the parent bundle; workbox-build
// (vite-plugin-pwa's generateSW) generates sw.js and workbox-<hash>.js and writes them into dist/ with fs after the
// build. In-process only: these builds run in the process of the build that uses their output.
const crypto = require('crypto');
const lru = require('./lru.cjs');

const S = Symbol.for('bundle-lockfile.generated.v1');
const MAX = 10000; // entries of each map; a long dev or watch session must not grow them forever
// hash of the content -> packages of that chunk; entry file -> packages of its whole build
const state = globalThis[S] || (globalThis[S] = { content: new Map(), entries: new Map() });

// workbox-build appends "//# sourceMappingURL=<file>.map" to the code it writes when it generates source maps
const SOURCE_MAP = /\n?\/\/# sourceMappingURL=[^\n]*\n?$/;

function hash(code) {
  const s = typeof code === 'string' ? code : Buffer.isBuffer(code) || code instanceof Uint8Array ? Buffer.from(code).toString('utf8') : null;
  if (s == null) return null;
  return crypto.createHash('sha256').update(s.replace(SOURCE_MAP, '')).digest('hex');
}

// A chunk of a generate-only build with its packages ([{ name, version, license, path }]).
function addChunk(code, pkgs) {
  const h = hash(code);
  if (h && pkgs.length) lru.set(state.content, h, pkgs, MAX);
}

// The entry file of a generate-only build with the packages of all its chunks.
function addEntry(file, pkgs) {
  if (file && pkgs.length) lru.set(state.entries, file, pkgs, MAX);
}

// Packages of a generate-only chunk whose content (string, Buffer or Uint8Array) this is, or null.
function byContent(code) {
  if (!state.content.size) return null;
  const h = hash(code);
  return (h && state.content.get(h)) || null;
}

// Packages of the generate-only build with this entry file, or null.
function byEntry(file) {
  return state.entries.get(file) || null;
}

module.exports = { addChunk, addEntry, byContent, byEntry, hash };
