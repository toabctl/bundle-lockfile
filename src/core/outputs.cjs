'use strict';
// Lockfiles shared by several compilers. Compilers can write to the same output directory, e.g. a config array
// whose app and service worker both go to dist/. They write the same lockfile, so that lockfile lists the
// packages of all of them - the last one to write it would otherwise drop the others' packages.
// Process-wide (also across copies of this module). Compilers in other processes (e.g. two webpack commands run in
// parallel) are seen through the lockfile itself: it records which writer put which packages and files there (see
// toPackageLock), and a writer keeps the others' packages as long as their files are there.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config.cjs');
const { cmp, toPackageLock, readMeta } = require('./lockfile.cjs');

const KEY = Symbol.for('bundle-lockfile.outputs.v2'); // v2: shape below; copies of another shape keep their own
// lockfile path -> Map(writer id -> { building, landed }); a writer is one compiler, across its (re)builds.
// building: { pkgs, context, files } of its build in progress, recorded before that build is written;
// landed: the same of its latest build whose output was written. A build that fails is never written
// (webpack's emitOnErrors: false): its packages must not replace those of the output still in the directory.
// Each writer also has an id: the one recorded in the lockfile, the same in every process and on every machine.
// disk: lockfile path -> its output is on the real disk, where other processes may write it too (not, e.g., a
// webpack-dev-server's in-memory file system).
const outputs = globalThis[KEY] || (globalThis[KEY] = { files: new Map(), queues: new Map(), disk: new Map() });

// The file other processes see: the lockfile in the output, or its export copy if it is not written inline.
const stateFile = (target) => (config.inline ? target : exportPath(target));

// Writers of `target` recorded by other processes (in the lockfile on disk) whose files are still there (all:
// also those whose files are gone), except those with an id in `own` (this process has their newest build):
// [{ id, pkgs, files, count, context }].
function foreign(target, own, all = false) {
  const file = outputs.disk.get(target) && stateFile(target);
  if (!file) return [];
  let json;
  try { json = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const meta = readMeta(json, path.dirname(target));
  if (!meta) return [];
  return meta.writers.filter(w => !own.has(w.id) && (all || !w.files.length || w.files.some(f => fs.existsSync(f))))
    .map(w => ({ id: w.id, pkgs: w.pkgs, files: w.files, count: w.count, outputs: w.outputs, context: meta.context }));
}

// The packages in the output directory: every writer's landed build; for `own`, the build it is about to write;
// writers in other processes whose files are there.
function render(target, own) {
  const builds = [];
  const ids = new Set();
  for (const [id, w] of outputs.files.get(target) || []) {
    ids.add(w.id);
    const b = id === own && w.building ? w.building : w.landed;
    if (b) builds.push({ ...b, id: w.id });
  }
  builds.push(...foreign(target, ids));
  const byPath = new Map();
  for (const b of builds) for (const p of b.pkgs) byPath.set(p.path, p);
  // keys are relative to one context; pick it independently of which writer finished last
  const context = builds.map(b => b.context).sort(cmp)[0];
  const writers = builds.map(b => ({ id: b.id, files: b.files, count: b.count, outputs: b.outputs, paths: b.pkgs.map(p => p.path) }));
  return toPackageLock([...byPath.values()], context, { dir: path.dirname(target), writers });
}

// Records the packages `writer` puts into the output directory of `target` with the build it is about to
// write, and returns the content for `target`. files: absolute paths of the other files the writer emits
// there, to tell later whether they are still there (see prune). opts.id: the writer's id in the lockfile (default:
// a hash of `writer`, which therefore must not contain machine-specific paths); opts.disk: see outputs.disk;
// opts.outputs: { absolute path: "sha256-<hex>" } of its JavaScript output files (see core/nested.cjs).
function record(target, writer, pkgs, context, files = [], opts = {}) {
  let writers = outputs.files.get(target);
  if (!writers) outputs.files.set(target, (writers = new Map()));
  const w = writers.get(writer) || { building: null, landed: null };
  w.id = opts.id || crypto.createHash('sha256').update(writer).digest('hex').slice(0, 16);
  w.building = { pkgs, context, files, outputs: opts.outputs || {} };
  writers.set(writer, w);
  if (opts.disk) outputs.disk.set(target, true);
  return render(target, writer);
}

// The writer's files of its latest build have landed.
function emitted(target, writer) {
  const w = (outputs.files.get(target) || new Map()).get(writer);
  if (w && w.building) { w.landed = w.building; w.building = null; }
}

// Another compiler, in this process or another one, writes `target` too - or did: a lockfile on disk that
// lists another process's writer, also one whose files are gone (deleted by output.clean after this compiler
// rendered its lockfile), is written again without it.
function isShared(target) {
  const writers = outputs.files.get(target) || new Map();
  return writers.size > 1 || foreign(target, new Set([...writers.values()].map(w => w.id)), true).length > 0;
}

// Drops the other writers whose files are all gone from the output directory, e.g. deleted by webpack's
// output.clean of `writer`, which removes what the others had written before it (except paths matching
// clean.keep; on watch rebuilds it removes only its own stale files). Only builds that have landed are
// checked: one still building has not written its files yet. If some of a writer's files are left, all its
// packages stay - listing a package too many is safer than missing one.
// exists(file, callback(boolean)); done() is called when every check has finished.
function prune(target, writer, exists, done) {
  const writers = outputs.files.get(target);
  const others = writers ? [...writers].filter(([id, w]) => id !== writer && w.landed && w.landed.files.length) : [];
  let pending = others.length;
  if (!pending) return done();
  for (const [id, w] of others) {
    const landed = w.landed;
    const next = (i) => {
      if (i === landed.files.length) {
        if (w.landed === landed) w.landed = null; // unless a newer build landed meanwhile
        if (!w.landed && !w.building && writers.get(id) === w) writers.delete(id);
        return finish();
      }
      exists(landed.files[i], (found) => (found ? finish() : next(i + 1)));
    };
    next(0);
  }
  function finish() { if (--pending === 0) done(); }
}

// Where the export copy of the lockfile `target` goes (BUNDLE_LOCKFILE_EXPORT_DIR, or null): the target's path
// mirrored below the export dir - relative to BUNDLE_LOCKFILE_EXPORT_BASE if it is below that, else its absolute
// path without the root (/srv/app/dist/bundle-lockfile/package-lock.json -> <export>/srv/app/dist/bundle-lockfile/
// package-lock.json; Windows: C:\app\... -> <export>/C/app/...). The file name stays package-lock.json, which syft
// requires, and outputs of different builds and processes never collide.
function exportPath(target) {
  if (!config.exportDir) return null;
  const abs = path.resolve(target);
  const rel = config.exportBase && path.relative(config.exportBase, abs);
  const inBase = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const { root } = path.parse(abs);
  return path.join(config.exportDir, inBase ? rel : path.join(root.replace(/[:\\/]+/g, '') || '.', abs.slice(root.length)));
}

// Takes an exclusive lock on `file` across processes (a <file>.lock next to it); returns the function that releases
// it. A lock older than a minute is from a process that died; one that cannot be taken in 30 s is skipped with a
// warning (the write goes ahead: a stalled build would be worse than a lockfile missing another process's packages).
function lock(file) {
  const l = `${file}.lock`;
  const deadline = Date.now() + 30000;
  try { fs.mkdirSync(path.dirname(l), { recursive: true }); } catch { return () => {}; }
  for (;;) {
    try { fs.closeSync(fs.openSync(l, 'wx')); return () => { try { fs.unlinkSync(l); } catch { /* gone */ } }; }
    catch (e) { if (e.code !== 'EEXIST') return () => {}; }
    try { if (Date.now() - fs.statSync(l).mtimeMs > 60000) { fs.unlinkSync(l); continue; } } catch { continue; }
    if (Date.now() > deadline) { config.warn('could not lock', file, '- writing it without the lock'); return () => {}; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

// Writes atomically: concurrent processes and readers see the old or the new file, never a partial one.
function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try { fs.writeFileSync(tmp, content); fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

// Parallel compilers can finish writing in any order, so one that wrote before another recorded its packages
// may land last. Each writer calls this after its own write has landed: writes of the same file run one after
// another, each with the content at the time it runs, so the last one has every writer's packages. Across
// processes, the lock makes each read-merge-write see the previous one.
// writeFile(content, callback(err)) writes target (null: only the export copy, see exportPath); done(err) is
// called when this write has landed.
function rewrite(target, writeFile, done) {
  const prev = outputs.queues.get(target) || Promise.resolve();
  // never rejects: a failed write must neither stall the build nor the writes queued after it
  const next = prev.then(() => new Promise((resolve) => {
    let release = () => {};
    const finish = (err) => { release(); resolve(err); };
    try {
      const shared = outputs.disk.get(target) && stateFile(target);
      if (shared) release = lock(shared);
      const content = render(target);
      const exported = (err) => {
        const file = exportPath(target);
        if (file) try { writeAtomic(file, content); } catch (e) { return finish(err || e); }
        finish(err);
      };
      if (writeFile) writeFile(content, exported); else exported();
    } catch (e) { finish(e); }
  }));
  outputs.queues.set(target, next);
  next.then((err) => setImmediate(done, err)); // outside the promise: done() continues the build
}

// The files the writers of `target` in this process emit there (their builds in progress and landed).
function filesOf(target) {
  const all = new Set();
  for (const w of (outputs.files.get(target) || new Map()).values()) {
    for (const b of [w.building, w.landed]) if (b) for (const f of b.files) all.add(f);
  }
  return all;
}

module.exports = { record, emitted, isShared, prune, rewrite, exportPath, filesOf };
