'use strict';
// Lockfiles shared by several compilers. Compilers can write to the same output directory, e.g. a config array
// whose app and service worker both go to dist/. They write the same lockfile, so that lockfile lists the
// packages of all of them - the last one to write it would otherwise drop the others' packages.
// Process-wide (also across copies of this module): compilers in other processes are not seen.
const { cmp, toPackageLock } = require('./lockfile.cjs');

const KEY = Symbol.for('bundle-lockfile.outputs.v2'); // v2: shape below; copies of another shape keep their own
// lockfile path -> Map(writer id -> { building, landed }); a writer is one compiler, across its (re)builds.
// building: { pkgs, context, files } of its build in progress, recorded before that build is written;
// landed: the same of its latest build whose output was written. A build that fails is never written
// (webpack's emitOnErrors: false): its packages must not replace those of the output still in the directory.
const outputs = globalThis[KEY] || (globalThis[KEY] = { files: new Map(), queues: new Map() });

// The packages in the output directory: every writer's landed build; for `own`, the build it is about to write.
function render(target, own) {
  const builds = [];
  for (const [id, w] of outputs.files.get(target) || []) {
    const b = id === own && w.building ? w.building : w.landed;
    if (b) builds.push(b);
  }
  const byPath = new Map();
  for (const b of builds) for (const p of b.pkgs) byPath.set(p.path, p);
  // keys are relative to one context; pick it independently of which writer finished last
  const context = builds.map(b => b.context).sort(cmp)[0];
  return toPackageLock([...byPath.values()], context);
}

// Records the packages `writer` puts into the output directory of `target` with the build it is about to
// write, and returns the content for `target`. files: absolute paths of the other files the writer emits
// there, to tell later whether they are still there (see prune).
function record(target, writer, pkgs, context, files = []) {
  let writers = outputs.files.get(target);
  if (!writers) outputs.files.set(target, (writers = new Map()));
  const w = writers.get(writer) || { building: null, landed: null };
  w.building = { pkgs, context, files };
  writers.set(writer, w);
  return render(target, writer);
}

// The writer's files of its latest build have landed.
function emitted(target, writer) {
  const w = (outputs.files.get(target) || new Map()).get(writer);
  if (w && w.building) { w.landed = w.building; w.building = null; }
}

const isShared = (target) => (outputs.files.get(target) || new Map()).size > 1;

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

// Parallel compilers can finish writing in any order, so one that wrote before another recorded its packages
// may land last. Each writer calls this after its own write has landed: writes of the same file run one after
// another, each with the content at the time it runs, so the last one has every writer's packages.
// writeFile(content, callback(err)) writes target; done() is called when this write has landed.
function rewrite(target, writeFile, done) {
  const prev = outputs.queues.get(target) || Promise.resolve();
  // never rejects: a failed write must neither stall the build nor the writes queued after it
  const next = prev.then(() => new Promise((resolve) => {
    try { writeFile(render(target), resolve); } catch (e) { resolve(e); }
  }));
  outputs.queues.set(target, next);
  next.then((err) => setImmediate(done, err)); // outside the promise: done() continues the build
}

module.exports = { record, emitted, isShared, prune, rewrite };
