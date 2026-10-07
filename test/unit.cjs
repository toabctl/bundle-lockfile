'use strict';
// Unit tests for the bundler-agnostic core and the adapter's detection logic. No network, no fixtures:
//   node --test test/unit.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { packageRoot, packagesForFiles } = require('../src/core/packages.cjs');
const { toPackageLock, lockfileForFiles } = require('../src/core/lockfile.cjs');
const webpack = require('../src/adapters/webpack.cjs');

const SRC = path.join(__dirname, '../src');
const PATCHED = Symbol.for('bundle-lockfile.webpack.patched');
const J = (...p) => path.join(...p);

// a temporary project: { 'node_modules/a/package.json': {...} | 'text', ... }; returns its real path
function project(files) {
  const root = fs.realpathSync(fs.mkdtempSync(J(os.tmpdir(), 'blr-unit-')));
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(J(root, f)), { recursive: true });
    fs.writeFileSync(J(root, f), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}
const ids = (pkgs) => pkgs.map(p => `${p.name}@${p.version}`).sort();
const entries = (json) => Object.entries(JSON.parse(json).packages).filter(([k]) => k);

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
});

test('packagesForFiles: one entry per package, nested manifests and first-party files ignored', () => {
  const root = project({
    'node_modules/a/package.json': { name: 'a', version: '1.0.0', license: 'MIT' },
    'node_modules/a/dist/esm/package.json': { type: 'module' },
    'node_modules/a/hooks/package.json': { name: 'a-hooks', version: '0.1.0' },
    'node_modules/@s/b/package.json': { name: '@s/b', version: '2.0.0' },
    'node_modules/a/node_modules/c/package.json': { name: 'c', version: '3.0.0' },
    'node_modules/noversion/package.json': { name: 'noversion' },
    'node_modules/broken/package.json': '{not json',
    'node_modules/alias/package.json': { name: 'real-name', version: '4.0.0' },
    'src/package.json': { name: 'app', version: '1.0.0' },
  });
  const pkgs = packagesForFiles([
    J(root, 'node_modules/a/index.js'), J(root, 'node_modules/a/dist/esm/x.js'), J(root, 'node_modules/a/hooks/index.js'),
    J(root, 'node_modules/@s/b/x.css') + '?inline', J(root, 'node_modules/a/node_modules/c/i.js'),
    J(root, 'node_modules/noversion/i.js'), J(root, 'node_modules/broken/i.js'), J(root, 'node_modules/alias/i.js'),
    J(root, 'src/index.js'), 'node_modules/a/relative.js', 'data:text/javascript,1', 'webpack/runtime/x',
  ]);
  assert.deepEqual(ids(pkgs), ['@s/b@2.0.0', 'a@1.0.0', 'c@3.0.0', 'real-name@4.0.0']);
  assert.equal(pkgs.find(p => p.name === 'a').path, J(root, 'node_modules/a'));
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

test('licenses: string, legacy object, legacy array; nothing usable means no license field', () => {
  const root = project({
    'node_modules/s/package.json': { name: 's', version: '1.0.0', license: 'MIT' },
    'node_modules/o/package.json': { name: 'o', version: '1.0.0', license: { type: 'ISC', url: 'x' } },
    'node_modules/l/package.json': { name: 'l', version: '1.0.0', licenses: [{ type: 'MIT' }, 'Apache-2.0', { url: 'x' }] },
    'node_modules/e/package.json': { name: 'e', version: '1.0.0', licenses: [] },
    'node_modules/n/package.json': { name: 'n', version: '1.0.0' },
  });
  const lock = JSON.parse(lockfileForFiles(['s', 'o', 'l', 'e', 'n'].map(n => J(root, 'node_modules', n, 'i.js')), root));
  assert.deepEqual(lock.packages, {
    '': {},
    'node_modules/e': { name: 'e', version: '1.0.0' },
    'node_modules/l': { name: 'l', version: '1.0.0', license: ['MIT', 'Apache-2.0'] },
    'node_modules/n': { name: 'n', version: '1.0.0' },
    'node_modules/o': { name: 'o', version: '1.0.0', license: 'ISC' },
    'node_modules/s': { name: 's', version: '1.0.0', license: 'MIT' },
  });
});

test('toPackageLock: lockfileVersion 3, unnamed root, keys relative to the context', () => {
  const ctx = J(path.sep, 'p');
  const json = toPackageLock([
    { name: 'ms', version: '2.1.3', path: J(ctx, 'node_modules/ms') },
    { name: 'ms', version: '2.0.0', path: J(ctx, 'node_modules/debug/node_modules/ms') },
    { name: 'ms', version: '2.0.0', path: J(ctx, 'node_modules/ms-old') },
    { name: 'x', version: '1.0.0', path: J(path.sep, 'q/node_modules/x') },
  ], ctx);
  const lock = JSON.parse(json);
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[''], {});
  assert.deepEqual(Object.keys(lock.packages), ['', 'node_modules/debug/node_modules/ms', 'node_modules/ms-old', 'node_modules/ms', '../q/node_modules/x']);
  assert.ok(json.endsWith('}\n'));
});

test('toPackageLock: keys are relative to the real context when the project path goes through a symlink', () => {
  const real = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const link = `${real}-link`;
  fs.symlinkSync(real, link, 'dir');
  // with resolve.symlinks (the default) webpack reports real paths, while the context may be the symlinked one
  assert.deepEqual(entries(lockfileForFiles([J(real, 'node_modules/a/i.js')], link)).map(([k]) => k), ['node_modules/a']);
});

test('toPackageLock: code-unit order, the same bytes under every locale', () => {
  const names = ['zod', 'aa-utils', 'Zed', 'ab', '@babel/runtime', 'yaml', 'x', 'ia', 'a.b', 'a-b'];
  const script = `const { toPackageLock } = require(${JSON.stringify(J(SRC, 'core/lockfile.cjs'))});
    process.stdout.write(toPackageLock(${JSON.stringify(names)}.map(n => ({ name: n, version: '1.0.0', path: '/p/node_modules/' + n })), '/p'));`;
  const out = {};
  for (const lc of ['C', 'en_US.UTF-8', 'da_DK.UTF-8', 'lt_LT.UTF-8']) {
    const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, LC_ALL: lc, LANG: lc }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    out[lc] = r.stdout;
  }
  assert.deepEqual(entries(out.C).map(([, p]) => p.name), [...names].sort());
  for (const lc of Object.keys(out)) assert.equal(out[lc], out.C, `output under ${lc} differs from LC_ALL=C`);
});

// a class that looks like webpack's Compiler
const fakeCompiler = () => class Compiler { compile() {} run() {} watch() {} newCompilation() {} isChild() { return false; } };

test('webpack adapter: patches webpack Compilers, not other classes called Compiler', () => {
  const W = fakeCompiler();
  webpack.onCjsLoad(W, './Compiler', () => '/p/node_modules/webpack/lib/Compiler.js');
  assert.equal(W.prototype[PATCHED], true);

  const NS = fakeCompiler();
  const ns = Object.assign(function webpack() {}, { Compiler: NS, Compilation: class {}, version: '5.0.0' });
  webpack.onCjsLoad(ns, 'webpack', () => '/p/node_modules/webpack/lib/index.js');
  assert.equal(NS.prototype[PATCHED], true);

  class Compiler { compile() {} } // e.g. snapdragon's
  webpack.onCjsLoad(Compiler, './compiler', () => '/p/node_modules/snapdragon/lib/compiler.js');
  assert.equal(Compiler.prototype[PATCHED], undefined);
});

test('webpack adapter: Next.js vendored webpack, whose exports are filled in by init()', () => {
  const where = '/p/node_modules/next/dist/compiled/webpack/webpack.js';
  // as next/dist/compiled/webpack/webpack.js: only init() at load time
  const C1 = fakeCompiler();
  const exp = { __esModule: true, init() { Object.assign(exp, { webpack: { Compiler: C1 } }); } };
  webpack.onCjsLoad(exp, 'next/dist/compiled/webpack/webpack', () => where);
  assert.equal(C1.prototype[PATCHED], undefined);
  exp.init();
  assert.equal(C1.prototype[PATCHED], true);
  webpack.onCjsLoad(exp, 'next/dist/compiled/webpack/webpack', () => where); // required again: init not wrapped twice
  exp.init();

  // already initialized when required (another copy of the module, or a later require)
  const C2 = fakeCompiler();
  webpack.onCjsLoad({ webpack: { Compiler: C2 } }, '../compiled/webpack/webpack', () => where);
  assert.equal(C2.prototype[PATCHED], true);

  // the same shape at any other path is ignored
  const C3 = fakeCompiler();
  webpack.onCjsLoad({ webpack: { Compiler: C3 } }, 'my-webpack', () => '/p/node_modules/my-webpack/index.js');
  assert.equal(C3.prototype[PATCHED], undefined);
});

// minimal webpack 5 compilation: chunks of modules, child compilations, assets with info
function compilation({ context, chunks, children = [], assets = {} }) {
  return {
    compiler: { context },
    chunks: chunks.map(c => ({ files: new Set(c.files || []), modules: c.modules })),
    chunkGraph: { getChunkModulesIterable: (chunk) => chunk.modules },
    children: children.map(compilation),
    getAsset: (name) => (name in assets ? { name, info: assets[name] } : undefined),
    getAssets: () => Object.entries(assets).map(([name, info]) => ({ name, info })),
  };
}

test('webpack adapter: chunks, concatenated modules, shipped child compilations and copied files', () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('chunk'), ...pj('inner'), ...pj('css'), ...pj('worker'), ...pj('nested'), ...pj('template'), ...pj('copied'), 'static/robots.txt': 'x' });
  const m = (name) => ({ resource: J(root, 'node_modules', name, 'i.js') });
  const c = compilation({
    context: root,
    chunks: [{ files: ['main.js'], modules: [m('chunk'), { modules: [m('inner')] }, { nameForCondition: () => J(root, 'node_modules/css/x.css') }, { resource: J(root, 'src/i.js') }] }],
    children: [
      // worker-loader: its chunk file was copied into the parent's assets; its own child likewise
      { context: root, chunks: [{ files: ['w.worker.js'], modules: [m('worker')] }],
        children: [{ context: root, chunks: [{ files: ['n.worker.js'], modules: [m('nested')] }] }] },
      // html-webpack-plugin: deleted its chunk file before it reached the parent
      { context: root, chunks: [{ files: ['__child-HtmlWebpackPlugin_0'], modules: [m('template')] }] },
    ],
    assets: {
      'main.js': {}, 'w.worker.js': {}, 'n.worker.js': {},
      'vendor/copied.js': { copied: true, sourceFilename: 'node_modules/copied/i.js' },
      'robots.txt': { copied: true, sourceFilename: 'static/robots.txt' },
    },
  });
  const lock = new webpack.BundleLockfilePlugin('bundle-lockfile/package-lock.json').lockfile(c);
  assert.deepEqual(entries(lock).map(([k]) => k).sort(), ['chunk', 'copied', 'css', 'inner', 'nested', 'worker'].map(n => `node_modules/${n}`));
});

test('hooks: a throwing adapter is reported and does not break require()', () => {
  const script = `const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
    hooks.register({ name: 'boom', onCjsLoad() { throw new Error('boom'); } });
    hooks.install(); hooks.install();
    console.log(require('path').join('a', 'b'));`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), J('a', 'b'));
  assert.match(r.stderr, /\[bundle-lockfile\] WARNING: boom adapter failed while inspecting path/);
});

test('register: BUNDLE_LOCKFILE_DISABLE=all installs no hooks', () => {
  const script = `const M = require('module'); const before = M._load; require(${JSON.stringify(J(SRC, 'register.cjs'))}); console.log(M._load === before);`;
  for (const [disable, untouched] of [['all', 'true'], ['webpack', 'true'], ['', 'false']]) {
    const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, BUNDLE_LOCKFILE_DISABLE: disable }, encoding: 'utf8' });
    assert.equal(r.stdout.trim(), untouched, `BUNDLE_LOCKFILE_DISABLE=${disable}: ${r.stderr}`);
  }
});
