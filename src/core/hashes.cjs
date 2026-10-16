'use strict';
// SHA-256 of output files, as the lockfile records them ("sha256-<hex>", see toPackageLock's "outputs"), cached per
// file while its inode, size, mtime and ctime stay the same (mtime alone can stay: coarse file systems, tools that set
// it; ctime changes with every write, and a replaced file has another inode). One entry per file, at most MAX: a long watch session that changes the
// same files again and again must not grow it.
const fs = require('fs');
const crypto = require('crypto');
const lru = require('./lru.cjs');
const { perProcess } = require('./values.cjs');

const S = Symbol.for('bundle-lockfile.hashes.v1');
const MAX = 10000;
/** @type {{ files: Map<string, { key: string, hash: string }> }} */
const state = perProcess(S, () => ({ files: new Map() })); // file -> { key, hash }

// The hex SHA-256 of a string or Buffer; "sha256-<hex>" (as the lockfile records outputs); its first 16 hex digits,
// the ids the lockfile records (writers, remnants, a tree's packages, a context's)
/** @type {(data: string | Uint8Array) => string} */
const hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
/** @type {(data: string | Uint8Array) => string} */
const sha256 = (data) => `sha256-${hex(data)}`;
/** @type {(data: string | Buffer) => string} */
const shortHash = (data) => hex(data).slice(0, 16);

// The file's hash, or null if it cannot be read.
/**
 * @param {string} file
 * @returns {string | null}
 */
function hashOf(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  const known = state.files.get(file);
  if (known && known.key === key) return known.hash;
  let hash;
  try { hash = sha256(fs.readFileSync(file)); } catch { return null; }
  lru.set(state.files, file, { key, hash }, MAX);
  return hash;
}

module.exports = { hashOf, sha256, hex, shortHash, MAX, state };
