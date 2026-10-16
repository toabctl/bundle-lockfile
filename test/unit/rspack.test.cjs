'use strict';
// Unit tests of the rspack adapter.
// All unit tests: node --test test/unit/*.test.cjs (see test/README.md)
// (helpers.cjs first: see there)
const {
  PATCHED, J, project, BUNDLER_FILE, BUNDLERS, warnings, fakeCompiler, compilation, LOCK, plugin, lockedNames,
  withConfig, fakeCompiler5, APPLIED_SYM, fakeRspack, rspackCompilation,
} = require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const webpackAdapter = require('../../src/adapters/webpack.cjs');
const problems = require('../../src/core/problems.cjs');
const rspackAdapter = require('../../src/adapters/rspack.cjs');

const RSPACK_PATCHED = Symbol.for('bundle-lockfile.rspack.patched');

// an instance of it, as rspack() makes one: hooks the plugin taps (taps: what was tapped on thisCompilation)
function rspackCompiler(exp, outputPath = '/p/dist') {
  const c = new exp.Compiler();
  const taps = [];
  c.outputPath = outputPath;
  c.hooks = { thisCompilation: { tap: (n, fn) => taps.push(fn) }, emit: { tap() {} }, afterEmit: { tapAsync() {} } };
  c[BUNDLER_FILE] = BUNDLERS.rspack;
  c.webpack = { rspackVersion: exp.rspackVersion, sources: { RawSource: class { constructor(s) { this.s = s; } source() { return this.s; } } } };
  return { c, taps };
}

test('rspack adapter: patches rspack\'s Compiler (not webpack\'s), once per class whatever path it is seen on', () => {
  const exp = fakeRspack('2.2.8');
  const orig = exp.Compiler.prototype.compile;
  webpackAdapter.onCjsLoad(exp, '@rspack/core', () => '/p/node_modules/@rspack/core/dist/index.js');
  assert.equal(exp.Compiler.prototype[PATCHED], undefined, 'webpack.cjs leaves rspack alone');
  rspackAdapter.onCjsLoad(exp, '@rspack/core', () => '/p/node_modules/@rspack/core/dist/index.js');
  assert.equal(exp.Compiler.prototype[RSPACK_PATCHED], true);
  const patched = exp.Compiler.prototype.compile;
  assert.notEqual(patched, orig);
  // the same class through the ES module entry (rspack 2 imported and required in one process): not patched again
  assert.equal(rspackAdapter.esmWrap('rspack', 'Compiler', exp.Compiler), exp.Compiler);
  assert.equal(exp.Compiler.prototype.compile, patched);
  assert.equal(rspackAdapter.esmWrap('rollup', 'rollup', () => {}), null);
  // a second copy of @rspack/core (OHIF loads rspack 1 and 2): its own class, patched too
  const other = fakeRspack('1.7.12');
  assert.equal(rspackAdapter.esmWrap('rspack', 'Compiler', other.Compiler), other.Compiler);
  assert.equal(other.Compiler.prototype[RSPACK_PATCHED], true);
  // webpack's namespace and other functions: not rspack's
  const W = fakeCompiler();
  rspackAdapter.onCjsLoad(Object.assign(function webpack() {}, { Compiler: W, Compilation: class {}, version: '5.111.1' }), 'webpack', () => '/p/node_modules/webpack/lib/index.js');
  assert.equal(W.prototype[RSPACK_PATCHED], undefined);
  rspackAdapter.onCjsLoad(() => {}, 'x', () => '/p/x.js');
});

test('rspack adapter: every top-level compiler of rspack 1.1+ gets the plugin once; 1.0 and 0.x fail their compilations', async () => {
  for (const strict of [true, false]) {
    await withConfig({ strict }, () => {
      problems.take();
      const exp = fakeRspack('2.2.8');
      rspackAdapter.onCjsLoad(exp, '@rspack/core', () => '/p/rspack.js');
      const { c } = rspackCompiler(exp);
      c.compile(); c.compile();
      assert.equal(c[APPLIED_SYM], true);
      assert.equal(c.compiled, 2);
      const configured = rspackCompiler(exp).c; // the plugin in its config already (or copied there: MF tree shaking)
      configured[APPLIED_SYM] = 'config';
      configured.compile();
      assert.equal(configured[APPLIED_SYM], 'config');
      const child = rspackCompiler(exp).c;
      child.isChild = () => true;
      child.compile();
      assert.equal(child[APPLIED_SYM], undefined);
      // rspack 1.0: no inner modules of concatenated modules - each compilation fails (strict), or a warning (once). The
      // plugin knows (also one in the config, see the next test): it taps nothing else
      const old = fakeRspack('1.0.14');
      rspackAdapter.onCjsLoad(old, '@rspack/core', () => '/p/rspack.js');
      const { c: o, taps } = rspackCompiler(old, '/p/old');
      o.compile();
      assert.equal(o.compiled, 1);
      for (let i = 0; i < 2; i++) {
        const comp = { errors: [] };
        const warned = warnings(() => { for (const fn of taps) fn(comp); });
        assert.equal(taps.length, 1);
        if (strict) {
          assert.deepEqual(warned, []);
          assert.equal(comp.errors.length, 1);
          assert.match(comp.errors[0].message, /rspack 1\.0\.14 is not supported \(it needs 1\.1 or later\): no lockfile for \/p\/old/);
        } else {
          assert.deepEqual(comp.errors, []);
          if (i === 0) assert.match(warned.join(), /rspack 1\.0\.14 is not supported/); else assert.deepEqual(warned, []);
        }
      }
      // rspack 0.x: no plugin, and its compilation fails (strict), or a warning
      const ancient = fakeRspack('0.7.5');
      rspackAdapter.onCjsLoad(ancient, '@rspack/core', () => '/p/rspack.js');
      const { c: a, taps: at } = rspackCompiler(ancient, '/p/ancient');
      const warned = warnings(() => a.compile());
      assert.equal(a[APPLIED_SYM], undefined);
      assert.equal(a.compiled, 1);
      if (strict) {
        assert.deepEqual(warned, []);
        const comp = { errors: [] };
        for (const fn of at) fn(comp);
        assert.equal(comp.errors.length, 1);
        assert.match(comp.errors[0].message, /rspack 0\.7\.5 is not supported \(it needs 1\.1 or later\): its builds write no lockfile/);
      } else {
        assert.match(warned.join(), /rspack 0\.7\.5 is not supported/);
        assert.equal(at.length, 0);
      }
      assert.equal(problems.pending(), false);
    });
  }
});

test('rspack: the plugin reads optional hooks without tripping rspack 2\'s hooks Proxy', () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const { compiler, taps } = fakeCompiler5({ outputPath: J(root, 'out-proxy') });
  compiler.webpack.rspackVersion = '2.2.8';
  compiler.webpack.Compilation = { PROCESS_ASSETS_STAGE_OPTIMIZE: 100 };
  const strictHooks = (o) => new Proxy(o, { get(t, k) { if (!(k in t)) throw new Error(`Compilation.hooks.${String(k)} is not supported in rspack`); return t[k]; } });
  compiler.hooks = strictHooks(compiler.hooks);
  new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
  const comp = compilation({ context: root, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }] });
  comp.compiler = compiler;
  const stages = {};
  comp.hooks = strictHooks({ processAssets: { tap: (o, fn) => (stages.copies = fn) }, afterProcessAssets: { tap: (o, fn) => (stages.after = fn) } });
  taps.thisCompilation(comp);
  stages.copies();
  stages.after();
  assert.equal(typeof stages.after, 'function');
});

test('rspack: files CopyRspackPlugin copied are found among the file dependencies by name, path and bytes', () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('left-pad'), ...pj('normalize.css'), ...pj('other'), ...pj('linked-real'), ...pj('glob'),
    'node_modules/left-pad/index.js': 'pad', 'node_modules/left-pad/perf/O(n).js': 'perf', 'node_modules/other/index.js': 'other',
    'node_modules/normalize.css/normalize.css': 'body{margin:0}', 'node_modules/glob/a.js': 'ga', 'src/index.js': 'app', 'static/hello.txt': 'hi',
    'node_modules/.pnpm/linked-real@2.0.0/node_modules/linked-real/LICENSE': 'MIT text',
    'node_modules/.pnpm/linked-real@2.0.0/node_modules/linked-real/package.json': { name: 'linked-real', version: '2.0.0' } });
  fs.rmSync(J(root, 'node_modules/linked-real'), { recursive: true });
  // pnpm: reached through a link into its store
  fs.symlinkSync(J(root, 'node_modules/.pnpm/linked-real@2.0.0/node_modules/linked-real'), J(root, 'node_modules/linked-real'));
  const deps = ['node_modules/left-pad/index.js', 'node_modules/left-pad/perf/O(n).js', 'node_modules/left-pad/package.json', 'node_modules/other/index.js',
    'node_modules/normalize.css/normalize.css', 'node_modules/glob/a.js', 'src/index.js', 'static/hello.txt', 'node_modules/linked-real/LICENSE',
    'node_modules/.pnpm/linked-real@2.0.0/node_modules/linked-real/LICENSE', 'node_modules/left-pad/index.js'].map(f => J(root, f)); // the real path too, and a duplicate (rspack 1)
  const copy = (sourceFilename, bytes) => ({ info: { copied: true, sourceFilename }, bytes });
  const lockOf = (assets) => lockedNames(plugin().lockfile(rspackCompilation(root, { chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'src/index.js') }] }], assets, fileDependencies: deps })));
  // a copied file: its name only; a directory: the path in it; generic names (index.js) told apart by their bytes
  assert.deepEqual(lockOf({ 'a/normalize.css': copy('normalize.css', 'body{margin:0}') }), ['normalize.css']);
  assert.deepEqual(lockOf({ 'b/index.js': copy('index.js', 'pad'), 'b/perf/O(n).js': copy('perf/O(n).js', 'perf') }), ['left-pad']);
  assert.deepEqual(lockOf({ 'x/index.js': copy('index.js', 'other') }), ['other']);
  // through a symbolic link: the same file once (keyed by its real place, as pnpm's packages are)
  assert.deepEqual(lockOf({ 'l/LICENSE': copy('LICENSE', 'MIT text') }), ['.pnpm/linked-real@2.0.0/node_modules/linked-real']);
  // transformed on the way (no package file has its bytes): every package file it may be
  assert.deepEqual(lockOf({ 'e/index.js': copy('index.js', '/* banner */ pad') }), ['left-pad', 'other']);
  // first-party copies list nothing; a query is no part of the name
  assert.deepEqual(lockOf({ 'hello.txt': copy('hello.txt', 'hi'), 'g/a.js': copy('a.js?v=1', 'ga') }), ['glob']);
  // no file of that name among the dependencies: its bytes (rare: a copy plugin that does not add them)
  assert.deepEqual(lockOf({ 'renamed.js': copy('gone.js', 'ga') }), ['glob']);
  // a first-party file with a package file's name (OHIF: public/config/default.js as app-config.js, js-yaml has a
  // lib/schema/default.js), and a first-party package.json (the resolver reads every package's): its own bytes, no package
  fs.mkdirSync(J(root, 'public/config'), { recursive: true });
  fs.writeFileSync(J(root, 'public/config/default.js'), 'window.config = {};');
  fs.mkdirSync(J(root, 'node_modules/yaml/lib/schema'), { recursive: true });
  fs.writeFileSync(J(root, 'node_modules/yaml/package.json'), JSON.stringify({ name: 'yaml', version: '1.0.0' }));
  fs.writeFileSync(J(root, 'node_modules/yaml/lib/schema/default.js'), 'module.exports = schema;');
  fs.writeFileSync(J(root, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }));
  deps.push(...['public/config/default.js', 'node_modules/yaml/lib/schema/default.js', 'package.json', 'node_modules/yaml/package.json'].map(f => J(root, f)));
  assert.deepEqual(lockOf({ 'app-config.js': copy('default.js', 'window.config = {};') }), []);
  assert.deepEqual(lockOf({ 'package.json': copy('package.json', fs.readFileSync(J(root, 'package.json'), 'utf8')) }), []);
  // transformed on the way (a library's package.json with a field changed): the file at the name below the context, the
  // copy pattern's default one, is its source - not every package's package.json the resolver read
  assert.deepEqual(lockOf({ 'package.json': copy('package.json', '{"name":"app","version":"1.0.0","private":true}') }), []);
});

test('rspack: style sheets loaders inlined - per module from 1.3.14, from the file dependencies before', () => {
  const root = project({ 'node_modules/bulma/package.json': { name: 'bulma', version: '1.0.4' }, 'node_modules/bulma/sass/_x.scss': '',
    'node_modules/other/package.json': { name: 'other', version: '1.0.0' }, 'node_modules/other/i.js': '' });
  const css = (buildInfo) => ({ nameForCondition: () => J(root, 'src/style.scss'), buildInfo });
  const deps = [J(root, 'src/style.scss'), J(root, 'node_modules/bulma/sass/_x.scss'), J(root, 'node_modules/other/i.js')];
  const lockOf = (m) => lockedNames(plugin().lockfile(rspackCompilation(root, { chunks: [{ files: ['main.css'], modules: [m] }], fileDependencies: deps })));
  assert.deepEqual(lockOf(css({})), ['bulma']); // rspack < 1.3.14: buildInfo without fileDependencies
  assert.deepEqual(lockOf(css({ fileDependencies: new Set([J(root, 'src/style.scss')]) })), []); // recorded: none from packages
  assert.deepEqual(lockOf(css({ fileDependencies: new Set([J(root, 'node_modules/bulma/sass/_x.scss')]) })), ['bulma']);
});

test('rspack: the match resource names a module also where nameForCondition() does not (rspack before 1.7)', () => {
  const m = { resource: '/p/src/a.css.ts', matchResource: '/p/node_modules/@vanilla-extract/webpack-plugin/extracted.js?x', nameForCondition: () => '/p/src/a.css.ts' };
  assert.equal(webpackAdapter.sourceFile(m, () => null), '/p/node_modules/@vanilla-extract/webpack-plugin/extracted.js');
  assert.equal(webpackAdapter.sourceFile({ resource: '/p/src/b.js', matchResource: '', nameForCondition: () => '/p/src/b.js' }, () => null), '/p/src/b.js');
});

test('rspack: modules whose exports were all inlined are listed (only with inlining on); tree-shaken ones not', () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('shipped'), ...pj('consts'), ...pj('unused'), ...pj('inner') });
  const mod = (name, id) => ({ resource: J(root, 'node_modules', name, 'i.js'), identifier: () => id });
  const shipped = mod('shipped', 'a'), consts = mod('consts', 'b'), unused = mod('unused', 'c'), inner = mod('inner', 'd');
  const concatenated = { identifier: () => 'a|concat', nameForCondition: () => J(root, 'src/index.js'), modules: [inner] };
  const used = new Set([consts, inner, shipped]); // isModuleUsed: inlined exports still count as used
  const lockOf = (optimization) => lockedNames(plugin().lockfile(rspackCompilation(root, {
    chunks: [{ files: ['main.js'], modules: [shipped, concatenated] }], modules: [consts, unused, inner], optimization, exportsUsed: (m) => used.has(m) })));
  assert.deepEqual(lockOf({ inlineExports: true, usedExports: true }), ['consts', 'inner', 'shipped']);
  // no inlining, or no usage analysis (development: every module counts as used): nothing more
  assert.deepEqual(lockOf({ inlineExports: false, usedExports: true }), ['inner', 'shipped']);
  assert.deepEqual(lockOf({ inlineExports: true, usedExports: false }), ['inner', 'shipped']);
  // a child compilation none of whose chunks ships (html-webpack-plugin's template): its used modules are not inlined
  // into the output
  const template = mod('unused', 'e');
  const c = rspackCompilation(root, { chunks: [{ files: ['main.js'], modules: [shipped] }], modules: [consts], optimization: { inlineExports: true, usedExports: true }, exportsUsed: (m) => m !== unused });
  c.chunks = new Set(c.chunks); // (as webpack and rspack have it)
  const child = compilation({ context: root, chunks: [{ files: ['__child-HtmlRspackPlugin_0'], entry: [{ resource: J(root, 'src/index.html') }], modules: [] }] });
  Object.assign(child, { modules: new Set([template]), moduleGraph: { getIssuer: () => null, getExportsInfo: () => ({ isModuleUsed: () => true }) } });
  child.compiler.options = { optimization: { inlineExports: true, usedExports: true } };
  c.children = [child];
  assert.deepEqual(lockedNames(plugin().lockfile(c)), ['consts', 'shipped']);
});

test('rspack 1.4 - 1.6: modules whose exports were inlined with experiments.inlineConst or inlineEnum are listed', () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('shipped'), ...pj('consts'), ...pj('unused') });
  const mod = (name, id) => ({ resource: J(root, 'node_modules', name, 'i.js'), identifier: () => id });
  const shipped = mod('shipped', 'a'), consts = mod('consts', 'b'), unused = mod('unused', 'c');
  const lockOf = (rspackVersion, experiments, optimization = { usedExports: true }, used = new Set([shipped, consts])) => lockedNames(plugin().lockfile(rspackCompilation(root, {
    chunks: [{ files: ['main.js'], modules: [shipped] }], modules: [consts, unused], optimization, experiments, rspackVersion, exportsUsed: (m) => used.has(m) })));
  // 1.5 and 1.6 (optimization.inlineExports is 1.7's): the inlined modules count as used
  assert.deepEqual(lockOf('1.6.8', { inlineConst: true }), ['consts', 'shipped']);
  assert.deepEqual(lockOf('1.6.8', { inlineEnum: true }), ['consts', 'shipped']);
  assert.deepEqual(lockOf('1.5.8', { inlineConst: true }), ['consts', 'shipped']);
  // without the experiment they inline nothing (the parser option fails without it); nor does rspack before 1.4; 1.7
  // inlines as optimization.inlineExports says (the experiments only set its default)
  assert.deepEqual(lockOf('1.6.8', {}), ['shipped']);
  assert.deepEqual(lockOf('1.3.15', { inlineConst: true }), ['shipped']);
  assert.deepEqual(lockOf('1.7.12', { inlineConst: true }, { usedExports: true, inlineExports: false }), ['shipped']);
  // without usage analysis every module counts as used, and nothing inlined leaves its chunk
  assert.deepEqual(lockOf('1.6.8', { inlineConst: true }, { usedExports: false }, new Set([shipped, consts, unused])), ['shipped']);
  // 1.4 records no use of what it inlined: every module of a package in no chunk counts (also with usedExports: false,
  // where it inlines too)
  assert.deepEqual(lockOf('1.4.11', { inlineConst: true }, { usedExports: true }, new Set([shipped])), ['consts', 'shipped', 'unused']);
  assert.deepEqual(lockOf('1.4.11', { inlineConst: true }, { usedExports: false }, new Set([shipped])), ['consts', 'shipped', 'unused']);
  assert.deepEqual(lockOf('1.4.11', {}, { usedExports: true }, new Set([shipped])), ['shipped']);
  // 1.5.0 - 1.5.3 as 1.4 (1.5.4 records the use); 1.5.0 - 1.5.2 inline also without usage analysis, 1.5.3 not
  for (const v of ['1.5.0', '1.5.3']) assert.deepEqual(lockOf(v, { inlineConst: true }, { usedExports: true }, new Set([shipped])), ['consts', 'shipped', 'unused'], v);
  assert.deepEqual(lockOf('1.5.2', { inlineConst: true }, { usedExports: false }, new Set([shipped, consts, unused])), ['consts', 'shipped', 'unused']);
  assert.deepEqual(lockOf('1.5.3', { inlineConst: true }, { usedExports: false }, new Set([shipped, consts, unused])), ['shipped']);
  assert.deepEqual(lockOf('1.5.4', { inlineConst: true }, { usedExports: true }, new Set([shipped])), ['shipped']);
});

test('rspack: BundleLockfilePlugin in an rspack 1.0 config fails each compilation (it cannot collect every package there)', () => withConfig({ strict: true }, () => {
  problems.take();
  const { c, taps } = rspackCompiler(fakeRspack('1.0.14'), '/p/hand');
  new rspackAdapter.BundleLockfilePlugin(LOCK).apply(c);
  assert.equal(taps.length, 1);
  for (let i = 0; i < 2; i++) {
    const comp = { errors: [] };
    taps[0](comp);
    assert.equal(comp.errors.length, 1);
    assert.match(comp.errors[0].message, /rspack 1\.0\.14 is not supported \(it needs 1\.1 or later\): no lockfile for \/p\/hand/);
  }
}));
