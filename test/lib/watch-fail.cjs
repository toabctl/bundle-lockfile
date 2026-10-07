'use strict';
// Watch-mode build of two compilers sharing dist/ through webpack's Node API (cwd = fixture edge-shared-output).
// After a good first build, app's entry switches to an import that does not resolve: its compilation fails and is
// not emitted (production: emitOnErrors false), so its previous output stays in dist/. The lockfile must keep
// listing that output's packages, also after sw rebuilds and rewrites it. Prints the package list of the shared
// lockfile after every build as JSON on the last line.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { LOCKFILE, readLockfile } = require('./check.cjs');

const req = createRequire(path.join(process.cwd(), 'package.json'));
const webpack = req('webpack');
const out = path.resolve('dist');
const entry = path.resolve('src/watch-fail-app.js'); // a copy of src/app.js, so the fixture's sources stay as they are
fs.copyFileSync(path.resolve('src/app.js'), entry);
const compiler = webpack([
  { name: 'app', mode: 'production', entry, output: { path: out, filename: 'app.js' } },
  { name: 'sw', mode: 'production', target: 'webworker', entry: './src/sw.js', output: { path: out, filename: 'sw.js' } },
]);
const builds = [];
const failed = (stats) => stats.stats.filter(s => s.hasErrors()).map(s => s.compilation.name).join(',');
const watching = compiler.watch({ aggregateTimeout: 50 }, (err, stats) => {
  if (err) { console.error(err); process.exit(1); }
  const want = builds.length === 0 ? '' : 'app';
  if (failed(stats) !== want) { console.error(`watch-fail: build ${builds.length + 1}: failed "${failed(stats)}", want "${want}"\n${stats.toString('errors-only')}`); process.exit(1); }
  builds.push(readLockfile(path.join(out, LOCKFILE)));
  if (builds.length === 1) fs.writeFileSync(entry, "require('debug')('x'); require('./does-not-exist');\n");
  else if (builds.length === 2) watching.invalidate(); // sw rebuilds too
  else watching.close(() => { fs.rmSync(entry); console.log(JSON.stringify(builds)); });
});
