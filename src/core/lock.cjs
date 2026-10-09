'use strict';
// Files that several processes write (see core/outputs.cjs): an exclusive lock across processes for a
// read-merge-write, and atomic replacement, so that readers without the lock never see a partial file.
const fs = require('fs');
const path = require('path');
const config = require('./config.cjs');

// Takes an exclusive lock on `file` across processes (a <file>.lock next to it); returns the function that releases
// it. A lock older than a minute (staleAfter) is from a process that died; one that cannot be taken in 30 s (wait) is
// skipped with a warning (the write goes ahead: a stalled build would be worse than a lockfile missing another
// process's packages).
function lock(file, { wait = 30000, staleAfter = 60000 } = {}) {
  const l = `${file}.lock`;
  const deadline = Date.now() + wait;
  try { fs.mkdirSync(path.dirname(l), { recursive: true }); } catch { return () => {}; }
  for (;;) {
    try {
      fs.closeSync(fs.openSync(l, 'wx'));
      const mine = fs.statSync(l);
      // not one another process took over as stale meanwhile (see takeStale)
      return () => { try { if (sameFile(fs.statSync(l), mine)) fs.unlinkSync(l); } catch { /* gone */ } };
    } catch (e) { if (e.code !== 'EEXIST') return () => {}; }
    let st;
    try { st = fs.statSync(l); } catch { continue; } // released meanwhile
    if (Date.now() - st.mtimeMs > staleAfter) { takeStale(l, st); continue; }
    if (Date.now() > deadline) { config.warn('could not lock', file, '- writing it without the lock'); return () => {}; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

const sameFile = (a, b) => a.ino === b.ino && a.dev === b.dev && a.mtimeMs === b.mtimeMs;

// Removes the stale lock `l` that had the stats `st` - not a lock another process has taken since: it is moved away
// first (only one process can move it), and put back if it is not the stale one.
function takeStale(l, st) {
  const away = `${l}.${process.pid}.${Math.random().toString(36).slice(2)}.stale`;
  try { fs.renameSync(l, away); } catch { return; } // another process took it first
  try {
    if (sameFile(fs.statSync(away), st)) return;
    try { fs.linkSync(away, l); } catch { /* a third one holds it now: it waits for that one like everyone else */ }
  } catch { /* gone */ } finally { try { fs.unlinkSync(away); } catch { /* gone */ } }
}

// Writes atomically: concurrent processes and readers see the old or the new file, never a partial one.
function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try { fs.writeFileSync(tmp, content); fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

module.exports = { lock, takeStale, writeAtomic };
