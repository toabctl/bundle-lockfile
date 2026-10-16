'use strict';
// Unit tests of the core that maps files to packages: package.json files, vendored copies, transpiler helpers, the
// bundler package, hashes, the package.json tree, Next.js traces, values of unknown shape.
// All unit tests: node --test test/unit/*.test.cjs (see test/README.md)
// (helpers.cjs first: see there)
const {
  packagesForFiles, strictEnv, nodeWith, SRC, J, pathToFileURLHref, project, ids, pkg, warnings, entries,
  withConfig, rollupBuild, nft, TEST,
} = require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const packages = require('../../src/core/packages.cjs');
const { packageRoot, unvirtual } = require('../../src/core/paths.cjs');
const { toPackageLock } = require('../../src/core/lockfile.cjs');
const crypto = require('crypto');
const config = require('../../src/core/config.cjs');
const problems = require('../../src/core/problems.cjs');
const traces = require('../../src/core/traces.cjs');

test('packageRoot: directory below the last node_modules', () => {
  const r = (p) => packageRoot(p.split('/').join(path.sep));
  assert.equal(r('/p/node_modules/a/index.js'), '/p/node_modules/a'.split('/').join(path.sep));
  assert.equal(r('/p/node_modules/@s/b/lib/x.js'), '/p/node_modules/@s/b'.split('/').join(path.sep));
  assert.equal(r('/p/node_modules/a/node_modules/c/i.js'), '/p/node_modules/a/node_modules/c'.split('/').join(path.sep));
  assert.equal(r('/p/node_modules/.pnpm/a@1.0.0/node_modules/a/i.js'), '/p/node_modules/.pnpm/a@1.0.0/node_modules/a'.split('/').join(path.sep));
  assert.equal(r('/p/.yarn/cache/a-npm-1.0.0-x.zip/node_modules/a/i.js'), '/p/.yarn/cache/a-npm-1.0.0-x.zip/node_modules/a'.split('/').join(path.sep));
  assert.equal(r('/p/node_modules/a/dist/esm/index.js'), '/p/node_modules/a'.split('/').join(path.sep)); // not dist/esm
  assert.equal(r('/p/src/index.js'), null);
  assert.equal(r('/p/node_modules/index.js'), null);   // a file directly in node_modules
  assert.equal(r('/p/node_modules/@s/b'), null);       // the package directory itself, not a file in it
  assert.equal(r('/p/node_modules/@s'), null);
  // a tool's directory below node_modules is no package (no package name starts with a dot)
  assert.equal(r('/p/node_modules/.cache/nuxt/.nuxt/dist/server/server.mjs'), null);
  assert.equal(r('/p/node_modules/.vite/deps/react.js'), null);
  assert.equal(r('/p/node_modules/.cache/x/node_modules/a/i.js'), '/p/node_modules/.cache/x/node_modules/a'.split('/').join(path.sep));
  assert.equal(r('/p/node_modules/.store/a-npm-1.0.0-x/package/i.js'), '/p/node_modules/.store/a-npm-1.0.0-x/package'.split('/').join(path.sep));
});

test('packagesForFiles: one entry per package, nested manifests and first-party files ignored', () => {
  const root = project({
    'node_modules/a/package.json': { name: 'a', version: '1.0.0', license: 'MIT' },
    'node_modules/a/dist/esm/package.json': { type: 'module' },
    'node_modules/a/hooks/package.json': { name: 'a-hooks', version: '0.1.0', private: true }, // as preact/hooks' (not private: a vendored copy)
    'node_modules/@s/b/package.json': { name: '@s/b', version: '2.0.0' },
    'node_modules/a/node_modules/c/package.json': { name: 'c', version: '3.0.0' },
    'node_modules/noversion/package.json': { name: 'noversion' },
    'node_modules/broken/package.json': '{not json',
    'node_modules/alias/package.json': { name: 'real-name', version: '4.0.0' },
    'src/package.json': { name: 'app', version: '1.0.0' },
  });
  let pkgs;
  const warned = warnings(() => { pkgs = packagesForFiles([
    J(root, 'node_modules/a/index.js'), J(root, 'node_modules/a/dist/esm/x.js'), J(root, 'node_modules/a/hooks/index.js'),
    J(root, 'node_modules/@s/b/x.css') + '?inline', J(root, 'node_modules/a/node_modules/c/i.js'),
    J(root, 'node_modules/noversion/i.js'), J(root, 'node_modules/broken/i.js'), J(root, 'node_modules/alias/i.js'),
    J(root, 'src/index.js'), 'node_modules/a/relative.js', 'data:text/javascript,1', 'webpack/runtime/x',
    J(root, 'node_modules/.cache/gen/x.js'),
  ]); });
  assert.deepEqual(ids(pkgs), ['@s/b@2.0.0', 'a@1.0.0', 'c@3.0.0', 'real-name@4.0.0']);
  assert.equal(pkgs.find(p => p.name === 'a').path, J(root, 'node_modules/a'));
  // bundled code the lockfile cannot list is reported; generated files in node_modules/.cache are no package
  assert.deepEqual(warned.map(w => w.split(' ').find(x => x.includes('node_modules'))), [J(root, 'node_modules/noversion'), J(root, 'node_modules/broken')]);
  // once per package and process, not on every watch rebuild
  assert.deepEqual(warnings(() => packagesForFiles([J(root, 'node_modules/noversion/i.js')])), []);
});

test("packagesForFiles: Yarn PnP virtual paths are the package in the cache", () => {
  assert.equal(unvirtual('/p/.yarn/__virtual__/debug-virtual-9a75/0/cache/debug-npm-2.6.9.zip/node_modules/debug'), '/p/.yarn/cache/debug-npm-2.6.9.zip/node_modules/debug'.split('/').join(path.sep));
  assert.equal(unvirtual('/p/.yarn/__virtual__/debug-virtual-9a75/3/home/u/.yarn/berry/cache/d.zip/node_modules/debug'), '/home/u/.yarn/berry/cache/d.zip/node_modules/debug'.split('/').join(path.sep));
  assert.equal(unvirtual('/p/node_modules/a'), '/p/node_modules/a');
  // a directory named __virtual__ in a package is the package's own, not Yarn's virtual folder; a depth too large for
  // the path ends at the root (no RangeError from '../'.repeat())
  assert.equal(unvirtual('/p/node_modules/evil/__virtual__/x/2/node_modules/react/index.js'), '/p/node_modules/evil/__virtual__/x/2/node_modules/react/index.js');
  assert.equal(unvirtual('/p/.yarn/cache/e.zip/node_modules/evil/__virtual__/x/9/node_modules/react'), '/p/.yarn/cache/e.zip/node_modules/evil/__virtual__/x/9/node_modules/react');
  assert.equal(unvirtual('/p/.yarn/__virtual__/d-virtual-1/99999999999/x'), `${path.sep}x`);
  // two virtual instances of one package (different peer dependencies): one entry, at the cache path
  const root = project({ '.yarn/cache/d.zip/node_modules/d/package.json': { name: 'd', version: '1.0.0' } });
  const pkgs = packagesForFiles(['virt-1', 'virt-2'].map(v => J(root, '.yarn/__virtual__', `d-${v}`, '0/cache/d.zip/node_modules/d/i.js')));
  assert.deepEqual(pkgs.map(p => [p.name, p.path]), [['d', J(root, '.yarn/cache/d.zip/node_modules/d')]]);
});

test('packagesForFiles: a package.json with a byte order mark is read', () => {
  const root = project({ 'node_modules/bom/package.json': '\uFEFF{"name": "bom", "version": "1.0.0"}' });
  assert.deepEqual(ids(packagesForFiles([J(root, 'node_modules/bom/i.js')])), ['bom@1.0.0']);
});

test('packagesForFiles: symlinked packages are resolved; ones that resolve out of node_modules are first-party', () => {
  const root = project({
    'packages/ui/package.json': { name: '@acme/ui', version: '1.0.0' },
    'node_modules/.pnpm/d@1.0.0/node_modules/d/package.json': { name: 'd', version: '1.0.0' },
  });
  fs.mkdirSync(J(root, 'node_modules/@acme'), { recursive: true });
  fs.symlinkSync(J(root, 'packages/ui'), J(root, 'node_modules/@acme/ui'), 'dir');               // npm workspace
  fs.symlinkSync(J(root, 'node_modules/.pnpm/d@1.0.0/node_modules/d'), J(root, 'node_modules/d'), 'dir'); // pnpm
  // as webpack reports them with resolve.symlinks = false, plus d once more by its real path
  const pkgs = packagesForFiles([J(root, 'node_modules/@acme/ui/index.js'), J(root, 'node_modules/d/i.js'),
    J(root, 'node_modules/.pnpm/d@1.0.0/node_modules/d/j.js')]);
  assert.deepEqual(pkgs.map(p => [p.name, p.path]), [['d', J(root, 'node_modules/.pnpm/d@1.0.0/node_modules/d')]]);
});

test('packagesForFiles: a node_modules that is a symbolic link (node_modules -> deps/): its packages are listed, bundled by their real path', { skip: process.platform === 'win32' }, () => {
  const root = project({ 'package.json': { name: 'app', version: '1.0.0' }, 'deps/react/package.json': { name: 'react', version: '19.0.0' },
    'deps/@s/b/package.json': { name: '@s/b', version: '2.0.0' }, 'packages/ui/package.json': { name: '@acme/ui', version: '1.0.0' } });
  fs.symlinkSync(J(root, 'deps'), J(root, 'node_modules'), 'dir');
  fs.mkdirSync(J(root, 'deps/@acme'));
  fs.symlinkSync(J(root, 'packages/ui'), J(root, 'deps/@acme/ui'), 'dir'); // a workspace package: still first-party
  const pkgs = packagesForFiles([J(root, 'deps/react/index.js'), J(root, 'deps/@s/b/i.js'), J(root, 'packages/ui/i.js'), J(root, 'src/app.js')], { context: root });
  assert.deepEqual(ids(pkgs), ['@s/b@2.0.0', 'react@19.0.0']);
});

test('licenses: string, legacy object, legacy array - always one string; nothing usable means no license field', () => {
  // one string is the only form both syft (string, array of strings) and Trivy (string, {type} objects) read; several
  // licenses are the SPDX expression npm's documentation gives for them
  const root = project({
    'node_modules/s/package.json': { name: 's', version: '1.0.0', license: 'MIT' },
    'node_modules/o/package.json': { name: 'o', version: '1.0.0', license: { type: 'ISC', url: 'x' } },
    'node_modules/l/package.json': { name: 'l', version: '1.0.0', licenses: [{ type: 'MIT' }, 'Apache-2.0', { url: 'x' }] },
    'node_modules/one/package.json': { name: 'one', version: '1.0.0', licenses: [{ type: 'MIT', url: 'x' }] },
    'node_modules/twice/package.json': { name: 'twice', version: '1.0.0', licenses: ['MIT', { type: 'MIT' }] },
    'node_modules/sp/package.json': { name: 'sp', version: '1.0.0', licenses: ['Apache 2.0', '(BSD-2-Clause OR ISC)'] },
    'node_modules/e/package.json': { name: 'e', version: '1.0.0', licenses: [] },
    'node_modules/n/package.json': { name: 'n', version: '1.0.0' },
  });
  const lock = JSON.parse(toPackageLock(packagesForFiles(['s', 'o', 'l', 'one', 'twice', 'sp', 'e', 'n'].map(n => J(root, 'node_modules', n, 'i.js'))), root));
  assert.deepEqual(lock.packages, {
    '': {},
    'node_modules/e': { name: 'e', version: '1.0.0' },
    'node_modules/l': { name: 'l', version: '1.0.0', license: '(MIT OR Apache-2.0)' },
    'node_modules/n': { name: 'n', version: '1.0.0' },
    'node_modules/o': { name: 'o', version: '1.0.0', license: 'ISC' },
    'node_modules/one': { name: 'one', version: '1.0.0', license: 'MIT' },
    'node_modules/s': { name: 's', version: '1.0.0', license: 'MIT' },
    'node_modules/sp': { name: 'sp', version: '1.0.0', license: '((Apache 2.0) OR (BSD-2-Clause OR ISC))' },
    'node_modules/twice': { name: 'twice', version: '1.0.0', license: 'MIT' },
  });
  // an array read back from a lockfile of v0.0.3 (readMeta) is written as one string too
  assert.equal(entries(toPackageLock([{ ...pkg('a', '1.0.0', J(root, 'node_modules/a')), license: ['MIT', 'ISC'] }], root))[0][1].license, '(MIT OR ISC)');
  // and what is no string there (an edited lockfile) is no license
  for (const license of [{ type: 'MIT' }, [1, null], 7]) {
    assert.deepEqual(entries(toPackageLock([{ ...pkg('a', '1.0.0', J(root, 'node_modules/a')), license }], root))[0][1], { name: 'a', version: '1.0.0' });
  }
});

test('packagesOfFiles: any number of files - none is an argument of its own of a call (V8 takes about 125000)', () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  // first-party files, one list of packages each (none), and one file of a package
  const files = [...Array.from({ length: 200000 }, (_, i) => J(root, `src/f${i}.js`)), J(root, 'node_modules/a/i.js')];
  const result = packages.packagesOfFiles(files);
  assert.deepEqual(result.all.map(p => `${p.name}@${p.version}`), ['a@1.0.0']);
  assert.deepEqual(packages.packagesForFiles(files).map(p => p.name), ['a']);
  // the packages of an esbuild output (and bundle-lockfile-from-metafile's) with that many inputs
  const { packagesOfInputs } = require('../../src/adapters/esbuild.cjs');
  assert.deepEqual(packagesOfInputs(files, result.byFile).map(p => p.name), ['a']);
});

test('packagesOfFiles: how each file\'s packages were found - modules by the class the adapter gives, copies made with fs, vendored copies', () => {
  const via = require('../../src/core/via.cjs');
  const copies = require('../../src/core/copies.cjs');
  const root = project({
    'package.json': { name: 'app', version: '1.0.0', private: true },
    'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/a/i.js': 'a',
    'node_modules/a/inner/package.json': { name: 'inner', version: '2.0.0' }, 'node_modules/a/inner/i.js': 'inner',
    'node_modules/s/package.json': { name: 's', version: '1.0.0' }, 'node_modules/s/s.scss': 's',
    'node_modules/c/package.json': { name: 'c', version: '1.0.0' }, 'node_modules/c/c.js': 'c',
    'public/c.js': 'c',
  });
  copies.record(J(root, 'node_modules/c/c.js'), J(root, 'public/c.js'));
  const files = [J(root, 'node_modules/a/i.js'), J(root, 'node_modules/a/inner/i.js'), J(root, 'node_modules/s/s.scss'), J(root, 'public/c.js')];
  const result = packages.packagesOfFiles(files, { context: root, entries: [] });
  const found = via.ofFiles(result, new Map([[J(root, 'node_modules/s/s.scss'), new Set(['style'])]]));
  const byName = Object.fromEntries(result.all.map(p => [p.name, [...(found.byPath.get(p.path) || [])].sort()]));
  assert.deepEqual(byName, { a: ['chunk'], inner: ['chunk', 'vendored'], s: ['style'], c: ['chunk', 'fs-copy'] });
});

test('packages: inlinedFile - files a loader or plugin inlines, not code, build tools\' settings or directories', () => {
  const { inlinedFile } = require('../../src/core/packages.cjs');
  const yes = ['node_modules/x/a.glsl', 'node_modules/x/i.svg', 'node_modules/x/f.woff2', 'node_modules/x/de.json', 'node_modules/x/s.scss',
    'node_modules/x/LICENSE', 'node_modules/x/m.wasm'];
  const no = ['node_modules/x/a.js', 'node_modules/x/a.mjs', 'node_modules/x/a.ts', 'node_modules/x/a.d.ts', 'node_modules/x/a.d.mts',
    'node_modules/x/a.tsx', 'node_modules/x/c.vue', 'node_modules/x/c.svelte', 'node_modules/x/b.node', 'node_modules/x/package.json',
    'node_modules/@tsconfig/x/tsconfig.json', 'node_modules/@vue/tsconfig/tsconfig.dom.json', 'node_modules/x/jsconfig.json',
    'node_modules/x/.babelrc', 'node_modules/x/.babelrc.json', 'node_modules/x/babel.config.json', 'node_modules/x/.browserslistrc',
    'node_modules/x/.postcssrc.json', 'node_modules/x/.swcrc', 'node_modules/x/.eslintrc.json'];
  const root = project(Object.fromEntries([...yes, ...no].map(f => [f, 'x'])));
  for (const f of yes) assert.equal(inlinedFile(J(root, f)), true, f);
  assert.equal(inlinedFile(`${J(root, 'node_modules/x/s.scss')}?inline`), true);
  for (const f of no) assert.equal(inlinedFile(J(root, f)), false, f);
  // directories (webpack 5's snapshots have those a loader looked into), no path; a file that is gone counts by its name
  for (const f of [J(root, 'node_modules/x'), J(root, 'node_modules/@tsconfig'), '', null]) assert.equal(inlinedFile(f), false, f);
  assert.equal(inlinedFile(J(root, 'node_modules/x/gone.svg')), true);
});

test('bundler: the package around the file the adapter patched, a copy without a version at the bundler\'s', () => withConfig({ strict: true }, () => {
  const { bundlerPackage } = require('../../src/core/bundler.cjs');
  const root = project({
    'node_modules/webpack/package.json': { name: 'webpack', version: '5.111.1', license: 'MIT' },
    'node_modules/webpack/lib/Compiler.js': '',
    'node_modules/next/package.json': { name: 'next', version: '16.4.0' },
    'node_modules/next/dist/compiled/webpack/package.json': { name: 'webpack', main: 'bundle5.js', license: 'MIT' },
    'node_modules/next/dist/compiled/webpack/webpack.js': '',
    'node_modules/.pnpm/rollup@4.0.2/node_modules/rollup/package.json': { name: 'rollup', version: '4.0.2' },
    'node_modules/.pnpm/rollup@4.0.2/node_modules/rollup/dist/es/package.json': { type: 'module' },
    'node_modules/.pnpm/rollup@4.0.2/node_modules/rollup/dist/es/rollup.js': '',
    'node_modules/.store/vite-npm-8.3.3-ab/package/package.json': { name: 'vite', version: '8.3.3' },
    'node_modules/.store/vite-npm-8.3.3-ab/package/dist/node/chunks/node.js': '',
    'node_modules/x/package.json': { name: 'x', version: '1.0.0' },
    'node_modules/x/node_modules/webpack/package.json': { name: 'webpack', version: '4.47.0' },
    'node_modules/x/node_modules/webpack/lib/Compiler.js': '',
    'node_modules/nameless/package.json': { name: 'webpack' },
    'node_modules/nameless/lib/Compiler.js': '',
    'src/Compiler.js': '',
  });
  problems.take();
  const at = (p) => J(root, p);
  // its package.json's version, over the version the code says (strings in code can be stale)
  assert.deepEqual(bundlerPackage('webpack', at('node_modules/webpack/lib/Compiler.js'), ['webpack'], '5.111.0'),
    { name: 'webpack', version: '5.111.1', path: at('node_modules/webpack'), license: 'MIT' });
  // Next.js' copy: its package.json has no version - the compiler's (compiler.webpack.version); at its own location
  assert.deepEqual(bundlerPackage('webpack', at('node_modules/next/dist/compiled/webpack/webpack.js'), ['webpack'], '5.98.0'),
    { name: 'webpack', version: '5.98.0', path: at('node_modules/next/dist/compiled/webpack'), license: 'MIT' });
  // a file: URL (an ES module entry), past dist/es/package.json ({"type": "module"}); pnpm
  assert.equal(bundlerPackage('rollup', pathToFileURLHref(at('node_modules/.pnpm/rollup@4.0.2/node_modules/rollup/dist/es/rollup.js')) + '?q', ['rollup']).path,
    at('node_modules/.pnpm/rollup@4.0.2/node_modules/rollup'));
  // Yarn's pnpm linker store
  assert.equal(bundlerPackage('vite', at('node_modules/.store/vite-npm-8.3.3-ab/package/package.json'), ['vite']).version, '8.3.3');
  // two copies: each at its own location
  assert.equal(bundlerPackage('webpack', at('node_modules/x/node_modules/webpack/lib/Compiler.js'), ['webpack']).version, '4.47.0');
  assert.deepEqual(problems.take(), []);
  // no version anywhere, no package of that name around the file: problems (strict mode: the build fails), nothing listed
  assert.equal(bundlerPackage('webpack', at('node_modules/nameless/lib/Compiler.js'), ['webpack']), null);
  assert.equal(bundlerPackage('webpack', at('src/Compiler.js'), ['webpack']), null);
  assert.equal(bundlerPackage('webpack', '@rspack/core (ES module)', ['@rspack/core']), null);
  const got = problems.take();
  assert.equal(got.length, 3);
  assert.match(got[0], /nameless \(webpack\) has no version/);
  assert.match(got[1], /no package\.json of webpack around .*src.Compiler\.js/);
  // again on the next build: not cached
  assert.equal(bundlerPackage('webpack', at('src/Compiler.js'), ['webpack']), null);
  assert.equal(problems.take().length, 1);
}));

test('bundler: Vite\'s package is the vite or rolldown-vite around a file of the caller; other packages\' files are skipped', () => {
  const { viteOf, callerFiles } = require('../../src/core/bundler.cjs');
  const root = project({
    'node_modules/vite/package.json': { name: 'vite', version: '7.3.7' },
    'node_modules/vite/dist/node/package.json': { type: 'module' },
    'node_modules/vite/dist/node/chunks/config.js': '',
    'node_modules/rolldown-vite/package.json': { name: 'rolldown-vite', version: '7.3.1' },
    'node_modules/rolldown-vite/dist/node/chunks/x.js': '',
    'node_modules/@sveltejs/kit/package.json': { name: '@sveltejs/kit', version: '2.0.0' },
    'node_modules/@sveltejs/kit/src/vite.js': '',
    'node_modules/@sveltejs/kit/node_modules/vite-like/package.json': { name: 'vite-like', version: '1.0.0' },
    'tools/build.mjs': '',
  });
  const at = (p) => J(root, p);
  assert.equal(viteOf([at('node_modules/vite/dist/node/chunks/config.js')]), at('node_modules/vite/package.json'));
  assert.equal(viteOf([at('node_modules/rolldown-vite/dist/node/chunks/x.js')]), at('node_modules/rolldown-vite/package.json'));
  // a tool calling Vite: its frames are not Vite's, the next one is
  assert.equal(viteOf([at('tools/build.mjs'), at('node_modules/@sveltejs/kit/src/vite.js'), at('node_modules/vite/dist/node/chunks/config.js')]),
    at('node_modules/vite/package.json'));
  assert.equal(viteOf([at('node_modules/@sveltejs/kit/src/vite.js')]), null);
  // the caller's files: none of bundle-lockfile's own, also with a tool's Error.stackTraceLimit = 0 - which stays
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    const files = callerFiles();
    assert.ok(files.includes(__filename), files.join(' '));
    assert.ok(!files.some(f => f.startsWith(SRC + path.sep)));
    assert.equal(Error.stackTraceLimit, 0);
  } finally { Error.stackTraceLimit = limit; }
});

test('inToolCache: outputs below node_modules are a tool\'s cache, except below node_modules/.cache/', () => {
  const { inToolCache } = require('../../src/core/paths.cjs');
  for (const [dir, want] of [
    ['/p/dist', false], ['/p/node_modules/.vite/deps', true], ['/p/node_modules/@vitejs/plugin-legacy/dist', true],
    ['/p/node_modules/.cache', false], ['/p/node_modules/.cache/nuxt/.nuxt/dist/client', false],
    ['/p/node_modules/.cache/x/node_modules/y/dist', true], // a package's directory inside the cache: the last node_modules counts
    ['/p/.cache/deps', false], ['/p/node_modules_old/dist', false],
  ]) assert.equal(inToolCache(dir), want, dir);
});

test('values: unknown values checked (objects, arrays, strings, error codes)', () => {
  const { isObject, isArray, strings, parseJson, codeOf } = require('../../src/core/values.cjs');
  assert.deepEqual([{}, [], null, 'x', () => {}, new Map()].map(isObject), [true, false, false, false, false, true]);
  assert.deepEqual([[], {}, 'ab'].map(isArray), [true, false, false]);
  assert.deepEqual(strings(['a', 1, null, 'b', '']), ['a', 'b', '']);
  assert.deepEqual(strings('a'), []);
  assert.deepEqual(parseJson('{"a":[1]}'), { a: [1] });
  assert.throws(() => parseJson('{'));
  assert.equal(codeOf(Object.assign(new Error('x'), { code: 'ENOENT' })), 'ENOENT');
  assert.deepEqual([new Error('x'), null, 'ENOENT', { code: 1 }].map(codeOf), [undefined, undefined, undefined, undefined]);
});

test('values: perProcess shares a state across copies, and fills in the fields a state of an earlier release lacks', () => {
  const { perProcess } = require('../../src/core/values.cjs');
  const key = Symbol.for(`bundle-lockfile.unit-test.${process.pid}.v1`);
  try {
    const first = perProcess(key, () => ({ files: new Map(), count: 0 }));
    first.files.set('a', 1);
    // another copy (the same key): the same object, not a new one
    assert.equal(perProcess(key, () => ({ files: new Map(), count: 0 })), first);
    // a release that added a field under the same key: the state keeps what it has and gets the new field
    const later = perProcess(key, () => ({ files: new Map(), count: 5, listeners: [] }));
    assert.equal(later, first);
    assert.equal(later.files.get('a'), 1);
    assert.equal(later.count, 0);
    assert.deepEqual(later.listeners, []);
  } finally { delete globalThis[key]; }
});

test('hashes: one cache entry per file, recomputed when the file changes', () => {
  const hashes = require('../../src/core/hashes.cjs');
  const root = project({ 'out.js': 'one' });
  const f = J(root, 'out.js');
  const sha = (s) => `sha256-${crypto.createHash('sha256').update(s).digest('hex')}`;
  assert.equal(hashes.hashOf(f), sha('one'));
  const before = hashes.state.files.size;
  for (const [i, content] of ['two', 'three!', 'four'].entries()) {
    fs.writeFileSync(f, content);
    fs.utimesSync(f, new Date(), new Date(Date.now() + (i + 1) * 1000)); // a new mtime, also on coarse file systems
    assert.equal(hashes.hashOf(f), sha(content));
  }
  assert.equal(hashes.state.files.size, before);
  assert.equal(hashes.hashOf(J(root, 'missing.js')), null);
});

// Vendored packages (core/vendored.cjs): copies outside node_modules and inside packages, package roots without a
// package.json, and the first-party boundaries.
test('vendored: which package.json is a copy of an npm package', () => {
  const { isVendorable } = require('../../src/core/vendored.cjs');
  const yes = [{ name: 'left-pad', version: '1.3.0' }, { name: '@scope/x', version: '1.0.0' }, { name: 'JSONStream', version: '1.3.5' }, // a legacy name
    { name: 'vscode-languageclient', version: '10.1.2', engines: { vscode: '^1.91.0' } }]; // a library for extensions: no publisher
  const no = [{ name: 'x' }, { version: '1.0.0' }, { name: 'x', version: '1.0.0', private: true }, { name: 'GitLab Web IDE', version: '1.94.0' },
    { name: 'yaml', version: '1.0.0', publisher: 'vscode', engines: { vscode: '*' } }, { name: 'a'.repeat(215), version: '1.0.0' }, null];
  for (const j of yes) assert.equal(isVendorable(j), true, JSON.stringify(j));
  for (const j of no) assert.equal(isVendorable(j), false, JSON.stringify(j));
});

test('vendored: workspace patterns, pnpm-workspace.yaml, rush.json', () => {
  const { globTest, pnpmPackages, parseJsonc } = require('../../src/core/vendored.cjs');
  const cases = [['packages/*', 'packages/a', true], ['packages/*', 'packages/a/b', false], ['packages/**', 'packages/a/b', true],
    ['./apps/*/', 'apps/web', true], ['{apps,libs}/*', 'libs/x', true], ['{apps,libs}/*', 'tools/x', false], ['pkg-?', 'pkg-a', true],
    ['**', 'a/b/c', true], ['packages/*/package.json', 'packages/a', true], ['a.b/*', 'axb/c', false]];
  for (const [p, rel, want] of cases) assert.equal(globTest(p)(rel), want, `${p} ${rel}`);
  assert.deepEqual(pnpmPackages("# x\npackages:\n  - 'apps/*' # apps\n  - \"libs/**\"\n  - '!**/test/**'\ncatalog:\n  a: 1\n"), ['apps/*', 'libs/**', '!**/test/**']);
  assert.deepEqual(pnpmPackages("packages: ['a/*', \"b/*\"]\n"), ['a/*', 'b/*']);
  assert.deepEqual(pnpmPackages('onlyBuiltDependencies: []\n'), []);
  assert.deepEqual(parseJsonc('/* c */ { "a": "x//y", // line\n "b": [1, 2,], }'), { a: 'x//y', b: [1, 2] });
});

test('vendored: first-party boundaries - context, entries, workspaces, pnpm, lerna, rush, Nx, links, settings, private', () => withConfig({ firstParty: [] }, () => {
  const { scope } = require('../../src/core/vendored.cjs');
  const v = (name) => ({ name, version: '1.0.0', main: 'i.js' });
  const files = { 'package.json': { name: 'root', version: '1.0.0', workspaces: { packages: ['packages/*', '!packages/excluded'] } },
    'pnpm-workspace.yaml': "packages:\n  - 'pnpm/*'\n", 'lerna.json': { packages: ['lerna/*'] }, 'rush.json': '{ // c\n "projects": [{ "projectFolder": "rush/x" }] }', 'nx.json': {},
    'app/package.json': { name: 'app', version: '1.0.0' }, 'other/package.json': v('other') };
  for (const d of ['packages/ui', 'packages/excluded', 'pnpm/p', 'lerna/l', 'rush/x', 'libs/nx', 'linked/l', 'tools/t', 'vendor/left-pad', 'vendor/private']) {
    files[`${d}/package.json`] = d === 'vendor/private' ? { ...v('p'), private: true } : v(d.split('/').pop());
    files[`${d}/i.js`] = '';
  }
  files['libs/nx/project.json'] = {};
  const root = project(files);
  fs.mkdirSync(J(root, 'node_modules'), { recursive: true });
  fs.symlinkSync(J(root, 'linked/l'), J(root, 'node_modules/l'), 'dir');
  // BUNDLE_LOCKFILE_FIRST_PARTY: absolute globs, whatever the working directory is
  config.firstParty = [J(root, 'tools/**')];
  const cwd = process.cwd();
  process.chdir(os.tmpdir());
  try {
    const s = scope({ context: J(root, 'app') });
    const owner = (d) => { const p = s.ownerOf(J(root, d, 'i.js')); return p && p.name; };
    assert.equal(owner('app'), null);                 // the context
    assert.equal(owner('packages/ui'), null);         // a workspace member
    assert.equal(owner('lerna/l'), null);
    assert.equal(owner('packages/excluded'), 'excluded'); // excluded from the workspaces: not a member
    assert.equal(owner('pnpm/p'), null);
    assert.equal(owner('rush/x'), null);
    assert.equal(owner('libs/nx'), null);             // an Nx project.json
    assert.equal(owner('linked/l'), null);            // linked into node_modules
    assert.equal(owner('tools/t'), null);             // BUNDLE_LOCKFILE_FIRST_PARTY
    assert.equal(owner('vendor/private'), null);
    assert.equal(owner('vendor/left-pad'), 'left-pad');
    assert.equal(owner('other'), 'other');            // an in-repo library nothing marks first-party
    // a glob through a symbolic link names the directories at their real paths too
    const link = `${root}-link`;
    fs.symlinkSync(root, link, 'dir');
    config.firstParty = [J(link, 'oth?r'), J(link, 'vendor/left-pad')];
    const linked = scope({ context: J(root, 'app') });
    assert.equal(linked.ownerOf(J(root, 'other/i.js')), null);
    assert.equal(linked.ownerOf(J(root, 'vendor/left-pad/i.js')), null);
    config.firstParty = ['/**']; // none outside node_modules
    assert.equal(scope({ context: J(root, 'app') }).ownerOf(J(root, 'other/i.js')), null);
    config.firstParty = [J(root, 'tools/**')];
    // a build started from another directory (Rollup's API): the package of its entry is first-party
    const elsewhere = scope({ context: os.tmpdir(), entries: [J(root, 'other/i.js')] });
    assert.equal(elsewhere.ownerOf(J(root, 'other/i.js')), null);
    assert.equal(scope({ context: os.tmpdir() }).ownerOf(J(root, 'other/i.js')).name, 'other');
  } finally { process.chdir(cwd); }
  // a lerna.json without packages: packages/* (as Nx reads it), also without package manager workspaces
  const lerna = project({ 'package.json': { name: 'r', version: '1.0.0' }, 'lerna.json': {}, 'packages/d/package.json': v('d'), 'libs/e/package.json': v('e') });
  const ls = scope({ context: lerna });
  assert.equal(ls.ownerOf(J(lerna, 'packages/d/i.js')), null);
  assert.equal(ls.ownerOf(J(lerna, 'libs/e/i.js')).name, 'e');
}));

test('vendored: packages of files - copies outside and inside node_modules, package roots without a package.json', () => {
  const v = (name, extra = {}) => ({ name, version: '1.0.0', ...extra });
  const root = project({ 'package.json': { name: 'app', version: '1.0.0' },
    'vendor/x/package.json': v('x'), 'vendor/x/dist/package.json': { type: 'module' }, 'vendor/x/dist/i.js': '',
    'vendor/ext/package.json': v('yaml', { publisher: 'vscode', engines: { vscode: '*' } }), 'vendor/ext/i.js': '',
    'node_modules/c/package.json': v('c'), 'node_modules/c/i.js': '',
    'node_modules/c/vendor/inner/package.json': v('inner'), 'node_modules/c/vendor/inner/i.js': '',
    'node_modules/c/build/esm/package.json': v('c'), 'node_modules/c/build/esm/i.js': '',
    'node_modules/c/hooks/package.json': v('c-hooks', { private: true }), 'node_modules/c/hooks/i.js': '',
    'node_modules/c/dist/esm/node_modules/flat/i.js': '',
    'node_modules/c/extensions/e/package.json': v('go', { publisher: 'vscode', engines: { vscode: '*' } }), 'node_modules/c/extensions/e/i.js': '',
    'ws/package.json': v('ws'), 'ws/vendor/y/package.json': v('y'), 'ws/vendor/y/i.js': '', 'ws/i.js': '',
    'ws/build/esm/package.json': v('ws'), 'ws/build/esm/i.js': '',
    'vendor/z/package.json': v('z'), 'vendor/z/build/esm/package.json': v('z'), 'vendor/z/build/esm/i.js': '' });
  fs.symlinkSync(J(root, 'ws'), J(root, 'node_modules/ws'), 'dir'); // a first-party package linked into node_modules
  const of = (f) => packagesForFiles([J(root, f)], { context: root }).map(p => `${p.name}@${p.version} ${path.relative(root, p.path)}`);
  assert.deepEqual(of('vendor/x/dist/i.js'), ['x@1.0.0 vendor/x']);           // the innermost copy, not dist/'s {type}
  assert.deepEqual(of('vendor/ext/i.js'), []);                                // a VS Code extension: first-party
  assert.deepEqual(of('node_modules/c/i.js'), ['c@1.0.0 node_modules/c']);
  // a copy inside a package, and the package that ships it: a package.json inside it can name any package, and must not
  // hide the package itself (node_modules/evil/lib/package.json saying left-pad)
  assert.deepEqual(of('node_modules/c/vendor/inner/i.js'), ['inner@1.0.0 node_modules/c/vendor/inner', 'c@1.0.0 node_modules/c']);
  assert.deepEqual(of('node_modules/c/build/esm/i.js'), ['c@1.0.0 node_modules/c']); // the package's own name
  assert.deepEqual(of('node_modules/c/hooks/i.js'), ['c@1.0.0 node_modules/c']);     // a private helper
  assert.deepEqual(of('node_modules/c/extensions/e/i.js'), ['c@1.0.0 node_modules/c']);
  const seen = warnings(() => assert.deepEqual(of('node_modules/c/dist/esm/node_modules/flat/i.js'), ['c@1.0.0 node_modules/c']));
  assert.match(seen.join('\n'), /no package\.json with name and version in \S*flat - its bundled files are listed as c@1\.0\.0, the package around it/);
  assert.deepEqual(of('node_modules/ws/i.js'), []);                           // first-party, through its link
  assert.deepEqual(of('node_modules/ws/vendor/y/i.js'), ['y@1.0.0 ws/vendor/y']); // a copy inside it is one
  // a package.json with the name of one further out is that package: first-party ws, the copy z at its root
  assert.deepEqual(of('node_modules/ws/build/esm/i.js'), []);
  assert.deepEqual(of('vendor/z/build/esm/i.js'), ['z@1.0.0 vendor/z']);
  // without the build (other callers): no copies outside node_modules
  assert.deepEqual(packagesForFiles([J(root, 'vendor/x/dist/i.js')]), []);
});

// The package.json files inside real packages that other tools took for packages of their own, as their npm tarballs
// have them (preact 10.29.8, @duetds/date-picker 1.4.0, @telekom/scale-components 3.0.0-beta.55, @ionic/core 8.8.19,
// engine.io-client 6.6.7, socket.io-client 4.8.4, luxon 3.7.2, @hookform/resolvers 5.9.1, @babel/runtime 7.29.10):
// none of them is a copy of an npm package, so a file below one is the package's
test('vendored: package.json files inside real packages are the package (name without version, version without name, private helpers)', () => {
  const v = (name, version, extra = {}) => ({ name, version, license: 'MIT', ...extra });
  const nested = {
    '@duetds/date-picker': ['1.4.0', 'dist/loader', { name: 'duet-loader', typings: './index.d.ts', module: './index.js', main: './index.cjs.js' }],
    '@telekom/scale-components': ['3.0.0-beta.55', 'loader', { name: 'scale-components-loader', module: './index.js', main: './index.cjs.js' }],
    '@ionic/core': ['8.8.19', 'components', { name: '@ionic/core/components', version: '0.0.0', main: './index.js', private: true, sideEffects: false }],
    'engine.io-client': ['6.6.7', 'build/esm', { name: 'engine.io-client', type: 'module', browser: { ws: false } }],
    'socket.io-client': ['4.8.4', 'build/esm', { name: 'socket.io-client', version: '4.8.4', type: 'module' }],
    luxon: ['3.7.2', 'src', { type: 'module', version: '3.7.2' }],
    '@hookform/resolvers': ['5.9.1', 'zod', { name: '@hookform/resolvers/zod', version: '1.0.0', private: true, main: 'dist/zod.js', license: 'MIT' }],
    '@babel/runtime': ['7.29.10', 'helpers/esm', { type: 'module' }],
    preact: ['10.29.8', 'hooks', { name: 'preact-hooks', version: '0.1.0', private: true, main: 'dist/hooks.js', license: 'MIT' }],
  };
  const files = { 'package.json': { name: 'app', version: '1.0.0' } };
  for (const [name, [version, dir, j]] of Object.entries(nested)) {
    files[`node_modules/${name}/package.json`] = v(name, version);
    files[`node_modules/${name}/${dir}/package.json`] = j;
    files[`node_modules/${name}/${dir}/i.js`] = '';
  }
  // the hydrate app's name has a slash and no version; the same name with a version and without private: still no
  // name npm accepts, so no copy either
  files['node_modules/@telekom/scale-components/hydrate/package.json'] = { name: '@telekom/scale-components/hydrate', main: 'index.js' };
  files['node_modules/@telekom/scale-components/hydrate/i.js'] = '';
  files['node_modules/@hookform/resolvers/yup/package.json'] = { name: '@hookform/resolvers/yup', version: '1.0.0', license: 'MIT' };
  files['node_modules/@hookform/resolvers/yup/i.js'] = '';
  const root = project(files);
  for (const build of [{ context: root }, undefined]) {
    const of = (f) => packagesForFiles([J(root, 'node_modules', f)], build).map(p => `${p.name}@${p.version} ${path.relative(root, p.path)}`);
    let seen;
    const warned = warnings(() => {
      seen = Object.fromEntries(Object.entries(nested).map(([name, [, dir]]) => [name, of(`${name}/${dir}/i.js`)]));
    });
    for (const [name, [version]] of Object.entries(nested)) assert.deepEqual(seen[name], [`${name}@${version} node_modules/${name}`], name);
    assert.deepEqual(of('@telekom/scale-components/hydrate/i.js'), ['@telekom/scale-components@3.0.0-beta.55 node_modules/@telekom/scale-components']);
    assert.deepEqual(of('@hookform/resolvers/yup/i.js'), ['@hookform/resolvers@5.9.1 node_modules/@hookform/resolvers']);
    assert.deepEqual(warned, []); // package roots with a usable package.json: nothing to warn about
  }
  // each is no copy by itself - except socket.io-client's, which has the package's own name and version, and so is it
  const { isVendorable } = require('../../src/core/vendored.cjs');
  for (const [name, [, , j]] of Object.entries(nested)) assert.equal(isVendorable(j), name === 'socket.io-client', JSON.stringify(j));
});

test('vendored: a bundled file another build produced is its output, no vendored copy', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/inner/package.json': { name: 'inner', version: '1.0.0' }, 'island/package.json': { name: 'island', version: '1.0.0' } });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'island/dist'), chunks: [{ fileName: 'main.js', code: 'island', modules: [J(root, 'node_modules/inner/i.js')] }] });
    const elsewhere = { context: os.tmpdir() }; // island/ is no ancestor: only the record says it is first-party output
    assert.deepEqual(ids(packages.packagesOfFiles([J(root, 'island/dist/main.js')], elsewhere).all), ['inner@1.0.0']);
    // changed after its build: still that build's output (its record says so by path), no vendored copy of island
    fs.appendFileSync(J(root, 'island/dist/main.js'), '/* changed */');
    let changed;
    assert.equal(warnings(() => { changed = packages.packagesOfFiles([J(root, 'island/dist/main.js')], elsewhere).all; }).length, 1);
    assert.deepEqual(ids(changed), ['inner@1.0.0']);
  } finally { process.chdir(cwd); }
});

test('tree: a package.json per lockfile key, rewritten in place only when the packages change; no package\'s files', () => {
  const { stubsOf, writeTree, inTree } = require('../../src/core/tree.cjs');
  const lock = (pkgs) => JSON.stringify({ lockfileVersion: 3, requires: true, packages: { '': {}, ...pkgs } });
  const json = lock({
    'node_modules/a': { name: 'a', version: '1.0.0', license: 'MIT' },
    'node_modules/a@2.0.0': { name: 'a', version: '2.0.0' },
    'node_modules/ms-old': { name: 'ms', version: '2.0.0', license: 'MIT' }, // an alias: the stub has the name
    'node_modules/@s/b/node_modules/c': { name: '@s/c', version: '1.0.0', license: '(MIT OR ISC)' },
  });
  const stubs = stubsOf(json);
  // packages/<id of the key>/node_modules/<name>/package.json: a package root (the directory below the last node_modules)
  for (const [rel] of stubs) assert.match(rel, /^packages\/[0-9a-f]{16}\/node_modules\/(@[^/]+\/)?[^/@]+\/package\.json$/, rel);
  assert.deepEqual(stubs.map(([rel, c]) => [rel.split('/').slice(3, -1).join('/'), JSON.parse(c)]).sort((x, y) => JSON.stringify(x) < JSON.stringify(y) ? -1 : 1), [
    ['@s/c', { name: '@s/c', version: '1.0.0', license: '(MIT OR ISC)' }], ['a', { name: 'a', version: '1.0.0', license: 'MIT' }],
    ['a', { name: 'a', version: '2.0.0' }], ['ms', { name: 'ms', version: '2.0.0', license: 'MIT' }]]);
  assert.equal(new Set(stubs.map(([rel]) => rel.split('/')[1])).size, 4); // one directory per key
  assert.ok(stubs.every(([rel]) => inTree(J('/out/bundle-lockfile', rel))));
  assert.ok(!inTree('/p/node_modules/a/package.json'));
  const dir = J(project({}), 'dist/bundle-lockfile');
  const files = () => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = J(d, e.name); if (e.isDirectory()) walk(f); else out.push(path.relative(dir, f).split(path.sep).join('/')); } }; walk(dir); return out.sort(); };
  writeTree(dir, json);
  assert.deepEqual(files(), stubs.map(([rel]) => rel).sort());
  // the same packages: not written again
  const one = J(dir, stubs[0][0]), mtime = fs.statSync(one).mtimeMs;
  fs.utimesSync(one, new Date(0), new Date(0));
  writeTree(dir, json);
  assert.equal(fs.statSync(one).mtimeMs, 0);
  // fewer packages: the others' stubs are gone, nothing left aside
  writeTree(dir, lock({ 'node_modules/a': { name: 'a', version: '1.0.0', license: 'MIT' } }));
  assert.deepEqual(files().map(f => f.split('/').slice(2).join('/')), ['node_modules/a/package.json']);
  writeTree(dir, lock({}));
  assert.deepEqual(files(), []);
  assert.deepEqual(fs.readdirSync(dir), ['packages']);
  assert.ok(mtime > 0);
});

test('tree: a package name that is no path of a package (.., an extra /, \\) writes no stub, anywhere: the tree fails', () => {
  const { stubsOf, writeTree } = require('../../src/core/tree.cjs');
  const lock = (name) => JSON.stringify({ lockfileVersion: 3, requires: true, packages: { '': {}, 'node_modules/x': { name, version: '1.0.0' } } });
  const root = project({});
  const dir = J(root, 'a/b/c/dist/bundle-lockfile');
  fs.mkdirSync(dir, { recursive: true });
  // a bundled package's package.json can say any name: it must not lead the stub out of the tree
  for (const name of ['../../../../../../escaped', '@s/../../../../../../../escaped', 'a/b', '@s/b/c', '..', '.', '@s/..', 'a\\b', '@/a', '']) {
    assert.throws(() => stubsOf(lock(name)), /no package name/, name);
    assert.throws(() => writeTree(dir, lock(name)), /no package name/, name);
  }
  assert.ok(!fs.existsSync(J(root, 'escaped')) && !fs.existsSync(J(root, 'a/escaped')));
  assert.deepEqual(fs.readdirSync(dir), []); // (nothing left aside either)
  // valid names, also with dots and a scope
  assert.equal(stubsOf(lock('@s/.b.c')).length, 1);
  assert.equal(stubsOf(lock('a..b')).length, 1);
});

test('tree: a packages directory bundle-lockfile did not write is never replaced (BUNDLE_LOCKFILE_FILE=package-lock.json: the output\'s own)', () => {
  const { writeTree } = require('../../src/core/tree.cjs');
  const lock = (pkgs) => JSON.stringify({ lockfileVersion: 3, requires: true, packages: { '': {}, ...pkgs } });
  const a = lock({ 'node_modules/a': { name: 'a', version: '1.0.0' } });
  const b = lock({ 'node_modules/b': { name: 'b', version: '1.0.0' } });
  // the output's (or the project's) own packages/: its files stay, the tree is not written
  for (const own of ['packages/keep.html', 'packages/docs/index.html', 'packages/0123456789abcdef/x.js', 'packages/0123456789abcdef/node_modules/a/index.js']) {
    const dir = project({ [own]: 'mine' });
    assert.throws(() => writeTree(dir, a), /is no tree bundle-lockfile wrote/, own);
    assert.equal(fs.readFileSync(J(dir, own), 'utf8'), 'mine', own);
    assert.deepEqual(fs.readdirSync(dir), ['packages'], own); // (nothing left aside)
  }
  const file = project({ packages: 'a file' });
  assert.throws(() => writeTree(file, a), /is no tree bundle-lockfile wrote/);
  // its own tree, and an empty directory, are replaced
  const dir = project({});
  fs.mkdirSync(J(dir, 'packages'));
  writeTree(dir, a);
  writeTree(dir, b);
  assert.deepEqual(fs.readdirSync(J(dir, 'packages')).flatMap(id => fs.readdirSync(J(dir, 'packages', id, 'node_modules'))), ['b']);
});

test('tree: a copy of a stub made with fs is no copy of a package file', () => {
  const copies = require('../../src/core/copies.cjs');
  const root = project({ 'dist/bundle-lockfile/packages/0123456789abcdef/node_modules/a/package.json': { name: 'a', version: '1.0.0' },
    'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const stub = J(root, 'dist/bundle-lockfile/packages/0123456789abcdef/node_modules/a/package.json');
  fs.mkdirSync(J(root, 'build'), { recursive: true });
  fs.copyFileSync(stub, J(root, 'build/x.json'));
  copies.record(stub, J(root, 'build/x.json'));
  assert.equal(copies.sourceOf(J(root, 'build/x.json')), null);
});

test('hashes: a file rewritten with the same size and modification time is hashed again (coarse timestamps, tools that set it)', () => {
  const hashes = require('../../src/core/hashes.cjs');
  const root = project({ 'out.js': 'one' });
  const f = J(root, 'out.js');
  const sha = (s) => `sha256-${crypto.createHash('sha256').update(s).digest('hex')}`;
  fs.utimesSync(f, 1e9, 1e9);
  assert.equal(hashes.hashOf(f), sha('one'));
  fs.writeFileSync(f, 'two');
  fs.utimesSync(f, 1e9, 1e9);
  assert.equal(fs.statSync(f).mtimeMs, 1e12);
  assert.equal(hashes.hashOf(f), sha('two'));
});

test('Yarn\'s pnpm linker (node_modules/.store/<slug>/package): its packages are listed, its bundlers are recognized', { skip: process.platform === 'win32' }, () => {
  const { logical } = require('../../src/core/layout.cjs');
  const esmWrap = require('../../src/esm-wrap.cjs');
  const S = 'node_modules/.store';
  const root = project({
    [`${S}/lodash-npm-4.17.21-abc/package/package.json`]: { name: 'lodash', version: '4.17.21', license: 'MIT' }, [`${S}/lodash-npm-4.17.21-abc/package/lodash.js`]: '',
    [`${S}/@scope-x-npm-1.0.0-def/package/package.json`]: { name: '@scope/x', version: '1.0.0' },
    [`${S}/rollup-npm-4.64.2-36b/package/package.json`]: { name: 'rollup', version: '4.64.2' },
    // its CommonJS build, as the rollup command line loads it
    [`${S}/rollup-npm-4.64.2-36b/package/dist/shared/rollup.js`]: "exports.version = '4.64.2'; exports.rollup = (o) => o.plugins.map(p => p.name); exports.rollupInternal = (o) => o.plugins.map(p => p.name);",
  });
  fs.symlinkSync('.store/lodash-npm-4.17.21-abc/package', J(root, 'node_modules/lodash'));
  const lodash = J(root, S, 'lodash-npm-4.17.21-abc/package');
  assert.equal(packageRoot(J(lodash, 'lodash.js')), lodash);
  assert.equal(packageRoot(lodash), null);
  const pkgs = packagesForFiles([J(lodash, 'lodash.js'), J(root, 'node_modules/lodash/lodash.js')]);
  assert.deepEqual(ids(pkgs), ['lodash@4.17.21']);
  // keyed by its location, which has its package.json
  assert.deepEqual(entries(toPackageLock(pkgs, root)).map(([k]) => k), [`${S}/lodash-npm-4.17.21-abc/package`]);
  // bundler files as if at node_modules/<name>
  assert.equal(logical(J(root, S, 'rollup-npm-4.64.2-36b/package/dist/es/rollup.js')), J(root, 'node_modules/rollup/dist/es/rollup.js'));
  assert.equal(logical(J(root, S, '@scope-x-npm-1.0.0-def/package/i.js')), J(root, 'node_modules/@scope/x/i.js'));
  assert.equal(logical(J(root, 'src/x.js')), J(root, 'src/x.js'));
  const rollupEntry = { id: 'rollup', suffixes: ['/rollup/dist/es/rollup.js'], wrap: ['rollup', 'watch'] };
  assert.equal(esmWrap.match(pathToFileURLHref(J(root, S, 'rollup-npm-4.64.2-36b/package/dist/es/rollup.js')), [rollupEntry]), rollupEntry);
  // Rollup's CommonJS build there is patched when it loads
  const r = nodeWith({ ...strictEnv(undefined), NODE_OPTIONS: '' }, ['--require', J(SRC, 'register.cjs'), '-e',
    `console.log(JSON.stringify(require(${JSON.stringify(J(root, S, 'rollup-npm-4.64.2-36b/package/dist/shared/rollup.js'))}).rollupInternal({ plugins: [] })))`]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['bundle-lockfile']);
});

// --- vendored copies

test('vendored: pnpm-workspace.yaml with Windows line endings; a private package.json in a vendored copy outside node_modules', () => {
  const vendored = require('../../src/core/vendored.cjs');
  assert.deepEqual(vendored.pnpmPackages('packages:\r\n  - "apps/*"\r\n  - libs/** # libraries\r\n'), ['apps/*', 'libs/**']);
  const root = project({
    'app/package.json': { name: 'app', version: '1.0.0', private: true },
    'vendor/preact/package.json': { name: 'preact', version: '10.28.3' }, 'vendor/preact/hooks/package.json': { name: 'preact-hooks', version: '0.1.0', private: true },
    'tools/shared/package.json': { name: 'shared', version: '1.0.0', private: true },
  });
  const { ownerOf } = vendored.scope({ context: J(root, 'app') });
  let owner;
  const noted = [];
  const orig = config.note;
  config.note = (...m) => noted.push(m.join(' '));
  try { owner = ownerOf(J(root, 'vendor/preact/hooks/dist/hooks.js')); } finally { config.note = orig; }
  assert.equal(owner && `${owner.name}@${owner.version}`, 'preact@10.28.3'); // the helper inside the copy is no boundary (as preact/hooks in node_modules)
  assert.equal(ownerOf(J(root, 'tools/shared/x.js')), null); // a private package with no copy around it: first-party
});

test('test helper: the canary check decodes data: URLs (base64 and percent-encoded)', () => {
  const { dataUrls, canaries } = require('../lib/check.cjs');
  const svg = "<svg><!-- BLCANARY:bl-canary-icon@1.0.0 --></svg>";
  const b64 = `url(data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')})`;
  const pct = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
  assert.deepEqual(dataUrls(`${b64} a ${pct} data:text/plain,%E0%A4%A`), [svg, svg]); // (a malformed one is skipped)
  const root = project({ 'dist/a.css': b64, 'dist/b.css': pct.replace('bl-canary-icon', 'bl-canary-other') });
  assert.deepEqual(canaries(J(root, 'dist')), ['bl-canary-icon@1.0.0', 'bl-canary-other@1.0.0']);
});

test('oracles/esm-entries: every installed copy of an entry against its wrapper, as Node.js loads both', () => {
  const es = (name, version, body, type = 'module') => ({
    [`${name}/package.json`]: { name: name.split('node_modules/').pop(), version, ...(type ? { type } : {}) },
    [`${name}/${name.endsWith('rspack/core') ? 'dist/index.js' : name.endsWith('rolldown') ? 'dist/index.mjs' : 'dist/es/rollup.js'}`]: body,
  });
  const root = project({
    ...es('node_modules/rollup', '4.0.0', 'export function rollup() {}\nexport function watch() {}\nexport const VERSION = "export default";\n'),
    // a copy of another version below another package (and pnpm's store), and one of a shape the adapter does not know
    ...es('node_modules/vite/node_modules/rollup', '3.0.0', 'export const VERSION = 3;\n'),
    ...es('node_modules/.pnpm/rolldown@1.0.0/node_modules/rolldown', '1.0.0', 'const r = /\\/*/; export function rolldown() {}\nexport default rolldown;\n'),
    // rspack 1: CommonJS at the path of rspack 2's entry, not wrapped
    ...es('node_modules/@rspack/core', '1.7.0', 'module.exports = {};\n', null),
  });
  const r = spawnSync(process.execPath, [J(TEST, 'oracles/esm-entries.cjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout).map(({ file, id, version, ok, error }) => ({ file: file.split(path.sep).join('/'), id, version, ok, error }));
  assert.deepEqual(got, [
    { file: 'node_modules/.pnpm/rolldown@1.0.0/node_modules/rolldown/dist/index.mjs', id: 'rolldown', version: '1.0.0', ok: true, error: undefined },
    { file: 'node_modules/rollup/dist/es/rollup.js', id: 'rollup', version: '4.0.0', ok: true, error: undefined },
    { file: 'node_modules/vite/node_modules/rollup/dist/es/rollup.js', id: 'rollup', version: '3.0.0', ok: false, error: 'none of rollup, watch is a function' },
  ]);
  assert.deepEqual(fs.readdirSync(root).filter(f => f.startsWith('.esm-entries-')), []); // its wrappers are gone
  fs.rmSync(root, { recursive: true, force: true });
});

test('traces: the .nft.json files of a distDir, not those of its caches and standalone copy; their files as absolute paths', () => {
  const root = project({
    '.next/next-server.js.nft.json': nft(['../node_modules/next/dist/server/next-server.js']),
    '.next/server/pages/index.js.nft.json': nft(['../../../node_modules/rt/index.js', '../chunks/1.js'], { fileHashes: {}, symlinks: {} }),
    '.next/cache/next-server.js.nft.json': 'not a trace',
    '.next/standalone/.next/server/pages/index.js.nft.json': nft([]),
    '.next/static/x.nft.json': nft([]),
  });
  const files = traces.traceFiles(J(root, '.next'));
  assert.deepEqual(files.map(f => path.relative(root, f).split(path.sep).join('/')), ['.next/next-server.js.nft.json', '.next/server/pages/index.js.nft.json']);
  assert.deepEqual(traces.filesOf(files[1]), [J(root, 'node_modules/rt/index.js'), J(root, '.next/server/chunks/1.js')]);
  assert.deepEqual(traces.traceFiles(J(root, 'none')), []);
  const bad = project({ 'a.nft.json': '{', 'b.nft.json': { version: 2, files: [] }, 'c.nft.json': { version: 1, files: 'x' } });
  assert.throws(() => traces.filesOf(J(bad, 'a.nft.json')), /could not read/);
  assert.throws(() => traces.filesOf(J(bad, 'b.nft.json')), /a trace of a version bundle-lockfile does not know \(2\)/);
  assert.throws(() => traces.filesOf(J(bad, 'c.nft.json')), /has no list of files/);
});

// Transpiler helpers inlined into modules (core/helpers.cjs): the names in the code after the loaders or plugins, not in
// the file; the transpiler copy the loader resolves (webpack) or this process loaded (Rollup, Vite, Rolldown)
test('helpers: Babel, swc and TypeScript helpers by their names; only those the file does not have count', () => {
  const helpers = require('../../src/core/helpers.cjs');
  // as the transpilers write them (babel-loader, swc-loader, ts-loader output on the workstation, 2026-10-14)
  const babel = 'function _classCallCheck(a, n) { if (!(a instanceof n)) throw new TypeError(); }\nfunction _typeof(o) {}\nvar A = function A() { _classCallCheck(this, A); };';
  const swc = 'function _class_call_check(instance, Constructor) {}\nfunction _inherits(a, b) {}\n';
  const ts = 'var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {};\nvar __extends = (this && this.__extends) || (function () {})();';
  const n = helpers.names(babel + swc + ts);
  assert.deepEqual([...n.babel], ['classCallCheck']);
  assert.deepEqual([...n.swc], ['class_call_check']);
  assert.deepEqual([...n.either].sort(), ['inherits', 'typeof']);
  assert.deepEqual([...n.typescript], ['__awaiter', '__extends']);
  const root = project({ 'src/a.js': 'export class A {}', 'src/own.js': 'function _classCallCheck() {}\nexport const x = 1;', 'src/plain.js': 'export const y = 2;' });
  assert.deepEqual([...helpers.inlined(babel, J(root, 'src/a.js'))].sort(), ['babel', 'either']);
  assert.deepEqual([...helpers.inlined(swc, J(root, 'src/a.js'))].sort(), ['either', 'swc']);
  assert.deepEqual([...helpers.inlined(ts, J(root, 'src/a.js'))], ['typescript']);
  // a package's own compiled helpers (in its file): no transpiler of this build wrote them
  assert.deepEqual([...helpers.inlined('function _classCallCheck() {}\nexport const x = 1;', J(root, 'src/own.js'))], []);
  // no helpers, a user function without the underscore shape, an unreadable file (virtual module): all its names count
  assert.deepEqual([...helpers.inlined('export const y = 2;', J(root, 'src/plain.js'))], []);
  assert.deepEqual([...helpers.inlined('function helper() {}', J(root, 'src/plain.js'))], []);
  assert.deepEqual([...helpers.inlined(babel, null)].sort(), ['babel', 'either']);
});

test('helpers: webpack modules list the transpiler copy their loader resolves; no loader of one, no look', () => {
  const helpers = require('../../src/core/helpers.cjs');
  const root = project({
    'node_modules/babel-loader/package.json': { name: 'babel-loader', version: '10.1.1' },
    'node_modules/babel-loader/lib/index.js': '',
    'node_modules/@babel/core/package.json': { name: '@babel/core', version: '7.29.7', main: 'lib/index.js' },
    'node_modules/@babel/core/lib/index.js': '',
    // @babel/core's own @babel/helpers, not the hoisted one: the copy that ran
    'node_modules/@babel/core/node_modules/@babel/helpers/package.json': { name: '@babel/helpers', version: '7.29.9', license: 'MIT' },
    'node_modules/@babel/helpers/package.json': { name: '@babel/helpers', version: '7.20.0', license: 'MIT' },
    'node_modules/ts-loader/package.json': { name: 'ts-loader', version: '9.6.2' },
    'node_modules/ts-loader/index.js': '',
    'node_modules/typescript/package.json': { name: 'typescript', version: '5.9.3', license: 'Apache-2.0' },
    'node_modules/my-tsc/package.json': { name: 'my-tsc', version: '1.0.0', license: 'MIT' },
    'src/a.js': 'export class A {}', 'src/t.ts': 'export class T {}', 'src/b.js': 'export const b = 1;',
  });
  const mod = (resource, loader, code, options) => ({ resource, loaders: loader ? [{ loader, options }] : [], originalSource: () => (code === null ? null : { source: () => code }), identifier: () => resource });
  const BL = J(root, 'node_modules/babel-loader/lib/index.js'), TL = J(root, 'node_modules/ts-loader/index.js');
  const idsAt = (list) => list.map(p => `${p.name}@${p.version} ${path.relative(root, p.path)}`).sort();
  const of = (mods) => idsAt(helpers.ofWebpackModules(mods, m => m.resource));
  assert.deepEqual(of([mod(J(root, 'src/a.js'), BL, 'function _classCallCheck(a, b) {}\nexport class A {}')]),
    ['@babel/helpers@7.29.9 node_modules/@babel/core/node_modules/@babel/helpers']);
  assert.deepEqual(of([mod(J(root, 'src/t.ts'), TL, 'var __awaiter = (this && this.__awaiter) || function () {};')]), ['typescript@5.9.3 node_modules/typescript']);
  assert.deepEqual(of([mod(J(root, 'src/t.ts'), TL, 'var __awaiter = (this && this.__awaiter) || function () {};', { compiler: 'my-tsc' })]), ['my-tsc@1.0.0 node_modules/my-tsc']);
  // babel-loader without inlined helpers (@babel/runtime imports: modules, listed as such), no transpiler loader
  assert.deepEqual(of([mod(J(root, 'src/b.js'), BL, 'import _c from "@babel/runtime/helpers/classCallCheck";')]), []);
  assert.deepEqual(of([mod(J(root, 'src/a.js'), null, 'function _classCallCheck(a, b) {}')]), []);
  // the code after the loaders is not there (rspack): the transpiler that ran counts
  assert.deepEqual(of([mod(J(root, 'src/a.js'), BL, null)]), ['@babel/helpers@7.29.9 node_modules/@babel/core/node_modules/@babel/helpers']);
  // Babel helpers in a module ts-loader compiled: no Babel ran on it
  assert.deepEqual(of([mod(J(root, 'src/a.js'), TL, 'function _classCallCheck(a, b) {}')]), []);
});

test('helpers: Rollup, Vite, Rolldown modules list the transpiler copies this process loaded, else the directory\'s', () => {
  const root = project({
    'node_modules/@babel/helpers/package.json': { name: '@babel/helpers', version: '7.29.9', license: 'MIT' },
    'node_modules/@babel/helpers/lib/index.js': 'module.exports = {};',
    'node_modules/@swc/core/package.json': { name: '@swc/core', version: '1.16.18', license: 'Apache-2.0' },
    'node_modules/typescript/package.json': { name: 'typescript', version: '5.9.3', license: 'Apache-2.0' },
    'src/a.js': 'export class A {}',
  });
  // a fresh process: the registry of loaded copies is per process
  const script = `
    const helpers = require(${JSON.stringify(J(SRC, 'core/helpers.cjs'))});
    const path = require('path'); const root = ${JSON.stringify(root)};
    const infos = { [path.join(root, 'src/a.js')]: { code: 'function _classCallCheck() {}\\nfunction _extends() {}\\nexport class A {}' },
      '\\0rollupPluginBabelHelpers.js': { code: 'function _defineProperty(e, r, t) {}' },
      [path.join(root, 'src/t.js')]: { code: 'var __awaiter = (this && this.__awaiter) || function () {};' } };
    const fileOf = (id) => (id.startsWith('\\0') ? null : id);
    const ids = (l) => l.map(p => p.name + '@' + p.version).sort();
    const run = (list) => ids(helpers.ofModuleIds(list, (id) => infos[id], fileOf, root));
    const out = {};
    out.notLoaded = run([path.join(root, 'src/a.js')]);       // Babel's from the directory; _extends (Babel or swc) alone would not add swc
    out.virtual = run(['\\0rollupPluginBabelHelpers.js']);      // @rollup/plugin-babel's bundled helpers module
    out.ts = run([path.join(root, 'src/t.js')]);
    helpers.seen(path.join(root, 'node_modules/@babel/helpers/lib/index.js'));
    out.loaded = run([path.join(root, 'src/a.js')]);
    console.log(JSON.stringify(out));`;
  const r = nodeWith(process.env, ['-e', script]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { notLoaded: ['@babel/helpers@7.29.9'], virtual: ['@babel/helpers@7.29.9'], ts: ['typescript@5.9.3'], loaded: ['@babel/helpers@7.29.9'] });
  // only one-word names (_extends), nothing loaded: no transpiler of the directory is listed for them
  const only = `const h = require(${JSON.stringify(J(SRC, 'core/helpers.cjs'))}); const f = ${JSON.stringify(J(root, 'src/a.js'))};
    console.log(JSON.stringify(h.ofModuleIds([f], () => ({ code: 'function _extends() {}' }), (id) => id, ${JSON.stringify(root)}).map(p => p.name)));`;
  const r2 = nodeWith(process.env, ['-e', only]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(JSON.parse(r2.stdout), []);
});
