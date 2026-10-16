'use strict';
// Unit tests of the Parcel adapter.
// All unit tests: node --test test/unit/*.test.cjs (see test/README.md)
// (helpers.cjs first: see there)
const { J, project, UNIT, LOCK, lockedNames, withConfig } = require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const problems = require('../../src/core/problems.cjs');

// Parcel: a fake @parcel/core lib/Parcel.js and bundle graph of the public API's shape (BundleGraph, Bundle, Asset)
test('parcel adapter: the Parcel class gets the reporter in its options; another shape fails (strict)', () => withConfig({ strict: true }, () => {
  const parcel = require('../../src/adapters/parcel.cjs');
  const where = '/p/node_modules/@parcel/core/lib/Parcel.js';
  class Parcel { constructor(o) { this.options = o; } run() {} watch() {} }
  const exp = { __esModule: true, default: Parcel };
  parcel.onCjsLoad(exp, where, () => where);
  assert.notEqual(exp.default, Parcel);
  assert.equal(exp.default.name, 'Parcel');
  const rep = (o) => o.additionalReporters.map(r => r.packageName);
  const cli = new exp.default({ entries: 'a', additionalReporters: [{ packageName: '@parcel/reporter-cli', resolveFrom: '/x' }] });
  assert.ok(cli instanceof Parcel);
  assert.deepEqual(rep(cli.options), ['@parcel/reporter-cli', parcel.REPORTER]); // last, after Parcel's own
  assert.deepEqual(rep(new exp.default({ entries: 'a' }).options), [parcel.REPORTER]);
  assert.deepEqual(rep(new exp.default(parcel.withReporter({ entries: 'a' })).options), [parcel.REPORTER]); // once
  const patched = exp.default;
  parcel.onCjsLoad(exp, where, () => where);
  assert.equal(exp.default, patched); // once per module
  // the reporter Parcel loads by its directory: engines.parcel, the plugin under Symbol.for('parcel-plugin-config')
  assert.equal(JSON.parse(fs.readFileSync(J(parcel.REPORTER, 'package.json'), 'utf8')).engines.parcel, '>=2.0.0');
  assert.equal(typeof require(parcel.REPORTER).default[Symbol.for('parcel-plugin-config')].report, 'function');
  problems.take();
  parcel.onCjsLoad({ default: class X {} }, where, () => where);
  assert.match(problems.take().join('\n'), /exports no Parcel class bundle-lockfile knows/);
  parcel.onCjsLoad({ default: Parcel }, '/p/node_modules/@parcel/core/lib/ParcelConfig.js', () => '');
  assert.equal(problems.count(), 0);
}));

function fakeBundleGraph(bundles) {
  const asset = (filePath, o = {}) => ({ filePath, sideEffects: o.sideEffects !== false, used: o.used || new Set(['default']), ref: !!o.ref });
  // (a bundle's type: Parcel's, e.g. 'js' or 'css' - the file's extension where the test gives none)
  const bs = bundles.map(b => ({ type: typeof b.filePath === 'string' ? path.extname(b.filePath).slice(1) : undefined, ...b, env: { shouldScopeHoist: b.scope !== false }, assets: b.assets.map(a => (typeof a === 'string' ? asset(a) : asset(a.f, a))),
    traverseAssets(fn) { for (const a of this.assets) fn(a); }, getMainEntry() { return this.assets[0]; } }));
  return { getBundles: () => bs, getUsedSymbols: (a) => a.used, isAssetReferenced: (b, a) => a.ref };
}

test('parcel adapter: the reporter writes the packages of every bundle\'s assets per distDir, not those the packager skips', () => withConfig({ strict: true }, async () => {
  const parcel = require('../../src/adapters/parcel.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('inl'), ...pj('skip'), ...pj('ref'), ...pj('lib'), 'node_modules/nopj/i.js': '', 'src/i.js': '',
    'node_modules/@parcel/packager-js/package.json': { name: '@parcel/packager-js', version: UNIT } }); // the code Parcel writes around JavaScript
  fakeParcelTracker(root, { 'src/i.js': [] }); // every Parcel build has a request graph (here: nothing inlined)
  // (one Parcel's plugin options: its builds replace each other's, see the test of two Parcels below)
  const options = { projectRoot: root };
  for (const f of ['dist/main.js', 'dist/main.css', 'lib/out/index.js']) { fs.mkdirSync(path.dirname(J(root, f)), { recursive: true }); fs.writeFileSync(J(root, f), f); }
  const target = (d) => ({ name: d, distDir: J(root, d) });
  const graph = fakeBundleGraph([
    { filePath: J(root, 'dist/main.js'), target: target('dist'), assets: [J(root, 'src/i.js'), J(root, 'node_modules/a/i.js'),
      { f: J(root, 'node_modules/skip/i.js'), sideEffects: false, used: new Set() }, { f: J(root, 'node_modules/ref/i.js'), sideEffects: false, used: new Set(), ref: true }] },
    { filePath: J(root, 'dist/main.css'), target: target('dist'), assets: [J(root, 'node_modules/a/s.css')] },
    { filePath: null, bundleBehavior: 'inline', target: target('dist'), assets: [J(root, 'node_modules/inl/i.js')] }, // inlined into another bundle
    { filePath: J(root, 'lib/out/index.js'), target: target('lib/out'), assets: [J(root, 'node_modules/lib/i.js')] }, // another target
  ]);
  await parcel.report({ event: { type: 'buildSuccess', bundleGraph: graph }, options });
  const dist = fs.readFileSync(J(root, 'dist', LOCK), 'utf8');
  assert.deepEqual(lockedNames(dist), ['a', 'inl', 'ref']); // not skip: no side effects, no used symbol, not referenced
  const w0 = JSON.parse(dist)['bundle-lockfile'].writers[0];
  assert.equal(w0.bundler.name, 'parcel');
  assert.deepEqual(Object.keys(w0.via).sort(), ['chunk', 'runtime']);
  assert.deepEqual(w0.via.runtime.map(i => w0.packages[i]), ['node_modules/@parcel/packager-js']);
  assert.deepEqual([...JSON.parse(dist)['bundle-lockfile'].writers[0].files].sort(), ['../main.css', '../main.js']);
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'lib/out', LOCK), 'utf8')), ['lib']);
  // a target below node_modules is a tool's cache - except below node_modules/.cache/ (core/paths.cjs inToolCache)
  for (const f of ['node_modules/.cache/x/main.js', 'node_modules/lib/dist/main.js']) { fs.mkdirSync(path.dirname(J(root, f)), { recursive: true }); fs.writeFileSync(J(root, f), f); }
  await parcel.report({ event: { type: 'buildSuccess', bundleGraph: fakeBundleGraph([
    { filePath: J(root, 'node_modules/.cache/x/main.js'), target: target('node_modules/.cache/x'), assets: [J(root, 'node_modules/a/i.js')] },
    { filePath: J(root, 'node_modules/lib/dist/main.js'), target: target('node_modules/lib/dist'), assets: [J(root, 'node_modules/a/i.js')] }]) }, options });
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'node_modules/.cache/x', LOCK), 'utf8')), ['a']);
  assert.equal(fs.existsSync(J(root, 'node_modules/lib/dist', LOCK)), false);
  // other events: nothing; a problem: thrown (Parcel fails the build with it)
  await parcel.report({ event: { type: 'buildStart' } });
  const bad = fakeBundleGraph([{ filePath: J(root, 'dist/main.js'), target: target('dist'), assets: [J(root, 'node_modules/nopj/i.js')] }]);
  await assert.rejects(parcel.report({ event: { type: 'buildSuccess', bundleGraph: bad }, options }), /no package\.json with name and version in \S*nopj/);
  problems.take(); // (also kept for the exit: Parcel's version is not known here, see failAtExit)
  // without scope hoisting nothing is skipped
  const noHoist = fakeBundleGraph([{ filePath: J(root, 'dist/main.js'), target: target('dist'), scope: false, assets: [{ f: J(root, 'node_modules/skip/i.js'), sideEffects: false, used: new Set() }] }]);
  await parcel.report({ event: { type: 'buildSuccess', bundleGraph: noHoist }, options });
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['skip']);
  // JavaScript only inlined into the HTML (<script type="module">): Parcel's code is around it too
  fs.mkdirSync(J(root, 'site'), { recursive: true });
  fs.writeFileSync(J(root, 'site/index.html'), '<script type="module">a</script>');
  const html = fakeBundleGraph([{ filePath: J(root, 'site/index.html'), type: 'html', target: target('site'), assets: [J(root, 'src/index.html')] },
    { filePath: null, type: 'js', bundleBehavior: 'inline', target: target('site'), assets: [J(root, 'node_modules/a/i.js')] }]);
  await parcel.report({ event: { type: 'buildSuccess', bundleGraph: html }, options });
  const site = JSON.parse(fs.readFileSync(J(root, 'site', LOCK), 'utf8'));
  assert.deepEqual(Object.values(site.packages).filter(p => p.name).map(p => p.name).sort(), ['@parcel/packager-js', 'a']);
  // a JavaScript bundle of a project that resolves no @parcel/packager-js: a problem (the code Parcel wrote would be
  // missing); a CSS-only output needs none
  const bare = project({ ...pj('a') });
  fakeParcelTracker(bare, {});
  for (const f of ['dist/main.js', 'dist/main.css']) { fs.mkdirSync(path.dirname(J(bare, f)), { recursive: true }); fs.writeFileSync(J(bare, f), f); }
  const css = fakeBundleGraph([{ filePath: J(bare, 'dist/main.css'), target: { name: 'dist', distDir: J(bare, 'dist') }, assets: [J(bare, 'node_modules/a/s.css')] }]);
  await parcel.report({ event: { type: 'buildSuccess', bundleGraph: css }, options: { projectRoot: bare } });
  const js = fakeBundleGraph([{ filePath: J(bare, 'dist/main.js'), target: { name: 'dist', distDir: J(bare, 'dist') }, assets: [J(bare, 'node_modules/a/i.js')] }]);
  await assert.rejects(parcel.report({ event: { type: 'buildSuccess', bundleGraph: js }, options: { projectRoot: bare } }), /resolves no @parcel\/packager-js/);
  problems.take(); // (also kept for the exit: Parcel's version is not known here, see failAtExit)
}));

// Only the JavaScript packager skips assets: a style sheet of a package without side effects, of which no symbol is
// used, that another style sheet @imports is in the CSS bundle (Parcel's CSS packager writes every asset)
test('parcel adapter: a CSS bundle lists the style sheets of packages without side effects', () => withConfig({ strict: true }, async () => {
  const parcel = require('../../src/adapters/parcel.cjs');
  const root = project({ 'node_modules/sfx/package.json': { name: 'sfx', version: '1.0.0', sideEffects: false }, 'node_modules/sfx/s.css': '', 'src/s.css': '' });
  fakeParcelTracker(root, { 'src/s.css': [] });
  fs.mkdirSync(J(root, 'dist'), { recursive: true }); fs.writeFileSync(J(root, 'dist/main.css'), '.sfx{}');
  const graph = fakeBundleGraph([{ filePath: J(root, 'dist/main.css'), target: { name: 'dist', distDir: J(root, 'dist') },
    assets: [J(root, 'src/s.css'), { f: J(root, 'node_modules/sfx/s.css'), sideEffects: false, used: new Set() }] }]);
  await parcel.report({ event: { type: 'buildSuccess', bundleGraph: graph }, options: { projectRoot: root } });
  const lock = JSON.parse(fs.readFileSync(J(root, 'dist', LOCK), 'utf8'));
  assert.deepEqual(lockedNames(JSON.stringify(lock)), ['sfx']);
  const w = lock['bundle-lockfile'].writers[0];
  assert.deepEqual(w.contents['../main.css'].map(i => w.packages[i]), ['node_modules/sfx']); // (also in the file's contents)
}));

// Two Parcels of one process (new Parcel().run() twice, as a script that builds several entries) into one distDir, of
// one target: the second is another run of the same writer, which keeps the files of the first that are still there,
// with their packages (core/outputs.cjs remnants); a rebuild of the second (the same plugin options: watch mode)
// replaces its own build
test('parcel adapter: a second Parcel of the process into the same distDir keeps the first one\'s packages', () => withConfig({ strict: true }, async () => {
  const parcel = require('../../src/adapters/parcel.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c'), 'node_modules/@parcel/packager-js/package.json': { name: '@parcel/packager-js', version: UNIT } });
  fakeParcelTracker(root, {});
  fs.mkdirSync(J(root, 'dist'), { recursive: true });
  for (const f of ['a.js', 'b.js']) fs.writeFileSync(J(root, 'dist', f), f);
  const target = { name: 'default', distDir: J(root, 'dist') };
  const build = (file, name) => fakeBundleGraph([{ filePath: J(root, 'dist', file), target, assets: [J(root, `node_modules/${name}/i.js`)] }]);
  const first = { projectRoot: root }, second = { projectRoot: root }; // (each Parcel's plugin options)
  await parcel.report({ event: { type: 'buildSuccess', bundleGraph: build('a.js', 'a') }, options: first });
  await parcel.report({ event: { type: 'buildSuccess', bundleGraph: build('b.js', 'b') }, options: second });
  const names = () => lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')); // (not the packager, at the version UNIT)
  assert.deepEqual(names(), ['a', 'b']);
  await parcel.report({ event: { type: 'buildSuccess', bundleGraph: build('b.js', 'c') }, options: second });
  assert.deepEqual(names(), ['a', 'c']);
}));

// A fake @parcel/core lib/RequestTracker.js (and its lib/projectPath.js) at root: a RequestTracker class whose instance,
// once it runs a request, has a request graph of Parcel's API (hasContentKey, getNodeIdByContentKey,
// getNodeIdsConnectedTo, getNode, getInvalidations). deps: { asset's file (project-relative): [files its asset request
// also depends on] }. shape: '2.16' (requestType numbers) or '2.0' (request nodes with value.type)
function fakeParcelTracker(root, deps, shape = '2.16') {
  const parcel = require('../../src/adapters/parcel.cjs');
  const lib = J(root, 'node_modules/@parcel/core/lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(J(lib, 'projectPath.js'), "const path = require('path');\n"
    + "exports.toProjectPath = (r, p) => path.relative(r, p);\nexports.fromProjectPath = (r, p) => path.resolve(r, p);\n");
  const EDGE = 3, nodes = [], byKey = new Map(), from = new Map();
  const addNode = (key, n) => { if (!byKey.has(key)) { byKey.set(key, nodes.length); nodes.push(n); } return byKey.get(key); };
  const file = (rel) => addNode(rel, shape === '2.0' ? { id: rel, type: 'file', value: { filePath: rel } } : { id: rel, type: 0 });
  for (const [asset, files] of Object.entries(deps)) {
    const req = addNode(`req:${asset}`, shape === '2.0' ? { type: 'request', value: { type: 'asset_request' } } : { type: 1, requestType: 9 });
    from.set(req, [asset, ...files].map(file));
  }
  // a request of another kind that depends on a file too (a path request): not an asset request, not counted
  if (Object.keys(deps).length) from.set(addNode('path', shape === '2.0' ? { type: 'request', value: { type: 'path_request' } } : { type: 1, requestType: 6 }), [file(Object.keys(deps)[0])]);
  const graph = {
    hasContentKey: (k) => byKey.has(k), getNodeIdByContentKey: (k) => byKey.get(k), getNode: (id) => nodes[id],
    getNodeIdsConnectedTo: (id, type) => (type === EDGE ? [...from].filter(([, to]) => to.includes(id)).map(([r]) => r) : []),
    getInvalidations: (id) => (from.get(id) || []).map(f => ({ type: 'file', filePath: nodes[f].id })),
  };
  class RequestTracker { constructor() { this.graph = graph; this.options = { projectRoot: root }; } runRequest() { return 'ran'; } }
  const exp = { default: RequestTracker, requestGraphEdgeTypes: { invalidated_by_update: EDGE }, ...(shape === '2.0' ? {} : { requestTypes: { asset_request: 9 } }) };
  const where = J(lib, 'RequestTracker.js');
  parcel.onCjsLoad(exp, where, () => where);
  const tracker = new exp.default();
  assert.equal(tracker.runRequest(), 'ran');
  return tracker;
}

test('parcel adapter: the files Parcel\'s transformers inline (Sass partials, Less @imports) from its request graph', () => withConfig({ strict: true }, async () => {
  const parcel = require('../../src/adapters/parcel.cjs');
  for (const shape of ['2.16', '2.0']) {
    const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
    const root = project({ ...pj('scss'), ...pj('less'), ...pj('cfg'), ...pj('notmine'), 'src/app.scss': '', 'src/app.less': '', 'src/i.js': '',
      'node_modules/scss/_p.scss': '', 'node_modules/less/p.less': '', 'node_modules/cfg/i.js': '', 'node_modules/notmine/_x.scss': '',
      'node_modules/@parcel/packager-js/package.json': { name: '@parcel/packager-js', version: UNIT } });
    for (const f of ['dist/main.js', 'dist/main.css']) { fs.mkdirSync(path.dirname(J(root, f)), { recursive: true }); fs.writeFileSync(J(root, f), f); }
    // the style sheets' asset requests depend on the package files they inline; a JavaScript asset's on code and on
    // a build tool's settings (neither counts); notmine's partial only on an asset that is in no bundle
    fakeParcelTracker(root, { 'src/app.scss': ['node_modules/scss/_p.scss'], 'src/app.less': ['node_modules/less/p.less'],
      'src/i.js': ['node_modules/cfg/i.js', 'tsconfig.json'], 'src/other.scss': ['node_modules/notmine/_x.scss'] }, shape);
    const target = { name: 'dist', distDir: J(root, 'dist') };
    const graph = fakeBundleGraph([
      { filePath: J(root, 'dist/main.js'), target, assets: [J(root, 'src/i.js')] },
      { filePath: J(root, 'dist/main.css'), target, assets: [J(root, 'src/app.scss'), J(root, 'src/app.less')] }]);
    await parcel.report({ event: { type: 'buildSuccess', bundleGraph: graph }, options: { projectRoot: root } });
    const lock = JSON.parse(fs.readFileSync(J(root, 'dist', LOCK), 'utf8'));
    assert.deepEqual(lockedNames(JSON.stringify(lock)), ['less', 'scss'], shape); // (not tsconfig.json, not cfg's code, not notmine)
    const w = lock['bundle-lockfile'].writers[0];
    assert.deepEqual(w.via.style.map(i => w.packages[i]).sort(), ['node_modules/less', 'node_modules/scss'], shape);
    // the CSS output's own packages (for a build that bundles it, nested bundles): its partials'
    assert.deepEqual(w.contents['../main.css'].map(i => w.packages[i]).sort(), ['node_modules/less', 'node_modules/scss'], shape);
  }
  // a project with style sheets and no request graph to read: a problem (strict: the build fails)
  const none = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/a/s.scss': '' });
  fs.mkdirSync(J(none, 'dist'), { recursive: true }); fs.writeFileSync(J(none, 'dist/main.css'), 'x');
  const css = fakeBundleGraph([{ filePath: J(none, 'dist/main.css'), target: { name: 'dist', distDir: J(none, 'dist') }, assets: [J(none, 'node_modules/a/s.scss')] }]);
  await assert.rejects(parcel.report({ event: { type: 'buildSuccess', bundleGraph: css }, options: { projectRoot: none } }), /no request graph of \S+: the style sheets Parcel's transformers inlined/);
  problems.take(); // (also kept for the exit: Parcel's version is not known here, see failAtExit)
  // a RequestTracker of another shape: a problem when it loads
  problems.take();
  const where = '/p/node_modules/@parcel/core/lib/RequestTracker.js';
  parcel.onCjsLoad({ default: class RequestTracker {} }, where, () => where);
  assert.match(problems.take().join('\n'), /is no RequestTracker bundle-lockfile knows/);
}));
