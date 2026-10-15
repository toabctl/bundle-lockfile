'use strict';
// Files that several processes write (see core/outputs.cjs): an exclusive lock across processes for a
// read-merge-write, and atomic replacement, so that readers without the lock never see a partial file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const problems = require('./problems.cjs');
/** @typedef {import('fs').Stats} Stats */

// Takes an exclusive lock on `file` across processes (a <file>.lock next to it); resolves with the function that
// releases it. While another process holds it, the event loop runs on (a dev server or another compiler of this process
// keeps working): it is tried again every 20 ms. A lock names its holder (see holder): one of a process of this machine
// that is gone is stale at once (a build killed while it wrote); any lock older than a minute (staleAfter) is stale too;
// one that cannot be taken in 30 s (wait) is skipped (the write goes ahead: a stalled build would be worse) - a problem
// (core/problems.cjs): the lockfile may miss the packages of another process writing it at the same time. So is a lock
// that cannot be created at all (the directory cannot be created, the file system refuses the file). A stale lock that
// cannot be removed (a directory another user owns, a read-only file system) is waited for like any other.
/**
 * @param {string} file
 * @param {{ wait?: number, staleAfter?: number }} [opts]
 * @returns {Promise<() => void>}
 */
async function lock(file, { wait = 30000, staleAfter = 60000 } = {}) {
  const l = `${file}.lock`;
  const deadline = Date.now() + wait;
  /** @type {(why: string, cause?: unknown) => () => void} */
  const without = (why, cause) => {
    problems.problem(`could not lock ${file}${why} - writing it without the lock (it may miss the packages of another process writing it at the same time)`, cause);
    return () => {};
  };
  for (let created = false; ;) {
    try {
      const fd = fs.openSync(l, 'wx');
      try { fs.writeSync(fd, HOLDER); } catch { /* a lock without its holder: stale by its age */ } finally { fs.closeSync(fd); }
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
    if ((holderGone(l) || isStale(l, st, staleAfter)) && takeStale(l, st)) continue;
    if (Date.now() > deadline) return without('');
    await sleep(20);
  }
}
/** @type {(ms: number) => Promise<void>} */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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

// What a lock says about its holder: this machine (its host name, and the PID namespace: containers on one host may
// share a host name and a volume, not their process numbers) and the process
const pidNamespace = (() => { try { return fs.readlinkSync('/proc/self/ns/pid'); } catch { return ''; } })();
const HOLDER = JSON.stringify({ host: os.hostname(), ns: pidNamespace, pid: process.pid });
// The lock `l` is held by a process of this machine (the same host name and PID namespace) that is gone
/** @param {string} l */
function holderGone(l) {
  let h;
  try { h = JSON.parse(fs.readFileSync(l, 'utf8')); } catch { return false; } // (empty, or another shape: by its age)
  if (!h || h.host !== os.hostname() || h.ns !== pidNamespace || !Number.isInteger(h.pid) || h.pid <= 0 || h.pid === process.pid) return false;
  try { process.kill(h.pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } // (EPERM: another user's, alive)
}

// Removes the stale lock `l` that had the stats `st` - not a lock another process has taken since. One process at a time
// takes over a stale lock (<lock>.takeover, created exclusively): it looks at the lock again, and moves it away only if
// it is still the stale one - another process that saw the same stale lock cannot move the new lock of the one that
// took over before it. The lock is moved away first and put back if it is not the stale one after all (its holder
// released it and another took it in between). Returns whether to look again at once: the lock is gone, or is another
// one now; false while another process takes over, or if the lock cannot be moved (another user's directory, a
// read-only file system) - it is waited for then. A takeover left by a process that died during it is removed once it
// is older than TAKEOVER_STALE.
/**
 * @param {string} l
 * @param {Stats} st
 */
function takeStale(l, st) {
  const t = `${l}.takeover`;
  try { fs.closeSync(fs.openSync(t, 'wx')); } catch (e) {
    if (e.code === 'EEXIST') { try { if (Date.now() - fs.lstatSync(t).mtimeMs > TAKEOVER_STALE) fs.unlinkSync(t); } catch { /* gone */ } }
    return false;
  }
  try {
    let now;
    try { now = fs.lstatSync(l); } catch { return true; } // released meanwhile
    if (!sameFile(now, st)) return true; // another lock now
    const away = `${l}.${unique()}.stale`;
    try { fs.renameSync(l, away); } catch (e) { return e.code === 'ENOENT'; }
    try {
      if (!sameFile(fs.lstatSync(away), st)) {
        try { fs.linkSync(away, l); } catch (e) {
          // EEXIST: a third one holds it now, and it waits for that one like everyone else; a file system without hard
          // links cannot put back the very file: an empty lock in its place keeps the others out until it is stale
          if (e.code !== 'EEXIST') { try { fs.closeSync(fs.openSync(l, 'wx')); } catch { /* a third one holds it */ } }
        }
      }
    } catch { /* gone */ } finally { try { fs.unlinkSync(away); } catch { /* gone */ } }
    return true;
  } finally { try { fs.unlinkSync(t); } catch { /* gone */ } }
}
const TAKEOVER_STALE = 10000;

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
