'use strict';
// SHA-256 of output files, as the lockfile records them ("sha256-<hex>", see toPackageLock's "outputs"), cached per
// file while its size and mtime stay the same. One entry per file, at most MAX: a long watch session that changes the
// same files again and again must not grow it.
const fs = require('fs');
const crypto = require('crypto');
const lru = require('./lru.cjs');

const S = Symbol.for('bundle-lockfile.hashes.v1');
const MAX = 10000;
const state = globalThis[S] || (globalThis[S] = { files: new Map() }); // file -> { size, mtimeMs, hash }

// "sha256-<hex>" of a string or Buffer
const sha256 = (data) => `sha256-${crypto.createHash('sha256').update(data).digest('hex')}`;

// The file's hash, or null if it cannot be read.
function hashOf(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const known = state.files.get(file);
  if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) return known.hash;
  let hash;
  try { hash = sha256(fs.readFileSync(file)); } catch { return null; }
  lru.set(state.files, file, { size: st.size, mtimeMs: st.mtimeMs, hash }, MAX);
  return hash;
}

module.exports = { hashOf, sha256, MAX, state };
