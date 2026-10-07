'use strict';
// Watch-mode build through webpack's Node API (cwd = fixture): builds, invalidates once to force a rebuild,
// then exits. Fails if a build reports errors (e.g. the lockfile emitted twice with different content) or
// does not emit the lockfile; prints the package list of every build as JSON on the last line.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const ASSET = 'bundle-lockfile/package-lock.json';
const req = createRequire(path.join(process.cwd(), 'package.json'));
const webpack = req('webpack');
const compiler = webpack(req('./webpack.config.js'));
const builds = [];
const watching = compiler.watch({}, (err, stats) => {
  if (err || stats.hasErrors()) { console.error(err || stats.toString('errors-only')); process.exit(1); }
  // after emitting, webpack keeps only the asset's size in memory: check it is in this build, read it from disk
  if (!stats.compilation.getAsset(ASSET)) { console.error(`watch: build ${builds.length + 1} did not emit ${ASSET}`); process.exit(1); }
  const lock = JSON.parse(fs.readFileSync(path.join(compiler.outputPath, ASSET), 'utf8'));
  builds.push(Object.entries(lock.packages).filter(([k]) => k).map(([, p]) => `${p.name}@${p.version}`).sort());
  if (builds.length === 1) { watching.invalidate(); return; }
  watching.close(() => console.log(JSON.stringify(builds)));
});
