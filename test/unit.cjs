'use strict';
// Unit tests for the bundler-agnostic core and the adapter's detection logic. No network, no fixtures:
//   node --test test/unit.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { packageRoot, packagesForFiles, unvirtual } = require('../src/core/packages.cjs');
const { toPackageLock, lockfileForFiles } = require('../src/core/lockfile.cjs');
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
const plugin = () => new webpack.BundleLockfilePlugin('bundle-lockfile/package-lock.json');
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
  const p = plugin();
  assert.deepEqual(lockedNames(p.lockfile(ca)), ['a']);
  assert.deepEqual(lockedNames(p.lockfile(cb)), ['a', 'b']);
  // a rebuild of one compiler (watch mode) replaces only its own packages
  const rebuilt = one('c');
  rebuilt.compiler = ca.compiler; // same compiler, next compilation
  assert.deepEqual(lockedNames(p.lockfile(rebuilt)), ['b', 'c']);
  // output.clean options alone drop nothing: only files that are really gone do (see the prune tests)
  const cleaned = one('a', { clean: true });
  cleaned.compiler = ca.compiler;
  assert.deepEqual(lockedNames(p.lockfile(cleaned)), ['a', 'b']);
});

test('webpack adapter: a new compiler for the same config replaces the previous one in a shared lockfile', () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c') });
  const outputPath = J(root, 'dist');
  const build = (dep, options) => {
    const c = compilation({ context: root, outputPath, chunks: [{ files: ['x.js'], modules: [{ resource: J(root, 'node_modules', dep, 'i.js') }] }] });
    c.compiler.options = options;
    return plugin().lockfile(c);
  };
  const app = { entry: { main: { import: ['./src/app.js'] } }, output: { filename: '[name].js' } };
  const sw = { entry: { sw: { import: ['./src/sw.js'] } }, target: 'webworker', output: { filename: '[name].js' } };
  assert.deepEqual(lockedNames(build('a', app)), ['a']);
  assert.deepEqual(lockedNames(build('b', sw)), ['a', 'b']);       // another config, same directory: both
  assert.deepEqual(lockedNames(build('c', { ...app })), ['b', 'c']); // the app built again by a new compiler: replaces a
  // dynamic entries cannot be compared: every such compiler is a writer of its own
  const fn = { ...app, entry: () => ({}) };
  assert.deepEqual(lockedNames(build('a', fn)), ['a', 'b', 'c']);
});

test('outputs: prune drops other writers whose files are all gone, once their build has landed', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c'), ...pj('d'), 'dist/b.js': '', 'dist/c2.js': '' });
  const target = J(root, 'dist/bundle-lockfile/package-lock.json');
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const exists = (f, cb) => setImmediate(cb, fs.existsSync(f));
  const prune = (writer) => new Promise(resolve => outputs.prune(target, writer, exists, resolve));
  outputs.record(target, 'a', [a], root, [J(root, 'dist/a.js')]);              // the one pruning: never dropped by itself
  outputs.record(target, 'b', [b], root, [J(root, 'dist/b.js')]);              // its file is there
  outputs.record(target, 'c', [c], root, [J(root, 'dist/c1.js'), J(root, 'dist/c2.js')]); // one of its files is left
  outputs.record(target, 'd', [d], root, [J(root, 'dist/d.js')]);              // its file is gone ...
  for (const w of ['a', 'b', 'c']) outputs.emitted(target, w);
  await prune('a');
  // ... but its build has not landed yet: it has not written its file
  assert.deepEqual(lockedNames(outputs.record(target, 'a', [a], root, [J(root, 'dist/a.js')])), ['a', 'b', 'c', 'd']);
  outputs.emitted(target, 'a');
  outputs.emitted(target, 'd');
  await prune('a');
  assert.deepEqual(lockedNames(outputs.record(target, 'a', [a], root, [J(root, 'dist/a.js')])), ['a', 'b', 'c']);
  // nothing to check: done at once
  let done = false;
  outputs.prune(J(root, 'other/package-lock.json'), 'a', exists, () => (done = true));
  assert.equal(done, true);
});

test('webpack adapter: a compiler whose output.clean deleted another compiler\'s files drops its packages', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b') });
  const outputPath = J(root, 'dist');
  const lock = J(outputPath, 'bundle-lockfile/package-lock.json');
  fs.mkdirSync(outputPath);
  // two compilers writing to dist/, through the plugin's real hooks; each "emits" by writing its asset files
  const make = (name) => {
    const { compiler, taps } = fakeCompiler5({ outputPath });
    compiler.name = name;
    compiler.outputFileSystem.stat = fs.stat;
    compiler.options = { entry: { main: { import: [`./src/${name}.js`] } } };
    new webpack.BundleLockfilePlugin('bundle-lockfile/package-lock.json').apply(compiler);
    const build = async () => {
      const comp = compilation({ context: root, outputPath, chunks: [{ files: [`${name}.js`], modules: [{ resource: J(root, 'node_modules', name, 'i.js') }] }],
        assets: { [`${name}.js`]: {} } });
      comp.compiler = compiler;
      comp.emitAsset = () => {};
      comp.hooks = { processAssets: { tap: (o, fn) => (comp.stage = fn) } };
      taps.thisCompilation(comp);
      comp.stage();
      fs.writeFileSync(J(outputPath, `${name}.js`), '');
      await new Promise(resolve => taps.afterEmit(comp, resolve));
    };
    return build;
  };
  const buildA = make('a'), buildB = make('b');
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

test('outputs: writes of a shared lockfile run in order, each with the latest content', async () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/b/package.json': { name: 'b', version: '1.0.0' } });
  const target = J(root, 'dist/bundle-lockfile/package-lock.json');
  const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]), [b] = packagesForFiles([J(root, 'node_modules/b/i.js')]);
  outputs.record(target, 'w1', [a], root);
  assert.equal(outputs.isShared(target), false);
  outputs.record(target, 'w2', [b], J(root, 'sub')); // another context: the smallest one is used, whoever writes last
  assert.equal(outputs.isShared(target), true);
  const written = [];
  // the first write is slow and fails: the second still runs after it, and the build continues
  const slow = (json, cb) => setTimeout(() => { written.push(json); cb(new Error('disk full')); }, 20);
  const fast = (json, cb) => { written.push(json); cb(); };
  const errors = await Promise.all([
    new Promise(resolve => outputs.rewrite(target, slow, resolve)),
    new Promise(resolve => { outputs.record(target, 'w2', [a, b], J(root, 'sub')); outputs.rewrite(target, fast, resolve); }),
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
    hooks: { thisCompilation: hook('thisCompilation'), afterEmit: hook('afterEmit') },
    outputFileSystem: { writeFile: (f, c, cb) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); cb(); } },
  };
  if (withWebpack) compiler.webpack = { Compilation: { PROCESS_ASSETS_STAGE_REPORT: 5000 }, sources: { RawSource: class { constructor(s) { this.s = s; } source() { return this.s; } } } };
  return { compiler, taps };
}

test('webpack adapter: plugin emits in webpack 5 and 4 (also without webpack-sources), injection skips a configured plugin', () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  for (const withWebpack of [true, false]) {
    const { compiler, taps } = fakeCompiler5({ outputPath: J(root, `out-${withWebpack}`), withWebpack });
    const comp = compilation({ context: root, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }] });
    comp.compiler = compiler;
    const emitted = {};
    comp.emitAsset = (file, src) => { emitted[file] = src.source(); };
    let stageTap;
    comp.hooks = { processAssets: { tap: (o, fn) => (stageTap = fn) }, afterOptimizeAssets: { tap: (o, fn) => (stageTap = fn) } };
    new webpack.BundleLockfilePlugin('bundle-lockfile/package-lock.json').apply(compiler); // webpack 4: no compilerFile, webpack-sources not found
    taps.thisCompilation(comp);
    stageTap();
    assert.deepEqual(entries(emitted['bundle-lockfile/package-lock.json']).map(([k]) => k), ['node_modules/a'], `withWebpack=${withWebpack}`);
    let done = false;
    taps.afterEmit(comp, () => (done = true)); // not shared: no extra write, continues at once
    assert.equal(done, true);
    assert.equal(compiler[Symbol.for('bundle-lockfile.webpack.applied')], true);
  }
});

test('webpack adapter: every top-level compiler gets the listeners once; child compilers none', () => {
  const W = fakeCompiler();
  let applied = 0;
  const seen = [];
  webpack.onCjsLoad(W, './Compiler', () => '/p/node_modules/webpack/lib/Compiler.js');
  webpack.onCompiler((c) => seen.push(c));
  const top = new W();
  top.hooks = { thisCompilation: { tap() { applied++; } }, afterEmit: { tapAsync() {} } };
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
  for (const [disable, untouched] of [['all', 'true'], ['webpack', 'true'], ['ALL', 'true'], [' Webpack ', 'true'], ['', 'false'], ['rspack', 'false']]) {
    const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, BUNDLE_LOCKFILE_DISABLE: disable }, encoding: 'utf8' });
    assert.equal(r.stdout.trim(), untouched, `BUNDLE_LOCKFILE_DISABLE=${disable}: ${r.stderr}`);
  }
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
