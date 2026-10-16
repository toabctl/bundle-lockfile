'use strict';
// Unit tests of Node's module loading: the CommonJS and ES-module hooks, the wrappers of entry modules.
// All unit tests: node --test test/unit/*.test.cjs (see test/README.md)
// (helpers.cjs first: see there)
const {
  strictEnv, nodeWith, SRC, J, pathToFileURLHref, project, node, cjsHookScript, cjsEnv,
} = require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const webpackAdapter = require('../../src/adapters/webpack.cjs');
const rspackAdapter = require('../../src/adapters/rspack.cjs');

test('hooks: a throwing adapter is reported and does not break require()', () => {
  const root = project({ 'lib.js': "module.exports = (a, b) => a + '/' + b;" });
  const script = `const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
    hooks.register({ name: 'boom', onCjsLoad() { throw new Error('boom'); } });
    hooks.install(); hooks.install();
    console.log(require(${JSON.stringify(J(root, 'lib.js'))})('a', 'b'));`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'a/b');
  assert.match(r.stderr, /\[bundle-lockfile\] WARNING: boom adapter failed while inspecting \S*lib\.js/);
});

test('esm-wrap: finds the entry, its exports, and wraps its functions; an entry with none of them is reported when it runs', () => {
  const esmWrap = require('../../src/esm-wrap.cjs');
  const rollupEntry = { id: 'rollup', suffixes: ['/rollup/dist/es/rollup.js'], wrap: ['rollup', 'watch'] };
  assert.equal(esmWrap.match('file:///p/node_modules/rollup/dist/es/rollup.js', [rollupEntry]), rollupEntry);
  assert.equal(esmWrap.match('file:///p/node_modules/rollup/dist/es/rollup.js?bundle-lockfile-real', [rollupEntry]), null); // the real one
  assert.equal(esmWrap.match('node:fs', [rollupEntry]), null);
  // rollup 4's and rolldown 1's entries
  assert.deepEqual([...esmWrap.exportedNames("export { VERSION, defineConfig, rollup, watch } from './shared/node-entry.js';")], ['VERSION', 'defineConfig', 'rollup', 'watch']);
  assert.deepEqual([...esmWrap.exportedNames('export { RUNTIME_MODULE_ID, RolldownMagicString, VERSION, build, defineConfig, rolldown as rolldown, watch };')],
    ['RUNTIME_MODULE_ID', 'RolldownMagicString', 'VERSION', 'build', 'defineConfig', 'rolldown', 'watch']);
  assert.deepEqual([...esmWrap.exportedNames('export function rollup() {}\nexport const x = 1;\nexport default 2;')], ['rollup', 'x', 'default']);
  // exports in comments do not count (a default the module does not have would not link), in strings they are kept
  const commented = "/**\n * export default rollup;\n */\n// export { a as default }\nconst u = 'http://x/*'; /* export default */ export { rollup }; // export default\n";
  assert.deepEqual([...esmWrap.exportedNames(commented)], ['rollup']);
  assert.equal(esmWrap.source('file:///r.js', commented, { id: 'rollup', wrap: ['rollup'] }).includes('default'), false);
  assert.deepEqual([...esmWrap.exportedNames("const s = '// x';\nexport { a as default };")], ['default']);
  assert.deepEqual([...esmWrap.exportedNames('export { a as "default", b as "module.exports" };')], ['default']); // (string names, ES2022)
  const src = esmWrap.source('file:///p/rollup.js', "export { VERSION, rollup } from './x.js';", rollupEntry);
  assert.match(src, /export \* from "file:\/\/\/p\/rollup\.js\?bundle-lockfile-real";/);
  assert.match(src, /export const rollup = api \? api\.wrap\("rollup", "rollup", real\.rollup, "file:\/\/\/p\/rollup\.js"\) : real\.rollup;/);
  // every function to wrap, whatever the source says (an `export *` of it is not in the source): one the module does not
  // have stays undefined; whether it had any, the wrapper tells the hooks when it runs
  assert.match(src, /export const watch = api \? api\.wrap\("rollup", "watch", real\.watch, "file:\/\/\/p\/rollup\.js"\) : real\.watch;/);
  assert.match(src, /api\.found\("rollup", "file:\/\/\/p\/rollup\.js", \["rollup","watch"\], \["rollup","watch"\]\.some\(n => typeof real\[n\] === 'function'\)\)/);
  const star = esmWrap.source('file:///p/rollup.js', "export * from './shared/x.js';", rollupEntry);
  assert.match(star, /export const rollup = api \? api\.wrap/);
});

test('esm-wrap: an entry module of a version the adapter does not know fails when it is imported (BUNDLE_LOCKFILE_STRICT=0: a warning)', () => {
  // hooks.cjs's found(), as the wrapper calls it: none of the functions to wrap is in the module
  const script = `const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
    process.env.BUNDLE_LOCKFILE_ESM_HOOKS = 'off';
    hooks.register({ name: 'r', esmEntries: [{ id: 'rollup', suffixes: ['/x.js'], wrap: ['rollup'] }], esmWrap: () => null });
    hooks.install();
    const api = globalThis[Symbol.for('bundle-lockfile.esm')];
    api.found('rollup', 'file:///p/rollup.js', ['rollup', 'watch'], true);
    try { api.found('rollup', 'file:///p/rollup.js', ['rollup', 'watch'], false); console.log('loaded'); } catch (e) { console.log('failed:', e.message); }`;
  const run = (v) => { const env = { ...process.env }; if (v === undefined) delete env.BUNDLE_LOCKFILE_STRICT; else env.BUNDLE_LOCKFILE_STRICT = v;
    return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env }); };
  const strict = run(undefined);
  assert.equal(strict.status, 0, strict.stderr);
  assert.match(strict.stdout, /^failed: bundle-lockfile: the lockfile would be missing or incomplete .*\n {2}file:\/\/\/p\/rollup\.js exports none of rollup, watch: a version of rollup bundle-lockfile does not know, whose builds would write no lockfile/);
  const off = run('0');
  assert.equal(off.stdout.trim(), 'loaded');
  assert.match(off.stderr, /WARNING: file:\/\/\/p\/rollup\.js exports none of rollup, watch/);
});

test('hooks: in-thread ESM hooks only on Node >= 22.22.3 / 24.11.1 / 25.1 (nodejs/node#59929); loader-thread hooks only in bundler processes', () => {
  const hooks = require('../../src/hooks.cjs');
  for (const [v, safe] of [['20.19.5', false], ['22.15.1', false], ['22.22.2', false], ['22.22.3', true], ['22.23.2', true], ['23.11.1', false],
    ['24.10.0', false], ['24.11.0', false], ['24.11.1', true], ['24.12.0', true], ['25.0.0', false], ['25.1.0', true], ['26.0.0', true], ['v24.21.0', true], ['v22.22.3', true]]) {
    assert.equal(hooks.syncHooksSafe(v), safe, v);
  }
  const root = project({
    'node_modules/vite/package.json': { name: 'vite', version: '8.3.3' }, 'node_modules/vite/bin/vite.js': '',
    'node_modules/headlamp-plugin/package.json': { name: 'headlamp-plugin', version: '1.0.0', dependencies: { vite: '^6' } }, 'node_modules/headlamp-plugin/bin/h.js': '',
    'node_modules/npm/package.json': { name: 'npm', version: '11.0.0', dependencies: { semver: '*' } }, 'node_modules/npm/bin/npm-cli.js': '',
    'package.json': { name: 'app', version: '1.0.0', devDependencies: { vite: '8.3.3' } }, 'scripts/build.mjs': '',
    'scripts/package.json': { type: 'module' }, // no name or dependencies: the project's package.json above counts
    'other/package.json': { name: 'other', version: '1.0.0', dependencies: { lodash: '*' } }, 'other/x.js': '',
  });
  const P = ['vite', 'rollup', 'rolldown'];
  const cwd = project({}); // a working directory without any of them installed (see the next test for one with)
  assert.equal(hooks.bundlerProcess(P, J(root, 'node_modules/vite/bin/vite.js'), cwd), true);       // the package itself
  assert.equal(hooks.bundlerProcess(P, J(root, 'node_modules/headlamp-plugin/bin/h.js'), cwd), true); // a tool depending on it
  assert.equal(hooks.bundlerProcess(P, J(root, 'scripts/build.mjs'), cwd), true);                    // a build script of a project using it
  assert.equal(hooks.bundlerProcess(P, J(root, 'node_modules/npm/bin/npm-cli.js'), cwd), false);
  assert.equal(hooks.bundlerProcess(P, J(root, 'other/x.js'), cwd), false);
  assert.equal(hooks.bundlerProcess(P, undefined, cwd), false);
});

test('hooks: a build in a worker thread gets the ESM hooks too; Node\'s own loader thread none', () => {
  // vite build from a worker_threads Worker: the main thread's loader-thread hooks do not reach the worker, which runs
  // the preload again and must register its own
  const root = project({
    'node_modules/rolldown/package.json': { name: 'rolldown', version: '1.2.13', type: 'module', exports: { '.': './dist/index.mjs' } },
    'node_modules/rolldown/dist/index.mjs': `const rolldown = async (o) => [].concat(o.plugins || []).flat().map(p => p.name);
      const VERSION = '1.2.13';
      export { VERSION, rolldown };`,
    'package.json': { name: 'app', version: '1.0.0', type: 'module', dependencies: { rolldown: '1.2.13' } },
    'build.mjs': `import { rolldown } from 'rolldown';
      import { parentPort } from 'node:worker_threads';
      parentPort.postMessage(await rolldown({ plugins: [{ name: 'x' }] }));`,
    'main.mjs': `import { Worker } from 'node:worker_threads';
      const w = new Worker(new URL('./build.mjs', import.meta.url));
      w.on('message', (m) => { console.log(JSON.stringify(m)); });`,
  });
  const run = (env) => {
    const r = spawnSync(process.execPath, ['--require', J(SRC, 'register.cjs'), J(root, 'main.mjs')],
      { cwd: root, env: { ...process.env, BUNDLE_LOCKFILE_DEBUG: '1', ...env }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return { names: JSON.parse(r.stdout.trim().split('\n').pop()), modes: r.stderr.match(/ESM hooks: \w+/g) };
  };
  const modes = ['async', undefined];
  if (typeof require('module').registerHooks === 'function') modes.push('sync');
  for (const mode of modes) {
    const got = run(mode ? { BUNDLE_LOCKFILE_ESM_HOOKS: mode } : {});
    assert.deepEqual(got.names, ['x', 'bundle-lockfile'], String(mode));
    // the main thread and the worker install them; Node's loader threads (one per thread with loader-thread hooks)
    // run the preload too, and do nothing (Node.js 20 and 22 before 22.14 do not mark them: no parentPort)
    assert.equal(got.modes.length, 2, `${mode}: ${got.modes}`);
    assert.equal(new Set(got.modes).size, 1, `${mode}: ${got.modes}`);
  }
});

test('esm-wrap: the real entry module sees its own file through import.meta (the marked URL), and a cycle back into the entry reads the wrapper', () => {
  // The wrapper imports the real module as <url>?bundle-lockfile-real: import.meta.url has that query, which Node drops
  // when it makes a path (fileURLToPath, import.meta.filename/dirname, createRequire, new URL(<relative>, ...)).
  // A module of the entry's own graph that imports the entry back gets the wrapper, whose exports exist only once the
  // real module has run: read during that (at its top level) they throw (TDZ) where a function declaration of the
  // entry itself would not - documented (docs/internals.md); no wrapped entry has such a cycle (rollup 4.64.6, rolldown
  // 1.2.13, @rspack/core 2.2.9). Read later, they are the wrapped functions.
  const root = project({
    'node_modules/rolldown/package.json': { name: 'rolldown', version: '1.2.13', type: 'module', exports: { '.': './dist/index.mjs' } },
    'node_modules/rolldown/dist/helper.cjs': 'module.exports = 42;',
    'node_modules/rolldown/dist/late.mjs': `import { rolldown } from 'rolldown';
      let early; try { early = typeof rolldown; } catch (e) { early = e.constructor.name; }
      export { early }; export const later = () => rolldown;`,
    'node_modules/rolldown/dist/index.mjs': `import { createRequire } from 'node:module';
      import { fileURLToPath } from 'node:url';
      import { early, later } from './late.mjs';
      export async function rolldown(o) { return [].concat(o.plugins || []).flat().map(p => p.name); }
      export const meta = { url: import.meta.url, path: fileURLToPath(import.meta.url), filename: import.meta.filename, dirname: import.meta.dirname,
        sibling: new URL('./helper.cjs', import.meta.url).href, required: createRequire(import.meta.url)('./helper.cjs') };
      export const cycle = { early, later };
      export const VERSION = '1.2.13';`,
    'package.json': { name: 'app', version: '1.0.0', type: 'module', dependencies: { rolldown: '1.2.13' } },
    'build.mjs': `import { meta, cycle } from 'rolldown';
      console.log(JSON.stringify({ meta, early: cycle.early, later: await cycle.later()({ plugins: [{ name: 'x' }] }) }));`,
  });
  const file = J(fs.realpathSync(root), 'node_modules/rolldown/dist/index.mjs');
  const run = (mode) => {
    const r = spawnSync(process.execPath, ['--require', J(SRC, 'register.cjs'), J(root, 'build.mjs')],
      { cwd: root, env: { ...process.env, BUNDLE_LOCKFILE_ESM_HOOKS: mode }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  const href = pathToFileURLHref(file), sibling = pathToFileURLHref(J(path.dirname(file), 'helper.cjs'));
  const off = run('off');
  assert.deepEqual(off, { meta: { url: href, path: file, filename: file, dirname: path.dirname(file), sibling, required: 42 }, early: 'function', later: ['x'] });
  const modes = ['async'];
  if (typeof require('module').registerHooks === 'function') modes.push('sync');
  for (const mode of modes) {
    assert.deepEqual(run(mode), { meta: { ...off.meta, url: `${href}?bundle-lockfile-real` }, early: 'ReferenceError', later: ['x', 'bundle-lockfile'] }, mode);
  }
});

test('hooks: a CommonJS bundler whose source another loader hook provides is patched, although Node loads it without Module._load', () => {
  // Yarn Plug'n'Play's loader returns the source of CommonJS files in its zip cache on Node versions whose fstat fails on
  // their file descriptors (22.22.3+, 24.15, 25.7+, 26.0): Node then evaluates them, and all they require, with a
  // require() of its own. This loader does the same for a fake webpack; webpack-cli 7 import()s webpack
  const compiler = 'class Compiler { compile() {} run() {} watch() {} newCompilation() {} isChild() { return false; } }\nmodule.exports = Compiler;\n';
  const root = project({
    'node_modules/webpack/package.json': { name: 'webpack', version: '5.0.0', main: 'lib/index.js' },
    'node_modules/webpack/lib/index.js': "const Compiler = require('./Compiler');\nmodule.exports = { Compiler };\n",
    'node_modules/webpack/lib/Compiler.js': compiler,
    'loader.mjs': `import fs from 'node:fs';
      export async function load(url, context, nextLoad) {
        if (!url.includes('/node_modules/webpack/')) return nextLoad(url, context);
        return { format: 'commonjs', source: fs.readFileSync(new URL(url), 'utf8'), shortCircuit: true };
      }`,
    'build.cjs': `const Module = require('module'), seen = [];
      const load = Module._load;
      Module._load = function (request) { if (request.includes('Compiler')) seen.push(request); return load.apply(this, arguments); };
      import('webpack').then(w => console.log(JSON.stringify({ viaModuleLoad: seen.length > 0,
        patched: !!w.default.Compiler.prototype[Symbol.for('bundle-lockfile.webpack.patched')] })));`,
  });
  const run = (env) => {
    const r = spawnSync(process.execPath, ['--no-warnings', '--require', J(SRC, 'register.cjs'), '--experimental-loader', pathToFileURLHref(J(root, 'loader.mjs')), J(root, 'build.cjs')],
      { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  const modes = ['auto', 'async']; // auto: the other loader makes it a process for the loader-thread hooks (Node < 22.22.3 / 24.11.1)
  if (typeof require('module').registerHooks === 'function' && require(J(SRC, 'hooks.cjs')).syncHooksSafe(process.versions.node)) modes.push('sync');
  for (const mode of modes) assert.deepEqual(run({ BUNDLE_LOCKFILE_ESM_HOOKS: mode }), { viaModuleLoad: false, patched: true }, mode);
  assert.deepEqual(run({ BUNDLE_LOCKFILE_ESM_HOOKS: 'off' }), { viaModuleLoad: false, patched: false }); // the case the hooks are for
  // the line is appended once, only to the source a hook provided, of the files an adapter patches
  const { cjsSource, CJS_LOADED } = require(J(SRC, 'esm-wrap.cjs'));
  const url = pathToFileURLHref(J(root, 'node_modules/webpack/lib/Compiler.js')), files = [/[\\/]webpack[\\/]lib[\\/]Compiler\.js$/];
  assert.equal(cjsSource(url, { format: 'commonjs', source: compiler }, files), compiler + CJS_LOADED);
  assert.equal(cjsSource(url, { format: 'commonjs', source: Buffer.from(compiler) }, files), compiler + CJS_LOADED);
  assert.equal(cjsSource(url, { format: 'commonjs', source: compiler + CJS_LOADED }, files), null);
  assert.equal(cjsSource(url, { format: 'commonjs', source: null }, files), null); // Node loads it through Module._load
  assert.equal(cjsSource(url, { format: 'module', source: compiler }, files), null);
  assert.equal(cjsSource(pathToFileURLHref(J(root, 'node_modules/webpack/lib/index.js')), { format: 'commonjs', source: 'x' }, files), null);
});

test('hooks: another loader-thread hook is recognized in NODE_OPTIONS and the command line', () => {
  const { otherLoader } = require(J(SRC, 'hooks.cjs'));
  assert.equal(otherLoader(['--require /p/.pnp.cjs --experimental-loader file:///p/.pnp.loader.mjs']), true); // Yarn Plug'n'Play
  assert.equal(otherLoader(['', '--import=tsx']), true);
  assert.equal(otherLoader(['--loader ./l.mjs']), true);
  assert.equal(otherLoader(['--max-old-space-size=4096 --require /x/register.cjs', '--inspect']), false);
  assert.equal(otherLoader(['--require /x/--import-helper.cjs']), false);
});

test('hooks: a circular require() makes Node print no warning (no adapter reads properties of unrelated modules)', () => {
  const root = project({ 'a.js': "exports.a = 1; require('./b');", 'b.js': "const a = require('./a'); a.a; module.exports = {};" });
  const r = node(['--require', J(SRC, 'register.cjs'), J(root, 'a.js')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  // the adapters look at an object only once its request is one of theirs
  const read = [];
  const exp = new Proxy({}, { get: (t, k) => { read.push(k); return undefined; }, has: (t, k) => { read.push(k); return false; } });
  for (const a of [webpackAdapter, require('../../src/adapters/rollup.cjs')]) a.onCjsLoad(exp, './b', () => J(root, 'b.js'));
  assert.deepEqual(read, []);
});

test('hooks: the ESM hook mode - forced (any case), or by Node version and process', () => {
  const hooks = require('../../src/hooks.cjs');
  const Module = require('module');
  const saved = process.env.BUNDLE_LOCKFILE_ESM_HOOKS;
  const mode = (v) => { if (v === undefined) delete process.env.BUNDLE_LOCKFILE_ESM_HOOKS; else process.env.BUNDLE_LOCKFILE_ESM_HOOKS = v; return hooks.esmMode(['vite']); };
  try {
    const sync = typeof Module.registerHooks === 'function', async = typeof Module.register === 'function';
    assert.equal(mode('off'), 'off');
    assert.equal(mode(' OFF '), 'off');
    assert.equal(mode('sync'), sync ? 'sync' : 'off');
    assert.equal(mode('Async'), async ? 'async' : 'off');
    // auto: in-thread where safe; else loader-thread hooks only in bundler processes (this one is none) or next to
    // another loader-thread hook (none here)
    const auto = sync && hooks.syncHooksSafe(process.versions.node) ? 'sync' : 'off';
    assert.equal(mode(undefined), auto);
    assert.equal(mode('auto'), auto);
    assert.equal(mode('nonsense'), auto);
  } finally { if (saved === undefined) delete process.env.BUNDLE_LOCKFILE_ESM_HOOKS; else process.env.BUNDLE_LOCKFILE_ESM_HOOKS = saved; }
});

test('hooks: an adapter that throws while wrapping an ESM entry is reported, and the function is used as it is', () => {
  const script = `const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
    process.env.BUNDLE_LOCKFILE_ESM_HOOKS = 'off'; // the wrap API only, no hooks
    hooks.register({ name: 'boom', esmEntries: [{ id: 'x', suffixes: ['/x.js'], wrap: ['f'] }], esmWrap() { throw new Error('boom'); } });
    hooks.install();
    const f = () => 42;
    console.log(globalThis[Symbol.for('bundle-lockfile.esm')].wrap('x', 'f', f) === f);`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'true');
  assert.match(r.stderr, /\[bundle-lockfile\] WARNING: boom adapter failed to wrap x f/);
});

test('esm-wrap: only ES modules are wrapped (rspack 1\'s CommonJS file at rspack 2\'s path goes on to cjsSource)', () => {
  const { transform, CJS_LOADED } = require('../../src/esm-wrap.cjs');
  const esmEntries = rspackAdapter.esmEntries, cjsFiles = rspackAdapter.cjsFiles;
  const url = 'file:///p/node_modules/@rspack/core/dist/index.js';
  const cjs = transform(url, { format: 'commonjs', source: 'module.exports = rspack;' }, esmEntries, cjsFiles);
  assert.equal(cjs.source, `module.exports = rspack;${CJS_LOADED}`);
  // rspack 2's entry (its export statements; the bundle is 700 KB): Compiler and the default wrapped, "module.exports" re-exported by export *
  const src = 'var src_rspack = function(){};\nexport default src_rspack;\nexport { Compiler_Compiler as Compiler, Compilation, MultiCompiler, src_rspack as "module.exports", src_rspack as rspack };\n';
  const esm = transform(url, { format: 'module', source: src }, esmEntries, cjsFiles);
  assert.equal(esm.format, 'module');
  assert.match(esm.source, /export \* from "file:\/\/\/p\/node_modules\/@rspack\/core\/dist\/index\.js\?bundle-lockfile-real";/);
  assert.match(esm.source, /export \{ default \} from/);
  assert.match(esm.source, /export const Compiler = api \? api\.wrap\("rspack", "Compiler", real\.Compiler, "file:\/\/\/p\/node_modules\/@rspack\/core\/dist\/index\.js"\) : real\.Compiler;/);
  assert.doesNotMatch(esm.source, /module\.exports/);
});

test('esm-wrap: withoutComments gives what the character-by-character version gave', () => {
  const { withoutComments } = require('../../src/esm-wrap.cjs');
  const reference = (src) => { // the implementation before (one character at a time)
    let out = '', i = 0;
    while (i < src.length) {
      const c = src[i], next = src[i + 1];
      if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; out += ' '; continue; }
      if (c === '/' && next === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; out += ' '; continue; }
      if (c === '"' || c === "'" || c === '`') { let j = i + 1; while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1; out += src.slice(i, j + 1); i = j + 1; continue; }
      out += c; i++;
    }
    return out;
  };
  const samples = ['', 'a', '//', '/*', '/* x */', 'a // c\nb', 'a /* c */ b /* unterminated', '"// no" // yes', "'a\\'b' /* c */", '`t ${x} // in` // out',
    'export { a } /* export { b } */ // export { c }\nexport default x', '"unterminated', 'x = "\\\\"; // c', 'a/b/c', 'a / * b'];
  for (const f of ['esm-wrap.cjs', 'hooks.cjs', 'adapters/rollup.cjs', 'adapters/webpack-family.cjs', 'esm-loader.mjs']) samples.push(fs.readFileSync(J(SRC, f), 'utf8'));
  for (const s of samples) assert.equal(withoutComments(s), reference(s), JSON.stringify(s.slice(0, 40)));
});

test('esm-wrap: regular expression literals and the code in template literals start no comment or string', () => {
  const { withoutComments, exportedNames } = require('../../src/esm-wrap.cjs');
  const hasDefault = (src) => exportedNames(src).has('default');
  // by the ECMAScript grammar (written by hand): the module has a default export, or none
  const cases = [
    ['const r = /\\/*/; export default 1;\n', true], // \/* in a regular expression: no comment
    ['const r = /[/*]/; export default 1;\n', true], // /* in a character class
    ['if (/\\/\\*/.test(a)) b(); export { c as default };\n', true],
    ["const r = /'/;\n/* export default x */\nexport const a = 1;\nconst s = 'q';\n", false], // ' in a regular expression: no string
    ['const r = /"/g; // export default x\nexport { a };\n', false],
    ['function f(s) { return /\'/.test(s) } // export default f\nexport { f };\n', false],
    ['const r = x => typeof /`/; /* export default */ export { r };\n', false],
    ['const t = `${\'`\'}`; /* export default x */ export const a = 1;\n', false], // a ` in a string in a ${}
    ['const t = `a${`b${c}`}`; // export default t\nexport { t };\n', false], // nested template literals
    ['const t = `${{ a: 1 }.a} // kept`; export default t;\n', true], // braces in a ${}; // in a template is no comment
    ['const t = `${f(() => { return 1 })}`; /* export default */ export { t };\n', false],
    ['const x = a / b; /* export default q */ export { c };\n', false], // division after a name
    ['const x = (a) / b / c; /* export default */ export { x };\n', false], // after )
    ['const x = a[0] / 2 /* export default */; export { x };\n', false], // after ]
    ['i++ / 2; /* export default */ export { i };\n', false], // after x++
    ['const x = 10 / 2; // export default\nexport { x };\n', false], // after a number
    ['const x = o.in / 2; /* export default */ export { x };\n', false], // a property named like a keyword
    ["const s = 'a' / 2; /* export default */ export { s };\n", false], // after a string
    // in literals: code a bundle generates, no export of its own
    ['const s = "export default";\nexport { a };\n', false],
    ["const s = 'export { x as default }'; export { a };\n", false],
    ['const t = `export default ${x}`; export { a };\n', false],
    ['const t = `${`export default`}`; export { a };\n', false],
    ['const r = /export default/; export { a };\n', false],
    ["const s = 'a'; export default s;\n", true],
    ['const t = `${a}`; export { t as default };\n', true],
  ];
  for (const [src, want] of cases) assert.equal(hasDefault(src), want, src);
  // the names of string literals do not count (a string-named export: `export *` brings it)
  assert.deepEqual([...exportedNames('export { a as "module.exports", b };')], ['b']);
  // comments in the code of a ${} go, as anywhere else in code
  assert.equal(withoutComments('`a${ b /* c */ }d`'), '`a${ b   }d`');
  assert.equal(withoutComments('x = /\\/\\/ no/; // yes'), 'x = /\\/\\/ no/;  ');
  // a / that cannot be a regular expression (no end on its line) divides
  assert.equal(withoutComments('a = (/ 2\n// c\n)'), 'a = (/ 2\n \n)');
});

test('hooks: a module whose exports are a getter (a new object every time) loads as without bundle-lockfile', () => {
  const root = project({ 'm.cjs': "Object.defineProperty(module, 'exports', { get: () => ({ x: 1 }), configurable: true }); module.loaded;", 'main.cjs': "console.log(require('./m.cjs').x);" });
  const env = { ...strictEnv(undefined), NODE_OPTIONS: `--require ${J(SRC, 'register.cjs')}` };
  const r = spawnSync(process.execPath, ['main.cjs'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '1');
});

test('hooks: a package\'s require() of a deprecated built-in module warns as without bundle-lockfile (Node decides by the caller)', () => {
  // punycode (DEP0040): Node warns only when the first frame that is not its own is outside node_modules - the
  // Module._load wrapper must not be that frame. Builds that exit on any warning (OpenSearch Dashboards') failed.
  const root = project({ 'node_modules/a/index.js': "require('punycode'); module.exports = 1;", 'app.js': "require('punycode');",
    'main.js': "process.on('warning', (w) => console.log('warning', w.code)); require(process.argv[2]); setTimeout(() => {}, 20);" });
  const run = (target, preload) => spawnSync(process.execPath, [...(preload ? ['--require', J(SRC, 'register.cjs')] : []), J(root, 'main.js'), target],
    { encoding: 'utf8', cwd: root, env: { ...process.env, NODE_OPTIONS: '' } }).stdout.trim();
  for (const target of ['a', J(root, 'app.js')]) assert.equal(run(target, true), run(target, false), target);
  // where this Node.js tells the callers apart (it warns for first-party code only: 24 and later, and 22 but for some
  // releases - 22.13.1 and 22.22.2 warn for the package too, with or without bundle-lockfile), so does it with it
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 24 || (major === 22 && run('a', false) === '')) {
    assert.equal(run('a', true), '');
    assert.match(run(J(root, 'app.js'), true), /warning DEP0040/);
  }
});

test('hooks: a CommonJS bundler that another loader compiles itself (tsx: Module.prototype._compile, not the handler before it) is patched', () => {
  const root = project({
    'node_modules/webpack/package.json': { name: 'webpack', version: '5.111.1' },
    'node_modules/webpack/lib/Compiler.js': 'module.exports = class Compiler { compile() {} run() {} watch() {} newCompilation() {} isChild() { return false; } };',
    // tsx's handler for .js: reads the file and compiles it, without the handler it replaced
    'tsx-like.cjs': "const Module = require('module'), fs = require('fs'); Module._extensions['.js'] = function (module, filename) { module._compile(fs.readFileSync(filename, 'utf8'), filename); };",
  });
  const script = `require(${JSON.stringify(J(root, 'tsx-like.cjs'))});
    const C = require(${JSON.stringify(J(root, 'node_modules/webpack/lib/Compiler.js'))});
    console.log(C.prototype[Symbol.for('bundle-lockfile.webpack.patched')] === true);`;
  const r = nodeWith({ ...strictEnv(undefined), NODE_OPTIONS: '' }, ['--require', J(SRC, 'register.cjs'), '-e', script]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'true');
});

test('hooks: an adapter that fails while inspecting modules warns once per process', () => {
  const root = project({ 'a.js': 'module.exports = 1;', 'b.js': 'module.exports = 2;' });
  const script = `const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
    hooks.register({ name: 'boom', onCjsLoad() { throw new Error('boom'); } });
    hooks.install();
    console.log(require(${JSON.stringify(J(root, 'a.js'))}) + require(${JSON.stringify(J(root, 'b.js'))}));`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '3');
  assert.equal((r.stderr.match(/WARNING: boom adapter failed while inspecting/g) || []).length, 1, r.stderr);
});

test('hooks: a process in a project that has a bundler installed is a bundler process (nuxi, storybook: their bundler comes through a dependency)', () => {
  const hooks = require('../../src/hooks.cjs');
  const root = project({
    'node_modules/vite/package.json': { name: 'vite', version: '8.3.3' },
    'node_modules/nuxi/package.json': { name: 'nuxi', version: '3.0.0', dependencies: { citty: '*' } }, 'node_modules/nuxi/bin/nuxi.mjs': '',
    'app/package.json': { name: 'app', dependencies: { nuxt: '*' } },
  });
  const other = project({ 'node_modules/npm/package.json': { name: 'npm', version: '11.0.0' }, 'node_modules/npm/bin/npm-cli.js': '' });
  const P = ['vite', 'rollup', 'rolldown'];
  assert.equal(hooks.bundlerProcess(P, J(root, 'node_modules/nuxi/bin/nuxi.mjs'), J(root, 'app')), true);
  assert.equal(hooks.bundlerProcess(P, J(other, 'node_modules/npm/bin/npm-cli.js'), other), false);
});

test('hooks: pnpm and bun (isolated linker) link a dependency of a dependency only in their hidden node_modules: still a bundler process', () => {
  const hooks = require('../../src/hooks.cjs');
  const P = ['vite', 'rollup', 'rolldown'];
  // pnpm 10 / bun 1.4: `pnpm nuxi build` - nuxi names no bundler, nuxt depends on vite, which is in no other node_modules
  for (const hidden of ['.pnpm', '.bun']) {
    const store = hidden === '.pnpm' ? 'vite@8.3.4' : 'vite@8.3.4+0123abcd';
    const root = project({
      [`node_modules/${hidden}/${store}/node_modules/vite/package.json`]: { name: 'vite', version: '8.3.4' },
      [`node_modules/${hidden}/node_modules/vite/package.json`]: { name: 'vite', version: '8.3.4' },
      [`node_modules/${hidden}/nuxi@4.0.1/node_modules/nuxi/package.json`]: { name: 'nuxi', version: '4.0.1', dependencies: { citty: '*' } },
      [`node_modules/${hidden}/nuxi@4.0.1/node_modules/nuxi/bin/nuxi.mjs`]: '',
      'package.json': { name: 'app', dependencies: { nuxt: '*', nuxi: '*' } },
    });
    assert.equal(hooks.bundlerProcess(P, J(root, `node_modules/${hidden}/nuxi@4.0.1/node_modules/nuxi/bin/nuxi.mjs`), root), true, hidden);
    // the hidden directory of another layout, or a package there that is no bundler, is not enough
    const none = project({ [`node_modules/${hidden}/node_modules/citty/package.json`]: { name: 'citty', version: '1.0.0' }, 'package.json': { name: 'app' } });
    assert.equal(hooks.bundlerProcess(P, J(none, 'scripts/x.js'), none), false, hidden);
  }
});

test('hooks: an entry module the in-thread hook cannot wrap fails when it is imported (BUNDLE_LOCKFILE_STRICT=0: a warning)', { skip: !(typeof require('module').registerHooks === 'function' && require('../../src/hooks.cjs').syncHooksSafe(process.versions.node)) }, () => {
  const root = project({ 'm.mjs': 'export const x = 1;' });
  const script = `const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
    process.env.BUNDLE_LOCKFILE_ESM_HOOKS = 'sync';
    hooks.register({ name: 'x', esmEntries: [{ id: 'x', suffixes: null, wrap: ['f'] }] }); // suffixes.some throws
    hooks.install();
    import(${JSON.stringify(pathToFileURLHref(J(root, 'm.mjs')))}).then(() => console.log('loaded'), (e) => console.log('failed:', e.message));`;
  const strict = nodeWith(strictEnv(undefined), ['-e', script]);
  assert.equal(strict.status, 0, strict.stderr);
  assert.match(strict.stdout, /^failed: bundle-lockfile: could not wrap file:.*m\.mjs: .* \(BUNDLE_LOCKFILE_STRICT=0 makes this a warning\)/);
  const off = nodeWith(strictEnv('0'), ['-e', script]);
  assert.equal(off.stdout.trim(), 'loaded');
  assert.match(off.stderr, /WARNING: could not wrap file:.*m\.mjs/);
});

test('hooks: modules that ran before the hooks were installed are reported when they are', () => {
  const root = project({ 'node_modules/early/index.js': 'module.exports = { early: true };', 'node_modules/late/index.js': 'module.exports = { late: true };' });
  const r = nodeWith(cjsEnv('0'), ['-e', cjsHookScript(
    "{ name: 'w', onCjsLoad(exp, request) { if (/node_modules[\\\\/](early|late)[\\\\/]/.test(request)) console.log(Object.keys(exp)[0]); } }",
    `require(${JSON.stringify(J(root, 'node_modules/early/index.js'))});`,
    `require(${JSON.stringify(J(root, 'node_modules/late/index.js'))});`)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'early\nlate\n');
});
