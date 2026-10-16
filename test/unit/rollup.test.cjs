'use strict';
// Unit tests of the Rollup, Rolldown and Vite adapter.
// All unit tests: node --test test/unit/*.test.cjs (see test/README.md)
// (helpers.cjs first: see there)
const {
  SRC, J, pathToFileURLHref, project, UNIT, BUNDLERS, notUnit, entries, allEntries, LOCK, lockedNames, withConfig,
  rollupBuild, recordOf,
} = require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../../src/core/config.cjs');
const problems = require('../../src/core/problems.cjs');

test('rollup adapter: rollup()/rolldown()/watch()/build() get the plugin once, through the ESM hooks (in-thread and loader thread)', () => {
  const root = project({
    // a fake rolldown: its entry returns the plugin names of the options it gets
    'node_modules/rolldown/package.json': { name: 'rolldown', version: '1.2.13', type: 'module', exports: { '.': './dist/index.mjs' } },
    'node_modules/rolldown/dist/index.mjs': `const names = (o) => [].concat(o.plugins || []).flat().map(p => p.name);
      const rolldown = async (o) => names(o);
      const watch = (o) => [].concat(o).map(names);
      const build = async (o) => [].concat(o).map(names);
      const VERSION = '1.2.13';
      export { VERSION, build, rolldown, watch };`,
    'package.json': { name: 'app', version: '1.0.0', type: 'module', dependencies: { rolldown: '1.2.13' } },
    'build.mjs': `import { rolldown, watch, build, VERSION } from 'rolldown';
      const vite = [{ name: 'vite:build-import-analysis' }];
      console.log(JSON.stringify({ VERSION, plain: await rolldown({ plugins: [{ name: 'x' }] }), vite: await rolldown({ plugins: vite }),
        twice: await rolldown({ plugins: [{ name: 'bundle-lockfile' }] }), watch: watch([{}, { plugins: vite }]), build: await build({}) }));`,
  });
  const run = (env) => {
    const r = spawnSync(process.execPath, ['--require', J(SRC, 'register.cjs'), J(root, 'build.mjs')], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  const modes = ['async'];
  if (typeof require('module').registerHooks === 'function') modes.push('sync');
  for (const mode of modes) {
    const got = run({ BUNDLE_LOCKFILE_ESM_HOOKS: mode });
    assert.deepEqual(got, { VERSION: '1.2.13', plain: ['x', 'bundle-lockfile'], vite: ['vite:build-import-analysis', 'bundle-lockfile'],
      twice: ['bundle-lockfile'], watch: [['bundle-lockfile'], ['vite:build-import-analysis', 'bundle-lockfile']], build: [['bundle-lockfile']] }, mode);
    // disabled by kind: a Vite build (it has Vite's plugins) or a plain rolldown() call
    const vite = run({ BUNDLE_LOCKFILE_ESM_HOOKS: mode, BUNDLE_LOCKFILE_DISABLE: 'vite' });
    assert.deepEqual([vite.plain, vite.vite], [['x', 'bundle-lockfile'], ['vite:build-import-analysis']], `${mode}: DISABLE=vite`);
    assert.deepEqual(run({ BUNDLE_LOCKFILE_ESM_HOOKS: mode, BUNDLE_LOCKFILE_DISABLE: 'rolldown' }).plain, ['x'], `${mode}: DISABLE=rolldown`);
  }
  assert.deepEqual(run({ BUNDLE_LOCKFILE_ESM_HOOKS: 'off' }).plain, ['x']);
});

test('rollup adapter: a written output gets its lockfile; generate-only builds and outputs below node_modules none', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c'), ...pj('d'), 'node_modules/d/logo.svg': '<svg/>', 'src/main.js': '' });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const rollupPlugin = rollupAdapter.bundleLockfile('vite', { input: J(root, 'index.html') });
    await rollupBuild(rollupPlugin, { outDir: J(root, 'dist'), chunks: [
      { fileName: 'assets/index.js', code: 'index', modules: [J(root, 'src/main.js'), J(root, 'node_modules/a/i.js'), '\0vite/modulepreload-polyfill.js',
        `\0${J(root, 'node_modules/b/i.js')}?commonjs-proxy`, `${J(root, 'node_modules/c/x.css')}?inline`] },
    ], assets: [{ fileName: 'assets/logo.svg', originalFileNames: ['node_modules/d/logo.svg'] }] });
    const lock = JSON.parse(fs.readFileSync(J(root, 'dist', LOCK), 'utf8'));
    assert.deepEqual(lockedNames(JSON.stringify(lock)), ['a', 'b', 'c', 'd']);
    assert.deepEqual(Object.keys(lock['bundle-lockfile'].writers[0].outputs), ['../assets/index.js']); // for nested bundles
    // a worker / legacy polyfill bundle (isWrite false) and a dependency pre-bundling output write nothing
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'gen'), chunks: [{ fileName: 'w.js', code: 'w', modules: [J(root, 'node_modules/a/i.js')] }], isWrite: false });
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'node_modules/.vite/deps'), chunks: [{ fileName: 'a.js', code: 'a', modules: [J(root, 'node_modules/a/i.js')] }] });
    assert.equal(fs.existsSync(J(root, 'gen', LOCK)), false);
    assert.equal(fs.existsSync(J(root, 'node_modules/.vite/deps', LOCK)), false);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: the file of a module id: queries and fragments cut, a "#" in a directory or file name kept', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const root = project({ 'c#proj/node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'c#proj/node_modules/a/i.js': '', 'c#proj/src/a#b.js': '' });
  const p = (f) => J(root, 'c#proj', f);
  assert.equal(rollupAdapter.fileOf(p('node_modules/a/i.js')), p('node_modules/a/i.js'));
  assert.equal(rollupAdapter.fileOf(`\0${p('node_modules/a/i.js')}?commonjs-proxy`), p('node_modules/a/i.js'));
  assert.equal(rollupAdapter.fileOf(p('src/a#b.js')), p('src/a#b.js'));         // a file name with "#"
  assert.equal(rollupAdapter.fileOf(`${p('src/a#b.js')}#frag`), p('src/a#b.js')); // and a fragment
  assert.equal(rollupAdapter.fileOf(`${p('src/x.css')}#hash`), p('src/x.css'));   // a fragment, also of a file that is not there
  assert.equal(rollupAdapter.fileOf(`${p('src/App.vue')}?vue&type=style&index=0#x`), p('src/App.vue'));
  assert.equal(rollupAdapter.fileOf('\0vite/modulepreload-polyfill.js'), null);
  // a whole build in that directory: its packages
  const cwd = process.cwd();
  process.chdir(J(root, 'c#proj'));
  try {
    await rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: p('dist'), chunks: [{ fileName: 'main.js', code: 'main', modules: [p('src/a#b.js'), p('node_modules/a/i.js')] }] });
    assert.deepEqual(lockedNames(fs.readFileSync(p(`dist/${LOCK}`), 'utf8')), ['a']);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: the bundler whose code is in the chunks is listed - Rollup or Rolldown, and Vite; the copies that ran', async () => withConfig({ strict: true }, async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/vite/package.json': { name: 'vite', version: '7.3.7' } });
  const cwd = process.cwd();
  process.chdir(root);
  problems.take();
  const listed = (dir) => allEntries(fs.readFileSync(J(dir, LOCK), 'utf8')).map(([, p]) => `${p.name}@${p.version}`).sort();
  const chunk = { fileName: 'main.js', code: 'main', modules: [J(root, 'node_modules/a/i.js')] };
  try {
    // configured by hand: the Rollup that runs its hooks
    await rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: J(root, 'r'), chunks: [chunk] });
    assert.deepEqual(listed(J(root, 'r')), ['a@1.0.0', `rollup@${UNIT}`]);
    // Rolldown (which says it is a Rollup too, meta.rollupVersion): Rolldown only
    await rollupBuild(rollupAdapter.bundleLockfile('rolldown'), { outDir: J(root, 'rd'), chunks: [chunk], ctx: { meta: { rolldownVersion: UNIT, rollupVersion: '4.0.0' } } });
    assert.deepEqual(listed(J(root, 'rd')), ['a@1.0.0', `rolldown@${UNIT}`]);
    // Vite: also the Vite that runs its config hook
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'v'), chunks: [chunk] });
    assert.deepEqual(listed(J(root, 'v')), ['a@1.0.0', `rollup@${UNIT}`, `vite@${UNIT}`]);
    // an output without chunks (only assets): no code of the bundler's
    await rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: J(root, 'assets'), assets: [{ fileName: 'x.txt', source: 'x' }] });
    assert.deepEqual(listed(J(root, 'assets')), []);
    assert.deepEqual(problems.take(), []);
    // Vite says it is another version (Vite 7+: meta.viteVersion) than the package its caller is in: a problem
    await assert.rejects(rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'vm'), chunks: [chunk], ctx: { meta: { viteVersion: '7.3.7' }, error: (e) => { throw e; } } }),
      /the build runs Vite 7\.3\.7, its caller is in .*vite \(vite@0\.0\.0-unit\)/);
    problems.take();
    // added by the preload: the copy whose rollup() was called (its entry module), and Vite around the caller
    let opts = null;
    const rollup = rollupAdapter.esmWrap('rollup', 'rollup', (o) => { opts = o; return Promise.resolve({}); }, pathToFileURLHref(J(BUNDLERS.root, 'node_modules/rollup/dist/shared/rollup.js')));
    BUNDLERS.vite(rollup, null, [{ plugins: [{ name: 'vite:build-html' }] }]); // (Vite calls it)
    const p = opts.plugins.find(x => x.name === 'bundle-lockfile');
    await rollupBuild(p, { outDir: J(root, 'pre'), chunks: [chunk] });
    assert.deepEqual(listed(J(root, 'pre')), ['a@1.0.0', `rollup@${UNIT}`, `vite@${UNIT}`]);
    assert.deepEqual(problems.take(), []);
  } finally { process.chdir(cwd); }
}));

test('rollup adapter: an asset emitted from a package file, named relative to a Vite root that is not the working directory', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('font'), ...pj('changed'), ...pj('decoy'), 'node_modules/font/f.woff2': 'font bytes',
    'node_modules/changed/c.svg': 'original', 'web/node_modules/decoy/d.svg': 'other bytes', 'node_modules/decoy/d.svg': 'decoy bytes', 'web/index.html': '',
    'web/node_modules/decoy/package.json': { name: 'decoy', version: '2.0.0' } });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    // vite build with root: 'web': Vite names an asset relative to its root (web/), the working directory is the project
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'dist'), chunks: [
      { fileName: 'assets/index.js', code: 'index', modules: [J(root, 'web/index.html'), J(root, 'web/main.js')], entry: J(root, 'web/index.html') },
    ], assets: [
      { fileName: 'assets/f.woff2', originalFileNames: ['../node_modules/font/f.woff2'], source: Buffer.from('font bytes') },
      // a file of that name with other bytes is not the asset's file
      { fileName: 'assets/c.svg', originalFileNames: ['../node_modules/changed/c.svg'], source: 'transformed' },
      // a file of that name relative to the working directory, but with other bytes: the one relative to the root is it
      { fileName: 'assets/d.svg', originalFileNames: ['node_modules/decoy/d.svg'], source: 'other bytes' },
    ] });
    // decoy@2.0.0 is the one in web/node_modules (keyed node_modules/decoy: every key is in node_modules/)
    assert.deepEqual(entries(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')).map(([, p]) => `${p.name}@${p.version}`).sort(), ['decoy@2.0.0', 'font@1.0.0']);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: outputs of one build written at the same time into one directory, in the same format, are writers of their own', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    // as Promise.all([bundle.write(a), bundle.write(b)]) (the rollup command line): every hook of one output gets
    // its own output options object; the hooks of both outputs interleave
    const dir = J(root, 'dist'), rollupPlugin = rollupAdapter.bundleLockfile('rollup', { input: 'src/main.js' });
    const outs = ['main.js', 'main.min.js'].map(entryFileNames => ({ dir, format: 'es', entryFileNames }));
    const modules = [J(root, 'src/main.js'), J(root, 'node_modules/a/i.js')];
    const chunk = (out) => ({ type: 'chunk', fileName: out.entryFileNames, code: `code of ${out.entryFileNames}`, moduleIds: modules, isEntry: true, facadeModuleId: modules[0] });
    rollupPlugin.buildStart.call({});
    for (const out of outs) rollupPlugin.renderStart.call({}, out);
    for (const out of outs) rollupPlugin.renderChunk.call({}, '', { moduleIds: modules }, out);
    for (const out of outs) await rollupPlugin.generateBundle.handler.call({}, out, { [out.entryFileNames]: chunk(out) }, true);
    fs.mkdirSync(dir, { recursive: true });
    for (const out of outs) fs.writeFileSync(J(dir, out.entryFileNames), chunk(out).code);
    await Promise.all(outs.map(out => rollupPlugin.writeBundle.handler.call({}, out)));
    await rollupPlugin.closeBundle.handler.call({});
    const writers = JSON.parse(fs.readFileSync(J(dir, LOCK), 'utf8'))['bundle-lockfile'].writers;
    assert.deepEqual(writers.map(w => w.files).sort(), [['../main.js'], ['../main.min.js']]);
    // each with the hash of its own file, for a build that bundles it (nested)
    assert.deepEqual(writers.map(w => Object.keys(w.outputs)).sort(), [['../main.js'], ['../main.min.js']]);
    assert.deepEqual(writers.map(w => w.packages), [['node_modules/a'], ['node_modules/a']]);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: Rolldown write() without dir and file: the lockfile in dist/, where Rolldown writes', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const rollupPlugin = rollupAdapter.bundleLockfile('rolldown', { input: 'src/main.js' });
    const ctx = { meta: { rolldownVersion: '1.2.13', rollupVersion: '4.23.0' } }; // Rolldown's plugin context
    const out = { format: 'es' }; // neither dir nor file in the hooks' output options
    const modules = [J(root, 'src/main.js'), J(root, 'node_modules/a/i.js')];
    rollupPlugin.buildStart.call(ctx, { input: ['src/main.js'] });
    rollupPlugin.renderStart.call(ctx, out);
    rollupPlugin.renderChunk.call(ctx, '', { moduleIds: modules }, out);
    await rollupPlugin.generateBundle.handler.call(ctx, out, { 'main.js': { type: 'chunk', fileName: 'main.js', code: 'rolldown main', moduleIds: modules } }, true);
    fs.mkdirSync(J(root, 'dist'));
    fs.writeFileSync(J(root, 'dist/main.js'), 'rolldown main');
    await rollupPlugin.writeBundle.handler.call(ctx, out);
    await rollupPlugin.closeBundle.handler.call(ctx);
    const lock = JSON.parse(fs.readFileSync(J(root, 'dist', LOCK), 'utf8'));
    assert.deepEqual(lockedNames(JSON.stringify(lock)), ['a']);
    assert.deepEqual(lock['bundle-lockfile'].writers.map(w => w.files), [['../main.js']]);
    assert.equal(fs.existsSync(J(root, LOCK)), false);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: Rolldown - the outputs of a build resolved against its cwd option; files written after its first write() of several are found', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/late/package.json': { name: 'late', version: '1.0.0' },
    'node_modules/late/l.js': 'late code' });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const rollupPlugin = rollupAdapter.bundleLockfile('rolldown', { input: 'src/main.js' });
    const ctx = { meta: { rolldownVersion: '1.2.13', rollupVersion: '4.23.0' } };
    const pkgDir = J(root, 'packages/a');
    const modules = [J(pkgDir, 'src/main.js'), J(root, 'node_modules/a/i.js')];
    // one build, two write()s (Rolldown runs buildStart for each): rolldown({ cwd: 'packages/a' }), dirs relative to it
    const write = async (dir) => {
      const out = { dir, format: 'es' };
      rollupPlugin.buildStart.call(ctx, { input: ['src/main.js'], cwd: pkgDir });
      rollupPlugin.renderStart.call(ctx, out);
      rollupPlugin.renderChunk.call(ctx, '', { moduleIds: modules }, out);
      await rollupPlugin.generateBundle.handler.call(ctx, out, { 'main.js': { type: 'chunk', fileName: 'main.js', code: `main ${dir}`, moduleIds: modules } }, true);
      fs.mkdirSync(J(pkgDir, dir), { recursive: true });
      fs.writeFileSync(J(pkgDir, dir, 'main.js'), `main ${dir}`);
      await rollupPlugin.writeBundle.handler.call(ctx, out);
    };
    await write('dist');
    // another plugin copies a package file into the first output (in its writeBundle), well before the second write()
    fs.mkdirSync(J(pkgDir, 'dist/vendor/node_modules/late'), { recursive: true });
    fs.writeFileSync(J(pkgDir, 'dist/vendor/node_modules/late/l.js'), 'late code');
    await new Promise(res => setTimeout(res, 2100));
    await write('dist-legacy');
    await rollupPlugin.closeBundle.handler.call(ctx);
    assert.deepEqual(lockedNames(fs.readFileSync(J(pkgDir, 'dist', LOCK), 'utf8')), ['a', 'late']);
    assert.deepEqual(lockedNames(fs.readFileSync(J(pkgDir, 'dist-legacy', LOCK), 'utf8')), ['a']);
    assert.equal(fs.existsSync(J(root, 'dist', LOCK)), false); // (not relative to the process's working directory)
  } finally { process.chdir(cwd); }
});

test('rollup adapter: a plugin from the Vite config adds itself to worker.plugins, and its worker builds count', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('w') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const names = (list) => list.map(p => p.name);
    const rollupPlugin = rollupAdapter.bundleLockfile('vite');
    // no worker.plugins, a function (Vite 5+), an array (Vite 4's form), one that has bundle-lockfile's already
    const cfg = {};
    rollupPlugin.config(cfg);
    assert.deepEqual(names(cfg.worker.plugins()), ['bundle-lockfile']);
    const fn = { worker: { format: 'es', plugins: () => [{ name: 'user' }] } };
    rollupPlugin.config(fn);
    assert.equal(fn.worker.format, 'es');
    assert.deepEqual(names(fn.worker.plugins()), ['user', 'bundle-lockfile']);
    const arr = { worker: { plugins: [{ name: 'user' }] } };
    rollupPlugin.config(arr);
    assert.deepEqual(names(arr.worker.plugins()), ['user', 'bundle-lockfile']);
    const has = { worker: { plugins: () => [[rollupAdapter.bundleLockfile('vite')]] } };
    rollupPlugin.config(has);
    assert.deepEqual(names(has.worker.plugins().flat()), ['bundle-lockfile']);
    // only for Vite
    assert.equal(rollupAdapter.bundleLockfile('rollup').config, undefined);
    assert.equal(rollupAdapter.bundleLockfile('rolldown').config, undefined);

    // the worker build (generate-only) with the plugin from worker.plugins, then the main build that emits its chunk
    const worker = cfg.worker.plugins()[0];
    await rollupBuild(worker, { outDir: J(root, 'dist'), chunks: [{ fileName: 'w.js', code: 'the worker', modules: [J(root, 'node_modules/w/i.js')], entry: J(root, 'src/w.js') }], isWrite: false });
    await rollupBuild(rollupPlugin, { outDir: J(root, 'dist'), chunks: [{ fileName: 'main.js', code: 'main', modules: [J(root, 'node_modules/a/i.js')] }],
      assets: [{ fileName: 'assets/w-1.js', source: 'the worker' }] });
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['a', 'w']);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: the preload hands a plugin from the config the build rolldown() returns (its watch files)', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('s') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const rollupPlugin = rollupAdapter.bundleLockfile('vite');
    // Rolldown: the style sheets a style sheet @imports are watch files of the build rolldown() returns only
    const build = { watchFiles: Promise.resolve([J(root, 'src/app.css'), J(root, 'node_modules/s/s.css')]) };
    let got;
    const rolldown = rollupAdapter.esmWrap('rolldown', 'rolldown', (options) => { got = options; return Promise.resolve(build); });
    const options = { input: 'index.html', plugins: [{ name: 'vite:css' }, [rollupPlugin]] };
    assert.equal(await rolldown(options), build);
    assert.equal(got, options); // no second plugin
    const ctx = { meta: { rolldownVersion: '1.2.13' } }; // no getWatchFiles in Rolldown's plugin context
    await rollupBuild(rollupPlugin, { outDir: J(root, 'dist'), chunks: [{ fileName: 'main.js', code: 'main', modules: [J(root, 'node_modules/a/i.js'), J(root, 'src/app.css')] }], ctx });
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['a', 's']);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: plugins configured by hand, two builds of different inputs into one directory: both writers', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    // bundleLockfile() without options, as in a config: the input comes from buildStart's options
    for (const name of ['a', 'b']) {
      await rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: J(root, 'dist'), input: [J(root, `src/${name}.js`)],
        chunks: [{ fileName: `${name}.js`, code: `hand-configured ${name}`, modules: [J(root, `src/${name}.js`), J(root, `node_modules/${name}/i.js`)] }] });
    }
    const lock = JSON.parse(fs.readFileSync(J(root, 'dist', LOCK), 'utf8'));
    assert.deepEqual(lockedNames(JSON.stringify(lock)), ['a', 'b']);
    assert.equal(new Set(lock['bundle-lockfile'].writers.map(w => w.id)).size, 2);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: style sheets a style sheet @imports from packages (watch files of Rollup and of Rolldown builds)', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('sanitize.css'), ...pj('bootstrap'), ...pj('tailwind-content'), ...pj('js-only') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const watch = [J(root, 'src/app.css'), J(root, 'node_modules/sanitize.css/sanitize.css'), J(root, 'node_modules/bootstrap/scss/_grid.scss'),
      J(root, 'node_modules/tailwind-content/dist/x.js'), J(root, 'node_modules/js-only/index.js'), 'virtual:not-a-file.css'];
    // Rollup: this.getWatchFiles()
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'a'), ctx: { getWatchFiles: () => watch }, chunks: [{ fileName: 'i.js', code: 'style a', modules: [J(root, 'src/main.js')] }] });
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'a', LOCK), 'utf8')), ['bootstrap', 'sanitize.css']);
    // Rolldown: the RolldownBuild's watchFiles (a promise), given to the plugin by the rolldown() wrapper
    const rollupPlugin = rollupAdapter.bundleLockfile('vite');
    rollupPlugin.api.setBuild({ get watchFiles() { return Promise.resolve(watch); } });
    await rollupBuild(rollupPlugin, { outDir: J(root, 'b'), chunks: [{ fileName: 'i.js', code: 'style b', modules: [J(root, 'src/main.js')] }] });
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'b', LOCK), 'utf8')), ['bootstrap', 'sanitize.css']);
    // the wrapper hands over the build
    let built;
    const rolldown = rollupAdapter.esmWrap('rolldown', 'rolldown', async (options) => { built = options; return { get watchFiles() { return Promise.resolve(watch); } }; });
    await rolldown({ input: 'x.js', plugins: [{ name: 'vite:css' }] });
    const added = built.plugins.find(p => p.name === 'bundle-lockfile');
    await rollupBuild(added, { outDir: J(root, 'c'), chunks: [{ fileName: 'i.js', code: 'style c', modules: [] }] });
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'c', LOCK), 'utf8')), ['bootstrap', 'sanitize.css']);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: files plugins inlined - watch files that are no module of the build (data: URLs, shader includes)', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('icons'), ...pj('glsl'), ...pj('tree'), ...pj('@tsconfig/strictest'), ...pj('a') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const nm = (name, f) => J(root, 'node_modules', name, f);
    // Vite 6.1+: the image a style sheet inlines as a data: URL; a plugin's shader #include; Rolldown: the tsconfig
    // files; a JSON module that was tree-shaken (a module of the build, in no chunk: not inlined); the modules themselves
    const watch = [J(root, 'src/main.js'), J(root, 'src/app.css'), nm('icons', 'bell.svg'), nm('glsl', 'noise.glsl'), nm('@tsconfig/strictest', 'tsconfig.json'),
      nm('tree', 'data.json'), nm('a', 'i.js')];
    const modules = [J(root, 'src/main.js'), J(root, 'src/app.css'), nm('a', 'i.js'), `\0${nm('tree', 'data.json')}?commonjs-proxy`];
    const ctx = { getWatchFiles: () => watch, getModuleIds: () => modules.values() };
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'dist'), ctx,
      chunks: [{ fileName: 'i.js', code: 'inlined', modules: [J(root, 'src/main.js'), nm('a', 'i.js')] }], assets: [{ fileName: 'i.css', source: 'css' }] });
    const lock = JSON.parse(fs.readFileSync(J(root, 'dist', LOCK), 'utf8'));
    assert.deepEqual(lockedNames(JSON.stringify(lock)), ['a', 'glsl', 'icons']);
    // for nested bundles: the CSS file has every inlined file's package, the chunk those that are no style's
    const w = lock['bundle-lockfile'].writers[0];
    const names = (f) => w.contents[f].map(i => lock.packages[w.packages[i]]).filter(notUnit).map(p => p.name).sort(); // indices into the writer's packages; without the unit tests' bundlers
    assert.deepEqual(names('../i.css'), ['glsl', 'icons']);
    assert.deepEqual(names('../i.js'), ['a', 'glsl', 'icons']);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: files other plugins write into the output after the build (workbox sw.js, static copies)', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('workbox-core'), ...pj('normalize.css'), ...pj('changed'), ...pj('old'), ...pj('app'),
    'node_modules/normalize.css/normalize.css': 'html{}', 'node_modules/changed/c.css': 'a{}', 'node_modules/old/o.css': 'o{}' });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const dist = J(root, 'dist');
    fs.mkdirSync(J(dist, 'vendor/node_modules/old'), { recursive: true });
    fs.writeFileSync(J(dist, 'vendor/node_modules/old/o.css'), 'o{}'); // left from before this build
    const before = new Date(Date.now() - 60000);
    fs.utimesSync(J(dist, 'vendor/node_modules/old/o.css'), before, before);
    // workbox-build: generate-only, written later by vite-plugin-pwa in its closeBundle (with a source map comment)
    await rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: '', isWrite: false, chunks: [{ fileName: 'workbox-1.js', code: 'workbox runtime', modules: [J(root, 'node_modules/workbox-core/i.js')] }] });
    const rollupPlugin = rollupAdapter.bundleLockfile('vite');
    await rollupBuild(rollupPlugin, { outDir: dist, chunks: [{ fileName: 'assets/index.js', code: 'index', modules: [J(root, 'node_modules/app/i.js')] }], late() {
      fs.writeFileSync(J(dist, 'workbox-1.js'), 'workbox runtime\n//# sourceMappingURL=workbox-1.js.map\n');
      fs.writeFileSync(J(dist, 'sw.js'), 'unknown');
      fs.mkdirSync(J(dist, 'vendor/node_modules/normalize.css'), { recursive: true });
      fs.writeFileSync(J(dist, 'vendor/node_modules/normalize.css/normalize.css'), 'html{}');
      fs.mkdirSync(J(dist, 'vendor/node_modules/changed'), { recursive: true });
      fs.writeFileSync(J(dist, 'vendor/node_modules/changed/c.css'), 'a{color:red}'); // not the package's bytes
    } });
    const lock = fs.readFileSync(J(dist, LOCK), 'utf8');
    assert.deepEqual(lockedNames(lock), ['app', 'normalize.css', 'workbox-core']);
    // a copy deleted later takes its packages with it (the late files are the writer's files, see outputs.prune)
    assert.ok(JSON.parse(lock)['bundle-lockfile'].writers[0].files.some(f => f.endsWith('normalize.css')));

    // an output directory that contains the working directory is not scanned
    process.chdir(J(root, 'node_modules'));
    const up = rollupAdapter.bundleLockfile('vite');
    await rollupBuild(up, { outDir: root, chunks: [{ fileName: 'top.js', code: 'top', modules: [] }], late() { fs.writeFileSync(J(root, 'w.js'), 'workbox runtime'); } });
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, LOCK), 'utf8')), []);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: files written after the build: over 20 MiB only this process\'s copies, at most 20,000 entries looked at', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const copies = require('../../src/core/copies.cjs');
  const big = Buffer.alloc(20 * 1024 * 1024 + 1, 'a');
  const root = project({ 'node_modules/big/package.json': { name: 'big', version: '1.0.0' }, 'node_modules/app/package.json': { name: 'app', version: '1.0.0' } });
  fs.writeFileSync(J(root, 'node_modules/big/big.js'), big);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const build = async (dist, late) => {
      await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: dist, chunks: [{ fileName: 'index.js', code: `index ${dist}`, modules: [J(root, 'node_modules/app/i.js')] }], late });
      return lockedNames(fs.readFileSync(J(dist, LOCK), 'utf8'));
    };
    const warned = [], warn = config.warn;
    config.warn = (...a) => warned.push(a.join(' '));
    // its path names the package and it has its bytes, but it is over 20 MiB and not a copy this process made: not
    // compared, and said so
    try {
      assert.deepEqual(await build(J(root, 'd1'), () => {
        fs.mkdirSync(J(root, 'd1/vendor/node_modules/big'), { recursive: true });
        fs.writeFileSync(J(root, 'd1/vendor/node_modules/big/big.js'), big);
      }), ['app']);
    } finally { config.warn = warn; }
    assert.deepEqual(warned, [`${J(root, 'd1/vendor/node_modules/big/big.js')} is larger than 20 MiB: not compared with node_modules/big/big.js, whose package it may be a copy of`]);
    warned.length = 0;
    // copied by this process with fs (recorded as copies.install's wrappers do): its package, whatever its size
    assert.deepEqual(await build(J(root, 'd2'), () => {
      copies.record(J(root, 'node_modules/big/big.js'), J(root, 'd2/big.js'));
      fs.copyFileSync(J(root, 'node_modules/big/big.js'), J(root, 'd2/big.js'));
    }), ['app', 'big']);
    // more than 20,000 entries in the output: the rest is not looked at, and that is said
    const many = J(root, 'd3/many');
    fs.mkdirSync(many, { recursive: true });
    const statted = new Set();
    const stat = fs.statSync;
    fs.statSync = function (p, ...rest) { if (typeof p === 'string' && p.startsWith(many)) statted.add(p); return stat.call(this, p, ...rest); };
    config.warn = (...a) => warned.push(a.join(' '));
    try {
      await build(J(root, 'd3'), () => { for (let i = 0; i < 20100; i++) fs.writeFileSync(J(many, `${i}.txt`), ''); });
    } finally { fs.statSync = stat; config.warn = warn; }
    assert.ok(statted.size > 19900 && statted.size <= 20000, `${statted.size} files looked at`);
    assert.deepEqual(warned, [`more than 20000 entries in ${J(root, 'd3')}: the files written there after the build were not all checked for packages`]);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: files written after the build that are older: copies keeping their source\'s time, files a watch rebuild did not write again', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const copies = require('../../src/core/copies.cjs');
  copies.install();
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('app'), ...pj('kept'), ...pj('once'), 'node_modules/kept/k.js': 'kept code', 'node_modules/once/o.js': 'once code' });
  const old = new Date('1985-10-26T08:15:00Z');
  fs.utimesSync(J(root, 'node_modules/kept/k.js'), old, old);
  fs.utimesSync(J(root, 'node_modules/once/o.js'), old, old);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const dist = J(root, 'dist');
    const watching = rollupAdapter.bundleLockfile('vite');
    const build = (n, late) => rollupBuild(watching, { outDir: dist, chunks: [{ fileName: 'index.js', code: `index ${n}`, modules: [J(root, 'node_modules/app/i.js')] }], late });
    // fs.cp with preserveTimestamps: the copy has npm's time of its source, long before the build
    await build(1, () => {
      fs.cpSync(J(root, 'node_modules/kept/k.js'), J(dist, 'vendor/k.js'), { preserveTimestamps: true });
      fs.mkdirSync(J(dist, 'vendor/node_modules/once'), { recursive: true }); // (another process's copy: found by path and bytes)
      fs.writeFileSync(J(dist, 'vendor/node_modules/once/o.js'), 'once code');
    });
    assert.ok(fs.statSync(J(dist, 'vendor/k.js')).mtimeMs < Date.now() - 1e9);
    assert.deepEqual(lockedNames(fs.readFileSync(J(dist, LOCK), 'utf8')), ['app', 'kept', 'once']);
    // the watch rebuild: the copy plugin copies only once; its files still ship
    await new Promise(res => setTimeout(res, 2100)); // (older than the rebuild by more than the coarse-timestamp margin)
    await build(2, () => {});
    assert.deepEqual(lockedNames(fs.readFileSync(J(dist, LOCK), 'utf8')), ['app', 'kept', 'once']);
    // gone, or changed since: no longer
    fs.rmSync(J(dist, 'vendor/node_modules'), { recursive: true });
    fs.writeFileSync(J(dist, 'vendor/k.js'), 'own code');
    fs.utimesSync(J(dist, 'vendor/k.js'), old, old);
    await build(3, () => {});
    assert.deepEqual(lockedNames(fs.readFileSync(J(dist, LOCK), 'utf8')), ['app']);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: the late files of one output are not those another output of the process writes there', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('modern'), ...pj('legacy'), ...pj('poly') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const dist = J(root, 'dist');
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: '', isWrite: false, chunks: [{ fileName: 'p.js', code: 'legacy polyfills', modules: [J(root, 'node_modules/poly/i.js')] }] });
    // plugin-legacy: the legacy output (with the polyfill chunk) and the modern one share dist/; the legacy one is
    // written while the modern one is between its write and its closeBundle
    const modern = rollupAdapter.bundleLockfile('vite', { input: 'modern' });
    await rollupBuild(modern, { outDir: dist, chunks: [{ fileName: 'index.js', code: 'modern', modules: [J(root, 'node_modules/modern/i.js')] }], late: () => {} });
    await rollupBuild(rollupAdapter.bundleLockfile('vite', { input: 'legacy' }), { outDir: dist, chunks: [
      { fileName: 'index-legacy.js', code: 'legacy', modules: [J(root, 'node_modules/legacy/i.js')] }, { fileName: 'polyfills-legacy.js', code: 'legacy polyfills', modules: [] }] });
    await modern.closeBundle.handler.call({}); // again, now that the legacy files are there
    const lock = JSON.parse(fs.readFileSync(J(dist, LOCK), 'utf8'));
    assert.deepEqual(lockedNames(JSON.stringify(lock)), ['legacy', 'modern', 'poly']);
    const byWriter = lock['bundle-lockfile'].writers.map(w => w.files.map(f => path.basename(f)).sort().join(' ')).sort();
    assert.deepEqual(byWriter, ['index-legacy.js polyfills-legacy.js', 'index.js']);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: Rollup\'s CommonJS build is patched when it loads (require(\'rollup\'), its command line, workbox-build)', () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const seen = [];
  // (the request: the module's file, as hooks.cjs passes it)
  const exp = { version: '4.64.2', rollup: async (o) => seen.push(['rollup', o.plugins.map(p => p.name)]), rollupInternal: async (o, hooks) => seen.push(['internal', o.plugins.map(p => p.name), hooks]) };
  const file = J('/x/node_modules/rollup/dist/shared/rollup.js');
  const other = J('/x/node_modules/other/dist/shared/rollup.js');
  rollupAdapter.onCjsLoad({ rollupInternal() {} }, other, () => other); // not Rollup's
  rollupAdapter.onCjsLoad(exp, file, () => file);
  rollupAdapter.onCjsLoad(exp, file, () => file); // once
  exp.rollup({ plugins: [{ name: 'x' }] });
  exp.rollupInternal({ plugins: [] }, 'hooks');
  assert.deepEqual(seen, [['rollup', ['x', 'bundle-lockfile']], ['internal', ['bundle-lockfile'], 'hooks']]);
  const wasmFile = J('/x/node_modules/@rollup/wasm-node/dist/shared/rollup.js');
  const wasm = { version: '4.64.2', rollupInternal: async (o) => seen.push(o.plugins.length) };
  rollupAdapter.onCjsLoad(wasm, wasmFile, () => wasmFile);
  wasm.rollupInternal({});
  assert.equal(seen.pop(), 1);
  // workbox-build's Rollup 2.79 has the object hooks the plugin uses (2.78 and later)
  const two = { version: '2.79.2', rollupInternal: async (o) => seen.push(o.plugins.length) };
  rollupAdapter.onCjsLoad(two, file, () => file);
  two.rollupInternal({});
  assert.equal(seen.pop(), 1);
});

// --- Rollup, Vite, Rolldown

// one output of a build through the plugin's hooks: out (output options), chunks [{ fileName, code, modules }]
async function writeOutput(rollupPlugin, ctx, out, chunks, input) {
  rollupPlugin.buildStart.call(ctx, { input });
  rollupPlugin.renderStart.call(ctx, out);
  for (const c of chunks) rollupPlugin.renderChunk.call(ctx, c.code, { moduleIds: c.modules }, out);
  const bundle = Object.fromEntries(chunks.map(c => [c.fileName, { type: 'chunk', fileName: c.fileName, code: c.code, moduleIds: c.modules, isEntry: true, facadeModuleId: c.modules[0] }]));
  await rollupPlugin.generateBundle.handler.call(ctx, out, bundle, true);
  const dir = out.dir || path.dirname(out.file);
  fs.mkdirSync(dir, { recursive: true });
  for (const c of chunks) fs.writeFileSync(J(dir, c.fileName), c.code);
  await rollupPlugin.writeBundle.handler.call(ctx, out);
}

test('rollup adapter: separate builds of one input into one directory, each with its own output.file (rollup -c with a config array), are writers of their own', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'src/main.js': '' });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    // the bundle with its dependencies, and the same input with them external; Rollup's output options (entryFileNames filled in)
    for (const [file, modules] of [['dist/lib.bundle.js', [J(root, 'src/main.js'), J(root, 'node_modules/a/i.js')]], ['dist/lib.esm.js', [J(root, 'src/main.js')]]]) {
      const rollupPlugin = rollupAdapter.bundleLockfile('rollup', { input: 'src/main.js' });
      const out = { file: J(root, file), format: 'es', entryFileNames: '[name].js' };
      await writeOutput(rollupPlugin, {}, out, [{ fileName: path.basename(file), code: `code of ${file}`, modules }], ['src/main.js']);
      await rollupPlugin.closeBundle.handler.call({});
    }
    const lock = fs.readFileSync(J(root, 'dist', LOCK), 'utf8');
    assert.deepEqual(lockedNames(lock), ['a']);
    assert.deepEqual(recordOf(lock).writers.map(w => w.files).sort(), [['../lib.bundle.js'], ['../lib.esm.js']]);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: Rolldown runs buildStart for every write() of a build: its closeBundle still checks each output for files written after it', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const copies = require('../../src/core/copies.cjs');
  copies.install();
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/late/package.json': { name: 'late', version: '1.0.0' },
    'node_modules/late/l.css': 'late bytes', 'src/main.js': '' });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const rollupPlugin = rollupAdapter.bundleLockfile('rolldown', { input: 'src/main.js' });
    const ctx = { meta: { rolldownVersion: '1.2.13' } };
    for (const dir of ['dist-a', 'dist-b']) {
      await writeOutput(rollupPlugin, ctx, { dir: J(root, dir), format: 'es' }, [{ fileName: 'main.js', code: `main of ${dir}`, modules: [J(root, 'src/main.js'), J(root, 'node_modules/a/i.js')] }], 'src/main.js');
    }
    fs.copyFileSync(J(root, 'node_modules/late/l.css'), J(root, 'dist-a/l.css')); // another plugin, after the writes (vite-plugin-static-copy)
    await rollupPlugin.closeBundle.handler.call(ctx);
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist-a', LOCK), 'utf8')), ['a', 'late']);
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist-b', LOCK), 'utf8')), ['a']);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: Vite 8\'s dependency pre-bundling (vite dev) gets no plugin, wherever its cache directory is', () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const options = { input: { lodash: '/p/node_modules/lodash/index.js' }, plugins: [{ name: 'vite:dep-pre-bundle-assets' }, { name: 'vite:dep-pre-bundle' }] };
  assert.equal(rollupAdapter.attach('rolldown', options), options);
  const build = rollupAdapter.attach('rolldown', { input: 'src/main.js', plugins: [{ name: 'vite:build-import-analysis' }] });
  assert.equal(build.plugins.at(-1).name, 'bundle-lockfile');
});

test('rollup adapter: a Rolldown build with Rolldown\'s builtin:vite-* plugins (tsdown) is no Vite build', () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  // tsdown 0.22 adds rolldown/experimental's importGlobPlugin, named builtin:vite-import-glob; Vite's builds have Vite's
  // own JavaScript plugins. Only a Vite build's plugin has the config hook (worker.plugins, Vite's package from its caller).
  const kindOf = (plugins) => (rollupAdapter.attach('rolldown', { input: 'src/index.ts', plugins }).plugins.at(-1).config ? 'vite' : 'rolldown');
  assert.equal(kindOf([{ name: 'builtin:vite-import-glob' }, { name: 'tsdown:external' }]), 'rolldown');
  assert.equal(kindOf([{ name: 'builtin:vite-json' }, { name: 'builtin:vite-resolve' }]), 'rolldown');
  assert.equal(kindOf([{ name: 'builtin:vite-import-glob' }, { name: 'vite:css' }]), 'vite');
  assert.equal(kindOf([[{ name: 'vite:build-html' }]]), 'vite'); // nested plugin arrays
});

// Rolldown's plugin context classes, as in its dist (1.0, 1.2): PluginContextImpl and its subclasses for load and
// transform, each with an addWatchFile of its own; data: the build's (one PluginContextData per build)
function rolldownContexts({ loadClass = true } = {}) {
  const calls = [];
  class PluginContextImpl {
    constructor(data) { this.data = data; this.meta = { rolldownVersion: '1.2.13' }; }
    addWatchFile(f) { calls.push(['base', f]); return 'base-result'; }
  }
  class LoadPluginContextImpl extends PluginContextImpl {
    constructor(data, id) { super(data); this.currentLoadingModule = id; }
    addWatchFile(f) { calls.push(['load', f]); }
  }
  class TransformPluginContextImpl extends PluginContextImpl {
    constructor(data, id) { super(data); this.moduleId = id; }
    addWatchFile(f) { calls.push(['transform', f]); }
  }
  return { calls, base: (d) => new PluginContextImpl(d), load: loadClass ? (d, id) => new LoadPluginContextImpl(d, id) : (d) => new PluginContextImpl(d),
    transform: (d, id) => new TransformPluginContextImpl(d, id) };
}

test('rolldown-watch: addWatchFile of Rolldown\'s plugin contexts, recorded per build and per module', () => {
  const rw = require('../../src/adapters/rolldown-watch.cjs');
  const r = rolldownContexts();
  const a = {}, b = {}; // two builds (vite build --app's environments; watch mode's builds)
  assert.equal(rw.start(r.base(a)), null);
  assert.equal(rw.start(r.base(b)), null);
  // the subclasses inherit the wrapped base: each is wrapped itself (the marker is an own property)
  for (const d of [a, b]) { assert.equal(rw.wrap(r.load(d, 'x')), null); assert.equal(rw.wrap(r.transform(d, 'x')), null); }
  // the original is called, with its this and its result
  const t = r.transform(a, '/p/src/app.css');
  t.addWatchFile('/p/node_modules/s/s.css');
  r.load(a, '/p/src/shader.glsl').addWatchFile('/p/node_modules/g/n.glsl');
  assert.equal(r.base(a).addWatchFile('/p/node_modules/c/c.json'), 'base-result'); // no module: the whole build's
  r.transform(b, '/p/src/other.css').addWatchFile('/p/node_modules/o/o.css');
  assert.deepEqual(r.calls.map(c => c[0]), ['transform', 'load', 'base', 'transform']); // each once
  assert.deepEqual(rw.filesOf(r.base(a), ['/p/src/app.css', '/p/src/shader.glsl']).sort(), ['/p/node_modules/c/c.json', '/p/node_modules/g/n.glsl', '/p/node_modules/s/s.css']);
  assert.deepEqual(rw.filesOf(r.base(a), ['/p/src/app.css']).sort(), ['/p/node_modules/c/c.json', '/p/node_modules/s/s.css']); // only this output's modules
  assert.deepEqual(rw.filesOf(r.base(b), ['/p/src/app.css', '/p/src/other.css']), ['/p/node_modules/o/o.css']); // the builds do not mix
  // a module loaded again (watch mode): its records start over
  rw.loading(r.base(a), '/p/src/app.css');
  assert.deepEqual(rw.filesOf(r.base(a), ['/p/src/app.css']), ['/p/node_modules/c/c.json']);
  // a build whose start was not seen: none known
  assert.equal(rw.filesOf(r.base({}), ['/p/src/app.css']), null);
  // a second copy of Rolldown: its own classes, wrapped too
  const r2 = rolldownContexts({ loadClass: false }); // 1.0 betas: the load hook's context is a PluginContextImpl
  const c = {};
  assert.equal(rw.start(r2.base(c)), null);
  assert.equal(rw.wrap(r2.load(c)), null);
  r2.load(c).addWatchFile('/p/node_modules/l/l.svg'); // no module known: the whole build's
  assert.deepEqual(rw.filesOf(r2.base(c), []), ['/p/node_modules/l/l.svg']);
  // a subclass without an addWatchFile of its own: the one it inherits is wrapped, once
  class Inherits extends Object.getPrototypeOf(r2.base(c)).constructor {}
  assert.equal(rw.wrap(new Inherits(c)), null);
  r2.calls.length = 0;
  new Inherits(c).addWatchFile('/p/node_modules/i/i.css');
  assert.equal(r2.calls.length, 1);
  // a shape bundle-lockfile does not know
  assert.match(rw.start({ data: {} }), /no addWatchFile/);
  assert.match(rw.wrap(Object.create({ addWatchFile() {} })), /no build data/);
});

test('rollup adapter: Rolldown build() and watch() - the files plugins inlined, from the plugin contexts (no build object)', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('sanitize.css'), ...pj('icons'), ...pj('glsl'), ...pj('other'), ...pj('a') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const nm = (name, f) => J(root, 'node_modules', name, f);
    const r = rolldownContexts();
    const data = {};
    const rollupPlugin = rollupAdapter.bundleLockfile('vite'); // also the plugin from a config: Rolldown's hooks are there
    const ctx = r.base(data);
    const app = J(root, 'src/app.css'), shader = J(root, 'src/shader.glsl'), unused = J(root, 'src/unused.css');
    // the hooks run as Rolldown runs them: buildStart, then per module load and transform (bundle-lockfile's first)
    rollupPlugin.buildStart.call(ctx, {});
    for (const id of [app, shader, unused]) {
      const l = r.load(data, id);
      rollupPlugin.load.handler.call(l, id);
      if (id === shader) l.addWatchFile(nm('glsl', 'noise.glsl'));
      const t = r.transform(data, id);
      rollupPlugin.transform.handler.call(t, 'code', id);
      if (id === app) { t.addWatchFile(nm('sanitize.css', 'sanitize.css')); t.addWatchFile(nm('icons', 'bell.svg')); }
      if (id === unused) t.addWatchFile(nm('other', 'o.css')); // a module in no chunk of this output
    }
    const out = { dir: J(root, 'dist'), format: 'es' };
    rollupPlugin.renderStart.call(ctx, out);
    rollupPlugin.renderChunk.call(ctx, '', { moduleIds: [app, shader, nm('a', 'i.js')] }, out);
    const bundle = { 'i.js': { type: 'chunk', fileName: 'i.js', code: 'i', moduleIds: [app, shader, nm('a', 'i.js')] }, 'i.css': { type: 'asset', fileName: 'i.css', source: 'css' } };
    await rollupPlugin.generateBundle.handler.call(ctx, out, bundle, true);
    fs.mkdirSync(J(root, 'dist'), { recursive: true });
    for (const f of Object.values(bundle)) fs.writeFileSync(J(root, 'dist', f.fileName), f.code || f.source);
    await rollupPlugin.writeBundle.handler.call(ctx, out);
    await rollupPlugin.closeBundle.handler.call(ctx);
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['a', 'glsl', 'icons', 'sanitize.css']);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: Rollup\'s watch mode - the transform dependencies of the modules a rebuild takes from the cache', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('sanitize.css'), ...pj('glsl'), ...pj('a') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const css = J(root, 'node_modules/sanitize.css/sanitize.css'), noise = J(root, 'node_modules/glsl/noise.glsl');
    const app = J(root, 'src/app.css'), shader = J(root, 'src/shader.glsl'), a = J(root, 'node_modules/a/i.js');
    const rollupPlugin = rollupAdapter.bundleLockfile('vite');
    // a build: options (with the cache Rollup's watcher passes), then the transforms of the modules not taken from it
    const build = async ({ cache, transform, modules, watch }) => {
      rollupPlugin.options({ input: 'x', cache });
      const ctx = { meta: { rollupVersion: '4.64.2', watchMode: true }, getWatchFiles: () => watch, getModuleIds: () => modules.values() };
      const run = { ...rollupPlugin, buildStart(o) { rollupPlugin.buildStart.call(this, o); for (const id of transform) rollupPlugin.transform.handler.call(this, '', id); } };
      // (code no other test's chunks have: generate-only builds' chunks are matched by content, process-wide)
      await rollupBuild(run, { outDir: J(root, 'dist'), chunks: [{ fileName: 'i.js', code: 'rebuilt from the cache', modules }], ctx });
      return lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8'));
    };
    assert.deepEqual(await build({ cache: undefined, transform: [app, shader, a], modules: [app, shader, a], watch: [app, shader, a, css, noise] }), ['a', 'glsl', 'sanitize.css']);
    // rebuilt without the shader: src/app.css from the cache (no watch file of this build has its @import)
    const cache = { modules: [{ id: app, transformDependencies: [css] }, { id: shader, transformDependencies: [noise] }, { id: a, transformDependencies: [] }] };
    assert.deepEqual(await build({ cache, transform: [], modules: [app, a], watch: [app, a] }), ['a', 'sanitize.css']);
    // src/app.css transformed again, without its @import: the cache's dependencies of it do not count
    assert.deepEqual(await build({ cache, transform: [app], modules: [app, a], watch: [app, a] }), ['a']);
  } finally { process.chdir(cwd); }
});
