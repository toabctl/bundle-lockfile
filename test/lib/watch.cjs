'use strict';
// Watch-mode build through webpack's Node API (cwd = fixture): builds, rebuilds with the lines of <file> that contain
// <text> removed (an import whose packages must leave the lockfile), rebuilds with the file restored (they must come
// back), then exits. usage: node watch.cjs <file> <text>. Fails if a build reports errors (e.g. the lockfile emitted
// twice with different content) or does not write the lockfile; prints the package list of every build as JSON on the
// last line. The file is restored also when this fails.
// The lockfile is deleted before every build: on the real disk it is no asset (written in afterEmit), so only the
// file itself shows that this build wrote it.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { LOCKFILE: ASSET, readLockfile } = require('./check.cjs');

const [file, text] = process.argv.slice(2);
if (!file || !text) { console.error('usage: node watch.cjs <file> <text>'); process.exit(2); }
const source = fs.readFileSync(file, 'utf8');
process.on('exit', () => fs.writeFileSync(file, source));
const without = source.split('\n').filter(l => !l.includes(text)).join('\n');
if (without === source) { console.error(`watch: no line of ${file} contains ${text}`); process.exit(2); }

const req = createRequire(path.join(process.cwd(), 'package.json'));
const webpack = req('webpack');
const compiler = webpack(req('./webpack.config.js'));
const lockfile = path.join(compiler.outputPath, ASSET);
const builds = [];
fs.rmSync(lockfile, { force: true });
const watching = compiler.watch({ aggregateTimeout: 50 }, (err, stats) => {
  if (err || stats.hasErrors()) { console.error(err || stats.toString('errors-only')); process.exit(1); }
  if (!fs.existsSync(lockfile)) { console.error(`watch: build ${builds.length + 1} did not write ${ASSET}`); process.exit(1); }
  builds.push(readLockfile(lockfile));
  if (builds.length === 3) return watching.close(() => console.log(JSON.stringify(builds)));
  fs.rmSync(lockfile);
  fs.writeFileSync(file, builds.length === 1 ? without : source);
});
