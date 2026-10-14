'use strict';
// Files that several processes write (see core/outputs.cjs): an exclusive lock across processes for a
// read-merge-write, and atomic replacement, so that readers without the lock never see a partial file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const problems = require('./problems.cjs');
/** @typedef {import('fs').Stats} Stats */

// Takes an exclusive lock on `file` across processes (a <file>.lock next to it); returns the function that releases
// it. A lock older than a minute (staleAfter) is from a process that died; one that cannot be taken in 30 s (wait) is
// skipped (the write goes ahead: a stalled build would be worse) - a problem (core/problems.cjs): the lockfile may miss
// the packages of another process writing it at the same time. So is a lock that cannot be created at all (the
// directory cannot be created, the file system refuses the file). A stale lock that cannot be removed (a directory
// another user owns, a read-only file system) is waited for like any other.
/**
 * @param {string} file
 * @param {{ wait?: number, staleAfter?: number }} [opts]
 * @returns {() => void}
 */
function lock(file, { wait = 30000, staleAfter = 60000 } = {}) {
  const l = `${file}.lock`;
  const deadline = Date.now() + wait;
  /** @type {(why: string, cause?: unknown) => () => void} */
  const without = (why, cause) => {
    problems.problem(`could not lock ${file}${why} - writing it without the lock (it may miss the packages of another process writing it at the same time)`, cause);
    return () => {};
  };
  for (let created = false; ;) {
    try {
      fs.closeSync(fs.openSync(l, 'wx'));
      const mine = fs.lstatSync(l);
      // not one another process took over as stale meanwhile (see takeStale)
      return () => { try { if (sameFile(fs.lstatSync(l), mine)) fs.unlinkSync(l); } catch { /* gone */ } };
    } catch (e) {
      if (e.code === 'ENOENT' && !created) { // no directory (yet, or no longer)
        created = true;
        try { fs.mkdirSync(path.dirname(l), { recursive: true }); } catch (m) { return without('', m); }
        continue;
      }
      if (e.code !== 'EEXIST') return without('', e);
    }
    created = false;
    let st;
    // lstat: a lock that is a symbolic link to nothing is there (open with wx fails on it), and is as old as the link
    try { st = fs.lstatSync(l); } catch (e) { if (e.code === 'ENOENT') continue; return without('', e); } // released meanwhile
    if (isStale(l, st, staleAfter) && takeStale(l, st)) continue;
    if (Date.now() > deadline) return without('');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

/** @type {(a: Stats, b: Stats) => boolean} */
const sameFile = (a, b) => a.ino === b.ino && a.dev === b.dev && a.mtimeMs === b.mtimeMs;

// The lock (with stats st) is older than staleAfter - by this machine's clock and by the file system's: a lock on a
// network file system has the server's time, and a client whose clock is ahead must not take over a live lock. The file
// system's time is that of a file made for it next to the lock (if that cannot be made: this machine's clock). A lock
// from further ahead in time than staleAfter is no live one either (touch -d 2099 would otherwise hold it forever).
/**
 * @param {string} l
 * @param {Stats} st
 * @param {number} staleAfter
 */
function isStale(l, st, staleAfter) {
  if (Math.abs(Date.now() - st.mtimeMs) <= staleAfter) return false;
  const probe = `${l}.${unique()}.now`;
  try {
    fs.closeSync(fs.openSync(probe, 'wx'));
    try { return Math.abs(fs.lstatSync(probe).mtimeMs - st.mtimeMs) > staleAfter; } finally { fs.unlinkSync(probe); }
  } catch { return true; }
}

// a part of a file name no other process or call uses (no name another user could make in advance)
const unique = () => `${process.pid}.${crypto.randomBytes(8).toString('hex')}`;

// Removes the stale lock `l` that had the stats `st` - not a lock another process has taken since: it is moved away
// first (only one process can move it), and put back if it is not the stale one. Returns whether the lock is gone, or
// was another process's and is back: false if it cannot be moved (another user's directory, a read-only file system).
// A file system without hard links cannot put back the very file: an empty lock in its place keeps the others out, and
// stays until it is stale (its holder releases only its own file).
/**
 * @param {string} l
 * @param {Stats} st
 */
function takeStale(l, st) {
  const away = `${l}.${unique()}.stale`;
  try { fs.renameSync(l, away); } catch (e) { return e.code === 'ENOENT'; } // ENOENT: another process took it first
  try {
    if (sameFile(fs.lstatSync(away), st)) return true;
    try { fs.linkSync(away, l); } catch (e) {
      // EEXIST: a third one holds it now, and it waits for that one like everyone else
      if (e.code !== 'EEXIST') { try { fs.closeSync(fs.openSync(l, 'wx')); } catch { /* a third one holds it */ } }
    }
  } catch { /* gone */ } finally { try { fs.unlinkSync(away); } catch { /* gone */ } }
  return true;
}

// Writes atomically: concurrent processes and readers see the old or the new file, never a partial one. The temporary
// file is a new one (wx: never through a symbolic link or into a file that is there).
/**
 * @param {string} file
 * @param {string | NodeJS.ArrayBufferView} content
 */
function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${unique()}.tmp`;
  const fd = fs.openSync(tmp, 'wx');
  try {
    try { fs.writeFileSync(fd, content); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

module.exports = { lock, takeStale, writeAtomic };
