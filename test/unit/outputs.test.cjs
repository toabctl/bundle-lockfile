'use strict';
// Unit tests of the writers of each lockfile, in this process and others: merges, export copies, copies of lockfiles
// and outputs, generate-only builds, the lock across processes.
// All unit tests: node --test test/unit/*.test.cjs (see test/README.md)
// (helpers.cjs first: see there)
const {
  packagesForFiles, strictEnv, SRC, J, project, ids, warningsOf, entries, LOCK, lockedNames, withConfig,
  sharedCompiler, rollupBuild, node, recordOf,
} = require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const packages = require('../../src/core/packages.cjs');
const { exportPath } = require('../../src/core/paths.cjs');
const { toPackageLock } = require('../../src/core/lockfile.cjs');
const crypto = require('crypto');
const outputs = require('../../src/core/outputs.cjs');
const config = require('../../src/core/config.cjs');
const problems = require('../../src/core/problems.cjs');

test('outputs: prune drops other writers whose files are all gone, once their build has landed', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c'), ...pj('d'), ...pj('e'), 'dist/b.js': '', 'dist/c2.js': '' });
  const target = J(root, 'dist/bundle-lockfile/package-lock.json');
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const exists = (f) => new Promise(resolve => setImmediate(resolve, fs.existsSync(f)));
  const prune = (writer) => outputs.prune(target, writer, exists);
  const listed = () => lockedNames(outputs.record(target, 'a', [a], root, [J(root, 'dist/a.js')]));
  outputs.record(target, 'a', [a], root, [J(root, 'dist/a.js')]);              // the one pruning: never dropped by itself
  outputs.record(target, 'b', [b], root, [J(root, 'dist/b.js')]);              // its file is there
  outputs.record(target, 'c', [c], root, [J(root, 'dist/c1.js'), J(root, 'dist/c2.js')]); // one of its files is left
  outputs.record(target, 'd', [d], root, [J(root, 'dist/d.js')]);              // its file is gone
  outputs.record(target, 'e', [e], root, [J(root, 'dist/e.js')]);              // its file is gone too, but ...
  for (const w of ['a', 'b', 'c', 'd']) outputs.emitted(target, w);
  await prune('a');
  // ... its build has not landed yet: it has not written its file. Not listed until it has, nor dropped
  assert.deepEqual(listed(), ['a', 'b', 'c']);
  outputs.emitted(target, 'e');
  assert.deepEqual(listed(), ['a', 'b', 'c', 'e']);
  outputs.emitted(target, 'a');
  await prune('a');
  assert.deepEqual(listed(), ['a', 'b', 'c']);
  assert.equal(outputs.isShared(target), true);
  // nothing to check: no file is looked at
  let looked = false;
  await outputs.prune(J(root, 'other/package-lock.json'), 'a', (f) => { looked = true; return exists(f); });
  assert.equal(looked, false);
});

test('outputs: a build that is never written (it failed) does not replace the packages of the output in the directory', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c') });
  const target = J(root, 'dist/bundle-lockfile/package-lock.json');
  const [a, b, c] = ['a', 'b', 'c'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const rewrite = () => new Promise(resolve => outputs.rewrite(target, (json) => { resolve(lockedNames(json)); }));
  outputs.record(target, 'app', [a], root); outputs.emitted(target, 'app');
  outputs.record(target, 'sw', [b], root); outputs.emitted(target, 'sw');
  // app's next build fails: recorded, never written (webpack's emitOnErrors: false). The lockfile it would
  // have written has its new packages ...
  assert.deepEqual(lockedNames(outputs.record(target, 'app', [c], root)), ['b', 'c']);
  // ... but sw's rebuild writes what is in the directory: app's previous output
  assert.deepEqual(lockedNames(outputs.record(target, 'sw', [b], root)), ['a', 'b']);
  outputs.emitted(target, 'sw');
  assert.deepEqual(await rewrite(), ['a', 'b']);
  // app's next build lands
  outputs.record(target, 'app', [c], root); outputs.emitted(target, 'app');
  assert.deepEqual(await rewrite(), ['b', 'c']);
});

test('outputs: the export path mirrors the lockfile path below the export dir', () => withConfig({ exportDir: '/x/export', exportBase: null }, () => {
  assert.equal(exportPath('/srv/app/dist/bundle-lockfile/package-lock.json'), '/x/export/srv/app/dist/bundle-lockfile/package-lock.json');
  assert.equal(exportPath('/srv/app/../app/dist/l/package-lock.json'), '/x/export/srv/app/dist/l/package-lock.json');
  config.exportBase = '/srv/app';
  assert.equal(exportPath('/srv/app/dist/bundle-lockfile/package-lock.json'), '/x/export/dist/bundle-lockfile/package-lock.json');
  // not below the base: its absolute path, below _outside_base/ - never where one below the base goes (/srv/app/srv/other/...)
  assert.equal(exportPath('/srv/other/dist/bundle-lockfile/package-lock.json'), '/x/export/_outside_base/srv/other/dist/bundle-lockfile/package-lock.json');
  assert.notEqual(exportPath('/srv/app/srv/other/dist/bundle-lockfile/package-lock.json'), exportPath('/srv/other/dist/bundle-lockfile/package-lock.json'));
  assert.equal(exportPath('/srv/app/..cache/dist/l/package-lock.json'), '/x/export/..cache/dist/l/package-lock.json'); // below it, a name starting with ..
  assert.equal(exportPath('/srv/application/dist/l/package-lock.json'), '/x/export/_outside_base/srv/application/dist/l/package-lock.json');
  config.exportDir = null;
  assert.equal(exportPath('/srv/app/dist/bundle-lockfile/package-lock.json'), null);
}));

test('outputs: an export base reached through a symbolic link is the base of the real paths below it (macOS /tmp, $TMPDIR)', { skip: process.platform === 'win32' }, () => {
  const root = project({ 'real/app/dist/x.js': '' });
  fs.symlinkSync(J(root, 'real'), J(root, 'link'));
  return withConfig({ exportDir: J(root, 'export'), exportBase: J(root, 'link/app') }, () => {
    // Rollup and Vite record real paths (their working directory's), the base is the logical $PWD
    assert.equal(exportPath(J(root, 'real/app/dist/bundle-lockfile/package-lock.json')), J(root, 'export/dist/bundle-lockfile/package-lock.json'));
    assert.equal(exportPath(J(root, 'link/app/dist/bundle-lockfile/package-lock.json')), J(root, 'export/dist/bundle-lockfile/package-lock.json'));
    // also a lockfile whose directory is not there yet
    assert.equal(exportPath(J(root, 'real/app/new/bundle-lockfile/package-lock.json')), J(root, 'export/new/bundle-lockfile/package-lock.json'));
  });
});

test('outputs: two lockfiles of a process at one export path are an error; the second does not replace the first\'s copy', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b') });
  const [a, b] = ['a', 'b'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  // a directory below the base named like the prefix of those outside it: the one way two lockfiles meet there
  const inside = J(root, `w/${require('../../src/core/paths.cjs').OUTSIDE_BASE}`, root.slice(1), 'dist', LOCK), outside = J(root, 'dist', LOCK);
  await withConfig({ exportDir: J(root, 'export'), exportBase: J(root, 'w') }, async () => {
    assert.equal(exportPath(inside), exportPath(outside));
    const write = (target, p) => new Promise((resolve) => {
      outputs.record(target, 'w', [p], root, [], { disk: true }); outputs.emitted(target, 'w');
      outputs.rewrite(target, outputs.writeDisk(target)).then(resolve);
    });
    assert.equal(await write(outside, a), undefined);
    const err = await write(inside, b);
    assert.match(err && err.message, /its export copy .*package-lock\.json is also the export copy of .*dist.bundle-lockfile.package-lock\.json/);
    assert.deepEqual(lockedNames(fs.readFileSync(exportPath(outside), 'utf8')), ['a']);
  });
});

test('outputs: a lockfile on disk keeps the packages other processes put there, while their files are there', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c'), 'dist/b.js': 'b' });
  const target = J(root, 'dist', LOCK);
  const [a, b, c] = ['a', 'b', 'c'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const writeFile = (json) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, json); };
  const rewrite = () => outputs.rewrite(target, writeFile).then(() => fs.readFileSync(target, 'utf8'));
  // another process wrote b (with its file dist/b.js) and an older build of this process's writer w1, with c
  const id = crypto.createHash('sha256').update('w1').digest('hex').slice(0, 16);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, toPackageLock([b, c], root, { dir: path.dirname(target), writers: [
    { id: 'other', files: [J(root, 'dist/b.js')], paths: [b.path] }, { id, files: [J(root, 'dist/a.js')], paths: [c.path] }] }));
  outputs.record(target, 'w1', [a], root, [J(root, 'dist/a.js')], { disk: true });
  outputs.emitted(target, 'w1');
  assert.equal(outputs.isShared(target), true);
  const json = await rewrite();
  assert.deepEqual(lockedNames(json), ['a', 'b']); // c was w1's own older build: replaced
  assert.equal(json.includes(root), false, 'no absolute paths');
  assert.equal(await rewrite(), json, 'the same bytes again');
  fs.rmSync(J(root, 'dist/b.js'));
  assert.equal(outputs.isShared(target), true); // still listed in the file, e.g. deleted by output.clean after rendering
  assert.deepEqual(lockedNames(await rewrite()), ['a']); // the other process's output is gone
  assert.equal(outputs.isShared(target), false);
});

test('outputs: another process\'s file that is a symbolic link to nothing is there, as for this process\'s writers', { skip: process.platform === 'win32' }, async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b') });
  const target = J(root, 'dist', LOCK);
  const [a, b] = ['a', 'b'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const writeFile = (json) => { fs.writeFileSync(target, json); };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(J(root, 'nowhere'), J(root, 'dist/b-link')); // a symbolic link asset (webpack >= 5.111)
  fs.writeFileSync(target, toPackageLock([b], root, { dir: path.dirname(target), writers: [{ id: 'other', files: [J(root, 'dist/b-link')], paths: [b.path] }] }));
  outputs.record(target, 'w-link', [a], root, [J(root, 'dist/a.js')], { disk: true });
  outputs.emitted(target, 'w-link');
  await outputs.rewrite(target, writeFile);
  assert.deepEqual(lockedNames(fs.readFileSync(target, 'utf8')), ['a', 'b']);
});

test('outputs: nothing recorded for a lockfile: nothing written, no error (one that failed before is not hidden)', async () => {
  const root = project({ 'dist/bundle-lockfile/package-lock.json': 'left alone' });
  const target = J(root, 'dist', LOCK);
  let written = false;
  const err = await outputs.rewrite(target, () => { written = true; });
  assert.equal(err, undefined);
  assert.equal(written, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'left alone');
});

test('outputs: a lockfile its own output.clean deleted keeps the other processes\' packages whose files it kept', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c'), 'dist/b.js': 'b', 'dist/c.js': 'c' });
  const target = J(root, 'dist', LOCK);
  const [a, b, c] = ['a', 'b', 'c'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const writeFile = (json) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, json); };
  // other processes wrote b (dist/b.js) and c (dist/c.js)
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, toPackageLock([b, c], root, { dir: path.dirname(target), writers: [
    { id: 'other-b', files: [J(root, 'dist/b.js')], paths: [b.path] }, { id: 'other-c', files: [J(root, 'dist/c.js')], paths: [c.path] }] }));
  outputs.record(target, 'w-clean', [a], root, [J(root, 'dist/a.js')], { disk: true }); // renders with the lockfile on disk
  // this build's output.clean (clean.keep: b.js) deletes c.js and the lockfile before the output is written
  fs.rmSync(J(root, 'dist/c.js'));
  fs.rmSync(target);
  outputs.emitted(target, 'w-clean');
  await outputs.rewrite(target, writeFile);
  assert.deepEqual(lockedNames(fs.readFileSync(target, 'utf8')), ['a', 'b']);
});

test('outputs: processes writing one lockfile at the same time each add their packages (inline and export only)', async () => {
  const N = 6;
  const pkgs = Object.fromEntries([...Array(N).keys()].map(i => [`node_modules/p${i}/package.json`, { name: `p${i}`, version: '1.0.0' }]));
  // one process: one writer p<i> with its package and file, a random delay, then the write (as webpack's afterEmit)
  const script = `const fs = require('fs'), path = require('path');
    const { packagesForFiles } = require(${JSON.stringify(J(SRC, 'core/packages.cjs'))});
    const outputs = require(${JSON.stringify(J(SRC, 'core/outputs.cjs'))});
    const [root, i] = [process.argv[2], process.argv[3]];
    const target = path.join(root, 'dist', ${JSON.stringify(LOCK)}), file = path.join(root, 'dist', 'p' + i + '.js');
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(file, 'x');
    outputs.record(target, 'p' + i, packagesForFiles([path.join(root, 'node_modules', 'p' + i, 'i.js')]), root, [file], { disk: true });
    setTimeout(() => { outputs.emitted(target, 'p' + i);
      outputs.rewrite(target, process.env.BUNDLE_LOCKFILE_INLINE === '0' ? null : outputs.writeDisk(target)).then((err) => { if (err) throw err; }); },
      Math.floor(Math.random() * 40));`;
  for (const inline of [true, false]) {
    const root = project(pkgs);
    fs.writeFileSync(J(root, 'writer.cjs'), script);
    const env = { ...process.env, BUNDLE_LOCKFILE_INLINE: inline ? '1' : '0', BUNDLE_LOCKFILE_EXPORT_DIR: J(root, 'export'), BUNDLE_LOCKFILE_EXPORT_BASE: root };
    await Promise.all([...Array(N).keys()].map(i => new Promise((resolve, reject) => {
      const p = require('child_process').spawn(process.execPath, [J(root, 'writer.cjs'), root, String(i)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; p.stderr.on('data', d => (err += d));
      p.on('exit', code => (code === 0 ? resolve() : reject(new Error(err))));
    })));
    const want = [...Array(N).keys()].map(i => `p${i}`);
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'export/dist', LOCK), 'utf8')), want, `inline=${inline}: export copy`);
    if (inline) assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), want, 'inline file');
    else assert.equal(fs.existsSync(J(root, 'dist', LOCK)), false);
    assert.deepEqual(fs.readdirSync(J(root, inline ? 'dist' : 'export/dist', 'bundle-lockfile')), ['package-lock.json'], 'no lock or temporary files left');
  }
});

test('outputs: writes of a shared lockfile run in order, each with the latest content', async () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/b/package.json': { name: 'b', version: '1.0.0' } });
  const target = J(root, 'dist/bundle-lockfile/package-lock.json');
  const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]), [b] = packagesForFiles([J(root, 'node_modules/b/i.js')]);
  outputs.record(target, 'w1', [a], root); outputs.emitted(target, 'w1');
  assert.equal(outputs.isShared(target), false);
  outputs.record(target, 'w2', [b], J(root, 'sub')); // another context: the smallest one is used, whoever writes last
  outputs.emitted(target, 'w2');
  assert.equal(outputs.isShared(target), true);
  const written = [];
  // the first write is slow and fails: the second still runs after it, and the build continues
  const slow = (json) => new Promise((resolve, reject) => setTimeout(() => { written.push(json); reject(new Error('disk full')); }, 20));
  const fast = (json) => { written.push(json); };
  const errors = await Promise.all([
    outputs.rewrite(target, slow),
    (() => { outputs.record(target, 'w2', [a, b], J(root, 'sub')); outputs.emitted(target, 'w2'); return outputs.rewrite(target, fast); })(),
    outputs.rewrite(target, () => { throw new Error('sync'); }),
  ]);
  assert.deepEqual(errors.map(e => e && e.message), ['disk full', undefined, 'sync']);
  assert.equal(written.length, 2);
  assert.deepEqual(entries(written[1]).map(([k]) => k), ['node_modules/a', 'node_modules/b']);
});

test('outputs.hasFile: as filesOf().has(), also after the build\'s file list grew', () => {
  const target = J(os.tmpdir(), `bl-hasfile-${process.pid}`, 'bundle-lockfile/package-lock.json');
  const files = ['/o/a.js', '/o/b.js'];
  outputs.record(target, 'hasFile', [], os.tmpdir(), files, { id: 'hasFile' });
  assert.deepEqual(['/o/a.js', '/o/b.js', '/o/c.js'].map(f => outputs.hasFile(target, f)), [true, true, false]);
  files.push('/o/c.js'); // (an adapter adds files written after its build)
  assert.equal(outputs.hasFile(target, '/o/c.js'), true);
  assert.equal(outputs.hasFile(J(os.tmpdir(), 'no-such-target'), '/o/a.js'), false);
});

test('outputs: runs of one config into one directory that write other files (other plugins, hashes, no clean) keep each other\'s packages while those files are there', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const dist = J(root, 'dist');
    const run = (file, name, own = rollupAdapter.bundleLockfile('vite', { input: 'src/sel.js' })) =>
      rollupBuild(own, { outDir: dist, chunks: [{ fileName: file, code: file, modules: [J(root, `node_modules/${name}/i.js`)] }] });
    const locked = () => lockedNames(fs.readFileSync(J(dist, LOCK), 'utf8'));
    // the same config twice in one process (rollup -c with two configs, other plugins), with hashed file names
    await run('sel-1.js', 'a');
    await run('sel-2.js', 'b');
    assert.deepEqual(locked(), ['a', 'b']);
    // its rebuild writing the same file again replaces it
    const same = rollupAdapter.bundleLockfile('vite', { input: 'src/sel.js' });
    await run('sel-2.js', 'c', same);
    assert.deepEqual(locked(), ['a', 'c']);
    // gone: no longer
    fs.rmSync(J(dist, 'sel-1.js'));
    await run('sel-2.js', 'c', same);
    assert.deepEqual(locked(), ['c']);
    // another process ran the same config before, into other files: the lockfile on disk has them, this run keeps them
    const before = JSON.parse(fs.readFileSync(J(dist, LOCK), 'utf8'));
    const state = globalThis[Symbol.for('bundle-lockfile.outputs.v4')];
    state.files.delete(J(dist, LOCK)); // (as a new process)
    fs.writeFileSync(J(dist, LOCK), JSON.stringify(before));
    await run('sel-3.js', 'a');
    assert.deepEqual(locked(), ['a', 'c']);
    const lock = JSON.parse(fs.readFileSync(J(dist, LOCK), 'utf8'));
    assert.deepEqual(lock['bundle-lockfile'].writers.map(w => w.files.join(' ')).sort(), ['../sel-2.js', '../sel-3.js']);
    assert.equal(new Set(lock['bundle-lockfile'].writers.map(w => w.id)).size, 2);
    // and the next run of it again (the earlier run's writer, an id of its own now, is another process's)
    state.files.delete(J(dist, LOCK));
    await run('sel-3.js', 'b');
    assert.deepEqual(locked(), ['b', 'c']);
    // a writer whose files are outside the output (Next.js' runtime packages: the traced files in node_modules), another
    // process's run before: replaced
    const traced = J(root, 'node_modules/a/i.js');
    fs.writeFileSync(traced, 'a');
    const target = J(root, 'runtime', LOCK);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const [pa, pb] = ['a', 'b'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
    const runtimeId = crypto.createHash('sha256').update('runtime').digest('hex').slice(0, 16);
    fs.writeFileSync(target, toPackageLock([pa], root, { dir: path.dirname(target), writers: [{ id: runtimeId, files: [traced], paths: [pa.path] }] }));
    outputs.record(target, 'runtime', [pb], root, [J(root, 'node_modules/b/i.js')], { disk: true });
    await outputs.land(target, 'runtime', 'test');
    assert.deepEqual(lockedNames(fs.readFileSync(target, 'utf8')), ['b']);
    // a writer whose lockfile the bundler writes with the content it is given (Angular, an in-memory output): its own
    // record of the build before, with files still there, is replaced by the next build
    const ng = J(root, 'ng', LOCK);
    for (const f of ['old.js', 'new.js']) { fs.mkdirSync(J(root, 'ng'), { recursive: true }); fs.writeFileSync(J(root, 'ng', f), f); }
    const first = outputs.record(ng, 'ng', [pa], root, [J(root, 'ng/old.js')], { disk: true });
    fs.mkdirSync(path.dirname(ng), { recursive: true });
    fs.writeFileSync(ng, first);
    outputs.emitted(ng, 'ng');
    assert.deepEqual(lockedNames(outputs.record(ng, 'ng', [pb], root, [J(root, 'ng/new.js')], { disk: true })), ['b']);
  } finally { process.chdir(cwd); }
});

test('generated: a build that writes nothing itself keeps the packages of the files its plugins inlined (a worker\'s font as a data: URL)', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('font'), ...pj('w'), ...pj('app') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const m = (name, f = 'i.js') => J(root, 'node_modules', name, f);
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'gen'), isWrite: false, ctx: { getWatchFiles: () => [m('font', 'f.woff2')] },
      chunks: [{ fileName: 'worker.js', code: 'worker with an inlined font', modules: [m('w')] }] });
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'dist'),
      chunks: [{ fileName: 'main.js', code: 'main', modules: [m('app')] }], assets: [{ fileName: 'worker.js', source: 'worker with an inlined font' }] });
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['app', 'font', 'w']);
  } finally { process.chdir(cwd); }
});

test('generated: generate-only output inside a written bundle (worker chunks as assets, inlined workers, polyfill chunks)', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('wa'), ...pj('wb'), ...pj('inl'), ...pj('poly'), ...pj('app'), ...pj('unused') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const gen = (fileName, code, modules, entry) => rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: '', isWrite: false, chunks: [{ fileName, code, modules, entry }] });
    // Vite's worker build (generate-only): its chunk becomes an asset of the parent; a ?worker&inline one is a string
    // in the parent's module; plugin-legacy's polyfills (output below node_modules) a chunk of the parent
    await gen('assets/worker-1.js', 'worker code', [J(root, 'src/worker.js'), J(root, 'node_modules/wa/i.js')], J(root, 'src/worker.js'));
    await gen('assets/worker-2.js', 'other worker', [J(root, 'node_modules/wb/i.js')]);
    await gen('assets/inline-worker.js', 'inline worker', [J(root, 'src/inline.js'), J(root, 'node_modules/inl/i.js')], J(root, 'src/inline.js'));
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'node_modules/@vitejs/plugin-legacy/dist'),
      chunks: [{ fileName: 'polyfills.js', code: 'polyfills', modules: [J(root, 'node_modules/poly/i.js')] }] });
    // an unrelated generate-only build must not be listed
    await gen('x.js', 'not used', [J(root, 'node_modules/unused/i.js')], J(root, 'src/x.js'));
    assert.equal(fs.existsSync(J(root, 'node_modules/@vitejs/plugin-legacy/dist', LOCK)), false);

    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'dist'), chunks: [
      { fileName: 'assets/index.js', code: 'index', modules: [J(root, 'src/main.js'), J(root, 'node_modules/app/i.js'), `${J(root, 'src/inline.js')}?worker&inline`] },
      { fileName: 'assets/polyfills-legacy.js', code: 'polyfills', modules: [] },
    ], assets: [{ fileName: 'assets/worker-1.js', source: 'worker code' }, { fileName: 'assets/worker-2.js', source: Buffer.from('other worker') },
      { fileName: 'assets/notes.txt', source: 'not used' }] });
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['app', 'inl', 'poly', 'wa', 'wb']);
  } finally { process.chdir(cwd); }
});

test('generated: the source map comment workbox-build appends does not change the content hash', () => {
  const generated = require('../../src/core/generated.cjs');
  assert.equal(generated.hash('code'), generated.hash('code\n//# sourceMappingURL=sw.js.map\n'));
  assert.equal(generated.hash('code'), generated.hash(Buffer.from('code//# sourceMappingURL=sw.js.map')));
  assert.notEqual(generated.hash('code'), generated.hash('code\n//# sourceMappingURL=sw.js.map\nmore'));
  assert.equal(generated.hash({}), null);
});

test('copies: a file copied out of a package (fs.copyFile*, fs.cp*) belongs to it while it has its bytes', async () => {
  const copies = require('../../src/core/copies.cjs');
  copies.install();
  copies.install(); // once
  const root = project({ 'node_modules/adapter/package.json': { name: 'adapter', version: '5.0.0' }, 'node_modules/adapter/files/index.js': 'index',
    'node_modules/adapter/files/chunks/vendor.js': 'vendor', 'node_modules/adapter/files/b.js': 'b', 'node_modules/adapter/files/c.js': 'c',
    'node_modules/adapter/files/d.js': 'd', 'src/own.js': 'own' });
  const nm = (f) => J(root, 'node_modules/adapter/files', f);
  const out = (f) => J(root, '.kit', f);
  fs.mkdirSync(J(root, '.kit'), { recursive: true });
  fs.copyFileSync(nm('index.js'), out('index.js'));
  await fs.promises.copyFile(nm('b.js'), out('b.js'));
  await new Promise((res, rej) => fs.copyFile(nm('c.js'), out('c.js'), (e) => (e ? rej(e) : res())));
  fs.cpSync(J(root, 'node_modules/adapter/files'), out('entries'), { recursive: true }); // a directory
  await fs.promises.cp(nm('d.js'), out('d.js'));
  fs.copyFileSync(J(root, 'src/own.js'), out('own.js'));                                 // not from a package
  fs.mkdirSync(J(root, 'node_modules/other'), { recursive: true });
  fs.copyFileSync(nm('index.js'), J(root, 'node_modules/other/index.js'));               // into node_modules: a package itself
  for (const f of ['index.js', 'b.js', 'c.js', 'd.js', 'entries/index.js', 'entries/chunks/vendor.js']) {
    assert.equal(fs.realpathSync(copies.sourceOf(out(f))).startsWith(J(root, 'node_modules/adapter/files')), true, f);
  }
  assert.equal(copies.sourceOf(out('own.js')), null);
  assert.equal(copies.sourceOf(J(root, 'node_modules/other/index.js')), null);
  assert.equal(copies.sourceOf(J(root, 'src/own.js')), null);
  assert.deepEqual(ids(packagesForFiles([out('index.js'), out('entries/chunks/vendor.js'), out('own.js')])), ['adapter@5.0.0']);
  // changed after the copy (or overwritten with other content): no longer the package's
  fs.writeFileSync(out('index.js'), 'patched');
  fs.appendFileSync(out('entries/chunks/vendor.js'), '!');
  assert.equal(copies.sourceOf(out('index.js')), null);
  assert.equal(copies.sourceOf(out('entries/chunks/vendor.js')), null);
  assert.deepEqual(ids(packagesForFiles([out('index.js'), out('entries/chunks/vendor.js')])), []);
  // copies still work and report their errors as before
  assert.throws(() => fs.copyFileSync(J(root, 'missing.js'), out('x.js')), { code: 'ENOENT' });
  await assert.rejects(fs.promises.copyFile(J(root, 'missing.js'), out('x.js')), { code: 'ENOENT' });
  assert.equal(fs.copyFileSync.name, 'copyFileSync');
});

test('copies: a file copied, then overwritten by a directory copy, is the later copy\'s; a destination through a symbolic link by its real path', { skip: process.platform === 'win32' }, () => {
  const copies = require('../../src/core/copies.cjs');
  copies.install();
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/a/x.js': 'a code',
    'node_modules/b/package.json': { name: 'b', version: '1.0.0' }, 'node_modules/b/lib/x.js': 'b code', 'node_modules/b/lib/y.js': 'b y' });
  fs.mkdirSync(J(root, 'out'));
  fs.copyFileSync(J(root, 'node_modules/a/x.js'), J(root, 'out/x.js'));
  fs.cpSync(J(root, 'node_modules/b/lib'), J(root, 'out'), { recursive: true });
  assert.equal(copies.sourceOf(J(root, 'out/x.js')), J(root, 'node_modules/b/lib/x.js'));
  // copied to a path through a symbolic link, bundled by its real path
  fs.mkdirSync(J(root, 'real'));
  fs.symlinkSync(J(root, 'real'), J(root, 'link'));
  fs.copyFileSync(J(root, 'node_modules/b/lib/y.js'), J(root, 'link/y.js'));
  fs.cpSync(J(root, 'node_modules/a'), J(root, 'link/a-copy'), { recursive: true });
  assert.equal(copies.sourceOf(J(root, 'real/y.js')), J(root, 'node_modules/b/lib/y.js'));
  assert.equal(copies.sourceOf(J(root, 'link/y.js')), J(root, 'node_modules/b/lib/y.js'));
  assert.equal(copies.sourceOf(J(root, 'real/a-copy/x.js')), J(root, 'node_modules/a/x.js'));
});

test('copies: a file copied out of a package into the output after the build (static copy under another name)', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/normalize.css/package.json': { name: 'normalize.css', version: '8.0.1' },
    'node_modules/normalize.css/normalize.css': 'html{}', 'node_modules/app/package.json': { name: 'app', version: '1.0.0' } });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const dist = J(root, 'dist');
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: dist, chunks: [{ fileName: 'index.js', code: 'copies app', modules: [J(root, 'node_modules/app/i.js')] }],
      late() { fs.mkdirSync(J(dist, 'vendor'), { recursive: true }); fs.copyFileSync(J(root, 'node_modules/normalize.css/normalize.css'), J(dist, 'vendor/reset.css')); } });
    assert.deepEqual(lockedNames(fs.readFileSync(J(dist, LOCK), 'utf8')), ['app', 'normalize.css']);
  } finally { process.chdir(cwd); }
});

test('outputs: lockfiles on disk are replaced atomically, never written in place (other processes read them without the lock)', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const dist = J(root, 'dist'), target = J(dist, LOCK);
  const inPlace = [], renamed = [];
  const orig = { writeFile: fs.writeFile, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync };
  fs.writeFile = function (f, ...rest) { if (f === target) inPlace.push(f); return orig.writeFile.call(this, f, ...rest); };
  fs.writeFileSync = function (f, ...rest) { if (f === target) inPlace.push(f); return orig.writeFileSync.call(this, f, ...rest); };
  fs.renameSync = function (from, to) { if (to === target) renamed.push(from); return orig.renameSync.call(this, from, to); };
  const cwd = process.cwd();
  process.chdir(root);
  try {
    // content of its own: generate-only chunks of other tests in this process are matched by content
    await rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: dist, chunks: [{ fileName: 'index.js', code: `atomic ${root}`, modules: [J(root, 'node_modules/a/i.js')] }] });
  } finally { Object.assign(fs, orig); process.chdir(cwd); }
  assert.deepEqual(inPlace, []);
  assert.equal(renamed.length, 1);
  assert.deepEqual(lockedNames(fs.readFileSync(target, 'utf8')), ['a']);
});

test('outputs: BUNDLE_LOCKFILE_INLINE=0 without BUNDLE_LOCKFILE_EXPORT_DIR writes nothing, and says so once per process', async () => {
  const script = `const outputs = require(${JSON.stringify(J(SRC, 'core/outputs.cjs'))});
    const t = require('path').join(process.argv[1], 'dist/bundle-lockfile/package-lock.json');
    outputs.record(t, 'w', [], process.argv[1]); outputs.emitted(t, 'w');
    const writeFile = require(${JSON.stringify(J(SRC, 'core/config.cjs'))}).inline ? outputs.writeDisk(t) : null; // as the adapters do
    outputs.rewrite(t, writeFile).then(() => outputs.rewrite(t, writeFile));`;
  const root = project({});
  const env = { BUNDLE_LOCKFILE_INLINE: '0', BUNDLE_LOCKFILE_EXPORT_DIR: '' };
  const r = node(['-e', script, root], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.match(/BUNDLE_LOCKFILE_INLINE is off and BUNDLE_LOCKFILE_EXPORT_DIR is not set/g).length, 1, r.stderr);
  assert.equal(fs.existsSync(J(root, 'dist')), false);
  assert.equal(node(['-e', script, root], { ...env, BUNDLE_LOCKFILE_INLINE: '1' }).stderr, ''); // written inline: nothing to say
  assert.equal(fs.existsSync(J(root, 'dist', LOCK)), true);
  // the webpack adapter, which skips the write altogether then, says it too
  const told = [];
  const nowhere = outputs.nowhere;
  outputs.nowhere = () => told.push(1);
  try {
    fs.mkdirSync(J(root, 'dist-webpack'));
    await withConfig({ inline: false, exportDir: null }, () => sharedCompiler(root, J(root, 'dist-webpack'), 'a')());
  } finally { outputs.nowhere = nowhere; }
  assert.equal(told.length, 1);
});

test('lock: a lock another process holds is waited for, then skipped with a warning; a stale one is taken over at once', async () => {
  const { lock } = require('../../src/core/lock.cjs');
  const root = project({});
  const file = J(root, 'dist/l.json'), l = `${file}.lock`;
  fs.mkdirSync(J(root, 'dist'));
  fs.writeFileSync(l, 'held'); // fresh: another process holds it
  let release, took = Date.now();
  const warned = await warningsOf(async () => { release = await lock(file, { wait: 300 }); });
  took = Date.now() - took;
  assert.ok(took >= 300 && took < 5000, `waited ${took} ms`);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /could not lock .* writing it without the lock/);
  release();
  assert.equal(fs.readFileSync(l, 'utf8'), 'held', 'the other process\'s lock is not released by this one');
  // older than staleAfter: from a process that died, taken over without waiting
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(l, old, old);
  took = Date.now();
  assert.deepEqual(await warningsOf(async () => { release = await lock(file); }), []);
  assert.ok(Date.now() - took < 5000);
  assert.notEqual(fs.readFileSync(l, 'utf8'), 'held');
  release();
  assert.deepEqual(fs.readdirSync(J(root, 'dist')), [], 'released: nothing left behind');
});

test('lock: while another process holds it, the event loop runs on (a dev server, other compilers)', async () => {
  const { lock } = require('../../src/core/lock.cjs');
  const root = project({ 'dist/l.json.lock': 'held' });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const warned = await warningsOf(async () => { (await lock(J(root, 'dist/l.json'), { wait: 300 }))(); });
    assert.equal(warned.length, 1); // skipped after the wait
  } finally { clearInterval(timer); }
  assert.ok(ticks >= 10, `the timer ran ${ticks} times in 300 ms`);
});

test('outputs: land() drops the writers whose files are gone, writes the lockfile, and makes a failed write a problem', async () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/b/package.json': { name: 'b', version: '1.0.0' } });
  const target = J(root, 'dist', LOCK);
  const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]), [b] = packagesForFiles([J(root, 'node_modules/b/i.js')]);
  outputs.record(target, 'gone', [b], root, [J(root, 'dist/gone.js')]); outputs.emitted(target, 'gone');
  outputs.record(target, 'land', [a], root, [J(root, 'dist/a.js')]);
  let written = null;
  await outputs.land(target, 'land', 'test', { writeFile: (json) => { written = json; } });
  assert.deepEqual(lockedNames(written), ['a']); // gone.js is not there: its writer is dropped
  const taken = await warningsOf(() => outputs.land(target, 'land', 'test', { writeFile: () => { throw new Error('EROFS'); } }));
  assert.equal(taken.length, 1);
  assert.match(taken[0], /^test: could not write .*package-lock\.json: Error: EROFS$/);
});

test('lock: two processes never hold it at the same time', async () => {
  const root = project({});
  const file = J(root, 'l.json');
  // each process takes the lock, notes when it holds it, keeps it 300 ms, notes the release, releases it
  const holder = `const fs = require('fs');
    const log = (what) => fs.appendFileSync(${JSON.stringify(J(root, 'log'))}, process.argv[2] + ' ' + what + '\\n');
    require(${JSON.stringify(J(SRC, 'core/lock.cjs'))}).lock(${JSON.stringify(file)}).then((release) => {
      log('in'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); log('out'); release();
    });`;
  fs.writeFileSync(J(root, 'holder.cjs'), holder);
  const run = (name) => new Promise((resolve) => require('child_process').spawn(process.execPath, [J(root, 'holder.cjs'), name], { stdio: 'inherit' }).on('exit', resolve));
  assert.deepEqual(await Promise.all(['a', 'b', 'c'].map(run)), [0, 0, 0]);
  const log = fs.readFileSync(J(root, 'log'), 'utf8').trim().split('\n').map(l => l.split(' '));
  assert.equal(log.length, 6);
  for (let i = 0; i < 6; i += 2) { // in, out of the same process, one after another
    assert.deepEqual([log[i][1], log[i + 1][1]], ['in', 'out'], JSON.stringify(log));
    assert.equal(log[i][0], log[i + 1][0], JSON.stringify(log));
  }
});

test('lock: a stale lock is taken over only if it is still the stale one', () => {
  const { takeStale } = require('../../src/core/lock.cjs');
  const root = project({ 'stale.lock': '' });
  const l = J(root, 'stale.lock');
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(l, old, old);
  // another process took the stale lock over and holds a new one by now: it stays
  const st = fs.statSync(l);
  fs.unlinkSync(l); fs.writeFileSync(l, 'fresh');
  takeStale(l, st);
  assert.equal(fs.readFileSync(l, 'utf8'), 'fresh');
  // still the stale one: removed
  fs.utimesSync(l, old, old);
  takeStale(l, fs.statSync(l));
  assert.equal(fs.existsSync(l), false);
  assert.deepEqual(fs.readdirSync(root), [], 'nothing left behind');
  takeStale(l, st); // already gone: nothing to do
  // another process is taking over (its .takeover): left to it; a takeover of a process that died during it is removed
  fs.writeFileSync(l, ''); fs.utimesSync(l, old, old);
  fs.writeFileSync(`${l}.takeover`, '');
  assert.equal(takeStale(l, fs.statSync(l)), false);
  assert.ok(fs.existsSync(l));
  fs.utimesSync(`${l}.takeover`, old, old);
  assert.equal(takeStale(l, fs.statSync(l)), false); // (the old takeover removed)
  assert.equal(takeStale(l, fs.statSync(l)), true);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('lock: a lock of a process of this machine that is gone is taken at once; one of a live process is waited for', async () => {
  const { lock } = require('../../src/core/lock.cjs');
  const root = project({});
  const file = J(root, 'package-lock.json'), l = `${file}.lock`;
  const ns = (() => { try { return fs.readlinkSync('/proc/self/ns/pid'); } catch { return ''; } })();
  const gone = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  // a build killed while it wrote: its fresh lock names it
  fs.writeFileSync(l, JSON.stringify({ host: os.hostname(), ns, pid: Number(gone) }));
  problems.take();
  const t0 = Date.now();
  const release = await lock(file, { wait: 5000 });
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  assert.equal(JSON.parse(fs.readFileSync(l, 'utf8')).pid, process.pid);
  release();
  assert.equal(fs.existsSync(l), false);
  // a live process's (this machine's, or another machine's that looks gone here): waited for, until the wait is over
  const parent = process.ppid;
  for (const holder of [{ host: os.hostname(), ns, pid: parent }, { host: `not-${os.hostname()}`, ns, pid: Number(gone) }]) {
    fs.writeFileSync(l, JSON.stringify(holder));
    const warned = await warningsOf(async () => { (await lock(file, { wait: 300 }))(); });
    assert.match(warned.join('\n'), /could not lock .* writing it without the lock/, JSON.stringify(holder));
    assert.ok(fs.existsSync(l));
    fs.unlinkSync(l);
  }
});

// Copies of a lockfile: its record's paths to the project ("context", the packages' locations) are relative to where
// it was written. A reader tells a copy from the lockfile by "self"; a package's path is the package only while its
// package.json there has its name and version; lockfiles copied with fs in this process are re-anchored and followed.
const nameVersions = (json) => entries(json).map(([k, p]) => `${k} = ${p.name}@${p.version}`);

// as SvelteKit's adapters do: the output in .svelte-kit/output/client copied to build/ (another depth)
function svelteProject() {
  const root = project({ 'node_modules/kit/package.json': { name: 'kit', version: '2.0.0' }, 'node_modules/esm/package.json': { name: 'esm', version: '1.0.0' } });
  const [kit, esm] = ['kit', 'esm'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const orig = J(root, '.svelte-kit/output/client'), build = J(root, 'build');
  const json = toPackageLock([kit, esm], root, { dir: J(orig, 'bundle-lockfile'), writers: [{ id: 'vite', files: [J(orig, '_app/x.js')], paths: [kit.path, esm.path] }] });
  for (const d of [orig, build]) {
    fs.mkdirSync(J(d, 'bundle-lockfile'), { recursive: true });
    fs.mkdirSync(J(d, '_app'), { recursive: true });
    fs.writeFileSync(J(d, LOCK), json); // a copy made without fs's copy functions (cp, rsync): the same bytes
    fs.writeFileSync(J(d, '_app/x.js'), 'x');
  }
  return { root, kit, esm, orig, build, json };
}

test('copies of lockfiles: "self" tells the lockfile from a copy at another depth or in another directory', () => {
  const { readMeta } = require('../../src/core/lockfile.cjs');
  const { root, kit, orig, build, json } = svelteProject();
  assert.equal(recordOf(json).self, '.svelte-kit/output/client/bundle-lockfile');
  const here = readMeta(json, J(orig, 'bundle-lockfile'));
  assert.equal(here.anchored, true);
  assert.equal(here.writers[0].pkgs.find(p => p.name === 'kit').path, kit.path);
  // the copy: its context would be two directories above the project
  const copy = readMeta(json, J(build, 'bundle-lockfile'));
  assert.equal(copy.anchored, false);
  assert.deepEqual(copy.writers[0].pkgs.map(p => [p.name, p.unknown, p.path]).sort(),
    [['esm', true, '\0unknown:esm@1.0.0'], ['kit', true, '\0unknown:kit@2.0.0']]);
  assert.deepEqual(copy.writers[0].files, [J(build, '_app/x.js')]); // paths in the output: where they are in the copy
  // a copy at the same depth: its context is the project, but it is not written there
  fs.mkdirSync(J(root, '.svelte-kit/output/other/bundle-lockfile'), { recursive: true });
  assert.equal(readMeta(json, J(root, '.svelte-kit/output/other/bundle-lockfile')).anchored, false);
  // the whole project somewhere else (another checkout path): written there, relative to it
  const moved = `${root}-moved`;
  fs.cpSync(root, moved, { recursive: true });
  assert.equal(readMeta(json, J(moved, '.svelte-kit/output/client/bundle-lockfile')).anchored, true);
  // written by v0.0.3 and before: no "self"
  const old = JSON.stringify({ ...JSON.parse(json), 'bundle-lockfile': { ...recordOf(json), self: undefined } });
  assert.equal(readMeta(old, J(build, 'bundle-lockfile')).anchored, null);
});

test('copies of lockfiles: writing into a directory with a copy - one entry per package, the context is the project', async () => {
  const { root, kit, build } = svelteProject();
  const target = J(build, LOCK);
  const writeFile = (json) => { fs.writeFileSync(target, json); };
  // a later build writes build/ too (another writer: the copy's files are there, so its packages stay)
  outputs.record(target, 'later', [kit], root, [J(build, 'later.js')], { disk: true });
  fs.writeFileSync(J(build, 'later.js'), '');
  outputs.emitted(target, 'later');
  await outputs.rewrite(target, writeFile);
  const json = fs.readFileSync(target, 'utf8');
  // kit from the copy is this build's kit; esm, only in the copy, keeps its name and version, location unknown
  assert.deepEqual(nameVersions(json), ['node_modules/esm = esm@1.0.0', 'node_modules/kit = kit@2.0.0']);
  const m = recordOf(json);
  assert.equal(m.context, '../..'); // the project, not the copy's context (two directories above it)
  assert.equal(m.self, 'build/bundle-lockfile');
  assert.deepEqual(m.unknown, ['node_modules/esm']);
  assert.equal(m.locations, undefined);
  // written again (watch mode, the other writer): the same bytes
  await outputs.rewrite(target, writeFile);
  assert.equal(fs.readFileSync(target, 'utf8'), json);
});

test('copies of lockfiles: a bundled file of a copied output brings its packages by name and version', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('inner'), ...pj('outer') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'island/dist'), chunks: [{ fileName: 'main.js', code: 'island code', modules: [J(root, 'node_modules/inner/i.js')] }] });
    // the island's output copied into the app's source with cp (no fs copy this process sees: the original bytes),
    // to widget/dist (its record says so) and to vendor/island/dist (as if the project had moved to src/vendor/: the
    // record's packages are not where it says)
    for (const d of ['src/widget/dist', 'src/vendor/island/dist']) {
      fs.cpSync(J(root, 'island/dist'), J(root, d), { recursive: true });
      fs.writeFileSync(J(root, d, LOCK), fs.readFileSync(J(root, 'island/dist', LOCK)));
    }
    assert.equal(packages.packagesOfFiles([J(root, 'src/widget/dist/main.js')]).all[0].unknown, true);
    for (const d of ['src/widget/dist', 'src/vendor/island/dist']) {
      const target = J(root, 'dist', d.split('/')[1], LOCK);
      const { all } = packages.packagesOfFiles([J(root, d, 'main.js'), J(root, 'node_modules/outer/i.js')]);
      outputs.record(target, 'app', all, root, [], { disk: true });
      outputs.emitted(target, 'app');
      await outputs.rewrite(target, outputs.writeDisk(target));
      const json = fs.readFileSync(target, 'utf8');
      assert.deepEqual(nameVersions(json), ['node_modules/inner = inner@1.0.0', 'node_modules/outer = outer@1.0.0'], d);
      assert.deepEqual(recordOf(json).unknown, ['node_modules/inner'], d);
      assert.equal(recordOf(json).locations, undefined, d);
    }
  } finally { process.chdir(cwd); }
});

test('copies of lockfiles: a package upgraded in place between two builds of one directory - both versions listed', async () => {
  const root = project({ 'node_modules/x/package.json': { name: 'x', version: '1.0.0' } });
  const target = J(root, 'dist', LOCK);
  const writeFile = (json) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, json); };
  const [x1] = packagesForFiles([J(root, 'node_modules/x/i.js')]);
  outputs.record(target, 'app', [x1], root, [J(root, 'dist/app.js')], { disk: true });
  outputs.emitted(target, 'app');
  // npm install during the watch session: x@2 in the same directory; the other writer's build has it, app.js still x@1
  fs.writeFileSync(J(root, 'node_modules/x/package.json'), JSON.stringify({ name: 'x', version: '2.0.0' }));
  const [x2] = packagesForFiles([J(root, 'node_modules/x/i.js')]);
  outputs.record(target, 'sw', [x2], root, [J(root, 'dist/sw.js')], { disk: true });
  outputs.emitted(target, 'sw');
  await outputs.rewrite(target, writeFile);
  assert.deepEqual(nameVersions(fs.readFileSync(target, 'utf8')), ['node_modules/x@1.0.0 = x@1.0.0', 'node_modules/x = x@2.0.0']);
  // another process with x@2 reads that lockfile: still both, the same bytes
  const { readMeta } = require('../../src/core/lockfile.cjs');
  const json = fs.readFileSync(target, 'utf8');
  const read = readMeta(json, path.dirname(target)).writers;
  const all = read.flatMap(w => w.pkgs);
  assert.deepEqual(all.map(p => `${p.name}@${p.version}${p.unknown ? ' (unknown)' : ''}`).sort(), ['x@1.0.0 (unknown)', 'x@2.0.0']);
});

test('copies of lockfiles: a package no longer where another process recorded it (reinstalled, removed) is listed once', async () => {
  const root = project({ 'node_modules/.pnpm/a@1.0.0_peer@1/node_modules/a/package.json': { name: 'a', version: '1.0.0' },
    'node_modules/.pnpm/gone@1.0.0/node_modules/gone/package.json': { name: 'gone', version: '1.0.0' }, 'dist/other.js': '' });
  const target = J(root, 'dist', LOCK);
  const writeFile = (json) => { fs.writeFileSync(target, json); };
  const [a, gone] = packagesForFiles([J(root, 'node_modules/.pnpm/a@1.0.0_peer@1/node_modules/a/i.js'), J(root, 'node_modules/.pnpm/gone@1.0.0/node_modules/gone/i.js')]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, toPackageLock([a, gone], root, { dir: path.dirname(target), writers: [{ id: 'other', files: [J(root, 'dist/other.js')], paths: [a.path, gone.path] }] }));
  // pnpm install again: another peer suffix, the old directory gone; gone@1.0.0 removed
  fs.renameSync(J(root, 'node_modules/.pnpm/a@1.0.0_peer@1'), J(root, 'node_modules/.pnpm/a@1.0.0_peer@2'));
  fs.rmSync(J(root, 'node_modules/.pnpm/gone@1.0.0'), { recursive: true });
  const [a2] = packagesForFiles([J(root, 'node_modules/.pnpm/a@1.0.0_peer@2/node_modules/a/i.js')]);
  outputs.record(target, 'mine', [a2], root, [J(root, 'dist/mine.js')], { disk: true });
  fs.writeFileSync(J(root, 'dist/mine.js'), '');
  outputs.emitted(target, 'mine');
  await outputs.rewrite(target, writeFile);
  const json = fs.readFileSync(target, 'utf8');
  assert.deepEqual(nameVersions(json), ['node_modules/.pnpm/a@1.0.0_peer@2/node_modules/a = a@1.0.0', 'node_modules/gone = gone@1.0.0']);
  assert.deepEqual(recordOf(json).unknown, ['node_modules/gone']);
});

test('copies of lockfiles: unknown packages give the same bytes whichever process writes last', () => {
  const { readMeta } = require('../../src/core/lockfile.cjs');
  const root = project({ 'node_modules/x/package.json': { name: 'x', version: '1.0.0' } });
  const dir = J(root, 'dist/bundle-lockfile');
  const [x] = packagesForFiles([J(root, 'node_modules/x/i.js')]);
  const xUnknown = { ...x, path: '\0unknown:x@1.0.0', unknown: true };
  // process A only knows x from a copy (location unknown), process B has it in node_modules; each writes in turn,
  // with its own build and the other's record
  const write = (own, prev) => {
    const theirs = prev ? readMeta(prev, dir).writers.filter(w => w.id !== own.id) : [];
    const pkgs = [...own.pkgs, ...theirs.flatMap(w => w.pkgs)];
    const byPath = new Map(pkgs.map(p => [p.path, p]));
    return toPackageLock([...byPath.values()], root, { dir, writers: [{ id: own.id, files: [], paths: own.pkgs.map(p => p.path) },
      ...theirs.map(w => ({ id: w.id, files: [], paths: w.pkgs.map(p => p.path) }))] });
  };
  const A = { id: 'a', pkgs: [xUnknown] }, B = { id: 'b', pkgs: [x] };
  const a1 = write(A, null), b1 = write(B, a1), a2 = write(A, b1), b2 = write(B, a2);
  assert.deepEqual(nameVersions(a1), ['node_modules/x = x@1.0.0']);
  assert.deepEqual(recordOf(a1).unknown, ['node_modules/x']);
  for (const json of [b1, a2, b2]) assert.equal(json, b1);
  assert.equal(recordOf(b1).unknown, undefined);
});

test('outputs: another record in the output keeps no writer without files, and does not change this build\'s packages', async () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0', license: 'MIT' }, 'node_modules/b/package.json': { name: 'b', version: '1.0.0' } });
  const dist = J(root, 'dist'), target = J(dist, LOCK);
  const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]), [b] = packagesForFiles([J(root, 'node_modules/b/i.js')]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(J(dist, 'other.js'), '');
  // on disk before the build (another process's, or put there by hand): a writer with no files, which has nothing in
  // the output, and one whose file is there, with this build's package under another license
  fs.writeFileSync(target, toPackageLock([b, { ...a, license: 'Unlicensed' }], root, { dir: path.dirname(target),
    writers: [{ id: 'empty', files: [], paths: [b.path] }, { id: 'other', files: [J(dist, 'other.js')], paths: [a.path] }] }));
  outputs.record(target, 'mine', [a], root, [J(dist, 'main.js')], { disk: true });
  fs.writeFileSync(J(dist, 'main.js'), '');
  outputs.emitted(target, 'mine');
  await outputs.rewrite(target, (j) => { fs.writeFileSync(target, j); });
  const out = fs.readFileSync(target, 'utf8');
  assert.deepEqual(nameVersions(out), ['node_modules/a = a@1.0.0']);
  assert.equal(JSON.parse(out).packages['node_modules/a'].license, 'MIT'); // the package.json this process read
  assert.deepEqual(recordOf(out).writers.map(w => w.id).filter(id => id === 'empty' || id === 'other'), ['other']);
});

test('copies of lockfiles: a record without "self" none of whose packages is there gives no context', async () => {
  const { root, kit, build, json } = svelteProject();
  const target = J(build, LOCK);
  fs.writeFileSync(target, JSON.stringify({ ...JSON.parse(json), 'bundle-lockfile': { ...recordOf(json), self: undefined } })); // v0.0.3's copy
  outputs.record(target, 'later', [kit], root, [J(build, 'later.js')], { disk: true });
  fs.writeFileSync(J(build, 'later.js'), '');
  outputs.emitted(target, 'later');
  await outputs.rewrite(target, (j) => { fs.writeFileSync(target, j); });
  const out = fs.readFileSync(target, 'utf8');
  assert.equal(recordOf(out).context, '../..');
  assert.deepEqual(nameVersions(out), ['node_modules/esm = esm@1.0.0', 'node_modules/kit = kit@2.0.0']);
});

test('copies of lockfiles: copied with fs in this process - re-anchored where they are, followed while unchanged', async () => {
  const { readMeta } = require('../../src/core/lockfile.cjs');
  const copies = require('../../src/core/copies.cjs');
  copies.install();
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), 'other/package-lock.json': '{"lockfileVersion":3,"packages":{}}' });
  const [a, b] = ['a', 'b'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const target = J(root, '.svelte-kit/output/client', LOCK);
  const write = () => outputs.rewrite(target, outputs.writeDisk(target));
  outputs.record(target, 'client', [a], root, [J(root, '.svelte-kit/output/client/x.js')], { disk: true });
  outputs.emitted(target, 'client');
  await write();
  const valid = (file) => {
    const meta = readMeta(fs.readFileSync(file, 'utf8'), path.dirname(file));
    return meta.anchored === true && meta.writers[0].pkgs.every(p => !p.unknown && fs.existsSync(J(p.path, 'package.json')));
  };
  // SvelteKit's copy(): fs.copyFileSync, file by file; and the other copy functions
  const to = (d) => J(root, d, LOCK);
  for (const d of ['build', 'callback/x', 'promise', 'dir/a/b']) fs.mkdirSync(path.dirname(to(d)), { recursive: true });
  fs.copyFileSync(target, to('build'));
  // the copy is re-anchored before the copy's callback runs
  assert.equal(await new Promise((res, rej) => fs.copyFile(target, to('callback/x'), (e) => (e ? rej(e) : res(valid(to('callback/x')))))), true);
  await fs.promises.copyFile(target, to('promise'));
  fs.cpSync(J(root, '.svelte-kit/output'), J(root, 'dir/a/b'), { recursive: true }); // a directory with the lockfile in client/
  const copiesOf = ['build', 'callback/x', 'promise', 'dir/a/b/client'].map(to);
  for (const f of copiesOf) assert.equal(valid(f), true, f);
  assert.equal(recordOf(fs.readFileSync(to('build'), 'utf8')).context, '../..');
  // a copy of a copy: re-anchored too
  fs.mkdirSync(J(root, 'deep/er/bundle-lockfile'), { recursive: true });
  fs.copyFileSync(to('build'), J(root, 'deep/er', LOCK));
  assert.equal(valid(J(root, 'deep/er', LOCK)), true);
  // another package-lock.json: copied as it is
  fs.copyFileSync(J(root, 'other/package-lock.json'), J(root, 'other/copy.json'));
  fs.mkdirSync(J(root, 'other2'), { recursive: true });
  fs.copyFileSync(J(root, 'other/package-lock.json'), J(root, 'other2/package-lock.json'));
  assert.equal(fs.readFileSync(J(root, 'other2/package-lock.json'), 'utf8'), '{"lockfileVersion":3,"packages":{}}');
  // the lockfile written again after the copies (files written after the build): the copies get the new packages,
  // except one changed since it was copied
  fs.appendFileSync(to('promise'), ' ');
  outputs.record(target, 'client', [a, b], root, [J(root, '.svelte-kit/output/client/x.js')], { disk: true });
  outputs.emitted(target, 'client');
  await write();
  for (const f of [...copiesOf.filter(c => c !== to('promise')), J(root, 'deep/er', LOCK)]) {
    assert.deepEqual(lockedNames(fs.readFileSync(f, 'utf8')), ['a', 'b'], f);
    assert.equal(valid(f), true, f);
  }
  assert.deepEqual(lockedNames(fs.readFileSync(to('promise'), 'utf8')), ['a']);
  // a copy removed since (its directory cleaned): no longer followed, without a warning
  fs.rmSync(J(root, 'build'), { recursive: true });
  outputs.record(target, 'client', [a], root, [J(root, '.svelte-kit/output/client/x.js')], { disk: true });
  outputs.emitted(target, 'client');
  assert.deepEqual(await (async () => { const seen = []; const orig = config.warn; config.warn = (...m) => seen.push(m.join(' '));
    try { await write(); } finally { config.warn = orig; } return seen; })(), []);
  assert.equal(fs.existsSync(to('build')), false);
});

test('copies of outputs: an output\'s files copied with fs elsewhere without the lockfile get a copy of it (Nitro\'s public assets), followed', async () => {
  const { readMeta } = require('../../src/core/lockfile.cjs');
  const copies = require('../../src/core/copies.cjs');
  copies.install();
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), '.nuxt/dist/client/_nuxt/e.js': 'e', '.nuxt/dist/client/_nuxt/f.css': 'f', '.nuxt/dist/client/notes.txt': 'n',
    'dist2/x.js': 'x' });
  const [a, b] = ['a', 'b'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const client = J(root, '.nuxt/dist/client'), target = J(client, LOCK);
  const files = [J(client, '_nuxt/e.js'), J(client, '_nuxt/f.css')];
  const write = () => outputs.rewrite(target, outputs.writeDisk(target));
  outputs.record(target, 'nuxt-client', [a], root, files, { disk: true });
  outputs.emitted(target, 'nuxt-client');
  // another output: nothing is copied into it, and nothing next to it
  const other = J(root, 'dist2', LOCK);
  outputs.record(other, 'other', [b], root, [J(root, 'dist2/x.js')], { disk: true });
  outputs.emitted(other, 'other');
  // a copy before the lockfile is written: the copy gets it when it is
  fs.mkdirSync(J(root, 'early/_nuxt'), { recursive: true });
  fs.copyFileSync(files[0], J(root, 'early/_nuxt/e.js'));
  assert.equal(fs.existsSync(J(root, 'early', LOCK)), false);
  await write();
  await outputs.rewrite(other, outputs.writeDisk(other));
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'early', LOCK), 'utf8')), ['a']);
  const valid = (file) => {
    const meta = readMeta(fs.readFileSync(file, 'utf8'), path.dirname(file));
    return meta.anchored === true && meta.writers[0].pkgs.every(p => !p.unknown && fs.existsSync(J(p.path, 'package.json')));
  };
  // Nitro: fs.promises.cp of each file of .nuxt/dist/client/_nuxt into .output/public/_nuxt
  for (const f of files) await fs.promises.cp(f, J(root, '.output/public/_nuxt', path.basename(f)));
  assert.equal(valid(J(root, '.output/public', LOCK)), true);
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, '.output/public', LOCK), 'utf8')), ['a']);
  // a directory of the output: the same
  fs.cpSync(J(client, '_nuxt'), J(root, 'pub2/_nuxt'), { recursive: true });
  assert.equal(valid(J(root, 'pub2', LOCK)), true);
  // not: a file of the output directory no writer emits, a copy into another output, a copy up into the project (the
  // place would contain the outputs), a copy below node_modules
  fs.mkdirSync(J(root, 'pub3'), { recursive: true });
  fs.copyFileSync(J(client, 'notes.txt'), J(root, 'pub3/notes.txt'));
  fs.mkdirSync(J(root, 'dist2/_nuxt'), { recursive: true });
  fs.copyFileSync(files[0], J(root, 'dist2/_nuxt/e.js'));
  fs.copyFileSync(files[0], J(root, 'top.js'));
  fs.mkdirSync(J(root, 'node_modules/c/_nuxt'), { recursive: true });
  fs.copyFileSync(files[0], J(root, 'node_modules/c/_nuxt/e.js'));
  for (const d of ['pub3', 'dist2/_nuxt', '.', '..', 'node_modules/c']) assert.equal(fs.existsSync(J(root, d, LOCK)), false, d);
  assert.deepEqual(lockedNames(fs.readFileSync(other, 'utf8')), ['b']);
  // the lockfile written again: the copies follow
  outputs.record(target, 'nuxt-client', [a, b], root, files, { disk: true });
  outputs.emitted(target, 'nuxt-client');
  await write();
  for (const d of ['.output/public', 'pub2', 'early']) assert.deepEqual(lockedNames(fs.readFileSync(J(root, d, LOCK), 'utf8')), ['a', 'b'], d);
  // a destination not cleaned since an earlier run: the copy that run left there is replaced; another build's lockfile not
  const idOf = (w) => crypto.createHash('sha256').update(w).digest('hex').slice(0, 16);
  for (const [d, id] of [['old', idOf('nuxt-client')], ['theirs', 'another-build']]) {
    fs.mkdirSync(J(root, d, 'bundle-lockfile'), { recursive: true });
    fs.writeFileSync(J(root, d, LOCK), toPackageLock([], root, { dir: J(root, d, 'bundle-lockfile'), writers: [{ id, files: [J(root, d, '_nuxt/e.js')], paths: [] }] }));
    fs.mkdirSync(J(root, d, '_nuxt'), { recursive: true });
    fs.copyFileSync(files[0], J(root, d, '_nuxt/e.js'));
  }
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'old', LOCK), 'utf8')), ['a', 'b']);
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'theirs', LOCK), 'utf8')), []);
  // with BUNDLE_LOCKFILE_INLINE=0: no lockfile in outputs, none in copies of them
  await withConfig({ inline: false }, async () => {
    fs.mkdirSync(J(root, 'pub4/_nuxt'), { recursive: true });
    fs.copyFileSync(files[0], J(root, 'pub4/_nuxt/e.js'));
    assert.equal(fs.existsSync(J(root, 'pub4', LOCK)), false);
  });
});

test('outputs: the export copy is written under its own lock also with the inline lockfile (a write without it locks only that one)', () => withConfig({ exportDir: null, exportBase: null }, async () => {
  const { lock } = require('../../src/core/lock.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  config.exportDir = J(root, 'export');
  config.exportBase = root;
  const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]);
  const target = J(root, 'dist', LOCK);
  outputs.record(target, 'export-lock', [a], root, [J(root, 'dist/x.js')], { disk: true });
  outputs.emitted(target, 'export-lock');
  // (as Angular's write of the export copy, or one whose output directory is gone, holds it)
  const release = await lock(exportPath(target));
  let done = false;
  const write = outputs.rewrite(target, outputs.writeDisk(target)).then(() => { done = true; });
  await new Promise(res => setTimeout(res, 200));
  assert.equal(done, false);
  release();
  await write;
  assert.deepEqual(lockedNames(fs.readFileSync(exportPath(target), 'utf8')), ['a']);
}));

test('copies of lockfiles: an export copy copied with fs is re-anchored like its lockfile', () => withConfig({ exportDir: null }, async () => {
  const { readMeta } = require('../../src/core/lockfile.cjs');
  const copies = require('../../src/core/copies.cjs');
  copies.install();
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  config.exportDir = J(root, 'export');
  config.exportBase = root;
  try {
    const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]);
    const target = J(root, 'ui/dist', LOCK);
    outputs.record(target, 'ui', [a], root, [J(root, 'ui/dist/x.js')], { disk: true });
    outputs.emitted(target, 'ui');
    await outputs.rewrite(target, null); // export copy only
    const exp = exportPath(target);
    assert.equal(fs.existsSync(target), false);
    fs.mkdirSync(J(root, 'pkg/usr/share/app/bundle-lockfile'), { recursive: true });
    fs.copyFileSync(exp, J(root, 'pkg/usr/share/app', LOCK));
    const meta = readMeta(fs.readFileSync(J(root, 'pkg/usr/share/app', LOCK), 'utf8'), J(root, 'pkg/usr/share/app/bundle-lockfile'));
    assert.equal(meta.anchored, true);
    assert.equal(meta.writers[0].pkgs[0].path, a.path);
  } finally { config.exportBase = null; }
}));

// --- the core write path: what cannot be read, locked or written, and what must not be replaced

test('lock: a stale lock that cannot be removed, a lock that is a link to nothing, a lock that cannot be made: never a busy loop', { skip: process.platform === 'win32' }, () => {
  // in a child process with a time limit: a lock() that loops forever must fail the test, not hang it
  const root = project({ blocker: '' });
  const run = (setup) => {
    const script = `const fs = require('fs'); const { lock } = require(${JSON.stringify(J(SRC, 'core/lock.cjs'))});
      const problems = require(${JSON.stringify(J(SRC, 'core/problems.cjs'))});
      ${setup}
      const t = Date.now(); lock(file, { wait: 300 }).then((release) => { release(); console.log(JSON.stringify({ took: Date.now() - t, problems: problems.take() })); });`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: strictEnv(undefined), timeout: 15000 });
    assert.equal(r.status, 0, `lock() did not return: ${r.signal || r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const old = (Date.now() - 120000) / 1000;
  // a stale lock in a directory this user may not change (another user's, a read-only file system): rename fails
  fs.mkdirSync(J(root, 'a'));
  fs.writeFileSync(J(root, 'a/l.json.lock'), 'died');
  fs.utimesSync(J(root, 'a/l.json.lock'), old, old);
  const a = run(`const file = ${JSON.stringify(J(root, 'a/l.json'))}; const rename = fs.renameSync;
    fs.renameSync = (x, y) => { if (x === file + '.lock') { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return rename(x, y); };`);
  assert.ok(a.took >= 300, `${a.took} ms`);
  assert.match(a.problems.join(), /could not lock .*l\.json - writing it without the lock/);
  assert.equal(fs.readFileSync(J(root, 'a/l.json.lock'), 'utf8'), 'died');
  // a lock that is a symbolic link to nothing: fresh, it is waited for; as old as a stale lock, it is taken over
  fs.mkdirSync(J(root, 'b'));
  fs.symlinkSync(J(root, 'nothing'), J(root, 'b/l.json.lock'));
  const fresh = run(`const file = ${JSON.stringify(J(root, 'b/l.json'))};`);
  assert.ok(fresh.took >= 300, `${fresh.took} ms`);
  assert.equal(fresh.problems.length, 1);
  fs.lutimesSync(J(root, 'b/l.json.lock'), old, old);
  assert.deepEqual(run(`const file = ${JSON.stringify(J(root, 'b/l.json'))};`).problems, []);
  assert.deepEqual(fs.readdirSync(J(root, 'b')), []);
  // a lock that cannot be made (its directory cannot be created: a file is in the way): a problem, not a silent write
  const c = run(`const file = ${JSON.stringify(J(root, 'blocker/sub/l.json'))};`);
  assert.equal(c.problems.length, 1);
  assert.match(c.problems[0], /could not lock .*blocker.sub.l\.json - writing it without the lock .*: E(NOTDIR|EXIST)/);
});

test('lock: a live lock is not taken over by a process whose clock is ahead (a network file system has the server\'s time)', { skip: process.platform === 'win32' }, () => {
  const root = project({});
  fs.mkdirSync(J(root, 'd'));
  fs.writeFileSync(J(root, 'd/l.json.lock'), 'live');
  const script = `const real = Date.now; Date.now = () => real() + 120000; // this machine's clock: two minutes ahead
    const { lock } = require(${JSON.stringify(J(SRC, 'core/lock.cjs'))});
    const problems = require(${JSON.stringify(J(SRC, 'core/problems.cjs'))});
    lock(${JSON.stringify(J(root, 'd/l.json'))}, { wait: 300 }).then((release) => { release(); console.log(JSON.stringify(problems.take())); });`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: strictEnv(undefined), timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).join(), /could not lock/);
  assert.equal(fs.readFileSync(J(root, 'd/l.json.lock'), 'utf8'), 'live');
});

test('lock: a lock dated in the future is stale (it would hold every write off); a live one is not, for a clock behind', { skip: process.platform === 'win32' }, () => {
  const root = project({});
  fs.mkdirSync(J(root, 'd'));
  const run = (clock) => {
    const script = `const real = Date.now; Date.now = () => real() + (${clock});
      const { lock } = require(${JSON.stringify(J(SRC, 'core/lock.cjs'))});
      const problems = require(${JSON.stringify(J(SRC, 'core/problems.cjs'))});
      lock(${JSON.stringify(J(root, 'd/l.json'))}, { wait: 300 }).then((release) => { release(); console.log(JSON.stringify(problems.take())); });`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: strictEnv(undefined), timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  // touch -d 2099: taken over at once, and released
  fs.writeFileSync(J(root, 'd/l.json.lock'), 'future');
  const future = new Date('2099-01-01');
  fs.utimesSync(J(root, 'd/l.json.lock'), future, future);
  assert.deepEqual(run(0), []);
  assert.deepEqual(fs.readdirSync(J(root, 'd')), [], 'nothing left behind');
  // a live lock, by a process whose clock is two minutes behind the file system's: it looks as if from the future
  fs.writeFileSync(J(root, 'd/l.json.lock'), 'live');
  assert.match(run(-120000).join(), /could not lock/);
  assert.equal(fs.readFileSync(J(root, 'd/l.json.lock'), 'utf8'), 'live');
});

test('lock: the temporary file of an atomic write is a new file, never one that is there', { skip: process.platform === 'win32' }, () => {
  const { writeAtomic } = require('../../src/core/lock.cjs');
  const root = project({ 'victim.txt': 'mine' });
  const open = fs.openSync, opened = [];
  fs.openSync = function (p, flags, ...rest) { opened.push([path.basename(String(p)), flags]); return open.call(this, p, flags, ...rest); };
  try { writeAtomic(J(root, 'out/file.json'), 'new'); } finally { fs.openSync = open; }
  assert.equal(opened.length, 1);
  assert.match(opened[0][0], /^file\.json\.\d+\.[0-9a-f]{16}\.tmp$/);
  assert.equal(opened[0][1], 'wx');
  assert.equal(fs.readFileSync(J(root, 'out/file.json'), 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(J(root, 'out')), ['file.json']);
  // a file where the temporary file would be (a symbolic link put there): the write fails, and leaves it alone
  const at = J(root, 'out/x.json'), names = crypto.randomBytes;
  crypto.randomBytes = () => Buffer.alloc(8);
  fs.symlinkSync(J(root, 'victim.txt'), `${at}.${process.pid}.0000000000000000.tmp`);
  try { assert.throws(() => writeAtomic(at, 'evil'), /EEXIST/); } finally { crypto.randomBytes = names; }
  assert.equal(fs.readFileSync(J(root, 'victim.txt'), 'utf8'), 'mine');
  assert.equal(fs.existsSync(at), false);
});

test('outputs: a shared lockfile that cannot be read (anything but "not there") is a problem: other processes\' packages would be lost', () => withConfig({ strict: true }, () => {
  problems.take();
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const target = J(root, 'dist', LOCK);
  fs.mkdirSync(target, { recursive: true }); // EISDIR: as EACCES or EMFILE, it hides what the other processes recorded
  const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]);
  assert.deepEqual(lockedNames(outputs.record(target, 'w', [a], root, [], { disk: true })), ['a']);
  const taken = problems.take();
  assert.equal(taken.length, 1, JSON.stringify(taken));
  assert.match(taken[0], /^could not read .*package-lock\.json: the packages other processes recorded there may be missing: EISDIR/);
  // not there, or a file where one of its directories would be: nothing recorded there, no problem
  const none = J(root, 'none', LOCK);
  fs.writeFileSync(J(root, 'none'), 'a file');
  outputs.record(none, 'w', [a], root, [], { disk: true });
  outputs.record(J(root, 'fresh', LOCK), 'w', [a], root, [], { disk: true });
  assert.deepEqual(problems.take(), []);
}));

test('copies of lockfiles: a copy that cannot be re-anchored is a problem (its record would be the original\'s, never followed)', () => withConfig({ strict: true }, async () => {
  const copies = require('../../src/core/copies.cjs');
  copies.install();
  problems.take();
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]);
  const target = J(root, 'out/client', LOCK);
  outputs.record(target, 'client', [a], root, [J(root, 'out/client/x.js')], { disk: true });
  outputs.emitted(target, 'client');
  await outputs.rewrite(target, outputs.writeDisk(target));
  const to = J(root, 'build', LOCK);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const rename = fs.renameSync;
  fs.renameSync = (x, y) => { if (y === to) { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; } return rename(x, y); };
  try { fs.copyFileSync(target, to); } finally { fs.renameSync = rename; }
  const taken = problems.take();
  assert.equal(taken.length, 1, JSON.stringify(taken));
  assert.match(taken[0], /^could not write the copy .*build.bundle-lockfile.package-lock\.json of .*client.bundle-lockfile.package-lock\.json: ENOSPC/);
}));

test('outputs: a writer whose first build in this process failed keeps the record its earlier process left for its output', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('c'), 'dist/sw.js': 'sw' });
  const [a, c] = ['a', 'c'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const target = J(root, 'dist', LOCK);
  // an earlier process wrote sw.js (with c); its writer's id is the one this process's sw compiler has
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, toPackageLock([c], root, { dir: path.dirname(target), writers: [{ id: 'sw-id', files: [J(root, 'dist/sw.js')], paths: [c.path] }] }));
  // this process: sw's build fails (recorded, never written), app's lands - sw.js and its packages are still in dist/
  outputs.record(target, 'sw', [], root, [J(root, 'dist/sw.js')], { disk: true, id: 'sw-id' });
  outputs.record(target, 'app', [a], root, [J(root, 'dist/app.js')], { disk: true, id: 'app-id' });
  outputs.emitted(target, 'app');
  await outputs.rewrite(target, outputs.writeDisk(target)).then((e) => { if (e) throw e; });
  assert.deepEqual(lockedNames(fs.readFileSync(target, 'utf8')), ['a', 'c']);
});

test('outputs: a package-lock.json bundle-lockfile did not write (the project\'s own npm lockfile) is never replaced', async () => {
  // BUNDLE_LOCKFILE_FILE=package-lock.json and an output directory that is the project (Rollup's output.file: 'bundle.js')
  const npm = JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'app' } } }, null, 2);
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'package-lock.json': npm });
  const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]);
  const target = J(root, 'package-lock.json');
  outputs.record(target, 'w', [a], root, [J(root, 'bundle.js')], { disk: true });
  outputs.emitted(target, 'w');
  const write = () => outputs.rewrite(target, outputs.writeDisk(target));
  const err = await write();
  assert.match(err && err.message, /package-lock\.json is there and was not written by bundle-lockfile \(e\.g\. npm's own lockfile\): it is not replaced/);
  assert.equal(fs.readFileSync(target, 'utf8'), npm);
  // one bundle-lockfile wrote: replaced
  fs.unlinkSync(target);
  assert.equal(await write(), undefined);
  assert.equal(await write(), undefined);
  assert.deepEqual(lockedNames(fs.readFileSync(target, 'utf8')), ['a']);
});

test('generated: the content hash of a binary asset is of its bytes (two fonts are not one); text as before', () => {
  const generated = require('../../src/core/generated.cjs');
  assert.notEqual(generated.hash(Buffer.from([0x00, 0xff, 0x01])), generated.hash(Buffer.from([0x00, 0xfe, 0x01])));
  assert.equal(generated.hash('x\n//# sourceMappingURL=x.js.map'), generated.hash(Buffer.from('x')));
  assert.equal(generated.hash(new Uint8Array(Buffer.from('ü'))), generated.hash('ü'));
});

test('generated: a package file a worker build emits (a font, wasm) is listed in the build that ships the worker', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/font/package.json': { name: 'font', version: '1.0.0' }, 'src/w.js': '', 'src/main.js': '' });
  const bytes = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff, 0x10]);
  fs.writeFileSync(J(root, 'node_modules/font/f.woff2'), bytes);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    // Vite's worker build: generate-only, the font emitted from its file
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: '', isWrite: false, chunks: [{ fileName: 'w.js', code: 'worker', modules: [J(root, 'src/w.js')], entry: J(root, 'src/w.js') }],
      assets: [{ fileName: 'assets/f-1.woff2', originalFileNames: ['node_modules/font/f.woff2'], source: bytes }] });
    // the parent emits the worker's assets again, without naming the file
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'dist'), chunks: [{ fileName: 'main.js', code: 'main', modules: [J(root, 'src/main.js')] }],
      assets: [{ fileName: 'assets/w.js', source: 'worker' }, { fileName: 'assets/f-1.woff2', source: Buffer.from(bytes) }] });
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['font']);
  } finally { process.chdir(cwd); }
});

test('generated: more chunks than kept warns once; packages of generate-only chunks no written output had warn when the process ends', () => {
  const lru = require('../../src/core/lru.cjs');
  const m = new Map();
  assert.deepEqual([lru.set(m, 'a', 1, 2), lru.set(m, 'b', 1, 2), lru.set(m, 'c', 1, 2), [...m.keys()]], [false, false, true, ['b', 'c']]);
  const gen = JSON.stringify(J(SRC, 'core/generated.cjs'));
  const run = (code) => spawnSync(process.execPath, ['-e', `const g = require(${gen}); const p = (n) => ({ name: n, version: '1.0.0', path: '/p/node_modules/' + n });\n${code}`],
    { encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BUNDLE_LOCKFILE_'))) });
  // a chunk whose bytes reached no output, and no lockfile of the process lists its packages
  let r = run("g.addChunk('chunk one', [p('a'), p('b')]); g.addChunk('chunk two', [p('b')]);");
  assert.equal(r.status, 0);
  assert.match(r.stderr, /WARNING: the output of a build that writes nothing itself \(generate\(\), write: false\) reached no output this process wrote, so no lockfile lists a@1\.0\.0, b@1\.0\.0 /);
  // its bytes were found (in a written chunk or asset), or its entry was imported (?worker&inline): nothing to say
  r = run("g.addChunk('chunk one', [p('a')]); g.byContent('chunk one');");
  assert.deepEqual([r.status, r.stderr], [0, '']);
  r = run("g.addChunk('chunk one', [p('a')]); g.addEntry('/p/w.js', [p('a')]); g.byEntry('/p/w.js');");
  assert.deepEqual([r.status, r.stderr], [0, '']);
  // more than 10000: the oldest are forgotten, once said
  r = run("for (let i = 0; i < 10002; i++) { g.addChunk('c' + i, [p('a')]); g.byContent('c' + i); }");
  assert.equal(r.status, 0);
  assert.equal((r.stderr.match(/WARNING: more than 10000 chunks of builds that write nothing themselves/g) || []).length, 1, r.stderr);
});
