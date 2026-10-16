'use strict';
// Unit tests of the lockfile's format: package-lock.json and its bundle-lockfile record, read and written; bundled
// files of another build (nested).
// All unit tests: node --test test/unit/*.test.cjs (see test/README.md)
// (helpers.cjs first: see there)
const {
  packagesForFiles, strictEnv, SRC, J, project, UNIT, ids, pkg, warnings, entries, compilation, LOCK, plugin,
  lockedNames, rollupBuild,
} = require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const packages = require('../../src/core/packages.cjs');
const { toPackageLock } = require('../../src/core/lockfile.cjs');
const outputs = require('../../src/core/outputs.cjs');

test('toPackageLock: lockfileVersion 3, unnamed root, keys relative to the context, all in node_modules/', () => {
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
  // ../node_modules/h and .yarn/cache/<zip>/node_modules/y as keys would be skipped by Trivy (see the next test)
  assert.deepEqual(Object.keys(lock.packages), ['', 'node_modules/h', 'node_modules/debug/node_modules/ms', 'node_modules/ms-old', 'node_modules/ms',
    'node_modules/y']);
  assert.ok(json.endsWith('}\n'));
});

test('toPackageLock: every key starts with node_modules/, and the record gives the location of those that are not one', () => {
  // Trivy's npm analyzer skips keys that do not start with node_modules (GitLab's webpack context is below the project
  // root: all ../node_modules/ keys, none read); syft and Trivy take the package from the name field
  const { readMeta } = require('../../src/core/lockfile.cjs');
  const root = J(path.sep, 'p'), ctx = J(root, 'app'), dir = J(ctx, 'dist/bundle-lockfile');
  const all = [
    pkg('a', '1.0.0', J(ctx, 'node_modules/a')),                                   // in the context's node_modules
    pkg('a', '2.0.0', J(root, 'node_modules/a')),                                  // the same key without ../: taken
    pkg('b', '1.0.0', J(root, 'node_modules/b')),
    pkg('c', '1.0.0', J(root, 'node_modules/b/node_modules/c')),                   // nested: stays nested
    pkg('d', '1.0.0', J(root, '..', 'node_modules/d')),                            // two levels up
    pkg('e', '1.0.0', J(ctx, 'packages/w/node_modules/e')),                        // a workspace's own node_modules
    pkg('y', '1.0.0', J(ctx, '.yarn/cache/y-npm-1.0.0-abc.zip/node_modules/y')),   // Yarn PnP, project cache
    pkg('y', '2.0.0', J(ctx, '.yarn/cache/y-npm-2.0.0-def.zip/node_modules/y')),
  ];
  const json = toPackageLock(all, ctx, { dir, writers: [{ id: 'w', files: [J(ctx, 'dist/main.js')], paths: all.map(p => p.path) }] });
  const doc = JSON.parse(json);
  assert.deepEqual(entries(json).map(([k, p]) => `${k} = ${p.name}@${p.version}`), [
    'node_modules/a = a@1.0.0', 'node_modules/a@2.0.0 = a@2.0.0', 'node_modules/b = b@1.0.0', 'node_modules/b/node_modules/c = c@1.0.0',
    'node_modules/d = d@1.0.0', 'node_modules/e = e@1.0.0', 'node_modules/y = y@1.0.0', 'node_modules/y@2.0.0 = y@2.0.0']);
  assert.deepEqual(doc['bundle-lockfile'].locations, {
    'node_modules/a@2.0.0': '../node_modules/a', 'node_modules/b': '../node_modules/b', 'node_modules/b/node_modules/c': '../node_modules/b/node_modules/c',
    'node_modules/d': '../../node_modules/d', 'node_modules/e': 'packages/w/node_modules/e',
    'node_modules/y': '.yarn/cache/y-npm-1.0.0-abc.zip/node_modules/y', 'node_modules/y@2.0.0': '.yarn/cache/y-npm-2.0.0-def.zip/node_modules/y' });
  assert.equal(doc['bundle-lockfile'].outside, undefined);
  // another process reads the real locations back, and writes the same bytes
  const read = readMeta(json, dir).writers[0].pkgs;
  assert.deepEqual(read.map(p => p.path).sort(), all.map(p => p.path).sort());
  assert.equal(toPackageLock(read, ctx, { dir, writers: [{ id: 'w', files: [J(ctx, 'dist/main.js')], paths: read.map(p => p.path) }] }), json);
  // a record without "locations": its keys are the locations
  const old = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, '../node_modules/b': { name: 'b', version: '1.0.0' } },
    'bundle-lockfile': { v: 2, context: '../..', writers: [{ id: 'w', files: [], packages: ['../node_modules/b'] }] } });
  assert.deepEqual(readMeta(old, dir).writers[0].pkgs.map(p => p.path), [J(root, 'node_modules/b')]);
});

test('readMeta: a package is read with its name, version and license only - other fields of its entry are no record', () => {
  // an edited lockfile whose entry has fields of the record's own words ("unknown", "outside") or npm's ("dev")
  const { readMeta } = require('../../src/core/lockfile.cjs');
  const ctx = J(path.sep, 'p'), dir = J(ctx, 'dist/bundle-lockfile');
  const a = pkg('a', '1.0.0', J(ctx, 'node_modules/a'));
  const doc = JSON.parse(toPackageLock([a], ctx, { dir, writers: [{ id: 'w', files: [], paths: [a.path] }] }));
  Object.assign(doc.packages['node_modules/a'], { unknown: true, outside: 'node_modules/x', dev: true, license: { type: 'MIT' } });
  const [read] = readMeta(JSON.stringify(doc), dir).writers[0].pkgs;
  assert.deepEqual(read, { name: 'a', version: '1.0.0', path: a.path });
});

test('toPackageLock: a writer\'s bundler and how it found its packages (via), read back by another process', () => {
  const { readMeta } = require('../../src/core/lockfile.cjs');
  const via = require('../../src/core/via.cjs');
  const ctx = J(path.sep, 'p'), dir = J(ctx, 'dist/bundle-lockfile');
  const a = pkg('a', '1.0.0', J(ctx, 'node_modules/a')), b = pkg('b', '1.0.0', J(ctx, 'node_modules/b')), c = pkg('c', '1.0.0', J(ctx, 'node_modules/c'));
  const found = via.collector();
  found.add('style', [b]); found.add('chunk', [b, a]); found.add('child', [c]); found.add('late', [c]);
  assert.throws(() => found.add('guessed', [a]), /unknown via class guessed/);
  const w = { id: 'w', files: [J(ctx, 'dist/main.js')], paths: [a.path, b.path, c.path], bundler: { name: 'webpack', version: '5.111.1' }, via: found.byPath };
  const json = toPackageLock([a, b, c], ctx, { dir, writers: [w] });
  const rec = JSON.parse(json)['bundle-lockfile'];
  assert.equal(rec.v, 2);
  // the classes in core/via.cjs order, each with indices into the writer's packages
  assert.deepEqual(rec.writers[0].packages, ['node_modules/a', 'node_modules/b', 'node_modules/c']);
  assert.deepEqual(rec.writers[0].bundler, { name: 'webpack', version: '5.111.1' });
  assert.deepEqual(Object.entries(rec.writers[0].via), [['chunk', [0, 1]], ['child', [2]], ['style', [1]], ['late', [2]]]);
  // another process reads them back and writes the same bytes
  const r = readMeta(json, dir).writers[0];
  assert.deepEqual(r.bundler, { name: 'webpack', version: '5.111.1' });
  assert.deepEqual([...r.via].map(([p, s]) => [p, [...s].sort()]).sort(), [[a.path, ['chunk']], [b.path, ['chunk', 'style']], [c.path, ['child', 'late']]]);
  assert.equal(toPackageLock(r.pkgs, ctx, { dir, writers: [{ ...r, paths: r.pkgs.map(p => p.path) }] }), json);
  // without them: no fields
  const plain = JSON.parse(toPackageLock([a], ctx, { dir, writers: [{ id: 'w', files: [], paths: [a.path] }] }))['bundle-lockfile'].writers[0];
  assert.equal(plain.bundler, undefined);
  assert.equal(plain.via, undefined);
});

test('toPackageLock: a lockfile outside the project has a record without its paths, which only the same context anchors', () => {
  const { readMeta, reanchor } = require('../../src/core/lockfile.cjs');
  const base = fs.realpathSync(fs.mkdtempSync(J(os.tmpdir(), 'blr-anchor-')));
  const proj = J(base, 'proj'), other = J(base, 'other');
  for (const [d, name] of [[proj, 'app'], [J(proj, 'node_modules/a'), 'a'], [other, 'other']]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(J(d, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
  const a = pkg('a', '1.0.0', J(proj, 'node_modules/a'));
  const meta = (dir) => ({ dir, writers: [{ id: 'w', files: [J(path.dirname(dir), 'main.js')], paths: [a.path] }] });
  try {
    // inside the project: the paths, as always
    const inside = JSON.parse(toPackageLock([a], proj, meta(J(proj, 'dist/bundle-lockfile'))))['bundle-lockfile'];
    assert.deepEqual([inside.context, inside.self, inside.contextId], ['../..', 'dist/bundle-lockfile', undefined]);
    // outside it (an absolute outDir elsewhere): no path of this machine in the record
    const dir = J(base, 'srv/www/out/bundle-lockfile');
    const json = toPackageLock([a], proj, meta(dir));
    const rec = JSON.parse(json)['bundle-lockfile'];
    assert.equal(rec.context, undefined);
    assert.equal(rec.self, undefined);
    assert.match(rec.contextId, /^[0-9a-f]{16}$/);
    assert.match(rec.selfId, /^[0-9a-f]{16}$/);
    for (const word of ['srv', 'www', 'proj', path.basename(base)]) assert.ok(!JSON.stringify(rec).includes(word), word);
    // the same context reads it as written there, at the packages' locations
    const m = readMeta(json, dir, [J(base, 'x'), proj]);
    assert.equal(m.anchored, true);
    assert.deepEqual(m.writers[0].pkgs.map(p => p.path), [a.path]);
    // another context (another project), or none: a copy - the packages' locations are not known
    for (const contexts of [[other], []]) {
      const o = readMeta(json, dir, contexts);
      assert.equal(o.anchored, false);
      assert.deepEqual(o.writers[0].pkgs.map(p => [p.name, !!p.unknown]), [['a', true]]);
    }
    // and in another place than it was written for: not anchored
    assert.equal(readMeta(json, J(base, 'srv/elsewhere/bundle-lockfile'), [proj]).anchored, false);
    // a copy (SvelteKit's adapters' kind): anchored where it is, outside the project or in it
    const outside = JSON.parse(reanchor(json, dir, J(base, 'srv/copy/bundle-lockfile'), [proj]))['bundle-lockfile'];
    assert.equal(outside.context, undefined);
    assert.notEqual(outside.selfId, rec.selfId);
    assert.equal(readMeta(JSON.stringify({ ...JSON.parse(json), 'bundle-lockfile': outside }), J(base, 'srv/copy/bundle-lockfile'), [proj]).anchored, true);
    const back = JSON.parse(reanchor(json, dir, J(proj, 'build/bundle-lockfile'), [proj]))['bundle-lockfile'];
    assert.deepEqual([back.context, back.self, back.contextId], ['../..', 'build/bundle-lockfile', undefined]);
    // a process without that context cannot re-anchor it
    assert.equal(reanchor(json, dir, J(base, 'srv/copy2/bundle-lockfile'), [other]), null);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
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
  // a vendored copy (core/vendored.cjs): in the context's tree it keeps its location; above it, it has none
  const lockOf = (dir, ctx) => JSON.parse(toPackageLock([pkg('v', '1.0.0', J(path.sep, dir))], J(path.sep, ctx), { dir: J(path.sep, ctx, 'dist/bundle-lockfile'), writers: [{ id: 'w', files: [], paths: [J(path.sep, dir)] }] }))['bundle-lockfile'];
  assert.deepEqual(lockOf('p/vendor/v', 'p').locations, { 'node_modules/v': 'vendor/v' });
  assert.deepEqual(lockOf('p/vendor/v', 'p/app').outside, ['node_modules/v']);
  assert.deepEqual(lockOf('p/app', 'p/app/sub').outside, ['node_modules/v']); // the context inside it: ..
  assert.deepEqual(lockOf('p/node_modules/.cache/v', 'p').outside, ['node_modules/v']); // generated files in node_modules
});

test('toPackageLock: keys are relative to the real context when the project path goes through a symlink', () => {
  const real = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const link = `${real}-link`;
  fs.symlinkSync(real, link, 'dir');
  // with resolve.symlinks (the default) webpack reports real paths, while the context may be the symlinked one
  assert.deepEqual(entries(toPackageLock(packagesForFiles([J(real, 'node_modules/a/i.js')]), link)).map(([k]) => k), ['node_modules/a']);
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

test('nested: a bundled file another build produced brings its packages, also when it changed since (with a warning)', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('inner'), ...pj('outer') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    // the island: a Vite build into island/dist with main.js containing node_modules/inner
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'island/dist'), chunks: [{ fileName: 'main.js', code: 'island code', modules: [J(root, 'node_modules/inner/i.js')] }] });
    const idsOf = (files) => packages.packagesOfFiles(files).all.map(p => `${p.name}@${p.version}`).sort();
    // the island's packages, and its bundler (Vite, its Rollup), whose code is in it
    assert.deepEqual(idsOf([J(root, 'src/app.js'), J(root, 'island/dist/main.js'), J(root, 'node_modules/outer/i.js')]), ['inner@1.0.0', 'outer@1.0.0', `rollup@${UNIT}`, `vite@${UNIT}`]);
    // post-processed after its build: the record says by path that the island's build wrote it
    fs.appendFileSync(J(root, 'island/dist/main.js'), '/* changed */');
    let got;
    const warned = warnings(() => { got = idsOf([J(root, 'island/dist/main.js'), J(root, 'node_modules/outer/i.js')]); });
    assert.deepEqual(got, ['inner@1.0.0', 'outer@1.0.0', `rollup@${UNIT}`, `vite@${UNIT}`]);
    assert.deepEqual(warned, [`${J(root, 'island/dist/main.js')} changed after the build that wrote it into ${J(root, 'island/dist')}: listed with that build's packages`]);
    assert.deepEqual(warnings(() => idsOf([J(root, 'island/dist/main.js')])), []); // once per file
    // a file the record does not have: first-party
    fs.writeFileSync(J(root, 'island/dist/other.js'), 'x');
    assert.deepEqual(idsOf([J(root, 'island/dist/other.js')]), []);
  } finally { process.chdir(cwd); }
});

test('nested: a build into node_modules/.cache (nuxi build\'s .nuxt there) brings its packages to the build that bundles its output', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const copies = require('../../src/core/copies.cjs');
  copies.install();
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('inner'), ...pj('outer'), ...pj('copied') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const out = J(root, 'node_modules/.cache/nuxt/.nuxt/dist/server');
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: out, chunks: [{ fileName: 'server.mjs', code: 'server code', modules: [J(root, 'node_modules/inner/i.js')] }] });
    assert.ok(fs.existsSync(J(out, LOCK)));
    const idsOf = (files) => ids(packages.packagesOfFiles(files).all);
    assert.deepEqual(idsOf([J(out, 'server.mjs'), J(root, 'node_modules/outer/i.js')]), ['inner@1.0.0', 'outer@1.0.0']);
    // a file copied out of a package into node_modules/.cache is that package's
    fs.writeFileSync(J(root, 'node_modules/copied/c.js'), 'copied code');
    fs.mkdirSync(J(root, 'node_modules/.cache/gen'), { recursive: true });
    fs.copyFileSync(J(root, 'node_modules/copied/c.js'), J(root, 'node_modules/.cache/gen/c.js'));
    assert.equal(copies.sourceOf(J(root, 'node_modules/.cache/gen/c.js')), J(root, 'node_modules/copied/c.js'));
    assert.deepEqual(idsOf([J(root, 'node_modules/.cache/gen/c.js')]), ['copied@1.0.0']);
  } finally { process.chdir(cwd); }
});

test('nested: a JavaScript or CSS file a webpack build wrote (no hashes recorded) brings all its packages', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('inner'), ...pj('other'), 'lib/dist/widget.js': 'widget', 'lib/dist/widget.css': 'css', 'lib/dist/logo.svg': '<svg/>', 'lib/dist/stale.js': 'x' });
  const target = J(root, 'lib/dist', LOCK);
  const inner = packagesForFiles([J(root, 'node_modules/inner/i.js')]);
  outputs.record(target, 'webpack-lib', inner, root, ['widget.js', 'widget.css', 'logo.svg'].map(f => J(root, 'lib/dist', f)), { disk: true });
  await outputs.land(target, 'webpack-lib', 'test');
  const idsOf = (files) => ids(packages.packagesOfFiles(files).all);
  assert.deepEqual(idsOf([J(root, 'lib/dist/widget.js'), J(root, 'node_modules/other/i.js')]), ['inner@1.0.0', 'other@1.0.0']);
  assert.deepEqual(idsOf([J(root, 'lib/dist/widget.css')]), ['inner@1.0.0']);
  assert.deepEqual(idsOf([J(root, 'lib/dist/logo.svg')]), []);  // no JavaScript or CSS file
  assert.deepEqual(idsOf([J(root, 'lib/dist/stale.js')]), []);  // none of its files
});

test('nested: the inner build\'s record is found whether it ran with BUNDLE_LOCKFILE_TREE=only (record.json) or not', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('inner') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'island/dist'), chunks: [{ fileName: 'main.js', code: 'island code', modules: [J(root, 'node_modules/inner/i.js')] }] });
  } finally { process.chdir(cwd); }
  const dir = J(root, 'island/dist/bundle-lockfile');
  // the packages a process with the given BUNDLE_LOCKFILE_TREE finds in the island's main.js (and its problems)
  const outer = (tree) => {
    const env = { ...strictEnv(undefined) };
    if (tree) env.BUNDLE_LOCKFILE_TREE = tree; else delete env.BUNDLE_LOCKFILE_TREE;
    const r = spawnSync(process.execPath, ['-e', `const p = require(${JSON.stringify(J(SRC, 'core/packages.cjs'))}); const problems = require(${JSON.stringify(J(SRC, 'core/problems.cjs'))});
      const got = p.packagesOfFiles([${JSON.stringify(J(root, 'island/dist/main.js'))}]).all.map(x => x.name).sort(); console.log(JSON.stringify([got, problems.take()]));`], { cwd: root, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const want = [['inner', 'rollup', 'vite'], []];
  // the inner build wrote package-lock.json (BUNDLE_LOCKFILE_TREE off or on); the outer one runs with only
  assert.deepEqual(outer('only'), want);
  // the inner build ran with only: record.json; the outer one without
  fs.renameSync(J(dir, 'package-lock.json'), J(dir, 'record.json'));
  assert.deepEqual(outer(undefined), want);
  assert.deepEqual(outer('only'), want);
  // both, from a build that switched its setting: the newer one counts. The older one here records the same output
  // without its packages: read instead, main.js would bring none
  const stale = JSON.parse(fs.readFileSync(J(dir, 'record.json'), 'utf8'));
  for (const w of stale['bundle-lockfile'].writers) { w.packages = []; w.contents = {}; delete w.via; }
  fs.writeFileSync(J(dir, 'package-lock.json'), JSON.stringify(stale));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(J(dir, 'package-lock.json'), old, old);
  assert.deepEqual(outer(undefined), want);
  assert.deepEqual(outer('only'), want);
  fs.utimesSync(J(dir, 'record.json'), new Date(old - 60000), new Date(old - 60000)); // now record.json is the older one
  assert.deepEqual(outer(undefined), [[], []]);
});

test('nested: each JavaScript and CSS file another build produced brings the packages in it', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
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
    const idsOf = (f) => packages.packagesOfFiles([J(dir, f)]).all.map(p => `${p.name}@${p.version}`).sort();
    // the bundler's code is in each chunk (and in the worker, a generate-only Vite build's chunk), not in the style sheet
    assert.deepEqual(idsOf('main.js'), ['inline@1.0.0', 'js@1.0.0', `rollup@${UNIT}`, `vite@${UNIT}`]);
    assert.deepEqual(idsOf('lazy.js'), ['lazy@1.0.0', `rollup@${UNIT}`, `vite@${UNIT}`]);
    assert.deepEqual(idsOf('style.css'), ['imported@1.0.0', 'sheet@1.0.0']);
    assert.deepEqual(idsOf('w.js'), [`rollup@${UNIT}`, `vite@${UNIT}`, 'worker@1.0.0']);
    assert.deepEqual(idsOf('l.svg'), []); // no JavaScript or CSS: its package is the file's own if bundled from there
    // recorded by a version that did not record the packages of each file: all of the island's
    const lock = J(dir, LOCK), json = JSON.parse(fs.readFileSync(lock, 'utf8'));
    assert.deepEqual(Object.keys(json['bundle-lockfile'].writers[0].contents).sort(), ['../l.svg', '../lazy.js', '../main.js', '../style.css', '../w.js'].filter(f => f !== '../l.svg'));
    delete json['bundle-lockfile'].writers[0].contents;
    fs.writeFileSync(lock, JSON.stringify(json));
    assert.deepEqual(idsOf('lazy.js'), ['imported@1.0.0', 'inline@1.0.0', 'js@1.0.0', 'lazy@1.0.0', 'logo@1.0.0', `rollup@${UNIT}`, 'sheet@1.0.0', `vite@${UNIT}`, 'worker@1.0.0']);
  } finally { process.chdir(cwd); }
});

test('nested: a CSS file has the style sheets of a chunk of style only that Vite removed, and the style blocks of single-file components', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('js'), ...pj('bootstrap'), ...pj('ui') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const dir = J(root, 'island/dist'), m = (name, f = 'i.js') => J(root, 'node_modules', name, f);
    // manualChunks: { 'vendor-styles': ['bootstrap/dist/css/bootstrap.css'] } - Vite removes that chunk in its
    // generateBundle and gives its CSS file to main.js, not its modules; a component library's .vue style block
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: dir,
      chunks: [{ fileName: 'main.js', code: 'main code', modules: [J(root, 'island/src/main.js'), m('js'), `${m('ui', 'Button.vue')}?vue&type=style&index=0&lang.css`], css: ['main.css', 'vendor-styles.css'] },
        { fileName: 'vendor-styles.js', code: '', modules: [m('bootstrap', 'dist/css/bootstrap.css')], removed: true }],
      assets: [{ fileName: 'main.css', source: 'main css' }, { fileName: 'vendor-styles.css', source: 'bootstrap css' }] });
    const idsOf = (f) => ids(packages.packagesOfFiles([J(dir, f)]).all);
    assert.ok(idsOf('vendor-styles.css').includes('bootstrap@1.0.0'), idsOf('vendor-styles.css').join(' '));
    assert.ok(idsOf('main.css').includes('ui@1.0.0'), idsOf('main.css').join(' '));
    assert.deepEqual(idsOf('main.js'), ['js@1.0.0']); // (the style block went into the CSS file)
  } finally { process.chdir(cwd); }
});

test('nested: a workspace package another build produced brings its packages, also through its node_modules link', async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('inner'), 'packages/island/package.json': { name: '@acme/island', version: '1.0.0' } });
  fs.mkdirSync(J(root, 'node_modules/@acme'));
  fs.symlinkSync('../../packages/island', J(root, 'node_modules/@acme/island'));
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'packages/island/dist'), chunks: [{ fileName: 'main.js', code: 'island code', modules: [J(root, 'node_modules/inner/i.js')] }] });
    const idsOf = (files) => packages.packagesOfFiles(files).all.map(p => `${p.name}@${p.version}`).sort();
    const island = ['inner@1.0.0', `rollup@${UNIT}`, `vite@${UNIT}`]; // with the island's bundler
    assert.deepEqual(idsOf([J(root, 'packages/island/dist/main.js')]), island);          // its real path (resolve.symlinks)
    assert.deepEqual(idsOf([J(root, 'node_modules/@acme/island/dist/main.js')]), island); // the link (resolve.symlinks: false)
    // a package's own files are no other build's output, even with the same bytes
    fs.mkdirSync(J(root, 'node_modules/copy/dist'), { recursive: true });
    fs.writeFileSync(J(root, 'node_modules/copy/package.json'), JSON.stringify({ name: 'copy', version: '1.0.0' }));
    fs.copyFileSync(J(root, 'packages/island/dist/main.js'), J(root, 'node_modules/copy/dist/main.js'));
    assert.deepEqual(idsOf([J(root, 'node_modules/copy/dist/main.js')]), ['copy@1.0.0']);
  } finally { process.chdir(cwd); }
});

test('lockfile: a context reached through a symlink is recorded as given, and read back as the real one', { skip: process.platform === 'win32' }, () => {
  const { readMeta } = require('../../src/core/lockfile.cjs');
  const root = fs.realpathSync(project({ 'real/proj/node_modules/a/package.json': { name: 'a', version: '1.0.0' } }));
  fs.symlinkSync(J(root, 'real/proj'), J(root, 'link'));
  const ctx = J(root, 'link'), dir = J(ctx, 'dist/bundle-lockfile'); // webpack's context and output.path as configured
  const pkgA = { name: 'a', version: '1.0.0', path: J(root, 'real/proj/node_modules/a') }; // package paths are real
  const json = toPackageLock([pkgA], ctx, { dir, writers: [{ id: 'w', files: [J(ctx, 'dist/main.js')], paths: [pkgA.path] }] });
  const doc = JSON.parse(json);
  assert.equal(doc['bundle-lockfile'].context, '../..'); // not ../../../real/proj: no path of this machine
  assert.deepEqual(Object.keys(doc.packages), ['', 'node_modules/a']);
  const meta = readMeta(json, dir);
  assert.equal(meta.context, J(root, 'real/proj'));
  assert.equal(meta.writers[0].pkgs[0].path, pkgA.path);
  // a record with the real context (written by v0.0.3, without "self") reads the same
  const old = JSON.stringify({ ...doc, 'bundle-lockfile': { ...doc['bundle-lockfile'], context: path.relative(dir, J(root, 'real/proj')), self: undefined } });
  assert.equal(readMeta(old, dir).writers[0].pkgs[0].path, pkgA.path);
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
  const { readMeta } = require('../../src/core/lockfile.cjs');
  const listed = readMeta(first, path.dirname(target)).writers[0].pkgs;
  assert.deepEqual(listed.map(p => p.outside || p.path).sort(), [J(proj, 'node_modules/foo'), 'node_modules/foo@1.0.0', 'node_modules/foo@1.0.0-2'].sort());
  assert.equal(listed.find(p => !p.outside).license, 'MIT');
  // this process has one of the two copies: still two keys, not three; the package in the project stays as it is
  const writeFile = (json) => { fs.writeFileSync(target, json); };
  outputs.record(target, 'mine', [outsideOne], proj, [J(proj, 'dist/mine.js')], { disk: true });
  fs.writeFileSync(J(proj, 'dist/mine.js'), '');
  outputs.emitted(target, 'mine');
  await outputs.rewrite(target, writeFile);
  const keys = (json) => entries(json).map(([k, p]) => `${k} = ${p.name}@${p.version}`);
  const want = ['node_modules/foo@1.0.0 = foo@1.0.0', 'node_modules/foo@1.0.0-2 = foo@1.0.0', 'node_modules/foo = foo@2.0.0']; // name, version order
  assert.deepEqual(keys(fs.readFileSync(target, 'utf8')), want);
  // written again and again (watch mode, more processes): the same bytes
  const again = fs.readFileSync(target, 'utf8');
  await outputs.rewrite(target, writeFile);
  assert.equal(fs.readFileSync(target, 'utf8'), again);
  // one copy outside, listed by the other process, and the same copy here: one entry
  const single = toPackageLock([outsideOne, { ...outsideOne, path: '\0outside:node_modules/foo', outside: 'node_modules/foo' }], proj, meta([]));
  assert.deepEqual(keys(single), ['node_modules/foo = foo@1.0.0']);
});

test('lockfile: a lockfile of another shape is no record, and never stops the lockfile from being written', async () => {
  const { readMeta } = require('../../src/core/lockfile.cjs');
  const NONE = Symbol('no packages');
  const field = (m, pkgs = {}) => JSON.stringify({ lockfileVersion: 3, ...(pkgs === NONE ? {} : { packages: pkgs }), 'bundle-lockfile': m });
  for (const json of [
    field({ v: 2, context: '.', writers: [{ id: 'x', packages: ['node_modules/a'] }] }, NONE), // no packages
    field({ v: 2, context: '.', writers: [] }, ['node_modules/a']),                                  // packages as an array
    field({ v: 2, context: '.', writers: {} }), field({ v: 2, context: 1, writers: [] }),
    // a record of another version (an older bundle-lockfile's, a newer one's)
    field({ v: 1, context: '.', writers: [{ id: 'x', packages: ['node_modules/a'] }] }, { 'node_modules/a': { name: 'a', version: '1.0.0' } }),
    field({ v: 3, context: '.', writers: [] }),
    field(null), field([]), 'null', '[]', '"x"', '{not json',
  ]) assert.equal(readMeta(json, '/d'), null, json);
  // malformed parts of a writer are left out, the rest is read
  const meta = readMeta(field({ v: 2, context: '.', outside: 'node_modules/b', writers: [
    null, 'x', { id: 1 }, { id: 'w', files: 'dist/a.js', count: '3', outputs: ['x'], packages: [1, 'node_modules/a', 'node_modules/none', 'toString', 'node_modules/noversion'],
      contents: { 'dist/a.js': [0, 1, 3, 9, -1, 0.5, 'node_modules/a'], 'dist/b.js': 'x' }, // indices into the strings of packages
      bundler: { name: 'webpack', version: 5 }, via: { chunk: [0, 1, 9, 'x'], unknown: [0], style: 'x' } },
  ] }, { 'node_modules/a': { name: 'a', version: '1.0.0' }, 'node_modules/noversion': { name: 'n' } }), '/d');
  const pa = { name: 'a', version: '1.0.0', path: J('/d/node_modules/a') };
  assert.deepEqual(meta.writers, [{ id: 'w', bundler: { name: 'webpack' }, via: new Map([[pa.path, new Set(['chunk'])]]), files: [], count: undefined, outputs: {},
    outputCount: undefined, contents: { [J('/d/dist/a.js')]: [pa.path] }, pkgs: [pa] }]); // (contents: package paths, as every writer record has them)
  // such a file on disk: replaced by a lockfile of this build
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const target = J(root, 'dist', LOCK);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, field({ v: 2, context: '.', writers: [{ id: 'x', packages: ['node_modules/a'] }] }, NONE));
  const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]);
  assert.deepEqual(lockedNames(outputs.record(target, 'w', [a], root, [], { disk: true })), ['a']);
  outputs.emitted(target, 'w');
  await outputs.rewrite(target, outputs.writeDisk(target)).then((err) => { if (err) throw err; });
  assert.deepEqual(lockedNames(fs.readFileSync(target, 'utf8')), ['a']);
  // a lockfile an older bundle-lockfile wrote there (a record of version 1): replaced too, without its writers
  fs.writeFileSync(target, field({ v: 1, context: '.', writers: [{ id: 'x', files: ['../main.js'], packages: ['node_modules/b'] }] },
    { 'node_modules/b': { name: 'b', version: '1.0.0' } }));
  fs.writeFileSync(J(root, 'dist/main.js'), '');
  await outputs.rewrite(target, outputs.writeDisk(target)).then((err) => { if (err) throw err; });
  const now = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.deepEqual(lockedNames(JSON.stringify(now)), ['a']);
  assert.equal(now['bundle-lockfile'].v, 2);
});

test('lockfile: a writer\'s record has at most 20 of its files and 500 output hashes (and their counts)', () => {
  const { readMeta } = require('../../src/core/lockfile.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const dir = J(root, 'dist/bundle-lockfile');
  const files = Array.from({ length: 25 }, (_, i) => J(root, `dist/f${String(i).padStart(2, '0')}.js`));
  const hashes = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [J(root, `dist/o${String(i).padStart(3, '0')}.js`), `sha256-${i}`]));
  const pkgA = packagesForFiles([J(root, 'node_modules/a/i.js')])[0];
  const json = toPackageLock([pkgA], root, { dir, writers: [{ id: 'w', files, paths: [pkgA.path], outputs: hashes }] });
  const w = JSON.parse(json)['bundle-lockfile'].writers[0];
  assert.equal(w.count, 25);
  assert.deepEqual(w.files, files.slice(0, 20).map(f => `../${path.basename(f)}`)); // the first 20 by path
  assert.equal(Object.keys(w.outputs).length, 500);
  assert.equal(Object.keys(w.outputs)[499], '../o499.js');
  assert.equal(w.outputCount, 600); // only some of them: their number
  const read = readMeta(json, dir).writers[0];
  assert.equal(read.count, 25);
  assert.equal(read.files.length, 20);
  assert.equal(read.outputCount, 600);
  // another build bundling one of the outputs the record does not have gets all of the writer's packages, not none
  // (a JavaScript or CSS file: no other one); one the record has, with other bytes (changed after its build), still
  // brings the writer's packages, with a warning (see nested.cjs)
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(J(dir, 'package-lock.json'), json);
  for (const f of ['o550.js', 'o100.js', 'o560.txt']) fs.writeFileSync(J(root, 'dist', f), 'x');
  const elsewhere = { context: os.tmpdir() };
  assert.deepEqual(ids(packages.packagesOfFiles([J(root, 'dist/o550.js')], elsewhere).all), ['a@1.0.0']);
  let changed;
  assert.equal(warnings(() => { changed = packages.packagesOfFiles([J(root, 'dist/o100.js')], elsewhere).all; }).length, 1);
  assert.deepEqual(ids(changed), ['a@1.0.0']);
  assert.deepEqual(ids(packages.packagesOfFiles([J(root, 'dist/o560.txt')], elsewhere).all), []);
  // a record with all of them has no count
  const few = JSON.parse(toPackageLock([pkgA], root, { dir, writers: [{ id: 'w', files, paths: [pkgA.path], outputs: { [J(root, 'dist/o.js')]: 'sha256-0' } }] }));
  assert.equal(few['bundle-lockfile'].writers[0].outputCount, undefined);
});

test('lockfile: the same build in another directory writes the same bytes (webpack and Rollup)', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0', license: 'MIT' } });
  const tree = { ...pj('a'), ...pj('b'), 'node_modules/b/node_modules/a/package.json': { name: 'a', version: '0.9.0' }, 'src/app.js': '' };
  // webpack, with entry: path.resolve(__dirname, ...), as configs often have it
  const webpackLock = (root) => {
    const c = compilation({ context: root, outputPath: J(root, 'dist'), chunks: [{ files: ['main.js'], modules: [
      { resource: J(root, 'src/app.js') }, { resource: J(root, 'node_modules/a/i.js') }, { resource: J(root, 'node_modules/b/node_modules/a/i.js') }] }],
    assets: { 'main.js': {} } });
    c.compiler.options = { entry: { main: { import: [J(root, 'src/app.js')] } }, output: { filename: '[name].js' } };
    return plugin().lockfile(c);
  };
  const [w1, w2] = [project(tree), project(tree)].map(webpackLock);
  assert.equal(w1, w2);
  // Rollup, in the project as the working directory
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const cwd = process.cwd();
  const rollupLock = async (root) => {
    process.chdir(root);
    try {
      await rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: J(root, 'dist'), input: [J(root, 'src/app.js')],
        chunks: [{ fileName: 'app.js', code: 'same bytes, another directory', modules: [J(root, 'src/app.js'), J(root, 'node_modules/a/i.js'), J(root, 'node_modules/b/i.js')] }] });
      return fs.readFileSync(J(root, 'dist', LOCK), 'utf8');
    } finally { process.chdir(cwd); }
  };
  const r1 = await rollupLock(project(tree)), r2 = await rollupLock(project(tree));
  assert.equal(r1, r2);
  assert.deepEqual(lockedNames(r1), ['a', 'b']);
});
