'use strict';
// Unit tests for the bundler-agnostic core and the adapter's detection logic. No network, no fixtures:
//   node --test test/unit.cjs
// Most tests check what is collected and written, with BUNDLE_LOCKFILE_STRICT=0 (problems are warnings, as they were
// before strict mode): set here, before config.cjs is loaded, and inherited by the child processes they start. The
// tests of strict mode (the default) set it themselves; see "strict:" below.
process.env.BUNDLE_LOCKFILE_STRICT = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const packages = require('../src/core/packages.cjs');
const { packagesForFiles } = packages;
const { packageRoot, unvirtual, exportPath } = require('../src/core/paths.cjs');
const { toPackageLock } = require('../src/core/lockfile.cjs');
const crypto = require('crypto');
const outputs = require('../src/core/outputs.cjs');
const config = require('../src/core/config.cjs');
const webpackAdapter = require('../src/adapters/webpack.cjs');
const problems = require('../src/core/problems.cjs');
// the environment of a child process with BUNDLE_LOCKFILE_STRICT unset (undefined) or set to v; a node run with it
const strictEnv = (v) => { const env = { ...process.env }; if (v === undefined) delete env.BUNDLE_LOCKFILE_STRICT; else env.BUNDLE_LOCKFILE_STRICT = v; return env; };
const nodeWith = (env, args) => spawnSync(process.execPath, args, { encoding: 'utf8', env });

const SRC = path.join(__dirname, '../src');
const PATCHED = Symbol.for('bundle-lockfile.webpack.patched');
const J = (...p) => path.join(...p);
const pathToFileURLHref = (p) => require('url').pathToFileURL(p).href;

// a temporary project: { 'node_modules/a/package.json': {...} | 'text', ... }; returns its real path
function project(files) {
  const root = fs.realpathSync(fs.mkdtempSync(J(os.tmpdir(), 'blr-unit-')));
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(J(root, f)), { recursive: true });
    fs.writeFileSync(J(root, f), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}
// The bundlers of the tests' compilers and builds, in a project of their own: every output with JavaScript lists the
// bundler (core/bundler.cjs; tests of that below), at version 0.0.0-unit - which the helpers that compare package lists
// leave out (ids, entries, lockedNames). The fake webpack compilers are patched ones (BUNDLER_FILE: their webpack's
// lib/Compiler.js); the Rollup plugin's hooks run from a file of rollup's or rolldown's (rollupBuild), as in a build of
// a plugin from the config, and Vite's config hook from one of vite's.
const UNIT = '0.0.0-unit';
const BUNDLER_FILE = Symbol.for('bundle-lockfile.webpack.bundler-file');
const BUNDLERS = (() => {
  const files = {};
  const CALL = 'module.exports = (fn, self, args) => fn.apply(self, args);\n';
  for (const [name, call] of [['webpack', 'lib/Compiler.js'], ['@rspack/core', 'dist/index.js'], ['rollup', 'dist/shared/rollup.js'], ['rolldown', 'dist/shared/call.js'], ['vite', 'dist/node/chunks/call.js']]) {
    files[`node_modules/${name}/package.json`] = { name, version: UNIT, license: 'MIT' };
    files[`node_modules/${name}/${call}`] = CALL;
  }
  const root = fs.realpathSync(fs.mkdtempSync(J(os.tmpdir(), 'blr-bundlers-')));
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(J(root, f)), { recursive: true });
    fs.writeFileSync(J(root, f), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return {
    root, webpack: J(root, 'node_modules/webpack/lib/Compiler.js'), rspack: J(root, 'node_modules/@rspack/core/dist/index.js'),
    rollup: require(J(root, 'node_modules/rollup/dist/shared/rollup.js')), rolldown: require(J(root, 'node_modules/rolldown/dist/shared/call.js')),
    vite: require(J(root, 'node_modules/vite/dist/node/chunks/call.js')),
  };
})();
const notUnit = (p) => p.version !== UNIT;
const ids = (pkgs) => pkgs.filter(notUnit).map(p => `${p.name}@${p.version}`).sort();
const pkg = (name, version, dir) => ({ name, version, path: dir });
// runs fn with config.warn recorded; returns the messages
function warnings(fn) {
  const orig = config.warn, seen = [];
  config.warn = (...a) => seen.push(a.join(' '));
  try { fn(); } finally { config.warn = orig; }
  return seen;
}
async function warningsOf(fn) {
  const orig = config.warn, seen = [];
  config.warn = (...a) => seen.push(a.join(' '));
  try { await fn(); } finally { config.warn = orig; }
  return seen;
}
const entries = (json) => Object.entries(JSON.parse(json).packages).filter(([k, p]) => k && notUnit(p));
const allEntries = (json) => Object.entries(JSON.parse(json).packages).filter(([k]) => k); // with the bundler

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
  const { readMeta } = require('../src/core/lockfile.cjs');
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
  const { readMeta } = require('../src/core/lockfile.cjs');
  const ctx = J(path.sep, 'p'), dir = J(ctx, 'dist/bundle-lockfile');
  const a = pkg('a', '1.0.0', J(ctx, 'node_modules/a'));
  const doc = JSON.parse(toPackageLock([a], ctx, { dir, writers: [{ id: 'w', files: [], paths: [a.path] }] }));
  Object.assign(doc.packages['node_modules/a'], { unknown: true, outside: 'node_modules/x', dev: true, license: { type: 'MIT' } });
  const [read] = readMeta(JSON.stringify(doc), dir).writers[0].pkgs;
  assert.deepEqual(read, { name: 'a', version: '1.0.0', path: a.path });
});

test('toPackageLock: a writer\'s bundler and how it found its packages (via), read back by another process', () => {
  const { readMeta } = require('../src/core/lockfile.cjs');
  const via = require('../src/core/via.cjs');
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

test('packagesOfFiles: how each file\'s packages were found - modules by the class the adapter gives, copies made with fs, vendored copies', () => {
  const via = require('../src/core/via.cjs');
  const copies = require('../src/core/copies.cjs');
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

test('toPackageLock: a lockfile outside the project has a record without its paths, which only the same context anchors', () => {
  const { readMeta, reanchor } = require('../src/core/lockfile.cjs');
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

// a class that looks like webpack's Compiler
const fakeCompiler = () => class Compiler { compile() {} run() {} watch() {} newCompilation() {} isChild() { return false; } };

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

// minimal webpack 5 compilation: chunks of modules (entry: the chunk's entry modules), child compilations,
// assets with info
let outputDirs = 0;
function compilation({ context, outputPath = J(context, `dist-${++outputDirs}`), chunks, children = [], assets = {}, clean }) {
  return {
    compiler: { context, outputPath, [BUNDLER_FILE]: BUNDLERS.webpack },
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
    compiler: { context, outputPath: J(context, `dist-${++outputDirs}`), [BUNDLER_FILE]: BUNDLERS.webpack },
    outputOptions: {},
    chunks: chunks.map(c => ({ files: c.files || [], modulesIterable: new Set(c.modules), entryModule: (c.entry || [])[0] })),
    children: children.map(c => compilation4({ context, ...c })),
    assets: Object.fromEntries(Object.keys(assets).map(n => [n, {}])),
  };
}
const LOCK = 'bundle-lockfile/package-lock.json';
const WRITER = Symbol.for('bundle-lockfile.webpack.writer');
const plugin = () => new webpackAdapter.BundleLockfilePlugin(LOCK);
const lockedNames = (json) => entries(json).map(([k]) => k.replace(/^node_modules\//, '')).sort();

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
      compiler: { context: root, outputPath: J(root, `dist-${++outputDirs}`) },
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
  const compiler = { context: root, outputPath: J(root, `dist-${++outputDirs}`), [BUNDLER_FILE]: BUNDLERS.webpack };
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

test('webpack adapter: webpack 5 minimizes unnamed copies; they are matched before the optimize stages', () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/file/package.json': { name: 'file', version: '1.0.0' },
    'node_modules/file/f.css': 'body {  margin: 0  }' });
  const { compiler, taps } = fakeCompiler5({ outputPath: J(root, 'dist') });
  compiler.webpack.Compilation = { PROCESS_ASSETS_STAGE_OPTIMIZE: 100 };
  const p = new webpackAdapter.BundleLockfilePlugin(LOCK);
  p.apply(compiler);
  const build = (beforeOptimize) => {
    const src = (content) => ({ size: () => Buffer.byteLength(content), source: () => content });
    const assets = new Map([['main.js', { name: 'main.js', source: src('main'), info: {} }],
      ['css/f.css', { name: 'css/f.css', source: src('body {  margin: 0  }'), info: { copied: true } }]]);
    let stage, optimize;
    const comp = {
      compiler, chunks: [{ files: new Set(['main.js']), modulesIterable: [{ resource: J(root, 'node_modules/a/i.js') }] }], children: [],
      fileDependencies: new Set([J(root, 'node_modules/a/i.js'), J(root, 'node_modules/file/f.css')]),
      getAsset: (n) => assets.get(n), getAssets: () => [...assets.values()], emitAsset: () => {},
      hooks: { processAssets: { tap: (o, fn) => { assert.equal(o.stage, 99); optimize = fn; } }, afterProcessAssets: { tap: (o, fn) => (stage = fn) } },
    };
    taps.thisCompilation(comp);
    if (beforeOptimize) optimize();
    assets.get('css/f.css').source = src('body{margin:0}'); // a minimizer at the optimize stages
    stage();
    return lockedNames(p.lockfile(comp));
  };
  assert.deepEqual(build(true), ['a', 'file']);
  assert.deepEqual(build(false), ['a']); // after minimizing, the bytes are no package file's
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

test('packages: inlinedFile - files a loader or plugin inlines, not code, build tools\' settings or directories', () => {
  const { inlinedFile } = require('../src/core/packages.cjs');
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

test('outputs: prune drops other writers whose files are all gone, once their build has landed', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c'), ...pj('d'), ...pj('e'), 'dist/b.js': '', 'dist/c2.js': '' });
  const target = J(root, 'dist/bundle-lockfile/package-lock.json');
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const exists = (f) => new Promise(resolve => setImmediate(resolve, fs.existsSync(f)));
  const prune = (writer) => outputs.prune(target, writer, exists);
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
  // nothing to check: no file is looked at
  let looked = false;
  await outputs.prune(J(root, 'other/package-lock.json'), 'a', (f) => { looked = true; return exists(f); });
  assert.equal(looked, false);
});

test('outputs: a build that is never written (it failed) does not replace the packages of the output in the directory', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c') });
  const target = J(root, 'dist/bundle-lockfile/package-lock.json');
  const [a, b, c] = ['a', 'b', 'c'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const rewrite = () => new Promise(resolve => outputs.rewrite(target, (json) => { resolve(lockedNames(json)); }));
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
  assert.equal(exportPath('/srv/app/dist/bundle-lockfile/package-lock.json'), '/x/export/srv/app/dist/bundle-lockfile/package-lock.json');
  assert.equal(exportPath('/srv/app/../app/dist/l/package-lock.json'), '/x/export/srv/app/dist/l/package-lock.json');
  config.exportBase = '/srv/app';
  assert.equal(exportPath('/srv/app/dist/bundle-lockfile/package-lock.json'), '/x/export/dist/bundle-lockfile/package-lock.json');
  // not below the base: its absolute path, below _outside_base/ - never where one below the base goes (/srv/app/srv/other/...)
  assert.equal(exportPath('/srv/other/dist/bundle-lockfile/package-lock.json'), '/x/export/_outside_base/srv/other/dist/bundle-lockfile/package-lock.json');
  assert.notEqual(exportPath('/srv/app/srv/other/dist/bundle-lockfile/package-lock.json'), exportPath('/srv/other/dist/bundle-lockfile/package-lock.json'));
  assert.equal(exportPath('/srv/app/..cache/dist/l/package-lock.json'), '/x/export/..cache/dist/l/package-lock.json'); // below it, a name starting with ..
  assert.equal(exportPath('/srv/application/dist/l/package-lock.json'), '/x/export/_outside_base/srv/application/dist/l/package-lock.json');
  config.exportDir = null;
  assert.equal(exportPath('/srv/app/dist/bundle-lockfile/package-lock.json'), null);
}));

test('outputs: an export base reached through a symbolic link is the base of the real paths below it (macOS /tmp, $TMPDIR)', { skip: process.platform === 'win32' }, () => {
  const root = project({ 'real/app/dist/x.js': '' });
  fs.symlinkSync(J(root, 'real'), J(root, 'link'));
  return withConfig({ exportDir: J(root, 'export'), exportBase: J(root, 'link/app') }, () => {
    // Rollup and Vite record real paths (their working directory's), the base is the logical $PWD
    assert.equal(exportPath(J(root, 'real/app/dist/bundle-lockfile/package-lock.json')), J(root, 'export/dist/bundle-lockfile/package-lock.json'));
    assert.equal(exportPath(J(root, 'link/app/dist/bundle-lockfile/package-lock.json')), J(root, 'export/dist/bundle-lockfile/package-lock.json'));
    // also a lockfile whose directory is not there yet
    assert.equal(exportPath(J(root, 'real/app/new/bundle-lockfile/package-lock.json')), J(root, 'export/new/bundle-lockfile/package-lock.json'));
  });
});

test('outputs: two lockfiles of a process at one export path are an error; the second does not replace the first\'s copy', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b') });
  const [a, b] = ['a', 'b'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  // a directory below the base named like the prefix of those outside it: the one way two lockfiles meet there
  const inside = J(root, `w/${require('../src/core/paths.cjs').OUTSIDE_BASE}`, root.slice(1), 'dist', LOCK), outside = J(root, 'dist', LOCK);
  await withConfig({ exportDir: J(root, 'export'), exportBase: J(root, 'w') }, async () => {
    assert.equal(exportPath(inside), exportPath(outside));
    const write = (target, p) => new Promise((resolve) => {
      outputs.record(target, 'w', [p], root, [], { disk: true }); outputs.emitted(target, 'w');
      outputs.rewrite(target, outputs.writeDisk(target)).then(resolve);
    });
    assert.equal(await write(outside, a), undefined);
    const err = await write(inside, b);
    assert.match(err && err.message, /its export copy .*package-lock\.json is also the export copy of .*dist.bundle-lockfile.package-lock\.json/);
    assert.deepEqual(lockedNames(fs.readFileSync(exportPath(outside), 'utf8')), ['a']);
  });
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

test('outputs: a lockfile on disk keeps the packages other processes put there, while their files are there', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c'), 'dist/b.js': 'b' });
  const target = J(root, 'dist', LOCK);
  const [a, b, c] = ['a', 'b', 'c'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const writeFile = (json) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, json); };
  const rewrite = () => outputs.rewrite(target, writeFile).then(() => fs.readFileSync(target, 'utf8'));
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

test('strict: a lockfile on disk whose record this bundle-lockfile cannot read (another version, another shape) fails the build that would replace it', () => withConfig({ strict: true }, async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), 'dist/other.js': 'x' });
  const target = J(root, 'dist', LOCK);
  const a = packagesForFiles([J(root, 'node_modules/a/i.js')])[0];
  for (const [record, why] of [
    [{ v: 1, writers: [{ id: 'w', files: ['../other.js'], packages: [1] }] }, /has a record of version 1, which this bundle-lockfile does not read/],
    [{ v: 2, writers: 'x' }, /has a bundle-lockfile record of a shape it does not read/],
  ]) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ lockfileVersion: 3, requires: true, packages: { '': {}, 'node_modules/left-pad': { name: 'left-pad', version: '1.3.0' } }, 'bundle-lockfile': record }));
    const writer = `unreadable-${JSON.stringify(record)}`;
    outputs.record(target, writer, [a], root, [J(root, 'dist/main.js')], { disk: true });
    await outputs.land(target, writer, 'test');
    const taken = problems.take();
    assert.ok(taken.some(t => why.test(t) && t.includes(target) && /the packages of the other builds it lists would be missing/.test(t)), taken.join('\n'));
  }
  // npm's own lockfile (no record): not replaced, which is a problem of its own (see ours)
}));

test('outputs: another process\'s file that is a symbolic link to nothing is there, as for this process\'s writers', { skip: process.platform === 'win32' }, async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b') });
  const target = J(root, 'dist', LOCK);
  const [a, b] = ['a', 'b'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const writeFile = (json) => { fs.writeFileSync(target, json); };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(J(root, 'nowhere'), J(root, 'dist/b-link')); // a symbolic link asset (webpack >= 5.111)
  fs.writeFileSync(target, toPackageLock([b], root, { dir: path.dirname(target), writers: [{ id: 'other', files: [J(root, 'dist/b-link')], paths: [b.path] }] }));
  outputs.record(target, 'w-link', [a], root, [J(root, 'dist/a.js')], { disk: true });
  outputs.emitted(target, 'w-link');
  await outputs.rewrite(target, writeFile);
  assert.deepEqual(lockedNames(fs.readFileSync(target, 'utf8')), ['a', 'b']);
});

test('outputs: nothing recorded for a lockfile: nothing written, no error (one that failed before is not hidden)', async () => {
  const root = project({ 'dist/bundle-lockfile/package-lock.json': 'left alone' });
  const target = J(root, 'dist', LOCK);
  let written = false;
  const err = await outputs.rewrite(target, () => { written = true; });
  assert.equal(err, undefined);
  assert.equal(written, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'left alone');
});

test('outputs: a lockfile its own output.clean deleted keeps the other processes\' packages whose files it kept', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c'), 'dist/b.js': 'b', 'dist/c.js': 'c' });
  const target = J(root, 'dist', LOCK);
  const [a, b, c] = ['a', 'b', 'c'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const writeFile = (json) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, json); };
  // other processes wrote b (dist/b.js) and c (dist/c.js)
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, toPackageLock([b, c], root, { dir: path.dirname(target), writers: [
    { id: 'other-b', files: [J(root, 'dist/b.js')], paths: [b.path] }, { id: 'other-c', files: [J(root, 'dist/c.js')], paths: [c.path] }] }));
  outputs.record(target, 'w-clean', [a], root, [J(root, 'dist/a.js')], { disk: true }); // renders with the lockfile on disk
  // this build's output.clean (clean.keep: b.js) deletes c.js and the lockfile before the output is written
  fs.rmSync(J(root, 'dist/c.js'));
  fs.rmSync(target);
  outputs.emitted(target, 'w-clean');
  await outputs.rewrite(target, writeFile);
  assert.deepEqual(lockedNames(fs.readFileSync(target, 'utf8')), ['a', 'b']);
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
      outputs.rewrite(target, process.env.BUNDLE_LOCKFILE_INLINE === '0' ? null : outputs.writeDisk(target)).then((err) => { if (err) throw err; }); },
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
  const slow = (json) => new Promise((resolve, reject) => setTimeout(() => { written.push(json); reject(new Error('disk full')); }, 20));
  const fast = (json) => { written.push(json); };
  const errors = await Promise.all([
    outputs.rewrite(target, slow),
    (() => { outputs.record(target, 'w2', [a, b], J(root, 'sub')); outputs.emitted(target, 'w2'); return outputs.rewrite(target, fast); })(),
    outputs.rewrite(target, () => { throw new Error('sync'); }),
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
    context: path.dirname(outputPath), outputPath, name: 'fake', [BUNDLER_FILE]: BUNDLERS.webpack,
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
  new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
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
  for (const shape of ['webpack 4', 'webpack 5']) {
    const outputPath = J(root, shape === 'webpack 4' ? 'dist4' : 'dist5');
    const { compiler, taps } = fakeCompiler5({ outputPath, withWebpack: shape === 'webpack 5' });
    compiler.outputFileSystem.readFile = fs.readFile;
    new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
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

test('register: BUNDLE_LOCKFILE_DISABLE=all installs no hooks', () => {
  const script = `const M = require('module'); const before = M._extensions['.js']; require(${JSON.stringify(J(SRC, 'register.cjs'))}); console.log(M._extensions['.js'] === before);`;
  // the rollup, rspack, esbuild, parcel, angular and next adapters hook CommonJS modules too (Rollup's CommonJS build,
  // rspack, esbuild, @parcel/core, Angular's builder, next build): only off with all names
  for (const [disable, untouched] of [['all', 'true'], ['webpack,rollup,rolldown,vite,rspack,esbuild,parcel,angular,next', 'true'], ['ALL', 'true'], [' Webpack ,ROLLUP,rolldown, vite,RSPACK,ESBuild,Parcel,Angular,Next', 'true'],
    ['webpack,rollup,rolldown,vite,rspack,esbuild,parcel,angular', 'false'], ['next', 'false'],
    ['webpack,rollup,rolldown,vite,rspack,esbuild,parcel', 'false'], ['webpack,rollup,rolldown,vite,rspack,esbuild', 'false'], ['webpack,rollup,rolldown,vite,rspack', 'false'], ['webpack,rollup,rolldown,vite', 'false'], ['webpack', 'false'], ['webpack,vite', 'false'], ['', 'false'], ['rspack', 'false'], ['esbuild', 'false']]) {
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
  // quoted, with a space, through a symlinked directory: the same register.cjs, not added again
  fs.symlinkSync(path.dirname(REGISTER), J(root, 'a b'));
  for (const form of [`--require "${J(root, 'a b/register.cjs')}"`, `--require="${J(root, 'a b/register.cjs')}"`]) {
    assert.equal(run('probe.cjs', { nodeOptions: `${form} --max-old-space-size=1024` }).options, `${form} --max-old-space-size=1024`, form);
  }
  // another copy of bundle-lockfile: no second --require (Next.js 15.0 - 16.3 break with several)
  fs.cpSync(SRC, J(root, 'other copy/src'), { recursive: true });
  const other = `--require "${J(root, 'other copy/src/register.cjs')}"`;
  const withOther = run('probe.cjs', { nodeOptions: other });
  assert.equal(withOther.options, other);
  assert.equal(withOther.loaded, true);
  // another tool's register.cjs is no copy
  fs.mkdirSync(J(root, 'tool')); fs.writeFileSync(J(root, 'tool/register.cjs'), '// another tool\n');
  assert.equal(run('probe.cjs', { nodeOptions: `--require ${J(root, 'tool/register.cjs')}` }).options, `--require ${REGISTER} --require ${J(root, 'tool/register.cjs')}`);
  // in yarn's process (and only there) process.execPath is the shim
  const yarn = run('yarn/bin/yarn.js');
  assert.equal(yarn.execPath, fs.realpathSync(J(root, 'shim/node')));
  const script = (rel) => { fs.mkdirSync(path.dirname(J(root, rel)), { recursive: true }); fs.writeFileSync(J(root, rel), `require(${JSON.stringify(J(root, 'probe.cjs'))});`); return rel; };
  for (const rel of ['.yarn/releases/yarn-4.9.2.cjs', 'corepack/v1/yarn/4.9.2/yarn.js', 'corepack/v1/yarn/1.22.22/bin/yarn.js', 'corepack/dist/yarn.js']) {
    assert.equal(run(script(rel)).execPath, fs.realpathSync(J(root, 'shim/node')), rel);
  }
  // scripts named after yarn are not yarn
  for (const rel of ['node_modules/yarn-deduplicate/yarn-deduplicate.js', 'scripts/yarn-audit-fix.js', 'build/yarn.js']) {
    assert.equal(fs.realpathSync(run(script(rel)).execPath), fs.realpathSync(process.execPath), rel);
  }
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

test('node shim: without a register.cjs it fails (BUNDLE_LOCKFILE_STRICT=0: warns and runs node; BUNDLE_LOCKFILE_DISABLE=all: runs node)', { skip: process.platform === 'win32' }, () => {
  const SHIM = J(__dirname, '../bin/node');
  const root = project({ 'probe.cjs': `console.log(JSON.stringify({ loaded: !!globalThis[Symbol.for('bundle-lockfile.hooks-installed')], options: process.env.NODE_OPTIONS || '' }));` });
  fs.mkdirSync(J(root, 'bin')); fs.copyFileSync(SHIM, J(root, 'bin/node')); fs.chmodSync(J(root, 'bin/node'), 0o755); // no ../src/register.cjs, no ../register.cjs
  const realDir = path.dirname(fs.realpathSync(process.execPath));
  const run = (vars) => {
    const env = { ...process.env, PATH: [J(root, 'bin'), realDir, '/usr/bin', '/bin'].join(':') };
    for (const k of ['NODE_OPTIONS', 'BUNDLE_LOCKFILE_NODE_SHIM', 'BUNDLE_LOCKFILE_NODE_SEEN', 'BUNDLE_LOCKFILE_REGISTER', 'BUNDLE_LOCKFILE_STRICT', 'BUNDLE_LOCKFILE_DISABLE']) delete env[k];
    Object.assign(env, vars);
    return spawnSync(J(root, 'bin/node'), [J(root, 'probe.cjs')], { env, encoding: 'utf8', timeout: 20000 });
  };
  // strict (the default, also for values that are not 0, false or off): node is not run
  for (const strict of [undefined, '', '1', 'yes', '0 1']) {
    const r = run(strict === undefined ? {} : { BUNDLE_LOCKFILE_STRICT: strict });
    assert.equal(r.status, 1, `${JSON.stringify(strict)}: ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^\[bundle-lockfile\] ERROR: node shim: no register\.cjs next to .*bin\/node \(\.\.\/src\/register\.cjs or \.\.\/register\.cjs\); set BUNDLE_LOCKFILE_REGISTER \(BUNDLE_LOCKFILE_STRICT=0 makes this a warning\)\n$/);
  }
  // a BUNDLE_LOCKFILE_REGISTER that names no file
  const named = run({ BUNDLE_LOCKFILE_REGISTER: J(root, 'gone/register.cjs') });
  assert.equal(named.status, 1);
  assert.match(named.stderr, /ERROR: node shim: BUNDLE_LOCKFILE_REGISTER names no file: .*gone\/register\.cjs;/);
  // BUNDLE_LOCKFILE_STRICT=0 (any case, spaces around it): a warning, node runs without bundle-lockfile
  for (const strict of ['0', 'false', ' OFF ']) {
    const r = run({ BUNDLE_LOCKFILE_STRICT: strict });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^\[bundle-lockfile\] WARNING: node shim: no register\.cjs next to .* - node runs without bundle-lockfile\n$/);
    assert.deepEqual(JSON.parse(r.stdout), { loaded: false, options: '' });
  }
  // bundle-lockfile disabled: nothing to preload, nothing to say
  for (const disable of ['all', 'webpack, ALL']) {
    const r = run({ BUNDLE_LOCKFILE_DISABLE: disable });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.deepEqual(JSON.parse(r.stdout), { loaded: false, options: '' });
  }
  assert.equal(run({ BUNDLE_LOCKFILE_DISABLE: 'webpack' }).status, 1); // not all of it
});

test('esm-wrap: finds the entry, its exports, and wraps its functions; an entry with none of them is reported when it runs', () => {
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

test('bundler: the package around the file the adapter patched, a copy without a version at the bundler\'s', () => withConfig({ strict: true }, () => {
  const { bundlerPackage } = require('../src/core/bundler.cjs');
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
  const { viteOf, callerFiles } = require('../src/core/bundler.cjs');
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

test('hooks: in-thread ESM hooks only on Node >= 22.22.3 / 24.11.1 / 25.1 (nodejs/node#59929); loader-thread hooks only in bundler processes', () => {
  const hooks = require('../src/hooks.cjs');
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

// runs the plugin's hooks like a rollup/rolldown build writing `outDir`; chunks: [{ fileName, code, modules, entry }]
// (entry: its facade module), assets: [{ fileName, originalFileNames, source }]; ctx: the plugin context (Rollup's
// getWatchFiles); late(): what other plugins do after the write, before the plugin's closeBundle
async function rollupBuild(rollupPlugin, { outDir, chunks = [], assets = [], isWrite = true, ctx = {}, late, input }) {
  const out = { dir: outDir, format: 'es' };
  if (rollupPlugin.config) BUNDLERS.vite(rollupPlugin.config, ctx, [{}]); // Vite runs it (core/bundler.cjs: Vite's package)
  // Rollup or Rolldown run the hooks
  BUNDLERS[ctx.meta && ctx.meta.rolldownVersion ? 'rolldown' : 'rollup'](rollupPlugin.buildStart, ctx, [{ input }]); // the (normalized) input options
  rollupPlugin.renderStart.call(ctx, out);
  for (const c of chunks) rollupPlugin.renderChunk.call(ctx, c.code, { moduleIds: c.modules }, out);
  // (a chunk `removed`: rendered, then taken out of the bundle by a plugin - Vite's chunks of style only)
  const bundle = Object.fromEntries([...chunks.filter(c => !c.removed).map(c => [c.fileName, { type: 'chunk', fileName: c.fileName, code: c.code, moduleIds: c.modules,
    isEntry: !!c.entry, facadeModuleId: c.entry || null, ...(c.css && { viteMetadata: { importedCss: new Set(c.css) } }) }]), ...assets.map(a => [a.fileName, { type: 'asset', fileName: a.fileName, ...a }])]);
  await rollupPlugin.generateBundle.handler.call(ctx, out, bundle, isWrite);
  if (isWrite) {
    for (const f of Object.values(bundle)) {
      fs.mkdirSync(path.dirname(J(outDir, f.fileName)), { recursive: true });
      fs.writeFileSync(J(outDir, f.fileName), f.type === 'chunk' ? f.code : f.source || '');
    }
    await rollupPlugin.writeBundle.handler.call(ctx, out);
  }
  if (late) late();
  await rollupPlugin.closeBundle.handler.call(ctx);
}

test('outputs.hasFile: as filesOf().has(), also after the build\'s file list grew', () => {
  const target = J(os.tmpdir(), `bl-hasfile-${process.pid}`, 'bundle-lockfile/package-lock.json');
  const files = ['/o/a.js', '/o/b.js'];
  outputs.record(target, 'hasFile', [], os.tmpdir(), files, { id: 'hasFile' });
  assert.deepEqual(['/o/a.js', '/o/b.js', '/o/c.js'].map(f => outputs.hasFile(target, f)), [true, true, false]);
  files.push('/o/c.js'); // (an adapter adds files written after its build)
  assert.equal(outputs.hasFile(target, '/o/c.js'), true);
  assert.equal(outputs.hasFile(J(os.tmpdir(), 'no-such-target'), '/o/a.js'), false);
});

test('inToolCache: outputs below node_modules are a tool\'s cache, except below node_modules/.cache/', () => {
  const { inToolCache } = require('../src/core/paths.cjs');
  for (const [dir, want] of [
    ['/p/dist', false], ['/p/node_modules/.vite/deps', true], ['/p/node_modules/@vitejs/plugin-legacy/dist', true],
    ['/p/node_modules/.cache', false], ['/p/node_modules/.cache/nuxt/.nuxt/dist/client', false],
    ['/p/node_modules/.cache/x/node_modules/y/dist', true], // a package's directory inside the cache: the last node_modules counts
    ['/p/.cache/deps', false], ['/p/node_modules_old/dist', false],
  ]) assert.equal(inToolCache(dir), want, dir);
});

test('rollup adapter: a written output gets its lockfile; generate-only builds and outputs below node_modules none', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c'), ...pj('d'), 'node_modules/d/logo.svg': '<svg/>', 'src/main.js': '' });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const rollupPlugin = rollupAdapter.bundleLockfile('vite', { input: J(root, 'index.html') });
    await rollupBuild(rollupPlugin, { outDir: J(root, 'dist'), chunks: [
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

test('rollup adapter: the file of a module id: queries and fragments cut, a "#" in a directory or file name kept', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const root = project({ 'c#proj/node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'c#proj/node_modules/a/i.js': '', 'c#proj/src/a#b.js': '' });
  const p = (f) => J(root, 'c#proj', f);
  assert.equal(rollupAdapter.fileOf(p('node_modules/a/i.js')), p('node_modules/a/i.js'));
  assert.equal(rollupAdapter.fileOf(`\0${p('node_modules/a/i.js')}?commonjs-proxy`), p('node_modules/a/i.js'));
  assert.equal(rollupAdapter.fileOf(p('src/a#b.js')), p('src/a#b.js'));         // a file name with "#"
  assert.equal(rollupAdapter.fileOf(`${p('src/a#b.js')}#frag`), p('src/a#b.js')); // and a fragment
  assert.equal(rollupAdapter.fileOf(`${p('src/x.css')}#hash`), p('src/x.css'));   // a fragment, also of a file that is not there
  assert.equal(rollupAdapter.fileOf(`${p('src/App.vue')}?vue&type=style&index=0#x`), p('src/App.vue'));
  assert.equal(rollupAdapter.fileOf('\0vite/modulepreload-polyfill.js'), null);
  // a whole build in that directory: its packages
  const cwd = process.cwd();
  process.chdir(J(root, 'c#proj'));
  try {
    await rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: p('dist'), chunks: [{ fileName: 'main.js', code: 'main', modules: [p('src/a#b.js'), p('node_modules/a/i.js')] }] });
    assert.deepEqual(lockedNames(fs.readFileSync(p(`dist/${LOCK}`), 'utf8')), ['a']);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: the bundler whose code is in the chunks is listed - Rollup or Rolldown, and Vite; the copies that ran', async () => withConfig({ strict: true }, async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/vite/package.json': { name: 'vite', version: '7.3.7' } });
  const cwd = process.cwd();
  process.chdir(root);
  problems.take();
  const listed = (dir) => allEntries(fs.readFileSync(J(dir, LOCK), 'utf8')).map(([, p]) => `${p.name}@${p.version}`).sort();
  const chunk = { fileName: 'main.js', code: 'main', modules: [J(root, 'node_modules/a/i.js')] };
  try {
    // configured by hand: the Rollup that runs its hooks
    await rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: J(root, 'r'), chunks: [chunk] });
    assert.deepEqual(listed(J(root, 'r')), ['a@1.0.0', `rollup@${UNIT}`]);
    // Rolldown (which says it is a Rollup too, meta.rollupVersion): Rolldown only
    await rollupBuild(rollupAdapter.bundleLockfile('rolldown'), { outDir: J(root, 'rd'), chunks: [chunk], ctx: { meta: { rolldownVersion: UNIT, rollupVersion: '4.0.0' } } });
    assert.deepEqual(listed(J(root, 'rd')), ['a@1.0.0', `rolldown@${UNIT}`]);
    // Vite: also the Vite that runs its config hook
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'v'), chunks: [chunk] });
    assert.deepEqual(listed(J(root, 'v')), ['a@1.0.0', `rollup@${UNIT}`, `vite@${UNIT}`]);
    // an output without chunks (only assets): no code of the bundler's
    await rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: J(root, 'assets'), assets: [{ fileName: 'x.txt', source: 'x' }] });
    assert.deepEqual(listed(J(root, 'assets')), []);
    assert.deepEqual(problems.take(), []);
    // Vite says it is another version (Vite 7+: meta.viteVersion) than the package its caller is in: a problem
    await assert.rejects(rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'vm'), chunks: [chunk], ctx: { meta: { viteVersion: '7.3.7' }, error: (e) => { throw e; } } }),
      /the build runs Vite 7\.3\.7, its caller is in .*vite \(vite@0\.0\.0-unit\)/);
    problems.take();
    // added by the preload: the copy whose rollup() was called (its entry module), and Vite around the caller
    let opts = null;
    const rollup = rollupAdapter.esmWrap('rollup', 'rollup', (o) => { opts = o; return Promise.resolve({}); }, pathToFileURLHref(J(BUNDLERS.root, 'node_modules/rollup/dist/shared/rollup.js')));
    BUNDLERS.vite(rollup, null, [{ plugins: [{ name: 'vite:build-html' }] }]); // (Vite calls it)
    const p = opts.plugins.find(x => x.name === 'bundle-lockfile');
    await rollupBuild(p, { outDir: J(root, 'pre'), chunks: [chunk] });
    assert.deepEqual(listed(J(root, 'pre')), ['a@1.0.0', `rollup@${UNIT}`, `vite@${UNIT}`]);
    assert.deepEqual(problems.take(), []);
  } finally { process.chdir(cwd); }
}));

test('rollup adapter: an asset emitted from a package file, named relative to a Vite root that is not the working directory', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('font'), ...pj('changed'), ...pj('decoy'), 'node_modules/font/f.woff2': 'font bytes',
    'node_modules/changed/c.svg': 'original', 'web/node_modules/decoy/d.svg': 'other bytes', 'node_modules/decoy/d.svg': 'decoy bytes', 'web/index.html': '',
    'web/node_modules/decoy/package.json': { name: 'decoy', version: '2.0.0' } });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    // vite build with root: 'web': Vite names an asset relative to its root (web/), the working directory is the project
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'dist'), chunks: [
      { fileName: 'assets/index.js', code: 'index', modules: [J(root, 'web/index.html'), J(root, 'web/main.js')], entry: J(root, 'web/index.html') },
    ], assets: [
      { fileName: 'assets/f.woff2', originalFileNames: ['../node_modules/font/f.woff2'], source: Buffer.from('font bytes') },
      // a file of that name with other bytes is not the asset's file
      { fileName: 'assets/c.svg', originalFileNames: ['../node_modules/changed/c.svg'], source: 'transformed' },
      // a file of that name relative to the working directory, but with other bytes: the one relative to the root is it
      { fileName: 'assets/d.svg', originalFileNames: ['node_modules/decoy/d.svg'], source: 'other bytes' },
    ] });
    // decoy@2.0.0 is the one in web/node_modules (keyed node_modules/decoy: every key is in node_modules/)
    assert.deepEqual(entries(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')).map(([, p]) => `${p.name}@${p.version}`).sort(), ['decoy@2.0.0', 'font@1.0.0']);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: outputs of one build written at the same time into one directory, in the same format, are writers of their own', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    // as Promise.all([bundle.write(a), bundle.write(b)]) (the rollup command line): every hook of one output gets
    // its own output options object; the hooks of both outputs interleave
    const dir = J(root, 'dist'), rollupPlugin = rollupAdapter.bundleLockfile('rollup', { input: 'src/main.js' });
    const outs = ['main.js', 'main.min.js'].map(entryFileNames => ({ dir, format: 'es', entryFileNames }));
    const modules = [J(root, 'src/main.js'), J(root, 'node_modules/a/i.js')];
    const chunk = (out) => ({ type: 'chunk', fileName: out.entryFileNames, code: `code of ${out.entryFileNames}`, moduleIds: modules, isEntry: true, facadeModuleId: modules[0] });
    rollupPlugin.buildStart.call({});
    for (const out of outs) rollupPlugin.renderStart.call({}, out);
    for (const out of outs) rollupPlugin.renderChunk.call({}, '', { moduleIds: modules }, out);
    for (const out of outs) await rollupPlugin.generateBundle.handler.call({}, out, { [out.entryFileNames]: chunk(out) }, true);
    fs.mkdirSync(dir, { recursive: true });
    for (const out of outs) fs.writeFileSync(J(dir, out.entryFileNames), chunk(out).code);
    await Promise.all(outs.map(out => rollupPlugin.writeBundle.handler.call({}, out)));
    await rollupPlugin.closeBundle.handler.call({});
    const writers = JSON.parse(fs.readFileSync(J(dir, LOCK), 'utf8'))['bundle-lockfile'].writers;
    assert.deepEqual(writers.map(w => w.files).sort(), [['../main.js'], ['../main.min.js']]);
    // each with the hash of its own file, for a build that bundles it (nested)
    assert.deepEqual(writers.map(w => Object.keys(w.outputs)).sort(), [['../main.js'], ['../main.min.js']]);
    assert.deepEqual(writers.map(w => w.packages), [['node_modules/a'], ['node_modules/a']]);
  } finally { process.chdir(cwd); }
});

test('outputs: runs of one config into one directory that write other files (other plugins, hashes, no clean) keep each other\'s packages while those files are there', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('c') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const dist = J(root, 'dist');
    const run = (file, name, own = rollupAdapter.bundleLockfile('vite', { input: 'src/sel.js' })) =>
      rollupBuild(own, { outDir: dist, chunks: [{ fileName: file, code: file, modules: [J(root, `node_modules/${name}/i.js`)] }] });
    const locked = () => lockedNames(fs.readFileSync(J(dist, LOCK), 'utf8'));
    // the same config twice in one process (rollup -c with two configs, other plugins), with hashed file names
    await run('sel-1.js', 'a');
    await run('sel-2.js', 'b');
    assert.deepEqual(locked(), ['a', 'b']);
    // its rebuild writing the same file again replaces it
    const same = rollupAdapter.bundleLockfile('vite', { input: 'src/sel.js' });
    await run('sel-2.js', 'c', same);
    assert.deepEqual(locked(), ['a', 'c']);
    // gone: no longer
    fs.rmSync(J(dist, 'sel-1.js'));
    await run('sel-2.js', 'c', same);
    assert.deepEqual(locked(), ['c']);
    // another process ran the same config before, into other files: the lockfile on disk has them, this run keeps them
    const before = JSON.parse(fs.readFileSync(J(dist, LOCK), 'utf8'));
    const state = globalThis[Symbol.for('bundle-lockfile.outputs.v4')];
    state.files.delete(J(dist, LOCK)); // (as a new process)
    fs.writeFileSync(J(dist, LOCK), JSON.stringify(before));
    await run('sel-3.js', 'a');
    assert.deepEqual(locked(), ['a', 'c']);
    const lock = JSON.parse(fs.readFileSync(J(dist, LOCK), 'utf8'));
    assert.deepEqual(lock['bundle-lockfile'].writers.map(w => w.files.join(' ')).sort(), ['../sel-2.js', '../sel-3.js']);
    assert.equal(new Set(lock['bundle-lockfile'].writers.map(w => w.id)).size, 2);
    // and the next run of it again (the earlier run's writer, an id of its own now, is another process's)
    state.files.delete(J(dist, LOCK));
    await run('sel-3.js', 'b');
    assert.deepEqual(locked(), ['b', 'c']);
    // a writer whose files are outside the output (Next.js' runtime packages: the traced files in node_modules), another
    // process's run before: replaced
    const traced = J(root, 'node_modules/a/i.js');
    fs.writeFileSync(traced, 'a');
    const target = J(root, 'runtime', LOCK);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const [pa, pb] = ['a', 'b'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
    const runtimeId = crypto.createHash('sha256').update('runtime').digest('hex').slice(0, 16);
    fs.writeFileSync(target, toPackageLock([pa], root, { dir: path.dirname(target), writers: [{ id: runtimeId, files: [traced], paths: [pa.path] }] }));
    outputs.record(target, 'runtime', [pb], root, [J(root, 'node_modules/b/i.js')], { disk: true });
    await outputs.land(target, 'runtime', 'test');
    assert.deepEqual(lockedNames(fs.readFileSync(target, 'utf8')), ['b']);
    // a writer whose lockfile the bundler writes with the content it is given (Angular, an in-memory output): its own
    // record of the build before, with files still there, is replaced by the next build
    const ng = J(root, 'ng', LOCK);
    for (const f of ['old.js', 'new.js']) { fs.mkdirSync(J(root, 'ng'), { recursive: true }); fs.writeFileSync(J(root, 'ng', f), f); }
    const first = outputs.record(ng, 'ng', [pa], root, [J(root, 'ng/old.js')], { disk: true });
    fs.mkdirSync(path.dirname(ng), { recursive: true });
    fs.writeFileSync(ng, first);
    outputs.emitted(ng, 'ng');
    assert.deepEqual(lockedNames(outputs.record(ng, 'ng', [pb], root, [J(root, 'ng/new.js')], { disk: true })), ['b']);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: Rolldown write() without dir and file: the lockfile in dist/, where Rolldown writes', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const rollupPlugin = rollupAdapter.bundleLockfile('rolldown', { input: 'src/main.js' });
    const ctx = { meta: { rolldownVersion: '1.2.13', rollupVersion: '4.23.0' } }; // Rolldown's plugin context
    const out = { format: 'es' }; // neither dir nor file in the hooks' output options
    const modules = [J(root, 'src/main.js'), J(root, 'node_modules/a/i.js')];
    rollupPlugin.buildStart.call(ctx, { input: ['src/main.js'] });
    rollupPlugin.renderStart.call(ctx, out);
    rollupPlugin.renderChunk.call(ctx, '', { moduleIds: modules }, out);
    await rollupPlugin.generateBundle.handler.call(ctx, out, { 'main.js': { type: 'chunk', fileName: 'main.js', code: 'rolldown main', moduleIds: modules } }, true);
    fs.mkdirSync(J(root, 'dist'));
    fs.writeFileSync(J(root, 'dist/main.js'), 'rolldown main');
    await rollupPlugin.writeBundle.handler.call(ctx, out);
    await rollupPlugin.closeBundle.handler.call(ctx);
    const lock = JSON.parse(fs.readFileSync(J(root, 'dist', LOCK), 'utf8'));
    assert.deepEqual(lockedNames(JSON.stringify(lock)), ['a']);
    assert.deepEqual(lock['bundle-lockfile'].writers.map(w => w.files), [['../main.js']]);
    assert.equal(fs.existsSync(J(root, LOCK)), false);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: Rolldown - the outputs of a build resolved against its cwd option; files written after its first write() of several are found', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/late/package.json': { name: 'late', version: '1.0.0' },
    'node_modules/late/l.js': 'late code' });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const rollupPlugin = rollupAdapter.bundleLockfile('rolldown', { input: 'src/main.js' });
    const ctx = { meta: { rolldownVersion: '1.2.13', rollupVersion: '4.23.0' } };
    const pkgDir = J(root, 'packages/a');
    const modules = [J(pkgDir, 'src/main.js'), J(root, 'node_modules/a/i.js')];
    // one build, two write()s (Rolldown runs buildStart for each): rolldown({ cwd: 'packages/a' }), dirs relative to it
    const write = async (dir) => {
      const out = { dir, format: 'es' };
      rollupPlugin.buildStart.call(ctx, { input: ['src/main.js'], cwd: pkgDir });
      rollupPlugin.renderStart.call(ctx, out);
      rollupPlugin.renderChunk.call(ctx, '', { moduleIds: modules }, out);
      await rollupPlugin.generateBundle.handler.call(ctx, out, { 'main.js': { type: 'chunk', fileName: 'main.js', code: `main ${dir}`, moduleIds: modules } }, true);
      fs.mkdirSync(J(pkgDir, dir), { recursive: true });
      fs.writeFileSync(J(pkgDir, dir, 'main.js'), `main ${dir}`);
      await rollupPlugin.writeBundle.handler.call(ctx, out);
    };
    await write('dist');
    // another plugin copies a package file into the first output (in its writeBundle), well before the second write()
    fs.mkdirSync(J(pkgDir, 'dist/vendor/node_modules/late'), { recursive: true });
    fs.writeFileSync(J(pkgDir, 'dist/vendor/node_modules/late/l.js'), 'late code');
    await new Promise(res => setTimeout(res, 2100));
    await write('dist-legacy');
    await rollupPlugin.closeBundle.handler.call(ctx);
    assert.deepEqual(lockedNames(fs.readFileSync(J(pkgDir, 'dist', LOCK), 'utf8')), ['a', 'late']);
    assert.deepEqual(lockedNames(fs.readFileSync(J(pkgDir, 'dist-legacy', LOCK), 'utf8')), ['a']);
    assert.equal(fs.existsSync(J(root, 'dist', LOCK)), false); // (not relative to the process's working directory)
  } finally { process.chdir(cwd); }
});

test('strict: a problem of a build that writes nothing itself fails it with that problem (not wrapped in another)', () => withConfig({ strict: true }, async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/nopj/i.js': '' });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    problems.take();
    const ctx = { error: (e) => { throw e; } };
    await assert.rejects(rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'gen'), isWrite: false, ctx,
      chunks: [{ fileName: 'w.js', code: 'worker without a package.json', modules: [J(root, 'node_modules/nopj/i.js')] }] }), (e) => {
      assert.match(e.message, /no package\.json with name and version in \S*nopj/);
      assert.doesNotMatch(e.message, /could not collect the bundled packages/);
      return true;
    });
  } finally { process.chdir(cwd); }
}));

test('rollup adapter: a plugin from the Vite config adds itself to worker.plugins, and its worker builds count', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('w') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const names = (list) => list.map(p => p.name);
    const rollupPlugin = rollupAdapter.bundleLockfile('vite');
    // no worker.plugins, a function (Vite 5+), an array (Vite 4's form), one that has bundle-lockfile's already
    const cfg = {};
    rollupPlugin.config(cfg);
    assert.deepEqual(names(cfg.worker.plugins()), ['bundle-lockfile']);
    const fn = { worker: { format: 'es', plugins: () => [{ name: 'user' }] } };
    rollupPlugin.config(fn);
    assert.equal(fn.worker.format, 'es');
    assert.deepEqual(names(fn.worker.plugins()), ['user', 'bundle-lockfile']);
    const arr = { worker: { plugins: [{ name: 'user' }] } };
    rollupPlugin.config(arr);
    assert.deepEqual(names(arr.worker.plugins()), ['user', 'bundle-lockfile']);
    const has = { worker: { plugins: () => [[rollupAdapter.bundleLockfile('vite')]] } };
    rollupPlugin.config(has);
    assert.deepEqual(names(has.worker.plugins().flat()), ['bundle-lockfile']);
    // only for Vite
    assert.equal(rollupAdapter.bundleLockfile('rollup').config, undefined);
    assert.equal(rollupAdapter.bundleLockfile('rolldown').config, undefined);

    // the worker build (generate-only) with the plugin from worker.plugins, then the main build that emits its chunk
    const worker = cfg.worker.plugins()[0];
    await rollupBuild(worker, { outDir: J(root, 'dist'), chunks: [{ fileName: 'w.js', code: 'the worker', modules: [J(root, 'node_modules/w/i.js')], entry: J(root, 'src/w.js') }], isWrite: false });
    await rollupBuild(rollupPlugin, { outDir: J(root, 'dist'), chunks: [{ fileName: 'main.js', code: 'main', modules: [J(root, 'node_modules/a/i.js')] }],
      assets: [{ fileName: 'assets/w-1.js', source: 'the worker' }] });
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['a', 'w']);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: the preload hands a plugin from the config the build rolldown() returns (its watch files)', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('s') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const rollupPlugin = rollupAdapter.bundleLockfile('vite');
    // Rolldown: the style sheets a style sheet @imports are watch files of the build rolldown() returns only
    const build = { watchFiles: Promise.resolve([J(root, 'src/app.css'), J(root, 'node_modules/s/s.css')]) };
    let got;
    const rolldown = rollupAdapter.esmWrap('rolldown', 'rolldown', (options) => { got = options; return Promise.resolve(build); });
    const options = { input: 'index.html', plugins: [{ name: 'vite:css' }, [rollupPlugin]] };
    assert.equal(await rolldown(options), build);
    assert.equal(got, options); // no second plugin
    const ctx = { meta: { rolldownVersion: '1.2.13' } }; // no getWatchFiles in Rolldown's plugin context
    await rollupBuild(rollupPlugin, { outDir: J(root, 'dist'), chunks: [{ fileName: 'main.js', code: 'main', modules: [J(root, 'node_modules/a/i.js'), J(root, 'src/app.css')] }], ctx });
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['a', 's']);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: plugins configured by hand, two builds of different inputs into one directory: both writers', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    // bundleLockfile() without options, as in a config: the input comes from buildStart's options
    for (const name of ['a', 'b']) {
      await rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: J(root, 'dist'), input: [J(root, `src/${name}.js`)],
        chunks: [{ fileName: `${name}.js`, code: `hand-configured ${name}`, modules: [J(root, `src/${name}.js`), J(root, `node_modules/${name}/i.js`)] }] });
    }
    const lock = JSON.parse(fs.readFileSync(J(root, 'dist', LOCK), 'utf8'));
    assert.deepEqual(lockedNames(JSON.stringify(lock)), ['a', 'b']);
    assert.equal(new Set(lock['bundle-lockfile'].writers.map(w => w.id)).size, 2);
  } finally { process.chdir(cwd); }
});

test('nested: a bundled file another build produced brings its packages, also when it changed since (with a warning)', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
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
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const copies = require('../src/core/copies.cjs');
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
  const rollupAdapter = require('../src/adapters/rollup.cjs');
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

test('strict: a nested build\'s lockfile that cannot be read fails the build that bundles its output (BUNDLE_LOCKFILE_STRICT=0: a warning)', () => {
  const lock = (record) => JSON.stringify({ lockfileVersion: 3, requires: true, packages: { '': {} }, ...(record === undefined ? {} : { 'bundle-lockfile': record }) });
  const cases = [
    ['not JSON', '{ "lockfileVersion": 3,', 'is not JSON'],
    ['another version', lock({ v: 1, context: '.', writers: [] }), 'has a record of version 1, which this bundle-lockfile does not read (it reads version 2): build it again with this one'],
    ['another shape', lock({ v: 2, context: 1, writers: 'x' }), 'has a bundle-lockfile record of a shape it does not read'],
  ];
  for (const [what, content, why] of cases) {
    const root = project({ 'island/dist/main.js': 'x', 'island/dist/bundle-lockfile/package-lock.json': content });
    const file = J(root, 'island/dist/bundle-lockfile/package-lock.json');
    const msg = `${file} ${why}: the packages of the build that wrote ${J(root, 'island/dist')} would be missing (a bundled file there may be its output)`;
    const script = `const p = require(${JSON.stringify(J(SRC, 'core/packages.cjs'))}); const problems = require(${JSON.stringify(J(SRC, 'core/problems.cjs'))});
      p.packagesOfFiles([${JSON.stringify(J(root, 'island/dist/main.js'))}]); console.log(JSON.stringify(problems.take()));`;
    const strict = nodeWith(strictEnv(undefined), ['-e', script]);
    assert.deepEqual(JSON.parse(strict.stdout), [msg], `${what}: ${strict.stderr}`);
    const off = nodeWith(strictEnv('0'), ['-e', script]);
    assert.deepEqual([JSON.parse(off.stdout), off.stderr], [[], `[bundle-lockfile] WARNING: ${msg}\n`], what);
  }
  // a lockfile that cannot be read (a directory in its place; permissions do not stop root, which runs the tests in CI)
  const dir = project({ 'island/dist/main.js': 'x', 'island/dist/bundle-lockfile/package-lock.json/x': '' });
  const unreadable = nodeWith(strictEnv(undefined), ['-e', `const p = require(${JSON.stringify(J(SRC, 'core/packages.cjs'))}); const problems = require(${JSON.stringify(J(SRC, 'core/problems.cjs'))});
    p.packagesOfFiles([${JSON.stringify(J(dir, 'island/dist/main.js'))}]); console.log(JSON.stringify(problems.take()));`]);
  const [got] = JSON.parse(unreadable.stdout);
  const lockAt = J(dir, 'island/dist/bundle-lockfile/package-lock.json');
  assert.ok(got.startsWith(`could not read ${lockAt}: the packages of the build that wrote ${J(dir, 'island/dist')} would be missing (a bundled file there may be its output): EISDIR`), got);
  // the project's own lockfile (BUNDLE_LOCKFILE_FILE=package-lock.json, an output directory that is the project): no
  // record, nothing to say; no lockfile at all: nothing either
  const own = project({ 'src/a.js': 'x', 'package-lock.json': lock(undefined), 'other/b.js': 'x' });
  const script = `const p = require(${JSON.stringify(J(SRC, 'core/packages.cjs'))}); const problems = require(${JSON.stringify(J(SRC, 'core/problems.cjs'))});
    p.packagesOfFiles([${JSON.stringify(J(own, 'src/a.js'))}, ${JSON.stringify(J(own, 'other/b.js'))}]); console.log(JSON.stringify(problems.take()));`;
  const r = nodeWith({ ...strictEnv(undefined), BUNDLE_LOCKFILE_FILE: 'package-lock.json' }, ['-e', script]);
  assert.deepEqual([r.stdout, r.stderr], ['[]\n', '']);
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
  const rollupAdapter = require('../src/adapters/rollup.cjs');
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

test('generated: a build that writes nothing itself keeps the packages of the files its plugins inlined (a worker\'s font as a data: URL)', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('font'), ...pj('w'), ...pj('app') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const m = (name, f = 'i.js') => J(root, 'node_modules', name, f);
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'gen'), isWrite: false, ctx: { getWatchFiles: () => [m('font', 'f.woff2')] },
      chunks: [{ fileName: 'worker.js', code: 'worker with an inlined font', modules: [m('w')] }] });
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'dist'),
      chunks: [{ fileName: 'main.js', code: 'main', modules: [m('app')] }], assets: [{ fileName: 'worker.js', source: 'worker with an inlined font' }] });
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['app', 'font', 'w']);
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
    const rollupPlugin = rollupAdapter.bundleLockfile('vite');
    rollupPlugin.api.setBuild({ get watchFiles() { return Promise.resolve(watch); } });
    await rollupBuild(rollupPlugin, { outDir: J(root, 'b'), chunks: [{ fileName: 'i.js', code: 'style b', modules: [J(root, 'src/main.js')] }] });
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

test('rollup adapter: files plugins inlined - watch files that are no module of the build (data: URLs, shader includes)', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('icons'), ...pj('glsl'), ...pj('tree'), ...pj('@tsconfig/strictest'), ...pj('a') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const nm = (name, f) => J(root, 'node_modules', name, f);
    // Vite 6.1+: the image a style sheet inlines as a data: URL; a plugin's shader #include; Rolldown: the tsconfig
    // files; a JSON module that was tree-shaken (a module of the build, in no chunk: not inlined); the modules themselves
    const watch = [J(root, 'src/main.js'), J(root, 'src/app.css'), nm('icons', 'bell.svg'), nm('glsl', 'noise.glsl'), nm('@tsconfig/strictest', 'tsconfig.json'),
      nm('tree', 'data.json'), nm('a', 'i.js')];
    const modules = [J(root, 'src/main.js'), J(root, 'src/app.css'), nm('a', 'i.js'), `\0${nm('tree', 'data.json')}?commonjs-proxy`];
    const ctx = { getWatchFiles: () => watch, getModuleIds: () => modules.values() };
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'dist'), ctx,
      chunks: [{ fileName: 'i.js', code: 'inlined', modules: [J(root, 'src/main.js'), nm('a', 'i.js')] }], assets: [{ fileName: 'i.css', source: 'css' }] });
    const lock = JSON.parse(fs.readFileSync(J(root, 'dist', LOCK), 'utf8'));
    assert.deepEqual(lockedNames(JSON.stringify(lock)), ['a', 'glsl', 'icons']);
    // for nested bundles: the CSS file has every inlined file's package, the chunk those that are no style's
    const w = lock['bundle-lockfile'].writers[0];
    const names = (f) => w.contents[f].map(i => lock.packages[w.packages[i]]).filter(notUnit).map(p => p.name).sort(); // indices into the writer's packages; without the unit tests' bundlers
    assert.deepEqual(names('../i.css'), ['glsl', 'icons']);
    assert.deepEqual(names('../i.js'), ['a', 'glsl', 'icons']);
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
    const rollupPlugin = rollupAdapter.bundleLockfile('vite');
    await rollupBuild(rollupPlugin, { outDir: dist, chunks: [{ fileName: 'assets/index.js', code: 'index', modules: [J(root, 'node_modules/app/i.js')] }], late() {
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

test('rollup adapter: files written after the build: over 20 MiB only this process\'s copies, at most 20,000 entries looked at', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const copies = require('../src/core/copies.cjs');
  const big = Buffer.alloc(20 * 1024 * 1024 + 1, 'a');
  const root = project({ 'node_modules/big/package.json': { name: 'big', version: '1.0.0' }, 'node_modules/app/package.json': { name: 'app', version: '1.0.0' } });
  fs.writeFileSync(J(root, 'node_modules/big/big.js'), big);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const build = async (dist, late) => {
      await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: dist, chunks: [{ fileName: 'index.js', code: `index ${dist}`, modules: [J(root, 'node_modules/app/i.js')] }], late });
      return lockedNames(fs.readFileSync(J(dist, LOCK), 'utf8'));
    };
    const warned = [], warn = config.warn;
    config.warn = (...a) => warned.push(a.join(' '));
    // its path names the package and it has its bytes, but it is over 20 MiB and not a copy this process made: not
    // compared, and said so
    try {
      assert.deepEqual(await build(J(root, 'd1'), () => {
        fs.mkdirSync(J(root, 'd1/vendor/node_modules/big'), { recursive: true });
        fs.writeFileSync(J(root, 'd1/vendor/node_modules/big/big.js'), big);
      }), ['app']);
    } finally { config.warn = warn; }
    assert.deepEqual(warned, [`${J(root, 'd1/vendor/node_modules/big/big.js')} is larger than 20 MiB: not compared with node_modules/big/big.js, whose package it may be a copy of`]);
    warned.length = 0;
    // copied by this process with fs (recorded as copies.install's wrappers do): its package, whatever its size
    assert.deepEqual(await build(J(root, 'd2'), () => {
      copies.record(J(root, 'node_modules/big/big.js'), J(root, 'd2/big.js'));
      fs.copyFileSync(J(root, 'node_modules/big/big.js'), J(root, 'd2/big.js'));
    }), ['app', 'big']);
    // more than 20,000 entries in the output: the rest is not looked at, and that is said
    const many = J(root, 'd3/many');
    fs.mkdirSync(many, { recursive: true });
    const statted = new Set();
    const stat = fs.statSync;
    fs.statSync = function (p, ...rest) { if (typeof p === 'string' && p.startsWith(many)) statted.add(p); return stat.call(this, p, ...rest); };
    config.warn = (...a) => warned.push(a.join(' '));
    try {
      await build(J(root, 'd3'), () => { for (let i = 0; i < 20100; i++) fs.writeFileSync(J(many, `${i}.txt`), ''); });
    } finally { fs.statSync = stat; config.warn = warn; }
    assert.ok(statted.size > 19900 && statted.size <= 20000, `${statted.size} files looked at`);
    assert.deepEqual(warned, [`more than 20000 entries in ${J(root, 'd3')}: the files written there after the build were not all checked for packages`]);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: files written after the build that are older: copies keeping their source\'s time, files a watch rebuild did not write again', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const copies = require('../src/core/copies.cjs');
  copies.install();
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('app'), ...pj('kept'), ...pj('once'), 'node_modules/kept/k.js': 'kept code', 'node_modules/once/o.js': 'once code' });
  const old = new Date('1985-10-26T08:15:00Z');
  fs.utimesSync(J(root, 'node_modules/kept/k.js'), old, old);
  fs.utimesSync(J(root, 'node_modules/once/o.js'), old, old);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const dist = J(root, 'dist');
    const watching = rollupAdapter.bundleLockfile('vite');
    const build = (n, late) => rollupBuild(watching, { outDir: dist, chunks: [{ fileName: 'index.js', code: `index ${n}`, modules: [J(root, 'node_modules/app/i.js')] }], late });
    // fs.cp with preserveTimestamps: the copy has npm's time of its source, long before the build
    await build(1, () => {
      fs.cpSync(J(root, 'node_modules/kept/k.js'), J(dist, 'vendor/k.js'), { preserveTimestamps: true });
      fs.mkdirSync(J(dist, 'vendor/node_modules/once'), { recursive: true }); // (another process's copy: found by path and bytes)
      fs.writeFileSync(J(dist, 'vendor/node_modules/once/o.js'), 'once code');
    });
    assert.ok(fs.statSync(J(dist, 'vendor/k.js')).mtimeMs < Date.now() - 1e9);
    assert.deepEqual(lockedNames(fs.readFileSync(J(dist, LOCK), 'utf8')), ['app', 'kept', 'once']);
    // the watch rebuild: the copy plugin copies only once; its files still ship
    await new Promise(res => setTimeout(res, 2100)); // (older than the rebuild by more than the coarse-timestamp margin)
    await build(2, () => {});
    assert.deepEqual(lockedNames(fs.readFileSync(J(dist, LOCK), 'utf8')), ['app', 'kept', 'once']);
    // gone, or changed since: no longer
    fs.rmSync(J(dist, 'vendor/node_modules'), { recursive: true });
    fs.writeFileSync(J(dist, 'vendor/k.js'), 'own code');
    fs.utimesSync(J(dist, 'vendor/k.js'), old, old);
    await build(3, () => {});
    assert.deepEqual(lockedNames(fs.readFileSync(J(dist, LOCK), 'utf8')), ['app']);
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
  // (the request: the module's file, as hooks.cjs passes it)
  const exp = { version: '4.64.2', rollup: async (o) => seen.push(['rollup', o.plugins.map(p => p.name)]), rollupInternal: async (o, hooks) => seen.push(['internal', o.plugins.map(p => p.name), hooks]) };
  const file = J('/x/node_modules/rollup/dist/shared/rollup.js');
  const other = J('/x/node_modules/other/dist/shared/rollup.js');
  rollupAdapter.onCjsLoad({ rollupInternal() {} }, other, () => other); // not Rollup's
  rollupAdapter.onCjsLoad(exp, file, () => file);
  rollupAdapter.onCjsLoad(exp, file, () => file); // once
  exp.rollup({ plugins: [{ name: 'x' }] });
  exp.rollupInternal({ plugins: [] }, 'hooks');
  assert.deepEqual(seen, [['rollup', ['x', 'bundle-lockfile']], ['internal', ['bundle-lockfile'], 'hooks']]);
  const wasmFile = J('/x/node_modules/@rollup/wasm-node/dist/shared/rollup.js');
  const wasm = { version: '4.64.2', rollupInternal: async (o) => seen.push(o.plugins.length) };
  rollupAdapter.onCjsLoad(wasm, wasmFile, () => wasmFile);
  wasm.rollupInternal({});
  assert.equal(seen.pop(), 1);
  // workbox-build's Rollup 2.79 has the object hooks the plugin uses (2.78 and later)
  const two = { version: '2.79.2', rollupInternal: async (o) => seen.push(o.plugins.length) };
  rollupAdapter.onCjsLoad(two, file, () => file);
  two.rollupInternal({});
  assert.equal(seen.pop(), 1);
});

test('strict: Rollup\'s CommonJS build of a version bundle-lockfile cannot hook is a problem (its require() fails)', () => withConfig({ strict: true }, () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  problems.take();
  const file = J('/x/node_modules/rollup/dist/shared/rollup.js');
  rollupAdapter.onCjsLoad({ version: '2.40.0', rollupInternal() {} }, file, () => file); // no object hooks yet
  rollupAdapter.onCjsLoad({ version: '5.0.0', rollupInternalV2() {} }, file, () => file); // a future one without rollupInternal
  const taken = problems.take();
  assert.equal(taken.length, 2);
  assert.match(taken[0], /rollup: .*rollup\.js \(Rollup 2\.40\.0\) is no Rollup bundle-lockfile can hook \(2\.78 or later, with rollupInternal\): its builds would write no lockfile/);
  assert.match(taken[1], /\(Rollup 5\.0\.0\) is no Rollup bundle-lockfile can hook/);
}));

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

test('copies: a file copied, then overwritten by a directory copy, is the later copy\'s; a destination through a symbolic link by its real path', { skip: process.platform === 'win32' }, () => {
  const copies = require('../src/core/copies.cjs');
  copies.install();
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/a/x.js': 'a code',
    'node_modules/b/package.json': { name: 'b', version: '1.0.0' }, 'node_modules/b/lib/x.js': 'b code', 'node_modules/b/lib/y.js': 'b y' });
  fs.mkdirSync(J(root, 'out'));
  fs.copyFileSync(J(root, 'node_modules/a/x.js'), J(root, 'out/x.js'));
  fs.cpSync(J(root, 'node_modules/b/lib'), J(root, 'out'), { recursive: true });
  assert.equal(copies.sourceOf(J(root, 'out/x.js')), J(root, 'node_modules/b/lib/x.js'));
  // copied to a path through a symbolic link, bundled by its real path
  fs.mkdirSync(J(root, 'real'));
  fs.symlinkSync(J(root, 'real'), J(root, 'link'));
  fs.copyFileSync(J(root, 'node_modules/b/lib/y.js'), J(root, 'link/y.js'));
  fs.cpSync(J(root, 'node_modules/a'), J(root, 'link/a-copy'), { recursive: true });
  assert.equal(copies.sourceOf(J(root, 'real/y.js')), J(root, 'node_modules/b/lib/y.js'));
  assert.equal(copies.sourceOf(J(root, 'link/y.js')), J(root, 'node_modules/b/lib/y.js'));
  assert.equal(copies.sourceOf(J(root, 'real/a-copy/x.js')), J(root, 'node_modules/a/x.js'));
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

test('config: BUNDLE_LOCKFILE_DEBUG is on with 1, true or on; off when unset, empty (also only spaces), 0, false, off or not recognized', () => {
  const script = `require(${JSON.stringify(J(SRC, 'core/config.cjs'))}).debug('on');`;
  for (const [value, on] of [[undefined, false], ['', false], ['  ', false], ['0', false], ['false', false], ['FALSE', false], ['off', false],
    ['1', true], ['true', true], [' ON ', true], ['yes', false]]) {
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
  for (const a of [webpackAdapter, require('../src/adapters/rollup.cjs')]) a.onCjsLoad(exp, './b', () => J(root, 'b.js'));
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
    outputs.rewrite(t, writeFile).then(() => outputs.rewrite(t, writeFile));`;
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

test('lockfile: a context reached through a symlink is recorded as given, and read back as the real one', { skip: process.platform === 'win32' }, () => {
  const { readMeta } = require('../src/core/lockfile.cjs');
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
  const { readMeta } = require('../src/core/lockfile.cjs');
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
  const { readMeta } = require('../src/core/lockfile.cjs');
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
    outputCount: undefined, contents: { [J('/d/dist/a.js')]: [pa] }, pkgs: [pa] }]);
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

test('lock: a lock another process holds is waited for, then skipped with a warning; a stale one is taken over at once', async () => {
  const { lock } = require('../src/core/lock.cjs');
  const root = project({});
  const file = J(root, 'dist/l.json'), l = `${file}.lock`;
  fs.mkdirSync(J(root, 'dist'));
  fs.writeFileSync(l, 'held'); // fresh: another process holds it
  let release, took = Date.now();
  const warned = await warningsOf(async () => { release = await lock(file, { wait: 300 }); });
  took = Date.now() - took;
  assert.ok(took >= 300 && took < 5000, `waited ${took} ms`);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /could not lock .* writing it without the lock/);
  release();
  assert.equal(fs.readFileSync(l, 'utf8'), 'held', 'the other process\'s lock is not released by this one');
  // older than staleAfter: from a process that died, taken over without waiting
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(l, old, old);
  took = Date.now();
  assert.deepEqual(await warningsOf(async () => { release = await lock(file); }), []);
  assert.ok(Date.now() - took < 5000);
  assert.notEqual(fs.readFileSync(l, 'utf8'), 'held');
  release();
  assert.deepEqual(fs.readdirSync(J(root, 'dist')), [], 'released: nothing left behind');
});

test('lock: while another process holds it, the event loop runs on (a dev server, other compilers)', async () => {
  const { lock } = require('../src/core/lock.cjs');
  const root = project({ 'dist/l.json.lock': 'held' });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const warned = await warningsOf(async () => { (await lock(J(root, 'dist/l.json'), { wait: 300 }))(); });
    assert.equal(warned.length, 1); // skipped after the wait
  } finally { clearInterval(timer); }
  assert.ok(ticks >= 10, `the timer ran ${ticks} times in 300 ms`);
});

test('outputs: land() drops the writers whose files are gone, writes the lockfile, and makes a failed write a problem', async () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/b/package.json': { name: 'b', version: '1.0.0' } });
  const target = J(root, 'dist', LOCK);
  const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]), [b] = packagesForFiles([J(root, 'node_modules/b/i.js')]);
  outputs.record(target, 'gone', [b], root, [J(root, 'dist/gone.js')]); outputs.emitted(target, 'gone');
  outputs.record(target, 'land', [a], root, [J(root, 'dist/a.js')]);
  let written = null;
  await outputs.land(target, 'land', 'test', { writeFile: (json) => { written = json; } });
  assert.deepEqual(lockedNames(written), ['a']); // gone.js is not there: its writer is dropped
  const taken = await warningsOf(() => outputs.land(target, 'land', 'test', { writeFile: () => { throw new Error('EROFS'); } }));
  assert.equal(taken.length, 1);
  assert.match(taken[0], /^test: could not write .*package-lock\.json: Error: EROFS$/);
});

test('lock: two processes never hold it at the same time', async () => {
  const root = project({});
  const file = J(root, 'l.json');
  // each process takes the lock, notes when it holds it, keeps it 300 ms, notes the release, releases it
  const holder = `const fs = require('fs');
    const log = (what) => fs.appendFileSync(${JSON.stringify(J(root, 'log'))}, process.argv[2] + ' ' + what + '\\n');
    require(${JSON.stringify(J(SRC, 'core/lock.cjs'))}).lock(${JSON.stringify(file)}).then((release) => {
      log('in'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); log('out'); release();
    });`;
  fs.writeFileSync(J(root, 'holder.cjs'), holder);
  const run = (name) => new Promise((resolve) => require('child_process').spawn(process.execPath, [J(root, 'holder.cjs'), name], { stdio: 'inherit' }).on('exit', resolve));
  assert.deepEqual(await Promise.all(['a', 'b', 'c'].map(run)), [0, 0, 0]);
  const log = fs.readFileSync(J(root, 'log'), 'utf8').trim().split('\n').map(l => l.split(' '));
  assert.equal(log.length, 6);
  for (let i = 0; i < 6; i += 2) { // in, out of the same process, one after another
    assert.deepEqual([log[i][1], log[i + 1][1]], ['in', 'out'], JSON.stringify(log));
    assert.equal(log[i][0], log[i + 1][0], JSON.stringify(log));
  }
});

test('lockfile: a writer\'s record has at most 20 of its files and 500 output hashes (and their counts)', () => {
  const { readMeta } = require('../src/core/lockfile.cjs');
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
  const rollupAdapter = require('../src/adapters/rollup.cjs');
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

test('hooks: the ESM hook mode - forced (any case), or by Node version and process', () => {
  const hooks = require('../src/hooks.cjs');
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

test('lock: a stale lock is taken over only if it is still the stale one', () => {
  const { takeStale } = require('../src/core/lock.cjs');
  const root = project({ 'stale.lock': '' });
  const l = J(root, 'stale.lock');
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(l, old, old);
  // another process took the stale lock over and holds a new one by now: it stays
  const st = fs.statSync(l);
  fs.unlinkSync(l); fs.writeFileSync(l, 'fresh');
  takeStale(l, st);
  assert.equal(fs.readFileSync(l, 'utf8'), 'fresh');
  // still the stale one: removed
  fs.utimesSync(l, old, old);
  takeStale(l, fs.statSync(l));
  assert.equal(fs.existsSync(l), false);
  assert.deepEqual(fs.readdirSync(root), [], 'nothing left behind');
  takeStale(l, st); // already gone: nothing to do
  // another process is taking over (its .takeover): left to it; a takeover of a process that died during it is removed
  fs.writeFileSync(l, ''); fs.utimesSync(l, old, old);
  fs.writeFileSync(`${l}.takeover`, '');
  assert.equal(takeStale(l, fs.statSync(l)), false);
  assert.ok(fs.existsSync(l));
  fs.utimesSync(`${l}.takeover`, old, old);
  assert.equal(takeStale(l, fs.statSync(l)), false); // (the old takeover removed)
  assert.equal(takeStale(l, fs.statSync(l)), true);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('lock: a lock of a process of this machine that is gone is taken at once; one of a live process is waited for', async () => {
  const { lock } = require('../src/core/lock.cjs');
  const root = project({});
  const file = J(root, 'package-lock.json'), l = `${file}.lock`;
  const ns = (() => { try { return fs.readlinkSync('/proc/self/ns/pid'); } catch { return ''; } })();
  const gone = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  // a build killed while it wrote: its fresh lock names it
  fs.writeFileSync(l, JSON.stringify({ host: os.hostname(), ns, pid: Number(gone) }));
  problems.take();
  const t0 = Date.now();
  const release = await lock(file, { wait: 5000 });
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  assert.equal(JSON.parse(fs.readFileSync(l, 'utf8')).pid, process.pid);
  release();
  assert.equal(fs.existsSync(l), false);
  // a live process's (this machine's, or another machine's that looks gone here): waited for, until the wait is over
  const parent = process.ppid;
  for (const holder of [{ host: os.hostname(), ns, pid: parent }, { host: `not-${os.hostname()}`, ns, pid: Number(gone) }]) {
    fs.writeFileSync(l, JSON.stringify(holder));
    const warned = await warningsOf(async () => { (await lock(file, { wait: 300 }))(); });
    assert.match(warned.join('\n'), /could not lock .* writing it without the lock/, JSON.stringify(holder));
    assert.ok(fs.existsSync(l));
    fs.unlinkSync(l);
  }
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

// Copies of a lockfile: its record's paths to the project ("context", the packages' locations) are relative to where
// it was written. A reader tells a copy from the lockfile by "self"; a package's path is the package only while its
// package.json there has its name and version; lockfiles copied with fs in this process are re-anchored and followed.
const nameVersions = (json) => entries(json).map(([k, p]) => `${k} = ${p.name}@${p.version}`);
const recordOf = (json) => JSON.parse(json)['bundle-lockfile'];
// as SvelteKit's adapters do: the output in .svelte-kit/output/client copied to build/ (another depth)
function svelteProject() {
  const root = project({ 'node_modules/kit/package.json': { name: 'kit', version: '2.0.0' }, 'node_modules/esm/package.json': { name: 'esm', version: '1.0.0' } });
  const [kit, esm] = ['kit', 'esm'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const orig = J(root, '.svelte-kit/output/client'), build = J(root, 'build');
  const json = toPackageLock([kit, esm], root, { dir: J(orig, 'bundle-lockfile'), writers: [{ id: 'vite', files: [J(orig, '_app/x.js')], paths: [kit.path, esm.path] }] });
  for (const d of [orig, build]) {
    fs.mkdirSync(J(d, 'bundle-lockfile'), { recursive: true });
    fs.mkdirSync(J(d, '_app'), { recursive: true });
    fs.writeFileSync(J(d, LOCK), json); // a copy made without fs's copy functions (cp, rsync): the same bytes
    fs.writeFileSync(J(d, '_app/x.js'), 'x');
  }
  return { root, kit, esm, orig, build, json };
}

test('copies of lockfiles: "self" tells the lockfile from a copy at another depth or in another directory', () => {
  const { readMeta } = require('../src/core/lockfile.cjs');
  const { root, kit, orig, build, json } = svelteProject();
  assert.equal(recordOf(json).self, '.svelte-kit/output/client/bundle-lockfile');
  const here = readMeta(json, J(orig, 'bundle-lockfile'));
  assert.equal(here.anchored, true);
  assert.equal(here.writers[0].pkgs.find(p => p.name === 'kit').path, kit.path);
  // the copy: its context would be two directories above the project
  const copy = readMeta(json, J(build, 'bundle-lockfile'));
  assert.equal(copy.anchored, false);
  assert.deepEqual(copy.writers[0].pkgs.map(p => [p.name, p.unknown, p.path]).sort(),
    [['esm', true, '\0unknown:esm@1.0.0'], ['kit', true, '\0unknown:kit@2.0.0']]);
  assert.deepEqual(copy.writers[0].files, [J(build, '_app/x.js')]); // paths in the output: where they are in the copy
  // a copy at the same depth: its context is the project, but it is not written there
  fs.mkdirSync(J(root, '.svelte-kit/output/other/bundle-lockfile'), { recursive: true });
  assert.equal(readMeta(json, J(root, '.svelte-kit/output/other/bundle-lockfile')).anchored, false);
  // the whole project somewhere else (another checkout path): written there, relative to it
  const moved = `${root}-moved`;
  fs.cpSync(root, moved, { recursive: true });
  assert.equal(readMeta(json, J(moved, '.svelte-kit/output/client/bundle-lockfile')).anchored, true);
  // written by v0.0.3 and before: no "self"
  const old = JSON.stringify({ ...JSON.parse(json), 'bundle-lockfile': { ...recordOf(json), self: undefined } });
  assert.equal(readMeta(old, J(build, 'bundle-lockfile')).anchored, null);
});

test('copies of lockfiles: writing into a directory with a copy - one entry per package, the context is the project', async () => {
  const { root, kit, build } = svelteProject();
  const target = J(build, LOCK);
  const writeFile = (json) => { fs.writeFileSync(target, json); };
  // a later build writes build/ too (another writer: the copy's files are there, so its packages stay)
  outputs.record(target, 'later', [kit], root, [J(build, 'later.js')], { disk: true });
  fs.writeFileSync(J(build, 'later.js'), '');
  outputs.emitted(target, 'later');
  await outputs.rewrite(target, writeFile);
  const json = fs.readFileSync(target, 'utf8');
  // kit from the copy is this build's kit; esm, only in the copy, keeps its name and version, location unknown
  assert.deepEqual(nameVersions(json), ['node_modules/esm = esm@1.0.0', 'node_modules/kit = kit@2.0.0']);
  const m = recordOf(json);
  assert.equal(m.context, '../..'); // the project, not the copy's context (two directories above it)
  assert.equal(m.self, 'build/bundle-lockfile');
  assert.deepEqual(m.unknown, ['node_modules/esm']);
  assert.equal(m.locations, undefined);
  // written again (watch mode, the other writer): the same bytes
  await outputs.rewrite(target, writeFile);
  assert.equal(fs.readFileSync(target, 'utf8'), json);
});

test('copies of lockfiles: a bundled file of a copied output brings its packages by name and version', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('inner'), ...pj('outer') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'island/dist'), chunks: [{ fileName: 'main.js', code: 'island code', modules: [J(root, 'node_modules/inner/i.js')] }] });
    // the island's output copied into the app's source with cp (no fs copy this process sees: the original bytes),
    // to widget/dist (its record says so) and to vendor/island/dist (as if the project had moved to src/vendor/: the
    // record's packages are not where it says)
    for (const d of ['src/widget/dist', 'src/vendor/island/dist']) {
      fs.cpSync(J(root, 'island/dist'), J(root, d), { recursive: true });
      fs.writeFileSync(J(root, d, LOCK), fs.readFileSync(J(root, 'island/dist', LOCK)));
    }
    assert.equal(packages.packagesOfFiles([J(root, 'src/widget/dist/main.js')]).all[0].unknown, true);
    for (const d of ['src/widget/dist', 'src/vendor/island/dist']) {
      const target = J(root, 'dist', d.split('/')[1], LOCK);
      const { all } = packages.packagesOfFiles([J(root, d, 'main.js'), J(root, 'node_modules/outer/i.js')]);
      outputs.record(target, 'app', all, root, [], { disk: true });
      outputs.emitted(target, 'app');
      await outputs.rewrite(target, outputs.writeDisk(target));
      const json = fs.readFileSync(target, 'utf8');
      assert.deepEqual(nameVersions(json), ['node_modules/inner = inner@1.0.0', 'node_modules/outer = outer@1.0.0'], d);
      assert.deepEqual(recordOf(json).unknown, ['node_modules/inner'], d);
      assert.equal(recordOf(json).locations, undefined, d);
    }
  } finally { process.chdir(cwd); }
});

test('copies of lockfiles: a package upgraded in place between two builds of one directory - both versions listed', async () => {
  const root = project({ 'node_modules/x/package.json': { name: 'x', version: '1.0.0' } });
  const target = J(root, 'dist', LOCK);
  const writeFile = (json) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, json); };
  const [x1] = packagesForFiles([J(root, 'node_modules/x/i.js')]);
  outputs.record(target, 'app', [x1], root, [J(root, 'dist/app.js')], { disk: true });
  outputs.emitted(target, 'app');
  // npm install during the watch session: x@2 in the same directory; the other writer's build has it, app.js still x@1
  fs.writeFileSync(J(root, 'node_modules/x/package.json'), JSON.stringify({ name: 'x', version: '2.0.0' }));
  const [x2] = packagesForFiles([J(root, 'node_modules/x/i.js')]);
  outputs.record(target, 'sw', [x2], root, [J(root, 'dist/sw.js')], { disk: true });
  outputs.emitted(target, 'sw');
  await outputs.rewrite(target, writeFile);
  assert.deepEqual(nameVersions(fs.readFileSync(target, 'utf8')), ['node_modules/x@1.0.0 = x@1.0.0', 'node_modules/x = x@2.0.0']);
  // another process with x@2 reads that lockfile: still both, the same bytes
  const { readMeta } = require('../src/core/lockfile.cjs');
  const json = fs.readFileSync(target, 'utf8');
  const read = readMeta(json, path.dirname(target)).writers;
  const all = read.flatMap(w => w.pkgs);
  assert.deepEqual(all.map(p => `${p.name}@${p.version}${p.unknown ? ' (unknown)' : ''}`).sort(), ['x@1.0.0 (unknown)', 'x@2.0.0']);
});

test('copies of lockfiles: a package no longer where another process recorded it (reinstalled, removed) is listed once', async () => {
  const root = project({ 'node_modules/.pnpm/a@1.0.0_peer@1/node_modules/a/package.json': { name: 'a', version: '1.0.0' },
    'node_modules/.pnpm/gone@1.0.0/node_modules/gone/package.json': { name: 'gone', version: '1.0.0' }, 'dist/other.js': '' });
  const target = J(root, 'dist', LOCK);
  const writeFile = (json) => { fs.writeFileSync(target, json); };
  const [a, gone] = packagesForFiles([J(root, 'node_modules/.pnpm/a@1.0.0_peer@1/node_modules/a/i.js'), J(root, 'node_modules/.pnpm/gone@1.0.0/node_modules/gone/i.js')]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, toPackageLock([a, gone], root, { dir: path.dirname(target), writers: [{ id: 'other', files: [J(root, 'dist/other.js')], paths: [a.path, gone.path] }] }));
  // pnpm install again: another peer suffix, the old directory gone; gone@1.0.0 removed
  fs.renameSync(J(root, 'node_modules/.pnpm/a@1.0.0_peer@1'), J(root, 'node_modules/.pnpm/a@1.0.0_peer@2'));
  fs.rmSync(J(root, 'node_modules/.pnpm/gone@1.0.0'), { recursive: true });
  const [a2] = packagesForFiles([J(root, 'node_modules/.pnpm/a@1.0.0_peer@2/node_modules/a/i.js')]);
  outputs.record(target, 'mine', [a2], root, [J(root, 'dist/mine.js')], { disk: true });
  fs.writeFileSync(J(root, 'dist/mine.js'), '');
  outputs.emitted(target, 'mine');
  await outputs.rewrite(target, writeFile);
  const json = fs.readFileSync(target, 'utf8');
  assert.deepEqual(nameVersions(json), ['node_modules/.pnpm/a@1.0.0_peer@2/node_modules/a = a@1.0.0', 'node_modules/gone = gone@1.0.0']);
  assert.deepEqual(recordOf(json).unknown, ['node_modules/gone']);
});

test('copies of lockfiles: unknown packages give the same bytes whichever process writes last', () => {
  const { readMeta } = require('../src/core/lockfile.cjs');
  const root = project({ 'node_modules/x/package.json': { name: 'x', version: '1.0.0' } });
  const dir = J(root, 'dist/bundle-lockfile');
  const [x] = packagesForFiles([J(root, 'node_modules/x/i.js')]);
  const xUnknown = { ...x, path: '\0unknown:x@1.0.0', unknown: true };
  // process A only knows x from a copy (location unknown), process B has it in node_modules; each writes in turn,
  // with its own build and the other's record
  const write = (own, prev) => {
    const theirs = prev ? readMeta(prev, dir).writers.filter(w => w.id !== own.id) : [];
    const pkgs = [...own.pkgs, ...theirs.flatMap(w => w.pkgs)];
    const byPath = new Map(pkgs.map(p => [p.path, p]));
    return toPackageLock([...byPath.values()], root, { dir, writers: [{ id: own.id, files: [], paths: own.pkgs.map(p => p.path) },
      ...theirs.map(w => ({ id: w.id, files: [], paths: w.pkgs.map(p => p.path) }))] });
  };
  const A = { id: 'a', pkgs: [xUnknown] }, B = { id: 'b', pkgs: [x] };
  const a1 = write(A, null), b1 = write(B, a1), a2 = write(A, b1), b2 = write(B, a2);
  assert.deepEqual(nameVersions(a1), ['node_modules/x = x@1.0.0']);
  assert.deepEqual(recordOf(a1).unknown, ['node_modules/x']);
  for (const json of [b1, a2, b2]) assert.equal(json, b1);
  assert.equal(recordOf(b1).unknown, undefined);
});

test('outputs: another record in the output keeps no writer without files, and does not change this build\'s packages', async () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0', license: 'MIT' }, 'node_modules/b/package.json': { name: 'b', version: '1.0.0' } });
  const dist = J(root, 'dist'), target = J(dist, LOCK);
  const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]), [b] = packagesForFiles([J(root, 'node_modules/b/i.js')]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(J(dist, 'other.js'), '');
  // on disk before the build (another process's, or put there by hand): a writer with no files, which has nothing in
  // the output, and one whose file is there, with this build's package under another license
  fs.writeFileSync(target, toPackageLock([b, { ...a, license: 'Unlicensed' }], root, { dir: path.dirname(target),
    writers: [{ id: 'empty', files: [], paths: [b.path] }, { id: 'other', files: [J(dist, 'other.js')], paths: [a.path] }] }));
  outputs.record(target, 'mine', [a], root, [J(dist, 'main.js')], { disk: true });
  fs.writeFileSync(J(dist, 'main.js'), '');
  outputs.emitted(target, 'mine');
  await outputs.rewrite(target, (j) => { fs.writeFileSync(target, j); });
  const out = fs.readFileSync(target, 'utf8');
  assert.deepEqual(nameVersions(out), ['node_modules/a = a@1.0.0']);
  assert.equal(JSON.parse(out).packages['node_modules/a'].license, 'MIT'); // the package.json this process read
  assert.deepEqual(recordOf(out).writers.map(w => w.id).filter(id => id === 'empty' || id === 'other'), ['other']);
});

test('copies of lockfiles: a record without "self" none of whose packages is there gives no context', async () => {
  const { root, kit, build, json } = svelteProject();
  const target = J(build, LOCK);
  fs.writeFileSync(target, JSON.stringify({ ...JSON.parse(json), 'bundle-lockfile': { ...recordOf(json), self: undefined } })); // v0.0.3's copy
  outputs.record(target, 'later', [kit], root, [J(build, 'later.js')], { disk: true });
  fs.writeFileSync(J(build, 'later.js'), '');
  outputs.emitted(target, 'later');
  await outputs.rewrite(target, (j) => { fs.writeFileSync(target, j); });
  const out = fs.readFileSync(target, 'utf8');
  assert.equal(recordOf(out).context, '../..');
  assert.deepEqual(nameVersions(out), ['node_modules/esm = esm@1.0.0', 'node_modules/kit = kit@2.0.0']);
});

test('copies of lockfiles: copied with fs in this process - re-anchored where they are, followed while unchanged', async () => {
  const { readMeta } = require('../src/core/lockfile.cjs');
  const copies = require('../src/core/copies.cjs');
  copies.install();
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), 'other/package-lock.json': '{"lockfileVersion":3,"packages":{}}' });
  const [a, b] = ['a', 'b'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const target = J(root, '.svelte-kit/output/client', LOCK);
  const write = () => outputs.rewrite(target, outputs.writeDisk(target));
  outputs.record(target, 'client', [a], root, [J(root, '.svelte-kit/output/client/x.js')], { disk: true });
  outputs.emitted(target, 'client');
  await write();
  const valid = (file) => {
    const meta = readMeta(fs.readFileSync(file, 'utf8'), path.dirname(file));
    return meta.anchored === true && meta.writers[0].pkgs.every(p => !p.unknown && fs.existsSync(J(p.path, 'package.json')));
  };
  // SvelteKit's copy(): fs.copyFileSync, file by file; and the other copy functions
  const to = (d) => J(root, d, LOCK);
  for (const d of ['build', 'callback/x', 'promise', 'dir/a/b']) fs.mkdirSync(path.dirname(to(d)), { recursive: true });
  fs.copyFileSync(target, to('build'));
  // the copy is re-anchored before the copy's callback runs
  assert.equal(await new Promise((res, rej) => fs.copyFile(target, to('callback/x'), (e) => (e ? rej(e) : res(valid(to('callback/x')))))), true);
  await fs.promises.copyFile(target, to('promise'));
  fs.cpSync(J(root, '.svelte-kit/output'), J(root, 'dir/a/b'), { recursive: true }); // a directory with the lockfile in client/
  const copiesOf = ['build', 'callback/x', 'promise', 'dir/a/b/client'].map(to);
  for (const f of copiesOf) assert.equal(valid(f), true, f);
  assert.equal(recordOf(fs.readFileSync(to('build'), 'utf8')).context, '../..');
  // a copy of a copy: re-anchored too
  fs.mkdirSync(J(root, 'deep/er/bundle-lockfile'), { recursive: true });
  fs.copyFileSync(to('build'), J(root, 'deep/er', LOCK));
  assert.equal(valid(J(root, 'deep/er', LOCK)), true);
  // another package-lock.json: copied as it is
  fs.copyFileSync(J(root, 'other/package-lock.json'), J(root, 'other/copy.json'));
  fs.mkdirSync(J(root, 'other2'), { recursive: true });
  fs.copyFileSync(J(root, 'other/package-lock.json'), J(root, 'other2/package-lock.json'));
  assert.equal(fs.readFileSync(J(root, 'other2/package-lock.json'), 'utf8'), '{"lockfileVersion":3,"packages":{}}');
  // the lockfile written again after the copies (files written after the build): the copies get the new packages,
  // except one changed since it was copied
  fs.appendFileSync(to('promise'), ' ');
  outputs.record(target, 'client', [a, b], root, [J(root, '.svelte-kit/output/client/x.js')], { disk: true });
  outputs.emitted(target, 'client');
  await write();
  for (const f of [...copiesOf.filter(c => c !== to('promise')), J(root, 'deep/er', LOCK)]) {
    assert.deepEqual(lockedNames(fs.readFileSync(f, 'utf8')), ['a', 'b'], f);
    assert.equal(valid(f), true, f);
  }
  assert.deepEqual(lockedNames(fs.readFileSync(to('promise'), 'utf8')), ['a']);
  // a copy removed since (its directory cleaned): no longer followed, without a warning
  fs.rmSync(J(root, 'build'), { recursive: true });
  outputs.record(target, 'client', [a], root, [J(root, '.svelte-kit/output/client/x.js')], { disk: true });
  outputs.emitted(target, 'client');
  assert.deepEqual(await (async () => { const seen = []; const orig = config.warn; config.warn = (...m) => seen.push(m.join(' '));
    try { await write(); } finally { config.warn = orig; } return seen; })(), []);
  assert.equal(fs.existsSync(to('build')), false);
});

test('copies of outputs: an output\'s files copied with fs elsewhere without the lockfile get a copy of it (Nitro\'s public assets), followed', async () => {
  const { readMeta } = require('../src/core/lockfile.cjs');
  const copies = require('../src/core/copies.cjs');
  copies.install();
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), '.nuxt/dist/client/_nuxt/e.js': 'e', '.nuxt/dist/client/_nuxt/f.css': 'f', '.nuxt/dist/client/notes.txt': 'n',
    'dist2/x.js': 'x' });
  const [a, b] = ['a', 'b'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const client = J(root, '.nuxt/dist/client'), target = J(client, LOCK);
  const files = [J(client, '_nuxt/e.js'), J(client, '_nuxt/f.css')];
  const write = () => outputs.rewrite(target, outputs.writeDisk(target));
  outputs.record(target, 'nuxt-client', [a], root, files, { disk: true });
  outputs.emitted(target, 'nuxt-client');
  // another output: nothing is copied into it, and nothing next to it
  const other = J(root, 'dist2', LOCK);
  outputs.record(other, 'other', [b], root, [J(root, 'dist2/x.js')], { disk: true });
  outputs.emitted(other, 'other');
  // a copy before the lockfile is written: the copy gets it when it is
  fs.mkdirSync(J(root, 'early/_nuxt'), { recursive: true });
  fs.copyFileSync(files[0], J(root, 'early/_nuxt/e.js'));
  assert.equal(fs.existsSync(J(root, 'early', LOCK)), false);
  await write();
  await outputs.rewrite(other, outputs.writeDisk(other));
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'early', LOCK), 'utf8')), ['a']);
  const valid = (file) => {
    const meta = readMeta(fs.readFileSync(file, 'utf8'), path.dirname(file));
    return meta.anchored === true && meta.writers[0].pkgs.every(p => !p.unknown && fs.existsSync(J(p.path, 'package.json')));
  };
  // Nitro: fs.promises.cp of each file of .nuxt/dist/client/_nuxt into .output/public/_nuxt
  for (const f of files) await fs.promises.cp(f, J(root, '.output/public/_nuxt', path.basename(f)));
  assert.equal(valid(J(root, '.output/public', LOCK)), true);
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, '.output/public', LOCK), 'utf8')), ['a']);
  // a directory of the output: the same
  fs.cpSync(J(client, '_nuxt'), J(root, 'pub2/_nuxt'), { recursive: true });
  assert.equal(valid(J(root, 'pub2', LOCK)), true);
  // not: a file of the output directory no writer emits, a copy into another output, a copy up into the project (the
  // place would contain the outputs), a copy below node_modules
  fs.mkdirSync(J(root, 'pub3'), { recursive: true });
  fs.copyFileSync(J(client, 'notes.txt'), J(root, 'pub3/notes.txt'));
  fs.mkdirSync(J(root, 'dist2/_nuxt'), { recursive: true });
  fs.copyFileSync(files[0], J(root, 'dist2/_nuxt/e.js'));
  fs.copyFileSync(files[0], J(root, 'top.js'));
  fs.mkdirSync(J(root, 'node_modules/c/_nuxt'), { recursive: true });
  fs.copyFileSync(files[0], J(root, 'node_modules/c/_nuxt/e.js'));
  for (const d of ['pub3', 'dist2/_nuxt', '.', '..', 'node_modules/c']) assert.equal(fs.existsSync(J(root, d, LOCK)), false, d);
  assert.deepEqual(lockedNames(fs.readFileSync(other, 'utf8')), ['b']);
  // the lockfile written again: the copies follow
  outputs.record(target, 'nuxt-client', [a, b], root, files, { disk: true });
  outputs.emitted(target, 'nuxt-client');
  await write();
  for (const d of ['.output/public', 'pub2', 'early']) assert.deepEqual(lockedNames(fs.readFileSync(J(root, d, LOCK), 'utf8')), ['a', 'b'], d);
  // a destination not cleaned since an earlier run: the copy that run left there is replaced; another build's lockfile not
  const idOf = (w) => crypto.createHash('sha256').update(w).digest('hex').slice(0, 16);
  for (const [d, id] of [['old', idOf('nuxt-client')], ['theirs', 'another-build']]) {
    fs.mkdirSync(J(root, d, 'bundle-lockfile'), { recursive: true });
    fs.writeFileSync(J(root, d, LOCK), toPackageLock([], root, { dir: J(root, d, 'bundle-lockfile'), writers: [{ id, files: [J(root, d, '_nuxt/e.js')], paths: [] }] }));
    fs.mkdirSync(J(root, d, '_nuxt'), { recursive: true });
    fs.copyFileSync(files[0], J(root, d, '_nuxt/e.js'));
  }
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'old', LOCK), 'utf8')), ['a', 'b']);
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'theirs', LOCK), 'utf8')), []);
  // with BUNDLE_LOCKFILE_INLINE=0: no lockfile in outputs, none in copies of them
  await withConfig({ inline: false }, async () => {
    fs.mkdirSync(J(root, 'pub4/_nuxt'), { recursive: true });
    fs.copyFileSync(files[0], J(root, 'pub4/_nuxt/e.js'));
    assert.equal(fs.existsSync(J(root, 'pub4', LOCK)), false);
  });
});

test('outputs: the export copy is written under its own lock also with the inline lockfile (a write without it locks only that one)', () => withConfig({ exportDir: null, exportBase: null }, async () => {
  const { lock } = require('../src/core/lock.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  config.exportDir = J(root, 'export');
  config.exportBase = root;
  const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]);
  const target = J(root, 'dist', LOCK);
  outputs.record(target, 'export-lock', [a], root, [J(root, 'dist/x.js')], { disk: true });
  outputs.emitted(target, 'export-lock');
  // (as Angular's write of the export copy, or one whose output directory is gone, holds it)
  const release = await lock(exportPath(target));
  let done = false;
  const write = outputs.rewrite(target, outputs.writeDisk(target)).then(() => { done = true; });
  await new Promise(res => setTimeout(res, 200));
  assert.equal(done, false);
  release();
  await write;
  assert.deepEqual(lockedNames(fs.readFileSync(exportPath(target), 'utf8')), ['a']);
}));

test('copies of lockfiles: an export copy copied with fs is re-anchored like its lockfile', () => withConfig({ exportDir: null }, async () => {
  const { readMeta } = require('../src/core/lockfile.cjs');
  const copies = require('../src/core/copies.cjs');
  copies.install();
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  config.exportDir = J(root, 'export');
  config.exportBase = root;
  try {
    const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]);
    const target = J(root, 'ui/dist', LOCK);
    outputs.record(target, 'ui', [a], root, [J(root, 'ui/dist/x.js')], { disk: true });
    outputs.emitted(target, 'ui');
    await outputs.rewrite(target, null); // export copy only
    const exp = exportPath(target);
    assert.equal(fs.existsSync(target), false);
    fs.mkdirSync(J(root, 'pkg/usr/share/app/bundle-lockfile'), { recursive: true });
    fs.copyFileSync(exp, J(root, 'pkg/usr/share/app', LOCK));
    const meta = readMeta(fs.readFileSync(J(root, 'pkg/usr/share/app', LOCK), 'utf8'), J(root, 'pkg/usr/share/app/bundle-lockfile'));
    assert.equal(meta.anchored, true);
    assert.equal(meta.writers[0].pkgs[0].path, a.path);
  } finally { config.exportBase = null; }
}));

// Vendored packages (core/vendored.cjs): copies outside node_modules and inside packages, package roots without a
// package.json, and the first-party boundaries.
test('vendored: which package.json is a copy of an npm package', () => {
  const { isVendorable } = require('../src/core/vendored.cjs');
  const yes = [{ name: 'left-pad', version: '1.3.0' }, { name: '@scope/x', version: '1.0.0' }, { name: 'JSONStream', version: '1.3.5' }, // a legacy name
    { name: 'vscode-languageclient', version: '10.1.2', engines: { vscode: '^1.91.0' } }]; // a library for extensions: no publisher
  const no = [{ name: 'x' }, { version: '1.0.0' }, { name: 'x', version: '1.0.0', private: true }, { name: 'GitLab Web IDE', version: '1.94.0' },
    { name: 'yaml', version: '1.0.0', publisher: 'vscode', engines: { vscode: '*' } }, { name: 'a'.repeat(215), version: '1.0.0' }, null];
  for (const j of yes) assert.equal(isVendorable(j), true, JSON.stringify(j));
  for (const j of no) assert.equal(isVendorable(j), false, JSON.stringify(j));
});

test('vendored: workspace patterns, pnpm-workspace.yaml, rush.json', () => {
  const { globTest, pnpmPackages, parseJsonc } = require('../src/core/vendored.cjs');
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
  const { scope } = require('../src/core/vendored.cjs');
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
  const { isVendorable } = require('../src/core/vendored.cjs');
  for (const [name, [, , j]] of Object.entries(nested)) assert.equal(isVendorable(j), name === 'socket.io-client', JSON.stringify(j));
});

test('vendored: a bundled file another build produced is its output, no vendored copy', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
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

// strict: BUNDLE_LOCKFILE_STRICT unset (the default) - what would leave a lockfile missing or incomplete fails the build
// (core/problems.cjs). In this process config.strict is toggled with withConfig; child processes get the variable.

test('strict: BUNDLE_LOCKFILE_STRICT is on unless 0, false or off', () => {
  const read = (v) => nodeWith(strictEnv(v), ['-e', `console.log(require(${JSON.stringify(J(SRC, 'core/config.cjs'))}).strict)`]).stdout.trim();
  for (const v of [undefined, '', ' ', '1', 'true', 'on', 'yes']) assert.equal(read(v), 'true', JSON.stringify(v));
  for (const v of ['0', 'false', 'off', 'OFF', ' False ']) assert.equal(read(v), 'false', JSON.stringify(v));
});

test('strict: a problem is recorded for the build to fail; without strict mode it is a warning (once per key)', () => withConfig({ strict: false }, async () => {
  problems.take();
  const warned = warnings(() => {
    problems.problem('a', new Error('cause'));
    problems.problem('b', null, { once: 'k' });
    problems.problem('b', null, { once: 'k' });
  });
  assert.deepEqual(warned, ['a: Error: cause', 'b']);
  assert.equal(problems.pending(), false);
  assert.equal(problems.failIfAny(() => assert.fail('nothing to fail')), false);
  await withConfig({ strict: true }, () => {
    assert.deepEqual(warnings(() => { problems.problem('x', new Error('cause')); problems.problem('y', null, { once: 'k' }); problems.problem('y', null, { once: 'k' }); }), []);
    let failed = null;
    assert.equal(problems.failIfAny((e) => { failed = e; }), true);
    assert.equal(problems.isFailure(failed), true);
    assert.equal(problems.isFailure(new Error('x')), false);
    assert.deepEqual(failed.problems, ['x: cause', 'y', 'y']); // in strict mode every build with it fails
    assert.match(failed.message, /^bundle-lockfile: the lockfile would be missing or incomplete \(BUNDLE_LOCKFILE_STRICT=0 makes this a warning\):\n {2}x: cause\n {2}y\n {2}y$/);
    // no stack, only the first line and a newline: what the rollup command line strips off (else it prints the message twice)
    assert.equal(failed.stack, `Error: ${failed.message}\n`);
    assert.equal(problems.pending(), false); // taken: one build fails with them
  });
}));

test('strict: problems no build took make the process exit with 1 (also after process.exit(0)), and keep another exit code', () => {
  const P = JSON.stringify(J(SRC, 'core/problems.cjs'));
  const run = (tail) => nodeWith(strictEnv(undefined), ['-e', `require(${P}).problem('could not write x', new Error('EACCES')); ${tail}`]);
  for (const tail of ['', 'process.exit(0)', 'setTimeout(() => {}, 10)']) {
    const r = run(tail);
    assert.equal(r.status, 1, `${tail}: ${r.stderr}`);
    assert.match(r.stderr, /\[bundle-lockfile\] ERROR: could not write x: EACCES\n\[bundle-lockfile\] ERROR: the process fails because a lockfile would be missing or incomplete \(BUNDLE_LOCKFILE_STRICT=0 makes this a warning\)/);
  }
  assert.equal(run('process.exitCode = 3').status, 3);
  assert.equal(run(`require(${P}).take()`).status, 0); // a build took it (and failed with it)
  const off = nodeWith(strictEnv('0'), ['-e', `require(${P}).problem('could not write x')`]);
  assert.equal(off.status, 0);
  assert.match(off.stderr, /\[bundle-lockfile\] WARNING: could not write x/);
});

test('strict: a build fails with its own problems and those of no build, never with another build\'s', () => withConfig({ strict: true }, async () => {
  problems.take();
  const a = {}, b = {};
  const fails = (owner) => problems.within(owner, () => { let got = null; problems.failIfAny((err) => { got = err.problems; }); return got; });
  problems.within(a, () => problems.problem('a: one'));
  // also what a build's hook starts asynchronously
  await problems.within(a, () => new Promise(resolve => setImmediate(() => { problems.problem('a: later'); resolve(); })));
  problems.within(b, () => problems.problem('b: one'));
  problems.problem('none: one'); // outside any build (a module that could not be patched)
  assert.deepEqual(fails(b), ['b: one', 'none: one']);
  assert.deepEqual(fails(b), null);
  assert.deepEqual(fails(a), ['a: one', 'a: later']);
  // outside any build: all of them
  problems.within(a, () => problems.problem('a: two'));
  let all = null;
  problems.failIfAny((err) => { all = err.problems; });
  assert.deepEqual(all, ['a: two']);
  assert.equal(problems.pending(), false);
}));

test('strict: a module whose patching fails throws its own problems, not those a build recorded meanwhile', () => withConfig({ strict: true }, () => {
  problems.take();
  const { loading } = require('../src/hooks.cjs');
  const b = {};
  problems.within(b, () => problems.problem('b: one'));
  assert.throws(() => loading(() => problems.problem('load: one')), (e) => problems.isFailure(e) && e.problems.join() === 'load: one');
  assert.equal(loading(() => 7), 7); // nothing recorded: what fn returns
  assert.deepEqual(problems.takeOwn(b), ['b: one']);
  assert.equal(problems.pending(), false);
}));

test('strict: nowhere to write (INLINE off, no export dir) and a lock that cannot be taken are problems of every build', () => withConfig({ strict: true }, async () => {
  problems.take();
  outputs.nowhere(); outputs.nowhere();
  assert.deepEqual(problems.take(), ['BUNDLE_LOCKFILE_INLINE is off and BUNDLE_LOCKFILE_EXPORT_DIR is not set: no lockfile is written',
    'BUNDLE_LOCKFILE_INLINE is off and BUNDLE_LOCKFILE_EXPORT_DIR is not set: no lockfile is written']);
  const { lock } = require('../src/core/lock.cjs');
  const root = project({ 'dist/l.json.lock': 'held' });
  const release = await lock(J(root, 'dist/l.json'), { wait: 100 });
  release();
  const [p, ...rest] = problems.take();
  assert.deepEqual(rest, []);
  assert.match(p, /^could not lock .*l\.json - writing it without the lock \(it may miss the packages of another process writing it at the same time\)$/);
}));

test('strict: a bundled package that cannot be listed fails every build; one listed as the package around it is a warning', () => withConfig({ strict: true }, () => {
  problems.take();
  const root = project({
    'node_modules/noversion/package.json': { name: 'noversion' },
    'node_modules/container/package.json': { name: 'container', version: '1.0.0' },
    'node_modules/container/lib/node_modules/flat/i.js': '',
  });
  for (let i = 0; i < 2; i++) {
    const warned = warnings(() => packagesForFiles([J(root, 'node_modules/noversion/i.js'), J(root, 'node_modules/container/lib/node_modules/flat/i.js')]));
    if (i === 0) { assert.equal(warned.length, 1); assert.match(warned[0], /flat - its bundled files are listed as container@1\.0\.0/); }
    else assert.deepEqual(warned, []); // the container's: once per process
    const taken = problems.take();
    assert.equal(taken.length, 1, `build ${i + 1}`);
    assert.match(taken[0], /no package\.json with name and version in .*noversion - its bundled files are not listed/);
  }
}));

test('strict: a package root that is not on disk (a module the input file system made up) is a warning; one inside an unreadable archive fails', () => withConfig({ strict: true }, () => {
  problems.take();
  // webpack-virtual-modules: node_modules/virtual-pkg/index.js only in memory, node_modules/ on disk
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/f.zip': 'an archive fs reads as a file' });
  const virtual = J(root, 'node_modules/virtual-pkg/index.js');
  for (let i = 0; i < 2; i++) {
    const warned = warnings(() => assert.deepEqual(packagesForFiles([virtual]), []));
    if (i === 0) { assert.equal(warned.length, 1); assert.match(warned[0], /virtual-pkg is not on disk: its bundled files are generated in memory/); }
    else assert.deepEqual(warned, []); // once per process
    assert.deepEqual(problems.take(), [], `build ${i + 1}`);
  }
  // a Yarn PnP archive path that fs cannot read in this process: a real package whose files would be missing
  assert.deepEqual(packagesForFiles([J(root, 'node_modules/f.zip/node_modules/f/index.js')]), []);
  const [p, ...rest] = problems.take();
  assert.deepEqual(rest, []);
  assert.match(p, /no package\.json with name and version in \S*f\.zip\/node_modules\/f - its bundled files are not listed/);
  // a package root that is there but has no usable package.json still fails (the existing rule)
  fs.mkdirSync(J(root, 'node_modules/empty'));
  assert.deepEqual(packagesForFiles([J(root, 'node_modules/empty/i.js')]), []);
  assert.equal(problems.take().length, 1);
}));

test('strict: a bundled package whose package.json cannot be parsed fails every build (BUNDLE_LOCKFILE_STRICT=0: a warning)', async () => {
  const root = project({ 'node_modules/broken/package.json': '{"name": "broken", "version": "1.0.0",' });
  const file = J(root, 'node_modules/broken/i.js');
  await withConfig({ strict: true }, () => {
    problems.take();
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(packagesForFiles([file]), []);
      const taken = problems.take();
      assert.equal(taken.length, 1, `build ${i + 1}`);
      assert.match(taken[0], /no package\.json with name and version in \S*broken - its bundled files are not listed/);
    }
  });
  await withConfig({ strict: false }, () => {
    problems.take();
    const warned = warnings(() => assert.deepEqual(packagesForFiles([file]), []));
    assert.equal(problems.take().length, 0);
    assert.match(warned.join('\n'), /broken - its bundled files are not listed/);
  });
});

test('strict: the webpack plugin fails the compilation when collecting or writing fails', async () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const build = async ({ webpackError, blockWrite, throwCollect }) => {
    const outputPath = J(root, `out-${webpackError}-${!!blockWrite}-${!!throwCollect}`);
    fs.mkdirSync(outputPath, { recursive: true });
    if (blockWrite) fs.writeFileSync(J(outputPath, 'bundle-lockfile'), 'a file where the directory must be');
    const { compiler, taps } = fakeCompiler5({ outputPath });
    Object.assign(compiler.outputFileSystem, { stat: fs.stat, lstat: fs.lstat });
    compiler.outputFileSystem.gracefulify = () => {}; // the real disk
    if (webpackError) compiler.webpack.WebpackError = class WebpackError extends Error {};
    new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
    const comp = compilation({ context: root, outputPath, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }], assets: { 'main.js': {} } });
    comp.compiler = compiler;
    comp.errors = [];
    comp.hooks = { afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) } };
    const orig = packages.packagesOfFiles;
    if (throwCollect) packages.packagesOfFiles = () => { throw new Error('injected'); };
    try {
      taps.thisCompilation(comp);
      comp.stage();
      fs.writeFileSync(J(outputPath, 'main.js'), '');
      await new Promise(resolve => taps.afterEmit(comp, resolve));
    } finally { packages.packagesOfFiles = orig; }
    return comp.errors;
  };
  await withConfig({ strict: true }, async () => {
    problems.take();
    assert.deepEqual(await build({}), []);
    for (const webpackError of [false, true]) {
      const [e, ...rest] = await build({ webpackError, throwCollect: true });
      assert.deepEqual(rest, []);
      assert.equal(e.constructor.name, webpackError ? 'WebpackError' : 'Error');
      if (webpackError) assert.equal(e.hideStack, true);
      assert.match(e.stack, /^Error: bundle-lockfile: the lockfile would be missing or incomplete/);
      assert.match(e.message, /webpack: could not collect the packages of .*: injected/);
    }
    const [w] = await build({ blockWrite: true });
    assert.match(w.message, /webpack: could not write .*bundle-lockfile.package-lock\.json/);
    assert.equal(problems.pending(), false);
  });
  await withConfig({ strict: false }, async () => {
    let errors;
    const warned = warnings(() => { errors = build({ throwCollect: true }); });
    assert.deepEqual(await errors, []);
    assert.match(warned[0], /webpack: could not collect the packages of .*: Error: injected/);
  });
});

test('strict: a compiler the plugin cannot be applied to fails its compilations (or, if not even that, its compile())', async () => {
  for (const strict of [true, false]) {
    await withConfig({ strict }, () => {
      problems.take();
      const W = fakeCompiler();
      let compiled = 0;
      W.prototype.compile = function (cb) { compiled++; cb(null); };
      webpackAdapter.onCjsLoad(W, './Compiler', () => '/p/node_modules/webpack/lib/Compiler.js');
      // apply() throws at emit.tap; thisCompilation can be tapped: each compilation fails, watch mode keeps running
      const c = new W();
      c.outputPath = '/p/dist';
      const tapped = [];
      c.hooks = { thisCompilation: { tap: (n, fn) => tapped.push(fn) } };
      let got;
      warnings(() => c.compile((err) => { got = err; }));
      assert.equal(compiled, 1);
      assert.equal(got, null);
      const comp = { errors: [] };
      for (const fn of tapped) { try { fn(comp); } catch { /* the plugin's own taps on a fake compilation */ } }
      if (strict) assert.match(comp.errors.map(e => e.message).join(), /webpack: could not attach to the compiler of \/p\/dist/);
      else assert.deepEqual(comp.errors, []);
      // not even thisCompilation can be tapped: compile() calls back with the error instead of compiling
      const d = new W();
      d.outputPath = '/p/dist2';
      d.hooks = { thisCompilation: {} };
      got = undefined;
      warnings(() => d.compile((err) => { got = err; }));
      if (strict) { assert.equal(compiled, 1); assert.match(got.message, /webpack: could not attach to the compiler of \/p\/dist2/); }
      else { assert.equal(compiled, 2); assert.equal(got, null); }
      assert.equal(problems.pending(), false);
    });
  }
});

test('strict: the Rollup plugin fails the build when collecting or writing fails', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const cwd = process.cwd();
  process.chdir(root);
  const chunks = [{ fileName: 'main.js', code: 'main', modules: [J(root, 'node_modules/a/i.js')] }];
  const ctx = { error(e) { throw e; } };
  try {
    await withConfig({ strict: true }, async () => {
      problems.take();
      const orig = packages.packagesOfFiles;
      packages.packagesOfFiles = () => { throw new Error('injected'); };
      try {
        await assert.rejects(rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: J(root, 'dist-c'), chunks, ctx }),
          (e) => problems.isFailure(e) && /rollup: could not collect the bundled packages of .*dist-c: injected/.test(e.message));
      } finally { packages.packagesOfFiles = orig; }
      fs.mkdirSync(J(root, 'dist-w'));
      fs.writeFileSync(J(root, 'dist-w/bundle-lockfile'), 'a file where the directory must be');
      await assert.rejects(rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: J(root, 'dist-w'), chunks, ctx }),
        (e) => problems.isFailure(e) && /rollup: could not write .*dist-w.bundle-lockfile.package-lock\.json/.test(e.message));
      assert.equal(problems.pending(), false);
      // closeBundle: a problem there fails the build by a throw, except in watch mode, where a throw would crash
      // `vite build --watch`: printed then
      const rollupPlugin = rollupAdapter.bundleLockfile('rollup');
      problems.problem('late');
      await assert.rejects(rollupPlugin.closeBundle.handler.call({ meta: {} }), (e) => problems.isFailure(e) && /\n {2}late$/.test(e.message));
      problems.problem('late');
      const origError = config.error, printed = [];
      config.error = (...a) => printed.push(a.join(' '));
      try { await rollupPlugin.closeBundle.handler.call({ meta: { watchMode: true } }); } finally { config.error = origError; }
      assert.match(printed.join('\n'), /bundle-lockfile: the lockfile would be missing or incomplete[\s\S]*\n {2}late/);
      assert.equal(problems.pending(), false);
    });
    await withConfig({ strict: false }, async () => {
      fs.mkdirSync(J(root, 'dist-s'));
      fs.writeFileSync(J(root, 'dist-s/bundle-lockfile'), 'x');
      await rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: J(root, 'dist-s'), chunks, ctx }); // resolves, with a warning
    });
  } finally { process.chdir(cwd); }
});

test('strict: an adapter that throws while wrapping an ESM entry makes the entry fail to load, with the reason', () => {
  // (as the loader thread does: the bundler's import fails - also in a process or thread whose exit code nobody reads)
  const script = `const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
    process.env.BUNDLE_LOCKFILE_ESM_HOOKS = 'off';
    hooks.register({ name: 'boom', esmEntries: [{ id: 'x', suffixes: ['/x.js'], wrap: ['f'] }], esmWrap() { throw new Error('boom'); } });
    hooks.install();
    const f = () => 42;
    try { console.log(globalThis[Symbol.for('bundle-lockfile.esm')].wrap('x', 'f', f) === f); } catch (e) { console.log('failed:', e.message); }`;
  const r = nodeWith(strictEnv(undefined), ['-e', script]);
  assert.equal(r.status, 0, r.stderr); // (taken by the failed load)
  assert.match(r.stdout, /^failed: bundle-lockfile: the lockfile would be missing or incomplete .*\n {2}boom adapter failed to wrap x f: boom/);
});

test('strict: a bundler module an adapter cannot patch fails its require() with the reason (BUNDLE_LOCKFILE_STRICT=0: a warning)', () => {
  const root = project({ 'node_modules/webpack/lib/Compiler.js': 'module.exports = class Compiler { compile() {} };', // no run, watch, ...
    'node_modules/webpack/package.json': { name: 'webpack', version: '9.0.0' } });
  const script = `try { require(${JSON.stringify(J(root, 'node_modules/webpack/lib/Compiler.js'))}); console.log('loaded'); } catch (e) { console.log('failed:', e.message); }`;
  const run = (v) => nodeWith({ ...strictEnv(v), NODE_OPTIONS: '' }, ['--require', J(SRC, 'register.cjs'), '-e', script]);
  const strict = run(undefined);
  assert.equal(strict.status, 0, strict.stderr);
  assert.match(strict.stdout, /^failed: bundle-lockfile: the lockfile would be missing or incomplete .*\n {2}webpack: .*Compiler\.js has no Compiler bundle-lockfile knows \(compile, run, watch, newCompilation, isChild\): its builds would write no lockfile/);
  const off = run('0');
  assert.equal(off.stdout.trim(), 'loaded');
  assert.match(off.stderr, /WARNING: webpack: .*Compiler\.js has no Compiler bundle-lockfile knows/);
});

test('strict: ESM hooks that cannot be installed fail a bundler process, and only warn elsewhere', { skip: typeof require('module').registerHooks !== 'function' }, () => {
  const root = project({ 'package.json': { name: 'app', devDependencies: { vite: '8.0.0' } }, 'build.cjs': '', 'other/package.json': { name: 'other' }, 'other/x.cjs': '' });
  const script = (main) => `require('module').registerHooks = () => { throw new Error('no hooks'); };
    process.env.BUNDLE_LOCKFILE_ESM_HOOKS = 'sync'; process.argv[1] = ${JSON.stringify(main)};
    const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
    hooks.register({ name: 'v', esmEntries: [{ id: 'x', suffixes: ['/x.js'], wrap: ['f'] }], esmPackages: ['vite'] });
    hooks.install();`;
  const bundler = nodeWith(strictEnv(undefined), ['-e', script(J(root, 'build.cjs'))]);
  assert.equal(bundler.status, 1, bundler.stderr);
  assert.match(bundler.stderr, /\[bundle-lockfile\] ERROR: could not install the ESM hooks: no hooks/);
  const other = nodeWith(strictEnv(undefined), ['-e', script(J(root, 'other/x.cjs'))]);
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stderr, /\[bundle-lockfile\] WARNING: could not install the ESM hooks/);
  // module.register throws what broke Node's loader thread (another tool's loader or preload): the message says so
  const thread = (main) => `require('module').register = () => { throw new TypeError('this[#customizations].loadSync is not a function'); };
    process.env.BUNDLE_LOCKFILE_ESM_HOOKS = 'async'; process.argv[1] = ${JSON.stringify(main)};
    const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
    hooks.register({ name: 'v', esmEntries: [{ id: 'x', suffixes: ['/x.js'], wrap: ['f'] }], esmPackages: ['vite'] });
    hooks.install();`;
  const broken = nodeWith(strictEnv(undefined), ['-e', thread(J(root, 'build.cjs'))]);
  assert.equal(broken.status, 1, broken.stderr);
  assert.match(broken.stderr, /ERROR: could not install the ESM hooks: Node\.js's loader thread did not start \(a --loader or --import that fails there, or a --require preload that calls module\.registerHooks, breaks it\)[^\n]*\n?.*loadSync is not a function/s);
});

test('strict: the loader thread makes an entry it cannot wrap fail when it is imported', () => {
  // strict: what hooks.cjs passes (config.strict), not read again in the loader thread
  const loader = JSON.stringify(pathToFileURLHref(J(SRC, 'esm-loader.mjs')));
  const script = (data) => `const { initialize, load } = await import(${loader});
    initialize({ entries: [{ id: 'x', suffixes: null, wrap: ['f'] }]${data} }); // suffixes.some throws
    const r = await load('file:///p/x.js', {}, async () => ({ format: 'module', source: 'export const f = 1;' }));
    console.log(JSON.stringify(r));`;
  for (const data of ['', ', strict: true']) {
    const strict = JSON.parse(nodeWith(strictEnv('0'), ['--input-type=module', '-e', script(data)]).stdout);
    assert.equal(strict.format, 'module');
    assert.match(strict.source, /^throw new Error\("bundle-lockfile: could not wrap file:\/\/\/p\/x\.js: .* \(BUNDLE_LOCKFILE_STRICT=0 makes this a warning\)"\);/);
  }
  const off = JSON.parse(nodeWith(strictEnv(undefined), ['--input-type=module', '-e', script(', strict: false')]).stdout);
  assert.equal(off.source, 'export const f = 1;');
});

// rspack (src/adapters/rspack.cjs and the rspack parts of webpack-family.cjs)
const rspackAdapter = require('../src/adapters/rspack.cjs');
const RSPACK_PATCHED = Symbol.for('bundle-lockfile.rspack.patched');
const APPLIED_SYM = Symbol.for('bundle-lockfile.webpack.applied');
// the export of @rspack/core: the rspack() function with its classes; its Compiler has no newCompilation
function fakeRspack(rspackVersion) {
  class Compiler {
    compile(cb) { this.compiled = (this.compiled || 0) + 1; if (cb) cb(null); }
    run() {} watch() {} isChild() { return false; } runAsChild() {} createChildCompiler() {}
  }
  return Object.assign(function rspack() {}, { Compiler, Compilation: class {}, version: '5.75.0', rspackVersion });
}
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

test('webpack adapter: never applies itself to an rspack compiler (Next.js with next-rspack loads both)', () => {
  const W = fakeCompiler();
  webpackAdapter.onCjsLoad(W, './Compiler', () => '/p/node_modules/webpack/lib/Compiler.js');
  const c = new W();
  c.hooks = { thisCompilation: { tap() { throw new Error('tapped'); } } };
  c.webpack = { rspackVersion: '2.0.4' };
  c.compile();
  assert.equal(c[APPLIED_SYM], undefined);
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

test('esm-wrap: only ES modules are wrapped (rspack 1\'s CommonJS file at rspack 2\'s path goes on to cjsSource)', () => {
  const { transform, CJS_LOADED } = require('../src/esm-wrap.cjs');
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

test('strict: problems fail the process also when a listener of the build\'s code calls process.exit() in its exit listener', () => {
  // (the build's listener is added before the first problem; bundle-lockfile's is there from the preload on)
  const script = `const problems = require(${JSON.stringify(J(SRC, 'core/problems.cjs'))});
    process.on('exit', () => process.exit(0));
    problems.problem('a lockfile would be missing');`;
  const r = nodeWith(strictEnv(undefined), ['-e', script]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /ERROR: a lockfile would be missing/);
});

test('esm-wrap: withoutComments gives what the character-by-character version gave', () => {
  const { withoutComments } = require('../src/esm-wrap.cjs');
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
  const { withoutComments, exportedNames } = require('../src/esm-wrap.cjs');
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

// a compilation of rspack 2: chunks, assets with their bytes (assets: name -> { info, bytes }), file dependencies,
// all modules, options
function rspackCompilation(root, { chunks, assets = {}, fileDependencies = [], modules = [], optimization = {}, exportsUsed = () => false }) {
  const c = compilation({ context: root, chunks, assets: Object.fromEntries(Object.entries(assets).map(([n, a]) => [n, a.info || {}])) });
  c.compiler.webpack = { rspackVersion: '2.2.8' };
  c.compiler[BUNDLER_FILE] = BUNDLERS.rspack;
  c.compiler.options = { optimization };
  c.getAsset = (name) => (name in assets ? { name, info: assets[name].info || {}, source: { source: () => assets[name].bytes, size: () => Buffer.byteLength(assets[name].bytes) } } : undefined);
  c.fileDependencies = fileDependencies;
  c.modules = new Set([...chunks.flatMap(ch => ch.modules), ...modules]);
  c.moduleGraph = { getIssuer: () => null, getExportsInfo: (m) => ({ isModuleUsed: () => exportsUsed(m) }) };
  return c;
}

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

test('strict: modules whose exports were inlined that cannot be looked for fail the build (a package would be missing)', () => withConfig({ strict: true }, () => {
  problems.take();
  const root = project({ 'node_modules/shipped/package.json': { name: 'shipped', version: '1.0.0' }, 'node_modules/consts/package.json': { name: 'consts', version: '1.0.0' } });
  const shipped = { resource: J(root, 'node_modules/shipped/i.js'), identifier: () => 'a' }, consts = { resource: J(root, 'node_modules/consts/i.js'), identifier: () => 'b' };
  const c = rspackCompilation(root, { chunks: [{ files: ['main.js'], modules: [shipped] }], modules: [consts], optimization: { inlineExports: true, usedExports: true },
    exportsUsed: () => { throw new Error('module graph gone'); } });
  assert.deepEqual(lockedNames(plugin().lockfile(c)), ['shipped']); // the chunks' packages are still collected
  const taken = problems.take();
  assert.equal(taken.length, 1);
  assert.match(taken[0], /^rspack: could not collect the modules whose exports were inlined into .*: module graph gone$/);
}));

test('webpack adapter: the modules are not looked at for copies unless an asset names no source (costly in rspack)', () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const c = compilation({ context: root, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }], assets: { 'main.js': {} } });
  c.getAsset = (name) => (name === 'main.js' ? { name, info: { sourceFilename: undefined }, source: { size: () => 0, source: () => '' } } : undefined);
  Object.defineProperty(c, 'modules', { get() { throw new Error('compilation.modules read'); } });
  assert.deepEqual(lockedNames(plugin().lockfile(c)), ['a']);
});

// settings file (src/core/config.cjs): bundle-lockfile from a copy with src/config.json; prints what the
// settings are in a child process
function withSettingsFile(content, env = {}) {
  const root = project({});
  for (const d of ['src', 'bin']) fs.cpSync(J(__dirname, '..', d), J(root, d), { recursive: true });
  if (content !== null) fs.writeFileSync(J(root, 'src/config.json'), typeof content === 'string' ? content : JSON.stringify(content));
  const script = `const c = require(${JSON.stringify(J(root, 'src/core/config.cjs'))});
    console.log(JSON.stringify({ file: c.file, exportDir: c.exportDir, strict: c.strict, settings: c.settingsFile.file, error: c.settingsFile.error && c.settingsFile.error.message,
      other: process.env.OTHER_SETTING, invalid: c.invalid, child: require('child_process').execSync('node -p process.env.BUNDLE_LOCKFILE_EXPORT_DIR', { encoding: 'utf8' }).trim() }));`;
  const e = { ...process.env };
  for (const k of ['BUNDLE_LOCKFILE_EXPORT_DIR', 'BUNDLE_LOCKFILE_FILE', 'BUNDLE_LOCKFILE_CONFIG']) delete e[k];
  Object.assign(e, env);
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: e });
  assert.equal(r.status, 0, r.stderr);
  return { root, ...JSON.parse(r.stdout) };
}

test('settings file: config.json next to register.cjs sets what the environment does not; only BUNDLE_LOCKFILE_* keys', () => {
  const s = withSettingsFile({ BUNDLE_LOCKFILE_EXPORT_DIR: '/x/export', BUNDLE_LOCKFILE_FILE: 'sbom/package-lock.json', OTHER_SETTING: 'no',
    BUNDLE_LOCKFILE_CONFIG: '/elsewhere.json', BUNDLE_LOCKFILE_INLINE: 0 });
  assert.equal(s.settings, J(s.root, 'src/config.json'));
  assert.equal(s.exportDir, '/x/export');
  assert.equal(s.file, 'sbom/package-lock.json');
  assert.equal(s.other, undefined);
  assert.equal(s.child, '/x/export'); // processes the build starts get them
  assert.equal(s.error, null);
  // keys it cannot set are not used, and are invalid (register.cjs reports them)
  assert.deepEqual(s.invalid, [`the settings file ${s.settings} sets OTHER_SETTING, which is no setting of bundle-lockfile`,
    `the settings file ${s.settings} sets BUNDLE_LOCKFILE_CONFIG, which only the environment can set`]);
  const odd = withSettingsFile({ BUNDLE_LOCKFILE_EXPORT_DIR: { dir: '/x' }, BUNDLE_LOCKFILE_FILE: null, BUNDLE_LOCKFILE_REGISTER: '/r.cjs', BUNDLE_LOCKFILE_EXPORTDIR: '/x' });
  assert.equal(odd.exportDir, null);
  assert.deepEqual(odd.invalid.map(m => m.replace(odd.settings, 'F')), ['the settings file F sets BUNDLE_LOCKFILE_EXPORT_DIR to {"dir":"/x"}: not a string, number or boolean',
    'the settings file F sets BUNDLE_LOCKFILE_FILE to null: not a string, number or boolean', 'the settings file F sets BUNDLE_LOCKFILE_REGISTER, which only the environment can set',
    'the settings file F sets BUNDLE_LOCKFILE_EXPORTDIR, which is no setting of bundle-lockfile']);
  assert.deepEqual(withSettingsFile({ BUNDLE_LOCKFILE_EXPORT_DIR: '/x/export', BUNDLE_LOCKFILE_INLINE: 0, BUNDLE_LOCKFILE_STRICT: true }).invalid, []);
  // the environment wins, also set to '' (the file's value is not used)
  assert.equal(withSettingsFile({ BUNDLE_LOCKFILE_FILE: 'sbom/package-lock.json' }, { BUNDLE_LOCKFILE_FILE: 'env/package-lock.json' }).file, 'env/package-lock.json');
  assert.equal(withSettingsFile({ BUNDLE_LOCKFILE_EXPORT_DIR: '/x/export' }, { BUNDLE_LOCKFILE_EXPORT_DIR: '' }).exportDir, null);
  // none: nothing to say
  const none = withSettingsFile(null);
  assert.deepEqual([none.settings, none.error, none.exportDir], [null, null, null]);
});

// what config.cjs finds invalid for an environment (BUNDLE_LOCKFILE_* variables of this process removed first)
function invalidFor(vars) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BUNDLE_LOCKFILE_')));
  const r = spawnSync(process.execPath, ['-e', `const c = require(${JSON.stringify(J(SRC, 'core/config.cjs'))}); console.log(JSON.stringify({ invalid: c.invalid, strict: c.strict, inline: c.inline, firstParty: c.firstParty, tree: c.tree, file: c.file }))`],
    { env: { ...env, ...vars }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('config: a setting that is not recognized or cannot work is invalid', () => {
  assert.deepEqual(invalidFor({}).invalid, []);
  // every setting with a value it takes
  assert.deepEqual(invalidFor({ BUNDLE_LOCKFILE_FILE: 'sbom/package-lock.json', BUNDLE_LOCKFILE_EXPORT_DIR: '/x', BUNDLE_LOCKFILE_EXPORT_BASE: '/y',
    BUNDLE_LOCKFILE_INLINE: 'OFF', BUNDLE_LOCKFILE_STRICT: ' true ', BUNDLE_LOCKFILE_DEBUG: '', BUNDLE_LOCKFILE_FIRST_PARTY: '/app/lib/**, /**',
    BUNDLE_LOCKFILE_DISABLE: ' Vite , rolldown', BUNDLE_LOCKFILE_ESM_HOOKS: 'Async', BUNDLE_LOCKFILE_TREE: ' On ', BUNDLE_LOCKFILE_REGISTER: '/r.cjs',
    BUNDLE_LOCKFILE_NODE_SHIM: '/s', BUNDLE_LOCKFILE_NODE_SEEN: '/a:/b' }).invalid, []);
  const one = (vars) => { const { invalid } = invalidFor(vars); assert.equal(invalid.length, 1, JSON.stringify(invalid)); return invalid[0]; };
  assert.equal(one({ BUNDLE_LOCKFILE_EXPORTDIR: '/x' }), 'BUNDLE_LOCKFILE_EXPORTDIR is set, but is no setting of bundle-lockfile');
  // a name in another case: case-sensitive, it would not be read (Windows: it is)
  if (process.platform !== 'win32') assert.equal(one({ bundle_lockfile_strict: '0' }), 'bundle_lockfile_strict is set, but the settings of bundle-lockfile are named in upper case (BUNDLE_LOCKFILE_STRICT)');
  assert.equal(one({ BUNDLE_LOCKFILE_DISABLE: 'webpack,rsbuild' }), 'BUNDLE_LOCKFILE_DISABLE names rsbuild, which is none of webpack, rspack, vite, rollup, rolldown, esbuild, parcel, angular, next or all');
  assert.equal(one({ BUNDLE_LOCKFILE_ESM_HOOKS: 'asnyc' }), 'BUNDLE_LOCKFILE_ESM_HOOKS=asnyc is none of auto, sync, async, off');
  assert.equal(one({ BUNDLE_LOCKFILE_TREE: 'both' }), 'BUNDLE_LOCKFILE_TREE=both is none of off, on, only');
  // the tree: off unless asked for (also for a value not recognized); only: the record in record.json, which no SBOM
  // tool reads, next to the tree
  assert.deepEqual([invalidFor({}).tree, invalidFor({ BUNDLE_LOCKFILE_TREE: 'both' }).tree, invalidFor({ BUNDLE_LOCKFILE_TREE: 'ON' }).tree], ['off', 'off', 'on']);
  assert.deepEqual(invalidFor({ BUNDLE_LOCKFILE_TREE: 'on' }).file, 'bundle-lockfile/package-lock.json');
  assert.deepEqual(invalidFor({ BUNDLE_LOCKFILE_TREE: 'only' }).file, 'bundle-lockfile/record.json');
  assert.deepEqual(invalidFor({ BUNDLE_LOCKFILE_TREE: 'only', BUNDLE_LOCKFILE_FILE: 'sbom/package-lock.json' }).file, 'sbom/record.json');
  for (const k of ['INLINE', 'STRICT', 'DEBUG']) {
    for (const v of ['yes', 'no', '2', 'disabled']) assert.equal(one({ [`BUNDLE_LOCKFILE_${k}`]: v }), `BUNDLE_LOCKFILE_${k}=${v} is not recognized (1, true or on; 0, false or off)`);
  }
  // a value not recognized: the default (strict stays on, and the build fails for the value)
  assert.deepEqual(invalidFor({ BUNDLE_LOCKFILE_STRICT: 'no', BUNDLE_LOCKFILE_INLINE: 'no' }).strict, true);
  assert.deepEqual(invalidFor({ BUNDLE_LOCKFILE_INLINE: 'no' }).inline, true);
  assert.match(one({ BUNDLE_LOCKFILE_EXPORT_DIR: 'out/export' }), /^BUNDLE_LOCKFILE_EXPORT_DIR is not an absolute path: out\/export/);
  assert.match(one({ BUNDLE_LOCKFILE_EXPORT_DIR: '/x', BUNDLE_LOCKFILE_EXPORT_BASE: '.' }), /^BUNDLE_LOCKFILE_EXPORT_BASE is not an absolute path: \./);
  assert.equal(one({ BUNDLE_LOCKFILE_EXPORT_BASE: '/y' }), 'BUNDLE_LOCKFILE_EXPORT_BASE is set without BUNDLE_LOCKFILE_EXPORT_DIR: it has no effect');
  assert.equal(one({ BUNDLE_LOCKFILE_FIRST_PARTY: '/app/lib/**,tools/**' }), 'BUNDLE_LOCKFILE_FIRST_PARTY names tools/**, which is not an absolute path (each process would match it against its own working directory)');
  assert.deepEqual(invalidFor({ BUNDLE_LOCKFILE_FIRST_PARTY: '/app/lib/**,tools/**' }).firstParty, ['/app/lib/**']);
  assert.match(one({ BUNDLE_LOCKFILE_CONFIG: 'config.json' }), /^BUNDLE_LOCKFILE_CONFIG is not an absolute path: config\.json/); // (and the file is missing: settingsFile.error)
  // the lockfile only where syft and Trivy read it
  for (const v of ['sbom/lock.json', '/abs/package-lock.json', '../package-lock.json', 'a/../../package-lock.json', 'node_modules/x/package-lock.json', 'package-lock.json/x']) {
    assert.match(one({ BUNDLE_LOCKFILE_FILE: v }), /^BUNDLE_LOCKFILE_FILE=.* is not a relative path inside the output directory to a file named package-lock\.json outside node_modules/, v);
  }
  for (const v of ['package-lock.json', 'a/b/package-lock.json', 'main.js/package-lock.json']) assert.deepEqual(invalidFor({ BUNDLE_LOCKFILE_FILE: v }).invalid, [], v);
});

test('tree: a package.json per lockfile key, rewritten in place only when the packages change; no package\'s files', () => {
  const { stubsOf, writeTree, inTree } = require('../src/core/tree.cjs');
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
  const { stubsOf, writeTree } = require('../src/core/tree.cjs');
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
  const { writeTree } = require('../src/core/tree.cjs');
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
  const copies = require('../src/core/copies.cjs');
  const root = project({ 'dist/bundle-lockfile/packages/0123456789abcdef/node_modules/a/package.json': { name: 'a', version: '1.0.0' },
    'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const stub = J(root, 'dist/bundle-lockfile/packages/0123456789abcdef/node_modules/a/package.json');
  fs.mkdirSync(J(root, 'build'), { recursive: true });
  fs.copyFileSync(stub, J(root, 'build/x.json'));
  copies.record(stub, J(root, 'build/x.json'));
  assert.equal(copies.sourceOf(J(root, 'build/x.json')), null);
});

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
const esbuildAdapter = () => require('../src/adapters/esbuild.cjs');
const ESBUILD_MAIN = '/p/node_modules/esbuild/lib/main.js';

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

test('strict: the output of a write: false build that its caller writes, in no lockfile, fails the process when it ends', () => {
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const script = (write) => `const a = require(${JSON.stringify(J(SRC, 'adapters/esbuild.cjs'))}); const fs = require('fs');
    const options = { entryPoints: ['src/main.js'], outdir: 'dist', write: false, absWorkingDir: ${JSON.stringify(root)} };
    const plugin = a.attach(options, ${JSON.stringify(ESBUILD_MAIN)}).plugins.at(-1);
    let end; plugin.setup({ initialOptions: options, onStart() {}, onEnd: (fn) => { end = fn; } });
    const out = { path: ${JSON.stringify(J(root, 'dist/main.js'))}, contents: Buffer.from('bundled a') };
    end({ errors: [], metafile: { outputs: { 'dist/main.js': { inputs: { 'node_modules/a/i.js': { bytesInOutput: 9 } } } } }, outputFiles: [out] }).then(() => {
      ${write ? "fs.mkdirSync(require('path').dirname(out.path), { recursive: true }); fs.writeFileSync(out.path, out.contents);" : ''} console.log('done');
    });`;
  const written = nodeWith(strictEnv(undefined), ['-e', script(true)]);
  assert.equal(written.status, 1, written.stderr);
  assert.match(written.stderr, /\S*dist\/main\.js, output of a build with write: false, was written by its caller or a plugin: no lockfile lists its packages/);
  fs.rmSync(J(root, 'dist'), { recursive: true });
  const kept = nodeWith(strictEnv(undefined), ['-e', script(false)]); // only looked at: nothing ships
  assert.deepEqual([kept.status, kept.stdout.trim()], [0, 'done'], kept.stderr);
});

test('esbuild adapter: a problem is an onEnd error (the build rejects); write: false keeps the packages for the build that uses the output', () => withConfig({ strict: true }, async () => {
  const generated = require('../src/core/generated.cjs');
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

test('hooks: a module whose exports are a getter (a new object every time) loads as without bundle-lockfile', () => {
  const root = project({ 'm.cjs': "Object.defineProperty(module, 'exports', { get: () => ({ x: 1 }), configurable: true }); module.loaded;", 'main.cjs': "console.log(require('./m.cjs').x);" });
  const env = { ...strictEnv(undefined), NODE_OPTIONS: `--require ${J(SRC, 'register.cjs')}` };
  const r = spawnSync(process.execPath, ['main.cjs'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '1');
});

test('esbuild adapter: style sheets a plugin inlines (its onLoad watchFiles) count for the module it loaded; files written by other plugins\' onEnd too', async () => {
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
  const CLI = J(__dirname, '../bin/bundle-lockfile-from-metafile');
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

test('strict: Parcel before 2.13 only prints a reporter\'s error - the process fails at its exit; from 2.13 on Parcel fails the build', () => {
  for (const [version, status] of [['2.8.3', 1], ['2.12.0', 1], ['2.13.0', 0], ['2.16.4', 0]]) {
    const root = project({ 'node_modules/@parcel/core/package.json': { name: '@parcel/core', version }, 'node_modules/@parcel/core/lib/Parcel.js': '' });
    const where = J(root, 'node_modules/@parcel/core/lib/Parcel.js');
    // Parcel's reporter runner: the reporter's error caught (and printed), the build goes on, the CLI exits with 0
    const script = `const parcel = require(${JSON.stringify(J(SRC, 'adapters/parcel.cjs'))});
      class Parcel { run() {} watch() {} }
      parcel.onCjsLoad({ default: Parcel }, ${JSON.stringify(where)}, () => ${JSON.stringify(where)});
      parcel.report({ event: { type: 'buildSuccess', bundleGraph: null }, options: { projectRoot: ${JSON.stringify(root)} } })
        .then(() => console.log('no error'), (e) => { console.log('reporter error:', e.message.split('\\n')[0]); process.exit(0); });`;
    const r = nodeWith(strictEnv(undefined), ['-e', script]);
    assert.match(r.stdout, /reporter error: bundle-lockfile: the lockfile would be missing or incomplete/, version);
    assert.equal(r.status, status, `${version}: ${r.stderr}`);
    if (status) assert.match(r.stderr, /could not collect the bundled packages of the build/, version);
  }
});

// Parcel: a fake @parcel/core lib/Parcel.js and bundle graph of the public API's shape (BundleGraph, Bundle, Asset)
test('parcel adapter: the Parcel class gets the reporter in its options; another shape fails (strict)', () => withConfig({ strict: true }, () => {
  const parcel = require('../src/adapters/parcel.cjs');
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
  const bs = bundles.map(b => ({ ...b, env: { shouldScopeHoist: b.scope !== false }, assets: b.assets.map(a => (typeof a === 'string' ? asset(a) : asset(a.f, a))),
    traverseAssets(fn) { for (const a of this.assets) fn(a); }, getMainEntry() { return this.assets[0]; } }));
  return { getBundles: () => bs, getUsedSymbols: (a) => a.used, isAssetReferenced: (b, a) => a.ref };
}

test('parcel adapter: the reporter writes the packages of every bundle\'s assets per distDir, not those the packager skips', () => withConfig({ strict: true }, async () => {
  const parcel = require('../src/adapters/parcel.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('inl'), ...pj('skip'), ...pj('ref'), ...pj('lib'), 'node_modules/nopj/i.js': '', 'src/i.js': '',
    'node_modules/@parcel/packager-js/package.json': { name: '@parcel/packager-js', version: UNIT } }); // the code Parcel writes around JavaScript
  fakeParcelTracker(root, { 'src/i.js': [] }); // every Parcel build has a request graph (here: nothing inlined)
  for (const f of ['dist/main.js', 'dist/main.css', 'lib/out/index.js']) { fs.mkdirSync(path.dirname(J(root, f)), { recursive: true }); fs.writeFileSync(J(root, f), f); }
  const target = (d) => ({ name: d, distDir: J(root, d) });
  const graph = fakeBundleGraph([
    { filePath: J(root, 'dist/main.js'), target: target('dist'), assets: [J(root, 'src/i.js'), J(root, 'node_modules/a/i.js'),
      { f: J(root, 'node_modules/skip/i.js'), sideEffects: false, used: new Set() }, { f: J(root, 'node_modules/ref/i.js'), sideEffects: false, used: new Set(), ref: true }] },
    { filePath: J(root, 'dist/main.css'), target: target('dist'), assets: [J(root, 'node_modules/a/s.css')] },
    { filePath: null, bundleBehavior: 'inline', target: target('dist'), assets: [J(root, 'node_modules/inl/i.js')] }, // inlined into another bundle
    { filePath: J(root, 'lib/out/index.js'), target: target('lib/out'), assets: [J(root, 'node_modules/lib/i.js')] }, // another target
  ]);
  await parcel.report({ event: { type: 'buildSuccess', bundleGraph: graph }, options: { projectRoot: root } });
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
    { filePath: J(root, 'node_modules/lib/dist/main.js'), target: target('node_modules/lib/dist'), assets: [J(root, 'node_modules/a/i.js')] }]) }, options: { projectRoot: root } });
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'node_modules/.cache/x', LOCK), 'utf8')), ['a']);
  assert.equal(fs.existsSync(J(root, 'node_modules/lib/dist', LOCK)), false);
  // other events: nothing; a problem: thrown (Parcel fails the build with it)
  await parcel.report({ event: { type: 'buildStart' } });
  const bad = fakeBundleGraph([{ filePath: J(root, 'dist/main.js'), target: target('dist'), assets: [J(root, 'node_modules/nopj/i.js')] }]);
  await assert.rejects(parcel.report({ event: { type: 'buildSuccess', bundleGraph: bad }, options: { projectRoot: root } }), /no package\.json with name and version in \S*nopj/);
  problems.take(); // (also kept for the exit: Parcel's version is not known here, see failAtExit)
  // without scope hoisting nothing is skipped
  const noHoist = fakeBundleGraph([{ filePath: J(root, 'dist/main.js'), target: target('dist'), scope: false, assets: [{ f: J(root, 'node_modules/skip/i.js'), sideEffects: false, used: new Set() }] }]);
  await parcel.report({ event: { type: 'buildSuccess', bundleGraph: noHoist }, options: { projectRoot: root } });
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['skip']);
  // JavaScript only inlined into the HTML (<script type="module">): Parcel's code is around it too
  fs.mkdirSync(J(root, 'site'), { recursive: true });
  fs.writeFileSync(J(root, 'site/index.html'), '<script type="module">a</script>');
  const html = fakeBundleGraph([{ filePath: J(root, 'site/index.html'), type: 'html', target: target('site'), assets: [J(root, 'src/index.html')] },
    { filePath: null, type: 'js', bundleBehavior: 'inline', target: target('site'), assets: [J(root, 'node_modules/a/i.js')] }]);
  await parcel.report({ event: { type: 'buildSuccess', bundleGraph: html }, options: { projectRoot: root } });
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

// A fake @parcel/core lib/RequestTracker.js (and its lib/projectPath.js) at root: a RequestTracker class whose instance,
// once it runs a request, has a request graph of Parcel's API (hasContentKey, getNodeIdByContentKey,
// getNodeIdsConnectedTo, getNode, getInvalidations). deps: { asset's file (project-relative): [files its asset request
// also depends on] }. shape: '2.16' (requestType numbers) or '2.0' (request nodes with value.type)
function fakeParcelTracker(root, deps, shape = '2.16') {
  const parcel = require('../src/adapters/parcel.cjs');
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
  const parcel = require('../src/adapters/parcel.cjs');
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

// Angular: executeBuild() of a fake application builder, whose result has Angular's shape (ExecutionResult)
function fakeExecuteBuild(root, { stats = 'split', inputs, assets = [], errors = [] } = {}) {
  return async (options) => {
    const outputFiles = [{ path: 'main.js', type: 0, text: 'x' }];
    const result = { outputFiles, assetFiles: assets.map(source => ({ source, destination: 'a' })), errors: [...errors],
      addOutputFile(p, text, type) { outputFiles.push({ path: p, type, text }); }, addError(e) { this.errors.push(e); } };
    const metafile = { outputs: { 'main.js': { entryPoint: 'src/main.ts', inputs: Object.fromEntries(inputs.map(i => [i, { bytesInOutput: 1 }])) } } };
    if (options.stats) {
      if (stats === 'split') outputFiles.push({ path: 'browser-stats.json', type: 4, text: JSON.stringify(metafile) });
      else outputFiles.push({ path: 'stats.json', type: 4, text: JSON.stringify(metafile) });
    }
    return result;
  };
}

test('angular adapter: executeBuild with stats on; the lockfile added to its output files; the stats taken out again unless asked for', () => withConfig({ strict: true }, async () => {
  const angular = require('../src/adapters/angular.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('font'), 'node_modules/nopj/i.js': '', 'src/main.ts': '',
    'node_modules/esbuild/package.json': { name: 'esbuild', version: UNIT } }); // the esbuild the build ran (its runtime helpers)
  const options = { workspaceRoot: root, outputOptions: { base: J(root, 'dist'), browser: 'browser', server: 'server' } };
  for (const stats of ['split', 'combined']) {
    const run = angular.wrap(fakeExecuteBuild(root, { stats, inputs: ['src/main.ts', 'node_modules/a/i.js'], assets: [J(root, 'node_modules/font/f.woff2')] }));
    const r = await run(options);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.outputFiles.map(f => f.path), ['main.js', LOCK], stats); // the stats are no output: not asked for
    const lock = r.outputFiles.find(f => f.path === LOCK);
    assert.equal(lock.type, 0); // Angular's Browser: <outputPath>/browser/
    assert.deepEqual(lockedNames(lock.text), ['a', 'font'], stats);
    const w = JSON.parse(lock.text)['bundle-lockfile'].writers[0];
    assert.equal(w.bundler.name, 'angular');
    const pk = w.packages;
    assert.deepEqual(Object.fromEntries(Object.entries(w.via).map(([c, ix]) => [c, ix.map(i => pk[i])])), { chunk: ['node_modules/a'], asset: ['node_modules/font'], runtime: ['node_modules/esbuild'] }, stats);
    const asked = await run({ ...options, stats: true });
    assert.ok(asked.outputFiles.some(f => /stats\.json$/.test(f.path)), stats);
  }
  // BUNDLE_LOCKFILE_TREE=on: Angular writes the package.json tree next to the lockfile too
  await withConfig({ tree: 'on' }, async () => {
    const r = await angular.wrap(fakeExecuteBuild(root, { inputs: ['node_modules/a/i.js'] }))(options);
    const stubs = r.outputFiles.filter(f => f.path.startsWith('bundle-lockfile/packages/') && notUnit(JSON.parse(f.text))); // (and the bundler's)
    assert.deepEqual(stubs.map(f => [f.path.replace(/[0-9a-f]{16}/, '<id>'), f.type, JSON.parse(f.text).name]), [['bundle-lockfile/packages/<id>/node_modules/a/package.json', 0, 'a']]);
  });
  // a failed build: nothing added; a problem: an error of the build
  const failed = await angular.wrap(fakeExecuteBuild(root, { inputs: ['node_modules/a/i.js'], errors: ['TS2307'] }))(options);
  assert.deepEqual(failed.outputFiles.map(f => f.path), ['main.js']);
  problems.take();
  const bad = await angular.wrap(fakeExecuteBuild(root, { inputs: ['node_modules/nopj/i.js'] }))(options);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /no package\.json with name and version in \S*nopj/);
  // an executeBuild of another shape
  const where = '/p/node_modules/@angular/build/src/builders/application/execute-build.js';
  angular.onCjsLoad({ executeBuild: 1 }, where, () => where);
  assert.match(problems.take().join('\n'), /exports no executeBuild\(\) bundle-lockfile knows/);
  const exp = { executeBuild: async () => null };
  angular.onCjsLoad(exp, where, () => where);
  assert.equal(exp.executeBuild.name, 'bundleLockfileExecuteBuild');
  const wrapped = exp.executeBuild;
  angular.onCjsLoad(exp, where, () => where);
  assert.equal(exp.executeBuild, wrapped); // once
}));

// An SSR build's result as Angular's executeBuild returns it: browser and server output files (Angular's types: Browser
// 0, ServerApplication 2, ServerRoot 3, Root 4), and its metafile - one per side (22 and later) or one for both
// (17 - 21), whose outputs are keyed by their path in their side's directory. 'gone.mjs' is an output no file has.
function fakeSsrBuild({ stats }) {
  return async (options) => {
    const outputFiles = [{ path: 'main.js', type: 0, text: 'x' }, { path: 'main.server.mjs', type: 2, text: 'x' }, { path: 'server.mjs', type: 3, text: 'x' }];
    const result = { outputFiles, assetFiles: [], errors: [],
      addOutputFile(p, text, type) { outputFiles.push({ path: p, type, text }); }, addError(e) { this.errors.push(e); } };
    const out = (i) => ({ inputs: { [i]: { bytesInOutput: 1 } } });
    const browser = { outputs: { 'main.js': { entryPoint: 'src/main.ts', ...out('node_modules/b/i.js') } } };
    const server = { outputs: { 'main.server.mjs': out('node_modules/s/i.js'), 'server.mjs': out('node_modules/r/i.js'), 'gone.mjs': out('node_modules/u/i.js') } };
    if (options.stats && stats === 'split') {
      outputFiles.push({ path: 'browser-stats.json', type: 4, text: JSON.stringify(browser) }, { path: 'server-stats.json', type: 4, text: JSON.stringify(server) });
    } else if (options.stats) {
      outputFiles.push({ path: 'stats.json', type: 4, text: JSON.stringify({ outputs: { ...browser.outputs, ...server.outputs } }) });
    }
    return result;
  };
}

test('angular adapter: server-side rendering - a lockfile per side, from per-side or combined metafiles; none for a server Angular does not write', () => withConfig({ strict: true }, async () => {
  const angular = require('../src/adapters/angular.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  // (esbuild: the one the build ran, whose runtime helpers are in every side's JavaScript - listed with it)
  const root = project({ ...pj('b'), ...pj('s'), ...pj('r'), ...pj('u'), ...pj('esbuild'), 'src/main.ts': '' });
  const outputOptions = { base: J(root, 'dist'), browser: 'browser', server: 'server' };
  for (const stats of ['split', 'combined']) {
    const r = await angular.wrap(fakeSsrBuild({ stats }))({ workspaceRoot: root, outputOptions });
    assert.deepEqual(r.errors, [], stats);
    const browser = r.outputFiles.filter(f => f.path === LOCK);
    assert.equal(browser.length, 1, stats);
    assert.equal(browser[0].type, 0);
    // the server's lockfile: a file of the output path's root, at server/<file> - Angular 17 - 21 key the files they
    // write by their path in their side's directory, so the server's at <file> would replace the browser's
    const server = r.outputFiles.filter(f => f.path === `server/${LOCK}`);
    assert.equal(server.length, 1, stats);
    assert.equal(server[0].type, 4);
    // combined: each output is the side of the output file of its path; one without a file counts for both
    assert.deepEqual(lockedNames(browser[0].text), stats === 'split' ? ['b', 'esbuild'] : ['b', 'esbuild', 'u'], stats);
    assert.deepEqual(lockedNames(server[0].text), ['esbuild', 'r', 's', 'u'], stats);
  }
  // outputMode static (or no SSR entry): Angular skips the server's files (ignoreServer) - no server lockfile
  for (const stats of ['split', 'combined']) {
    const r = await angular.wrap(fakeSsrBuild({ stats }))({ workspaceRoot: root, outputOptions: { ...outputOptions, ignoreServer: true } });
    assert.deepEqual(r.outputFiles.filter(f => /bundle-lockfile/.test(f.path)).map(f => f.path), [LOCK], stats);
  }
}));

test('angular adapter: i18n - a lockfile in each locale\'s copy of the output, from per-side or combined metafiles; locales without subPath fail', () => withConfig({ strict: true }, async () => {
  const angular = require('../src/adapters/angular.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/s/package.json': { name: 's', version: '1.0.0' },
    'node_modules/esbuild/package.json': { name: 'esbuild', version: '1.0.0' }, 'src/main.ts': '' });
  const i18nOptions = { shouldInline: true, inlineLocales: new Set(['de', 'en-US']), locales: { de: { subPath: 'de' }, 'en-US': { subPath: 'en-US' } } };
  const options = { workspaceRoot: root, outputOptions: { base: J(root, 'dist'), browser: 'browser', server: 'server' }, i18nOptions };
  // the result after Angular inlined the translations: each locale's copy of the outputs in <subPath>/; the metafile is
  // the one before (main.js, main.server.mjs)
  const build = (stats) => async (o) => {
    const outputFiles = ['de', 'en-US'].flatMap(l => [{ path: `${l}/main.js`, type: 0, text: 'x' }, { path: `${l}/main.server.mjs`, type: 2, text: 'x' }]);
    const browser = { outputs: { 'main.js': { entryPoint: 'src/main.ts', inputs: { 'node_modules/a/i.js': { bytesInOutput: 1 } } } } };
    const server = { outputs: { 'main.server.mjs': { inputs: { 'node_modules/s/i.js': { bytesInOutput: 1 } } } } };
    if (o.stats && stats === 'split') outputFiles.push({ path: 'browser-stats.json', type: 4, text: JSON.stringify(browser) }, { path: 'server-stats.json', type: 4, text: JSON.stringify(server) });
    else if (o.stats) outputFiles.push({ path: 'stats.json', type: 4, text: JSON.stringify({ outputs: { ...browser.outputs, ...server.outputs } }) });
    return { outputFiles, assetFiles: [], errors: [], addOutputFile(p, text, type) { outputFiles.push({ path: p, type, text }); }, addError(e) { this.errors.push(e); } };
  };
  for (const stats of ['split', 'combined']) {
    const r = await angular.wrap(build(stats))(options);
    assert.deepEqual(r.errors, [], stats);
    const locks = Object.fromEntries(r.outputFiles.filter(f => /bundle-lockfile/.test(f.path)).map(f => [`${f.type} ${f.path}`, lockedNames(f.text)]));
    assert.deepEqual(locks, { [`0 de/${LOCK}`]: ['a', 'esbuild'], [`0 en-US/${LOCK}`]: ['a', 'esbuild'], [`4 server/de/${LOCK}`]: ['esbuild', 's'], [`4 server/en-US/${LOCK}`]: ['esbuild', 's'] }, stats);
  }
  // with server-side rendering: the SSR entry bundle (server.mjs, ServerRoot) is written once, in the server's own
  // directory - its lockfile there lists its packages (r), the locales' theirs (s); an output no file has (gone.mjs)
  // counts for both
  for (const stats of ['split', 'combined']) {
    const ssr = async (o) => {
      const r = await build(stats)(o);
      r.outputFiles.push({ path: 'server.mjs', type: 3, text: 'x' });
      const meta = r.outputFiles.find(f => f.path === (stats === 'split' ? 'server-stats.json' : 'stats.json'));
      const j = JSON.parse(meta.text);
      j.outputs['server.mjs'] = { inputs: { 'node_modules/r/i.js': { bytesInOutput: 1 } } };
      j.outputs['gone.mjs'] = { inputs: { 'node_modules/u/i.js': { bytesInOutput: 1 } } };
      meta.text = JSON.stringify(j);
      return r;
    };
    for (const n of ['r', 'u']) { fs.mkdirSync(J(root, 'node_modules', n), { recursive: true }); fs.writeFileSync(J(root, 'node_modules', n, 'package.json'), JSON.stringify({ name: n, version: '1.0.0' })); }
    const r = await angular.wrap(ssr)(options);
    assert.deepEqual(r.errors, [], stats);
    const locks = Object.fromEntries(r.outputFiles.filter(f => /bundle-lockfile/.test(f.path) && f.path.startsWith('server/')).map(f => [f.path, lockedNames(f.text)]));
    assert.deepEqual(locks, { [`server/${LOCK}`]: ['esbuild', 'r', 'u'], [`server/de/${LOCK}`]: ['esbuild', 's', 'u'], [`server/en-US/${LOCK}`]: ['esbuild', 's', 'u'] }, stats);
  }
  // flatOutput (one locale, the dev server's): one copy, no locale directory
  const flat = await angular.wrap(build('split'))({ ...options, i18nOptions: { ...i18nOptions, flatOutput: true } });
  assert.deepEqual(flat.outputFiles.filter(f => /bundle-lockfile/.test(f.path)).map(f => f.path).sort(), [LOCK, `server/${LOCK}`]);
  // locales of a shape bundle-lockfile does not know: an error of the build
  const bad = await angular.wrap(build('split'))({ ...options, i18nOptions: { ...i18nOptions, locales: { de: {}, 'en-US': {} } } });
  assert.match(bad.errors.join('\n'), /an i18n build whose locales have no subPath/);
}));

test('angular adapter: a build of the dev server (ng serve) gets no lockfile and no stats; with NG_BUILD_PARTIAL_SSR set, a build gets its lockfile', () => withConfig({ strict: true }, async () => {
  const angular = require('../src/adapters/angular.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/esbuild/package.json': { name: 'esbuild', version: '1.0.0' }, 'src/main.ts': '' });
  const options = { workspaceRoot: root, outputOptions: { base: J(root, 'dist'), browser: 'browser', server: 'server' }, partialSSRBuild: true };
  let seen = null;
  const inner = fakeExecuteBuild(root, { inputs: ['node_modules/a/i.js'] });
  const run = angular.wrap(async (o) => { seen = o; return inner(o); });
  const saved = process.env.NG_BUILD_PARTIAL_SSR;
  try {
    delete process.env.NG_BUILD_PARTIAL_SSR;
    const r = await run(options);
    assert.deepEqual(r.outputFiles.map(f => f.path), ['main.js']); // no lockfile, no stats
    assert.equal(seen.stats, undefined); // the options as the dev server made them
    // ng build with NG_BUILD_PARTIAL_SSR: partialSSRBuild too, but a build that writes - its lockfile
    process.env.NG_BUILD_PARTIAL_SSR = '1';
    const b = await run(options);
    assert.deepEqual(b.errors, []);
    assert.deepEqual(b.outputFiles.map(f => f.path), ['main.js', LOCK]);
  } finally { if (saved === undefined) delete process.env.NG_BUILD_PARTIAL_SSR; else process.env.NG_BUILD_PARTIAL_SSR = saved; }
}));

test('config: BUNDLE_LOCKFILE_DISABLE takes exactly the adapters\' names', () => {
  const names = ['webpack', 'rollup', 'rspack', 'esbuild', 'parcel', 'angular', 'next'].flatMap(a => { const ad = require(`../src/adapters/${a}.cjs`); return ad.names || [ad.name]; });
  assert.deepEqual([...names].sort(), [...config.ADAPTER_NAMES].sort());
});

test('register: invalid settings fail the process (BUNDLE_LOCKFILE_STRICT=0: warnings; BUNDLE_LOCKFILE_DISABLE=all: nothing is checked)', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BUNDLE_LOCKFILE_')));
  const run = (vars) => spawnSync(process.execPath, ['--require', J(SRC, 'register.cjs'), '-e', '0'], { env: { ...env, ...vars }, encoding: 'utf8' });
  const strict = run({ BUNDLE_LOCKFILE_EXPORTDIR: '/x', BUNDLE_LOCKFILE_DEBUG: 'yes' });
  assert.equal(strict.status, 1, strict.stderr);
  assert.match(strict.stderr, /\[bundle-lockfile\] ERROR: BUNDLE_LOCKFILE_EXPORTDIR is set, but is no setting of bundle-lockfile\n\[bundle-lockfile\] ERROR: BUNDLE_LOCKFILE_DEBUG=yes is not recognized/);
  const off = run({ BUNDLE_LOCKFILE_EXPORTDIR: '/x', BUNDLE_LOCKFILE_STRICT: '0' });
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stderr, /\[bundle-lockfile\] WARNING: BUNDLE_LOCKFILE_EXPORTDIR is set, but is no setting of bundle-lockfile/);
  const all = run({ BUNDLE_LOCKFILE_EXPORTDIR: '/x', BUNDLE_LOCKFILE_DISABLE: 'all' });
  assert.deepEqual([all.status, all.stderr], [0, '']);
  assert.deepEqual([run({}).status, run({}).stderr], [0, '']);
});

test('register: another copy of bundle-lockfile preloaded too fails the process, whichever comes first; the same one through a link does not', () => {
  const root = project({ 'other/note.txt': '' });
  for (const d of ['src', 'bin']) fs.cpSync(J(__dirname, '..', d), J(root, 'copy', d), { recursive: true });
  fs.symlinkSync(J(__dirname, '..'), J(root, 'link'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BUNDLE_LOCKFILE_') && k !== 'NODE_OPTIONS'));
  const run = (nodeOptions, args = []) => spawnSync(process.execPath, [...args, '-e', '0'], { env: { ...env, NODE_OPTIONS: nodeOptions }, encoding: 'utf8' });
  const ours = J(SRC, 'register.cjs'), copy = J(root, 'copy/src/register.cjs');
  for (const opts of [`--require ${ours} --require ${copy}`, `--require=${copy} --require=${ours}`, `-r "${copy}" -r ${ours}`]) {
    const r = run(opts);
    assert.equal(r.status, 1, `${opts}: ${r.stderr}`);
    assert.match(r.stderr, /\[bundle-lockfile\] ERROR: another copy of bundle-lockfile is preloaded too: \S*register\.cjs \(only the first one runs; preload one\)/, opts);
  }
  // on the command line
  const cli = run(`--require ${ours}`, ['--require', copy]);
  assert.equal(cli.status, 1, cli.stderr);
  // one copy, also through a symbolic link to it, and a register.cjs of something else
  fs.writeFileSync(J(root, 'other/register.cjs'), '// ts-node style\n');
  for (const opts of [`--require ${ours}`, `--require ${ours} --require ${J(root, 'link/src/register.cjs')}`, `--require ${ours} --require ${J(root, 'other/register.cjs')}`]) {
    const r = run(opts);
    assert.deepEqual([r.status, r.stderr], [0, ''], opts);
  }
});

test('settings file: BUNDLE_LOCKFILE_CONFIG names it; one that cannot be used is an error the build fails with', () => {
  const named = J(project({ 's.json': { BUNDLE_LOCKFILE_EXPORT_DIR: '/named' } }), 's.json');
  const s = withSettingsFile({ BUNDLE_LOCKFILE_EXPORT_DIR: '/default' }, { BUNDLE_LOCKFILE_CONFIG: named });
  assert.deepEqual([s.settings, s.exportDir], [named, '/named']);
  assert.match(withSettingsFile(null, { BUNDLE_LOCKFILE_CONFIG: '/does/not/exist.json' }).error, /ENOENT/);
  assert.match(withSettingsFile('{not json').error, /JSON/);
  assert.equal(withSettingsFile('[1]').error, 'not a JSON object');
  // register.cjs reports it: strict mode fails the process (no build took it), BUNDLE_LOCKFILE_STRICT=0 warns
  const root = withSettingsFile('{not json').root;
  const reg = J(root, 'src/register.cjs');
  const strict = nodeWith(strictEnv(undefined), ['--require', reg, '-e', '0']);
  assert.equal(strict.status, 1, strict.stderr);
  assert.match(strict.stderr, /\[bundle-lockfile\] ERROR: could not read the settings file .*config\.json: .*JSON/);
  const off = nodeWith(strictEnv('0'), ['--require', reg, '-e', '0']);
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stderr, /\[bundle-lockfile\] WARNING: could not read the settings file/);
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

// --- the core write path: what cannot be read, locked or written, and what must not be replaced

test('lock: a stale lock that cannot be removed, a lock that is a link to nothing, a lock that cannot be made: never a busy loop', { skip: process.platform === 'win32' }, () => {
  // in a child process with a time limit: a lock() that loops forever must fail the test, not hang it
  const root = project({ blocker: '' });
  const run = (setup) => {
    const script = `const fs = require('fs'); const { lock } = require(${JSON.stringify(J(SRC, 'core/lock.cjs'))});
      const problems = require(${JSON.stringify(J(SRC, 'core/problems.cjs'))});
      ${setup}
      const t = Date.now(); lock(file, { wait: 300 }).then((release) => { release(); console.log(JSON.stringify({ took: Date.now() - t, problems: problems.take() })); });`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: strictEnv(undefined), timeout: 15000 });
    assert.equal(r.status, 0, `lock() did not return: ${r.signal || r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const old = (Date.now() - 120000) / 1000;
  // a stale lock in a directory this user may not change (another user's, a read-only file system): rename fails
  fs.mkdirSync(J(root, 'a'));
  fs.writeFileSync(J(root, 'a/l.json.lock'), 'died');
  fs.utimesSync(J(root, 'a/l.json.lock'), old, old);
  const a = run(`const file = ${JSON.stringify(J(root, 'a/l.json'))}; const rename = fs.renameSync;
    fs.renameSync = (x, y) => { if (x === file + '.lock') { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return rename(x, y); };`);
  assert.ok(a.took >= 300, `${a.took} ms`);
  assert.match(a.problems.join(), /could not lock .*l\.json - writing it without the lock/);
  assert.equal(fs.readFileSync(J(root, 'a/l.json.lock'), 'utf8'), 'died');
  // a lock that is a symbolic link to nothing: fresh, it is waited for; as old as a stale lock, it is taken over
  fs.mkdirSync(J(root, 'b'));
  fs.symlinkSync(J(root, 'nothing'), J(root, 'b/l.json.lock'));
  const fresh = run(`const file = ${JSON.stringify(J(root, 'b/l.json'))};`);
  assert.ok(fresh.took >= 300, `${fresh.took} ms`);
  assert.equal(fresh.problems.length, 1);
  fs.lutimesSync(J(root, 'b/l.json.lock'), old, old);
  assert.deepEqual(run(`const file = ${JSON.stringify(J(root, 'b/l.json'))};`).problems, []);
  assert.deepEqual(fs.readdirSync(J(root, 'b')), []);
  // a lock that cannot be made (its directory cannot be created: a file is in the way): a problem, not a silent write
  const c = run(`const file = ${JSON.stringify(J(root, 'blocker/sub/l.json'))};`);
  assert.equal(c.problems.length, 1);
  assert.match(c.problems[0], /could not lock .*blocker.sub.l\.json - writing it without the lock .*: E(NOTDIR|EXIST)/);
});

test('lock: a live lock is not taken over by a process whose clock is ahead (a network file system has the server\'s time)', { skip: process.platform === 'win32' }, () => {
  const root = project({});
  fs.mkdirSync(J(root, 'd'));
  fs.writeFileSync(J(root, 'd/l.json.lock'), 'live');
  const script = `const real = Date.now; Date.now = () => real() + 120000; // this machine's clock: two minutes ahead
    const { lock } = require(${JSON.stringify(J(SRC, 'core/lock.cjs'))});
    const problems = require(${JSON.stringify(J(SRC, 'core/problems.cjs'))});
    lock(${JSON.stringify(J(root, 'd/l.json'))}, { wait: 300 }).then((release) => { release(); console.log(JSON.stringify(problems.take())); });`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: strictEnv(undefined), timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).join(), /could not lock/);
  assert.equal(fs.readFileSync(J(root, 'd/l.json.lock'), 'utf8'), 'live');
});

test('lock: a lock dated in the future is stale (it would hold every write off); a live one is not, for a clock behind', { skip: process.platform === 'win32' }, () => {
  const root = project({});
  fs.mkdirSync(J(root, 'd'));
  const run = (clock) => {
    const script = `const real = Date.now; Date.now = () => real() + (${clock});
      const { lock } = require(${JSON.stringify(J(SRC, 'core/lock.cjs'))});
      const problems = require(${JSON.stringify(J(SRC, 'core/problems.cjs'))});
      lock(${JSON.stringify(J(root, 'd/l.json'))}, { wait: 300 }).then((release) => { release(); console.log(JSON.stringify(problems.take())); });`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: strictEnv(undefined), timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  // touch -d 2099: taken over at once, and released
  fs.writeFileSync(J(root, 'd/l.json.lock'), 'future');
  const future = new Date('2099-01-01');
  fs.utimesSync(J(root, 'd/l.json.lock'), future, future);
  assert.deepEqual(run(0), []);
  assert.deepEqual(fs.readdirSync(J(root, 'd')), [], 'nothing left behind');
  // a live lock, by a process whose clock is two minutes behind the file system's: it looks as if from the future
  fs.writeFileSync(J(root, 'd/l.json.lock'), 'live');
  assert.match(run(-120000).join(), /could not lock/);
  assert.equal(fs.readFileSync(J(root, 'd/l.json.lock'), 'utf8'), 'live');
});

test('lock: the temporary file of an atomic write is a new file, never one that is there', { skip: process.platform === 'win32' }, () => {
  const { writeAtomic } = require('../src/core/lock.cjs');
  const root = project({ 'victim.txt': 'mine' });
  const open = fs.openSync, opened = [];
  fs.openSync = function (p, flags, ...rest) { opened.push([path.basename(String(p)), flags]); return open.call(this, p, flags, ...rest); };
  try { writeAtomic(J(root, 'out/file.json'), 'new'); } finally { fs.openSync = open; }
  assert.equal(opened.length, 1);
  assert.match(opened[0][0], /^file\.json\.\d+\.[0-9a-f]{16}\.tmp$/);
  assert.equal(opened[0][1], 'wx');
  assert.equal(fs.readFileSync(J(root, 'out/file.json'), 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(J(root, 'out')), ['file.json']);
  // a file where the temporary file would be (a symbolic link put there): the write fails, and leaves it alone
  const at = J(root, 'out/x.json'), names = crypto.randomBytes;
  crypto.randomBytes = () => Buffer.alloc(8);
  fs.symlinkSync(J(root, 'victim.txt'), `${at}.${process.pid}.0000000000000000.tmp`);
  try { assert.throws(() => writeAtomic(at, 'evil'), /EEXIST/); } finally { crypto.randomBytes = names; }
  assert.equal(fs.readFileSync(J(root, 'victim.txt'), 'utf8'), 'mine');
  assert.equal(fs.existsSync(at), false);
});

test('outputs: a shared lockfile that cannot be read (anything but "not there") is a problem: other processes\' packages would be lost', () => withConfig({ strict: true }, () => {
  problems.take();
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const target = J(root, 'dist', LOCK);
  fs.mkdirSync(target, { recursive: true }); // EISDIR: as EACCES or EMFILE, it hides what the other processes recorded
  const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]);
  assert.deepEqual(lockedNames(outputs.record(target, 'w', [a], root, [], { disk: true })), ['a']);
  const taken = problems.take();
  assert.equal(taken.length, 1, JSON.stringify(taken));
  assert.match(taken[0], /^could not read .*package-lock\.json: the packages other processes recorded there may be missing: EISDIR/);
  // not there, or a file where one of its directories would be: nothing recorded there, no problem
  const none = J(root, 'none', LOCK);
  fs.writeFileSync(J(root, 'none'), 'a file');
  outputs.record(none, 'w', [a], root, [], { disk: true });
  outputs.record(J(root, 'fresh', LOCK), 'w', [a], root, [], { disk: true });
  assert.deepEqual(problems.take(), []);
}));

test('copies of lockfiles: a copy that cannot be re-anchored is a problem (its record would be the original\'s, never followed)', () => withConfig({ strict: true }, async () => {
  const copies = require('../src/core/copies.cjs');
  copies.install();
  problems.take();
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]);
  const target = J(root, 'out/client', LOCK);
  outputs.record(target, 'client', [a], root, [J(root, 'out/client/x.js')], { disk: true });
  outputs.emitted(target, 'client');
  await outputs.rewrite(target, outputs.writeDisk(target));
  const to = J(root, 'build', LOCK);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const rename = fs.renameSync;
  fs.renameSync = (x, y) => { if (y === to) { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; } return rename(x, y); };
  try { fs.copyFileSync(target, to); } finally { fs.renameSync = rename; }
  const taken = problems.take();
  assert.equal(taken.length, 1, JSON.stringify(taken));
  assert.match(taken[0], /^could not write the copy .*build.bundle-lockfile.package-lock\.json of .*client.bundle-lockfile.package-lock\.json: ENOSPC/);
}));

test('outputs: a writer whose first build in this process failed keeps the record its earlier process left for its output', async () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('c'), 'dist/sw.js': 'sw' });
  const [a, c] = ['a', 'c'].map(n => packagesForFiles([J(root, 'node_modules', n, 'i.js')])[0]);
  const target = J(root, 'dist', LOCK);
  // an earlier process wrote sw.js (with c); its writer's id is the one this process's sw compiler has
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, toPackageLock([c], root, { dir: path.dirname(target), writers: [{ id: 'sw-id', files: [J(root, 'dist/sw.js')], paths: [c.path] }] }));
  // this process: sw's build fails (recorded, never written), app's lands - sw.js and its packages are still in dist/
  outputs.record(target, 'sw', [], root, [J(root, 'dist/sw.js')], { disk: true, id: 'sw-id' });
  outputs.record(target, 'app', [a], root, [J(root, 'dist/app.js')], { disk: true, id: 'app-id' });
  outputs.emitted(target, 'app');
  await outputs.rewrite(target, outputs.writeDisk(target)).then((e) => { if (e) throw e; });
  assert.deepEqual(lockedNames(fs.readFileSync(target, 'utf8')), ['a', 'c']);
});

test('outputs: a package-lock.json bundle-lockfile did not write (the project\'s own npm lockfile) is never replaced', async () => {
  // BUNDLE_LOCKFILE_FILE=package-lock.json and an output directory that is the project (Rollup's output.file: 'bundle.js')
  const npm = JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'app' } } }, null, 2);
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'package-lock.json': npm });
  const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]);
  const target = J(root, 'package-lock.json');
  outputs.record(target, 'w', [a], root, [J(root, 'bundle.js')], { disk: true });
  outputs.emitted(target, 'w');
  const write = () => outputs.rewrite(target, outputs.writeDisk(target));
  const err = await write();
  assert.match(err && err.message, /package-lock\.json is there and was not written by bundle-lockfile \(e\.g\. npm's own lockfile\): it is not replaced/);
  assert.equal(fs.readFileSync(target, 'utf8'), npm);
  // one bundle-lockfile wrote: replaced
  fs.unlinkSync(target);
  assert.equal(await write(), undefined);
  assert.equal(await write(), undefined);
  assert.deepEqual(lockedNames(fs.readFileSync(target, 'utf8')), ['a']);
});

test('hashes: a file rewritten with the same size and modification time is hashed again (coarse timestamps, tools that set it)', () => {
  const hashes = require('../src/core/hashes.cjs');
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

test('generated: the content hash of a binary asset is of its bytes (two fonts are not one); text as before', () => {
  const generated = require('../src/core/generated.cjs');
  assert.notEqual(generated.hash(Buffer.from([0x00, 0xff, 0x01])), generated.hash(Buffer.from([0x00, 0xfe, 0x01])));
  assert.equal(generated.hash('x\n//# sourceMappingURL=x.js.map'), generated.hash(Buffer.from('x')));
  assert.equal(generated.hash(new Uint8Array(Buffer.from('ü'))), generated.hash('ü'));
});

// --- settings, the preload and the shim

test('config: BUNDLE_LOCKFILE_FILE is trimmed (only spaces: the default), a backslash is no separator on POSIX; REGISTER must be absolute', () => {
  const fileFor = (v) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BUNDLE_LOCKFILE_')));
    const r = spawnSync(process.execPath, ['-e', `const c = require(${JSON.stringify(J(SRC, 'core/config.cjs'))}); console.log(JSON.stringify({ file: c.file, invalid: c.invalid }))`],
      { env: { ...env, BUNDLE_LOCKFILE_FILE: v }, encoding: 'utf8' });
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(fileFor('   '), { file: 'bundle-lockfile/package-lock.json', invalid: [] });
  assert.deepEqual(fileFor(' sbom/package-lock.json '), { file: 'sbom/package-lock.json', invalid: [] });
  if (path.sep === '/') {
    // a file literally named "sbom\package-lock.json": syft and Trivy read no such file
    for (const v of ['sbom\\package-lock.json', 'node_modules\\x\\package-lock.json']) {
      const { invalid } = fileFor(v);
      assert.equal(invalid.length, 1, v);
      assert.match(invalid[0], /^BUNDLE_LOCKFILE_FILE=.* is not a relative path inside the output directory to a file named package-lock\.json/);
    }
  }
  const one = (vars) => { const { invalid } = invalidFor(vars); assert.equal(invalid.length, 1, JSON.stringify(invalid)); return invalid[0]; };
  assert.match(one({ BUNDLE_LOCKFILE_REGISTER: 'bl/src/register.cjs' }), /^BUNDLE_LOCKFILE_REGISTER is not an absolute path: bl\/src\/register\.cjs/);
});

test('settings file: a value it sets that is not recognized names the file it comes from', () => {
  const s = withSettingsFile({ BUNDLE_LOCKFILE_INLINE: 'yes', BUNDLE_LOCKFILE_ESM_HOOKS: 'later', BUNDLE_LOCKFILE_EXPORT_DIR: 'rel', BUNDLE_LOCKFILE_FILE: 'x.json' });
  const F = `(from the settings file ${s.settings})`;
  assert.ok(s.invalid.some(m => m.startsWith(`BUNDLE_LOCKFILE_INLINE=yes ${F} is not recognized`)), JSON.stringify(s.invalid));
  assert.ok(s.invalid.some(m => m.startsWith(`BUNDLE_LOCKFILE_ESM_HOOKS=later ${F} is none of`)), JSON.stringify(s.invalid));
  assert.ok(s.invalid.some(m => m.startsWith(`BUNDLE_LOCKFILE_EXPORT_DIR is not an absolute path: rel ${F}`)), JSON.stringify(s.invalid));
  assert.ok(s.invalid.some(m => m.startsWith(`BUNDLE_LOCKFILE_FILE=x.json ${F} is not a relative path`)), JSON.stringify(s.invalid));
});

test('register: Node\'s own loader thread (which runs preloads too: Node.js 20, 22.14 and later) reports nothing a second time', { skip: process.platform === 'win32' }, () => {
  const root = project({ 'noop.mjs': 'export async function load(u, c, next) { return next(u, c); }' });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BUNDLE_LOCKFILE_') && k !== 'NODE_OPTIONS'));
  const r = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', pathToFileURLHref(J(root, 'noop.mjs')), '--require', J(SRC, 'register.cjs'), '-e', '0'],
    { encoding: 'utf8', env: { ...env, BUNDLE_LOCKFILE_BOGUS: '1', BUNDLE_LOCKFILE_STRICT: '0' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stderr.match(/BUNDLE_LOCKFILE_BOGUS is set, but is no setting of bundle-lockfile/g) || []).length, 1, r.stderr);
});

test('node shim: a relative BUNDLE_LOCKFILE_REGISTER fails (Node would take it for a package name, in every directory)', { skip: process.platform === 'win32' }, () => {
  const root = project({});
  const env = { PATH: `${path.join(__dirname, '../bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root };
  const run = (vars) => spawnSync('sh', [J(__dirname, '../bin/node'), '-e', 'console.log(process.env.NODE_OPTIONS || "")'], { cwd: J(__dirname, '..'), env: { ...env, ...vars }, encoding: 'utf8' });
  const strict = run({ BUNDLE_LOCKFILE_REGISTER: 'src/register.cjs' }); // there, relative to this directory
  assert.equal(strict.status, 1, strict.stderr);
  assert.match(strict.stderr, /\[bundle-lockfile\] ERROR: node shim: BUNDLE_LOCKFILE_REGISTER is not an absolute path: src\/register\.cjs/);
  const off = run({ BUNDLE_LOCKFILE_REGISTER: 'src/register.cjs', BUNDLE_LOCKFILE_STRICT: '0' });
  assert.equal(off.status, 0, off.stderr);
  assert.equal(off.stdout.trim(), '');
  // a newline around the value: trimmed, as config.cjs does
  assert.equal(run({ BUNDLE_LOCKFILE_REGISTER: 'src/register.cjs', BUNDLE_LOCKFILE_STRICT: '0\n' }).status, 0);
  const abs = run({ BUNDLE_LOCKFILE_REGISTER: J(SRC, 'register.cjs') });
  assert.equal(abs.status, 0, abs.stderr);
  assert.match(abs.stdout, /--require \S*register\.cjs/);
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
  const hooks = require('../src/hooks.cjs');
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
  const hooks = require('../src/hooks.cjs');
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

test('strict: a Node.js without ESM hooks (20.0 - 20.5) fails a bundler process: its ES-module bundlers would not be hooked', () => {
  const root = project({ 'package.json': { name: 'app', devDependencies: { vite: '8.0.0' } }, 'build.cjs': '' });
  const script = (main) => `const M = require('module'); M.registerHooks = undefined; M.register = undefined;
    process.argv[1] = ${JSON.stringify(main)};
    const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
    hooks.register({ name: 'v', esmEntries: [{ id: 'x', suffixes: ['/x.js'], wrap: ['f'] }], esmPackages: ['vite'] });
    hooks.install();`;
  const r = spawnSync(process.execPath, ['-e', script(J(root, 'build.cjs'))], { encoding: 'utf8', env: { ...strictEnv(undefined), BUNDLE_LOCKFILE_ESM_HOOKS: '' }, cwd: root });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /ERROR: Node\.js \S+ has no ESM hooks \(module\.register: 20\.6 and later\): ES-module bundlers are not hooked/);
  const elsewhere = project({ 'x.cjs': '' });
  const e = spawnSync(process.execPath, ['-e', script(J(elsewhere, 'x.cjs'))], { encoding: 'utf8', env: { ...strictEnv(undefined), BUNDLE_LOCKFILE_ESM_HOOKS: '' }, cwd: elsewhere });
  assert.deepEqual([e.status, e.stderr], [0, '']);
});

test('strict: an ES-module bundler in a thread without ESM hooks fails when it loads its CommonJS companion; its CommonJS build does not', () => {
  // a process that bundlerProcess does not take for one (its project has no bundler installed where it looks, and its
  // main script names none): older Node.js (before 22.22.3 / 24.11.1) installs no ESM hooks there. Simulated on every version by taking
  // module.register / registerHooks away before the hooks install.
  const tools = {
    // Rollup: the ES build loads dist/native.js with no CommonJS module of Rollup's before it, the CommonJS one from
    // dist/shared/parseAst.js
    'node_modules/rollup/package.json': { name: 'rollup', version: '4.64.6' },
    'node_modules/rollup/dist/es/package.json': { type: 'module' },
    'node_modules/rollup/dist/es/rollup.js': "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('../native.js');\nexport const rollup = async () => {};\n",
    'node_modules/rollup/dist/native.js': 'module.exports = { parse() {} };\n',
    'node_modules/rollup/dist/shared/parseAst.js': "module.exports = require('../native.js');\n",
    'node_modules/rollup/dist/rollup.js': "require('./shared/parseAst.js');\nexports.rollup = async () => {};\n",
    // Rolldown: its ES build loads its binding's package.json from dist/shared/*.mjs
    'node_modules/rolldown/package.json': { name: 'rolldown', version: '1.2.13', type: 'module' },
    'node_modules/rolldown/dist/shared/binding-x.mjs': "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('@rolldown/binding-linux-x64-gnu/package.json');\nexport const rolldown = async () => {};\n",
    'node_modules/@rolldown/binding-linux-x64-gnu/package.json': { name: '@rolldown/binding-linux-x64-gnu', version: '1.2.13' },
    // rspack 2: its ES module loads @rspack/binding/binding.js
    'node_modules/@rspack/core/package.json': { name: '@rspack/core', version: '2.2.9', type: 'module' },
    'node_modules/@rspack/core/dist/index.js': "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('@rspack/binding/binding.js');\nexport const rspack = () => {};\n",
    'node_modules/@rspack/binding/package.json': { name: '@rspack/binding', version: '2.2.9' },
    'node_modules/@rspack/binding/binding.js': 'module.exports = {};\n',
  };
  const root = project({ ...Object.fromEntries(Object.entries(tools).map(([k, v]) => [`tools/${k}`, v])), 'app/package.json': { name: 'app', version: '1.0.0' } });
  // rspack 1: a CommonJS dist/index.js loads the same binding (and exports rspack() as rspack 1 does: one of another shape
  // is a problem of its own)
  const cjs = project({
    'node_modules/@rspack/core/package.json': { name: '@rspack/core', version: '1.7.12' },
    'node_modules/@rspack/core/dist/index.js': "require('@rspack/binding/binding.js');\nmodule.exports = Object.assign(function rspack() {}, { rspackVersion: '1.7.12',\n  Compiler: class Compiler { compile() {} run() {} watch() {} isChild() {} runAsChild() {} createChildCompiler() {} } });\n",
    'node_modules/@rspack/binding/package.json': { name: '@rspack/binding', version: '1.7.12' },
    'node_modules/@rspack/binding/binding.js': 'module.exports = {};\n',
  });
  const T = (f) => J(root, 'tools/node_modules', f);
  const run = (env, file, how = 'import') => spawnSync(process.execPath, ['-e', `const M = require('module'); M.registerHooks = undefined; M.register = undefined;
    require(${JSON.stringify(J(SRC, 'register.cjs'))});
    (${how === 'import' ? `import(${JSON.stringify(pathToFileURLHref(file))})` : `Promise.resolve().then(() => require(${JSON.stringify(file)}))`})
      .then(() => console.log('loaded'), (e) => { console.log('failed:', e.message); process.exitCode = 3; });`],
  { encoding: 'utf8', cwd: J(root, 'app'), env: { ...strictEnv(env), BUNDLE_LOCKFILE_ESM_HOOKS: '' } });
  for (const [id, file] of [['rollup', T('rollup/dist/es/rollup.js')], ['rolldown', T('rolldown/dist/shared/binding-x.mjs')], ['rspack', T('@rspack/core/dist/index.js')]]) {
    const strict = run(undefined, file);
    assert.match(strict.stdout, new RegExp(`^failed: bundle-lockfile: the lockfile would be missing or incomplete[\\s\\S]*${id} is loaded as an ES module in a process without bundle-lockfile's ESM hooks .*set BUNDLE_LOCKFILE_ESM_HOOKS=async`), `${id}: ${strict.stdout}${strict.stderr}`);
    const lax = run('0', file);
    assert.equal(lax.stdout.trim(), 'loaded', `${id}: ${lax.stderr}`);
    assert.match(lax.stderr, new RegExp(`WARNING: ${id} is loaded as an ES module`), id);
    // turned off: nothing to check; the bundler disabled: nothing either
    const off = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(J(SRC, 'register.cjs'))}); import(${JSON.stringify(pathToFileURLHref(file))}).then(() => console.log('loaded'));`],
      { encoding: 'utf8', cwd: J(root, 'app'), env: { ...strictEnv(undefined), BUNDLE_LOCKFILE_ESM_HOOKS: 'off' } });
    assert.deepEqual([off.stdout.trim(), off.stderr], ['loaded', ''], id);
  }
  const dis = spawnSync(process.execPath, ['-e', `const M = require('module'); M.registerHooks = undefined; M.register = undefined;
    require(${JSON.stringify(J(SRC, 'register.cjs'))}); import(${JSON.stringify(pathToFileURLHref(T('rollup/dist/es/rollup.js')))}).then(() => console.log('loaded'));`],
  { encoding: 'utf8', cwd: J(root, 'app'), env: { ...strictEnv(undefined), BUNDLE_LOCKFILE_ESM_HOOKS: '', BUNDLE_LOCKFILE_DISABLE: 'rollup,vite' } });
  assert.deepEqual([dis.stdout.trim(), dis.stderr], ['loaded', '']);
  // the CommonJS builds load the same files from a module that came through the CommonJS hook: no problem
  for (const file of [T('rollup/dist/rollup.js'), J(cjs, 'node_modules/@rspack/core/dist/index.js')]) {
    const r = run(undefined, file, 'require');
    assert.deepEqual([r.stdout.trim(), r.stderr, r.status], ['loaded', '', 0], file);
  }
  // Yarn's pnpm linker: Rollup in its store (node_modules/.store/<slug>/package) is recognized as node_modules/rollup
  const store = project({ ...Object.fromEntries(Object.entries(tools).filter(([k]) => k.startsWith('node_modules/rollup/'))
    .map(([k, v]) => [k.replace('node_modules/rollup/', 'node_modules/.store/rollup-npm-4.64.6-0123456789/package/'), v])), 'app/package.json': { name: 'app', version: '1.0.0' } });
  const yarn = run(undefined, J(store, 'node_modules/.store/rollup-npm-4.64.6-0123456789/package/dist/es/rollup.js'));
  assert.match(yarn.stdout, /^failed: [\s\S]*rollup is loaded as an ES module in a process without bundle-lockfile's ESM hooks/, yarn.stdout + yarn.stderr);
  // the ESM hooks could not be installed (in a process not taken for a bundler's: a warning): the check is on, too
  const broken = spawnSync(process.execPath, ['-e', `const M = require('module'); M.register = () => { throw new Error('no loader thread'); };
    require(${JSON.stringify(J(SRC, 'register.cjs'))});
    import(${JSON.stringify(pathToFileURLHref(T('rollup/dist/es/rollup.js')))}).then(() => console.log('loaded'), (e) => { console.log('failed:', e.message); process.exitCode = 3; });`],
  { encoding: 'utf8', cwd: J(root, 'app'), env: { ...strictEnv(undefined), BUNDLE_LOCKFILE_ESM_HOOKS: 'async' } });
  assert.match(broken.stderr, /WARNING: could not install the ESM hooks: .*no loader thread/, broken.stderr);
  assert.match(broken.stdout, /^failed: [\s\S]*rollup is loaded as an ES module in a process without bundle-lockfile's ESM hooks/, broken.stdout + broken.stderr);
});

test('hooks: an entry module the in-thread hook cannot wrap fails when it is imported (BUNDLE_LOCKFILE_STRICT=0: a warning)', { skip: !(typeof require('module').registerHooks === 'function' && require('../src/hooks.cjs').syncHooksSafe(process.versions.node)) }, () => {
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

test('Yarn\'s pnpm linker (node_modules/.store/<slug>/package): its packages are listed, its bundlers are recognized', { skip: process.platform === 'win32' }, () => {
  const { logical } = require('../src/core/layout.cjs');
  const esmWrap = require('../src/esm-wrap.cjs');
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
  const generated = require('../src/core/generated.cjs');
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
  const copies = require('../src/core/copies.cjs');
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

test('strict: a bundler an adapter fails to patch is a problem (webpack, rspack, Rollup)', () => withConfig({ strict: true }, () => {
  problems.take();
  const W = fakeCompiler();
  Object.freeze(W.prototype); // patching throws
  webpackAdapter.onCjsLoad(W, '/p/node_modules/webpack/lib/Compiler.js', () => '/p/node_modules/webpack/lib/Compiler.js');
  const R = fakeRspack('2.2.8');
  Object.freeze(R.Compiler.prototype);
  rspackAdapter.onCjsLoad(R, '/p/node_modules/@rspack/core/dist/index.js', () => '/p/node_modules/@rspack/core/dist/index.js');
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const file = '/p/node_modules/rollup/dist/shared/rollup.js';
  rollupAdapter.onCjsLoad(Object.freeze({ version: '4.64.2', rollup() {}, rollupInternal() {} }), file, () => file);
  const taken = problems.take();
  assert.equal(taken.length, 3, JSON.stringify(taken));
  assert.match(taken[0], /^webpack: could not patch .*Compiler\.js: /);
  assert.match(taken[1], /^rspack: could not patch .*index\.js: /);
  assert.match(taken[2], /^rollup: could not patch .*rollup\.js: /);
}));

test('strict: rspack whose Compiler is of an unknown shape is a problem when it loads - from 1.0 on, and 0.x (which is never patched, so it would not fail when it compiles: above)', () => withConfig({ strict: true }, () => {
  problems.take();
  const odd = Object.assign(function rspack() {}, { Compiler: class Compiler { compile() {} }, Compilation: class {}, rspackVersion: '3.0.0' });
  rspackAdapter.onCjsLoad(odd, '/p/x.js', () => '/p/x.js');
  rspackAdapter.onCjsLoad(Object.assign(function rspack() {}, { Compiler: class Compiler {}, rspackVersion: '0.7.5' }), '/p/y.js', () => '/p/y.js');
  const taken = problems.take();
  assert.equal(taken.length, 2, JSON.stringify(taken));
  assert.match(taken[0], /^rspack: the Compiler of rspack 3\.0\.0 \(\/p\/x\.js\) is not one bundle-lockfile knows/);
  assert.match(taken[1], /^rspack 0\.7\.5 \(\/p\/y\.js\) is not supported \(it needs 1\.1 or later\): its builds write no lockfile/);
}));

test('strict: the files copied into the output that cannot be checked fail the compilation', () => withConfig({ strict: true }, () => {
  problems.take();
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const { compiler, taps } = fakeCompiler5({ outputPath: J(root, 'out-copies') });
  compiler.webpack.Compilation = { PROCESS_ASSETS_STAGE_OPTIMIZE: 100 };
  new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
  const comp = compilation({ context: root, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }] });
  Object.assign(comp, { compiler, errors: [], emitAsset: () => {}, hooks: { processAssets: { tap: (o, fn) => (comp.copies = fn) }, afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) } } });
  taps.thisCompilation(comp);
  comp.getAssets = () => { throw new Error('assets gone'); };
  comp.copies();
  delete comp.getAssets;
  comp.getAssets = () => [];
  comp.stage();
  assert.match(comp.errors.map(e => e.message).join(), /webpack: could not check the files copied into .*out-copies: assets gone/);
}));

test('strict: a build that cannot even be failed (its compilation gone) still lets webpack go on: afterEmit calls back, the process fails', () => withConfig({ strict: true }, async () => {
  problems.take();
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const { compiler, taps } = fakeCompiler5({ outputPath: J(root, 'out-gone') });
  new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
  const comp = compilation({ context: root, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'node_modules/a/i.js') }] }] });
  Object.assign(comp, { compiler, errors: [], emitAsset: () => {}, hooks: { afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) } } });
  taps.thisCompilation(comp);
  comp.stage();
  problems.problem('a problem when the build ends');
  comp.errors = Object.freeze([]); // (pushing an error throws)
  const saved = process.exitCode;
  const errors = [], error = config.error;
  config.error = (...a) => errors.push(a.join(' '));
  try {
    const called = await Promise.race([new Promise(resolve => taps.afterEmit(comp, () => resolve(true))), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
    assert.equal(called, true);
    assert.equal(process.exitCode, 1);
    assert.match(errors.join('\n'), /could not fail the build of \S*out-gone/);
  } finally { config.error = error; process.exitCode = saved; }
}));

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

// --- Rollup, Vite, Rolldown

// one output of a build through the plugin's hooks: out (output options), chunks [{ fileName, code, modules }]
async function writeOutput(rollupPlugin, ctx, out, chunks, input) {
  rollupPlugin.buildStart.call(ctx, { input });
  rollupPlugin.renderStart.call(ctx, out);
  for (const c of chunks) rollupPlugin.renderChunk.call(ctx, c.code, { moduleIds: c.modules }, out);
  const bundle = Object.fromEntries(chunks.map(c => [c.fileName, { type: 'chunk', fileName: c.fileName, code: c.code, moduleIds: c.modules, isEntry: true, facadeModuleId: c.modules[0] }]));
  await rollupPlugin.generateBundle.handler.call(ctx, out, bundle, true);
  const dir = out.dir || path.dirname(out.file);
  fs.mkdirSync(dir, { recursive: true });
  for (const c of chunks) fs.writeFileSync(J(dir, c.fileName), c.code);
  await rollupPlugin.writeBundle.handler.call(ctx, out);
}

test('rollup adapter: separate builds of one input into one directory, each with its own output.file (rollup -c with a config array), are writers of their own', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'src/main.js': '' });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    // the bundle with its dependencies, and the same input with them external; Rollup's output options (entryFileNames filled in)
    for (const [file, modules] of [['dist/lib.bundle.js', [J(root, 'src/main.js'), J(root, 'node_modules/a/i.js')]], ['dist/lib.esm.js', [J(root, 'src/main.js')]]]) {
      const rollupPlugin = rollupAdapter.bundleLockfile('rollup', { input: 'src/main.js' });
      const out = { file: J(root, file), format: 'es', entryFileNames: '[name].js' };
      await writeOutput(rollupPlugin, {}, out, [{ fileName: path.basename(file), code: `code of ${file}`, modules }], ['src/main.js']);
      await rollupPlugin.closeBundle.handler.call({});
    }
    const lock = fs.readFileSync(J(root, 'dist', LOCK), 'utf8');
    assert.deepEqual(lockedNames(lock), ['a']);
    assert.deepEqual(recordOf(lock).writers.map(w => w.files).sort(), [['../lib.bundle.js'], ['../lib.esm.js']]);
  } finally { process.chdir(cwd); }
});

test('rollup adapter: Rolldown runs buildStart for every write() of a build: its closeBundle still checks each output for files written after it', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const copies = require('../src/core/copies.cjs');
  copies.install();
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/late/package.json': { name: 'late', version: '1.0.0' },
    'node_modules/late/l.css': 'late bytes', 'src/main.js': '' });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const rollupPlugin = rollupAdapter.bundleLockfile('rolldown', { input: 'src/main.js' });
    const ctx = { meta: { rolldownVersion: '1.2.13' } };
    for (const dir of ['dist-a', 'dist-b']) {
      await writeOutput(rollupPlugin, ctx, { dir: J(root, dir), format: 'es' }, [{ fileName: 'main.js', code: `main of ${dir}`, modules: [J(root, 'src/main.js'), J(root, 'node_modules/a/i.js')] }], 'src/main.js');
    }
    fs.copyFileSync(J(root, 'node_modules/late/l.css'), J(root, 'dist-a/l.css')); // another plugin, after the writes (vite-plugin-static-copy)
    await rollupPlugin.closeBundle.handler.call(ctx);
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist-a', LOCK), 'utf8')), ['a', 'late']);
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist-b', LOCK), 'utf8')), ['a']);
  } finally { process.chdir(cwd); }
});

test('strict: a generate-only build fails with its own problems (a package without a package.json in a worker)', () => withConfig({ strict: true }, async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  problems.take();
  const root = project({ 'node_modules/noversion/package.json': { name: 'noversion' } });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    // in its generateBundle, as for a build that writes (not left for another build, or the process's exit)
    const rollupPlugin = rollupAdapter.bundleLockfile('vite'), ctx = { error(e) { throw e; } }, out = { format: 'es' };
    const modules = [J(root, 'node_modules/noversion/i.js')];
    rollupPlugin.buildStart.call(ctx, {});
    rollupPlugin.renderStart.call(ctx, out);
    await assert.rejects(rollupPlugin.generateBundle.handler.call(ctx, out, { 'w.js': { type: 'chunk', fileName: 'w.js', code: 'worker', moduleIds: modules } }, false),
      (e) => problems.isFailure(e) && /no package\.json with name and version in .*noversion/.test(e.message));
    assert.equal(problems.pending(), false);
  } finally { process.chdir(cwd); }
}));

test('rollup adapter: Vite 8\'s dependency pre-bundling (vite dev) gets no plugin, wherever its cache directory is', () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const options = { input: { lodash: '/p/node_modules/lodash/index.js' }, plugins: [{ name: 'vite:dep-pre-bundle-assets' }, { name: 'vite:dep-pre-bundle' }] };
  assert.equal(rollupAdapter.attach('rolldown', options), options);
  const build = rollupAdapter.attach('rolldown', { input: 'src/main.js', plugins: [{ name: 'vite:build-import-analysis' }] });
  assert.equal(build.plugins.at(-1).name, 'bundle-lockfile');
});

test('rollup adapter: a Rolldown build with Rolldown\'s builtin:vite-* plugins (tsdown) is no Vite build', () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  // tsdown 0.22 adds rolldown/experimental's importGlobPlugin, named builtin:vite-import-glob; Vite's builds have Vite's
  // own JavaScript plugins. Only a Vite build's plugin has the config hook (worker.plugins, Vite's package from its caller).
  const kindOf = (plugins) => (rollupAdapter.attach('rolldown', { input: 'src/index.ts', plugins }).plugins.at(-1).config ? 'vite' : 'rolldown');
  assert.equal(kindOf([{ name: 'builtin:vite-import-glob' }, { name: 'tsdown:external' }]), 'rolldown');
  assert.equal(kindOf([{ name: 'builtin:vite-json' }, { name: 'builtin:vite-resolve' }]), 'rolldown');
  assert.equal(kindOf([{ name: 'builtin:vite-import-glob' }, { name: 'vite:css' }]), 'vite');
  assert.equal(kindOf([[{ name: 'vite:build-html' }]]), 'vite'); // nested plugin arrays
});

test('generated: a package file a worker build emits (a font, wasm) is listed in the build that ships the worker', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/font/package.json': { name: 'font', version: '1.0.0' }, 'src/w.js': '', 'src/main.js': '' });
  const bytes = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff, 0x10]);
  fs.writeFileSync(J(root, 'node_modules/font/f.woff2'), bytes);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    // Vite's worker build: generate-only, the font emitted from its file
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: '', isWrite: false, chunks: [{ fileName: 'w.js', code: 'worker', modules: [J(root, 'src/w.js')], entry: J(root, 'src/w.js') }],
      assets: [{ fileName: 'assets/f-1.woff2', originalFileNames: ['node_modules/font/f.woff2'], source: bytes }] });
    // the parent emits the worker's assets again, without naming the file
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'dist'), chunks: [{ fileName: 'main.js', code: 'main', modules: [J(root, 'src/main.js')] }],
      assets: [{ fileName: 'assets/w.js', source: 'worker' }, { fileName: 'assets/f-1.woff2', source: Buffer.from(bytes) }] });
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['font']);
  } finally { process.chdir(cwd); }
});

test('strict: files written after the build that cannot be checked fail the Rollup build', () => withConfig({ strict: true }, async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  problems.take();
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const cwd = process.cwd();
  process.chdir(root);
  const filesOf = outputs.filesOf;
  try {
    const late = () => { outputs.filesOf = () => { throw new Error('injected'); }; };
    await assert.rejects(rollupBuild(rollupAdapter.bundleLockfile('rollup'), { outDir: J(root, 'dist'), late, ctx: { meta: {} },
      chunks: [{ fileName: 'main.js', code: 'main', modules: [J(root, 'node_modules/a/i.js')] }] }),
    (e) => problems.isFailure(e) && /rollup: could not add the files written into .*dist after the build: injected/.test(e.message));
  } finally { outputs.filesOf = filesOf; process.chdir(cwd); }
}));

// --- vendored copies

test('vendored: pnpm-workspace.yaml with Windows line endings; a private package.json in a vendored copy outside node_modules', () => {
  const vendored = require('../src/core/vendored.cjs');
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

test('webpack adapter: a generate-only build\'s assets still count when files written after the build make the lockfile render again (webpack 5 keeps only sizes then)', async () => {
  const generated = require('../src/core/generated.cjs');
  const copies = require('../src/core/copies.cjs');
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

test('config: BUNDLE_LOCKFILE_ESM_HOOKS=sync is invalid on a Node.js without module.registerHooks', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BUNDLE_LOCKFILE_')));
  const run = (value, without) => {
    const r = spawnSync(process.execPath, ['-e', `${without ? "require('module').registerHooks = undefined;" : "require('module').registerHooks = () => {};"}
      console.log(JSON.stringify(require(${JSON.stringify(J(SRC, 'core/config.cjs'))}).invalid))`], { env: { ...env, BUNDLE_LOCKFILE_ESM_HOOKS: value }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(run('sync', true), [`BUNDLE_LOCKFILE_ESM_HOOKS=sync needs module.registerHooks, which Node.js ${process.versions.node} does not have (22.15 and later): ES-module bundlers would not be hooked`]);
  assert.deepEqual(run(' Sync ', false), []);
  assert.deepEqual(run('async', true), []);
  assert.deepEqual(run('off', true), []);
});

test('strict: an entry wrapper evaluated where bundle-lockfile is not loaded fails its import (BUNDLE_LOCKFILE_STRICT=0: a warning)', () => {
  const esmWrap = require('../src/esm-wrap.cjs');
  const root = project({ 'rollup.mjs': 'export function rollup() { return 1; }' });
  const url = pathToFileURLHref(J(root, 'rollup.mjs'));
  const entry = { id: 'rollup', suffixes: ['/rollup.mjs'], wrap: ['rollup'] };
  fs.writeFileSync(J(root, 'strict.mjs'), esmWrap.source(url, 'export function rollup() {}', entry, true));
  fs.writeFileSync(J(root, 'warn.mjs'), esmWrap.source(url, 'export function rollup() {}', entry, false));
  const load = (f) => nodeWith(strictEnv('0'), ['--input-type=module', '-e',
    `try { const m = await import(${JSON.stringify(pathToFileURLHref(J(root, f)))}); console.log('loaded', m.rollup()); } catch (e) { console.log('failed:', e.message); }`]);
  const msg = `${url} is wrapped, but bundle-lockfile is not loaded in this thread: its builds would write no lockfile`;
  const strict = load('strict.mjs');
  assert.equal(strict.stdout, `failed: bundle-lockfile: ${msg} (BUNDLE_LOCKFILE_STRICT=0 makes this a warning)\n`, strict.stderr);
  const warn = load('warn.mjs');
  assert.equal(warn.stdout, 'loaded 1\n', warn.stderr);
  assert.equal(warn.stderr, `[bundle-lockfile] WARNING: ${msg}\n`);
  // with the API (the hooks installed in the thread): no message
  const hooked = nodeWith(strictEnv(undefined), ['--input-type=module', '-e',
    `globalThis[Symbol.for('bundle-lockfile.esm')] = { wrap: (id, n, fn) => () => 2, found() {} };
     const m = await import(${JSON.stringify(pathToFileURLHref(J(root, 'strict.mjs')))}); console.log('loaded', m.rollup());`]);
  assert.deepEqual([hooked.stdout, hooked.stderr], ['loaded 2\n', '']);
});

test('test helper: the canary check decodes data: URLs (base64 and percent-encoded)', () => {
  const { dataUrls, canaries } = require('./lib/check.cjs');
  const svg = "<svg><!-- BLCANARY:bl-canary-icon@1.0.0 --></svg>";
  const b64 = `url(data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')})`;
  const pct = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
  assert.deepEqual(dataUrls(`${b64} a ${pct} data:text/plain,%E0%A4%A`), [svg, svg]); // (a malformed one is skipped)
  const root = project({ 'dist/a.css': b64, 'dist/b.css': pct.replace('bl-canary-icon', 'bl-canary-other') });
  assert.deepEqual(canaries(J(root, 'dist')), ['bl-canary-icon@1.0.0', 'bl-canary-other@1.0.0']);
});
test('webpack adapter: directories among a module\'s file dependencies (webpack 5 snapshots) are no files it inlined', () => {
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('@vanilla-extract/webpack-plugin'), 'node_modules/@vanilla-extract/webpack-plugin/loader/dist/x.js': '' });
  const nm = (f) => J(root, 'node_modules', f);
  const c = compilation({ context: root, chunks: [{ files: ['main.js'], modules: [{ resource: J(root, 'src/styles.css.js'), buildInfo: { snapshot: {
    getFileIterable: () => [J(root, 'src/styles.css.js'), nm('@vanilla-extract'), nm('@vanilla-extract/webpack-plugin'), nm('@vanilla-extract/webpack-plugin/loader/dist')] } } }] }] });
  assert.deepEqual(lockedNames(plugin().lockfile(c)), []);
});

test('strict: builds bundle-lockfile recognizes but does not hook fail (the rolldown command line, Next.js with Turbopack, ncc, Parcel); STRICT=0: a warning', () => {
  const root = project({
    'node_modules/rolldown/package.json': { name: 'rolldown', version: '1.2.13', type: 'module' },
    'node_modules/rolldown/bin/cli.mjs': "console.log('built');\n",
    // next build: Next sets TURBOPACK when it builds with Turbopack (auto: by default), NEXT_RSPACK with next-rspack;
    // next build ends with process.exit()
    'node_modules/next/package.json': { name: 'next', version: '16.4.0' },
    'node_modules/next/dist/bin/next': "if (process.env.FAKE_BUNDLER) process.env[process.env.FAKE_BUNDLER] = 'auto';\nconsole.log('built');\nprocess.exit(0);\n",
    'node_modules/@vercel/ncc/package.json': { name: '@vercel/ncc', version: '0.38.4' },
    'node_modules/@vercel/ncc/dist/ncc/index.js': 'module.exports = () => {};\n',
    'ncc.cjs': "try { require('@vercel/ncc/dist/ncc/index.js'); console.log('loaded'); } catch (e) { console.log('failed:', e.message); process.exitCode = 3; }\n",
  });
  const spawnNode = (env, args) => spawnSync(process.execPath, ['--require', J(SRC, 'register.cjs'), ...args], { cwd: root, encoding: 'utf8', env: { ...strictEnv(env.STRICT), ...env } });
  const ROLLDOWN = /the rolldown command line is not hooked: its builds write no lockfile/;
  const TURBO = /Next\.js built with Turbopack, which bundle-lockfile does not hook: no lockfile \(build with next build --webpack, or with next-rspack\)/;
  // strict: the process fails (at exit: there is no build to fail), or the module's require()
  let r = spawnNode({}, [J(root, 'node_modules/rolldown/bin/cli.mjs')]);
  assert.deepEqual([r.status, r.stdout.trim()], [1, 'built']);
  assert.match(r.stderr, ROLLDOWN);
  r = spawnNode({ FAKE_BUNDLER: 'TURBOPACK' }, [J(root, 'node_modules/next/dist/bin/next'), 'build']);
  assert.deepEqual([r.status, r.stdout.trim()], [1, 'built'], r.stderr);
  assert.match(r.stderr, TURBO);
  r = spawnNode({}, [J(root, 'ncc.cjs')]);
  assert.match(r.stdout, /^failed: bundle-lockfile: the lockfile would be missing or incomplete[\s\S]*@vercel\/ncc builds with a webpack of its own/);
  // STRICT=0: warnings, and the builds go on
  r = spawnNode({ STRICT: '0' }, [J(root, 'node_modules/rolldown/bin/cli.mjs')]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /WARNING: the rolldown command line is not hooked/);
  r = spawnNode({ STRICT: '0', FAKE_BUNDLER: 'TURBOPACK' }, [J(root, 'node_modules/next/dist/bin/next'), 'build']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /WARNING: Next\.js built with Turbopack/);
  r = spawnNode({ STRICT: '0' }, [J(root, 'ncc.cjs')]);
  assert.equal(r.stdout.trim(), 'loaded');
  assert.match(r.stderr, /WARNING: @vercel\/ncc builds with a webpack of its own/);
  // not these: next build with webpack (no TURBOPACK) or next-rspack, next dev, rolldown disabled
  for (const [env, args] of [[{}, ['build']], [{ FAKE_BUNDLER: 'NEXT_RSPACK' }, ['build']], [{ FAKE_BUNDLER: 'TURBOPACK' }, ['dev']]]) {
    r = spawnNode(env, [J(root, 'node_modules/next/dist/bin/next'), ...args]);
    assert.deepEqual([r.status, r.stderr], [0, ''], JSON.stringify([env, args]));
  }
  r = spawnNode({ BUNDLE_LOCKFILE_DISABLE: 'rolldown' }, [J(root, 'node_modules/rolldown/bin/cli.mjs')]);
  assert.deepEqual([r.status, r.stderr], [0, '']);
  r = spawnNode({ BUNDLE_LOCKFILE_DISABLE: 'all' }, [J(root, 'ncc.cjs')]);
  assert.deepEqual([r.status, r.stdout.trim(), r.stderr], [0, 'loaded', '']);
  // Yarn's pnpm linker: the main script in its store (node_modules/.store/<slug>/package) is recognized as well
  for (const [name, bin] of [['rolldown', 'bin/cli.mjs'], ['next', 'dist/bin/next']]) {
    const at = J(root, `node_modules/.store/${name}-npm-1.0.0-0123456789/package`);
    fs.mkdirSync(path.dirname(J(at, bin)), { recursive: true });
    fs.copyFileSync(J(root, 'node_modules', name, 'package.json'), J(at, 'package.json'));
    fs.copyFileSync(J(root, 'node_modules', name, bin), J(at, bin));
  }
  r = spawnNode({}, [J(root, 'node_modules/.store/rolldown-npm-1.0.0-0123456789/package/bin/cli.mjs')]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, ROLLDOWN);
  r = spawnNode({ FAKE_BUNDLER: 'TURBOPACK' }, [J(root, 'node_modules/.store/next-npm-1.0.0-0123456789/package/dist/bin/next'), 'build']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, TURBO);
});

test('strict: webpack before 4 (a Compiler without hooks) fails the process when it compiles; STRICT=0: a warning', () => {
  const compiler = "class Compiler { compile(cb) { cb && cb(null); } run() { this.compile(); } watch() {} newCompilation() {} isChild() { return false; } }\nmodule.exports = Compiler;\n";
  const root = project({
    'node_modules/webpack/package.json': { name: 'webpack', version: '3.12.0' },
    'node_modules/webpack/lib/Compiler.js': compiler,
    'build.cjs': "const Compiler = require('webpack/lib/Compiler.js');\nrequire('webpack/lib/Compiler.js');\nconsole.log('loaded');\nnew Compiler().run();\nconsole.log('built');\n",
    'load.cjs': "require('webpack/lib/Compiler.js');\nconsole.log('loaded');\n",
  });
  const spawnNode = (strict, file) => spawnSync(process.execPath, ['--require', J(SRC, 'register.cjs'), J(root, file)], { cwd: root, encoding: 'utf8', env: strictEnv(strict) });
  let r = spawnNode(undefined, 'build.cjs');
  assert.deepEqual([r.status, r.stdout.trim()], [1, 'loaded\nbuilt']);
  assert.match(r.stderr, /webpack before 4 is not supported \(a Compiler without hooks, from \S+Compiler\.js\): its builds write no lockfile/);
  r = spawnNode('0', 'build.cjs');
  assert.equal(r.status, 0);
  assert.match(r.stderr, /WARNING: webpack before 4 is not supported/);
  // loaded only (an old copy among a project's packages): nothing
  r = spawnNode(undefined, 'load.cjs');
  assert.deepEqual([r.status, r.stderr], [0, '']);
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
  const r = spawnSync(process.execPath, [J(__dirname, 'oracles/esm-entries.cjs')], { cwd: root, encoding: 'utf8' });
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

// Rolldown's plugin context classes, as in its dist (1.0, 1.2): PluginContextImpl and its subclasses for load and
// transform, each with an addWatchFile of its own; data: the build's (one PluginContextData per build)
function rolldownContexts({ loadClass = true } = {}) {
  const calls = [];
  class PluginContextImpl {
    constructor(data) { this.data = data; this.meta = { rolldownVersion: '1.2.13' }; }
    addWatchFile(f) { calls.push(['base', f]); return 'base-result'; }
  }
  class LoadPluginContextImpl extends PluginContextImpl {
    constructor(data, id) { super(data); this.currentLoadingModule = id; }
    addWatchFile(f) { calls.push(['load', f]); }
  }
  class TransformPluginContextImpl extends PluginContextImpl {
    constructor(data, id) { super(data); this.moduleId = id; }
    addWatchFile(f) { calls.push(['transform', f]); }
  }
  return { calls, base: (d) => new PluginContextImpl(d), load: loadClass ? (d, id) => new LoadPluginContextImpl(d, id) : (d) => new PluginContextImpl(d),
    transform: (d, id) => new TransformPluginContextImpl(d, id) };
}

test('rolldown-watch: addWatchFile of Rolldown\'s plugin contexts, recorded per build and per module', () => {
  const rw = require('../src/adapters/rolldown-watch.cjs');
  const r = rolldownContexts();
  const a = {}, b = {}; // two builds (vite build --app's environments; watch mode's builds)
  assert.equal(rw.start(r.base(a)), null);
  assert.equal(rw.start(r.base(b)), null);
  // the subclasses inherit the wrapped base: each is wrapped itself (the marker is an own property)
  for (const d of [a, b]) { assert.equal(rw.wrap(r.load(d, 'x')), null); assert.equal(rw.wrap(r.transform(d, 'x')), null); }
  // the original is called, with its this and its result
  const t = r.transform(a, '/p/src/app.css');
  t.addWatchFile('/p/node_modules/s/s.css');
  r.load(a, '/p/src/shader.glsl').addWatchFile('/p/node_modules/g/n.glsl');
  assert.equal(r.base(a).addWatchFile('/p/node_modules/c/c.json'), 'base-result'); // no module: the whole build's
  r.transform(b, '/p/src/other.css').addWatchFile('/p/node_modules/o/o.css');
  assert.deepEqual(r.calls.map(c => c[0]), ['transform', 'load', 'base', 'transform']); // each once
  assert.deepEqual(rw.filesOf(r.base(a), ['/p/src/app.css', '/p/src/shader.glsl']).sort(), ['/p/node_modules/c/c.json', '/p/node_modules/g/n.glsl', '/p/node_modules/s/s.css']);
  assert.deepEqual(rw.filesOf(r.base(a), ['/p/src/app.css']).sort(), ['/p/node_modules/c/c.json', '/p/node_modules/s/s.css']); // only this output's modules
  assert.deepEqual(rw.filesOf(r.base(b), ['/p/src/app.css', '/p/src/other.css']), ['/p/node_modules/o/o.css']); // the builds do not mix
  // a module loaded again (watch mode): its records start over
  rw.loading(r.base(a), '/p/src/app.css');
  assert.deepEqual(rw.filesOf(r.base(a), ['/p/src/app.css']), ['/p/node_modules/c/c.json']);
  // a build whose start was not seen: none known
  assert.equal(rw.filesOf(r.base({}), ['/p/src/app.css']), null);
  // a second copy of Rolldown: its own classes, wrapped too
  const r2 = rolldownContexts({ loadClass: false }); // 1.0 betas: the load hook's context is a PluginContextImpl
  const c = {};
  assert.equal(rw.start(r2.base(c)), null);
  assert.equal(rw.wrap(r2.load(c)), null);
  r2.load(c).addWatchFile('/p/node_modules/l/l.svg'); // no module known: the whole build's
  assert.deepEqual(rw.filesOf(r2.base(c), []), ['/p/node_modules/l/l.svg']);
  // a subclass without an addWatchFile of its own: the one it inherits is wrapped, once
  class Inherits extends Object.getPrototypeOf(r2.base(c)).constructor {}
  assert.equal(rw.wrap(new Inherits(c)), null);
  r2.calls.length = 0;
  new Inherits(c).addWatchFile('/p/node_modules/i/i.css');
  assert.equal(r2.calls.length, 1);
  // a shape bundle-lockfile does not know
  assert.match(rw.start({ data: {} }), /no addWatchFile/);
  assert.match(rw.wrap(Object.create({ addWatchFile() {} })), /no build data/);
});

test('rollup adapter: Rolldown build() and watch() - the files plugins inlined, from the plugin contexts (no build object)', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('sanitize.css'), ...pj('icons'), ...pj('glsl'), ...pj('other'), ...pj('a') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const nm = (name, f) => J(root, 'node_modules', name, f);
    const r = rolldownContexts();
    const data = {};
    const rollupPlugin = rollupAdapter.bundleLockfile('vite'); // also the plugin from a config: Rolldown's hooks are there
    const ctx = r.base(data);
    const app = J(root, 'src/app.css'), shader = J(root, 'src/shader.glsl'), unused = J(root, 'src/unused.css');
    // the hooks run as Rolldown runs them: buildStart, then per module load and transform (bundle-lockfile's first)
    rollupPlugin.buildStart.call(ctx, {});
    for (const id of [app, shader, unused]) {
      const l = r.load(data, id);
      rollupPlugin.load.handler.call(l, id);
      if (id === shader) l.addWatchFile(nm('glsl', 'noise.glsl'));
      const t = r.transform(data, id);
      rollupPlugin.transform.handler.call(t, 'code', id);
      if (id === app) { t.addWatchFile(nm('sanitize.css', 'sanitize.css')); t.addWatchFile(nm('icons', 'bell.svg')); }
      if (id === unused) t.addWatchFile(nm('other', 'o.css')); // a module in no chunk of this output
    }
    const out = { dir: J(root, 'dist'), format: 'es' };
    rollupPlugin.renderStart.call(ctx, out);
    rollupPlugin.renderChunk.call(ctx, '', { moduleIds: [app, shader, nm('a', 'i.js')] }, out);
    const bundle = { 'i.js': { type: 'chunk', fileName: 'i.js', code: 'i', moduleIds: [app, shader, nm('a', 'i.js')] }, 'i.css': { type: 'asset', fileName: 'i.css', source: 'css' } };
    await rollupPlugin.generateBundle.handler.call(ctx, out, bundle, true);
    fs.mkdirSync(J(root, 'dist'), { recursive: true });
    for (const f of Object.values(bundle)) fs.writeFileSync(J(root, 'dist', f.fileName), f.code || f.source);
    await rollupPlugin.writeBundle.handler.call(ctx, out);
    await rollupPlugin.closeBundle.handler.call(ctx);
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['a', 'glsl', 'icons', 'sanitize.css']);
  } finally { process.chdir(cwd); }
});

test('strict: a Rolldown build with style whose inlined files cannot be read fails; without style it does not', () => withConfig({ strict: true }, async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    problems.take();
    // a Rolldown of another shape: its plugin context has no addWatchFile
    const ctx = { meta: { rolldownVersion: '9.0.0' }, data: {}, error(e) { throw e; } };
    const style = [{ fileName: 'main.js', code: 'main', modules: [J(root, 'src/app.css'), J(root, 'node_modules/a/i.js')] }];
    await assert.rejects(rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'dist'), chunks: style, ctx }),
      (e) => problems.isFailure(e) && /Rolldown 9\.0\.0: could not read the files its plugins inlined \(its plugin context has no addWatchFile\): style sheets @imported from packages would be missing/.test(e.message));
    // the same with the build rolldown() returned: its watch files have them
    const rollupPlugin = rollupAdapter.bundleLockfile('vite');
    rollupPlugin.api.setBuild({ get watchFiles() { return Promise.resolve([]); } });
    await rollupBuild(rollupPlugin, { outDir: J(root, 'dist2'), chunks: style, ctx });
    // no style: nothing would be missing that the build could have inlined from a style sheet
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'dist3'), chunks: [{ fileName: 'main.js', code: 'm', modules: [J(root, 'node_modules/a/i.js')] }], ctx });
    assert.equal(problems.pending(), false);
  } finally { process.chdir(cwd); }
}));

test('STRICT=0: a Rolldown build with style whose inlined files cannot be read warns and writes its lockfile', () => withConfig({ strict: false }, async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const cwd = process.cwd();
  process.chdir(root);
  const orig = config.warn, seen = [];
  config.warn = (...a) => seen.push(a.join(' '));
  try {
    problems.take();
    const ctx = { meta: { rolldownVersion: '9.0.0' }, data: {}, error(e) { throw e; } };
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'dist'), ctx,
      chunks: [{ fileName: 'main.js', code: 'main', modules: [J(root, 'src/app.css'), J(root, 'node_modules/a/i.js')] }] });
    assert.match(seen.join('\n'), /Rolldown 9\.0\.0: could not read the files its plugins inlined/);
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['a']);
  } finally { config.warn = orig; process.chdir(cwd); }
}));

test('rollup adapter: Rollup\'s watch mode - the transform dependencies of the modules a rebuild takes from the cache', async () => {
  const rollupAdapter = require('../src/adapters/rollup.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('sanitize.css'), ...pj('glsl'), ...pj('a') });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const css = J(root, 'node_modules/sanitize.css/sanitize.css'), noise = J(root, 'node_modules/glsl/noise.glsl');
    const app = J(root, 'src/app.css'), shader = J(root, 'src/shader.glsl'), a = J(root, 'node_modules/a/i.js');
    const rollupPlugin = rollupAdapter.bundleLockfile('vite');
    // a build: options (with the cache Rollup's watcher passes), then the transforms of the modules not taken from it
    const build = async ({ cache, transform, modules, watch }) => {
      rollupPlugin.options({ input: 'x', cache });
      const ctx = { meta: { rollupVersion: '4.64.2', watchMode: true }, getWatchFiles: () => watch, getModuleIds: () => modules.values() };
      const run = { ...rollupPlugin, buildStart(o) { rollupPlugin.buildStart.call(this, o); for (const id of transform) rollupPlugin.transform.handler.call(this, '', id); } };
      // (code no other test's chunks have: generate-only builds' chunks are matched by content, process-wide)
      await rollupBuild(run, { outDir: J(root, 'dist'), chunks: [{ fileName: 'i.js', code: 'rebuilt from the cache', modules }], ctx });
      return lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8'));
    };
    assert.deepEqual(await build({ cache: undefined, transform: [app, shader, a], modules: [app, shader, a], watch: [app, shader, a, css, noise] }), ['a', 'glsl', 'sanitize.css']);
    // rebuilt without the shader: src/app.css from the cache (no watch file of this build has its @import)
    const cache = { modules: [{ id: app, transformDependencies: [css] }, { id: shader, transformDependencies: [noise] }, { id: a, transformDependencies: [] }] };
    assert.deepEqual(await build({ cache, transform: [], modules: [app, a], watch: [app, a] }), ['a', 'sanitize.css']);
    // src/app.css transformed again, without its @import: the cache's dependencies of it do not count
    assert.deepEqual(await build({ cache, transform: [app], modules: [app, a], watch: [app, a] }), ['a']);
  } finally { process.chdir(cwd); }
});

test('children: a node started with an environment that drops bundle-lockfile\'s --require warns once (the node shim: put back)', () => {
  const root = project({
    'parent.cjs': `const cp = require('child_process'), { Worker, SHARE_ENV } = require('worker_threads'), util = require('util');
      const has = "process.stdout.write(String((process.env.NODE_OPTIONS || '').includes('register.cjs')))";
      const out = (r) => String(r.stdout);
      const results = [];
      results.push(out(cp.spawnSync(process.execPath, ['-e', has], { env: { PATH: process.env.PATH } })));      // dropped
      results.push(out(cp.spawnSync(process.execPath, ['-e', has], { env: { ...process.env } })));             // kept
      results.push(out(cp.spawnSync(process.execPath, ['-e', has])));                                          // inherited
      results.push(String(cp.execFileSync('sh', ['-c', 'printf %s "$NODE_OPTIONS" | grep -c register.cjs || true'], { env: { PATH: process.env.PATH } })).trim()); // no node
      util.promisify(cp.execFile)(process.execPath, ['-e', has], { env: { ...process.env } }).then(async (r) => {
        results.push(typeof r === 'object' && 'stdout' in r && 'stderr' in r ? 'promisified' : 'broken');
        for (const env of [{}, SHARE_ENV]) {
          await new Promise((resolve) => { const w = new Worker('1', { eval: true, env }); w.on('exit', resolve); });
        }
        results.push(Worker.name);
        console.log(JSON.stringify(results));
      });`,
  });
  const run = (env) => spawnSync(process.execPath, [J(root, 'parent.cjs')], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: `--require ${J(SRC, 'register.cjs')}`, ...env } });
  const r = run({});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), ['false', 'true', 'true', '0', 'promisified', 'Worker']);
  assert.equal((r.stderr.match(/WARNING: node \(spawnSync -e\) is started with an environment whose NODE_OPTIONS lacks bundle-lockfile's --require: a bundler in it is not hooked/g) || []).length, 1, r.stderr);
  assert.equal((r.stderr.match(/WARNING:/g) || []).length, 1, r.stderr); // once per process: not again for the worker
  // with the node shim: the --require is put back, no warning
  const shim = run({ BUNDLE_LOCKFILE_NODE_SHIM: '/opt/bl/bin/node' });
  assert.equal(shim.status, 0, shim.stderr);
  assert.deepEqual(JSON.parse(shim.stdout.trim().split('\n').pop()).slice(0, 3), ['true', 'true', 'true']);
  assert.doesNotMatch(shim.stderr, /WARNING/);
  // the --require on the command line (not in NODE_OPTIONS) reaches no child anyway: nothing to say
  const cmdline = spawnSync(process.execPath, ['--require', J(SRC, 'register.cjs'), J(root, 'parent.cjs')], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(cmdline.status, 0, cmdline.stderr);
  assert.doesNotMatch(cmdline.stderr, /WARNING/);
  // a relative --require is put back by its absolute path: a child in another directory finds it
  fs.symlinkSync(SRC, J(root, 'bl'), 'dir');
  fs.mkdirSync(J(root, 'elsewhere'));
  fs.writeFileSync(J(root, 'rel.cjs'), `const r = require('child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(String(!!globalThis[Symbol.for("bundle-lockfile.settings-reported")]))'],
    { cwd: ${JSON.stringify(J(root, 'elsewhere'))}, env: { PATH: process.env.PATH }, encoding: 'utf8' });
    console.log(JSON.stringify([r.status, r.stdout]));`);
  const rel = spawnSync(process.execPath, [J(root, 'rel.cjs')], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '--require ./bl/register.cjs', BUNDLE_LOCKFILE_NODE_SHIM: '/opt/bl/bin/node' } });
  assert.equal(rel.status, 0, rel.stderr);
  assert.deepEqual(JSON.parse(rel.stdout.trim()), [0, 'true'], rel.stderr);
});

test('generated: more chunks than kept warns once; packages of generate-only chunks no written output had warn when the process ends', () => {
  const lru = require('../src/core/lru.cjs');
  const m = new Map();
  assert.deepEqual([lru.set(m, 'a', 1, 2), lru.set(m, 'b', 1, 2), lru.set(m, 'c', 1, 2), [...m.keys()]], [false, false, true, ['b', 'c']]);
  const gen = JSON.stringify(J(SRC, 'core/generated.cjs'));
  const run = (code) => spawnSync(process.execPath, ['-e', `const g = require(${gen}); const p = (n) => ({ name: n, version: '1.0.0', path: '/p/node_modules/' + n });\n${code}`],
    { encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BUNDLE_LOCKFILE_'))) });
  // a chunk whose bytes reached no output, and no lockfile of the process lists its packages
  let r = run("g.addChunk('chunk one', [p('a'), p('b')]); g.addChunk('chunk two', [p('b')]);");
  assert.equal(r.status, 0);
  assert.match(r.stderr, /WARNING: the output of a build that writes nothing itself \(generate\(\), write: false\) reached no output this process wrote, so no lockfile lists a@1\.0\.0, b@1\.0\.0 /);
  // its bytes were found (in a written chunk or asset), or its entry was imported (?worker&inline): nothing to say
  r = run("g.addChunk('chunk one', [p('a')]); g.byContent('chunk one');");
  assert.deepEqual([r.status, r.stderr], [0, '']);
  r = run("g.addChunk('chunk one', [p('a')]); g.addEntry('/p/w.js', [p('a')]); g.byEntry('/p/w.js');");
  assert.deepEqual([r.status, r.stderr], [0, '']);
  // more than 10000: the oldest are forgotten, once said
  r = run("for (let i = 0; i < 10002; i++) { g.addChunk('c' + i, [p('a')]); g.byContent('c' + i); }");
  assert.equal(r.status, 0);
  assert.equal((r.stderr.match(/WARNING: more than 10000 chunks of builds that write nothing themselves/g) || []).length, 1, r.stderr);
});

// The CommonJS hook in a child process: hooks.cjs with `adapter` (source of an object), after `before` ran; no ESM hooks
const cjsHookScript = (adapter, before = '', after = '') => `const Module = require('module');
  ${before}
  const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
  hooks.register(${adapter});
  hooks.install();
  ${after}`;
const cjsEnv = (strict) => ({ ...strictEnv(strict), BUNDLE_LOCKFILE_ESM_HOOKS: 'off' });

test('strict: a Node.js without the CommonJS hook points fails a process that builds with webpack, and is silent elsewhere', () => {
  const root = project({ 'package.json': { name: 'app', devDependencies: { webpack: '5.0.0' } }, 'build.cjs': '' });
  const elsewhere = project({ 'package.json': { name: 'tool' }, 'x.cjs': '' });
  // (hooks.cjs is loaded first: loading a module needs _compile)
  const script = (main) => `const Module = require('module'); process.argv[1] = ${JSON.stringify(main)};
    const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
    hooks.register({ name: 'w', onCjsLoad() {}, cjsFiles: [/[\\\\/]x\\.cjs$/], cjsPackages: ['webpack'] });
    const compile = Module.prototype._compile; Module.prototype._compile = undefined;
    hooks.install();
    Module.prototype._compile = compile;`;
  const msg = /Node\.js \S+ has no Module\.prototype\._compile: CommonJS bundlers \(webpack, rspack 1, Rollup's CommonJS build, esbuild, Parcel, Angular's builder, Next\.js' build\) are not hooked/;
  const strict = spawnSync(process.execPath, ['-e', script(J(root, 'build.cjs'))], { encoding: 'utf8', env: cjsEnv(undefined), cwd: root });
  assert.equal(strict.status, 1, strict.stderr);
  assert.match(strict.stderr, new RegExp(`ERROR: ${msg.source}`));
  const off = spawnSync(process.execPath, ['-e', script(J(root, 'build.cjs'))], { encoding: 'utf8', env: cjsEnv('0'), cwd: root });
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stderr, new RegExp(`WARNING: ${msg.source}`));
  const other = spawnSync(process.execPath, ['-e', script(J(elsewhere, 'x.cjs'))], { encoding: 'utf8', env: cjsEnv(undefined), cwd: elsewhere });
  assert.deepEqual([other.status, other.stderr], [0, '']);
});

test('strict: a Node.js without the CommonJS hook points fails a process that builds with any CommonJS adapter\'s bundler, by its own package', () => {
  // every adapter that hooks CommonJS modules says which packages make a process one that builds with it: a process
  // that builds only with that bundler (no webpack, no Vite installed) must not go unhooked without a word
  const adapters = ['webpack', 'rollup', 'rspack', 'esbuild', 'parcel', 'angular', 'next'].map(n => [n, require(J(SRC, 'adapters', `${n}.cjs`))]);
  for (const [n, a] of adapters) if (a.onCjsLoad) assert.ok([...(a.cjsPackages || []), ...(a.esmPackages || [])].length, `${n} adapter: no cjsPackages`);
  for (const [name, dep] of [['parcel', 'parcel'], ['parcel', '@parcel/core'], ['angular', '@angular/cli'], ['angular', '@angular/build'], ['angular', '@angular-devkit/build-angular'], ['next', 'next'], ['esbuild', 'esbuild']]) {
    const root = project({ 'package.json': { name: 'app', devDependencies: { [dep]: '1.0.0' } }, 'build.cjs': '' });
    const script = `const Module = require('module'); process.argv[1] = ${JSON.stringify(J(root, 'build.cjs'))};
      const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
      hooks.register(require(${JSON.stringify(J(SRC, 'adapters', `${name}.cjs`))}));
      const compile = Module.prototype._compile; Module.prototype._compile = undefined;
      hooks.install();
      Module.prototype._compile = compile;`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: cjsEnv(undefined), cwd: root });
    assert.equal(r.status, 1, `${name} with ${dep}: ${r.stderr}`);
    assert.match(r.stderr, /ERROR: Node\.js \S+ has no Module\.prototype\._compile: CommonJS bundlers .* are not hooked/, `${name} with ${dep}`);
  }
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

test('strict: a bundler module that ran past the CommonJS hook fails the process at exit (BUNDLE_LOCKFILE_STRICT=0: a warning)', () => {
  const root = project({ 'node_modules/webpack/lib/Compiler.js': 'module.exports = class Compiler {};', 'node_modules/other/lib/Compiler.js': '' });
  const file = J(root, 'node_modules/webpack/lib/Compiler.js');
  // a loader that compiles a module itself, as ncc's or a test runner's: in require.cache, never through _compile
  const past = (f) => `{ const m = new Module(${JSON.stringify(f)}); m.filename = ${JSON.stringify(f)}; m.loaded = true; Module._cache[${JSON.stringify(f)}] = m; }`;
  const adapter = "{ name: 'webpack', onCjsLoad() {}, cjsFiles: [/[\\\\/]webpack[\\\\/]lib[\\\\/]Compiler\\.js$/] }";
  const msg = 'ran past bundle-lockfile\'s CommonJS hook (a loader that compiles modules itself): the bundler in it was not patched, its builds wrote no lockfile';
  const strict = nodeWith(cjsEnv(undefined), ['-e', cjsHookScript(adapter, '', past(file))]);
  assert.equal(strict.status, 1, strict.stderr);
  assert.ok(strict.stderr.includes(`ERROR: ${file} ${msg}`), strict.stderr);
  const off = nodeWith(cjsEnv('0'), ['-e', cjsHookScript(adapter, '', past(file))]);
  assert.equal(off.status, 0, off.stderr);
  assert.ok(off.stderr.includes(`WARNING: ${file} ${msg}`), off.stderr);
  // loaded through the hook, or another file that ran past it: nothing to say
  const hooked = nodeWith(cjsEnv(undefined), ['-e', cjsHookScript(adapter, '', `require(${JSON.stringify(file)}); ${past(J(root, 'node_modules/other/lib/Compiler.js'))}`)]);
  assert.deepEqual([hooked.status, hooked.stderr], [0, '']);
  // loaded before the hooks were installed: reported when they are, so not past them
  const early = nodeWith(cjsEnv(undefined), ['-e', cjsHookScript(adapter, `require(${JSON.stringify(file)});`)]);
  assert.deepEqual([early.status, early.stderr], [0, '']);
});

test('strict: an adapter that fails on a module it patches (cjsFiles) fails its require(); on other modules only warns', () => {
  const root = project({ 'node_modules/webpack/lib/Compiler.js': 'module.exports = class Compiler {};', 'node_modules/x/index.js': '' });
  const adapter = "{ name: 'webpack', onCjsLoad(exp, request) { if (/node_modules/.test(request)) throw new Error('boom'); }, cjsFiles: [/[\\\\/]webpack[\\\\/]lib[\\\\/]Compiler\\.js$/] }";
  const load = (f) => `try { require(${JSON.stringify(f)}); console.log('loaded'); } catch (e) { console.log('failed:', e.message.split('\\n')[1]); }`;
  const file = J(root, 'node_modules/webpack/lib/Compiler.js');
  const strict = nodeWith(cjsEnv(undefined), ['-e', cjsHookScript(adapter, '', load(file))]);
  assert.equal(strict.stdout, `failed:   webpack adapter failed on ${file}: its builds would write no lockfile: boom\n`, strict.stderr);
  const off = nodeWith(cjsEnv('0'), ['-e', cjsHookScript(adapter, '', load(file))]);
  assert.equal(off.stdout, 'loaded\n');
  assert.match(off.stderr, /WARNING: webpack adapter failed on .*Compiler\.js: its builds would write no lockfile: Error: boom/);
  const other = nodeWith(cjsEnv(undefined), ['-e', cjsHookScript(adapter, '', load(J(root, 'node_modules/x/index.js')))]);
  assert.equal(other.stdout, 'loaded\n');
  assert.match(other.stderr, /WARNING: webpack adapter failed while inspecting .*index\.js:/);
});

test('strict: @rspack/core of an unknown shape fails its require() - from 1.0 on, and 0.x (one it patches fails when it compiles)', () => {
  const at = (version, src) => project({ 'node_modules/@rspack/core/package.json': { name: '@rspack/core', version }, 'node_modules/@rspack/core/dist/index.js': src });
  const adapter = `require(${JSON.stringify(J(SRC, 'adapters/rspack.cjs'))})`;
  const run = (root, strict) => nodeWith(cjsEnv(strict), ['-e', cjsHookScript(adapter, '',
    `try { require(${JSON.stringify(J(root, 'node_modules/@rspack/core/dist/index.js'))}); console.log('loaded'); } catch (e) { console.log('failed:', e.message.split('\\n')[1]); }`)]);
  const unknown = at('1.7.0', 'module.exports = { rspack() {} };');
  const file = J(unknown, 'node_modules/@rspack/core/dist/index.js');
  const msg = `rspack: ${file} (rspack 1.7.0) exports no rspack() with rspackVersion and Compiler, as bundle-lockfile knows it: its builds would write no lockfile`;
  assert.equal(run(unknown, undefined).stdout, `failed:   ${msg}\n`);
  const off = run(unknown, '0');
  assert.equal(off.stdout, 'loaded\n');
  assert.ok(off.stderr.includes(`WARNING: ${msg}`), off.stderr);
  const oldAt = at('0.7.5', 'module.exports = { rspack() {} };');
  const old = run(oldAt, undefined);
  assert.equal(old.stdout, `failed:   rspack 0.7.5 (${J(oldAt, 'node_modules/@rspack/core/dist/index.js')}) is not supported (it needs 1.1 or later): its builds write no lockfile\n`, old.stderr);
  // rspack 2's ES module through require(esm), as its namespace (no "module.exports" export): patched (on a Node.js that
  // can require() an ES module: 20.19, 22.12 and later)
  if (!process.features.require_module) return;
  const esm = at('2.2.8', "export class Compiler { compile() {} run() {} watch() {} isChild() {} runAsChild() {} createChildCompiler() {} } export const rspackVersion = '2.2.8';");
  fs.writeFileSync(J(esm, 'node_modules/@rspack/core/package.json'), JSON.stringify({ name: '@rspack/core', version: '2.2.8', type: 'module' }));
  const ns = nodeWith(cjsEnv(undefined), ['-e', cjsHookScript(adapter, '',
    `console.log(require(${JSON.stringify(J(esm, 'node_modules/@rspack/core/dist/index.js'))}).Compiler.prototype[Symbol.for('bundle-lockfile.rspack.patched')]);`)]);
  assert.equal(ns.stdout, 'true\n', ns.stderr);
  assert.doesNotMatch(ns.stderr, /bundle-lockfile/); // (Node.js may warn that require(esm) is experimental)
});

// Next.js' file traces (core/traces.cjs) and the server's runtime packages (adapters/next.cjs)
const traces = require('../src/core/traces.cjs');
const nextAdapter = () => require('../src/adapters/next.cjs');
const nft = (files, extra = {}) => ({ version: 1, files, ...extra });

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

// a project with a fake next build (next/dist/build/index.js and build-context.js) and traces; returns
// { root, build(): the wrapped build function, ctx: Next's build context }
function fakeNext(files, ctx = () => ({})) {
  const root = project({
    'package.json': { name: 'app', private: true },
    'node_modules/next/package.json': { name: 'next', version: '16.4.0' },
    'node_modules/next/dist/build/build-context.js': 'exports.NextBuildContext = {};',
    'node_modules/next/dist/build/index.js': '',
    'node_modules/next/dist/server/next-server.js': '',
    'node_modules/rt/package.json': { name: 'rt', version: '1.0.0', license: 'MIT' },
    'node_modules/rt/index.js': '',
    'node_modules/legacy/package.json': { name: 'legacy', version: '2.0.0' },
    'node_modules/legacy/lib/x.cjs': '',
    '.next/server/chunks/1.js': '',
    '.next/next-server.js.nft.json': nft(['../node_modules/next/dist/server/next-server.js']),
    '.next/server/pages/index.js.nft.json': nft(['../../../node_modules/rt/index.js', '../../../node_modules/legacy/lib/x.cjs', '../chunks/1.js']),
    ...files,
  });
  const buildFile = J(root, 'node_modules/next/dist/build/index.js');
  const context = require(J(root, 'node_modules/next/dist/build/build-context.js')).NextBuildContext;
  Object.assign(context, { dir: root, distDir: J(root, '.next'), config: { distDir: '.next' }, ...ctx(root) });
  let ran = 0;
  const exp = {};
  Object.defineProperty(exp, 'default', { enumerable: true, get: () => async () => { ran++; return 'built'; } }); // Next's getter exports
  const copy = nextAdapter().onCjsLoad(exp, buildFile, () => buildFile).exports;
  return { root, build: () => copy.default(root), ran: () => ran, copy };
}
const runtimeLock = (root, at = '.next/runtime') => JSON.parse(fs.readFileSync(J(root, at, LOCK), 'utf8'));

test('next adapter: after next build, the packages of its traces in .next/runtime/bundle-lockfile (also Next itself, not first-party files)', () => withConfig({ strict: true }, async () => {
  const { root, build, ran, copy } = fakeNext({}, () => ({}));
  assert.equal(copy.__esModule, true); // ES-module interop: next build's own require of it gets the copy's default
  problems.take();
  assert.equal(await build(), 'built');
  assert.equal(ran(), 1);
  const lock = runtimeLock(root);
  assert.deepEqual(Object.entries(lock.packages).filter(([k]) => k).map(([k, p]) => `${k} ${p.name}@${p.version}`),
    ['node_modules/legacy legacy@2.0.0', 'node_modules/next next@16.4.0', 'node_modules/rt rt@1.0.0']);
  const [w] = lock['bundle-lockfile'].writers;
  assert.deepEqual(w.bundler, { name: 'next', version: '16.4.0' });
  assert.deepEqual(w.via, { traced: [0, 1, 2] });
  assert.equal(fs.existsSync(J(root, '.next/standalone')), false);
  assert.equal(problems.count(), 0);
}));

test('next adapter: no traces (output: export) writes nothing; Next.js 12 (no build context) takes distDir from the config its build loaded', () => withConfig({ strict: true }, async () => {
  const none = fakeNext({ '.next/next-server.js.nft.json': nft([]), '.next/server/pages/index.js.nft.json': nft([]) }, () => ({}));
  fs.rmSync(J(none.root, '.next/next-server.js.nft.json')); fs.rmSync(J(none.root, '.next/server/pages/index.js.nft.json'));
  await none.build();
  assert.equal(fs.existsSync(J(none.root, '.next/runtime')), false);
  // Next.js 12: server/config.js's default export (a plain property) is wrapped; the build reads the config through it
  const root = project({
    'node_modules/next/package.json': { name: 'next', version: '12.3.7' },
    'node_modules/next/dist/build/index.js': '',
    'node_modules/rt/package.json': { name: 'rt', version: '1.0.0' },
    'node_modules/rt/index.js': '',
    'out12/server/pages/index.js.nft.json': nft(['../../../node_modules/rt/index.js']),
  });
  const a = nextAdapter();
  const configFile = J(root, 'node_modules/next/dist/server/config.js');
  const confExp = { default: async (phase) => ({ distDir: phase === 'phase-production-build' ? 'out12' : 'x' }) };
  a.onCjsLoad(confExp, configFile, () => configFile);
  const buildFile = J(root, 'node_modules/next/dist/build/index.js');
  const copy = a.onCjsLoad({ default: async function build(dir) { await confExp.default('phase-production-build', dir); } }, buildFile, () => buildFile).exports;
  await copy.default(root);
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'out12/runtime', LOCK), 'utf8')), ['rt']);
}));

test('next adapter: output: standalone - the runtime packages in .next/standalone, keyed where Next copied them; the bundles\' lockfiles copied along', () => withConfig({ strict: true }, async () => {
  const { root, build } = fakeNext({
    '.next/standalone/server.js': '',
    '.next/standalone/node_modules/rt/index.js': '',
    '.next/standalone/node_modules/rt/package.json': { name: 'rt', version: '1.0.0', license: 'MIT' },
    '.next/standalone/node_modules/legacy/lib/x.cjs': '', // no package.json: Next copies only traced files
    '.next/standalone/.next/server/chunks/1.js': '',
    '.next/server/chunks/bundle-lockfile/package-lock.json': '{"lockfileVersion":3,"packages":{"":{}}}',
    '.next/bundle-lockfile/package-lock.json': '{"lockfileVersion":3,"packages":{"":{}}}',
  }, () => ({ config: { distDir: '.next', output: 'standalone' } }));
  await build();
  const lock = runtimeLock(root, '.next/standalone');
  assert.deepEqual(Object.keys(lock.packages).filter(Boolean), ['node_modules/legacy', 'node_modules/next', 'node_modules/rt']);
  assert.equal(lock['bundle-lockfile'].context, '../../..'); // anchored where the packages are installed (the tracing root)
  // the server output's directory is in .next/standalone: its lockfile goes along; the client's (.next) too
  assert.equal(fs.existsSync(J(root, '.next/standalone/.next/server/chunks', LOCK)), true);
  assert.equal(fs.existsSync(J(root, '.next/standalone/.next', LOCK)), true);
  assert.equal(fs.existsSync(J(root, '.next/standalone/runtime')), false);
}));

test('next adapter: an unreadable trace, or a traced package without package.json, fails next build (strict); STRICT=0 warns', async () => {
  for (const strict of [true, false]) {
    await withConfig({ strict }, async () => {
      const bad = fakeNext({ '.next/server/pages/broken.js.nft.json': '{' }, () => ({}));
      problems.take();
      if (strict) await assert.rejects(bad.build(), /could not read .*broken\.js\.nft\.json.*the server's runtime packages are unknown/s);
      else { const w = await (async () => { const seen = []; const orig = config.warn; config.warn = (...m) => seen.push(m.join(' ')); try { await bad.build(); } finally { config.warn = orig; } return seen; })(); assert.match(w.join('\n'), /broken\.js\.nft\.json/); }
      problems.take();
      const nopj = fakeNext({ 'node_modules/nopj/i.js': '', '.next/server/pages/n.js.nft.json': nft(['../../../node_modules/nopj/i.js']) }, () => ({}));
      if (strict) await assert.rejects(nopj.build(), /no package\.json with name and version in .*nopj/);
      else await nopj.build();
      problems.take();
    });
  }
});

test('next adapter: a next/dist/build of a shape it does not know fails (strict); BUNDLE_LOCKFILE_DISABLE takes next', () => withConfig({ strict: true }, async () => {
  problems.take();
  const f = '/p/node_modules/next/dist/build/index.js';
  assert.equal(nextAdapter().onCjsLoad({ build: () => {} }, f, () => f), undefined);
  assert.match(problems.take().join('\n'), /exports no build function bundle-lockfile knows/);
  assert.equal(nextAdapter().onCjsLoad({ default: () => {} }, '/p/node_modules/other/dist/build/index.js', () => '/p/x'), undefined); // not Next's
  assert.equal(problems.count(), 0);
  const r = nodeWith({ ...strictEnv(undefined), BUNDLE_LOCKFILE_DISABLE: 'next' }, ['-e', `require(${JSON.stringify(J(SRC, 'core/config.cjs'))}); console.log(require(${JSON.stringify(J(SRC, 'core/config.cjs'))}).isDisabled('next'))`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'true');
}));

// Transpiler helpers inlined into modules (core/helpers.cjs): the names in the code after the loaders or plugins, not in
// the file; the transpiler copy the loader resolves (webpack) or this process loaded (Rollup, Vite, Rolldown)
test('helpers: Babel, swc and TypeScript helpers by their names; only those the file does not have count', () => {
  const helpers = require('../src/core/helpers.cjs');
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
  const helpers = require('../src/core/helpers.cjs');
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
