'use strict';
// Unit tests for the bundler-agnostic core and the adapter's detection logic. No network, no fixtures:
//   node --test test/unit.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const packages = require('../src/core/packages.cjs');
const { packageRoot, packagesForFiles, unvirtual } = packages;
const { toPackageLock, lockfileForFiles } = require('../src/core/lockfile.cjs');
const crypto = require('crypto');
const outputs = require('../src/core/outputs.cjs');
const config = require('../src/core/config.cjs');
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
const pkg = (name, version, dir) => ({ name, version, path: dir });
// runs fn with config.warn recorded; returns the messages
function warnings(fn) {
  const orig = config.warn, seen = [];
  config.warn = (...a) => seen.push(a.join(' '));
  try { fn(); } finally { config.warn = orig; }
  return seen;
}
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
  const ctx = J(path.sep, 'p', 'app');
  const json = toPackageLock([
    pkg('ms', '2.1.3', J(ctx, 'node_modules/ms')),
    pkg('ms', '2.0.0', J(ctx, 'node_modules/debug/node_modules/ms')),
    pkg('ms', '2.0.0', J(ctx, 'node_modules/ms-old')),
    pkg('y', '1.0.0', J(ctx, '.yarn/cache/y-npm-1.0.0-abc.zip/node_modules/y')), // Yarn PnP, project cache
    pkg('h', '1.0.0', J(ctx, '../node_modules/h')),                              // hoisted above the context
  ], ctx);
  const lock = JSON.parse(json);
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[''], {});
  assert.deepEqual(Object.keys(lock.packages), ['', '../node_modules/h', 'node_modules/debug/node_modules/ms', 'node_modules/ms-old', 'node_modules/ms',
    '.yarn/cache/y-npm-1.0.0-abc.zip/node_modules/y']);
  assert.ok(json.endsWith('}\n'));
});

test('toPackageLock: packages outside the project get keys without their machine-specific path', () => {
  // Yarn's global cache in the home directory: the same build on two machines must write the same bytes
  const build = (home) => toPackageLock([
    pkg('ms', '2.1.3', J(home, '.yarn/berry/cache/ms-npm-2.1.3-x.zip/node_modules/ms')),
    pkg('ms', '2.0.0', J(home, '.yarn/berry/cache/ms-npm-2.0.0-y.zip/node_modules/ms')),
    pkg('debug', '2.6.9', J(home, '.yarn/berry/cache/debug-npm-2.6.9-z.zip/node_modules/debug')),
    pkg('ms', '2.1.3', J(home, '.yarn/berry/cache/ms-npm-2.1.3-copy.zip/node_modules/ms')),
    pkg('a', '1.0.0', J(home, 'proj/node_modules/a')),
    pkg('b', '1.0.0', J(home, 'store/b@1.0.0/node_modules/b')),
  ], J(home, 'proj'));
  const one = build(J(path.sep, 'home', 'alice')), other = build(J(path.sep, 'builds', 'ci', 'job-1234'));
  assert.equal(one, other);
  assert.deepEqual(Object.entries(JSON.parse(one).packages).map(([k, p]) => `${k} = ${p.name ? `${p.name}@${p.version}` : ''}`), [
    ' = ', 'node_modules/a = a@1.0.0', 'node_modules/b = b@1.0.0', 'node_modules/debug = debug@2.6.9',
    'node_modules/ms = ms@2.0.0', 'node_modules/ms@2.1.3 = ms@2.1.3', 'node_modules/ms@2.1.3-2 = ms@2.1.3']);
  // a real node_modules/<name> keeps its key; the outside copy of the same name gets the next free one
  const mixed = JSON.parse(toPackageLock([pkg('a', '0.1.0', J(path.sep, 'cache/a@0.1.0/node_modules/a')), pkg('a', '1.0.0', J(path.sep, 'p/node_modules/a'))], J(path.sep, 'p')));
  assert.deepEqual(Object.keys(mixed.packages), ['', 'node_modules/a@0.1.0', 'node_modules/a']);
  // a context inside a package: never the root key ""
  const inside = JSON.parse(toPackageLock([pkg('a', '1.0.0', J(path.sep, 'p/node_modules/a'))], J(path.sep, 'p/node_modules/a/sub')));
  assert.deepEqual(Object.keys(inside.packages), ['', 'node_modules/a']);
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

// minimal webpack 5 compilation: chunks of modules (entry: the chunk's entry modules), child compilations,
// assets with info
let outputDirs = 0;
function compilation({ context, outputPath = J(context, `dist-${++outputDirs}`), chunks, children = [], assets = {}, clean }) {
  return {
    compiler: { context, outputPath },
    outputOptions: { clean },
    chunks: chunks.map(c => ({ files: new Set(c.files || []), modules: c.modules, entry: c.entry || [] })),
    chunkGraph: { getChunkModulesIterable: (chunk) => chunk.modules, getChunkEntryModulesIterable: (chunk) => chunk.entry },
    moduleGraph: { getIssuer: (m) => m.issuer },
    children: children.map(c => compilation({ context, ...c })),
    getAsset: (name) => (name in assets ? { name, info: assets[name] } : undefined),
    getAssets: () => Object.entries(assets).map(([name, info]) => ({ name, info })),
  };
}
// the same in webpack 4's shape: chunk.modulesIterable / chunk.entryModule, assets as an object, no getAsset(s)
function compilation4({ context, chunks, children = [], assets = {} }) {
  return {
    compiler: { context, outputPath: J(context, `dist-${++outputDirs}`) },
    outputOptions: {},
    chunks: chunks.map(c => ({ files: c.files || [], modulesIterable: new Set(c.modules), entryModule: (c.entry || [])[0] })),
    children: children.map(c => compilation4({ context, ...c })),
    assets: Object.fromEntries(Object.keys(assets).map(n => [n, {}])),
  };
}
const LOCK = 'bundle-lockfile/package-lock.json';
const WRITER = Symbol.for('bundle-lockfile.webpack.writer');
const plugin = () => new webpack.BundleLockfilePlugin(LOCK);
const lockedNames = (json) => entries(json).map(([k]) => k.replace(/^node_modules\//, '')).sort();

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
  assert.deepEqual(lockedNames(plugin().lockfile(c)), ['chunk', 'copied', 'css', 'inner', 'nested', 'worker']);
});

test('webpack adapter: inlined child compilations count, build-time ones do not', () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('app'), ...pj('inline'), ...pj('nested-inline'), ...pj('template'), ...pj('unused') });
  const m = (name) => ({ resource: J(root, 'node_modules', name, 'i.js') });
  const src = (file) => ({ resource: J(root, 'src', file) });
  const build = (shape) => shape({
    context: root,
    // src/w.js is the parent module "worker-loader?inline=no-fallback!./w.js": it embeds the worker's code
    chunks: [{ files: ['main.js'], modules: [m('app'), src('w.js')] }],
    children: [
      // worker-loader inline: the chunk file was taken out of the parent, the child kept it; its entry is src/w.js.
      // It inlines a worker of its own the same way.
      { chunks: [{ files: ['w.worker.js'], entry: [src('w.js')], modules: [src('w.js'), m('inline'), src('n.js')] }],
        assets: { 'w.worker.js': {} },
        children: [{ chunks: [{ files: ['n.worker.js'], entry: [src('n.js')], modules: [src('n.js'), m('nested-inline')] }], assets: { 'n.worker.js': {} } }] },
      // html-webpack-plugin 4: also taken out of the parent and kept in the child, but the template is no module of the parent
      { chunks: [{ files: ['__child-HtmlWebpackPlugin_0'], entry: [src('index.html')], modules: [src('index.html'), m('template')] }],
        assets: { '__child-HtmlWebpackPlugin_0': {} } },
      // a build-time child that deleted its own output (html-webpack-plugin 5, mini-css-extract), same entry as a shipped module
      { chunks: [{ files: ['x.js'], entry: [src('w.js')], modules: [src('w.js'), m('unused')] }] },
    ],
    assets: { 'main.js': {} },
  });
  assert.deepEqual(lockedNames(plugin().lockfile(build(compilation))), ['app', 'inline', 'nested-inline']);
  assert.deepEqual(lockedNames(plugin().lockfile(build(compilation4))), ['app', 'inline', 'nested-inline']);
});

test("webpack adapter: a module is the file webpack names it by (match resource), not the placeholder it reads", () => {
  const root = project({ 'node_modules/tool/package.json': { name: 'tool', version: '1.0.0' }, 'node_modules/lib/package.json': { name: 'lib', version: '1.0.0' } });
  const c = compilation({
    context: root,
    chunks: [{ files: ['main.js'], modules: [
      // "<root>/src/x.css.ts.vanilla.css!=!<loader>!tool/extracted.js": nameForCondition() is the match resource
      { resource: J(root, 'node_modules/tool/extracted.js'), nameForCondition: () => J(root, 'src/x.css.ts.vanilla.css') },
      { resource: J(root, 'node_modules/tool/other.js'), nameForCondition: () => 'src/x.vanilla.css' }, // relative match resource
      { resource: `${J(root, 'node_modules/lib/i.js')}?q`, nameForCondition: () => J(root, 'node_modules/lib/i.js') },
      { nameForCondition: () => null }, // an external module
      // mini-css-extract's CssModule for the CSS that module produced: named by the placeholder, issued by the module
      { nameForCondition: () => J(root, 'node_modules/tool/extracted.js'),
        issuer: { resource: `${J(root, 'node_modules/tool/extracted.js')}?x`, nameForCondition: () => J(root, 'src/x.css.ts.vanilla.css') } },
      // CSS from a package, @imported by a first-party file: it keeps its own file
      { nameForCondition: () => J(root, 'node_modules/lib/x.css'), issuer: { resource: J(root, 'src/app.css'), nameForCondition: () => J(root, 'src/app.css') } },
    ] }],
    assets: { 'main.js': {} },
  });
  assert.deepEqual(lockedNames(plugin().lockfile(c)), ['lib']);
});

test('webpack adapter: compilers writing to the same output dir share one lockfile', () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c') });
  const m = (name) => ({ resource: J(root, 'node_modules', name, 'i.js') });
  const outputPath = J(root, 'dist');
  const one = (name, opts = {}) => compilation({ context: root, outputPath, chunks: [{ files: [`${name}.js`], modules: [m(name)] }], ...opts });
  const ca = one('a'), cb = one('b');
  ca.compiler.name = 'a'; cb.compiler.name = 'b'; // two configs of an array
  const p = plugin();
  const build = (c) => { const json = p.lockfile(c); outputs.emitted(J(outputPath, LOCK), c.compiler[WRITER]); return json; }; // and lands
  assert.deepEqual(lockedNames(build(ca)), ['a']);
  assert.deepEqual(lockedNames(build(cb)), ['a', 'b']);
  // a rebuild of one compiler (watch mode) replaces only its own packages
  const rebuilt = one('c');
  rebuilt.compiler = ca.compiler; // same compiler, next compilation
  assert.deepEqual(lockedNames(build(rebuilt)), ['b', 'c']);
  // output.clean options alone drop nothing: only files that are really gone do (see the prune tests)
  const cleaned = one('a', { clean: true });
  cleaned.compiler = ca.compiler;
  assert.deepEqual(lockedNames(build(cleaned)), ['a', 'b']);
});

test('webpack adapter: output.path placeholders are resolved: compilers whose paths resolve to different directories share nothing', () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b') });
  const outputPath = J(root, 'dist/[fullhash]');
  const one = (name) => {
    const c = compilation({ context: root, outputPath, chunks: [{ files: [`${name}.js`], modules: [{ resource: J(root, 'node_modules', name, 'i.js') }] }] });
    c.getPath = (p, data) => (assert.deepEqual(data, {}), p.replace('[fullhash]', `hash-${name}`)); // webpack 4 and 5: compilation.getPath
    return c;
  };
  const p = plugin();
  for (const name of ['a', 'b']) {
    const c = one(name);
    assert.deepEqual(lockedNames(p.lockfile(c)), [name]);
    outputs.emitted(J(root, `dist/hash-${name}`, LOCK), c.compiler[WRITER]);
    assert.equal(outputs.isShared(J(root, `dist/hash-${name}`, LOCK)), false);
  }
});

test('webpack adapter: a new compiler for the same config replaces the previous one in a shared lockfile', () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c'), ...pj('d') });
  const outputPath = J(root, 'dist');
  const build = (dep, options) => {
    const c = compilation({ context: root, outputPath, chunks: [{ files: ['x.js'], modules: [{ resource: J(root, 'node_modules', dep, 'i.js') }] }] });
    c.compiler.options = options;
    const json = plugin().lockfile(c);
    outputs.emitted(J(outputPath, LOCK), c.compiler[WRITER]);
    return json;
  };
  const app = { entry: { main: { import: ['./src/app.js'] } }, output: { filename: '[name].js' } };
  const sw = { entry: { sw: { import: ['./src/sw.js'] } }, target: 'webworker', output: { filename: '[name].js' } };
  assert.deepEqual(lockedNames(build('a', app)), ['a']);
  assert.deepEqual(lockedNames(build('b', sw)), ['a', 'b']);       // another config, same directory: both
  assert.deepEqual(lockedNames(build('c', { ...app })), ['b', 'c']); // the app built again by a new compiler: replaces a
  // dynamic entries cannot be compared: every such compiler is a writer of its own
  const fn = { ...app, entry: () => ({}) };
  assert.deepEqual(lockedNames(build('a', fn)), ['a', 'b', 'c']);
  // so are entries that cannot be serialized
  assert.deepEqual(lockedNames(build('d', { ...app, entry: { main: { import: ['./src/app.js'], n: 1n } } })), ['a', 'b', 'c', 'd']);
});

test('webpack adapter: a compiler for the same config that is still running is another writer, e.g. of a config array', () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c') });
  // two configs differing only in resolve.alias, writing [contenthash] names to one directory
  const options = { entry: { main: { import: ['./src/app.js'] } }, output: { filename: '[name].[contenthash].js' } };
  const shutdownHook = () => { const fns = []; return { tap: (o, fn) => fns.push(fn), call: () => fns.forEach(fn => fn()) }; };
  for (const version of ['webpack >= 5.17', 'webpack < 5.17']) {
    const outputPath = J(root, version.includes('>=') ? 'dist-closed' : 'dist-running');
    const build = (dep) => {
      const c = compilation({ context: root, outputPath, chunks: [{ files: [`${dep}.js`], modules: [{ resource: J(root, 'node_modules', dep, 'i.js') }] }] });
      Object.assign(c.compiler, { options, running: true }, version === 'webpack >= 5.17' && { hooks: { shutdown: shutdownHook() } });
      const json = plugin().lockfile(c);
      outputs.emitted(J(outputPath, LOCK), c.compiler[WRITER]);
      return { compiler: c.compiler, names: lockedNames(json) };
    };
    const first = build('a');
    assert.deepEqual(first.names, ['a'], version);
    assert.deepEqual(build('b').names, ['a', 'b'], version); // the first one has not finished: both are in the directory
    // the first compiler is done (closed; webpack < 5.17: not running): a new compiler for the same config replaces it
    first.compiler.running = false;
    if (version === 'webpack >= 5.17') {
      // finished but not closed, e.g. a config array built one after another (dependencies, parallelism: 1)
      assert.deepEqual(build('c').names, ['a', 'b', 'c'], `${version}: finished, not closed`);
      first.compiler.hooks.shutdown.call();
    }
    assert.deepEqual(build('c').names, ['b', 'c'], version);
  }
});

test('outputs: prune drops other writers whose files are all gone, once their build has landed', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c'), ...pj('d'), ...pj('e'), 'dist/b.js': '', 'dist/c2.js': '' });
  const target = J(root, 'dist/bundle-lockfile/package-lock.json');
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const exists = (f, cb) => setImmediate(cb, fs.existsSync(f));
  const prune = (writer) => new Promise(resolve => outputs.prune(target, writer, exists, resolve));
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
  // nothing to check: done at once
  let done = false;
  outputs.prune(J(root, 'other/package-lock.json'), 'a', exists, () => (done = true));
  assert.equal(done, true);
});

test('outputs: a build that is never written (it failed) does not replace the packages of the output in the directory', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c') });
  const target = J(root, 'dist/bundle-lockfile/package-lock.json');
  const [a, b, c] = ['a', 'b', 'c'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const rewrite = () => new Promise(resolve => outputs.rewrite(target, (json, cb) => { resolve(lockedNames(json)); cb(); }, () => {}));
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

// runs fn with config fields set (they are read when used); restores them afterwards
async function withConfig(fields, fn) {
  const saved = Object.fromEntries(Object.keys(fields).map(k => [k, config[k]]));
  Object.assign(config, fields);
  try { return await fn(); } finally { Object.assign(config, saved); }
}

test('outputs: the export path mirrors the lockfile path below the export dir', () => withConfig({ exportDir: '/x/export', exportBase: null }, () => {
  assert.equal(outputs.exportPath('/srv/app/dist/bundle-lockfile/package-lock.json'), '/x/export/srv/app/dist/bundle-lockfile/package-lock.json');
  assert.equal(outputs.exportPath('/srv/app/../app/dist/l/package-lock.json'), '/x/export/srv/app/dist/l/package-lock.json');
  config.exportBase = '/srv/app';
  assert.equal(outputs.exportPath('/srv/app/dist/bundle-lockfile/package-lock.json'), '/x/export/dist/bundle-lockfile/package-lock.json');
  assert.equal(outputs.exportPath('/srv/other/dist/bundle-lockfile/package-lock.json'), '/x/export/srv/other/dist/bundle-lockfile/package-lock.json'); // not below the base
  config.exportDir = null;
  assert.equal(outputs.exportPath('/srv/app/dist/bundle-lockfile/package-lock.json'), null);
}));

test('webpack adapter: BUNDLE_LOCKFILE_EXPORT_DIR gets every lockfile; BUNDLE_LOCKFILE_INLINE=0 keeps it out of the output', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b') });
  const exportDir = J(root, 'export');
  for (const inline of [false, true]) {
    const outputPath = J(root, `dist-${inline}`);
    fs.mkdirSync(outputPath);
    await withConfig({ exportDir, exportBase: root, inline }, async () => {
      const emitted = [];
      const build = sharedCompiler(root, outputPath, 'a', (name) => emitted.push(name));
      await build();
      const exported = J(exportDir, `dist-${inline}`, LOCK);
      assert.deepEqual(lockedNames(fs.readFileSync(exported, 'utf8')), ['a'], `inline=${inline}`);
      assert.deepEqual(emitted, inline ? [LOCK] : [], `inline=${inline}: lockfile asset`);
      // a second compiler into the same dir: the export copy has both, the inline file is written only if inline
      await sharedCompiler(root, outputPath, 'b')();
      assert.deepEqual(lockedNames(fs.readFileSync(exported, 'utf8')), ['a', 'b'], `inline=${inline}`);
      assert.equal(fs.existsSync(J(outputPath, LOCK)), inline, `inline=${inline}: inline file`);
    });
  }
});

test('outputs: a lockfile on disk keeps the packages other processes put there, while their files are there', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c'), 'dist/b.js': 'b' });
  const target = J(root, 'dist', LOCK);
  const [a, b, c] = ['a', 'b', 'c'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const writeFile = (json, cb) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, json); cb(); };
  const rewrite = () => new Promise(resolve => outputs.rewrite(target, writeFile, resolve)).then(() => fs.readFileSync(target, 'utf8'));
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
      outputs.rewrite(target, process.env.BUNDLE_LOCKFILE_INLINE === '0' ? null : (json, cb) => fs.writeFile(target, json, cb), (err) => { if (err) throw err; }); },
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

test('webpack adapter: a compiler whose output.clean deleted another compiler\'s files drops its packages', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b') });
  const outputPath = J(root, 'dist');
  const lock = J(outputPath, LOCK);
  fs.mkdirSync(outputPath);
  const buildA = sharedCompiler(root, outputPath, 'a'), buildB = sharedCompiler(root, outputPath, 'b');
  await buildB();
  await buildA();
  assert.deepEqual(lockedNames(fs.readFileSync(lock, 'utf8')), ['a', 'b']);
  // a watch rebuild of a, which with output.clean deletes only its own stale files: b stays
  await buildA();
  assert.deepEqual(lockedNames(fs.readFileSync(lock, 'utf8')), ['a', 'b']);
  // a new build of a whose output.clean deleted b's file (as on a first build): b is dropped
  fs.rmSync(J(outputPath, 'b.js'));
  await buildA();
  assert.deepEqual(lockedNames(fs.readFileSync(lock, 'utf8')), ['a']);
  // b builds again: listed again
  await buildB();
  assert.deepEqual(lockedNames(fs.readFileSync(lock, 'utf8')), ['a', 'b']);
});

test('webpack adapter: a compiler\'s files are those it wrote, also when a plugin replaced its assets in the emit hook', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b') });
  const outputPath = J(root, 'dist');
  const lock = J(outputPath, LOCK);
  fs.mkdirSync(outputPath);
  // compression-webpack-plugin 6 with deleteOriginalAssets on webpack 4: a.js is replaced by a.js.gz in the emit hook,
  // after the lockfile was rendered
  await sharedCompiler(root, outputPath, 'a')({ 'a.js': null }, { 'a.js.gz': 'a.js.gz' });
  await sharedCompiler(root, outputPath, 'b')(); // a's output is still there: its packages stay
  assert.deepEqual(lockedNames(fs.readFileSync(lock, 'utf8')), ['a', 'b']);
  const files = JSON.parse(fs.readFileSync(lock, 'utf8'))['bundle-lockfile'].writers.map(w => w.files).sort();
  assert.deepEqual(files, [['../a.js.gz'], ['../b.js']]); // what another process checks
});

test('webpack adapter: a compiler\'s files are those webpack writes: asset names without query or fragment, symbolic links', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('query'), ...pj('hash'), ...pj('oldhash'), ...pj('link'), ...pj('last') });
  const outputPath = J(root, 'dist');
  const lock = J(outputPath, LOCK);
  fs.mkdirSync(outputPath);
  // asset name -> file webpack writes (null: written below)
  await sharedCompiler(root, outputPath, 'query')({ 'query.js?v=1a2b': 'query.js' });          // output.filename: '[name].js?v=[contenthash]'
  await sharedCompiler(root, outputPath, 'hash')({ 'hash.js#x?v=1': 'hash.js' });              // webpack >= 5.104 cuts at "#" too
  await sharedCompiler(root, outputPath, 'oldhash')({ 'oldhash.js#x?v=1': 'oldhash.js#x' });   // older versions keep it
  fs.symlinkSync('../not-built-yet.js', J(outputPath, 'link.js'));                             // a symbolic link asset whose target is missing
  await sharedCompiler(root, outputPath, 'link')({ 'link.js': null });
  await sharedCompiler(root, outputPath, 'last')();
  assert.deepEqual(lockedNames(fs.readFileSync(lock, 'utf8')), ['hash', 'last', 'link', 'oldhash', 'query']);
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
  const slow = (json, cb) => setTimeout(() => { written.push(json); cb(new Error('disk full')); }, 20);
  const fast = (json, cb) => { written.push(json); cb(); };
  const errors = await Promise.all([
    new Promise(resolve => outputs.rewrite(target, slow, resolve)),
    new Promise(resolve => { outputs.record(target, 'w2', [a, b], J(root, 'sub')); outputs.emitted(target, 'w2'); outputs.rewrite(target, fast, resolve); }),
    new Promise(resolve => outputs.rewrite(target, () => { throw new Error('sync'); }, resolve)),
  ]);
  assert.deepEqual(errors.map(e => e && e.message), ['disk full', undefined, 'sync']);
  assert.equal(written.length, 2);
  assert.deepEqual(entries(written[1]).map(([k]) => k), ['node_modules/a', 'node_modules/b']);
});

// webpack-like compiler for apply(): records taps, runs them on demand
function fakeCompiler5({ outputPath, withWebpack = true }) {
  const taps = {};
  const hook = (name) => ({ tap: (o, fn) => (taps[name] = fn), tapAsync: (o, fn) => (taps[name] = fn) });
  const compiler = {
    context: path.dirname(outputPath), outputPath, name: 'fake',
    hooks: { thisCompilation: hook('thisCompilation'), emit: hook('emit'), afterEmit: hook('afterEmit') },
    outputFileSystem: { writeFile: (f, c, cb) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); cb(); } },
  };
  if (withWebpack) compiler.webpack = { sources: { RawSource: class { constructor(s) { this.s = s; } source() { return this.s; } } } };
  return { compiler, taps };
}

// A compiler writing to outputPath through the plugin's real hooks (webpack 5 shape). Returns build(assets),
// which "emits" by writing the asset files (asset name -> file name on disk; null: none) and resolves once
// afterEmit has finished. Default: one asset <name>.js. Its module is in node_modules/<name>. onEmitAsset(name):
// called for assets the plugin emits. emitted: the assets after the emit hook, if a plugin replaced them there (asset
// name -> file name on disk).
function sharedCompiler(root, outputPath, name, onEmitAsset = () => {}) {
  const { compiler, taps } = fakeCompiler5({ outputPath });
  compiler.name = name;
  Object.assign(compiler.outputFileSystem, { stat: fs.stat, lstat: fs.lstat });
  compiler.options = { entry: { main: { import: [`./src/${name}.js`] } } };
  new webpack.BundleLockfilePlugin(LOCK).apply(compiler);
  return async (assets = { [`${name}.js`]: `${name}.js` }, emitted = assets) => {
    const infos = Object.fromEntries(Object.keys(assets).map(n => [n, {}]));
    const comp = compilation({ context: root, outputPath, chunks: [{ files: Object.keys(assets), modules: [{ resource: J(root, 'node_modules', name, 'i.js') }] }],
      assets: infos });
    comp.compiler = compiler;
    comp.emitAsset = (file) => onEmitAsset(file);
    comp.hooks = { afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) } };
    taps.thisCompilation(comp);
    comp.stage();
    for (const n of Object.keys(infos)) if (!(n in emitted)) delete infos[n]; // the emit hook
    for (const n of Object.keys(emitted)) infos[n] = infos[n] || {};
    for (const file of Object.values(emitted)) if (file) fs.writeFileSync(J(outputPath, file), '');
    await new Promise(resolve => taps.afterEmit(comp, resolve));
  };
}

test('webpack adapter: plugin emits in webpack 5 and 4 (also without webpack-sources), injection skips a configured plugin', () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  for (const withWebpack of [true, false]) {
    const { compiler, taps } = fakeCompiler5({ outputPath: J(root, `out-${withWebpack}`), withWebpack });
    const comp = compilation({ context: root, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }] });
    comp.compiler = compiler;
    const emitted = {};
    comp.emitAsset = (file, src) => { emitted[file] = src.source(); };
    comp.getAsset = (file) => (file in emitted ? { name: file } : undefined);
    let stageTap;
    // webpack 5: after processAssets, whose additionalAssets taps would process the lockfile too; webpack 4: afterOptimizeAssets
    comp.hooks = withWebpack
      ? { processAssets: { tap() { throw new Error('emitted in processAssets'); } }, afterProcessAssets: { tap: (o, fn) => (stageTap = fn) } }
      : { afterOptimizeAssets: { tap: (o, fn) => (stageTap = fn) } };
    new webpack.BundleLockfilePlugin(LOCK).apply(compiler); // webpack 4: no compilerFile, webpack-sources not found
    taps.thisCompilation(comp);
    stageTap();
    const json = emitted[LOCK];
    assert.deepEqual(entries(json).map(([k]) => k), ['node_modules/a'], `withWebpack=${withWebpack}`);
    // a plugin deleted it in the emit hook (compression-webpack-plugin with deleteOriginalAssets on webpack 4): put back
    delete emitted[LOCK];
    taps.emit(comp);
    assert.equal(emitted[LOCK], json, `withWebpack=${withWebpack}`);
    taps.emit(comp); // still there: left alone
    let done = false;
    taps.afterEmit(comp, () => (done = true)); // not shared: no extra write, continues at once
    assert.equal(done, true);
    assert.equal(compiler[Symbol.for('bundle-lockfile.webpack.applied')], true);
  }
});

test('webpack adapter: files copied in the emit hook (copy-webpack-plugin 5) count as the package files whose bytes they have', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('copied'), ...pj('other'), ...pj('empty'), ...pj('named'),
    'node_modules/copied/x.css': 'body{}', 'node_modules/other/z.css': 'BODY{}', 'node_modules/empty/e.css': '', 'src/robots.txt': 'x' });
  const dep = (f) => J(root, f);
  const DEPS = [dep('node_modules/a/i.js'), dep('node_modules/copied/x.css'), dep('node_modules/other/z.css'), dep('node_modules/empty/e.css'), dep('src/robots.txt')];
  for (const shape of ['webpack 4', 'webpack 5']) {
    const outputPath = J(root, shape === 'webpack 4' ? 'dist4' : 'dist5');
    const { compiler, taps } = fakeCompiler5({ outputPath, withWebpack: shape === 'webpack 5' });
    compiler.outputFileSystem.readFile = fs.readFile;
    new webpack.BundleLockfilePlugin(LOCK).apply(compiler);
    // late: assets the emit hook adds (name -> [content, info]); deps: the compilation's file dependencies
    const build = async (late, deps = DEPS) => {
      const comp = {
        compiler, chunks: [{ files: ['main.js'], modulesIterable: [{ resource: dep('node_modules/a/i.js') }] }], children: [],
        fileDependencies: new Set(deps),
        hooks: { afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) }, afterOptimizeAssets: { tap: (o, fn) => (comp.stage = fn) } },
      };
      let add, sourceOf;
      if (shape === 'webpack 4') { // assets: an object of sources, no asset info (webpack < 4.40), no emitAsset
        comp.assets = {};
        add = (name, source) => { comp.assets[name] = source; };
        sourceOf = (name) => comp.assets[name];
      } else {
        const assets = new Map();
        add = (name, source, info = {}) => assets.set(name, { name, source, info });
        sourceOf = (name) => assets.get(name).source;
        Object.assign(comp, { emitAsset: add, getAsset: (name) => assets.get(name), getAssets: () => [...assets.values()] });
      }
      add('main.js', { source: () => 'main' });
      taps.thisCompilation(comp);
      comp.stage();
      for (const [name, [content, info]] of Object.entries(late)) {
        // webpack 5 keeps only the size of emitted assets: the content is read from the output
        add(name, shape === 'webpack 5' ? { source() { throw new Error('size only'); } } : { source: () => content }, info);
        fs.mkdirSync(path.dirname(J(outputPath, name)), { recursive: true });
        fs.writeFileSync(J(outputPath, name), content);
      }
      fs.mkdirSync(J(outputPath, 'bundle-lockfile'), { recursive: true });
      fs.writeFileSync(J(outputPath, LOCK), sourceOf(LOCK).source()); // webpack writes the lockfile asset
      await new Promise(resolve => taps.afterEmit(comp, resolve));
      return lockedNames(fs.readFileSync(J(outputPath, LOCK), 'utf8'));
    };
    // x.css has copied/x.css's bytes; z.css has its size, not its bytes; empty files match nothing;
    // robots.txt is a first-party file
    assert.deepEqual(await build({ 'css/x.css': [Buffer.from('body{}')], 'z.css': ['body{}'], 'e.css': [''], 'robots.txt': ['x'] }), ['a', 'copied'], shape);
    // watch rebuild: copy-webpack-plugin 5 does not add the unchanged file again, it is still in the output
    assert.deepEqual(await build({}), ['a', 'copied'], shape);
    // no longer copied (not a file dependency any more)
    assert.deepEqual(await build({}, DEPS.filter(f => !f.includes('copied'))), ['a'], shape);
    // a late asset that names its source file
    if (shape === 'webpack 5') assert.deepEqual(await build({ 'y.js': ['y', { sourceFilename: 'node_modules/named/y.js' }] }), ['a', 'named'], shape);
  }
});

test('webpack adapter: every top-level compiler gets the listeners once; child compilers none', () => {
  const W = fakeCompiler();
  let applied = 0;
  const seen = [];
  webpack.onCjsLoad(W, './Compiler', () => '/p/node_modules/webpack/lib/Compiler.js');
  webpack.onCompiler((c) => seen.push(c));
  const top = new W();
  top.hooks = { thisCompilation: { tap() { applied++; } }, emit: { tap() {} }, afterEmit: { tapAsync() {} } };
  top.webpack = { Compilation: {}, sources: {} };
  top.compile(); top.compile();
  const configured = new W();
  configured.hooks = top.hooks;
  configured[Symbol.for('bundle-lockfile.webpack.applied')] = true; // BundleLockfilePlugin already in its config
  configured.compile();
  const child = new W();
  child.hooks = top.hooks;
  child.isChild = () => true;
  child.compile();
  assert.deepEqual(seen, [top, configured]);
  assert.equal(applied, 1);
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
  // the rollup adapter patches Module._load too (Rollup's CommonJS build): only off with all of its names
  for (const [disable, untouched] of [['all', 'true'], ['webpack,rollup,rolldown,vite', 'true'], ['ALL', 'true'], [' Webpack ,ROLLUP,rolldown, vite', 'true'],
    ['webpack', 'false'], ['webpack,vite', 'false'], ['', 'false'], ['rspack', 'false']]) {
    const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, BUNDLE_LOCKFILE_DISABLE: disable }, encoding: 'utf8' });
    assert.equal(r.stdout.trim(), untouched, `BUNDLE_LOCKFILE_DISABLE=${disable}: ${r.stderr}`);
  }
});

test('node shim: puts the --require back into NODE_OPTIONS, runs the real node, also behind a wrapper pointing at it', { skip: process.platform === 'win32' }, () => {
  const SHIM = J(__dirname, '../bin/node'), REGISTER = fs.realpathSync(J(SRC, 'register.cjs'));
  const root = project({
    // prints whether bundle-lockfile was preloaded, NODE_OPTIONS and process.execPath
    'probe.cjs': `console.log(JSON.stringify({ loaded: !!globalThis[Symbol.for('bundle-lockfile.hooks-installed')], options: process.env.NODE_OPTIONS || '', execPath: process.execPath }));`,
  });
  fs.mkdirSync(J(root, 'yarn/bin'), { recursive: true });
  fs.writeFileSync(J(root, 'yarn/bin/yarn.js'), `require(${JSON.stringify(J(root, 'probe.cjs'))});`);
  fs.mkdirSync(J(root, 'shim')); fs.copyFileSync(SHIM, J(root, 'shim/node')); fs.chmodSync(J(root, 'shim/node'), 0o755);
  fs.mkdirSync(J(root, 'src')); fs.symlinkSync(REGISTER, J(root, 'src/register.cjs')); // ../src/register.cjs next to the shim
  // yarn's temporary wrapper: `node` first in PATH, running the shim (as yarn does after register.cjs pointed its execPath there)
  fs.mkdirSync(J(root, 'wrapper')); fs.writeFileSync(J(root, 'wrapper/node'), `#!/bin/sh\nexec "${J(root, 'shim/node')}" "$@"\n`, { mode: 0o755 });
  const realDir = path.dirname(fs.realpathSync(process.execPath));
  const run = (script, { nodeOptions, pathDirs = [J(root, 'wrapper'), J(root, 'shim'), realDir] } = {}) => {
    const env = { ...process.env, PATH: [...pathDirs, '/usr/bin', '/bin'].join(':') };
    delete env.NODE_OPTIONS; delete env.BUNDLE_LOCKFILE_NODE_SHIM;
    if (nodeOptions !== undefined) env.NODE_OPTIONS = nodeOptions;
    const r = spawnSync(J(root, 'shim/node'), [J(root, script)], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  const plain = run('probe.cjs');
  assert.equal(plain.loaded, true);
  assert.equal(plain.options, `--require ${REGISTER}`);
  assert.equal(fs.realpathSync(plain.execPath), fs.realpathSync(process.execPath)); // the real node, not a wrapper
  assert.equal(run('probe.cjs', { nodeOptions: '--max-old-space-size=1024' }).options, `--require ${REGISTER} --max-old-space-size=1024`);
  for (const form of [`--require ${REGISTER}`, `--require=${REGISTER}`, `-r ${REGISTER}`]) {
    assert.equal(run('probe.cjs', { nodeOptions: `--max-old-space-size=1024 ${form}` }).options, `--max-old-space-size=1024 ${form}`, form); // never twice
  }
  // in yarn's process (and only there) process.execPath is the shim
  const yarn = run('yarn/bin/yarn.js');
  assert.equal(yarn.execPath, fs.realpathSync(J(root, 'shim/node')));
  // no node binary in PATH: a clear error, no loop through the wrapper
  fs.mkdirSync(J(root, 'tools')); // only what the shim needs
  for (const t of ['readlink', 'dirname', 'head']) fs.symlinkSync(spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim(), J(root, 'tools', t));
  const env = { ...process.env, PATH: [J(root, 'wrapper'), J(root, 'shim'), J(root, 'tools')].join(':') };
  const none = spawnSync(J(root, 'shim/node'), [J(root, 'probe.cjs')], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(none.status, 127);
  assert.match(none.stderr, /no node binary in PATH/);
});

test('node shim: runs version managers\' script shims, skips itself and scripts it passed through; a --require through a symlink counts', { skip: process.platform === 'win32' }, () => {
  const SHIM = J(__dirname, '../bin/node'), REGISTER = fs.realpathSync(J(SRC, 'register.cjs'));
  const realNode = fs.realpathSync(process.execPath);
  const root = project({
    'probe.cjs': `console.log(JSON.stringify({ loaded: !!globalThis[Symbol.for('bundle-lockfile.hooks-installed')], options: process.env.NODE_OPTIONS || '',
      execPath: process.execPath, seen: process.env.BUNDLE_LOCKFILE_NODE_SEEN === undefined ? null : process.env.BUNDLE_LOCKFILE_NODE_SEEN,
      child: process.argv[2] === 'child' ? null : JSON.parse(require('child_process').execFileSync('node', [__filename, 'child'], { encoding: 'utf8' })) }));`,
  });
  const dir = (d, files) => { fs.mkdirSync(J(root, d), { recursive: true }); for (const [f, c] of Object.entries(files)) fs.writeFileSync(J(root, d, f), c, { mode: 0o755 }); };
  dir('install/bin', {}); fs.copyFileSync(SHIM, J(root, 'install/bin/node')); fs.chmodSync(J(root, 'install/bin/node'), 0o755);
  dir('install/src', {}); fs.symlinkSync(REGISTER, J(root, 'install/src/register.cjs'));
  fs.symlinkSync(J(root, 'install'), J(root, 'linked'), 'dir'); // e.g. /opt/bundle-lockfile -> /usr/lib/bundle-lockfile
  // asdf's and nodenv's shims: scripts that run the real node by its path
  dir('asdf/shims', { node: `#!/bin/sh\n# asdf-plugin: nodejs\nexec "${realNode}" "$@"\n` });
  // a script that runs whatever `node` is in PATH: back to the shim, which must not run it again
  dir('loop', { node: '#!/bin/sh\nexec node "$@"\n' });
  dir('copy', {}); fs.copyFileSync(SHIM, J(root, 'copy/node')); fs.chmodSync(J(root, 'copy/node'), 0o755); // another copy of the shim
  const run = (shim, pathDirs, nodeOptions) => {
    const env = { ...process.env, PATH: [...pathDirs.map(d => J(root, d)), '/usr/bin', '/bin'].join(':') };
    delete env.NODE_OPTIONS; delete env.BUNDLE_LOCKFILE_NODE_SHIM; delete env.BUNDLE_LOCKFILE_NODE_SEEN;
    if (nodeOptions !== undefined) env.NODE_OPTIONS = nodeOptions;
    const r = spawnSync(J(root, shim), [J(root, 'probe.cjs')], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  // (a script running `node` first in PATH would run itself, with or without the shim: the shim comes first)
  for (const pathDirs of [['install/bin', 'asdf/shims'], ['install/bin', 'loop', 'copy', 'asdf/shims'], ['install/bin', 'copy', 'loop', 'asdf/shims']]) {
    const r = run('install/bin/node', pathDirs);
    assert.equal(r.loaded, true, pathDirs.join(' '));
    assert.equal(r.options, `--require ${REGISTER}`, pathDirs.join(' '));
    assert.equal(fs.realpathSync(r.execPath), realNode, pathDirs.join(' '));
    assert.equal(r.seen, null, `${pathDirs.join(' ')}: what the shim passed through is not passed on`);
    // a node this one starts through PATH (with NODE_OPTIONS overwritten, as cross-env does) goes through the same scripts again
    assert.equal(r.child.loaded, true, pathDirs.join(' '));
    assert.equal(fs.realpathSync(r.child.execPath), realNode, pathDirs.join(' '));
  }
  // NODE_OPTIONS already has the --require, through the symlinked install directory: not a second one (Next 15-16.3
  // fail with two)
  for (const form of [`--require ${J(root, 'linked/src/register.cjs')}`, `--require=${J(root, 'linked/src/register.cjs')}`, `-r "${J(root, 'linked/src/register.cjs')}"`]) {
    assert.equal(run('linked/bin/node', ['linked/bin', 'asdf/shims'], form).options, form, form);
  }
  // no node at all: a clear error, also with scripts in PATH that lead back to the shim
  fs.mkdirSync(J(root, 'tools'));
  for (const t of ['readlink', 'dirname', 'head']) fs.symlinkSync(spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim(), J(root, 'tools', t));
  const env = { ...process.env, PATH: ['install/bin', 'loop', 'copy', 'tools'].map(d => J(root, d)).join(':') };
  delete env.BUNDLE_LOCKFILE_NODE_SEEN;
  const none = spawnSync(J(root, 'install/bin/node'), [J(root, 'probe.cjs')], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(none.status, 127, none.stderr);
  assert.match(none.stderr, /no node binary in PATH/);
});

test('esm-wrap: finds the entry, its exports, and wraps only the functions it exports', () => {
  const esmWrap = require('../src/esm-wrap.cjs');
  const rollupEntry = { id: 'rollup', suffixes: ['/rollup/dist/es/rollup.js'], wrap: ['rollup', 'watch'] };
  assert.equal(esmWrap.match('file:///p/node_modules/rollup/dist/es/rollup.js', [rollupEntry]), rollupEntry);
  assert.equal(esmWrap.match('file:///p/node_modules/rollup/dist/es/rollup.js?bundle-lockfile-real', [rollupEntry]), null); // the real one
  assert.equal(esmWrap.match('node:fs', [rollupEntry]), null);
  // rollup 4's and rolldown 1's entries
  assert.deepEqual([...esmWrap.exportedNames("export { VERSION, defineConfig, rollup, watch } from './shared/node-entry.js';")], ['VERSION', 'defineConfig', 'rollup', 'watch']);
  assert.deepEqual([...esmWrap.exportedNames('export { RUNTIME_MODULE_ID, RolldownMagicString, VERSION, build, defineConfig, rolldown as rolldown, watch };')],
    ['RUNTIME_MODULE_ID', 'RolldownMagicString', 'VERSION', 'build', 'defineConfig', 'rolldown', 'watch']);
  assert.deepEqual([...esmWrap.exportedNames('export function rollup() {}\nexport const x = 1;\nexport default 2;')], ['rollup', 'x', 'default']);
  const src = esmWrap.source('file:///p/rollup.js', "export { VERSION, rollup } from './x.js';", rollupEntry);
  assert.match(src, /export \* from "file:\/\/\/p\/rollup\.js\?bundle-lockfile-real";/);
  assert.match(src, /export const rollup = api \? api\.wrap\("rollup", "rollup", real\.rollup\) : real\.rollup;/);
  assert.doesNotMatch(src, /export const watch/); // not exported by this version
  assert.equal(esmWrap.source('file:///p/rollup.js', 'export const other = 1;', rollupEntry), null); // unknown shape: untouched
});

test('hooks: in-thread ESM hooks only on Node >= 24.12 / 25.2; loader-thread hooks only in bundler processes', () => {
  const hooks = require('../src/hooks.cjs');
  for (const [v, safe] of [['22.23.3', false], ['24.11.1', false], ['24.12.0', true], ['25.1.0', false], ['25.2.0', true], ['26.0.0', true], ['v24.21.0', true]]) {
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
  assert.equal(hooks.bundlerProcess(P, J(root, 'node_modules/vite/bin/vite.js')), true);       // the package itself
  assert.equal(hooks.bundlerProcess(P, J(root, 'node_modules/headlamp-plugin/bin/h.js')), true); // a tool depending on it
  assert.equal(hooks.bundlerProcess(P, J(root, 'scripts/build.mjs')), true);                    // a build script of a project using it
  assert.equal(hooks.bundlerProcess(P, J(root, 'node_modules/npm/bin/npm-cli.js')), false);
  assert.equal(hooks.bundlerProcess(P, J(root, 'other/x.js')), false);
  assert.equal(hooks.bundlerProcess(P, undefined), false);
});

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

// runs the plugin's hooks like a rollup/rolldown build writing `outDir`; chunks: [{ fileName, code, modules, entry }]
// (entry: its facade module), assets: [{ fileName, originalFileNames, source }]; ctx: the plugin context (Rollup's
// getWatchFiles); late(): what other plugins do after the write, before the plugin's closeBundle
async function rollupBuild(plugin, { outDir, chunks = [], assets = [], isWrite = true, ctx = {}, late }) {
  const out = { dir: outDir, format: 'es' };
  plugin.buildStart.call(ctx);
  plugin.renderStart.call(ctx, out);
  for (const c of chunks) plugin.renderChunk.call(ctx, c.code, { moduleIds: c.modules }, out);
  const bundle = Object.fromEntries([...chunks.map(c => [c.fileName, { type: 'chunk', fileName: c.fileName, code: c.code, moduleIds: c.modules,
    isEntry: !!c.entry, facadeModuleId: c.entry || null, ...(c.css && { viteMetadata: { importedCss: new Set(c.css) } }) }]), ...assets.map(a => [a.fileName, { type: 'asset', fileName: a.fileName, ...a }])]);
  await plugin.generateBundle.handler.call(ctx, out, bundle, isWrite);
  if (isWrite) {
    for (const f of Object.values(bundle)) {
      fs.mkdirSync(path.dirname(J(outDir, f.fileName)), { recursive: true });
      fs.writeFileSync(J(outDir, f.fileName), f.type === 'chunk' ? f.code : f.source || '');
    }
    await plugin.writeBundle.handler.call(ctx, out);
  }
  if (late) late();
  await plugin.closeBundle.handler.call(ctx);
}

test('rollup adapter: a written output gets its lockfile; generate-only builds and outputs below node_modules none', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c'), ...pj('d'), 'node_modules/d/logo.svg': '<svg/>', 'src/main.js': '' });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const plugin = rollupAdapter.bundleLockfile('vite', { input: J(root, 'index.html') });
    await rollupBuild(plugin, { outDir: J(root, 'dist'), chunks: [
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

test('nested: a bundled file another build produced brings its packages, unless it changed since', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('inner'), ...pj('outer') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    // the island: a Vite build into island/dist with main.js containing node_modules/inner
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'island/dist'), chunks: [{ fileName: 'main.js', code: 'island code', modules: [J(root, 'node_modules/inner/i.js')] }] });
    const ids = (files) => packages.packagesOfOutput(files).map(p => `${p.name}@${p.version}`).sort();
    assert.deepEqual(ids([J(root, 'src/app.js'), J(root, 'island/dist/main.js'), J(root, 'node_modules/outer/i.js')]), ['inner@1.0.0', 'outer@1.0.0']);
    fs.appendFileSync(J(root, 'island/dist/main.js'), '/* changed */');
    assert.deepEqual(ids([J(root, 'island/dist/main.js'), J(root, 'node_modules/outer/i.js')]), ['outer@1.0.0']);
  } finally { process.chdir(cwd); }
});

test('nested: each JavaScript and CSS file another build produced brings the packages in it', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('js'), ...pj('lazy'), ...pj('sheet'), ...pj('imported'), ...pj('inline'), ...pj('worker'), ...pj('logo'),
    'node_modules/logo/l.svg': '<svg/>' });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const dir = J(root, 'island/dist'), m = (name, f = 'i.js') => J(root, 'node_modules', name, f);
    // a generate-only worker build whose chunk the island emits as an asset
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'gen'), chunks: [{ fileName: 'w.js', code: 'nested island worker code', modules: [m('worker')] }], isWrite: false });
    // the island: main.js with a style sheet Vite takes out into style.css (and one inlined as a string), lazy.js; the
    // style sheet @imports one from a package (a watch file); a worker asset; an image
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: dir, ctx: { getWatchFiles: () => [m('imported', 'i.css')] },
      chunks: [{ fileName: 'main.js', code: 'main code', modules: [J(root, 'island/src/main.js'), m('js'), m('sheet', 's.css'), `${m('inline', 'x.css')}?inline`], css: ['style.css'] },
        { fileName: 'lazy.js', code: 'lazy code', modules: [m('lazy')] }],
      assets: [{ fileName: 'style.css', source: 'css code' }, { fileName: 'w.js', source: 'nested island worker code' },
        { fileName: 'l.svg', source: '<svg/>', originalFileNames: ['node_modules/logo/l.svg'] }] });
    const ids = (f) => packages.packagesOfOutput([J(dir, f)]).map(p => `${p.name}@${p.version}`).sort();
    assert.deepEqual(ids('main.js'), ['inline@1.0.0', 'js@1.0.0']);
    assert.deepEqual(ids('lazy.js'), ['lazy@1.0.0']);
    assert.deepEqual(ids('style.css'), ['imported@1.0.0', 'sheet@1.0.0']);
    assert.deepEqual(ids('w.js'), ['worker@1.0.0']);
    assert.deepEqual(ids('l.svg'), []); // no JavaScript or CSS: its package is the file's own if bundled from there
    // recorded by a version that did not record the packages of each file: all of the island's
    const lock = J(dir, LOCK), json = JSON.parse(fs.readFileSync(lock, 'utf8'));
    assert.deepEqual(Object.keys(json['bundle-lockfile'].writers[0].contents).sort(), ['../l.svg', '../lazy.js', '../main.js', '../style.css', '../w.js'].filter(f => f !== '../l.svg'));
    delete json['bundle-lockfile'].writers[0].contents;
    fs.writeFileSync(lock, JSON.stringify(json));
    assert.deepEqual(ids('lazy.js'), ['imported@1.0.0', 'inline@1.0.0', 'js@1.0.0', 'lazy@1.0.0', 'logo@1.0.0', 'sheet@1.0.0', 'worker@1.0.0']);
  } finally { process.chdir(cwd); }
});

test('nested: a workspace package another build produced brings its packages, also through its node_modules link', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('inner'), 'packages/island/package.json': { name: '@acme/island', version: '1.0.0' } });
  fs.mkdirSync(J(root, 'node_modules/@acme'));
  fs.symlinkSync('../../packages/island', J(root, 'node_modules/@acme/island'));
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'packages/island/dist'), chunks: [{ fileName: 'main.js', code: 'island code', modules: [J(root, 'node_modules/inner/i.js')] }] });
    const ids = (files) => packages.packagesOfOutput(files).map(p => `${p.name}@${p.version}`).sort();
    assert.deepEqual(ids([J(root, 'packages/island/dist/main.js')]), ['inner@1.0.0']);          // its real path (resolve.symlinks)
    assert.deepEqual(ids([J(root, 'node_modules/@acme/island/dist/main.js')]), ['inner@1.0.0']); // the link (resolve.symlinks: false)
    // a package's own files are no other build's output, even with the same bytes
    fs.mkdirSync(J(root, 'node_modules/copy/dist'), { recursive: true });
    fs.writeFileSync(J(root, 'node_modules/copy/package.json'), JSON.stringify({ name: 'copy', version: '1.0.0' }));
    fs.copyFileSync(J(root, 'packages/island/dist/main.js'), J(root, 'node_modules/copy/dist/main.js'));
    assert.deepEqual(ids([J(root, 'node_modules/copy/dist/main.js')]), ['copy@1.0.0']);
  } finally { process.chdir(cwd); }
});

test('generated: generate-only output inside a written bundle (worker chunks as assets, inlined workers, polyfill chunks)', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
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
  const generated = require('../src/core/generated.cjs');
  assert.equal(generated.hash('code'), generated.hash('code\n//# sourceMappingURL=sw.js.map\n'));
  assert.equal(generated.hash('code'), generated.hash(Buffer.from('code//# sourceMappingURL=sw.js.map')));
  assert.notEqual(generated.hash('code'), generated.hash('code\n//# sourceMappingURL=sw.js.map\nmore'));
  assert.equal(generated.hash({}), null);
});

test('rollup adapter: style sheets a style sheet @imports from packages (watch files of Rollup and of Rolldown builds)', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
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
    const plugin = rollupAdapter.bundleLockfile('vite');
    plugin.api.setBuild({ get watchFiles() { return Promise.resolve(watch); } });
    await rollupBuild(plugin, { outDir: J(root, 'b'), chunks: [{ fileName: 'i.js', code: 'style b', modules: [J(root, 'src/main.js')] }] });
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

test('rollup adapter: files other plugins write into the output after the build (workbox sw.js, static copies)', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
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
    const plugin = rollupAdapter.bundleLockfile('vite');
    await rollupBuild(plugin, { outDir: dist, chunks: [{ fileName: 'assets/index.js', code: 'index', modules: [J(root, 'node_modules/app/i.js')] }], late() {
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

test('rollup adapter: the late files of one output are not those another output of the process writes there', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
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
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const seen = [];
  const exp = { rollup: async (o) => seen.push(['rollup', o.plugins.map(p => p.name)]), rollupInternal: async (o, hooks) => seen.push(['internal', o.plugins.map(p => p.name), hooks]) };
  const file = J('/x/node_modules/rollup/dist/shared/rollup.js');
  rollupAdapter.onCjsLoad({ rollupInternal() {} }, './shared/rollup.js', () => J('/x/node_modules/other/dist/shared/rollup.js')); // not Rollup's
  rollupAdapter.onCjsLoad(exp, '../shared/rollup.js', () => file);
  rollupAdapter.onCjsLoad(exp, '../shared/rollup.js', () => file); // once
  exp.rollup({ plugins: [{ name: 'x' }] });
  exp.rollupInternal({ plugins: [] }, 'hooks');
  assert.deepEqual(seen, [['rollup', ['x', 'bundle-lockfile']], ['internal', ['bundle-lockfile'], 'hooks']]);
  const wasm = { rollupInternal: async (o) => seen.push(o.plugins.length) };
  rollupAdapter.onCjsLoad(wasm, './shared/rollup.js', () => J('/x/node_modules/@rollup/wasm-node/dist/shared/rollup.js'));
  wasm.rollupInternal({});
  assert.equal(seen.pop(), 1);
});

test('copies: a file copied out of a package (fs.copyFile*, fs.cp*) belongs to it while it has its bytes', async () => {
  const copies = require('../src/core/copies.cjs');
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

test('copies: a file copied out of a package into the output after the build (static copy under another name)', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
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

test('config: BUNDLE_LOCKFILE_DEBUG is off when unset, empty, 0 or false', () => {
  const script = `require(${JSON.stringify(J(SRC, 'core/config.cjs'))}).debug('on');`;
  for (const [value, on] of [[undefined, false], ['', false], ['0', false], ['false', false], ['FALSE', false], ['1', true], ['yes', true]]) {
    const env = { ...process.env };
    delete env.BUNDLE_LOCKFILE_DEBUG;
    if (value !== undefined) env.BUNDLE_LOCKFILE_DEBUG = value;
    const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
    assert.equal(r.stderr.includes('[bundle-lockfile] on'), on, `BUNDLE_LOCKFILE_DEBUG=${value}`);
  }
});

// runs node with a script; returns { status, stdout, stderr }
const node = (args, env = {}) => spawnSync(process.execPath, args, { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000 });

test('hooks: a circular require() makes Node print no warning (no adapter reads properties of unrelated modules)', () => {
  const root = project({ 'a.js': "exports.a = 1; require('./b');", 'b.js': "const a = require('./a'); a.a; module.exports = {};" });
  const r = node(['--require', J(SRC, 'register.cjs'), J(root, 'a.js')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  // the adapters look at an object only once its request is one of theirs
  const read = [];
  const exp = new Proxy({}, { get: (t, k) => { read.push(k); return undefined; }, has: (t, k) => { read.push(k); return false; } });
  for (const a of [webpack, require('../src/adapters/rollup.cjs')]) a.onCjsLoad(exp, './b', () => J(root, 'b.js'));
  assert.deepEqual(read, []);
});

// One webpack process writing dist/ through the plugin's real hooks: renders its lockfile after processAssets, waits
// until `waitFor` exists, then emits like webpack (the emit hook, every asset written, afterEmit); touches `staged`
// after rendering and `done` at the end ('-': none). Its output is on the real disk (webpack 4's NodeOutputFileSystem).
const WEBPACK_PROCESS = `const fs = require('fs'), path = require('path');
const webpack = require(${JSON.stringify(J(SRC, 'adapters/webpack.cjs'))});
const [root, name, staged, waitFor, done] = process.argv.slice(2);
const outputPath = path.join(root, 'dist');
const taps = {};
const hook = (n) => ({ tap: (o, fn) => (taps[n] = fn), tapAsync: (o, fn) => (taps[n] = fn) });
class NodeOutputFileSystem { writeFile(f, c, cb) { fs.writeFile(f, c, cb); } stat(f, cb) { fs.stat(f, cb); } lstat(f, cb) { fs.lstat(f, cb); } readFile(f, cb) { fs.readFile(f, cb); } }
const compiler = { context: root, outputPath, name, options: { entry: './src/' + name + '.js' }, outputFileSystem: new NodeOutputFileSystem(),
  hooks: { thisCompilation: hook('thisCompilation'), emit: hook('emit'), afterEmit: hook('afterEmit') },
  webpack: { sources: { RawSource: class { constructor(s) { this.s = s; } source() { return this.s; } } } } };
new webpack.BundleLockfilePlugin('bundle-lockfile/package-lock.json').apply(compiler);
const assets = { [name + '.js']: { source: () => name } };
const chunk = { files: new Set([name + '.js']), modules: [{ resource: path.join(root, 'node_modules', name, 'i.js') }] };
const comp = { compiler, chunks: [chunk], children: [], fileDependencies: [],
  chunkGraph: { getChunkModulesIterable: (c) => c.modules, getChunkEntryModulesIterable: () => [] }, moduleGraph: { getIssuer: () => null },
  getAsset: (n) => assets[n] && { name: n, source: assets[n], info: {} }, getAssets: () => Object.keys(assets).map(n => ({ name: n, source: assets[n], info: {} })),
  emitAsset: (n, s) => { assets[n] = s; }, hooks: { afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) } } };
taps.thisCompilation(comp);
comp.stage();
if (staged !== '-') fs.writeFileSync(staged, '');
const emit = () => {
  taps.emit(comp);
  for (const [n, s] of Object.entries(assets)) { fs.mkdirSync(path.dirname(path.join(outputPath, n)), { recursive: true }); fs.writeFileSync(path.join(outputPath, n), s.source()); }
  taps.afterEmit(comp, () => { if (done !== '-') fs.writeFileSync(done, ''); });
};
const wait = () => (waitFor === '-' || fs.existsSync(waitFor) ? emit() : setTimeout(wait, 10));
wait();`;

test('webpack adapter: a process that writes its output after another one has written the shared lockfile keeps that one\'s packages', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), 'process.cjs': WEBPACK_PROCESS });
  const run = (...args) => new Promise((resolve, reject) => {
    const p = require('child_process').spawn(process.execPath, [J(root, 'process.cjs'), root, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', d => (err += d));
    p.on('exit', code => (code === 0 && !err ? resolve() : reject(new Error(`exit ${code}: ${err}`))));
  });
  const until = async (file) => { while (!fs.existsSync(file)) await new Promise(r => setTimeout(r, 10)); };
  // a has rendered its lockfile (b has written nothing yet); b builds and writes completely; then a writes its output
  const a = run('a', J(root, 'a-staged'), J(root, 'go'), '-');
  await until(J(root, 'a-staged'));
  await run('b', '-', '-', '-');
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['b']);
  fs.writeFileSync(J(root, 'go'), '');
  await a;
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['a', 'b']);
  assert.deepEqual(fs.readdirSync(J(root, 'dist/bundle-lockfile')), ['package-lock.json'], 'no lock or temporary files left');
});

test('webpack adapter: on the real disk the lockfile is no asset: written once the output has landed, also the export copy', async () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const notByIt = () => { throw new Error('the lockfile on disk is written atomically, not by the output file system'); };
  // the real disk: webpack 4's NodeOutputFileSystem, webpack 5's graceful-fs - in any copy (the one Next.js bundles, or
  // one a plugin configured by hand cannot resolve from webpack), known by its gracefulify()
  class NodeOutputFileSystem { writeFile() { notByIt(); } }
  const disks = { 'webpack 4': () => new NodeOutputFileSystem(), 'graceful-fs': () => ({ gracefulify() {}, writeFile: notByIt }), "Node's fs": () => fs };
  for (const [kind, make] of Object.entries(disks)) for (const inline of [true, false]) {
    const outputPath = J(root, `disk-${kind.replace(/\W/g, '')}-${inline}`);
    await withConfig({ inline, exportDir: J(root, 'export'), exportBase: root }, async () => {
      const { compiler, taps } = fakeCompiler5({ outputPath });
      compiler.outputFileSystem = Object.assign(make(), { lstat: fs.lstat });
      const comp = compilation({ context: root, outputPath, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }] });
      comp.compiler = compiler;
      const emitted = [];
      comp.emitAsset = (file) => emitted.push(file);
      comp.hooks = { afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) } };
      new webpack.BundleLockfilePlugin(LOCK).apply(compiler);
      taps.thisCompilation(comp);
      comp.stage();
      taps.emit(comp);
      assert.deepEqual(emitted, [], `${kind}, inline=${inline}: no asset`);
      assert.equal(fs.existsSync(J(outputPath, LOCK)), false, `${kind}, inline=${inline}: not before the output has landed`);
      await new Promise(resolve => taps.afterEmit(comp, resolve));
      assert.equal(fs.existsSync(J(outputPath, LOCK)), inline, `${kind}, inline=${inline}: inline file`);
      if (inline) assert.deepEqual(lockedNames(fs.readFileSync(J(outputPath, LOCK), 'utf8')), ['a']);
      assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'export', path.basename(outputPath), LOCK), 'utf8')), ['a'], `${kind}, inline=${inline}: export copy`);
    });
  }
});

test('outputs: lockfiles on disk are replaced atomically, never written in place (other processes read them without the lock)', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
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
    outputs.rewrite(t, writeFile, () => outputs.rewrite(t, writeFile, () => {}));`;
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

test('lockfile: a package outside the project another process listed is listed once, also after many writes', async () => {
  const pj = (name, version = '1.0.0') => ({ name, version });
  const root = project({ 'proj/node_modules/foo/package.json': pj('foo', '2.0.0') });
  const proj = J(root, 'proj');
  const cache = (zip) => J(root, 'cache', zip, 'node_modules/foo');
  const target = J(proj, 'dist', LOCK);
  const outsideOne = pkg('foo', '1.0.0', cache('foo-1.0.0-a.zip')), outsideTwo = pkg('foo', '1.0.0', cache('foo-1.0.0-b.zip'));
  const located = { ...pkg('foo', '2.0.0', J(proj, 'node_modules/foo')), license: 'MIT' };
  // another process wrote the lockfile: foo@2.0.0 in the project, and two copies of foo@1.0.0 outside of it
  fs.mkdirSync(J(proj, 'dist'), { recursive: true });
  fs.writeFileSync(J(proj, 'dist/other.js'), '');
  const meta = (writers) => ({ dir: path.dirname(target), writers });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, toPackageLock([located, outsideOne, outsideTwo], proj, meta([{ id: 'other', files: [J(proj, 'dist/other.js')], paths: [located.path, outsideOne.path, outsideTwo.path] }])));
  const first = fs.readFileSync(target, 'utf8');
  assert.deepEqual(JSON.parse(first)['bundle-lockfile'].outside, ['node_modules/foo@1.0.0', 'node_modules/foo@1.0.0-2']);
  const { readMeta } = require('../src/core/lockfile.cjs');
  const listed = readMeta(first, path.dirname(target)).writers[0].pkgs;
  assert.deepEqual(listed.map(p => p.outside || p.path).sort(), [J(proj, 'node_modules/foo'), 'node_modules/foo@1.0.0', 'node_modules/foo@1.0.0-2'].sort());
  assert.equal(listed.find(p => !p.outside).license, 'MIT');
  // this process has one of the two copies: still two keys, not three; the package in the project stays as it is
  const writeFile = (json, cb) => { fs.writeFileSync(target, json); cb(); };
  outputs.record(target, 'mine', [outsideOne], proj, [J(proj, 'dist/mine.js')], { disk: true });
  fs.writeFileSync(J(proj, 'dist/mine.js'), '');
  outputs.emitted(target, 'mine');
  await new Promise(resolve => outputs.rewrite(target, writeFile, resolve));
  const keys = (json) => entries(json).map(([k, p]) => `${k} = ${p.name}@${p.version}`);
  const want = ['node_modules/foo@1.0.0 = foo@1.0.0', 'node_modules/foo@1.0.0-2 = foo@1.0.0', 'node_modules/foo = foo@2.0.0']; // name, version order
  assert.deepEqual(keys(fs.readFileSync(target, 'utf8')), want);
  // written again and again (watch mode, more processes): the same bytes
  const again = fs.readFileSync(target, 'utf8');
  await new Promise(resolve => outputs.rewrite(target, writeFile, resolve));
  assert.equal(fs.readFileSync(target, 'utf8'), again);
  // one copy outside, listed by the other process, and the same copy here: one entry
  const single = toPackageLock([outsideOne, { ...outsideOne, path: '\0outside:node_modules/foo', outside: 'node_modules/foo' }], proj, meta([]));
  assert.deepEqual(keys(single), ['node_modules/foo = foo@1.0.0']);
});

test('lockfile: a lockfile of another shape is no record, and never stops the lockfile from being written', async () => {
  const { readMeta } = require('../src/core/lockfile.cjs');
  const NONE = Symbol('no packages');
  const field = (m, packages = {}) => JSON.stringify({ lockfileVersion: 3, ...(packages === NONE ? {} : { packages }), 'bundle-lockfile': m });
  for (const json of [
    field({ v: 1, context: '.', writers: [{ id: 'x', packages: ['node_modules/a'] }] }, NONE), // no packages
    field({ v: 1, context: '.', writers: [] }, ['node_modules/a']),                                  // packages as an array
    field({ v: 1, context: '.', writers: {} }), field({ v: 1, context: 1, writers: [] }), field({ v: 2, context: '.', writers: [] }),
    field(null), field([]), 'null', '[]', '"x"', '{not json',
  ]) assert.equal(readMeta(json, '/d'), null, json);
  // malformed parts of a writer are left out, the rest is read
  const meta = readMeta(field({ v: 1, context: '.', outside: 'node_modules/b', writers: [
    null, 'x', { id: 1 }, { id: 'w', files: 'dist/a.js', count: '3', outputs: ['x'], packages: [1, 'node_modules/a', 'node_modules/none', 'toString', 'node_modules/noversion'],
      contents: { 'dist/a.js': [0, 1, 3, 9, -1, 0.5, 'node_modules/a'], 'dist/b.js': 'x' } }, // indices into the strings of packages
  ] }, { 'node_modules/a': { name: 'a', version: '1.0.0' }, 'node_modules/noversion': { name: 'n' } }), '/d');
  const pa = { name: 'a', version: '1.0.0', path: J('/d/node_modules/a') };
  assert.deepEqual(meta.writers, [{ id: 'w', files: [], count: undefined, outputs: {}, contents: { [J('/d/dist/a.js')]: [pa] }, pkgs: [pa] }]);
  // such a file on disk: replaced by a lockfile of this build
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const target = J(root, 'dist', LOCK);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, field({ v: 1, context: '.', writers: [{ id: 'x', packages: ['node_modules/a'] }] }, NONE));
  const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]);
  assert.deepEqual(lockedNames(outputs.record(target, 'w', [a], root, [], { disk: true })), ['a']);
  outputs.emitted(target, 'w');
  await new Promise((resolve, reject) => outputs.rewrite(target, outputs.writeDisk(target), (err) => (err ? reject(err) : resolve())));
  assert.deepEqual(lockedNames(fs.readFileSync(target, 'utf8')), ['a']);
});

test('outputs: a stale lock is taken over only if it is still the stale one', () => {
  const root = project({ 'stale.lock': '' });
  const l = J(root, 'stale.lock');
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(l, old, old);
  // another process took the stale lock over and holds a new one by now: it stays
  const st = fs.statSync(l);
  fs.unlinkSync(l); fs.writeFileSync(l, 'fresh');
  outputs.takeStale(l, st);
  assert.equal(fs.readFileSync(l, 'utf8'), 'fresh');
  // still the stale one: removed
  fs.utimesSync(l, old, old);
  outputs.takeStale(l, fs.statSync(l));
  assert.equal(fs.existsSync(l), false);
  assert.deepEqual(fs.readdirSync(root), [], 'nothing left behind');
  outputs.takeStale(l, st); // already gone: nothing to do
});

test('hashes: one cache entry per file, recomputed when the file changes', () => {
  const hashes = require('../src/core/hashes.cjs');
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
