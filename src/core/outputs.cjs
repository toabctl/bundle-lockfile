'use strict';
// Lockfiles shared by several compilers. Compilers can write to the same output directory, e.g. a config array
// whose app and service worker both go to dist/. They write the same lockfile, so that lockfile lists the
// packages of all of them - the last one to write it would otherwise drop the others' packages.
// Process-wide (also across copies of this module): compilers in other processes are not seen.
const { cmp, toPackageLock } = require('./lockfile.cjs');

const KEY = Symbol.for('bundle-lockfile.outputs');
// lockfile path -> Map(writer id -> { pkgs, context, files, emitted }); a writer is one compiler, across its (re)builds
const outputs = globalThis[KEY] || (globalThis[KEY] = { files: new Map(), queues: new Map() });

function render(target) {
  const writers = [...outputs.files.get(target).values()];
  const byPath = new Map();
  for (const w of writers) for (const p of w.pkgs) byPath.set(p.path, p);
  // keys are relative to one context; pick it independently of which writer finished last
  const context = writers.map(w => w.context).sort(cmp)[0];
  return toPackageLock([...byPath.values()], context);
}

// Records the packages `writer` puts into the output directory of `target` and returns the content for
// `target`. files: absolute paths of the other files the writer emits there, to tell later whether they are
// still there (see prune).
function record(target, writer, pkgs, context, files = []) {
  let writers = outputs.files.get(target);
  if (!writers) outputs.files.set(target, (writers = new Map()));
  writers.set(writer, { pkgs, context, files, emitted: false });
  return render(target);
}

// The writer's files of its latest build have landed.
function emitted(target, writer) {
  const w = (outputs.files.get(target) || new Map()).get(writer);
  if (w) w.emitted = true;
}

const isShared = (target) => (outputs.files.get(target) || new Map()).size > 1;

// Drops the other writers whose files are all gone from the output directory, e.g. deleted by webpack's
// output.clean of `writer`, which removes what the others had written before it (except paths matching
// clean.keep; on watch rebuilds it removes only its own stale files). Only writers whose latest build has
// landed are checked: one still building has not written its files yet. If some of a writer's files are
// left, all its packages stay - listing a package too many is safer than missing one.
// exists(file, callback(boolean)); done() is called when every check has finished.
function prune(target, writer, exists, done) {
  const writers = outputs.files.get(target);
  const others = writers ? [...writers].filter(([id, w]) => id !== writer && w.emitted && w.files.length) : [];
  let pending = others.length;
  if (!pending) return done();
  for (const [id, w] of others) {
    const next = (i) => {
      if (i === w.files.length) {
        if (writers.get(id) === w) writers.delete(id); // unless it recorded a new build meanwhile
        return finish();
      }
      exists(w.files[i], (found) => (found ? finish() : next(i + 1)));
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
