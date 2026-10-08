'use strict';
// SHA-256 of output files, as the lockfile records them ("sha256-<hex>", see toPackageLock's "outputs"), cached per
// file while its size and mtime stay the same. One entry per file, at most MAX: a long watch session that changes the
// same files again and again must not grow it.
const fs = require('fs');
const crypto = require('crypto');

const S = Symbol.for('bundle-lockfile.hashes.v1');
const MAX = 10000;
const state = globalThis[S] || (globalThis[S] = { files: new Map() }); // file -> { size, mtimeMs, hash }

// The file's hash, or null if it cannot be read.
function hashOf(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const known = state.files.get(file);
  if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) return known.hash;
  let hash;
  try { hash = `sha256-${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`; } catch { return null; }
  state.files.delete(file); // re-inserted as the newest
  state.files.set(file, { size: st.size, mtimeMs: st.mtimeMs, hash });
  while (state.files.size > MAX) state.files.delete(state.files.keys().next().value);
  return hash;
}

module.exports = { hashOf, MAX, state };
