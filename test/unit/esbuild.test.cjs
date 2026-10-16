'use strict';
// Unit tests of the esbuild adapter and bundle-lockfile-from-metafile.
// All unit tests: node --test test/unit/*.test.cjs (see test/README.md)
// (helpers.cjs first: see there)
const {
  strictEnv, SRC, J, project, ids, warningsOf, LOCK, lockedNames, withConfig, esbuildAdapter, ESBUILD_MAIN,
  esbuildCall, TEST,
} = require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const problems = require('../../src/core/problems.cjs');

// esbuild: its lib/main.js as esbuild builds it - module.exports = __toCommonJS(node_exports): getters only, not
// configurable, "default" the inner object
function fakeEsbuild(version, impl = {}) {
  const inner = {};
  const api = { version, build: impl.build || (async (o) => ({ errors: [], warnings: [], options: o })), context: impl.context, buildSync: impl.buildSync || ((o) => ({ errors: [], options: o })), transform: async () => ({}) };
  for (const [k, v] of Object.entries(api)) if (v !== undefined) Object.defineProperty(inner, k, { get: () => v, enumerable: true });
  Object.defineProperty(inner, 'default', { get: () => inner, enumerable: true });
  const exp = Object.defineProperty({}, '__esModule', { value: true });
  for (const k of Object.keys(inner)) Object.defineProperty(exp, k, { get: () => inner[k], enumerable: true });
  return exp;
}

test('esbuild adapter: metafile input keys -> files', () => {
  const { fileOfInput } = esbuildAdapter();
  const root = project({ 'node_modules/a/i.js': '', 'src/h#x.js': '', 'rel/p.js': '' });
  assert.equal(fileOfInput('node_modules/a/i.js', root), J(root, 'node_modules/a/i.js'));
  assert.equal(fileOfInput('(disabled):node_modules/a/i.js', root), null); // a browser field's false: no code of it
  assert.equal(fileOfInput(`ns:${J(root, 'node_modules/a/i.js')}`, root), J(root, 'node_modules/a/i.js')); // a plugin's, absolute
  assert.equal(fileOfInput('ns:rel/p.js', root), J(root, 'rel/p.js')); // relative, there
  assert.equal(fileOfInput('virt:virtual:x', root), null); // virtual
  assert.equal(fileOfInput('ns:rel/none.js', root), null);
  assert.equal(fileOfInput('src/q.js?raw', root), J(root, 'src/q.js'));
  assert.equal(fileOfInput('src/a.js#frag', root), J(root, 'src/a.js'));
  assert.equal(fileOfInput('src/h#x.js', root), J(root, 'src/h#x.js')); // a "#" in the name of a file that is there
  assert.equal(fileOfInput('', root), null);
});

test('esbuild adapter: an image a style sheet inlines as a data: URL counts for the style sheet\'s output (only among its imports in the metafile)', () => {
  const { filesOfOutputs } = esbuildAdapter();
  const root = '/p';
  // esbuild 0.28 with loader { '.svg': 'dataurl' }: the inlined icon is an input of no output; the font (file loader)
  // is the input of an output of its own; tree-shaken.css was dropped; an external url() is no input
  const metafile = {
    inputs: {
      'src/app.css': { bytes: 1, imports: [{ path: 'node_modules/icons/bell.svg', kind: 'url-token' }, { path: 'node_modules/f/f.woff2', kind: 'url-token' },
        { path: 'node_modules/b/b.css', kind: 'import-rule' }, { path: 'https://cdn/x.svg', kind: 'url-token', external: true }] },
      'node_modules/icons/bell.svg': { bytes: 1, imports: [] }, 'node_modules/f/f.woff2': { bytes: 1, imports: [] }, 'node_modules/b/b.css': { bytes: 1, imports: [] },
      'src/tree-shaken.css': { bytes: 1, imports: [{ path: 'node_modules/gone/g.svg', kind: 'url-token' }] }, 'node_modules/gone/g.svg': { bytes: 1, imports: [] },
    },
    outputs: {
      'dist/index.css': { inputs: { 'src/app.css': { bytesInOutput: 9 }, 'node_modules/b/b.css': { bytesInOutput: 9 } } },
      'dist/f-X.woff2': { inputs: { 'node_modules/f/f.woff2': { bytesInOutput: 9 } } },
    },
  };
  const got = filesOfOutputs(metafile, root);
  assert.deepEqual(got.get(J(root, 'dist/index.css')).sort(), ['/p/node_modules/b/b.css', '/p/node_modules/icons/bell.svg', '/p/src/app.css'].map(f => J(f)));
  assert.deepEqual(got.get(J(root, 'dist/f-X.woff2')), [J(root, 'node_modules/f/f.woff2')]);
});

test('esbuild adapter: replaces the getter-only exports with a copy whose build/context/buildSync add the plugin', async () => {
  const a = esbuildAdapter();
  let seen = null;
  const exp = fakeEsbuild('0.28.2', { build: async (o) => { seen = o; return { errors: [] }; }, context: async (o) => { seen = o; return {}; } });
  const r = a.onCjsLoad(exp, ESBUILD_MAIN, () => ESBUILD_MAIN);
  assert.ok(r && r.exports);
  const copy = r.exports;
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(exp).sort()); // every export kept
  assert.equal(copy.default, copy); // ES-module interop reaches the wrappers too
  assert.equal(copy.__esModule, true);
  assert.equal(copy.transform, exp.transform);
  assert.equal(copy.version, '0.28.2');
  assert.equal(a.onCjsLoad(exp, ESBUILD_MAIN, () => ESBUILD_MAIN), undefined); // once
  assert.equal(a.onCjsLoad(copy, ESBUILD_MAIN, () => ESBUILD_MAIN), undefined);
  const names = (o) => (o.plugins || []).map(p => p.name);
  const opts = { entryPoints: ['src/main.js'], outdir: 'dist', plugins: [{ name: 'user', setup() {} }] };
  await copy.build(opts);
  assert.deepEqual(names(seen), ['user', 'bundle-lockfile']);
  assert.deepEqual(names(opts), ['user']); // the caller's options as they were
  await copy.context({ outfile: 'dist/x.js' });
  assert.deepEqual(names(seen), ['bundle-lockfile']);
  await copy.build({ outdir: 'dist', plugins: [{ name: 'bundle-lockfile' }] }); // configured already
  assert.deepEqual(names(seen), ['bundle-lockfile']);
  // Vite 5 - 7's own builds, and outputs below node_modules, are left alone
  for (const o of [{ outdir: 'node_modules/.vite/deps', plugins: [{ name: 'vite:dep-pre-bundle' }] }, { outdir: '.cache/deps', plugins: [{ name: 'vite:dep-pre-bundle' }] }, { write: false, plugins: [{ name: 'vite:dep-scan' }] }, { outdir: 'node_modules/some-lib/dist' },
    { write: false, plugins: [{ name: 'externalize-deps' }, { name: 'inject-file-scope-variables' }] }]) { // (the last: Vite bundling its config)
    await copy.build(o);
    assert.equal(seen, o);
  }
  // except below node_modules/.cache/, where tools build what ships (as for Rollup and Vite, core/paths.cjs inToolCache)
  await copy.build({ outdir: 'node_modules/.cache/x' });
  assert.deepEqual(names(seen), ['bundle-lockfile']);
  // other modules, and a lib/main.js of another package
  assert.equal(a.onCjsLoad(fakeEsbuild('0.28.2'), '/p/node_modules/other/lib/main.js', () => ''), undefined);
  // a plugin's build.esbuild (esbuild's inner exports) is the copy: a sub-build gets the plugin too; a plugin whose name
  // is a getter of its class keeps it
  let sub = null;
  class Named { get name() { return 'named'; } setup(build) { sub = build.esbuild; } }
  await copy.build({ outdir: 'dist', plugins: [new Named()] });
  assert.deepEqual(names(seen), ['named', 'bundle-lockfile']);
  seen.plugins[0].setup({ esbuild: exp.default, initialOptions: {}, onLoad() {} });
  assert.equal(sub, copy);
});

test('esbuild adapter: buildSync fails with its own problems (and those of none), not with those of another build running meanwhile', () => withConfig({ strict: true }, () => {
  const a = esbuildAdapter();
  const copy = a.onCjsLoad(fakeEsbuild('0.28.2', { buildSync: () => ({ errors: [], metafile: { outputs: {} } }) }), ESBUILD_MAIN, () => ESBUILD_MAIN).exports;
  problems.take();
  const other = {};
  problems.within(other, () => problems.problem('a problem of another build'));
  copy.buildSync({ entryPoints: ['a.js'], write: false });
  assert.deepEqual(problems.takeOwn(other), ['a problem of another build']);
}));

test('esbuild adapter: an esbuild of a shape it does not know, or before 0.17, fails (strict) instead of writing no lockfile', () => withConfig({ strict: true }, async () => {
  const a = esbuildAdapter();
  problems.take();
  assert.equal(a.onCjsLoad({ version: '0.28.2' }, ESBUILD_MAIN, () => ESBUILD_MAIN), undefined);
  assert.match(problems.take().join('\n'), /exports no build\(\) and version bundle-lockfile knows/);
  const old = a.onCjsLoad(fakeEsbuild('0.16.17'), ESBUILD_MAIN, () => ESBUILD_MAIN).exports;
  await assert.rejects(old.build({ entryPoints: ['a.js'], outdir: 'dist' }), /needs esbuild 0\.17 or later/);
  assert.throws(() => old.buildSync({ entryPoints: ['a.js'], outfile: 'dist/a.js' }), /needs esbuild 0\.17 or later/);
  // not for builds it would not cover anyway
  await old.build({ entryPoints: ['a.js'], write: false });
  await old.build({ entryPoints: ['a.js'], outdir: 'node_modules/.vite/deps' });
  assert.equal(problems.count(), 0);
}));

// runs the plugin of one build: its setup with the options, then onEnd with the result; returns onEnd's return value
async function esbuildEnd(options, result, file) {
  const esbuildPlugin = esbuildAdapter().attach(options, file).plugins.at(-1);
  let end = null;
  esbuildPlugin.setup({ initialOptions: options, onStart() {}, onEnd: (fn) => { end = fn; } });
  return end(result);
}

test('esbuild adapter: onEnd lists the packages of the inputs of every output, writes the lockfile, removes the forced metafile', async () => {
  const pj = (name, version = '1.0.0') => ({ [`node_modules/${name}/package.json`]: { name, version } });
  const root = project({ ...pj('a'), ...pj('reexp'), ...pj('shaken'), ...pj('font'), ...pj('dis'), ...pj('ns'), 'node_modules/a/i.js': '', 'src/main.js': '' });
  fs.mkdirSync(J(root, 'dist'));
  for (const f of ['main.js', 'main.css', 'f.woff2']) fs.writeFileSync(J(root, 'dist', f), f);
  const metafile = {
    inputs: { 'node_modules/shaken/i.js': {} }, // tree-shaken: in no output
    outputs: {
      'dist/main.js': { entryPoint: 'src/main.js', inputs: { 'src/main.js': { bytesInOutput: 9 }, 'node_modules/a/i.js': { bytesInOutput: 3 }, 'node_modules/reexp/index.js': { bytesInOutput: 0 }, '(disabled):node_modules/dis/i.js': { bytesInOutput: 102 }, [`ns:${J(root, 'node_modules/ns/i.js')}`]: { bytesInOutput: 5 }, 'virt:virtual:x': { bytesInOutput: 5 } }, imports: [{ path: 'ext', external: true }] },
      'dist/main.css': { inputs: { 'node_modules/a/s.css': { bytesInOutput: 4 } } },
      'dist/f.woff2': { inputs: { 'node_modules/font/f.woff2': { bytesInOutput: 9 } } },
    },
  };
  const options = { entryPoints: ['src/main.js'], outdir: 'dist', absWorkingDir: root };
  const result = { errors: [], warnings: [], metafile };
  assert.equal(await esbuildEnd(options, result), undefined);
  assert.equal(options.metafile, true); // turned on for the build
  assert.equal('metafile' in result, false); // and taken out of the result: the caller did not ask for it
  const lock = JSON.parse(fs.readFileSync(J(root, 'dist', LOCK), 'utf8'));
  assert.deepEqual(lockedNames(JSON.stringify(lock)), ['a', 'font', 'ns', 'reexp']);
  const [w] = lock['bundle-lockfile'].writers;
  assert.deepEqual([...w.files].sort(), ['../f.woff2', '../main.css', '../main.js']);
  assert.deepEqual(Object.keys(w.outputs).sort(), ['../main.css', '../main.js']); // JavaScript and CSS: for nested bundles
  // asked for: kept
  const asked = { errors: [], metafile };
  await esbuildEnd({ ...options, metafile: true }, asked);
  assert.equal(asked.metafile, metafile);
  // the esbuild whose build() ran (its runtime helpers are in the JavaScript): listed, as found by "runtime", for the
  // JavaScript output only - not without a JavaScript output
  const esb = J(root, 'node_modules/esbuild/lib/main.js');
  fs.mkdirSync(path.dirname(esb), { recursive: true });
  fs.writeFileSync(J(root, 'node_modules/esbuild/package.json'), JSON.stringify({ name: 'esbuild', version: '0.28.2', license: 'MIT' }));
  await esbuildEnd({ ...options }, { errors: [], metafile }, esb);
  const withRt = JSON.parse(fs.readFileSync(J(root, 'dist', LOCK), 'utf8'));
  assert.deepEqual(lockedNames(JSON.stringify(withRt)), ['a', 'esbuild', 'font', 'ns', 'reexp']);
  const w2 = withRt['bundle-lockfile'].writers[0];
  assert.deepEqual(w2.via.runtime.map(i => w2.packages[i]), ['node_modules/esbuild']);
  const at = (f) => w2.contents[f].map(i => w2.packages[i]);
  assert.ok(at('../main.js').includes('node_modules/esbuild'));
  assert.ok(!at('../main.css').includes('node_modules/esbuild'));
  const cssOnly = { outputs: { 'dist/main.css': metafile.outputs['dist/main.css'] } };
  // (the files of the earlier builds that are still there ship, with their packages: an output of main.css alone)
  for (const f of ['main.js', 'f.woff2']) fs.rmSync(J(root, 'dist', f));
  await esbuildEnd({ ...options }, { errors: [], metafile: cssOnly }, esb);
  assert.ok(!lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')).includes('esbuild'));
  // a failed build wrote nothing: nothing recorded (esbuild gives no metafile then)
  fs.rmSync(J(root, 'dist', LOCK));
  await esbuildEnd({ ...options }, { errors: [{ text: 'x' }] });
  assert.equal(fs.existsSync(J(root, 'dist', LOCK)), false);
  // another plugin's onEnd returned an error (a type check): esbuild wrote the output before - its lockfile too
  await esbuildEnd({ ...options }, { errors: [{ text: 'TS2307', pluginName: 'tsc' }], metafile: cssOnly });
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['a']);
  // written, and none of its files there (another plugin's onEnd moved them): said, no lockfile
  fs.rmSync(J(root, 'dist'), { recursive: true });
  const warned = await warningsOf(() => esbuildEnd({ ...options }, { errors: [], metafile }));
  assert.match(warned.join('\n'), /none of the files of the build into \S*dist is there after it/);
  assert.equal(fs.existsSync(J(root, 'dist', LOCK)), false);
});

test('esbuild adapter: a problem is an onEnd error (the build rejects); write: false keeps the packages for the build that uses the output', () => withConfig({ strict: true }, async () => {
  const generated = require('../../src/core/generated.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/nopj/i.js': '' });
  fs.mkdirSync(J(root, 'dist'));
  fs.writeFileSync(J(root, 'dist/main.js'), 'x');
  problems.take();
  const bad = await esbuildEnd({ outdir: 'dist', absWorkingDir: root }, { errors: [], metafile: { outputs: { 'dist/main.js': { inputs: { 'node_modules/nopj/i.js': { bytesInOutput: 1 } } } } } });
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0].text, /no package\.json with name and version in .*nopj/);
  // write: false - nothing written, the packages by the output's content
  const text = 'generated by esbuild, write: false';
  assert.equal(await esbuildEnd({ outdir: 'out', write: false, absWorkingDir: root }, { errors: [], metafile: { outputs: { 'out/w.js': { entryPoint: 'src/w.js', inputs: { 'node_modules/a/i.js': { bytesInOutput: 1 } } } } }, outputFiles: [{ path: J(root, 'out/w.js'), text, contents: Buffer.from(text) }] }), undefined);
  assert.equal(fs.existsSync(J(root, 'out')), false);
  assert.deepEqual(ids(generated.byContent(text)), ['a@1.0.0']);
}));

test('esbuild adapter: separate builds of one config into one directory (ES modules and CommonJS) keep each other\'s packages; a rebuild of one replaces its own', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c'), 'dist/a.mjs': 'esm', 'dist/a.cjs': 'cjs' });
  const base = { entryPoints: ['src/a.js'], bundle: true, outdir: 'dist', absWorkingDir: root };
  const result = (out, name) => ({ errors: [], metafile: { outputs: { [`dist/${out}`]: { entryPoint: 'src/a.js', inputs: { [`node_modules/${name}/i.js`]: { bytesInOutput: 1 } } } } } });
  const esm = esbuildCall({ ...base, format: 'esm', outExtension: { '.js': '.mjs' } });
  const cjs = esbuildCall({ ...base, format: 'cjs', outExtension: { '.js': '.cjs' }, external: ['a'] });
  // (one writer: the same entry points and output directory)
  await esm.build(result('a.mjs', 'a'));
  await cjs.build(result('a.cjs', 'b'));
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['a', 'b']);
  // a rebuild of the CommonJS build (a context's), with another package: its earlier build is gone, the other one stays
  await cjs.build(result('a.cjs', 'c'));
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['a', 'c']);
});

test('esbuild adapter: write: false without outdir or outfile - its one output file, which esbuild names <stdout>, is the metafile\'s one output', async () => {
  const generated = require('../../src/core/generated.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  // esbuild 0.17 - 0.28: outputFiles [<stdout>], the metafile's output named after the entry point
  const text = 'a worker, bundled into a string (write: false, no outdir)';
  assert.equal(await esbuildEnd({ entryPoints: ['src/w.js'], bundle: true, write: false, absWorkingDir: root },
    { errors: [], metafile: { outputs: { 'w.js': { entryPoint: 'src/w.js', inputs: { 'node_modules/a/i.js': { bytesInOutput: 1 } } } } }, outputFiles: [{ path: '<stdout>', text, contents: Buffer.from(text) }] }), undefined);
  assert.deepEqual(ids(generated.byContent(text)), ['a@1.0.0']);
  assert.deepEqual(ids(generated.byContent(Buffer.from(text))), ['a@1.0.0']); // (the bytes a caller writes)
});

test('esbuild adapter: the output of a write: false build that a plugin inlines into a module it loads (its entry): listed (esbuild-plugin-inline-worker)', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('dep'), ...pj('wk'), ...pj('lib'), ...pj('earlier'), 'dist/main.js': 'main', 'src/w.worker.js': '', 'src/lib.js': '', 'src/main.js': '' });
  // write: false builds (no output), each with a package of its own: the worker the plugin bundles in its onLoad; a module
  // of the main build that esbuild loads itself; the main build's own entry point (an earlier build of it)
  for (const [entry, name] of [['src/w.worker.js', 'wk'], ['src/lib.js', 'lib'], ['src/main.js', 'earlier']]) {
    const text = `${entry} bundled`;
    await esbuildEnd({ entryPoints: [J(root, entry)], bundle: true, write: false, absWorkingDir: root }, { errors: [],
      metafile: { outputs: { [path.basename(entry)]: { entryPoint: entry, inputs: { [`node_modules/${name}/i.js`]: { bytesInOutput: 1 }, [entry]: { bytesInOutput: 1 } } } } },
      outputFiles: [{ path: '<stdout>', text, contents: Buffer.from(text) }] });
  }
  const inline = { name: 'inline-worker', setup(build) {
    build.onLoad({ filter: /\.worker\.js$/ }, async (args) => ({ contents: `export default ${JSON.stringify(`${args.path} bundled`)};`, loader: 'js' }));
  } };
  const call = esbuildCall({ entryPoints: ['src/main.js'], bundle: true, outdir: 'dist', absWorkingDir: root, plugins: [inline] });
  // (the fake build calls the callback for the entry too: a plugin that loads every module)
  for (const cb of call.loads) for (const f of ['src/w.worker.js', 'src/main.js']) await cb({ path: J(root, f), namespace: 'file' });
  assert.equal(await call.build({ errors: [], metafile: { outputs: { 'dist/main.js': { entryPoint: 'src/main.js',
    inputs: { 'src/main.js': { bytesInOutput: 1 }, 'src/w.worker.js': { bytesInOutput: 1 }, 'src/lib.js': { bytesInOutput: 1 }, 'node_modules/dep/i.js': { bytesInOutput: 1 } } } } } }), undefined);
  const lock = JSON.parse(fs.readFileSync(J(root, 'dist', LOCK), 'utf8'));
  assert.deepEqual(lockedNames(JSON.stringify(lock)), ['dep', 'wk']);
  const [w] = lock['bundle-lockfile'].writers;
  assert.deepEqual(w.via.generated.map(i => w.packages[i]), ['node_modules/wk']);
  assert.deepEqual(w.contents['../main.js'].map(i => w.packages[i]).sort(), ['node_modules/dep', 'node_modules/wk']);
});

test('esbuild adapter: a script that changes its working directory after loading esbuild builds in the one esbuild loaded in', () => {
  const root = project({
    'node_modules/a/package.json': { name: 'a', version: '1.0.0' },
    'node_modules/esbuild/package.json': { name: 'esbuild', version: '0.28.2', main: 'lib/main.js' },
    // esbuild's defaultWD: the working directory when lib/main.js loads, for builds without absWorkingDir
    'node_modules/esbuild/lib/main.js': `"use strict";
const fs = require('fs'), path = require('path');
var defaultWD = process.cwd();
async function build(options) {
  const wd = options.absWorkingDir || defaultWD;
  const ends = [];
  for (const p of options.plugins || []) await p.setup({ initialOptions: options, onStart() {}, onEnd: (cb) => ends.push(cb), onLoad() {}, onResolve() {} });
  const out = path.resolve(wd, options.outdir, 'main.js');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'bundled a');
  const result = { errors: [], warnings: [], metafile: options.metafile ? { inputs: {}, outputs: { [path.relative(wd, out)]: { inputs: { 'node_modules/a/i.js': { bytesInOutput: 9 } } } } } : undefined };
  for (const cb of ends) { const r = await cb(result); if (r && r.errors) result.errors.push(...r.errors); }
  if (result.errors.length) throw new Error(result.errors.map(e => e.text).join('\\n'));
  return result;
}
module.exports = { version: '0.28.2', build };`,
    'sub/x': '',
    'build.cjs': `const esbuild = require('esbuild'); const path = require('path');
const abs = process.argv[2] === 'abs';
process.chdir('sub');
esbuild.build({ entryPoints: [abs ? path.resolve('../src/main.js') : 'src/main.js'], outdir: abs ? path.resolve('../dist') : 'dist' })
  .then(() => console.log('built'), (e) => { console.error(e.message); process.exit(1); });`,
  });
  const env = { ...strictEnv(undefined), NODE_OPTIONS: `--require ${J(SRC, 'register.cjs')}` };
  for (const k of Object.keys(env)) if (k.startsWith('BUNDLE_LOCKFILE_') && k !== 'BUNDLE_LOCKFILE_STRICT') delete env[k];
  for (const mode of ['abs', 'relative']) {
    const r = spawnSync(process.execPath, ['build.cjs', mode], { cwd: root, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['a', 'esbuild'], mode); // (esbuild: its runtime helpers)
    assert.equal(fs.existsSync(J(root, 'sub/dist')), false, mode);
    fs.rmSync(J(root, 'dist'), { recursive: true });
  }
});

test('esbuild adapter: Vite 5 - 7\'s build of a dependency\'s entry for its exports (extractExportsData) is left alone, told by its caller', async () => {
  // (Vite 7: parse((await build({ ...optimizeDeps.esbuildOptions, entryPoints: [filePath], write: false, format: 'esm' }))...))
  const code = `exports.run = (build) => extractExportsData(build, '/p/node_modules/dep/index.svelte');
async function extractExportsData(build, filePath) { await null; return build({ entryPoints: [filePath], write: false, format: 'esm', plugins: [{ name: 'svelte', setup() {} }] }); }`;
  const root = project({ 'node_modules/vite/dist/node/chunks/config.js': code, 'node_modules/other/dist/node/chunks/config.js': code });
  let seen = null;
  const copy = esbuildAdapter().onCjsLoad(fakeEsbuild('0.28.2', { build: async (o) => { seen = o; return { errors: [] }; } }), ESBUILD_MAIN, () => ESBUILD_MAIN).exports;
  await require(J(root, 'node_modules/vite/dist/node/chunks/config.js')).run(copy.build);
  assert.deepEqual(seen.plugins.map(p => p.name), ['svelte']);
  // the same build from another package's function of that name gets the plugin
  await require(J(root, 'node_modules/other/dist/node/chunks/config.js')).run(copy.build);
  assert.deepEqual(seen.plugins.map(p => p.name), ['svelte', 'bundle-lockfile']);
});

test('esbuild adapter: style sheets a plugin inlines (its onLoad watchFiles) count for the module it loaded; files written by other plugins\' onEnd too', async () => {
  require('../../src/core/copies.cjs').install(); // (as register.cjs does: the copy below is one of a package file)
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('partial'), ...pj('code'), ...pj('unused'), ...pj('copied'), 'node_modules/copied/c.css': 'copied bytes',
    'node_modules/partial/_p.scss': '', 'src/s.scss': '', 'src/u.scss': '' });
  fs.mkdirSync(J(root, 'dist'));
  fs.writeFileSync(J(root, 'dist/main.css'), 'css');
  const options = { entryPoints: ['src/s.scss'], outdir: 'dist', absWorkingDir: root, plugins: [{
    name: 'sass', setup(build) {
      assert.equal(build.initialOptions.outdir, 'dist'); // the build's own, through the recording wrapper
      build.onLoad({ filter: /\.scss$/ }, async (args) => ({ contents: '', loader: 'css',
        watchFiles: args.path.endsWith('s.scss')
          ? [args.path, J(root, 'node_modules/partial/_p.scss'), J(root, 'node_modules/code/i.js'), 'relative/_x.scss']
          : [J(root, 'node_modules/unused/_u.scss')] }));
      build.onEnd(() => { fs.copyFileSync(J(root, 'node_modules/copied/c.css'), J(root, 'dist/c.css')); });
    },
  }] };
  const attached = esbuildAdapter().attach(options);
  assert.deepEqual(attached.plugins.map(p => p.name), ['sass', 'bundle-lockfile']);
  const loads = [], ends = [], starts = [];
  const build = { initialOptions: attached, onLoad: (o, cb) => loads.push(cb), onEnd: (cb) => ends.push(cb), onStart: (cb) => starts.push(cb), onResolve() {} };
  for (const p of attached.plugins) p.setup(build);
  for (const s of starts) s();
  for (const cb of loads) { await cb({ path: J(root, 'src/s.scss'), namespace: 'file' }); await cb({ path: J(root, 'src/u.scss'), namespace: 'file' }); }
  const result = { errors: [], metafile: { outputs: { 'dist/main.css': { inputs: { 'src/s.scss': { bytesInOutput: 3 } } } } } };
  for (const cb of ends) assert.equal(await cb(result), undefined);
  // the partial of the module in the output (not the code file, not the relative path, not the unused module's), and
  // the file the other plugin's onEnd copied out of a package
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['copied', 'partial']);
});

test('esbuild adapter: the CommonJS hook replaces esbuild\'s exports, for require(), import and ES-module interop', () => {
  const root = project({
    'node_modules/esbuild/package.json': { name: 'esbuild', version: '0.28.2', main: 'lib/main.js' },
    'node_modules/esbuild/lib/main.js': `"use strict";
var __defProp = Object.defineProperty;
var node_exports = {};
for (const [k, v] of Object.entries({ version: '0.28.2', build: async (o) => o, context: async (o) => o, buildSync: (o) => ({ plugins: o.plugins, metafile: { outputs: {} } }) })) __defProp(node_exports, k, { get: () => v, enumerable: true });
__defProp(node_exports, 'default', { get: () => node_exports, enumerable: true });
const out = __defProp({}, '__esModule', { value: true });
for (const k of Object.keys(node_exports)) __defProp(out, k, { get: () => node_exports[k], enumerable: true });
module.exports = out;
0 && (module.exports = { build, buildSync, context, version });`,
    'cjs.cjs': `const e = require('esbuild'); const d = require('esbuild').default;
const names = (o) => (o.plugins || []).map(p => p.name).join(',');
const __importDefault = (m) => (m && m.__esModule ? m : { default: m });
Promise.all([e.build({ outdir: 'd' }), d.build({ outdir: 'd' }), __importDefault(e).default.context({ outdir: 'd' })]).then(r => console.log(r.map(names).join(' '), names(e.buildSync({ outdir: 'd' }))));`,
    'esm.mjs': `import * as ns from 'esbuild'; import def, { build } from 'esbuild';
const names = (o) => (o.plugins || []).map(p => p.name).join(',');
console.log((await Promise.all([ns.build({ outdir: 'd' }), def.build({ outdir: 'd' }), build({ outdir: 'd' })])).map(names).join(' '));`,
  });
  const env = { ...strictEnv(undefined), NODE_OPTIONS: `--require ${J(SRC, 'register.cjs')}` };
  for (const k of Object.keys(env)) if (k.startsWith('BUNDLE_LOCKFILE_') && k !== 'BUNDLE_LOCKFILE_STRICT') delete env[k];
  const cjs = spawnSync(process.execPath, ['cjs.cjs'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(cjs.stdout, 'bundle-lockfile bundle-lockfile bundle-lockfile \n', cjs.stderr); // (buildSync takes no plugins: none added)
  const esm = spawnSync(process.execPath, ['esm.mjs'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(esm.stdout.trim(), 'bundle-lockfile bundle-lockfile bundle-lockfile', esm.stderr);
  const off = spawnSync(process.execPath, ['esm.mjs'], { cwd: root, env: { ...env, BUNDLE_LOCKFILE_DISABLE: 'esbuild' }, encoding: 'utf8' });
  assert.equal(off.stdout, '  \n', off.stderr);
});

test('bundle-lockfile-from-metafile: the lockfile of an output from an esbuild metafile; what it cannot read fails (STRICT=0: a warning)', () => {
  const CLI = J(TEST, '../bin/bundle-lockfile-from-metafile');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/b/package.json': { name: 'b', version: '2.0.0' },
    'node_modules/esbuild/package.json': { name: 'esbuild', version: '0.28.2', license: 'MIT' }, 'tools/bun/package.json': { name: 'bun', version: '1.4.2' },
    'node_modules/nopj/i.js': '', 'dist/main.js': 'x', 'dist/assets/f.woff2': 'f',
    'meta.json': { inputs: {}, outputs: { 'dist/main.js': { inputs: { 'node_modules/a/i.js': { bytesInOutput: 1 }, '(disabled):node_modules/b/i.js': { bytesInOutput: 9 } } },
      'dist/assets/f.woff2': { inputs: { 'node_modules/b/f.woff2': { bytesInOutput: 1 } } } } },
    'bad.json': { outputs: { 'dist/main.js': { inputs: { 'node_modules/nopj/i.js': { bytesInOutput: 1 } } } } },
    'none.json': { inputs: {} }, 'broken.json': '{"BUNDLE_LOCKFILE_EXPORT_DIR": ',
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BUNDLE_LOCKFILE_') && k !== 'NODE_OPTIONS'));
  const run = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' });
  const ok = run(['meta.json']);
  assert.equal(ok.status, 0, ok.stderr);
  const lock = JSON.parse(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')); // dist/: the directory of all outputs
  // b: the font's package (not its disabled module); esbuild: the one the working directory resolves, for the
  // JavaScript output (its runtime helpers)
  assert.deepEqual(lockedNames(JSON.stringify(lock)), ['a', 'b', 'esbuild']);
  const w = lock['bundle-lockfile'].writers[0];
  assert.deepEqual([...w.files].sort(), ['../assets/f.woff2', '../main.js']);
  assert.deepEqual(w.via.runtime.map(i => w.packages[i]), ['node_modules/esbuild']);
  assert.deepEqual(w.bundler, { name: 'esbuild', version: '0.28.2' }); // (the bundler that wrote it)
  // --bundler: another package (its directory); none: none
  assert.equal(run(['meta.json', '--bundler', 'tools/bun']).status, 0);
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['a', 'b', 'bun']);
  assert.equal(run(['meta.json', '--bundler', 'none']).status, 0);
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['a', 'b']);
  // a directory without a package.json: fails
  const nob = run(['meta.json', '--bundler', 'nowhere']);
  assert.equal(nob.status, 1);
  assert.match(nob.stderr, /nowhere has no package\.json: the bundler that wrote \S*meta\.json is not known/);
  const out = run(['meta.json', '--out', 'elsewhere', '--working-dir', root]);
  assert.equal(out.status, 0, out.stderr);
  assert.ok(fs.existsSync(J(root, 'elsewhere', LOCK)));
  // run in another directory than the build's (the metafile's paths are relative to that): fails, writes nothing
  fs.mkdirSync(J(root, 'sub'));
  const inSub = (extra = {}, args = []) => spawnSync(process.execPath, [CLI, '../meta.json', ...args], { cwd: J(root, 'sub'), env: { ...env, ...extra }, encoding: 'utf8' });
  const elsewhere = inSub();
  assert.equal(elsewhere.status, 1, elsewhere.stderr);
  assert.match(elsewhere.stderr, /none of the output files of \S*meta\.json is there \(its paths relative to \S*sub\): run it in the build's working directory, or name that with --working-dir/);
  const laxElsewhere = inSub({ BUNDLE_LOCKFILE_STRICT: '0' });
  assert.equal(laxElsewhere.status, 0, laxElsewhere.stderr);
  assert.match(laxElsewhere.stderr, /WARNING: none of the output files/);
  assert.equal(fs.existsSync(J(root, 'sub/dist')), false);
  assert.equal(inSub({}, ['--working-dir', root]).status, 0); // (named: fine)
  // a package without a package.json, a file that is no metafile, none at all, a misspelled setting: exit code 1
  for (const [args, re, extra] of [[['bad.json'], /no package\.json with name and version in \S*nopj/], [['none.json'], /none\.json is no esbuild metafile/],
    [['missing.json'], /could not read the metafile \S*missing\.json/], [['meta.json'], /BUNDLE_LOCKFILE_EXPORTDIR is set/, { BUNDLE_LOCKFILE_EXPORTDIR: '/x' }],
    // a settings file that is missing or broken: its settings would not apply
    [['meta.json'], /could not read the settings file \S*nonexistent\.json/, { BUNDLE_LOCKFILE_CONFIG: J(root, 'nonexistent.json') }],
    [['meta.json'], /could not read the settings file \S*broken\.json/, { BUNDLE_LOCKFILE_CONFIG: J(root, 'broken.json') }]]) {
    const r = run(args, extra);
    assert.equal(r.status, 1, `${args}: ${r.stderr}`);
    assert.match(r.stderr, /\[bundle-lockfile\] ERROR: bundle-lockfile: the lockfile would be missing or incomplete/);
    assert.match(r.stderr, re);
    const lax = run(args, { ...extra, BUNDLE_LOCKFILE_STRICT: '0' });
    assert.equal(lax.status, 0, lax.stderr);
    assert.match(lax.stderr, /WARNING/);
  }
  assert.equal(run([]).status, 2);
  assert.equal(run(['meta.json', '--out']).status, 2);
  // outputs in no directory but the root (/a/x.js, /b/y.js): not written there - fails, --out names the directory
  fs.writeFileSync(J(root, 'apart.json'), JSON.stringify({ outputs: { '/bl-nowhere-a/x.js': { inputs: {} }, '/bl-nowhere-b/y.js': { inputs: {} } } }));
  const apart = run(['apart.json', '--bundler', 'none']);
  assert.equal(apart.status, 1, apart.stderr);
  assert.match(apart.stderr, /the outputs of \S*apart\.json are in no directory but the root: name the output directory with --out/);
});
