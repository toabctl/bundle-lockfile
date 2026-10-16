'use strict';
// Unit tests of the Next.js adapter.
// All unit tests: node --test test/unit/*.test.cjs (see test/README.md)
// (helpers.cjs first: see there)
const {
  packagesForFiles, strictEnv, nodeWith, SRC, J, project, LOCK, lockedNames, withConfig, nft,
} = require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { toPackageLock } = require('../../src/core/lockfile.cjs');
const config = require('../../src/core/config.cjs');
const problems = require('../../src/core/problems.cjs');

const nextAdapter = () => require('../../src/adapters/next.cjs');

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

test('next adapter: a static export gets the client\'s lockfile in <out>/_next/, its record for where it is (output: export, next export)', () => withConfig({ strict: true }, async () => {
  require('../../src/core/copies.cjs').install();
  problems.take();
  const files = (distDir) => ({
    'node_modules/a/package.json': { name: 'a', version: '1.0.0' },
    [`${distDir}/static/chunks/main.js`]: '',
    'node_modules/next/dist/export/index.js': '',
  });
  // a fake Next export: copies <distDir>/static to <outdir>/_next/static, as Next's does (fs.cp of the directory)
  const fakeExport = (root, distDir) => async (dir, options) => {
    fs.cpSync(J(root, distDir, 'static'), J(options.outdir, '_next/static'), { recursive: true });
    return 'exported';
  };
  // the client compiler's lockfile in <distDir>, written by bundle-lockfile in another process (Next's build workers):
  // this one knows nothing of it but its record
  const clientLock = async (root, distDir) => {
    const [a] = packagesForFiles([J(root, 'node_modules/a/i.js')]);
    const dir = J(root, distDir, path.dirname(LOCK));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(J(root, distDir, LOCK), toPackageLock([a], root, { dir, writers: [{ id: 'client', files: [J(root, distDir, 'static/chunks/main.js')], paths: [a.path] }] }));
  };
  const exportFile = (root) => J(root, 'node_modules/next/dist/export/index.js');
  const wrapped = (root, distDir) => nextAdapter().onCjsLoad({ default: fakeExport(root, distDir) }, exportFile(root), () => exportFile(root)).exports.default;

  // output: 'export' (Next.js 13.3 - 15: options.nextConfig, distDir the config's)
  let root = project(files('.next'));
  await clientLock(root, '.next');
  assert.equal(await wrapped(root, '.next')(root, { outdir: J(root, 'out'), nextConfig: { distDir: '.next', output: 'export' } }), 'exported');
  const copy = JSON.parse(fs.readFileSync(J(root, 'out/_next', LOCK), 'utf8'));
  assert.deepEqual(lockedNames(JSON.stringify(copy)), ['a']);
  assert.equal(copy['bundle-lockfile'].context, '../../..'); // anchored where it is: out/_next/bundle-lockfile -> the project
  // Next's internal export into <distDir>/export (buildExport) is none
  root = project(files('.next'));
  await clientLock(root, '.next');
  await wrapped(root, '.next')(root, { outdir: J(root, '.next/export'), buildExport: true, nextConfig: { distDir: '.next' } });
  assert.equal(fs.existsSync(J(root, '.next/export/_next', LOCK)), false);
  // Next.js 16: a custom distDir names the export's destination, the build is in .next (its export/utils.js)
  root = project({ ...files('.next'), 'node_modules/next/dist/export/utils.js': "exports.getBuildDistDir = (c) => (c.output === 'export' && c.distDir !== '.next' ? '.next' : c.distDir);" });
  await clientLock(root, '.next');
  await wrapped(root, '.next')(root, { outdir: J(root, 'site'), nextConfig: { distDir: 'site', output: 'export' } }, {}, { worker: true });
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'site/_next', LOCK), 'utf8')), ['a']);
  // `next export` (Next.js 12, 13): the config as the export loads it (server/config.js), a custom distDir
  root = project({ ...files('build'), 'node_modules/next/dist/server/config.js': "exports.default = async (phase) => ({ distDir: phase === 'phase-export' ? 'build' : 'wrong' });" });
  await clientLock(root, 'build');
  await wrapped(root, 'build')(root, { outdir: J(root, 'out') });
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'out/_next', LOCK), 'utf8')), ['a']);
  // ... Next.js 12 passes the config as the 4th argument
  root = project(files('dist12'));
  await clientLock(root, 'dist12');
  await wrapped(root, 'dist12')(root, { outdir: J(root, 'out') }, {}, { distDir: 'dist12' });
  assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'out/_next', LOCK), 'utf8')), ['a']);
  // no client lockfile (BUNDLE_LOCKFILE_DISABLE=webpack): nothing, and no problem
  root = project(files('.next'));
  await wrapped(root, '.next')(root, { outdir: J(root, 'out'), nextConfig: { distDir: '.next' } });
  assert.equal(fs.existsSync(J(root, 'out/_next/bundle-lockfile')), false);
  assert.deepEqual(problems.take(), []);
  // an export module of another shape: a problem
  const f = '/p/node_modules/next/dist/export/index.js';
  assert.equal(nextAdapter().onCjsLoad({ exportApp: () => {} }, f, () => f), undefined);
  assert.match(problems.take().join('\n'), /exports no export function bundle-lockfile knows/);
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
