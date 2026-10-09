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
const { cmp, toPackageLock, readMeta, reanchor, unknownPackage } = require('./lockfile.cjs');
const { readPackage } = require('./manifest.cjs');
const { exportPath } = require('./paths.cjs');
const { lock, writeAtomic } = require('./lock.cjs');
const copies = require('./copies.cjs');
const lru = require('./lru.cjs');

const KEY = Symbol.for('bundle-lockfile.outputs.v4'); // v4: shape below; copies of another shape keep their own
// lockfile path -> Map(writer id -> { building, landed }); a writer is one compiler, across its (re)builds.
// building: { pkgs, context, files } of its build in progress, recorded before that build is written;
// landed: the same of its latest build whose output was written. A build that fails is never written
// (webpack's emitOnErrors: false): its packages must not replace those of the output still in the directory.
// Each writer also has an id: the one recorded in the lockfile, the same in every process and on every machine.
// disk: lockfile path -> its output is on the real disk, where other processes may write it too (not, e.g., a
// webpack-dev-server's in-memory file system).
// read: lockfile path -> the record (readMeta) of the lockfile last read from disk, for when it is gone (see foreign).
// copies: copy of a lockfile, made in this process -> { target: the lockfile it is a copy of, content: what was
// written to the copy last } (see copied).
const outputs = globalThis[KEY] || (globalThis[KEY] = { files: new Map(), queues: new Map(), disk: new Map(), read: new Map(), copies: new Map() });
const MAX_COPIES = 1000;

// The file other processes see: the lockfile in the output, or its export copy if it is not written inline.
const stateFile = (target) => (config.inline ? target : exportPath(target));

// A file of a writer is there: anything but "not found" counts (when in doubt, keep the packages), and lstat: a
// symbolic link the build wrote is there also if what it points at is not - as prune's checks of this process's writers.
function there(file) {
  try { fs.lstatSync(file); return true; } catch (e) { return e.code !== 'ENOENT'; }
}

// Writers of `target` recorded by other processes (in the lockfile on disk) whose files are still there (all:
// also those whose files are gone), except those with an id in `own` (this process has their newest build):
// [{ id, pkgs, files, count, context, anchored }] (anchored: see readMeta). A lockfile that is gone since this process last read it was deleted with
// the output directory - by this build's own output.clean, which deletes it with the other writers' files except
// those clean.keep keeps: its record is still what the other processes put there, for their files that are left.
function foreign(target, own, all = false) {
  const file = outputs.disk.get(target) && stateFile(target);
  if (!file) return [];
  let meta;
  try {
    meta = readMeta(fs.readFileSync(file, 'utf8'), path.dirname(target));
    outputs.read.set(target, meta);
  } catch { meta = outputs.read.get(target) || null; } // not there (any more)
  if (!meta) return [];
  return meta.writers.filter(w => !own.has(w.id) && (all || !w.files.length || w.files.some(there)))
    .map(w => ({ id: w.id, pkgs: w.pkgs, files: w.files, count: w.count, outputs: w.outputs, context: meta.context, anchored: meta.anchored,
      contents: Object.fromEntries(Object.entries(w.contents).map(([f, pkgs]) => [f, pkgs.map(p => p.path)])) }));
}

// A build with its packages checked (seen: package directory -> its package, read once per render): a package's path
// is the package only while its package.json there still has its name and version. A package upgraded in place since
// the build (npm install during a watch session), reinstalled elsewhere (pnpm's .pnpm directory names) or removed is
// no longer the one at that path, and another build's package at that path must not replace it: its location is
// then not known (see toPackageLock), in the build's packages and in its outputs' contents.
const stillThere = (seen) => (b) => {
  const at = (dir) => { if (!seen.has(dir)) seen.set(dir, readPackage(dir)); return seen.get(dir); };
  const ids = new Map(); // path -> path after the check, of this build's packages
  const pkgs = b.pkgs.map((p) => {
    const there = !p.outside && !p.unknown && at(p.path);
    const q = p.outside || p.unknown || (there && there.name === p.name && there.version === p.version) ? p : unknownPackage(p);
    ids.set(p.path, q.path);
    return q;
  });
  const contents = Object.fromEntries(Object.entries(b.contents || {}).map(([f, paths]) => [f, paths.map(x => ids.get(x) || x)]));
  return { ...b, pkgs, contents };
};

// The packages in the output directory: every writer's landed build; for `own`, the build it is about to write;
// writers in other processes whose files are there. null if there are none (nothing recorded, e.g. after a failure).
function render(target, own) {
  const builds = [];
  const ids = new Set();
  for (const [id, w] of outputs.files.get(target) || []) {
    ids.add(w.id);
    const b = id === own && w.building ? w.building : w.landed;
    if (b) builds.push({ ...b, id: w.id });
  }
  builds.push(...foreign(target, ids));
  if (!builds.length) return null;
  const checked = builds.map(stillThere(new Map()));
  const byPath = new Map();
  for (const b of checked) for (const p of b.pkgs) byPath.set(p.path, p);
  // keys are relative to one context; pick it independently of which writer finished last - this process's, and that of
  // another process's record only if it is no copy's (see readMeta) and has a package that is still where it says: the
  // context of a copy is not the project (two directories above it, for SvelteKit's build/)
  const valid = checked.filter(b => b.anchored === undefined || (b.anchored !== false && b.pkgs.some(p => !p.unknown && !p.outside)));
  const context = (valid.length ? valid : checked).map(b => b.context).sort(cmp)[0];
  const writers = checked.map(b => ({ id: b.id, files: b.files, count: b.count, outputs: b.outputs, contents: b.contents, paths: b.pkgs.map(p => p.path) }));
  return toPackageLock([...byPath.values()], context, { dir: path.dirname(target), writers });
}

// Records the packages `writer` puts into the output directory of `target` with the build it is about to
// write, and returns the content for `target`. files: absolute paths of the other files the writer emits
// there, to tell later whether they are still there (see prune). opts.id: the writer's id in the lockfile (default:
// a hash of `writer`, which therefore must not contain machine-specific paths); opts.disk: see outputs.disk;
// opts.outputs: { absolute path: "sha256-<hex>" } of its JavaScript and CSS output files, opts.contents: { absolute
// path: [package paths] } the packages in each of them (see core/nested.cjs).
function record(target, writer, pkgs, context, files = [], opts = {}) {
  let writers = outputs.files.get(target);
  if (!writers) outputs.files.set(target, (writers = new Map()));
  const w = writers.get(writer) || { building: null, landed: null };
  w.id = opts.id || crypto.createHash('sha256').update(writer).digest('hex').slice(0, 16);
  w.building = { pkgs, context, files, outputs: opts.outputs || {}, contents: opts.contents || {} };
  writers.set(writer, w);
  if (opts.disk) outputs.disk.set(target, true);
  return render(target, writer);
}

// The files the writer's build in progress writes, once they are known for certain: webpack's emit hook can still
// replace assets after the lockfile was rendered (compression-webpack-plugin's deleteOriginalAssets on webpack 4).
function setFiles(target, writer, files) {
  const w = (outputs.files.get(target) || new Map()).get(writer);
  if (w && w.building) w.building = { ...w.building, files };
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

// A lockfile copied with fs in this process (e.g. by SvelteKit's adapters, from .svelte-kit/output/ to build/): its
// record's "context" and "self" are rewritten for where the copy is, so that the copy's record is right there too (see
// readMeta), and the copy is followed: written again whenever its lockfile is (see rewrite), as long as it has what
// was written to it last. A lockfile copied before its last write (an adapter that copies in closeBundle, before
// files written after the build added packages) gets them too. Known are lockfiles this process writes (and their
// export copies), copies it followed, and - copied as a file - any other with a record written where it is copied
// from. A copy made otherwise (cp, rsync, an image build) keeps its bytes; readers see that its record is a copy's.
function copied(src, dest, isDirectory) {
  const name = path.basename(config.file);
  const known = new Map(); // lockfile -> the lockfile it is (a target) or follows
  for (const target of outputs.files.keys()) {
    known.set(target, target);
    const exp = exportPath(target);
    if (exp) known.set(exp, target);
  }
  for (const [copy, c] of outputs.copies) known.set(copy, c.target);
  const pairs = [];
  if (!isDirectory) {
    if (path.basename(src) === name) pairs.push([src, dest]);
  } else {
    for (const f of known.keys()) if (f.startsWith(src + path.sep)) pairs.push([f, path.join(dest, path.relative(src, f))]);
  }
  for (const [from, to] of pairs) {
    const target = known.get(from) || null;
    // the record of an export copy is anchored where its lockfile is, that of a copy where it is
    const anchor = target && exportPath(target) === from ? path.dirname(target) : path.dirname(from);
    let json;
    try { json = reanchor(fs.readFileSync(to, 'utf8'), anchor, path.dirname(to)); } catch { continue; }
    if (json === null) continue; // no record written where it comes from: left as it is
    writeAtomic(to, json);
    lru.set(outputs.copies, to, { target, content: json }, MAX_COPIES);
    config.debug('copied lockfile', from, '->', to, '- its record is for where it is now');
  }
}
if (!outputs.listening) { outputs.listening = true; copies.onCopy(copied); } // once per process, also with copies of this module

// The copies of `target` (see copied), with `content` - the target's new content - for where they are; a copy changed
// or removed since it was written last is no longer followed.
function follow(target, content) {
  for (const [copy, c] of outputs.copies) {
    if (c.target !== target) continue;
    let now = null;
    try { now = fs.readFileSync(copy, 'utf8'); } catch { /* removed */ }
    if (now !== c.content) { outputs.copies.delete(copy); continue; }
    try {
      const json = reanchor(content, path.dirname(target), path.dirname(copy));
      if (json === null) { outputs.copies.delete(copy); continue; }
      writeAtomic(copy, json);
      c.content = json;
    } catch (e) { outputs.copies.delete(copy); config.warn('could not write the copy', copy, 'of', target, ':', e); }
  }
}

// writeFile for rewrite(): a lockfile on the real disk, which other processes read
function writeDisk(file) {
  return (content, cb) => { try { writeAtomic(file, content); } catch (e) { return cb(e); } cb(); };
}

// BUNDLE_LOCKFILE_INLINE=0 without BUNDLE_LOCKFILE_EXPORT_DIR: there is nowhere to write; said once per process
let toldNowhere = false;
function nowhere() {
  if (toldNowhere) return;
  toldNowhere = true;
  config.warn('BUNDLE_LOCKFILE_INLINE is off and BUNDLE_LOCKFILE_EXPORT_DIR is not set: no lockfile is written');
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
      if (content === null) { config.debug('nothing recorded for', target, '- not written'); return finish(); }
      if (!writeFile && !exportPath(target)) nowhere();
      const exported = (err) => {
        const file = exportPath(target);
        if (file) try { writeAtomic(file, content); } catch (e) { return finish(err || e); }
        if (!err) follow(target, content);
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

module.exports = { record, setFiles, emitted, isShared, prune, rewrite, filesOf, writeDisk, nowhere };
