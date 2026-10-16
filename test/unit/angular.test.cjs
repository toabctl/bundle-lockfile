'use strict';
// Unit tests of the Angular builder's adapter.
// All unit tests: node --test test/unit/*.test.cjs (see test/README.md)
// (helpers.cjs first: see there)
const {
  J, project, UNIT, notUnit, LOCK, lockedNames, withConfig, recordOf,
} = require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { exportPath } = require('../../src/core/paths.cjs');
const problems = require('../../src/core/problems.cjs');

// Angular: executeBuild() of a fake application builder, whose result has Angular's shape (ExecutionResult)
// (main: the name of its one chunk, which Angular hashes)
function fakeExecuteBuild(root, { stats = 'split', inputs, assets = [], errors = [], more = [], main = 'main.js' } = {}) {
  return async (options) => {
    const outputFiles = [{ path: main, type: 0, text: 'x' }, ...more];
    const result = { outputFiles, assetFiles: assets.map(source => ({ source, destination: 'a' })), errors: [...errors],
      addOutputFile(p, text, type) { outputFiles.push({ path: p, type, text }); }, addError(e) { this.errors.push(e); } };
    const metafile = { outputs: { [main]: { entryPoint: 'src/main.ts', inputs: Object.fromEntries(inputs.map(i => [i, { bytesInOutput: 1 }])) } } };
    if (options.stats) {
      if (stats === 'split') outputFiles.push({ path: 'browser-stats.json', type: 4, text: JSON.stringify(metafile) });
      else outputFiles.push({ path: 'stats.json', type: 4, text: JSON.stringify(metafile) });
    }
    return result;
  };
}

test('angular adapter: executeBuild with stats on; the lockfile added to its output files; the stats taken out again unless asked for', () => withConfig({ strict: true }, async () => {
  const angular = require('../../src/adapters/angular.cjs');
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

test('angular adapter: a side whose directory is the output path itself (browser or server \'\') - the lockfile and its record where Angular writes the side\'s files', () => withConfig({ strict: true }, async () => {
  const angular = require('../../src/adapters/angular.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('b'), ...pj('s'), ...pj('r'), ...pj('u'), ...pj('esbuild'), 'src/main.ts': '' });
  // browser: '' (the browser-esbuild builder of @angular-devkit/build-angular always has it): Angular writes the browser
  // files into dist/ - the lockfile there, its record saying so; a media file (a font of a style sheet) is one of its files
  const r = await angular.wrap(fakeExecuteBuild(root, { inputs: ['node_modules/a/i.js'], more: [{ path: 'media/f.woff2', type: 1, text: 'x' }] }))(
    { workspaceRoot: root, outputOptions: { base: J(root, 'dist'), browser: '', server: 'server' } });
  assert.deepEqual(r.errors, []);
  const lock = r.outputFiles.find(f => f.path === LOCK);
  assert.equal(lock.type, 0);
  const rec = recordOf(lock.text);
  assert.deepEqual([rec.context, rec.self], ['../..', 'dist/bundle-lockfile']);
  assert.deepEqual(rec.writers[0].files.sort(), ['../main.js', '../media/f.woff2']);
  // server: '' (SSR: Angular requires browser and server to differ): the server's lockfile a root file at <file>, the
  // browser's then a root file at browser/<file> - Angular 17 - 21 key the files they write by their path in their
  // side's directory, where both would be <file>
  for (const stats of ['split', 'combined']) {
    const ssr = await angular.wrap(fakeSsrBuild({ stats }))({ workspaceRoot: root, outputOptions: { base: J(root, 'ssr'), browser: 'browser', server: '' } });
    assert.deepEqual(ssr.errors, [], stats);
    const locks = ssr.outputFiles.filter(f => /bundle-lockfile/.test(f.path));
    assert.deepEqual(locks.map(f => `${f.type} ${f.path}`).sort(), [`4 browser/${LOCK}`, `4 ${LOCK}`], stats);
    const server = locks.find(f => f.path === LOCK), browser = locks.find(f => f.path === `browser/${LOCK}`);
    assert.equal(recordOf(server.text).self, 'ssr/bundle-lockfile', stats);
    assert.equal(recordOf(browser.text).self, 'ssr/browser/bundle-lockfile', stats);
    assert.deepEqual(lockedNames(server.text), ['esbuild', 'r', 's', 'u'], stats);
  }
}));

test('angular adapter: a build that fails (on a problem, or a compile error) writes nothing - no export copy either', () => withConfig({ strict: true }, async () => {
  const angular = require('../../src/adapters/angular.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/nopj/i.js': '',
    'node_modules/esbuild/package.json': { name: 'esbuild', version: '1.0.0' }, 'src/main.ts': '' });
  const options = { workspaceRoot: root, outputOptions: { base: J(root, 'dist'), browser: 'browser', server: 'server' } };
  await withConfig({ exportDir: J(root, 'export'), exportBase: root }, async () => {
    const exported = exportPath(J(root, 'dist/browser', LOCK));
    const bad = await angular.wrap(fakeExecuteBuild(root, { inputs: ['node_modules/nopj/i.js'] }))(options);
    assert.match(bad.errors.join('\n'), /no package\.json with name and version in \S*nopj/);
    assert.equal(fs.existsSync(exported), false);
    // (control: the same build without the problem writes it)
    const good = await angular.wrap(fakeExecuteBuild(root, { inputs: ['node_modules/a/i.js'] }))(options);
    assert.deepEqual(good.errors, []);
    assert.deepEqual(lockedNames(fs.readFileSync(exported, 'utf8')), ['a', 'esbuild']);
    // a build that fails for Angular's own reasons (a compile error: Angular writes none of its files, also in watch
    // mode, where the output of the last good build stays): nothing recorded, the export copy left as it is - the next
    // good build's lockfile has none of the failed build's packages
    const before = fs.readFileSync(exported, 'utf8');
    const ts = await angular.wrap(fakeExecuteBuild(root, { inputs: ['node_modules/nopj/i.js', 'node_modules/b/i.js'], errors: ['TS2322'] }))(options);
    assert.deepEqual(ts.errors, ['TS2322']); // (no problem of bundle-lockfile's: nopj not even looked at)
    assert.deepEqual(ts.outputFiles.map(f => f.path), ['main.js']);
    assert.equal(fs.readFileSync(exported, 'utf8'), before);
    const again = await angular.wrap(fakeExecuteBuild(root, { inputs: ['node_modules/a/i.js'] }))(options);
    assert.deepEqual(again.errors, []);
    assert.deepEqual(recordOf(fs.readFileSync(exported, 'utf8')).writers.length, 1);
    assert.deepEqual(lockedNames(fs.readFileSync(exported, 'utf8')), ['a', 'esbuild']);
  });
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
  const angular = require('../../src/adapters/angular.cjs');
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
  const angular = require('../../src/adapters/angular.cjs');
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
  // a locale whose subPath is '' (its copy in the side's own directory): one lockfile there with one writer, its files and
  // the packages of both (here: no server)
  const atRoot = async (o) => {
    const r = await build('split')(o);
    const kept = r.outputFiles.filter(f => f.type !== 2 && !f.path.startsWith('server')).map(f => (f.path.startsWith('en-US/') ? { ...f, path: f.path.slice(6) } : f));
    r.outputFiles.splice(0, Infinity, ...kept); // (the array addOutputFile adds to)
    return r;
  };
  const root2 = await angular.wrap(atRoot)({ ...options, i18nOptions: { ...i18nOptions, locales: { de: { subPath: 'de' }, 'en-US': { subPath: '' } } } });
  assert.deepEqual(root2.errors, []);
  const byPath = Object.fromEntries(root2.outputFiles.filter(f => /bundle-lockfile/.test(f.path)).map(f => [f.path, f.text]));
  assert.deepEqual(Object.keys(byPath).sort(), [LOCK, `de/${LOCK}`]);
  assert.deepEqual(recordOf(byPath[LOCK]).writers.map(w => w.files), [['../main.js']]);
  assert.deepEqual(lockedNames(byPath[LOCK]), ['a', 'esbuild']);
  // flatOutput (one locale, the dev server's): one copy, no locale directory
  const flat = await angular.wrap(build('split'))({ ...options, i18nOptions: { ...i18nOptions, flatOutput: true } });
  assert.deepEqual(flat.outputFiles.filter(f => /bundle-lockfile/.test(f.path)).map(f => f.path).sort(), [LOCK, `server/${LOCK}`]);
  // locales of a shape bundle-lockfile does not know: an error of the build
  const bad = await angular.wrap(build('split'))({ ...options, i18nOptions: { ...i18nOptions, locales: { de: {}, 'en-US': {} } } });
  assert.match(bad.errors.join('\n'), /an i18n build whose locales have no subPath/);
}));

test('angular adapter: builds of the builders whose output nobody ships (ng serve, extract-i18n, karma, unit-test) get no lockfile and no stats; other builders\' do', () => withConfig({ strict: true }, async () => {
  const angular = require('../../src/adapters/angular.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' }, 'node_modules/esbuild/package.json': { name: 'esbuild', version: '1.0.0' }, 'src/main.ts': '' });
  const options = { workspaceRoot: root, outputOptions: { base: J(root, 'dist'), browser: 'browser', server: 'server' } };
  let seen = null;
  const inner = fakeExecuteBuild(root, { inputs: ['node_modules/a/i.js'] });
  const run = angular.wrap(async (o, context) => { seen = { o, context }; return inner(o); });
  const context = (builderName) => ({ builder: { builderName, description: '', optionSchema: {} } });
  const saved = process.env.NG_BUILD_PARTIAL_SSR;
  await withConfig({ exportDir: J(root, 'export'), exportBase: root }, async () => {
    try {
      for (const name of ['@angular/build:dev-server', '@angular-devkit/build-angular:dev-server', '@angular-builders/custom-esbuild:dev-server',
        '@angular/build:extract-i18n', '@angular/build:karma', '@angular-devkit/build-angular:karma', '@angular/build:unit-test']) {
        // (the dev server sets partialSSRBuild)
        const c = context(name);
        const r = await run({ ...options, partialSSRBuild: name.endsWith(':dev-server') }, c);
        assert.deepEqual(r.outputFiles.map(f => f.path), ['main.js'], name); // no lockfile, no stats
        assert.equal(seen.o.stats, undefined, name); // the options as the builder made them
        assert.equal(seen.context, c, name);
        assert.equal(fs.existsSync(J(root, 'export')), false, name); // no export copy
      }
      // the application builders write, also with partialSSRBuild (ng build with NG_BUILD_PARTIAL_SSR, whatever its
      // value) - and a build without a builder's context (executeBuild called by hand)
      for (const [name, partial] of [['@angular/build:application', undefined], ['@angular/build:application', '0'], ['@angular/build:application', '1'],
        ['@angular-devkit/build-angular:browser-esbuild', undefined], ['@angular-builders/custom-esbuild:application', undefined], [null, undefined]]) {
        if (partial === undefined) delete process.env.NG_BUILD_PARTIAL_SSR; else process.env.NG_BUILD_PARTIAL_SSR = partial;
        const r = await run({ ...options, partialSSRBuild: partial !== undefined }, name === null ? undefined : context(name));
        assert.deepEqual(r.errors, [], name);
        assert.deepEqual(r.outputFiles.map(f => f.path), ['main.js', LOCK], `${name} ${partial}`);
      }
      assert.ok(fs.existsSync(exportPath(J(root, 'dist/browser', LOCK))));
    } finally { if (saved === undefined) delete process.env.NG_BUILD_PARTIAL_SSR; else process.env.NG_BUILD_PARTIAL_SSR = saved; }
  });
}));

test('angular adapter: a build in a new process over the output of an earlier one lists only its own packages when Angular empties the output path first (outputOptions.clean)', () => withConfig({ strict: true }, async () => {
  const angular = require('../../src/adapters/angular.cjs');
  const pj = (name) => ({ [`node_modules/${name}/package.json`]: { name, version: '1.0.0' } });
  const root = project({ ...pj('a'), ...pj('gone'), ...pj('esbuild'), 'src/main.ts': '' });
  const browser = J(root, 'dist/browser');
  // Angular writes the files of a build (after it emptied the output path, if it does)
  const write = (r) => { for (const f of r.outputFiles) { fs.mkdirSync(require('path').dirname(J(browser, f.path)), { recursive: true }); fs.writeFileSync(J(browser, f.path), f.text); } };
  for (const clean of [true, false]) {
    fs.rmSync(J(root, 'dist'), { recursive: true, force: true });
    const options = { workspaceRoot: root, outputOptions: { base: J(root, 'dist'), browser: 'browser', server: 'server', clean } };
    write(await angular.wrap(fakeExecuteBuild(root, { inputs: ['node_modules/a/i.js', 'node_modules/gone/i.js'], main: 'main-OLD.js' }))(options));
    globalThis[Symbol.for('bundle-lockfile.outputs.v5')].files.clear(); // (the next ng build: a new process)
    // the next build no longer has `gone`, and its chunk another hash: main-OLD.js is still there while it renders the
    // lockfile - Angular deletes it after (clean); without clean it stays in the output, with its packages
    const r = await angular.wrap(fakeExecuteBuild(root, { inputs: ['node_modules/a/i.js'], main: 'main-NEW.js' }))(options);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(lockedNames(r.outputFiles.find(f => f.path === LOCK).text), clean ? ['a', 'esbuild'] : ['a', 'esbuild', 'gone'], `clean=${clean}`);
  }
}));
