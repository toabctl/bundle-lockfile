'use strict';
// Unit tests of strict mode: what makes a lockfile missing or incomplete fails the build (BUNDLE_LOCKFILE_STRICT=0: a
// warning).
// All unit tests: node --test test/unit/*.test.cjs (see test/README.md)
// (helpers.cjs first: see there)
const {
  packagesForFiles, strictEnv, nodeWith, SRC, J, pathToFileURLHref, project, BUNDLERS, warnings, fakeCompiler,
  compilation, LOCK, plugin, lockedNames, withConfig, fakeCompiler5, rollupBuild, fakeRspack, rspackCompilation,
  ESBUILD_MAIN, esbuildCall, cjsHookScript, cjsEnv,
} = require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const packages = require('../../src/core/packages.cjs');
const outputs = require('../../src/core/outputs.cjs');
const config = require('../../src/core/config.cjs');
const webpackAdapter = require('../../src/adapters/webpack.cjs');
const problems = require('../../src/core/problems.cjs');
const rspackAdapter = require('../../src/adapters/rspack.cjs');

test('strict: a lockfile on disk whose record this bundle-lockfile cannot read (another version, another shape) fails the build that would replace it', () => withConfig({ strict: true }, async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), 'dist/other.js': 'x' });
  const target = J(root, 'dist', LOCK);
  const a = packagesForFiles([J(root, 'node_modules/a/i.js')])[0];
  for (const [record, why] of [
    [{ v: 1, writers: [{ id: 'w', files: ['../other.js'], packages: [1] }] }, /has a record of version 1, which this bundle-lockfile does not read/],
    [{ v: 2, writers: 'x' }, /has a bundle-lockfile record of a shape it does not read/],
  ]) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ lockfileVersion: 3, requires: true, packages: { '': {}, 'node_modules/left-pad': { name: 'left-pad', version: '1.3.0' } }, 'bundle-lockfile': record }));
    const writer = `unreadable-${JSON.stringify(record)}`;
    outputs.record(target, writer, [a], root, [J(root, 'dist/main.js')], { disk: true });
    await outputs.land(target, writer, 'test');
    const taken = problems.take();
    assert.ok(taken.some(t => why.test(t) && t.includes(target) && /the packages of the other builds it lists would be missing/.test(t)), taken.join('\n'));
  }
  // npm's own lockfile (no record): not replaced, which is a problem of its own (see ours)
}));

test('strict: a problem of a build that writes nothing itself fails it with that problem (not wrapped in another)', () => withConfig({ strict: true }, async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/nopj/i.js': '' });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    problems.take();
    const ctx = { error: (e) => { throw e; } };
    await assert.rejects(rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'gen'), isWrite: false, ctx,
      chunks: [{ fileName: 'w.js', code: 'worker without a package.json', modules: [J(root, 'node_modules/nopj/i.js')] }] }), (e) => {
      assert.match(e.message, /no package\.json with name and version in \S*nopj/);
      assert.doesNotMatch(e.message, /could not collect the bundled packages/);
      return true;
    });
  } finally { process.chdir(cwd); }
}));

test('strict: a nested build\'s lockfile that cannot be read fails the build that bundles its output (BUNDLE_LOCKFILE_STRICT=0: a warning)', () => {
  const lock = (record) => JSON.stringify({ lockfileVersion: 3, requires: true, packages: { '': {} }, ...(record === undefined ? {} : { 'bundle-lockfile': record }) });
  const cases = [
    ['not JSON', '{ "lockfileVersion": 3,', 'is not JSON'],
    ['another version', lock({ v: 1, context: '.', writers: [] }), 'has a record of version 1, which this bundle-lockfile does not read (it reads version 2): build it again with this one'],
    ['another shape', lock({ v: 2, context: 1, writers: 'x' }), 'has a bundle-lockfile record of a shape it does not read'],
  ];
  for (const [what, content, why] of cases) {
    const root = project({ 'island/dist/main.js': 'x', 'island/dist/bundle-lockfile/package-lock.json': content });
    const file = J(root, 'island/dist/bundle-lockfile/package-lock.json');
    const msg = `${file} ${why}: the packages of the build that wrote ${J(root, 'island/dist')} would be missing (a bundled file there may be its output)`;
    const script = `const p = require(${JSON.stringify(J(SRC, 'core/packages.cjs'))}); const problems = require(${JSON.stringify(J(SRC, 'core/problems.cjs'))});
      p.packagesOfFiles([${JSON.stringify(J(root, 'island/dist/main.js'))}]); console.log(JSON.stringify(problems.take()));`;
    const strict = nodeWith(strictEnv(undefined), ['-e', script]);
    assert.deepEqual(JSON.parse(strict.stdout), [msg], `${what}: ${strict.stderr}`);
    const off = nodeWith(strictEnv('0'), ['-e', script]);
    assert.deepEqual([JSON.parse(off.stdout), off.stderr], [[], `[bundle-lockfile] WARNING: ${msg}\n`], what);
  }
  // a lockfile that cannot be read (a directory in its place; permissions do not stop root, which runs the tests in CI)
  const dir = project({ 'island/dist/main.js': 'x', 'island/dist/bundle-lockfile/package-lock.json/x': '' });
  const unreadable = nodeWith(strictEnv(undefined), ['-e', `const p = require(${JSON.stringify(J(SRC, 'core/packages.cjs'))}); const problems = require(${JSON.stringify(J(SRC, 'core/problems.cjs'))});
    p.packagesOfFiles([${JSON.stringify(J(dir, 'island/dist/main.js'))}]); console.log(JSON.stringify(problems.take()));`]);
  const [got] = JSON.parse(unreadable.stdout);
  const lockAt = J(dir, 'island/dist/bundle-lockfile/package-lock.json');
  assert.ok(got.startsWith(`could not read ${lockAt}: the packages of the build that wrote ${J(dir, 'island/dist')} would be missing (a bundled file there may be its output): EISDIR`), got);
  // the project's own lockfile (BUNDLE_LOCKFILE_FILE=package-lock.json, an output directory that is the project): no
  // record, nothing to say; no lockfile at all: nothing either
  const own = project({ 'src/a.js': 'x', 'package-lock.json': lock(undefined), 'other/b.js': 'x' });
  const script = `const p = require(${JSON.stringify(J(SRC, 'core/packages.cjs'))}); const problems = require(${JSON.stringify(J(SRC, 'core/problems.cjs'))});
    p.packagesOfFiles([${JSON.stringify(J(own, 'src/a.js'))}, ${JSON.stringify(J(own, 'other/b.js'))}]); console.log(JSON.stringify(problems.take()));`;
  const r = nodeWith({ ...strictEnv(undefined), BUNDLE_LOCKFILE_FILE: 'package-lock.json' }, ['-e', script]);
  assert.deepEqual([r.stdout, r.stderr], ['[]\n', '']);
});

test('strict: Rollup\'s CommonJS build of a version bundle-lockfile cannot hook is a problem (its require() fails)', () => withConfig({ strict: true }, () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  problems.take();
  const file = J('/x/node_modules/rollup/dist/shared/rollup.js');
  rollupAdapter.onCjsLoad({ version: '2.40.0', rollupInternal() {} }, file, () => file); // no object hooks yet
  rollupAdapter.onCjsLoad({ version: '5.0.0', rollupInternalV2() {} }, file, () => file); // a future one without rollupInternal
  const one = J('/x/node_modules/rollup/dist/shared/node-entry.js'); // Rollup 1's (require('rollup'), its command line)
  rollupAdapter.onCjsLoad({ version: '1.32.1', rollup() {}, watch() {} }, one, () => one);
  rollupAdapter.onCjsLoad({ VERSION: '4.64.7', watch() {} }, one, () => one); // Rollup 4's file of that name: none of its builds
  const taken = problems.take();
  assert.equal(taken.length, 3);
  assert.match(taken[0], /rollup: .*rollup\.js \(Rollup 2\.40\.0\) is no Rollup bundle-lockfile can hook \(2\.78 or later, with rollupInternal\): its builds would write no lockfile/);
  assert.match(taken[1], /\(Rollup 5\.0\.0\) is no Rollup bundle-lockfile can hook/);
  assert.match(taken[2], /rollup: .*node-entry\.js \(Rollup 1\.32\.1\) is no Rollup bundle-lockfile can hook/);
}));

test('strict: Rollup\'s ES build of a version bundle-lockfile cannot hook (before 2.78) is a problem (its import fails); with BUNDLE_LOCKFILE_STRICT=0 it builds without the plugin', () => {
  // a fake rollup: as Rollup 2 before 2.78 it rejects a plugin's object hooks ({ order, handler }), which fails the build
  const at = (version) => project({
    'node_modules/rollup/package.json': { name: 'rollup', version, type: 'module', exports: { '.': './dist/es/rollup.js' } },
    'node_modules/rollup/dist/es/rollup.js': `const VERSION = ${JSON.stringify(version)};
      const old = /^2\\.([0-9]|[1-6][0-9]|7[0-7])\\./.test(VERSION);
      const names = (o) => [].concat(o.plugins || []).flat().map(p => {
        if (old && Object.values(p).some(v => v && typeof v === 'object' && typeof v.handler === 'function')) throw new Error('expected a function hook');
        return p.name;
      });
      const rollup = async (o) => names(o);
      const watch = (o) => [].concat(o).map(names);
      export { VERSION, rollup, watch };`,
    'package.json': { name: 'app', version: '1.0.0', type: 'module', dependencies: { rollup: version } },
    'build.mjs': `import { rollup, watch } from 'rollup';
      console.log(JSON.stringify([await rollup({ plugins: [{ name: 'x' }] }), watch({ plugins: [{ name: 'x' }] })]));`,
  });
  const run = (root, env) => spawnSync(process.execPath, ['--require', J(SRC, 'register.cjs'), J(root, 'build.mjs')], { cwd: root, env: { ...strictEnv(undefined), ...env }, encoding: 'utf8' });
  const old = at('2.77.3'), hookable = at('2.78.0');
  const msg = /rollup: file:\S*\/node_modules\/rollup\/dist\/es\/rollup\.js \(Rollup 2\.77\.3\) is no Rollup bundle-lockfile can hook \(2\.78 or later\): its builds would write no lockfile/;
  const modes = ['async'];
  if (typeof require('module').registerHooks === 'function') modes.push('sync');
  for (const mode of modes) {
    const strict = run(old, { BUNDLE_LOCKFILE_ESM_HOOKS: mode });
    assert.equal(strict.status, 1, `${mode}: ${strict.stderr}`);
    assert.match(strict.stderr, msg, mode);
    assert.doesNotMatch(strict.stderr, /expected a function hook/, mode);
    // BUNDLE_LOCKFILE_STRICT=0: said once, and the build goes on as without bundle-lockfile
    const off = run(old, { BUNDLE_LOCKFILE_ESM_HOOKS: mode, BUNDLE_LOCKFILE_STRICT: '0' });
    assert.equal(off.status, 0, `${mode}: ${off.stderr}`);
    assert.deepEqual(JSON.parse(off.stdout.trim().split('\n').pop()), [['x'], [['x']]], mode);
    assert.equal((off.stderr.match(new RegExp(`WARNING: ${msg.source}`, 'g')) || []).length, 1, `${mode}: ${off.stderr}`);
    // 2.78: the plugin
    const ok = run(hookable, { BUNDLE_LOCKFILE_ESM_HOOKS: mode });
    assert.equal(ok.status, 0, `${mode}: ${ok.stderr}`);
    assert.deepEqual(JSON.parse(ok.stdout.trim().split('\n').pop()), [['x', 'bundle-lockfile'], [['x', 'bundle-lockfile']]], mode);
  }
});

// strict: BUNDLE_LOCKFILE_STRICT unset (the default) - what would leave a lockfile missing or incomplete fails the build
// (core/problems.cjs). In this process config.strict is toggled with withConfig; child processes get the variable.

test('strict: BUNDLE_LOCKFILE_STRICT is on unless 0, false or off', () => {
  const read = (v) => nodeWith(strictEnv(v), ['-e', `console.log(require(${JSON.stringify(J(SRC, 'core/config.cjs'))}).strict)`]).stdout.trim();
  for (const v of [undefined, '', ' ', '1', 'true', 'on', 'yes']) assert.equal(read(v), 'true', JSON.stringify(v));
  for (const v of ['0', 'false', 'off', 'OFF', ' False ']) assert.equal(read(v), 'false', JSON.stringify(v));
});

test('strict: a problem is recorded for the build to fail; without strict mode it is a warning (once per key)', () => withConfig({ strict: false }, async () => {
  problems.take();
  const warned = warnings(() => {
    problems.problem('a', new Error('cause'));
    problems.problem('b', null, { once: 'k' });
    problems.problem('b', null, { once: 'k' });
  });
  assert.deepEqual(warned, ['a: Error: cause', 'b']);
  assert.equal(problems.pending(), false);
  assert.equal(problems.failIfAny(() => assert.fail('nothing to fail')), false);
  await withConfig({ strict: true }, () => {
    assert.deepEqual(warnings(() => { problems.problem('x', new Error('cause')); problems.problem('y', null, { once: 'k' }); problems.problem('y', null, { once: 'k' }); }), []);
    let failed = null;
    assert.equal(problems.failIfAny((e) => { failed = e; }), true);
    assert.equal(problems.isFailure(failed), true);
    assert.equal(problems.isFailure(new Error('x')), false);
    assert.deepEqual(failed.problems, ['x: cause', 'y', 'y']); // in strict mode every build with it fails
    assert.match(failed.message, /^bundle-lockfile: the lockfile would be missing or incomplete \(BUNDLE_LOCKFILE_STRICT=0 makes this a warning\):\n {2}x: cause\n {2}y\n {2}y$/);
    // no stack, only the first line and a newline: what the rollup command line strips off (else it prints the message twice)
    assert.equal(failed.stack, `Error: ${failed.message}\n`);
    assert.equal(problems.pending(), false); // taken: one build fails with them
  });
}));

test('strict: problems no build took make the process exit with 1 (also after process.exit(0)), and keep another exit code', () => {
  const P = JSON.stringify(J(SRC, 'core/problems.cjs'));
  const run = (tail) => nodeWith(strictEnv(undefined), ['-e', `require(${P}).problem('could not write x', new Error('EACCES')); ${tail}`]);
  for (const tail of ['', 'process.exit(0)', 'setTimeout(() => {}, 10)']) {
    const r = run(tail);
    assert.equal(r.status, 1, `${tail}: ${r.stderr}`);
    assert.match(r.stderr, /\[bundle-lockfile\] ERROR: could not write x: EACCES\n\[bundle-lockfile\] ERROR: the process fails because a lockfile would be missing or incomplete \(BUNDLE_LOCKFILE_STRICT=0 makes this a warning\)/);
  }
  assert.equal(run('process.exitCode = 3').status, 3);
  assert.equal(run(`require(${P}).take()`).status, 0); // a build took it (and failed with it)
  const off = nodeWith(strictEnv('0'), ['-e', `require(${P}).problem('could not write x')`]);
  assert.equal(off.status, 0);
  assert.match(off.stderr, /\[bundle-lockfile\] WARNING: could not write x/);
});

test('strict: a build fails with its own problems and those of no build, never with another build\'s', () => withConfig({ strict: true }, async () => {
  problems.take();
  const a = {}, b = {};
  const fails = (owner) => problems.within(owner, () => { let got = null; problems.failIfAny((err) => { got = err.problems; }); return got; });
  problems.within(a, () => problems.problem('a: one'));
  // also what a build's hook starts asynchronously
  await problems.within(a, () => new Promise(resolve => setImmediate(() => { problems.problem('a: later'); resolve(); })));
  problems.within(b, () => problems.problem('b: one'));
  problems.problem('none: one'); // outside any build (a module that could not be patched)
  assert.deepEqual(fails(b), ['b: one', 'none: one']);
  assert.deepEqual(fails(b), null);
  assert.deepEqual(fails(a), ['a: one', 'a: later']);
  // outside any build: all of them
  problems.within(a, () => problems.problem('a: two'));
  let all = null;
  problems.failIfAny((err) => { all = err.problems; });
  assert.deepEqual(all, ['a: two']);
  assert.equal(problems.pending(), false);
}));

test('strict: a module whose patching fails throws its own problems, not those a build recorded meanwhile', () => withConfig({ strict: true }, () => {
  problems.take();
  const { loading } = require('../../src/hooks.cjs');
  const b = {};
  problems.within(b, () => problems.problem('b: one'));
  assert.throws(() => loading(() => problems.problem('load: one')), (e) => problems.isFailure(e) && e.problems.join() === 'load: one');
  assert.equal(loading(() => 7), 7); // nothing recorded: what fn returns
  assert.deepEqual(problems.takeOwn(b), ['b: one']);
  assert.equal(problems.pending(), false);
}));

test('strict: nowhere to write (INLINE off, no export dir) and a lock that cannot be taken are problems of every build', () => withConfig({ strict: true }, async () => {
  problems.take();
  outputs.nowhere(); outputs.nowhere();
  assert.deepEqual(problems.take(), ['BUNDLE_LOCKFILE_INLINE is off and BUNDLE_LOCKFILE_EXPORT_DIR is not set: no lockfile is written',
    'BUNDLE_LOCKFILE_INLINE is off and BUNDLE_LOCKFILE_EXPORT_DIR is not set: no lockfile is written']);
  const { lock } = require('../../src/core/lock.cjs');
  const root = project({ 'dist/l.json.lock': 'held' });
  const release = await lock(J(root, 'dist/l.json'), { wait: 100 });
  release();
  const [p, ...rest] = problems.take();
  assert.deepEqual(rest, []);
  assert.match(p, /^could not lock .*l\.json - writing it without the lock \(it may miss the packages of another process writing it at the same time\)$/);
}));

test('strict: a bundled package that cannot be listed fails every build; one listed as the package around it is a warning', () => withConfig({ strict: true }, () => {
  problems.take();
  const root = project({
    'node_modules/noversion/package.json': { name: 'noversion' },
    'node_modules/container/package.json': { name: 'container', version: '1.0.0' },
    'node_modules/container/lib/node_modules/flat/i.js': '',
  });
  for (let i = 0; i < 2; i++) {
    const warned = warnings(() => packagesForFiles([J(root, 'node_modules/noversion/i.js'), J(root, 'node_modules/container/lib/node_modules/flat/i.js')]));
    if (i === 0) { assert.equal(warned.length, 1); assert.match(warned[0], /flat - its bundled files are listed as container@1\.0\.0/); }
    else assert.deepEqual(warned, []); // the container's: once per process
    const taken = problems.take();
    assert.equal(taken.length, 1, `build ${i + 1}`);
    assert.match(taken[0], /no package\.json with name and version in .*noversion - its bundled files are not listed/);
  }
}));

test('strict: a package root that is not on disk (a module the input file system made up) is a warning; one inside an unreadable archive fails', () => withConfig({ strict: true }, () => {
  problems.take();
  // webpack-virtual-modules: node_modules/virtual-pkg/index.js only in memory, node_modules/ on disk
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/f.zip': 'an archive fs reads as a file' });
  const virtual = J(root, 'node_modules/virtual-pkg/index.js');
  for (let i = 0; i < 2; i++) {
    const warned = warnings(() => assert.deepEqual(packagesForFiles([virtual]), []));
    if (i === 0) { assert.equal(warned.length, 1); assert.match(warned[0], /virtual-pkg is not on disk: its bundled files are generated in memory/); }
    else assert.deepEqual(warned, []); // once per process
    assert.deepEqual(problems.take(), [], `build ${i + 1}`);
  }
  // a Yarn PnP archive path that fs cannot read in this process: a real package whose files would be missing
  assert.deepEqual(packagesForFiles([J(root, 'node_modules/f.zip/node_modules/f/index.js')]), []);
  const [p, ...rest] = problems.take();
  assert.deepEqual(rest, []);
  assert.match(p, /no package\.json with name and version in \S*f\.zip\/node_modules\/f - its bundled files are not listed/);
  // a package root that is there but has no usable package.json still fails (the existing rule)
  fs.mkdirSync(J(root, 'node_modules/empty'));
  assert.deepEqual(packagesForFiles([J(root, 'node_modules/empty/i.js')]), []);
  assert.equal(problems.take().length, 1);
}));

test('strict: a bundled package whose package.json cannot be parsed fails every build (BUNDLE_LOCKFILE_STRICT=0: a warning)', async () => {
  const root = project({ 'node_modules/broken/package.json': '{"name": "broken", "version": "1.0.0",' });
  const file = J(root, 'node_modules/broken/i.js');
  await withConfig({ strict: true }, () => {
    problems.take();
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(packagesForFiles([file]), []);
      const taken = problems.take();
      assert.equal(taken.length, 1, `build ${i + 1}`);
      assert.match(taken[0], /no package\.json with name and version in \S*broken - its bundled files are not listed/);
    }
  });
  await withConfig({ strict: false }, () => {
    problems.take();
    const warned = warnings(() => assert.deepEqual(packagesForFiles([file]), []));
    assert.equal(problems.take().length, 0);
    assert.match(warned.join('\n'), /broken - its bundled files are not listed/);
  });
});

test('strict: the webpack plugin fails the compilation when collecting or writing fails', async () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const build = async ({ webpackError, blockWrite, throwCollect }) => {
    const outputPath = J(root, `out-${webpackError}-${!!blockWrite}-${!!throwCollect}`);
    fs.mkdirSync(outputPath, { recursive: true });
    if (blockWrite) fs.writeFileSync(J(outputPath, 'bundle-lockfile'), 'a file where the directory must be');
    const { compiler, taps } = fakeCompiler5({ outputPath });
    Object.assign(compiler.outputFileSystem, { stat: fs.stat, lstat: fs.lstat });
    compiler.outputFileSystem.gracefulify = () => {}; // the real disk
    if (webpackError) compiler.webpack.WebpackError = class WebpackError extends Error {};
    new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
    const comp = compilation({ context: root, outputPath, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }], assets: { 'main.js': {} } });
    comp.compiler = compiler;
    comp.errors = [];
    comp.hooks = { afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) } };
    const orig = packages.packagesOfFiles;
    if (throwCollect) packages.packagesOfFiles = () => { throw new Error('injected'); };
    try {
      taps.thisCompilation(comp);
      comp.stage();
      fs.writeFileSync(J(outputPath, 'main.js'), '');
      await new Promise(resolve => taps.afterEmit(comp, resolve));
    } finally { packages.packagesOfFiles = orig; }
    return comp.errors;
  };
  await withConfig({ strict: true }, async () => {
    problems.take();
    assert.deepEqual(await build({}), []);
    for (const webpackError of [false, true]) {
      const [e, ...rest] = await build({ webpackError, throwCollect: true });
      assert.deepEqual(rest, []);
      assert.equal(e.constructor.name, webpackError ? 'WebpackError' : 'Error');
      if (webpackError) assert.equal(e.hideStack, true);
      assert.match(e.stack, /^Error: bundle-lockfile: the lockfile would be missing or incomplete/);
      assert.match(e.message, /webpack: could not collect the packages of .*: injected/);
    }
    const [w] = await build({ blockWrite: true });
    assert.match(w.message, /webpack: could not write .*bundle-lockfile.package-lock\.json/);
    assert.equal(problems.pending(), false);
  });
  await withConfig({ strict: false }, async () => {
    let errors;
    const warned = warnings(() => { errors = build({ throwCollect: true }); });
    assert.deepEqual(await errors, []);
    assert.match(warned[0], /webpack: could not collect the packages of .*: Error: injected/);
  });
});

test('strict: a compiler the plugin cannot be applied to fails its compilations (or, if not even that, its compile())', async () => {
  for (const strict of [true, false]) {
    await withConfig({ strict }, () => {
      problems.take();
      const W = fakeCompiler();
      let compiled = 0;
      W.prototype.compile = function (cb) { compiled++; cb(null); };
      webpackAdapter.onCjsLoad(W, './Compiler', () => '/p/node_modules/webpack/lib/Compiler.js');
      // apply() throws at emit.tap; thisCompilation can be tapped: each compilation fails, watch mode keeps running
      const c = new W();
      c.outputPath = '/p/dist';
      const tapped = [];
      c.hooks = { thisCompilation: { tap: (n, fn) => tapped.push(fn) } };
      let got;
      warnings(() => c.compile((err) => { got = err; }));
      assert.equal(compiled, 1);
      assert.equal(got, null);
      const comp = { errors: [] };
      for (const fn of tapped) { try { fn(comp); } catch { /* the plugin's own taps on a fake compilation */ } }
      if (strict) assert.match(comp.errors.map(e => e.message).join(), /webpack: could not attach to the compiler of \/p\/dist/);
      else assert.deepEqual(comp.errors, []);
      // not even thisCompilation can be tapped: compile() calls back with the error instead of compiling
      const d = new W();
      d.outputPath = '/p/dist2';
      d.hooks = { thisCompilation: {} };
      got = undefined;
      warnings(() => d.compile((err) => { got = err; }));
      if (strict) { assert.equal(compiled, 1); assert.match(got.message, /webpack: could not attach to the compiler of \/p\/dist2/); }
      else { assert.equal(compiled, 2); assert.equal(got, null); }
      assert.equal(problems.pending(), false);
    });
  }
});

test('strict: the Rollup plugin fails the build when collecting or writing fails', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const cwd = process.cwd();
  process.chdir(root);
  const chunks = [{ fileName: 'main.js', code: 'main', modules: [J(root, 'node_modules/a/i.js')] }];
  const ctx = { error(e) { throw e; } };
  try {
    await withConfig({ strict: true }, async () => {
      problems.take();
      const orig = packages.packagesOfFiles;
      packages.packagesOfFiles = () => { throw new Error('injected'); };
      try {
        await assert.rejects(rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: J(root, 'dist-c'), chunks, ctx }),
          (e) => problems.isFailure(e) && /rollup: could not collect the bundled packages of .*dist-c: injected/.test(e.message));
      } finally { packages.packagesOfFiles = orig; }
      fs.mkdirSync(J(root, 'dist-w'));
      fs.writeFileSync(J(root, 'dist-w/bundle-lockfile'), 'a file where the directory must be');
      await assert.rejects(rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: J(root, 'dist-w'), chunks, ctx }),
        (e) => problems.isFailure(e) && /rollup: could not write .*dist-w.bundle-lockfile.package-lock\.json/.test(e.message));
      assert.equal(problems.pending(), false);
      // closeBundle: a problem there fails the build by a throw, except in watch mode, where a throw would crash
      // `vite build --watch`: printed then
      const rollupPlugin = rollupAdapter.bundleLockfile('rollup');
      problems.problem('late');
      await assert.rejects(rollupPlugin.closeBundle.handler.call({ meta: {} }), (e) => problems.isFailure(e) && /\n {2}late$/.test(e.message));
      problems.problem('late');
      const origError = config.error, printed = [];
      config.error = (...a) => printed.push(a.join(' '));
      try { await rollupPlugin.closeBundle.handler.call({ meta: { watchMode: true } }); } finally { config.error = origError; }
      assert.match(printed.join('\n'), /bundle-lockfile: the lockfile would be missing or incomplete[\s\S]*\n {2}late/);
      assert.equal(problems.pending(), false);
    });
    await withConfig({ strict: false }, async () => {
      fs.mkdirSync(J(root, 'dist-s'));
      fs.writeFileSync(J(root, 'dist-s/bundle-lockfile'), 'x');
      await rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: J(root, 'dist-s'), chunks, ctx }); // resolves, with a warning
    });
  } finally { process.chdir(cwd); }
});

test('strict: an adapter that throws while wrapping an ESM entry makes the entry fail to load, with the reason', () => {
  // (as the loader thread does: the bundler's import fails - also in a process or thread whose exit code nobody reads)
  const script = `const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
    process.env.BUNDLE_LOCKFILE_ESM_HOOKS = 'off';
    hooks.register({ name: 'boom', esmEntries: [{ id: 'x', suffixes: ['/x.js'], wrap: ['f'] }], esmWrap() { throw new Error('boom'); } });
    hooks.install();
    const f = () => 42;
    try { console.log(globalThis[Symbol.for('bundle-lockfile.esm')].wrap('x', 'f', f) === f); } catch (e) { console.log('failed:', e.message); }`;
  const r = nodeWith(strictEnv(undefined), ['-e', script]);
  assert.equal(r.status, 0, r.stderr); // (taken by the failed load)
  assert.match(r.stdout, /^failed: bundle-lockfile: the lockfile would be missing or incomplete .*\n {2}boom adapter failed to wrap x f: boom/);
});

test('strict: a bundler module an adapter cannot patch fails its require() with the reason (BUNDLE_LOCKFILE_STRICT=0: a warning)', () => {
  const root = project({ 'node_modules/webpack/lib/Compiler.js': 'module.exports = class Compiler { compile() {} };', // no run, watch, ...
    'node_modules/webpack/package.json': { name: 'webpack', version: '9.0.0' } });
  const script = `try { require(${JSON.stringify(J(root, 'node_modules/webpack/lib/Compiler.js'))}); console.log('loaded'); } catch (e) { console.log('failed:', e.message); }`;
  const run = (v) => nodeWith({ ...strictEnv(v), NODE_OPTIONS: '' }, ['--require', J(SRC, 'register.cjs'), '-e', script]);
  const strict = run(undefined);
  assert.equal(strict.status, 0, strict.stderr);
  assert.match(strict.stdout, /^failed: bundle-lockfile: the lockfile would be missing or incomplete .*\n {2}webpack: .*Compiler\.js has no Compiler bundle-lockfile knows \(compile, run, watch, newCompilation, isChild\): its builds would write no lockfile/);
  const off = run('0');
  assert.equal(off.stdout.trim(), 'loaded');
  assert.match(off.stderr, /WARNING: webpack: .*Compiler\.js has no Compiler bundle-lockfile knows/);
});

test('strict: ESM hooks that cannot be installed fail a bundler process, and only warn elsewhere', { skip: typeof require('module').registerHooks !== 'function' }, () => {
  const root = project({ 'package.json': { name: 'app', devDependencies: { vite: '8.0.0' } }, 'build.cjs': '', 'other/package.json': { name: 'other' }, 'other/x.cjs': '' });
  const script = (main) => `require('module').registerHooks = () => { throw new Error('no hooks'); };
    process.env.BUNDLE_LOCKFILE_ESM_HOOKS = 'sync'; process.argv[1] = ${JSON.stringify(main)};
    const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
    hooks.register({ name: 'v', esmEntries: [{ id: 'x', suffixes: ['/x.js'], wrap: ['f'] }], esmPackages: ['vite'] });
    hooks.install();`;
  const bundler = nodeWith(strictEnv(undefined), ['-e', script(J(root, 'build.cjs'))]);
  assert.equal(bundler.status, 1, bundler.stderr);
  assert.match(bundler.stderr, /\[bundle-lockfile\] ERROR: could not install the ESM hooks: no hooks/);
  const other = nodeWith(strictEnv(undefined), ['-e', script(J(root, 'other/x.cjs'))]);
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stderr, /\[bundle-lockfile\] WARNING: could not install the ESM hooks/);
  // module.register throws what broke Node's loader thread (another tool's loader or preload): the message says so
  const thread = (main) => `require('module').register = () => { throw new TypeError('this[#customizations].loadSync is not a function'); };
    process.env.BUNDLE_LOCKFILE_ESM_HOOKS = 'async'; process.argv[1] = ${JSON.stringify(main)};
    const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
    hooks.register({ name: 'v', esmEntries: [{ id: 'x', suffixes: ['/x.js'], wrap: ['f'] }], esmPackages: ['vite'] });
    hooks.install();`;
  const broken = nodeWith(strictEnv(undefined), ['-e', thread(J(root, 'build.cjs'))]);
  assert.equal(broken.status, 1, broken.stderr);
  assert.match(broken.stderr, /ERROR: could not install the ESM hooks: Node\.js's loader thread did not start \(a --loader or --import that fails there, or a --require preload that calls module\.registerHooks, breaks it\)[^\n]*\n?.*loadSync is not a function/s);
});

test('strict: the loader thread makes an entry it cannot wrap fail when it is imported', () => {
  // strict: what hooks.cjs passes (config.strict), not read again in the loader thread
  const loader = JSON.stringify(pathToFileURLHref(J(SRC, 'esm-loader.mjs')));
  const script = (data) => `const { initialize, load } = await import(${loader});
    initialize({ entries: [{ id: 'x', suffixes: null, wrap: ['f'] }]${data} }); // suffixes.some throws
    const r = await load('file:///p/x.js', {}, async () => ({ format: 'module', source: 'export const f = 1;' }));
    console.log(JSON.stringify(r));`;
  for (const data of ['', ', strict: true']) {
    const strict = JSON.parse(nodeWith(strictEnv('0'), ['--input-type=module', '-e', script(data)]).stdout);
    assert.equal(strict.format, 'module');
    assert.match(strict.source, /^throw new Error\("bundle-lockfile: could not wrap file:\/\/\/p\/x\.js: .* \(BUNDLE_LOCKFILE_STRICT=0 makes this a warning\)"\);/);
  }
  const off = JSON.parse(nodeWith(strictEnv(undefined), ['--input-type=module', '-e', script(', strict: false')]).stdout);
  assert.equal(off.source, 'export const f = 1;');
});

test('strict: problems fail the process also when a listener of the build\'s code calls process.exit() in its exit listener', () => {
  // (the build's listener is added before the first problem; bundle-lockfile's is there from the preload on)
  const script = `const problems = require(${JSON.stringify(J(SRC, 'core/problems.cjs'))});
    process.on('exit', () => process.exit(0));
    problems.problem('a lockfile would be missing');`;
  const r = nodeWith(strictEnv(undefined), ['-e', script]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /ERROR: a lockfile would be missing/);
});

test('strict: modules whose exports were inlined that cannot be looked for fail the build (a package would be missing)', () => withConfig({ strict: true }, () => {
  problems.take();
  const root = project({ 'node_modules/shipped/package.json': { name: 'shipped', version: '1.0.0' }, 'node_modules/consts/package.json': { name: 'consts', version: '1.0.0' } });
  const shipped = { resource: J(root, 'node_modules/shipped/i.js'), identifier: () => 'a' }, consts = { resource: J(root, 'node_modules/consts/i.js'), identifier: () => 'b' };
  const c = rspackCompilation(root, { chunks: [{ files: ['main.js'], modules: [shipped] }], modules: [consts], optimization: { inlineExports: true, usedExports: true },
    exportsUsed: () => { throw new Error('module graph gone'); } });
  assert.deepEqual(lockedNames(plugin().lockfile(c)), ['shipped']); // the chunks' packages are still collected
  const taken = problems.take();
  assert.equal(taken.length, 1);
  assert.match(taken[0], /^rspack: could not collect the modules whose exports were inlined into .*: module graph gone$/);
}));

test('strict: the output of a write: false build that its caller writes, in no lockfile, fails the process when it ends', () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const script = (write) => `const a = require(${JSON.stringify(J(SRC, 'adapters/esbuild.cjs'))}); const fs = require('fs');
    const options = { entryPoints: ['src/main.js'], outdir: 'dist', write: false, absWorkingDir: ${JSON.stringify(root)} };
    const plugin = a.attach(options, ${JSON.stringify(ESBUILD_MAIN)}).plugins.at(-1);
    let end; plugin.setup({ initialOptions: options, onStart() {}, onEnd: (fn) => { end = fn; } });
    const out = { path: ${JSON.stringify(J(root, 'dist/main.js'))}, contents: Buffer.from('bundled a') };
    end({ errors: [], metafile: { outputs: { 'dist/main.js': { inputs: { 'node_modules/a/i.js': { bytesInOutput: 9 } } } } }, outputFiles: [out] }).then(() => {
      ${write ? "fs.mkdirSync(require('path').dirname(out.path), { recursive: true }); fs.writeFileSync(out.path, out.contents);" : ''} console.log('done');
    });`;
  const written = nodeWith(strictEnv(undefined), ['-e', script(true)]);
  assert.equal(written.status, 1, written.stderr);
  assert.match(written.stderr, /\S*dist\/main\.js, output of a build with write: false, was written by its caller or a plugin: no lockfile lists its packages/);
  fs.rmSync(J(root, 'dist'), { recursive: true });
  const kept = nodeWith(strictEnv(undefined), ['-e', script(false)]); // only looked at: nothing ships
  assert.deepEqual([kept.status, kept.stdout.trim()], [0, 'done'], kept.stderr);
  // said once, also after a write: false build whose output has no path (<stdout>: no outdir, nothing to look at)
  const first = `const o0 = { entryPoints: ['src/w.js'], write: false, absWorkingDir: ${JSON.stringify(root)} };
    const p0 = a.attach(o0, ${JSON.stringify(ESBUILD_MAIN)}).plugins.at(-1);
    let end0; p0.setup({ initialOptions: o0, onStart() {}, onEnd: (fn) => { end0 = fn; } });
    end0({ errors: [], metafile: { outputs: { 'w.js': { inputs: { 'node_modules/a/i.js': { bytesInOutput: 9 } } } } }, outputFiles: [{ path: '<stdout>', contents: Buffer.from('w') }] }).then(() => {`;
  const twice = nodeWith(strictEnv(undefined), ['-e', script(true).replace("const options =", `${first} const options =`) + '});']);
  assert.equal(twice.status, 1, twice.stderr);
  assert.equal(twice.stderr.match(/was written by its caller or a plugin/g).length, 1, twice.stderr);
});

test('strict: the output of a generate() whose caller writes it where the build said, in no lockfile, fails the process when it ends (Rollup, Vite, tsup\'s treeshake)', () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'src/main.js': '' });
  const call = JSON.stringify(J(BUNDLERS.root, 'node_modules/rollup/dist/shared/rollup.js'));
  // a Rollup build with the plugin (as rollupBuild runs it) that only generates, with `out` as its output options; then
  // `after` (the caller)
  const script = (out, after, kind = 'rollup') => `const a = require(${JSON.stringify(J(SRC, 'adapters/rollup.cjs'))}); const call = require(${call});
    const fs = require('fs'), path = require('path');
    const plugin = a.bundleLockfile(${JSON.stringify(kind)}, { input: 'src/main.js' });
    const out = ${JSON.stringify({ format: 'es', ...out })};
    const chunk = { type: 'chunk', fileName: 'main.js', code: 'bundled a', moduleIds: [${JSON.stringify(J(root, 'node_modules/a/i.js'))}], isEntry: true, facadeModuleId: ${JSON.stringify(J(root, 'src/main.js'))} };
    const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
    (async () => {
      call(plugin.buildStart, {}, [{ input: 'src/main.js' }]);
      plugin.renderStart.call({}, out);
      await call(plugin.generateBundle.handler, {}, [out, { 'main.js': chunk }, false]);
      await plugin.closeBundle.handler.call({});
      ${after}
      console.log('done');
    })();`;
  const run = (env, ...args) => spawnSync(process.execPath, ['-e', script(...args)], { cwd: root, encoding: 'utf8', env });
  const gen = J(root, 'gen/main.js');
  const rollupMsg = /rollup: \S*gen\/main\.js, output of Rollup's generate\(\), was written by its caller or a plugin: no lockfile lists its packages \(write it with bundle\.write\(\)\)/;
  // written as generated, or changed (minified, post-processed) after the build
  for (const [out, text] of [[{ dir: 'gen' }, 'bundled a'], [{ file: 'gen/main.js' }, 'bundled a'], [{ dir: J(root, 'gen') }, 'bundled a, minified']]) {
    const r = run(strictEnv(undefined), out, `write(${JSON.stringify(gen)}, ${JSON.stringify(text)});`);
    assert.equal(r.status, 1, `${JSON.stringify(out)}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`ERROR: ${rollupMsg.source}`));
    fs.rmSync(J(root, 'gen'), { recursive: true });
  }
  // BUNDLE_LOCKFILE_STRICT=0: a warning
  let r = run(strictEnv('0'), { dir: 'gen' }, `write(${JSON.stringify(gen)}, 'bundled a');`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`WARNING: ${rollupMsg.source}`));
  assert.equal((r.stderr.match(/WARNING/g) || []).length, 1, r.stderr); // (not again as output that reached no output)
  // a Vite build with build.write: false
  r = run(strictEnv(undefined), { dir: 'gen' }, `write(${JSON.stringify(gen)}, 'bundled a');`, 'vite');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /ERROR: vite: \S*gen\/main\.js, output of a Vite build with build\.write: false, was written by its caller or a plugin: no lockfile lists its packages \(let Vite write it\)/);
  // only looked at (nothing written there), a file there from before the build, or one a build of the process writes
  // and lists: nothing ships without a lockfile
  fs.rmSync(J(root, 'gen'), { recursive: true });
  r = run(strictEnv(undefined), { dir: 'gen' }, '');
  assert.deepEqual([r.status, r.stdout.trim()], [0, 'done'], r.stderr);
  fs.mkdirSync(J(root, 'gen'));
  const old = new Date(Date.now() - 60000);
  for (const text of ['an older build', 'bundled a']) { // (the same bytes: written by an earlier process, with its lockfile)
    fs.writeFileSync(gen, text);
    fs.utimesSync(gen, old, old);
    r = run(strictEnv(undefined), { dir: 'gen' }, '');
    assert.deepEqual([r.status, r.stdout.trim()], [0, 'done'], `${text}: ${r.stderr}`);
  }
  r = run(strictEnv(undefined), { dir: 'gen' }, `write(${JSON.stringify(gen)}, 'bundled a'); require(${JSON.stringify(J(SRC, 'core/outputs.cjs'))}).record(${JSON.stringify(J(root, 'gen', LOCK))}, 'w', [], ${JSON.stringify(root)}, [${JSON.stringify(gen)}]);`);
  assert.deepEqual([r.status, r.stdout.trim()], [0, 'done'], r.stderr);
  fs.rmSync(J(root, 'gen'), { recursive: true });
  // tsup's treeshake option: esbuild (write: false) builds dist/main.js, Rollup's generate() with file: dist/main.js
  // tree-shakes it, tsup writes Rollup's output there - other bytes than esbuild's
  const dist = J(root, 'dist/main.js');
  const tsup = `const e = require(${JSON.stringify(J(SRC, 'adapters/esbuild.cjs'))});
    const options = { entryPoints: ['src/main.js'], outdir: 'dist', write: false, absWorkingDir: ${JSON.stringify(root)} };
    const p = e.attach(options, ${JSON.stringify(ESBUILD_MAIN)}).plugins.at(-1);
    let end; p.setup({ initialOptions: options, onStart() {}, onEnd: (fn) => { end = fn; } });
    await end({ errors: [], metafile: { outputs: { 'dist/main.js': { inputs: { 'node_modules/a/i.js': { bytesInOutput: 9 } } } } }, outputFiles: [{ path: ${JSON.stringify(dist)}, contents: Buffer.from('bundled a, by esbuild') }] });`;
  r = spawnSync(process.execPath, ['-e', script({ file: dist }, `write(${JSON.stringify(dist)}, 'bundled a');`).replace('(async () => {', `(async () => { ${tsup}`)], { cwd: root, encoding: 'utf8', env: strictEnv(undefined) });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /ERROR: esbuild: \S*dist\/main\.js, output of a build with write: false, was written by its caller or a plugin: no lockfile lists its packages/);
});

test('strict: a rebuild with a problem fails (an onEnd error); the next one without it writes the lockfile again', () => withConfig({ strict: true }, async () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/nopj/i.js': '', 'dist/main.js': 'x' });
  problems.take();
  const call = esbuildCall({ entryPoints: ['src/main.js'], outdir: 'dist', absWorkingDir: root });
  const result = (name) => ({ errors: [], metafile: { outputs: { 'dist/main.js': { inputs: { [`node_modules/${name}/i.js`]: { bytesInOutput: 1 } } } } } });
  assert.equal(await call.build(result('a')), undefined);
  const bad = await call.build(result('nopj'));
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0].text, /no package\.json with name and version in \S*nopj/);
  assert.equal(await call.build(result('a')), undefined);
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['a']);
  assert.equal(problems.count(), 0);
}));

test('strict: Parcel before 2.13 only prints a reporter\'s error - the process fails at its exit; from 2.13 on Parcel fails the build', () => {
  for (const [version, status] of [['2.8.3', 1], ['2.12.0', 1], ['2.13.0', 0], ['2.16.4', 0]]) {
    const root = project({ 'node_modules/@parcel/core/package.json': { name: '@parcel/core', version }, 'node_modules/@parcel/core/lib/Parcel.js': '' });
    const where = J(root, 'node_modules/@parcel/core/lib/Parcel.js');
    // Parcel's reporter runner: the reporter's error caught (and printed), the build goes on, the CLI exits with 0.
    // Parcel's command line sends console's output to its logger (patchConsole), which prints nothing at the exit:
    // bundle-lockfile's messages are printed all the same
    const script = `const parcel = require(${JSON.stringify(J(SRC, 'adapters/parcel.cjs'))});
      class Parcel { run() {} watch() {} }
      parcel.onCjsLoad({ default: Parcel }, ${JSON.stringify(where)}, () => ${JSON.stringify(where)});
      const log = console.log;
      console.log = console.warn = console.error = () => {};
      parcel.report({ event: { type: 'buildSuccess', bundleGraph: null }, options: { projectRoot: ${JSON.stringify(root)} } })
        .then(() => log('no error'), (e) => { log('reporter error:', e.message.split('\\n')[0]); process.exit(0); });`;
    const r = nodeWith(strictEnv(undefined), ['-e', script]);
    assert.match(r.stdout, /reporter error: bundle-lockfile: the lockfile would be missing or incomplete/, version);
    assert.equal(r.status, status, `${version}: ${r.stderr}`);
    if (status) assert.match(r.stderr, /\[bundle-lockfile\] ERROR: parcel: could not collect the bundled packages of the build/, version);
    // BUNDLE_LOCKFILE_STRICT=0: a warning, no failure
    const lax = nodeWith(strictEnv('0'), ['-e', script]);
    assert.equal(lax.stdout.trim(), 'no error', version);
    assert.equal(lax.status, 0, `${version}: ${lax.stderr}`);
    assert.match(lax.stderr, /\[bundle-lockfile\] WARNING: parcel: could not collect the bundled packages of the build/, version);
  }
});

test('strict: a Node.js without ESM hooks (20.0 - 20.5) fails a bundler process: its ES-module bundlers would not be hooked', () => {
  const root = project({ 'package.json': { name: 'app', devDependencies: { vite: '8.0.0' } }, 'build.cjs': '' });
  const script = (main) => `const M = require('module'); M.registerHooks = undefined; M.register = undefined;
    process.argv[1] = ${JSON.stringify(main)};
    const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
    hooks.register({ name: 'v', esmEntries: [{ id: 'x', suffixes: ['/x.js'], wrap: ['f'] }], esmPackages: ['vite'] });
    hooks.install();`;
  const r = spawnSync(process.execPath, ['-e', script(J(root, 'build.cjs'))], { encoding: 'utf8', env: { ...strictEnv(undefined), BUNDLE_LOCKFILE_ESM_HOOKS: '' }, cwd: root });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /ERROR: Node\.js \S+ has no ESM hooks \(module\.register: 20\.6 and later\): ES-module bundlers are not hooked/);
  const elsewhere = project({ 'x.cjs': '' });
  const e = spawnSync(process.execPath, ['-e', script(J(elsewhere, 'x.cjs'))], { encoding: 'utf8', env: { ...strictEnv(undefined), BUNDLE_LOCKFILE_ESM_HOOKS: '' }, cwd: elsewhere });
  assert.deepEqual([e.status, e.stderr], [0, '']);
});

test('strict: an ES-module bundler in a thread without ESM hooks fails when it loads its CommonJS companion; its CommonJS build does not', () => {
  // a process that bundlerProcess does not take for one (its project has no bundler installed where it looks, and its
  // main script names none): older Node.js (before 22.22.3 / 24.11.1) installs no ESM hooks there. Simulated on every version by taking
  // module.register / registerHooks away before the hooks install.
  const tools = {
    // Rollup: the ES build loads dist/native.js with no CommonJS module of Rollup's before it, the CommonJS one from
    // dist/shared/parseAst.js
    'node_modules/rollup/package.json': { name: 'rollup', version: '4.64.6' },
    'node_modules/rollup/dist/es/package.json': { type: 'module' },
    'node_modules/rollup/dist/es/rollup.js': "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('../native.js');\nexport const rollup = async () => {};\n",
    'node_modules/rollup/dist/native.js': 'module.exports = { parse() {} };\n',
    'node_modules/rollup/dist/shared/parseAst.js': "module.exports = require('../native.js');\n",
    'node_modules/rollup/dist/rollup.js': "require('./shared/parseAst.js');\nexports.rollup = async () => {};\n",
    // Rolldown: its ES build loads its binding's package.json from dist/shared/*.mjs
    'node_modules/rolldown/package.json': { name: 'rolldown', version: '1.2.13', type: 'module' },
    'node_modules/rolldown/dist/shared/binding-x.mjs': "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('@rolldown/binding-linux-x64-gnu/package.json');\nexport const rolldown = async () => {};\n",
    'node_modules/@rolldown/binding-linux-x64-gnu/package.json': { name: '@rolldown/binding-linux-x64-gnu', version: '1.2.13' },
    // rspack 2: its ES module loads @rspack/binding/binding.js
    'node_modules/@rspack/core/package.json': { name: '@rspack/core', version: '2.2.9', type: 'module' },
    'node_modules/@rspack/core/dist/index.js': "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('@rspack/binding/binding.js');\nexport const rspack = () => {};\n",
    'node_modules/@rspack/binding/package.json': { name: '@rspack/binding', version: '2.2.9' },
    'node_modules/@rspack/binding/binding.js': 'module.exports = {};\n',
  };
  const root = project({ ...Object.fromEntries(Object.entries(tools).map(([k, v]) => [`tools/${k}`, v])), 'app/package.json': { name: 'app', version: '1.0.0' } });
  // rspack 1: a CommonJS dist/index.js loads the same binding (and exports rspack() as rspack 1 does: one of another shape
  // is a problem of its own)
  const cjs = project({
    'node_modules/@rspack/core/package.json': { name: '@rspack/core', version: '1.7.12' },
    'node_modules/@rspack/core/dist/index.js': "require('@rspack/binding/binding.js');\nmodule.exports = Object.assign(function rspack() {}, { rspackVersion: '1.7.12',\n  Compiler: class Compiler { compile() {} run() {} watch() {} isChild() {} runAsChild() {} createChildCompiler() {} } });\n",
    'node_modules/@rspack/binding/package.json': { name: '@rspack/binding', version: '1.7.12' },
    'node_modules/@rspack/binding/binding.js': 'module.exports = {};\n',
  });
  const T = (f) => J(root, 'tools/node_modules', f);
  const run = (env, file, how = 'import') => spawnSync(process.execPath, ['-e', `const M = require('module'); M.registerHooks = undefined; M.register = undefined;
    require(${JSON.stringify(J(SRC, 'register.cjs'))});
    (${how === 'import' ? `import(${JSON.stringify(pathToFileURLHref(file))})` : `Promise.resolve().then(() => require(${JSON.stringify(file)}))`})
      .then(() => console.log('loaded'), (e) => { console.log('failed:', e.message); process.exitCode = 3; });`],
  { encoding: 'utf8', cwd: J(root, 'app'), env: { ...strictEnv(env), BUNDLE_LOCKFILE_ESM_HOOKS: '' } });
  for (const [id, file] of [['rollup', T('rollup/dist/es/rollup.js')], ['rolldown', T('rolldown/dist/shared/binding-x.mjs')], ['rspack', T('@rspack/core/dist/index.js')]]) {
    const strict = run(undefined, file);
    assert.match(strict.stdout, new RegExp(`^failed: bundle-lockfile: the lockfile would be missing or incomplete[\\s\\S]*${id} is loaded as an ES module in a process without bundle-lockfile's ESM hooks .*set BUNDLE_LOCKFILE_ESM_HOOKS=async`), `${id}: ${strict.stdout}${strict.stderr}`);
    const lax = run('0', file);
    assert.equal(lax.stdout.trim(), 'loaded', `${id}: ${lax.stderr}`);
    assert.match(lax.stderr, new RegExp(`WARNING: ${id} is loaded as an ES module`), id);
    // turned off: nothing to check; the bundler disabled: nothing either
    const off = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(J(SRC, 'register.cjs'))}); import(${JSON.stringify(pathToFileURLHref(file))}).then(() => console.log('loaded'));`],
      { encoding: 'utf8', cwd: J(root, 'app'), env: { ...strictEnv(undefined), BUNDLE_LOCKFILE_ESM_HOOKS: 'off' } });
    assert.deepEqual([off.stdout.trim(), off.stderr], ['loaded', ''], id);
  }
  const dis = spawnSync(process.execPath, ['-e', `const M = require('module'); M.registerHooks = undefined; M.register = undefined;
    require(${JSON.stringify(J(SRC, 'register.cjs'))}); import(${JSON.stringify(pathToFileURLHref(T('rollup/dist/es/rollup.js')))}).then(() => console.log('loaded'));`],
  { encoding: 'utf8', cwd: J(root, 'app'), env: { ...strictEnv(undefined), BUNDLE_LOCKFILE_ESM_HOOKS: '', BUNDLE_LOCKFILE_DISABLE: 'rollup,vite' } });
  assert.deepEqual([dis.stdout.trim(), dis.stderr], ['loaded', '']);
  // the CommonJS builds load the same files from a module that came through the CommonJS hook: no problem
  for (const file of [T('rollup/dist/rollup.js'), J(cjs, 'node_modules/@rspack/core/dist/index.js')]) {
    const r = run(undefined, file, 'require');
    assert.deepEqual([r.stdout.trim(), r.stderr, r.status], ['loaded', '', 0], file);
  }
  // Yarn's pnpm linker: Rollup in its store (node_modules/.store/<slug>/package) is recognized as node_modules/rollup
  const store = project({ ...Object.fromEntries(Object.entries(tools).filter(([k]) => k.startsWith('node_modules/rollup/'))
    .map(([k, v]) => [k.replace('node_modules/rollup/', 'node_modules/.store/rollup-npm-4.64.6-0123456789/package/'), v])), 'app/package.json': { name: 'app', version: '1.0.0' } });
  const yarn = run(undefined, J(store, 'node_modules/.store/rollup-npm-4.64.6-0123456789/package/dist/es/rollup.js'));
  assert.match(yarn.stdout, /^failed: [\s\S]*rollup is loaded as an ES module in a process without bundle-lockfile's ESM hooks/, yarn.stdout + yarn.stderr);
  // the ESM hooks could not be installed (in a process not taken for a bundler's: a warning): the check is on, too
  const broken = spawnSync(process.execPath, ['-e', `const M = require('module'); M.register = () => { throw new Error('no loader thread'); };
    require(${JSON.stringify(J(SRC, 'register.cjs'))});
    import(${JSON.stringify(pathToFileURLHref(T('rollup/dist/es/rollup.js')))}).then(() => console.log('loaded'), (e) => { console.log('failed:', e.message); process.exitCode = 3; });`],
  { encoding: 'utf8', cwd: J(root, 'app'), env: { ...strictEnv(undefined), BUNDLE_LOCKFILE_ESM_HOOKS: 'async' } });
  assert.match(broken.stderr, /WARNING: could not install the ESM hooks: .*no loader thread/, broken.stderr);
  assert.match(broken.stdout, /^failed: [\s\S]*rollup is loaded as an ES module in a process without bundle-lockfile's ESM hooks/, broken.stdout + broken.stderr);
});

test('strict: a bundler an adapter fails to patch is a problem (webpack, rspack, Rollup)', () => withConfig({ strict: true }, () => {
  problems.take();
  const W = fakeCompiler();
  Object.freeze(W.prototype); // patching throws
  webpackAdapter.onCjsLoad(W, '/p/node_modules/webpack/lib/Compiler.js', () => '/p/node_modules/webpack/lib/Compiler.js');
  const R = fakeRspack('2.2.8');
  Object.freeze(R.Compiler.prototype);
  rspackAdapter.onCjsLoad(R, '/p/node_modules/@rspack/core/dist/index.js', () => '/p/node_modules/@rspack/core/dist/index.js');
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const file = '/p/node_modules/rollup/dist/shared/rollup.js';
  rollupAdapter.onCjsLoad(Object.freeze({ version: '4.64.2', rollup() {}, rollupInternal() {} }), file, () => file);
  const taken = problems.take();
  assert.equal(taken.length, 3, JSON.stringify(taken));
  assert.match(taken[0], /^webpack: could not patch .*Compiler\.js: /);
  assert.match(taken[1], /^rspack: could not patch .*index\.js: /);
  assert.match(taken[2], /^rollup: could not patch .*rollup\.js: /);
}));

test('strict: rspack whose Compiler is of an unknown shape is a problem when it loads - from 1.0 on, and 0.x (which is never patched, so it would not fail when it compiles: above)', () => withConfig({ strict: true }, () => {
  problems.take();
  const odd = Object.assign(function rspack() {}, { Compiler: class Compiler { compile() {} }, Compilation: class {}, rspackVersion: '3.0.0' });
  rspackAdapter.onCjsLoad(odd, '/p/x.js', () => '/p/x.js');
  rspackAdapter.onCjsLoad(Object.assign(function rspack() {}, { Compiler: class Compiler {}, rspackVersion: '0.7.5' }), '/p/y.js', () => '/p/y.js');
  const taken = problems.take();
  assert.equal(taken.length, 2, JSON.stringify(taken));
  assert.match(taken[0], /^rspack: the Compiler of rspack 3\.0\.0 \(\/p\/x\.js\) is not one bundle-lockfile knows/);
  assert.match(taken[1], /^rspack 0\.7\.5 \(\/p\/y\.js\) is not supported \(it needs 1\.1 or later\): its builds write no lockfile/);
}));

test('strict: the files copied into the output that cannot be checked fail the compilation', () => withConfig({ strict: true }, () => {
  problems.take();
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const { compiler, taps } = fakeCompiler5({ outputPath: J(root, 'out-copies') });
  compiler.webpack.Compilation = { PROCESS_ASSETS_STAGE_OPTIMIZE: 100 };
  new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
  const comp = compilation({ context: root, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }] });
  Object.assign(comp, { compiler, errors: [], emitAsset: () => {}, hooks: { processAssets: { tap: (o, fn) => (comp.copies = fn) }, afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) } } });
  taps.thisCompilation(comp);
  comp.getAssets = () => { throw new Error('assets gone'); };
  comp.copies();
  delete comp.getAssets;
  comp.getAssets = () => [];
  comp.stage();
  assert.match(comp.errors.map(e => e.message).join(), /webpack: could not check the files copied into .*out-copies: assets gone/);
}));

test('strict: a build that cannot even be failed (its compilation gone) still lets webpack go on: afterEmit calls back, the process fails', () => withConfig({ strict: true }, async () => {
  problems.take();
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const { compiler, taps } = fakeCompiler5({ outputPath: J(root, 'out-gone') });
  new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
  const comp = compilation({ context: root, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }] });
  Object.assign(comp, { compiler, errors: [], emitAsset: () => {}, hooks: { afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) } } });
  taps.thisCompilation(comp);
  comp.stage();
  problems.problem('a problem when the build ends');
  comp.errors = Object.freeze([]); // (pushing an error throws)
  const saved = process.exitCode;
  const errors = [], error = config.error;
  config.error = (...a) => errors.push(a.join(' '));
  try {
    const called = await Promise.race([new Promise(resolve => taps.afterEmit(comp, () => resolve(true))), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
    assert.equal(called, true);
    assert.equal(process.exitCode, 1);
    assert.match(errors.join('\n'), /could not fail the build of \S*out-gone/);
  } finally { config.error = error; process.exitCode = saved; }
}));

test('strict: a generate-only build fails with its own problems (a package without a package.json in a worker)', () => withConfig({ strict: true }, async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  problems.take();
  const root = project({ 'node_modules/noversion/package.json': { name: 'noversion' } });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    // in its generateBundle, as for a build that writes (not left for another build, or the process's exit)
    const rollupPlugin = rollupAdapter.bundleLockfile('vite'), ctx = { error(e) { throw e; } }, out = { format: 'es' };
    const modules = [J(root, 'node_modules/noversion/i.js')];
    rollupPlugin.buildStart.call(ctx, {});
    rollupPlugin.renderStart.call(ctx, out);
    await assert.rejects(rollupPlugin.generateBundle.handler.call(ctx, out, { 'w.js': { type: 'chunk', fileName: 'w.js', code: 'worker', moduleIds: modules } }, false),
      (e) => problems.isFailure(e) && /no package\.json with name and version in .*noversion/.test(e.message));
    assert.equal(problems.pending(), false);
  } finally { process.chdir(cwd); }
}));

test('strict: files written after the build that cannot be checked fail the Rollup build', () => withConfig({ strict: true }, async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  problems.take();
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const cwd = process.cwd();
  process.chdir(root);
  const filesOf = outputs.filesOf;
  try {
    const late = () => { outputs.filesOf = () => { throw new Error('injected'); }; };
    await assert.rejects(rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: J(root, 'dist'), late, ctx: { meta: {} },
      chunks: [{ fileName: 'main.js', code: 'main', modules: [J(root, 'node_modules/a/i.js')] }] }),
    (e) => problems.isFailure(e) && /rollup: could not add the files written into .*dist after the build: injected/.test(e.message));
  } finally { outputs.filesOf = filesOf; process.chdir(cwd); }
}));

test('strict: an entry wrapper evaluated where bundle-lockfile is not loaded fails its import (BUNDLE_LOCKFILE_STRICT=0: a warning)', () => {
  const esmWrap = require('../../src/esm-wrap.cjs');
  const root = project({ 'rollup.mjs': 'export function rollup() { return 1; }' });
  const url = pathToFileURLHref(J(root, 'rollup.mjs'));
  const entry = { id: 'rollup', suffixes: ['/rollup.mjs'], wrap: ['rollup'] };
  fs.writeFileSync(J(root, 'strict.mjs'), esmWrap.source(url, 'export function rollup() {}', entry, true));
  fs.writeFileSync(J(root, 'warn.mjs'), esmWrap.source(url, 'export function rollup() {}', entry, false));
  const load = (f) => nodeWith(strictEnv('0'), ['--input-type=module', '-e',
    `try { const m = await import(${JSON.stringify(pathToFileURLHref(J(root, f)))}); console.log('loaded', m.rollup()); } catch (e) { console.log('failed:', e.message); }`]);
  const msg = `${url} is wrapped, but bundle-lockfile is not loaded in this thread: its builds would write no lockfile`;
  const strict = load('strict.mjs');
  assert.equal(strict.stdout, `failed: bundle-lockfile: ${msg} (BUNDLE_LOCKFILE_STRICT=0 makes this a warning)\n`, strict.stderr);
  const warn = load('warn.mjs');
  assert.equal(warn.stdout, 'loaded 1\n', warn.stderr);
  assert.equal(warn.stderr, `[bundle-lockfile] WARNING: ${msg}\n`);
  // with the API (the hooks installed in the thread): no message
  const hooked = nodeWith(strictEnv(undefined), ['--input-type=module', '-e',
    `globalThis[Symbol.for('bundle-lockfile.esm')] = { wrap: (id, n, fn) => () => 2, found() {} };
     const m = await import(${JSON.stringify(pathToFileURLHref(J(root, 'strict.mjs')))}); console.log('loaded', m.rollup());`]);
  assert.deepEqual([hooked.stdout, hooked.stderr], ['loaded 2\n', '']);
});

test('strict: builds bundle-lockfile recognizes but does not hook fail (the rolldown command line, Next.js with Turbopack, ncc, Parcel); STRICT=0: a warning', () => {
  const root = project({
    'node_modules/rolldown/package.json': { name: 'rolldown', version: '1.2.13', type: 'module' },
    'node_modules/rolldown/bin/cli.mjs': "console.log('built');\n",
    // next build: Next sets TURBOPACK when it builds with Turbopack (auto: by default), NEXT_RSPACK with next-rspack;
    // next build ends with process.exit()
    'node_modules/next/package.json': { name: 'next', version: '16.4.0' },
    'node_modules/next/dist/bin/next': "if (process.env.FAKE_BUNDLER) process.env[process.env.FAKE_BUNDLER] = 'auto';\nconsole.log('built');\nprocess.exit(0);\n",
    'node_modules/@vercel/ncc/package.json': { name: '@vercel/ncc', version: '0.38.4' },
    'node_modules/@vercel/ncc/dist/ncc/index.js': 'module.exports = () => {};\n',
    'ncc.cjs': "try { require('@vercel/ncc/dist/ncc/index.js'); console.log('loaded'); } catch (e) { console.log('failed:', e.message); process.exitCode = 3; }\n",
  });
  const spawnNode = (env, args) => spawnSync(process.execPath, ['--require', J(SRC, 'register.cjs'), ...args], { cwd: root, encoding: 'utf8', env: { ...strictEnv(env.STRICT), ...env } });
  const ROLLDOWN = /the rolldown command line is not hooked: its builds write no lockfile/;
  const TURBO = /Next\.js built with Turbopack, which bundle-lockfile does not hook: no lockfile \(build with next build --webpack, or with next-rspack\)/;
  // strict: the process fails (at exit: there is no build to fail), or the module's require()
  let r = spawnNode({}, [J(root, 'node_modules/rolldown/bin/cli.mjs')]);
  assert.deepEqual([r.status, r.stdout.trim()], [1, 'built']);
  assert.match(r.stderr, ROLLDOWN);
  r = spawnNode({ FAKE_BUNDLER: 'TURBOPACK' }, [J(root, 'node_modules/next/dist/bin/next'), 'build']);
  assert.deepEqual([r.status, r.stdout.trim()], [1, 'built'], r.stderr);
  assert.match(r.stderr, TURBO);
  r = spawnNode({}, [J(root, 'ncc.cjs')]);
  assert.match(r.stdout, /^failed: bundle-lockfile: the lockfile would be missing or incomplete[\s\S]*@vercel\/ncc builds with a webpack of its own/);
  // STRICT=0: warnings, and the builds go on
  r = spawnNode({ STRICT: '0' }, [J(root, 'node_modules/rolldown/bin/cli.mjs')]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /WARNING: the rolldown command line is not hooked/);
  r = spawnNode({ STRICT: '0', FAKE_BUNDLER: 'TURBOPACK' }, [J(root, 'node_modules/next/dist/bin/next'), 'build']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /WARNING: Next\.js built with Turbopack/);
  r = spawnNode({ STRICT: '0' }, [J(root, 'ncc.cjs')]);
  assert.equal(r.stdout.trim(), 'loaded');
  assert.match(r.stderr, /WARNING: @vercel\/ncc builds with a webpack of its own/);
  // not these: next build with webpack (no TURBOPACK) or next-rspack, next dev, rolldown disabled
  for (const [env, args] of [[{}, ['build']], [{ FAKE_BUNDLER: 'NEXT_RSPACK' }, ['build']], [{ FAKE_BUNDLER: 'TURBOPACK' }, ['dev']]]) {
    r = spawnNode(env, [J(root, 'node_modules/next/dist/bin/next'), ...args]);
    assert.deepEqual([r.status, r.stderr], [0, ''], JSON.stringify([env, args]));
  }
  r = spawnNode({ BUNDLE_LOCKFILE_DISABLE: 'rolldown' }, [J(root, 'node_modules/rolldown/bin/cli.mjs')]);
  assert.deepEqual([r.status, r.stderr], [0, '']);
  r = spawnNode({ BUNDLE_LOCKFILE_DISABLE: 'all' }, [J(root, 'ncc.cjs')]);
  assert.deepEqual([r.status, r.stdout.trim(), r.stderr], [0, 'loaded', '']);
  // BUNDLE_LOCKFILE_DISABLE=webpack: Turbopack and ncc stand in for webpack, whose lockfiles are not expected then
  r = spawnNode({ BUNDLE_LOCKFILE_DISABLE: 'webpack', FAKE_BUNDLER: 'TURBOPACK' }, [J(root, 'node_modules/next/dist/bin/next'), 'build']);
  assert.deepEqual([r.status, r.stderr], [0, '']);
  r = spawnNode({ BUNDLE_LOCKFILE_DISABLE: 'webpack' }, [J(root, 'ncc.cjs')]);
  assert.deepEqual([r.status, r.stdout.trim(), r.stderr], [0, 'loaded', '']);
  // ... not by another name (next: the runtime packages, which a Turbopack build still gets)
  r = spawnNode({ BUNDLE_LOCKFILE_DISABLE: 'next,rspack', FAKE_BUNDLER: 'TURBOPACK' }, [J(root, 'node_modules/next/dist/bin/next'), 'build']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, TURBO);
  // Yarn's pnpm linker: the main script in its store (node_modules/.store/<slug>/package) is recognized as well
  for (const [name, bin] of [['rolldown', 'bin/cli.mjs'], ['next', 'dist/bin/next']]) {
    const at = J(root, `node_modules/.store/${name}-npm-1.0.0-0123456789/package`);
    fs.mkdirSync(path.dirname(J(at, bin)), { recursive: true });
    fs.copyFileSync(J(root, 'node_modules', name, 'package.json'), J(at, 'package.json'));
    fs.copyFileSync(J(root, 'node_modules', name, bin), J(at, bin));
  }
  r = spawnNode({}, [J(root, 'node_modules/.store/rolldown-npm-1.0.0-0123456789/package/bin/cli.mjs')]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, ROLLDOWN);
  r = spawnNode({ FAKE_BUNDLER: 'TURBOPACK' }, [J(root, 'node_modules/.store/next-npm-1.0.0-0123456789/package/dist/bin/next'), 'build']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, TURBO);
});

test('strict: webpack before 4 (a Compiler without hooks) fails the process when it compiles; STRICT=0: a warning', () => {
  const compiler = "class Compiler { compile(cb) { cb && cb(null); } run() { this.compile(); } watch() {} newCompilation() {} isChild() { return false; } }\nmodule.exports = Compiler;\n";
  const root = project({
    'node_modules/webpack/package.json': { name: 'webpack', version: '3.12.0' },
    'node_modules/webpack/lib/Compiler.js': compiler,
    'build.cjs': "const Compiler = require('webpack/lib/Compiler.js');\nrequire('webpack/lib/Compiler.js');\nconsole.log('loaded');\nnew Compiler().run();\nconsole.log('built');\n",
    'load.cjs': "require('webpack/lib/Compiler.js');\nconsole.log('loaded');\n",
  });
  const spawnNode = (strict, file) => spawnSync(process.execPath, ['--require', J(SRC, 'register.cjs'), J(root, file)], { cwd: root, encoding: 'utf8', env: strictEnv(strict) });
  let r = spawnNode(undefined, 'build.cjs');
  assert.deepEqual([r.status, r.stdout.trim()], [1, 'loaded\nbuilt']);
  assert.match(r.stderr, /webpack before 4 is not supported \(a Compiler without hooks, from \S+Compiler\.js\): its builds write no lockfile/);
  r = spawnNode('0', 'build.cjs');
  assert.equal(r.status, 0);
  assert.match(r.stderr, /WARNING: webpack before 4 is not supported/);
  // loaded only (an old copy among a project's packages): nothing
  r = spawnNode(undefined, 'load.cjs');
  assert.deepEqual([r.status, r.stderr], [0, '']);
});

test('strict: a Rolldown build with style whose inlined files cannot be read fails; without style it does not', () => withConfig({ strict: true }, async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    problems.take();
    // a Rolldown of another shape: its plugin context has no addWatchFile
    const ctx = { meta: { rolldownVersion: '9.0.0' }, data: {}, error(e) { throw e; } };
    const style = [{ fileName: 'main.js', code: 'main', modules: [J(root, 'src/app.css'), J(root, 'node_modules/a/i.js')] }];
    await assert.rejects(rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'dist'), chunks: style, ctx }),
      (e) => problems.isFailure(e) && /Rolldown 9\.0\.0: could not read the files its plugins inlined \(its plugin context has no addWatchFile\): style sheets @imported from packages would be missing/.test(e.message));
    // the same with the build rolldown() returned: its watch files have them
    const rollupPlugin = rollupAdapter.bundleLockfile('vite');
    rollupPlugin.api.setBuild({ get watchFiles() { return Promise.resolve([]); } });
    await rollupBuild(rollupPlugin, { outDir: J(root, 'dist2'), chunks: style, ctx });
    // no style: nothing would be missing that the build could have inlined from a style sheet
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'dist3'), chunks: [{ fileName: 'main.js', code: 'm', modules: [J(root, 'node_modules/a/i.js')] }], ctx });
    assert.equal(problems.pending(), false);
  } finally { process.chdir(cwd); }
}));

test('strict: a Node.js without the CommonJS hook points fails a process that builds with webpack, and is silent elsewhere', () => {
  const root = project({ 'package.json': { name: 'app', devDependencies: { webpack: '5.0.0' } }, 'build.cjs': '' });
  const elsewhere = project({ 'package.json': { name: 'tool' }, 'x.cjs': '' });
  // (hooks.cjs is loaded first: loading a module needs _compile)
  const script = (main) => `const Module = require('module'); process.argv[1] = ${JSON.stringify(main)};
    const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
    hooks.register({ name: 'w', onCjsLoad() {}, cjsFiles: [/[\\\\/]x\\.cjs$/], cjsPackages: ['webpack'] });
    const compile = Module.prototype._compile; Module.prototype._compile = undefined;
    hooks.install();
    Module.prototype._compile = compile;`;
  const msg = /Node\.js \S+ has no Module\.prototype\._compile: CommonJS bundlers \(webpack, rspack 1, Rollup's CommonJS build, esbuild, Parcel, Angular's builder, Next\.js' build\) are not hooked/;
  const strict = spawnSync(process.execPath, ['-e', script(J(root, 'build.cjs'))], { encoding: 'utf8', env: cjsEnv(undefined), cwd: root });
  assert.equal(strict.status, 1, strict.stderr);
  assert.match(strict.stderr, new RegExp(`ERROR: ${msg.source}`));
  const off = spawnSync(process.execPath, ['-e', script(J(root, 'build.cjs'))], { encoding: 'utf8', env: cjsEnv('0'), cwd: root });
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stderr, new RegExp(`WARNING: ${msg.source}`));
  const other = spawnSync(process.execPath, ['-e', script(J(elsewhere, 'x.cjs'))], { encoding: 'utf8', env: cjsEnv(undefined), cwd: elsewhere });
  assert.deepEqual([other.status, other.stderr], [0, '']);
});

test('strict: a Node.js without the CommonJS hook points fails a process that builds with any CommonJS adapter\'s bundler, by its own package', () => {
  // every adapter that hooks CommonJS modules says which packages make a process one that builds with it: a process
  // that builds only with that bundler (no webpack, no Vite installed) must not go unhooked without a word
  const adapters = ['webpack', 'rollup', 'rspack', 'esbuild', 'parcel', 'angular', 'next'].map(n => [n, require(J(SRC, 'adapters', `${n}.cjs`))]);
  for (const [n, a] of adapters) if (a.onCjsLoad) assert.ok([...(a.cjsPackages || []), ...(a.esmPackages || [])].length, `${n} adapter: no cjsPackages`);
  for (const [name, dep] of [['parcel', 'parcel'], ['parcel', '@parcel/core'], ['angular', '@angular/cli'], ['angular', '@angular/build'], ['angular', '@angular-devkit/build-angular'], ['next', 'next'], ['esbuild', 'esbuild']]) {
    const root = project({ 'package.json': { name: 'app', devDependencies: { [dep]: '1.0.0' } }, 'build.cjs': '' });
    const script = `const Module = require('module'); process.argv[1] = ${JSON.stringify(J(root, 'build.cjs'))};
      const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
      hooks.register(require(${JSON.stringify(J(SRC, 'adapters', `${name}.cjs`))}));
      const compile = Module.prototype._compile; Module.prototype._compile = undefined;
      hooks.install();
      Module.prototype._compile = compile;`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: cjsEnv(undefined), cwd: root });
    assert.equal(r.status, 1, `${name} with ${dep}: ${r.stderr}`);
    assert.match(r.stderr, /ERROR: Node\.js \S+ has no Module\.prototype\._compile: CommonJS bundlers .* are not hooked/, `${name} with ${dep}`);
  }
});

test('strict: a bundler module that ran past the CommonJS hook fails the process at exit (BUNDLE_LOCKFILE_STRICT=0: a warning)', () => {
  const root = project({ 'node_modules/webpack/lib/Compiler.js': 'module.exports = class Compiler {};', 'node_modules/other/lib/Compiler.js': '' });
  const file = J(root, 'node_modules/webpack/lib/Compiler.js');
  // a loader that compiles a module itself, as ncc's or a test runner's: in require.cache, never through _compile
  const past = (f) => `{ const m = new Module(${JSON.stringify(f)}); m.filename = ${JSON.stringify(f)}; m.loaded = true; Module._cache[${JSON.stringify(f)}] = m; }`;
  const adapter = "{ name: 'webpack', onCjsLoad() {}, cjsFiles: [/[\\\\/]webpack[\\\\/]lib[\\\\/]Compiler\\.js$/] }";
  const msg = 'ran past bundle-lockfile\'s CommonJS hook (a loader that compiles modules itself): the bundler in it was not patched, its builds wrote no lockfile';
  const strict = nodeWith(cjsEnv(undefined), ['-e', cjsHookScript(adapter, '', past(file))]);
  assert.equal(strict.status, 1, strict.stderr);
  assert.ok(strict.stderr.includes(`ERROR: ${file} ${msg}`), strict.stderr);
  const off = nodeWith(cjsEnv('0'), ['-e', cjsHookScript(adapter, '', past(file))]);
  assert.equal(off.status, 0, off.stderr);
  assert.ok(off.stderr.includes(`WARNING: ${file} ${msg}`), off.stderr);
  // loaded through the hook, or another file that ran past it: nothing to say
  const hooked = nodeWith(cjsEnv(undefined), ['-e', cjsHookScript(adapter, '', `require(${JSON.stringify(file)}); ${past(J(root, 'node_modules/other/lib/Compiler.js'))}`)]);
  assert.deepEqual([hooked.status, hooked.stderr], [0, '']);
  // loaded before the hooks were installed: reported when they are, so not past them
  const early = nodeWith(cjsEnv(undefined), ['-e', cjsHookScript(adapter, `require(${JSON.stringify(file)});`)]);
  assert.deepEqual([early.status, early.stderr], [0, '']);
});

test('strict: an adapter that fails on a module it patches (cjsFiles) fails its require(); on other modules only warns', () => {
  const root = project({ 'node_modules/webpack/lib/Compiler.js': 'module.exports = class Compiler {};', 'node_modules/x/index.js': '' });
  const adapter = "{ name: 'webpack', onCjsLoad(exp, request) { if (/node_modules/.test(request)) throw new Error('boom'); }, cjsFiles: [/[\\\\/]webpack[\\\\/]lib[\\\\/]Compiler\\.js$/] }";
  const load = (f) => `try { require(${JSON.stringify(f)}); console.log('loaded'); } catch (e) { console.log('failed:', e.message.split('\\n')[1]); }`;
  const file = J(root, 'node_modules/webpack/lib/Compiler.js');
  const strict = nodeWith(cjsEnv(undefined), ['-e', cjsHookScript(adapter, '', load(file))]);
  assert.equal(strict.stdout, `failed:   webpack adapter failed on ${file}: its builds would write no lockfile: boom\n`, strict.stderr);
  const off = nodeWith(cjsEnv('0'), ['-e', cjsHookScript(adapter, '', load(file))]);
  assert.equal(off.stdout, 'loaded\n');
  assert.match(off.stderr, /WARNING: webpack adapter failed on .*Compiler\.js: its builds would write no lockfile: Error: boom/);
  const other = nodeWith(cjsEnv(undefined), ['-e', cjsHookScript(adapter, '', load(J(root, 'node_modules/x/index.js')))]);
  assert.equal(other.stdout, 'loaded\n');
  assert.match(other.stderr, /WARNING: webpack adapter failed while inspecting .*index\.js:/);
});

test('strict: @rspack/core of an unknown shape fails its require() - from 1.0 on, and 0.x (one it patches fails when it compiles)', () => {
  const at = (version, src) => project({ 'node_modules/@rspack/core/package.json': { name: '@rspack/core', version }, 'node_modules/@rspack/core/dist/index.js': src });
  const adapter = `require(${JSON.stringify(J(SRC, 'adapters/rspack.cjs'))})`;
  const run = (root, strict) => nodeWith(cjsEnv(strict), ['-e', cjsHookScript(adapter, '',
    `try { require(${JSON.stringify(J(root, 'node_modules/@rspack/core/dist/index.js'))}); console.log('loaded'); } catch (e) { console.log('failed:', e.message.split('\\n')[1]); }`)]);
  const unknown = at('1.7.0', 'module.exports = { rspack() {} };');
  const file = J(unknown, 'node_modules/@rspack/core/dist/index.js');
  const msg = `rspack: ${file} (rspack 1.7.0) exports no rspack() with rspackVersion and Compiler, as bundle-lockfile knows it: its builds would write no lockfile`;
  assert.equal(run(unknown, undefined).stdout, `failed:   ${msg}\n`);
  const off = run(unknown, '0');
  assert.equal(off.stdout, 'loaded\n');
  assert.ok(off.stderr.includes(`WARNING: ${msg}`), off.stderr);
  const oldAt = at('0.7.5', 'module.exports = { rspack() {} };');
  const old = run(oldAt, undefined);
  assert.equal(old.stdout, `failed:   rspack 0.7.5 (${J(oldAt, 'node_modules/@rspack/core/dist/index.js')}) is not supported (it needs 1.1 or later): its builds write no lockfile\n`, old.stderr);
  // rspack 2's ES module through require(esm), as its namespace (no "module.exports" export): patched (on a Node.js that
  // can require() an ES module: 20.19, 22.12 and later)
  if (!process.features.require_module) return;
  const esm = at('2.2.8', "export class Compiler { compile() {} run() {} watch() {} isChild() {} runAsChild() {} createChildCompiler() {} } export const rspackVersion = '2.2.8';");
  fs.writeFileSync(J(esm, 'node_modules/@rspack/core/package.json'), JSON.stringify({ name: '@rspack/core', version: '2.2.8', type: 'module' }));
  const ns = nodeWith(cjsEnv(undefined), ['-e', cjsHookScript(adapter, '',
    `console.log(require(${JSON.stringify(J(esm, 'node_modules/@rspack/core/dist/index.js'))}).Compiler.prototype[Symbol.for('bundle-lockfile.rspack.patched')]);`)]);
  assert.equal(ns.stdout, 'true\n', ns.stderr);
  assert.doesNotMatch(ns.stderr, /bundle-lockfile/); // (Node.js may warn that require(esm) is experimental)
});
