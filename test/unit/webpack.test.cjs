'use strict';
// Unit tests of the webpack adapter (and what rspack shares with it).
// All unit tests: node --test test/unit/*.test.cjs (see test/README.md)
// (helpers.cjs first: see there)
const {
  packagesForFiles, SRC, PATCHED, J, project, UNIT, BUNDLER_FILE, BUNDLERS, warnings, entries, allEntries,
  fakeCompiler, newOutputDir, compilation, LOCK, plugin, lockedNames, withConfig, fakeCompiler5, sharedCompiler,
  APPLIED_SYM, fakeRspack,
} = require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const outputs = require('../../src/core/outputs.cjs');
const webpackAdapter = require('../../src/adapters/webpack.cjs');
const problems = require('../../src/core/problems.cjs');

test('webpack adapter: patches webpack Compilers, not other classes called Compiler', () => {
  const W = fakeCompiler();
  webpackAdapter.onCjsLoad(W, './Compiler', () => '/p/node_modules/webpack/lib/Compiler.js');
  assert.equal(W.prototype[PATCHED], true);

  const NS = fakeCompiler();
  const ns = Object.assign(function webpack() {}, { Compiler: NS, Compilation: class {}, version: '5.0.0' });
  webpackAdapter.onCjsLoad(ns, 'webpack', () => '/p/node_modules/webpack/lib/index.js');
  assert.equal(NS.prototype[PATCHED], true);

  class Compiler { compile() {} } // e.g. snapdragon's
  webpackAdapter.onCjsLoad(Compiler, './compiler', () => '/p/node_modules/snapdragon/lib/compiler.js');
  assert.equal(Compiler.prototype[PATCHED], undefined);
});

test('webpack adapter: Next.js vendored webpack, whose exports are filled in by init()', () => {
  // (the request: the module's file as hooks.cjs passes it, see core/layout.cjs logical)
  const where = '/p/node_modules/next/dist/compiled/webpack/webpack.js';
  // as next/dist/compiled/webpack/webpack.js: only init() at load time
  const C1 = fakeCompiler();
  const exp = { __esModule: true, init() { Object.assign(exp, { webpack: { Compiler: C1 } }); } };
  webpackAdapter.onCjsLoad(exp, where, () => where);
  assert.equal(C1.prototype[PATCHED], undefined);
  exp.init();
  assert.equal(C1.prototype[PATCHED], true);
  webpackAdapter.onCjsLoad(exp, where, () => where); // required again: init not wrapped twice
  exp.init();

  // already initialized when required (another copy of the module, or a later require)
  const C2 = fakeCompiler();
  webpackAdapter.onCjsLoad({ webpack: { Compiler: C2 } }, where, () => where);
  assert.equal(C2.prototype[PATCHED], true);

  // the same shape at any other path is ignored
  const C3 = fakeCompiler();
  webpackAdapter.onCjsLoad({ webpack: { Compiler: C3 } }, '/p/node_modules/my-webpack/index.js', () => '/p/node_modules/my-webpack/index.js');
  assert.equal(C3.prototype[PATCHED], undefined);

  // next-rspack fills it with rspack's exports: rspack's Compiler (no newCompilation) is rspack.cjs's, no unknown webpack
  return withConfig({ strict: true }, () => {
    problems.take();
    const R = fakeRspack('2.0.4');
    const viaInit = { init() { Object.assign(viaInit, { webpack: R }); } };
    webpackAdapter.onCjsLoad(viaInit, where, () => where);
    viaInit.init();
    webpackAdapter.onCjsLoad({ webpack: R }, where, () => where);
    assert.deepEqual(problems.take(), []);
    assert.equal(R.Compiler.prototype[PATCHED], undefined);
  });
});

// the same in webpack 4's shape: chunk.modulesIterable / chunk.entryModule, assets as an object, no getAsset(s)
function compilation4({ context, chunks, children = [], assets = {} }) {
  return {
    compiler: { context, outputPath: newOutputDir(context), [BUNDLER_FILE]: BUNDLERS.webpack },
    outputOptions: {},
    chunks: chunks.map(c => ({ files: c.files || [], modulesIterable: new Set(c.modules), entryModule: (c.entry || [])[0] })),
    children: children.map(c => compilation4({ context, ...c })),
    assets: Object.fromEntries(Object.keys(assets).map(n => [n, {}])),
  };
}

const WRITER = Symbol.for('bundle-lockfile.webpack.writer');

test('webpack adapter: the bundler whose code is in the output is listed - the patched copy, Next.js\' at its version, the one that applied a configured plugin', () => withConfig({ strict: true }, () => {
  problems.take();
  const root = project({
    'node_modules/a/package.json': { name: 'a', version: '1.0.0' },
    'node_modules/next/package.json': { name: 'next', version: '16.4.0' },
    'node_modules/next/dist/compiled/webpack/package.json': { name: 'webpack', main: 'bundle5.js', license: 'MIT' }, // (no version, as Next ships it)
    'node_modules/next/dist/compiled/webpack/webpack.js': '',
    'node_modules/webpack/package.json': { name: 'webpack', version: '5.111.1' },
  });
  const a = { resource: J(root, 'node_modules/a/i.js') };
  const lock = (c) => Object.fromEntries(allEntries(plugin().lockfile(c)).map(([k, p]) => [k, `${p.name}@${p.version}`]));
  // a JavaScript chunk: its webpack (the patched Compiler's: BUNDLERS.webpack)
  assert.deepEqual(lock(compilation({ context: root, chunks: [{ files: ['main.js'], modules: [a] }] })),
    { 'node_modules/a': 'a@1.0.0', 'node_modules/webpack': `webpack@${UNIT}` });
  // only a style sheet and assets: no code of webpack's
  assert.deepEqual(lock(compilation({ context: root, chunks: [{ files: ['main.css'], modules: [a] }] })), { 'node_modules/a': 'a@1.0.0' });
  // Next.js' copy: at its location, at the version the compiler says
  const next = compilation({ context: root, chunks: [{ files: ['main.js?v=1'], modules: [a] }] });
  next.compiler[BUNDLER_FILE] = J(root, 'node_modules/next/dist/compiled/webpack/webpack.js');
  next.compiler.webpack = { version: '5.98.0' };
  assert.deepEqual(lock(next), { 'node_modules/a': 'a@1.0.0', 'node_modules/next/dist/compiled/webpack': 'webpack@5.98.0' });
  const json = JSON.parse(plugin().lockfile(next));
  assert.deepEqual(json.packages['node_modules/next/dist/compiled/webpack'], { name: 'webpack', version: '5.98.0', license: 'MIT' });
  assert.deepEqual(problems.take(), []);
  // a plugin in the config, without the preload: the webpack that applies it
  const { compiler } = fakeCompiler5({ outputPath: J(root, 'dist-configured') });
  delete compiler[BUNDLER_FILE];
  const configured = new webpackAdapter.BundleLockfilePlugin(LOCK);
  require(BUNDLERS.webpack)(configured.apply, configured, [compiler]);
  const c = compilation({ context: root, chunks: [{ files: ['main.js'], modules: [a] }] });
  c.compiler = compiler;
  assert.equal(allEntries(configured.lockfile(c)).find(([k]) => k === 'node_modules/webpack')[1].version, UNIT);
  // applied by anything else: the webpack the context resolves, if it is the compiler's version
  const other = fakeCompiler5({ outputPath: J(root, 'dist-other') }).compiler;
  delete other[BUNDLER_FILE];
  other.webpack.version = '5.111.1';
  const p2 = new webpackAdapter.BundleLockfilePlugin(LOCK);
  p2.apply(other);
  const c2 = compilation({ context: root, chunks: [{ files: ['main.js'], modules: [a] }] });
  c2.compiler = other;
  assert.equal(allEntries(p2.lockfile(c2)).find(([k]) => k === 'node_modules/webpack')[1].version, '5.111.1');
  assert.deepEqual(problems.take(), []);
  // ... else the copy that ran is not known: a problem (strict mode: the build fails)
  other.webpack.version = '5.112.0';
  const p3 = new webpackAdapter.BundleLockfilePlugin(LOCK);
  p3.apply(other);
  assert.equal(allEntries(p3.lockfile(c2)).some(([, p]) => p.name === 'webpack'), false);
  const taken = problems.take();
  assert.equal(taken.length, 1);
  assert.match(taken[0], /is webpack@5\.112\.0, which was not loaded with the preload, and .*node_modules.webpack.package\.json is another copy/);
}));

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

test('webpack adapter: files copied before the lockfile without naming their source (copy-webpack-plugin 6.0 - 6.2)', () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('file'), ...pj('dir'), ...pj('other'), ...pj('empty'), ...pj('img'),
    'node_modules/file/f.css': 'body{}', 'node_modules/dir/lib/d.js': 'dir()', 'node_modules/other/o.css': 'BODY{}',
    'node_modules/empty/e.css': '', 'node_modules/img/i.png': 'png', 'src/robots.txt': 'robots' });
  const src = (content) => ({ size: () => Buffer.byteLength(content), source: () => content });
  const shapes = {
    // webpack 5 (copy-webpack-plugin 6.1, 6.2: info.copied only), with auxiliary files of chunks
    'webpack 5': (assets) => {
      const all = new Map(Object.entries(assets).map(([name, [content, info = {}]]) => [name, { name, source: src(content), info }]));
      return { getAsset: (n) => all.get(n), getAssets: () => [...all.values()] };
    },
    // webpack 4 (copy-webpack-plugin 6.0): assets an object of sources, no asset info
    'webpack 4': (assets) => ({ assets: Object.fromEntries(Object.entries(assets).map(([n, [content]]) => [n, src(content)])) }),
  };
  for (const [shape, assetsOf] of Object.entries(shapes)) {
    const c = {
      compiler: { context: root, outputPath: newOutputDir(root) },
      chunks: [{ files: shape === 'webpack 5' ? new Set(['main.js']) : ['main.js'], auxiliaryFiles: new Set(['img.png']), modulesIterable: [{ resource: J(root, 'node_modules/a/i.js') }] }],
      // a module's own asset (webpack 4's file-loader: emitFile) with a package file's bytes: no copy
      modules: [{ buildInfo: { assets: { 'emitted.png': {} } } }],
      children: [],
      fileDependencies: new Set([J(root, 'node_modules/a/i.js'), J(root, 'node_modules/file/f.css'), J(root, 'node_modules/other/o.css'),
        J(root, 'node_modules/empty/e.css'), J(root, 'node_modules/img/i.png'), J(root, 'src/robots.txt')]),
      // copy-webpack-plugin 6.2 adds a copied directory only as a context dependency
      contextDependencies: new Set([J(root, 'node_modules/dir'), J(root, 'src')]),
      ...assetsOf({
        'main.js': ['main'],
        'css/f.css': ['body{}', { copied: true }],          // a copied file: file/f.css's bytes
        'vendor/dir/lib/d.js': ['dir()', { copied: true }], // a file of a copied directory
        'o.css': ['XODY{}'],                                // other/o.css's size, not its bytes
        'e.css': [''],                                      // empty: equals every empty file
        'robots.txt': ['robots'],                           // a first-party file
        'img.png': ['png'],                                 // a chunk's auxiliary file (webpack 5 asset module)
        'emitted.png': ['png'],
      }),
    };
    if (shape === 'webpack 4') delete c.chunks[0].auxiliaryFiles; // webpack 4 has none
    const expected = shape === 'webpack 5' ? ['a', 'dir', 'file'] : ['a', 'dir', 'file', 'img']; // webpack 4: img.png is no chunk's file
    assert.deepEqual(lockedNames(plugin().lockfile(c)), expected, shape);
  }
});

test('webpack adapter: more than 20,000 files below a copied directory in node_modules: not all compared, said once per compiler', () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/dir/package.json': { name: 'dir', version: '1.0.0' } });
  for (let i = 0; i < 20001; i++) fs.writeFileSync(J(root, `node_modules/dir/${i}.txt`), '');
  const assets = new Map([['main.js', 'main'], ['copied.txt', 'unnamed']].map(([name, content]) => [name, { name, source: { size: () => content.length, source: () => content }, info: {} }]));
  const compiler = { context: root, outputPath: newOutputDir(root), [BUNDLER_FILE]: BUNDLERS.webpack };
  const freshCompilation = () => ({ // (a new one per build: the plugin keeps what it found on it)
    compiler,
    chunks: [{ files: new Set(['main.js']), modulesIterable: [{ resource: J(root, 'node_modules/a/i.js') }] }],
    modules: [], children: [], fileDependencies: new Set(), contextDependencies: new Set([J(root, 'node_modules/dir')]),
    getAsset: (n) => assets.get(n), getAssets: () => [...assets.values()],
  });
  const p = plugin();
  const seen = warnings(() => { p.lockfile(freshCompilation()); p.lockfile(freshCompilation()); }); // two builds of one compiler
  assert.equal(seen.length, 1, seen.join('\n'));
  assert.match(seen[0], /^more than 20000 files below the directories in node_modules that \S+'s build depends on: assets copied from them without naming their source were not all compared$/);
});

test('webpack adapter: webpack 5 minimizes unnamed copies; they are matched before the optimize stages (also on 5.0, without compiler.webpack)', () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/file/package.json': { name: 'file', version: '1.0.0' },
    'node_modules/file/f.css': 'body {  margin: 0  }' });
  // webpack 5.0.0 has no compiler.webpack (5.1.0 adds it): the stages are its Compilation class's
  class Compilation { static PROCESS_ASSETS_STAGE_OPTIMIZE = 100; }
  for (const shape of ['webpack >= 5.1', 'webpack 5.0']) {
    const { compiler, taps } = fakeCompiler5({ outputPath: J(root, `dist-${shape.replace(/\W/g, '')}`), withWebpack: shape !== 'webpack 5.0' });
    if (compiler.webpack) compiler.webpack.Compilation = { PROCESS_ASSETS_STAGE_OPTIMIZE: 100 };
    const p = new webpackAdapter.BundleLockfilePlugin(LOCK);
    p.apply(compiler);
    const build = (beforeOptimize) => {
      const src = (content) => ({ size: () => Buffer.byteLength(content), source: () => content });
      const assets = new Map([['main.js', { name: 'main.js', source: src('main'), info: {} }],
        ['css/f.css', { name: 'css/f.css', source: src('body {  margin: 0  }'), info: { copied: true } }]]);
      let stage, optimize;
      const comp = Object.assign(new Compilation(), {
        compiler, chunks: [{ files: new Set(['main.js']), modulesIterable: [{ resource: J(root, 'node_modules/a/i.js') }] }], children: [],
        fileDependencies: new Set([J(root, 'node_modules/a/i.js'), J(root, 'node_modules/file/f.css')]),
        getAsset: (n) => assets.get(n), getAssets: () => [...assets.values()], emitAsset: () => {},
        hooks: { processAssets: { tap: (o, fn) => { assert.equal(o.stage, 99); optimize = fn; } }, afterProcessAssets: { tap: (o, fn) => (stage = fn) } },
      });
      taps.thisCompilation(comp);
      assert.ok(optimize, `${shape}: a tap before the optimize stages`);
      if (beforeOptimize) optimize();
      assets.get('css/f.css').source = src('body{margin:0}'); // a minimizer at the optimize stages
      stage();
      return lockedNames(p.lockfile(comp));
    };
    assert.deepEqual(build(true), ['a', 'file'], shape);
    assert.deepEqual(build(false), ['a'], shape); // after minimizing, the bytes are no package file's
  }
});

test('webpack adapter: style sheets a shipped style module\'s loaders inlined from packages (Sass, Less, PostCSS)', () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('bulma'), ...pj('nless'), ...pj('rel'), ...pj('tw'), ...pj('inlined'), ...pj('jsasset'), ...pj('sfc'), ...pj('loader'),
    ...pj('icons'), ...pj('unshipped') });
  const nm = (name, f) => J(root, 'node_modules', name, f);
  const src = (f) => J(root, 'src', f);
  // the issuer of mini-css-extract's CssModule: the style module, built with Tailwind (webpack 5: only a snapshot)
  const tailwind = { resource: src('c.css'), nameForCondition: () => src('c.css'), buildInfo: { snapshot: { fileTimestamps: new Map([[nm('tw', 'index.css'), {}]]) } } };
  const c = compilation({
    context: root,
    chunks: [{ files: ['main.js'], modules: [
      // webpack 4: sass-loader's partials in buildInfo.fileDependencies; package.json files read on the way are no style sheets
      { resource: src('a.scss'), buildInfo: { fileDependencies: new Set([src('a.scss'), nm('bulma', 'm.scss'), nm('bulma', 'package.json')]) } },
      // webpack 5: buildInfo.fileDependencies cleared after the build of a cacheable module, the snapshot has them
      { modules: [{ resource: src('b.less'), buildInfo: { fileDependencies: undefined, snapshot: { getFileIterable: () => [nm('nless', 'n.less')] } } }] },
      // less-loader 7 (webpack 4): what Less found from the working directory, relative to it
      { resource: src('e.less'), buildInfo: { fileDependencies: new Set([path.relative(process.cwd(), nm('rel', 'r.css'))]) } },
      { nameForCondition: () => src('c.css'), issuer: tailwind, buildInfo: { hash: 'x' } },
      // a module that is no style sheet, whose loaders inlined one: style too (an Angular component's styles; a Vue
      // single-file component's <style lang="scss"> is App.vue?vue&type=style, whose file is App.vue)
      { resource: src('x.js'), buildInfo: { fileDependencies: new Set([nm('inlined', 'x.css'), nm('jsasset', 'logo.svg')]) } },
      { resource: `${src('App.vue')}?vue&type=style&index=0&lang=scss`, nameForCondition: () => src('App.vue'),
        buildInfo: { fileDependencies: new Set([src('App.vue'), nm('sfc', '_v.scss'), nm('loader', 'helper.js')]) } },
      // a style sheet whose CSS embeds a package's image as a data: URL (mini-css-extract-plugin built the asset module
      // at build time: in no chunk; its file is among the style module's dependencies)
      { resource: src('icons.css'), buildInfo: { fileDependencies: new Set([src('icons.css'), nm('icons', 'alarm.svg'), nm('loader', 'runtime.js')]) } },
    ] }],
  });
  c.modules = [{ resource: src('d.scss'), buildInfo: { fileDependencies: new Set([nm('unshipped', 'u.scss')]) } }]; // in no chunk
  // (jsasset's logo.svg: a file a loader of a module that is no style read - and inlined, as an svg-inline-loader would;
  // the loader's files: code; bulma's package.json: read by the resolver)
  assert.deepEqual(lockedNames(plugin().lockfile(c)), ['bulma', 'icons', 'inlined', 'jsasset', 'nless', 'rel', 'sfc', 'tw']);
});

test('webpack adapter: files a shipped module\'s loaders inlined from packages (glslify includes, merged JSON), not code or build settings', () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('glsl-noise'), ...pj('locales'), ...pj('@types/node'), ...pj('@tsconfig/node22'), ...pj('babel-preset'), ...pj('helper'),
    ...pj('browserslist-config'), ...pj('unshipped'), ...pj('vendor-copy'), 'vendor/v/package.json': { name: 'vendor-copy', version: '2.0.0' } });
  const nm = (name, f) => J(root, 'node_modules', name, f);
  const src = (f) => J(root, 'src', f);
  const c = compilation({
    context: root,
    chunks: [{ files: ['main.js'], modules: [
      // glslify-loader: a shader's #pragma glslify: import of a package's file (webpack 5: in the snapshot, inside a
      // concatenated module); a loader merging a package's locale JSON
      { modules: [{ resource: src('shader.glsl'), buildInfo: { snapshot: { getFileIterable: () => [src('shader.glsl'), nm('glsl-noise', 'simplex/3d.glsl')] } } }] },
      { resource: src('i18n.js'), buildInfo: { fileDependencies: new Set([src('i18n.js'), nm('locales', 'de.json')]) } },
      // ts-loader, babel-loader: type declarations, TypeScript and Babel settings and package.json files are read at build time
      { resource: src('main.ts'), buildInfo: { fileDependencies: new Set([src('main.ts'), nm('@types/node', 'index.d.ts'), nm('@tsconfig/node22', 'tsconfig.json'),
        nm('babel-preset', '.babelrc'), nm('browserslist-config', '.browserslistrc'), nm('helper', 'package.json'), nm('helper', 'index.cjs')]) } },
      // a vendored copy outside node_modules: its file counts as the copy
      { resource: src('v.js'), buildInfo: { fileDependencies: new Set([src('v.js'), J(root, 'vendor/v/data.txt')]) } },
    ] }],
  });
  c.modules = [{ resource: src('d.js'), buildInfo: { fileDependencies: new Set([nm('unshipped', 'u.glsl')]) } }]; // in no chunk
  assert.deepEqual(lockedNames(plugin().lockfile(c)), ['glsl-noise', 'locales', 'vendor-copy']);
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

test('webpack adapter: writer ids have no paths of this machine; ids of configs without absolute paths unchanged', () => {
  const writerIn = (root, entry) => {
    const c = compilation({ context: root, outputPath: J(root, 'dist'), chunks: [] });
    c.compiler.options = { entry, output: { filename: '[name].js' } };
    plugin().lockfile(c);
    return c.compiler[WRITER];
  };
  // the same config checked out at two paths, with entry: path.resolve(__dirname, 'src/app.js')
  const [a, b] = [project({}), project({})];
  const writerIds = [a, b].map(root => writerIn(root, { main: { import: [J(root, 'src/app.js')] } }));
  assert.equal(writerIds[0], writerIds[1]);
  assert.equal(writerIds[0], JSON.stringify([null, { main: { import: ['src/app.js'] } }, null, '[name].js', null]));
  // as before: relative paths, undefined fields (webpack's normalized entry) left out
  assert.equal(writerIn(project({}), { main: { import: ['./src/app.js'], filename: undefined } }),
    JSON.stringify([null, { main: { import: ['./src/app.js'] } }, null, '[name].js', null]));
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

test('webpack adapter: a new compiler for the same config keeps what the one it replaces left in the output (remnants)', () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c') });
  const outputPath = J(root, 'dist');
  fs.mkdirSync(outputPath);
  const options = { entry: { main: { import: ['./src/app.js'] } }, output: { filename: '[name].[contenthash].js' } };
  // a new compiler (a script that runs webpack(config) again, or `rollup -c`-style config arrays), other hashes, no clean
  const build = (dep, file) => {
    const c = compilation({ context: root, outputPath, chunks: [{ files: [file], modules: [{ resource: J(root, 'node_modules', dep, 'i.js') }] }], assets: { [file]: {} } });
    c.compiler.options = options;
    fs.writeFileSync(J(outputPath, file), dep);
    const json = plugin().lockfile(c);
    outputs.emitted(J(outputPath, LOCK), c.compiler[WRITER]);
    return lockedNames(json);
  };
  assert.deepEqual(build('a', 'main.1.js'), ['a']);
  assert.deepEqual(build('b', 'main.2.js'), ['a', 'b']); // main.1.js is still there, with a in it
  fs.rmSync(J(outputPath, 'main.1.js'));
  assert.deepEqual(build('c', 'main.3.js'), ['b', 'c']); // main.2.js is, main.1.js no longer
});

test('webpack adapter: an output below node_modules is a tool\'s cache: no lockfile (as for every bundler), except below node_modules/.cache/', async () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/mylib/package.json': { name: 'mylib', version: '1.0.0' } });
  for (const [dir, want] of [['node_modules/mylib/dist', false], ['node_modules/.cache/x', true]]) {
    const outputPath = J(root, dir);
    fs.mkdirSync(outputPath, { recursive: true });
    const { compiler, taps } = fakeCompiler5({ outputPath });
    Object.assign(compiler.outputFileSystem, { stat: fs.stat, lstat: fs.lstat });
    compiler.outputFileSystem.gracefulify = () => {}; // the real disk
    compiler.options = { entry: { main: { import: ['./src/app.js'] } } };
    new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
    const comp = compilation({ context: root, outputPath, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }] });
    Object.assign(comp, { compiler, errors: [], hooks: { afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) } } });
    taps.thisCompilation(comp);
    if (comp.stage) comp.stage();
    fs.writeFileSync(J(outputPath, 'main.js'), '');
    await new Promise(resolve => taps.afterEmit(comp, resolve));
    assert.deepEqual(comp.errors, [], dir);
    assert.equal(fs.existsSync(J(outputPath, LOCK)), want, dir);
  }
});

test('webpack adapter: BundleLockfilePlugin writes BUNDLE_LOCKFILE_FILE; naming another file fails each compilation', () => withConfig({ strict: true }, () => {
  problems.take();
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const run = (p) => {
    const outputPath = newOutputDir(root);
    const { compiler, taps } = fakeCompiler5({ outputPath });
    p.apply(compiler);
    const comp = compilation({ context: root, outputPath, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }] });
    const emitted = {};
    Object.assign(comp, { compiler, errors: [], emitAsset: (f) => { emitted[f] = true; }, hooks: { afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) } } });
    taps.thisCompilation(comp);
    comp.stage();
    return { errors: comp.errors.map(e => e.message), file: p.file };
  };
  // left out, or the setting's name (as the README showed it), also spelled otherwise: no problem
  for (const arg of [undefined, LOCK, `./${LOCK}`]) assert.deepEqual(run(new webpackAdapter.BundleLockfilePlugin(arg)), { errors: [], file: LOCK }, String(arg));
  // another name: the lockfile is still where the setting says (where other builds and copies look), and the build fails
  const other = run(new webpackAdapter.BundleLockfilePlugin('sbom/package-lock.json'));
  assert.equal(other.file, LOCK);
  assert.equal(other.errors.length, 1);
  assert.match(other.errors[0], /BundleLockfilePlugin\("sbom\/package-lock\.json"\) names another file than BUNDLE_LOCKFILE_FILE \(bundle-lockfile\/package-lock\.json\)/);
  // BUNDLE_LOCKFILE_TREE=only: the record goes to record.json, also from a plugin naming the setting's package-lock.json
  return withConfig({ file: 'bundle-lockfile/record.json', tree: 'only' }, () => {
    assert.deepEqual(run(new webpackAdapter.BundleLockfilePlugin(LOCK)), { errors: [], file: 'bundle-lockfile/record.json' });
  });
}));

test('webpack adapter: webpack 4 with the plugin added by hand records its version (from the patched Compiler, or the copy that applied it)', () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const outputPath = J(root, 'dist');
  const { compiler, taps } = fakeCompiler5({ outputPath, withWebpack: false }); // webpack 4: no compiler.webpack
  new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler); // from the config: no compilerFile
  const comp = compilation4({ context: root, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }] });
  const emitted = {};
  Object.assign(comp, { compiler, emitAsset: undefined, hooks: { afterOptimizeAssets: { tap: (o, fn) => (comp.stage = fn) } } });
  comp.assets = new Proxy(comp.assets, { set: (t, k, v) => { emitted[k] = v; t[k] = v; return true; } });
  taps.thisCompilation(comp);
  comp.stage();
  const rec = JSON.parse(emitted[LOCK].source())['bundle-lockfile'];
  assert.deepEqual(rec.writers.map(w => w.bundler), [{ name: 'webpack', version: UNIT }]);
});

test('webpack adapter: a favicon a plugin reads from a package and emits while the assets are processed is listed (html-webpack-plugin 5, Rsbuild, HtmlRspackPlugin)', () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('fav-pkg'), ...pj('other'), 'node_modules/fav-pkg/favicon.ico': 'ICON', 'node_modules/other/o.ico': 'ICON2', 'src/own.ico': 'MINE' });
  const fav = J(root, 'node_modules/fav-pkg/favicon.ico');
  const RawSource = class { constructor(s) { this.s = s; } source() { return this.s; } size() { return Buffer.byteLength(this.s); } };
  // reads: what the plugin reads through the input file system in processAssets (after copiedUnnamed looked); emits:
  // the assets it adds then (name -> bytes); rspack: rspack's version and its plugins (the config's)
  const run = ({ reads = [], emits, rspack, plugins = [] }) => {
    const outputPath = newOutputDir(root);
    const { compiler, taps } = fakeCompiler5({ outputPath });
    const read = [];
    compiler.inputFileSystem = { readFile: (f, cb) => { read.push(f); fs.readFile(f, cb); } };
    compiler.webpack.Compilation = { PROCESS_ASSETS_STAGE_OPTIMIZE: 100 };
    if (rspack) { compiler.webpack.rspackVersion = rspack; compiler[BUNDLER_FILE] = BUNDLERS.rspack; }
    compiler.options = { plugins };
    new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
    const assets = new Map();
    const add = (name, bytes, info = {}) => assets.set(name, { name, info, source: new RawSource(bytes) });
    const comp = compilation({ context: root, outputPath, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }] });
    const emitted = {};
    let optimize;
    Object.assign(comp, {
      compiler, errors: [], fileDependencies: new Set(), emitAsset: (n, src) => { emitted[n] = src.source(); },
      getAsset: (n) => assets.get(n), getAssets: () => [...assets.values()],
      hooks: { processAssets: { tap: (o, fn) => (optimize = fn) }, afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) } },
    });
    add('main.js', 'main');
    taps.thisCompilation(comp);
    optimize();
    // the plugin: reads (the input file system's readFile, possibly unbound: promisify), then emits
    for (const f of reads) compiler.inputFileSystem.readFile.call(undefined, f, () => {});
    for (const [n, b] of Object.entries(emits)) add(n, b);
    comp.stage();
    return lockedNames(emitted[LOCK]);
  };
  assert.deepEqual(run({ reads: [fav], emits: { 'favicon.ico': 'ICON' } }), ['a', 'fav-pkg']);
  assert.deepEqual(run({ reads: [fav], emits: { 'static/favicon.ico': 'ICON' } }), ['a', 'fav-pkg']); // Rsbuild: faviconDistPath
  // read but not emitted as it is (another file's bytes), a first-party file, a package file not read: nothing
  assert.deepEqual(run({ reads: [fav], emits: { 'favicon.ico': 'ICON-resized' } }), ['a']);
  assert.deepEqual(run({ reads: [J(root, 'src/own.ico')], emits: { 'own.ico': 'MINE' } }), ['a']);
  assert.deepEqual(run({ reads: [], emits: { 'o.ico': 'ICON2' } }), ['a']);
  // rspack's built-in HtmlRspackPlugin reads the favicon in Rust: its option names it (relative to the context)
  const html = { name: 'HtmlRspackPlugin', _args: [{ favicon: 'node_modules/fav-pkg/favicon.ico' }] };
  assert.deepEqual(run({ emits: { 'favicon.ico': 'ICON' }, rspack: '2.2.8', plugins: [html] }), ['a', 'fav-pkg']);
  assert.deepEqual(run({ emits: { 'favicon.ico': 'ICON' }, rspack: '2.2.8' }), ['a']);
});

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

test('webpack adapter: plugin emits in webpack 5 and 4 (also without webpack-sources), injection skips a configured plugin', async () => {
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
    new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler); // webpack 4: no compilerFile, webpack-sources not found
    taps.thisCompilation(comp);
    stageTap();
    const json = emitted[LOCK];
    assert.deepEqual(entries(json).map(([k]) => k), ['node_modules/a'], `withWebpack=${withWebpack}`);
    // a plugin deleted it in the emit hook (compression-webpack-plugin with deleteOriginalAssets on webpack 4): put back
    delete emitted[LOCK];
    taps.emit(comp);
    assert.equal(emitted[LOCK], json, `withWebpack=${withWebpack}`);
    taps.emit(comp); // still there: left alone
    // not shared: no extra write; webpack goes on outside this compiler's builds (it may start another compiler)
    const owner = await new Promise(resolve => taps.afterEmit(comp, () => resolve(problems.current())));
    assert.equal(fs.existsSync(J(root, `out-${withWebpack}`, LOCK)), false, `withWebpack=${withWebpack}`);
    assert.equal(owner, undefined, `withWebpack=${withWebpack}`);
    assert.equal(compiler[Symbol.for('bundle-lockfile.webpack.applied')], true);
  }
});

test('webpack adapter: files copied in the emit hook (copy-webpack-plugin 5) count as the package files whose bytes they have', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('copied'), ...pj('other'), ...pj('empty'), ...pj('named'),
    'node_modules/copied/x.css': 'body{}', 'node_modules/other/z.css': 'BODY{}', 'node_modules/empty/e.css': '', 'src/robots.txt': 'x' });
  const dep = (f) => J(root, f);
  const DEPS = [dep('node_modules/a/i.js'), dep('node_modules/copied/x.css'), dep('node_modules/other/z.css'), dep('node_modules/empty/e.css'), dep('src/robots.txt')];
  // webpack 4 with output.futureEmitAssets (react-scripts 4 sets it) keeps only the sizes of emitted assets, as webpack 5
  // does, and its output file system (NodeOutputFileSystem) has no readFile: the bytes are read from the disk
  for (const shape of ['webpack 4', 'webpack 4 futureEmitAssets', 'webpack 5']) {
    const outputPath = J(root, shape === 'webpack 5' ? 'dist5' : shape === 'webpack 4' ? 'dist4' : 'dist4-future');
    const { compiler, taps } = fakeCompiler5({ outputPath, withWebpack: shape === 'webpack 5' });
    if (shape === 'webpack 5') compiler.outputFileSystem.readFile = fs.readFile;
    else compiler.outputFileSystem = Object.assign(new (class NodeOutputFileSystem {})(), compiler.outputFileSystem);
    const sizeOnly = shape !== 'webpack 4';
    new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
    // late: assets the emit hook adds (name -> [content, info]); deps: the compilation's file dependencies
    const build = async (late, deps = DEPS) => {
      const comp = {
        compiler, chunks: [{ files: ['main.js'], modulesIterable: [{ resource: dep('node_modules/a/i.js') }] }], children: [],
        fileDependencies: new Set(deps),
        hooks: { afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) }, afterOptimizeAssets: { tap: (o, fn) => (comp.stage = fn) } },
      };
      let add, sourceOf;
      if (shape !== 'webpack 5') { // assets: an object of sources, no asset info (webpack < 4.40), no emitAsset
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
        // webpack 5 (and 4 with futureEmitAssets) keeps only the size of emitted assets: the content is read from the output
        add(name, sizeOnly ? { source() { throw new Error('size only'); } } : { source: () => content }, info);
        fs.mkdirSync(path.dirname(J(outputPath, name)), { recursive: true });
        fs.writeFileSync(J(outputPath, name), content);
      }
      // webpack writes the lockfile asset (on the real disk, NodeOutputFileSystem, there is none: the plugin writes it)
      if (sourceOf(LOCK)) {
        fs.mkdirSync(J(outputPath, 'bundle-lockfile'), { recursive: true });
        fs.writeFileSync(J(outputPath, LOCK), sourceOf(LOCK).source());
      }
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
  webpackAdapter.onCjsLoad(W, './Compiler', () => '/p/node_modules/webpack/lib/Compiler.js');
  webpackAdapter.onCompiler((c) => seen.push(c));
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
  [Symbol.for('bundle-lockfile.webpack.bundler-file')]: ${JSON.stringify(BUNDLERS.webpack)},
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
  // (a deadline: a process that died before writing its marker fails the test, not hangs it)
  const until = async (file, end = Date.now() + 30000) => { while (!fs.existsSync(file)) { if (Date.now() > end) throw new Error(`timed out waiting for ${file}`); await new Promise(r => setTimeout(r, 10)); } };
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
      new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
      taps.thisCompilation(comp);
      comp.stage();
      taps.emit(comp);
      assert.deepEqual(emitted, [], `${kind}, inline=${inline}: no asset`);
      assert.equal(fs.existsSync(J(outputPath, LOCK)), false, `${kind}, inline=${inline}: not before the output has landed`);
      fs.mkdirSync(outputPath, { recursive: true }); // webpack has written main.js there
      await new Promise(resolve => taps.afterEmit(comp, resolve));
      assert.equal(fs.existsSync(J(outputPath, LOCK)), inline, `${kind}, inline=${inline}: inline file`);
      if (inline) assert.deepEqual(lockedNames(fs.readFileSync(J(outputPath, LOCK), 'utf8')), ['a']);
      assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'export', path.basename(outputPath), LOCK), 'utf8')), ['a'], `${kind}, inline=${inline}: export copy`);
    });
  }
});

test('webpack adapter: never applies itself to an rspack compiler (Next.js with next-rspack loads both)', () => {
  const W = fakeCompiler();
  webpackAdapter.onCjsLoad(W, './Compiler', () => '/p/node_modules/webpack/lib/Compiler.js');
  const c = new W();
  c.hooks = { thisCompilation: { tap() { throw new Error('tapped'); } } };
  c.webpack = { rspackVersion: '2.0.4' };
  c.compile();
  assert.equal(c[APPLIED_SYM], undefined);
});

test('webpack adapter: the modules are not looked at for copies unless an asset names no source (costly in rspack)', () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const c = compilation({ context: root, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }], assets: { 'main.js': {} } });
  c.getAsset = (name) => (name === 'main.js' ? { name, info: { sourceFilename: undefined }, source: { size: () => 0, source: () => '' } } : undefined);
  Object.defineProperty(c, 'modules', { get() { throw new Error('compilation.modules read'); } });
  assert.deepEqual(lockedNames(plugin().lockfile(c)), ['a']);
});

test('webpack adapter: an output directory another plugin removed after the build is not recreated for the lockfile (its export copy is written)', async () => {
  // Metabase's embed build: an afterEmit plugin copies its files into another directory and removes this one
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const outputPath = J(root, 'tmp-embed');
  fs.mkdirSync(outputPath);
  const { compiler, taps } = fakeCompiler5({ outputPath });
  Object.assign(compiler.outputFileSystem, { stat: fs.stat, lstat: fs.lstat });
  compiler.outputFileSystem.gracefulify = () => {}; // the real disk
  new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
  const comp = compilation({ context: root, outputPath, chunks: [{ files: ['embed.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }], assets: { 'embed.js': {} } });
  comp.compiler = compiler;
  comp.errors = [];
  comp.hooks = { afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) } };
  await withConfig({ strict: true, exportDir: J(root, 'export'), exportBase: root }, async () => {
    taps.thisCompilation(comp);
    comp.stage();
    fs.rmSync(outputPath, { recursive: true }); // the other plugin's afterEmit
    await new Promise(resolve => taps.afterEmit(comp, resolve));
  });
  assert.equal(fs.existsSync(outputPath), false);
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'export/tmp-embed', LOCK), 'utf8')), ['a']);
  assert.deepEqual(comp.errors, []);
});

// --- webpack and rspack

test('webpack adapter: a project path with "#" (webpack resources have "\\0#" there) lists its packages', () => {
  const root = project({ 'c#proj/node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'c#proj/src/i.js': '' });
  const esc = (f) => f.replace(/#/g, '\0#'); // enhanced-resolve's escape, kept in resource and nameForCondition()
  const res = esc(J(root, 'c#proj/node_modules/a/i.js'));
  assert.equal(webpackAdapter.sourceFile({ resource: res, nameForCondition: () => res }, () => null), J(root, 'c#proj/node_modules/a/i.js'));
  const c = compilation({ context: J(root, 'c#proj'), chunks: [{ files: ['main.js'], modules: [{ resource: res, nameForCondition: () => res },
    { resource: esc(J(root, 'c#proj/src/i.js')), nameForCondition: () => esc(J(root, 'c#proj/src/i.js')) }] }], assets: { 'main.js': {} } });
  assert.deepEqual(lockedNames(plugin().lockfile(c)), ['a']);
});

test('webpack adapter: assets that are a generate-only build\'s output (workbox GenerateSW: sw.js, workbox-<hash>.js) bring its packages', async () => {
  const generated = require('../../src/core/generated.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '7.4.1' } });
  const root = project({ ...pj('app'), ...pj('workbox-core'), ...pj('workbox-routing') });
  const [core, routing] = ['workbox-core', 'workbox-routing'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  // workbox-build's Rollup generate() (the rollup adapter records its chunks), with the source map comment it appends
  generated.addChunk('/* workbox runtime */', [core]);
  generated.addChunk('/* sw */', [routing]);
  const src = (content) => ({ source: () => content, size: () => Buffer.byteLength(content) });
  // webpack 5: GenerateSW emits them in processAssets, before the lockfile
  const assets = { 'main.js': src('main'), 'workbox-86637ee2.js': src('/* workbox runtime */\n//# sourceMappingURL=workbox-86637ee2.js.map'), 'sw.js': src(Buffer.from('/* sw */')) };
  const c = compilation({ context: root, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/app/i.js') }] }], assets: { 'main.js': {} } });
  c.getAsset = (name) => (assets[name] ? { name, source: assets[name], info: {} } : undefined);
  c.getAssets = () => Object.keys(assets).map(name => c.getAsset(name));
  assert.deepEqual(lockedNames(plugin().lockfile(c)), ['app', 'workbox-core', 'workbox-routing']);
  // webpack 4: GenerateSW emits them in the emit hook, after the lockfile
  const outputPath = J(root, 'dist4');
  const { compiler, taps } = fakeCompiler5({ outputPath, withWebpack: false });
  new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
  const comp = { compiler, chunks: [{ files: ['main.js'], modulesIterable: [{ resource: J(root, 'node_modules/app/i.js') }] }], children: [],
    assets: { 'main.js': src('main') }, hooks: { afterOptimizeAssets: { tap: (o, fn) => (comp.stage = fn) } } };
  taps.thisCompilation(comp);
  comp.stage();
  comp.assets['sw.js'] = src('/* sw */');
  fs.mkdirSync(J(outputPath, 'bundle-lockfile'), { recursive: true });
  fs.writeFileSync(J(outputPath, LOCK), comp.assets[LOCK].source());
  await new Promise(resolve => taps.afterEmit(comp, resolve));
  assert.deepEqual(lockedNames(fs.readFileSync(J(outputPath, LOCK), 'utf8')), ['app', 'workbox-routing']);
});

test('webpack adapter: files another plugin copies out of packages into the output after the build (filemanager-webpack-plugin) are listed', async () => {
  const copies = require('../../src/core/copies.cjs');
  copies.install();
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/copied/package.json': { name: 'copied', version: '2.0.0' },
    'node_modules/copied/dist/x.min.js': 'copied bytes', 'src/robots.txt': 'robots' });
  const outputPath = J(root, 'dist');
  fs.mkdirSync(outputPath);
  const { compiler, taps } = fakeCompiler5({ outputPath });
  Object.assign(compiler.outputFileSystem, { stat: fs.stat, lstat: fs.lstat });
  compiler.outputFileSystem.gracefulify = () => {}; // the real disk
  new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
  const comp = compilation({ context: root, outputPath, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }], assets: { 'main.js': {} } });
  Object.assign(comp, { compiler, errors: [], hooks: { afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) } } });
  taps.thisCompilation(comp);
  comp.stage();
  fs.writeFileSync(J(outputPath, 'main.js'), 'main');
  // the other plugin's afterEmit (it runs before bundle-lockfile's): a package file and a first-party file
  fs.mkdirSync(J(outputPath, 'vendor'));
  fs.copyFileSync(J(root, 'node_modules/copied/dist/x.min.js'), J(outputPath, 'vendor/x.min.js'));
  fs.copyFileSync(J(root, 'src/robots.txt'), J(outputPath, 'robots.txt'));
  await new Promise(resolve => taps.afterEmit(comp, resolve));
  assert.deepEqual(comp.errors, []);
  assert.deepEqual(lockedNames(fs.readFileSync(J(outputPath, LOCK), 'utf8')), ['a', 'copied']);
});

test('webpack adapter: a compilation sealed again (needAdditionalSeal) lists the packages of its new chunks', () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b') });
  const { compiler, taps } = fakeCompiler5({ outputPath: J(root, 'out-unseal') });
  new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
  const comp = compilation({ context: root, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }] });
  const emitted = [];
  Object.assign(comp, { compiler, emitAsset: (n, src) => emitted.push(src.source()), getAsset: () => undefined,
    hooks: { afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) }, unseal: { tap: (o, fn) => (comp.unseal = fn) } } });
  taps.thisCompilation(comp);
  comp.stage();
  comp.unseal();
  comp.chunks[0].modules = [{ resource: J(root, 'node_modules/a/i.js') }, { resource: J(root, 'node_modules/b/i.js') }];
  comp.stage();
  assert.deepEqual(emitted.map(lockedNames), [['a'], ['a', 'b']]);
});

test('webpack adapter: a style module whose snapshot failed (webpack 5: no file dependencies at all) lists the compilation\'s style sheets in packages', () => {
  const root = project({ 'node_modules/bulma/package.json': { name: 'bulma', version: '1.0.4' }, 'node_modules/bulma/sass/_x.scss': '' });
  const c = compilation({ context: root, chunks: [{ files: ['main.css'], modules: [{ resource: J(root, 'src/app.scss'), buildInfo: { snapshot: null } }] }], assets: { 'main.css': {} } });
  c.fileDependencies = new Set([J(root, 'src/app.scss'), J(root, 'node_modules/bulma/sass/_x.scss')]);
  assert.deepEqual(lockedNames(plugin().lockfile(c)), ['bulma']);
  // webpack 5's snapshot without getFileIterable (a shape before 5.0's release): its managed files are in packages
  const d = compilation({ context: root, chunks: [{ files: ['main.css'], modules: [{ resource: J(root, 'src/app.scss'),
    buildInfo: { snapshot: { fileTimestamps: new Map([[J(root, 'src/app.scss'), {}]]), managedFiles: new Set([J(root, 'node_modules/bulma/sass/_x.scss')]) } } }] }], assets: { 'main.css': {} } });
  assert.deepEqual(lockedNames(plugin().lockfile(d)), ['bulma']);
});

test('webpack adapter: writer ids have no machine paths also for entries outside the project (Yarn\'s global cache, a global store)', () => {
  const writerIn = (context, entry) => {
    const c = compilation({ context, outputPath: J(context, 'dist'), chunks: [] });
    c.compiler.options = { entry: { main: { import: [entry] } }, output: { filename: '[name].js' } };
    plugin().lockfile(c);
    return c.compiler[WRITER];
  };
  const cache = (home) => J(home, '.yarn/berry/cache/pkg-npm-1.0.0-abc.zip/node_modules/pkg/entry.js');
  const a = writerIn(J(os.tmpdir(), 'u1-proj'), cache('/home/u1')), b = writerIn(J(os.tmpdir(), 'ci/proj'), cache('/root'));
  assert.equal(a, b);
  assert.equal(a, JSON.stringify([null, { main: { import: ['node_modules/pkg/entry.js'] } }, null, '[name].js', null]));
});

test('webpack adapter: a generate-only build\'s assets still count when files written after the build make the lockfile render again (webpack 5 keeps only sizes then)', async () => {
  const generated = require('../../src/core/generated.cjs');
  const copies = require('../../src/core/copies.cjs');
  copies.install();
  const pj = (name, version = '1.0.0') => ({ [`node_modules/${name}/package.json`]: { name, version } });
  const root = project({ ...pj('a'), ...pj('wb-runtime'), ...pj('late'), 'node_modules/late/l.js': 'late bytes' });
  const [runtime] = packagesForFiles([J(root, 'node_modules/wb-runtime/i.js')]);
  generated.addChunk('/* the generated runtime */', [runtime]);
  const outputPath = J(root, 'dist');
  fs.mkdirSync(outputPath);
  const { compiler, taps } = fakeCompiler5({ outputPath });
  Object.assign(compiler.outputFileSystem, { stat: fs.stat, lstat: fs.lstat });
  compiler.outputFileSystem.gracefulify = () => {}; // the real disk
  new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
  const sources = { 'main.js': 'main', 'workbox-1.js': '/* the generated runtime */' };
  let emitted = false; // after the emit, webpack 5 keeps only the size of an asset
  const asset = (name) => ({ name, info: {}, source: { size: () => sources[name].length, source() { if (emitted) throw new Error('size only'); return sources[name]; } } });
  const comp = compilation({ context: root, outputPath, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }] });
  Object.assign(comp, { compiler, errors: [], getAsset: (n) => (n in sources ? asset(n) : undefined), getAssets: () => Object.keys(sources).map(asset),
    hooks: { afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) } } });
  taps.thisCompilation(comp);
  comp.stage();
  for (const [n, c] of Object.entries(sources)) fs.writeFileSync(J(outputPath, n), c);
  emitted = true;
  fs.copyFileSync(J(root, 'node_modules/late/l.js'), J(outputPath, 'l.js')); // another plugin's afterEmit
  await new Promise(resolve => taps.afterEmit(comp, resolve));
  assert.deepEqual(comp.errors, []);
  assert.deepEqual(lockedNames(fs.readFileSync(J(outputPath, LOCK), 'utf8')), ['a', 'late', 'wb-runtime']);
});

test('webpack adapter: directories among a module\'s file dependencies (webpack 5 snapshots) are no files it inlined', () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('@vanilla-extract/webpack-plugin'), 'node_modules/@vanilla-extract/webpack-plugin/loader/dist/x.js': '' });
  const nm = (f) => J(root, 'node_modules', f);
  const c = compilation({ context: root, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'src/styles.css.js'), buildInfo: { snapshot: {
    getFileIterable: () => [J(root, 'src/styles.css.js'), nm('@vanilla-extract'), nm('@vanilla-extract/webpack-plugin'), nm('@vanilla-extract/webpack-plugin/loader/dist')] } } }] }] });
  assert.deepEqual(lockedNames(plugin().lockfile(c)), []);
});

test('webpack adapter: a vendored webpack exported as a plain object around its namespace (umi) is patched', () => {
  const W = fakeCompiler();
  const exp = { webpack: Object.assign(function webpack() {}, { Compiler: W, Compilation: class {}, version: '5.110.3' }), Compiler: W };
  webpackAdapter.onCjsLoad(exp, '/p/node_modules/@umijs/bundler-webpack/compiled/webpack/index.js', () => '/p/node_modules/@umijs/bundler-webpack/compiled/webpack/index.js');
  assert.equal(W.prototype[PATCHED], true);
  // the same shape around rspack's, or with another name, is not webpack's
  const R = fakeCompiler();
  webpackAdapter.onCjsLoad({ webpack: Object.assign(function rspack() {}, { Compiler: R, Compilation: class {}, version: '5.75.0', rspackVersion: '1.7.12' }) }, '/p/node_modules/x-webpack/index.js', () => '/p/x.js');
  const O = fakeCompiler();
  webpackAdapter.onCjsLoad({ webpack: Object.assign(function webpack() {}, { Compiler: O, Compilation: class {}, version: '5.0.0' }) }, '/p/node_modules/other/index.js', () => '/p/other.js');
  assert.deepEqual([R.prototype[PATCHED], O.prototype[PATCHED]], [undefined, undefined]);
  // the exports of a module in a require() cycle (Node.js gives them a prototype that warns about reading a property
  // they do not have, as webpack 5.0's lib/ files are): only own properties are read
  const read = [];
  const cyclic = Object.create(new Proxy({}, { get: (t, k) => { read.push(k); return undefined; } }));
  webpackAdapter.onCjsLoad(cyclic, '/p/node_modules/webpack/lib/WebpackOptionsApply.js', () => '/p/node_modules/webpack/lib/WebpackOptionsApply.js');
  assert.deepEqual(read, []);
});
