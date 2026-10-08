'use strict';
// Watch-mode build through webpack's Node API (cwd = fixture): builds, invalidates once to force a rebuild,
// then exits. Fails if a build reports errors (e.g. the lockfile emitted twice with different content) or
// does not write the lockfile; prints the package list of every build as JSON on the last line.
// The lockfile is deleted before every build: on the real disk it is no asset (written in afterEmit), so only the
// file itself shows that this build wrote it.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { LOCKFILE: ASSET, readLockfile } = require('./check.cjs');

const req = createRequire(path.join(process.cwd(), 'package.json'));
const webpack = req('webpack');
const compiler = webpack(req('./webpack.config.js'));
const lockfile = path.join(compiler.outputPath, ASSET);
const builds = [];
fs.rmSync(lockfile, { force: true });
const watching = compiler.watch({}, (err, stats) => {
  if (err || stats.hasErrors()) { console.error(err || stats.toString('errors-only')); process.exit(1); }
  if (!fs.existsSync(lockfile)) { console.error(`watch: build ${builds.length + 1} did not write ${ASSET}`); process.exit(1); }
  builds.push(readLockfile(lockfile));
  if (builds.length === 1) { fs.rmSync(lockfile); watching.invalidate(); return; }
  watching.close(() => console.log(JSON.stringify(builds)));
});
