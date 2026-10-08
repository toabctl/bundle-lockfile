'use strict';
// `rollup -c -w` (cwd = fixture): the rollup command line in watch mode. Waits for each build's lockfile, rebuilds
// without the lines of src/main.js that contain <text> (an import whose packages must leave the lockfile), then with
// them again, then stops rollup. usage: node rollup-cli-watch.cjs <text>. Prints the package list of every build as
// JSON on the last line; src/main.js is restored also when this fails.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readLockfile } = require('./check.cjs');

const text = process.argv[2];
const main = path.resolve('src/main.js');
const lockfile = path.resolve('dist/bundle-lockfile/package-lock.json');
const source = fs.readFileSync(main, 'utf8');
const without = source.split('\n').filter(l => !l.includes(text)).join('\n');
const fail = (msg) => { console.error(msg); process.exit(1); };
if (!text || without === source) fail(`rollup-cli-watch: no line of src/main.js contains ${text}`);

const rollup = spawn(process.execPath, [path.resolve('node_modules/rollup/dist/bin/rollup'), '-c', '-w'], { stdio: ['ignore', 'inherit', 'inherit'] });
process.on('exit', () => { rollup.kill(); fs.writeFileSync(main, source); });
rollup.on('exit', (code) => fail(`rollup-cli-watch: rollup exited ${code}`));
setTimeout(() => fail('rollup-cli-watch: timed out'), 120000).unref();

const builds = [];
fs.rmSync(lockfile, { force: true });
const poll = setInterval(() => {
  if (!fs.existsSync(lockfile)) return;
  builds.push(readLockfile(lockfile));
  if (builds.length === 3) { clearInterval(poll); console.log(JSON.stringify(builds)); process.exit(0); }
  fs.rmSync(lockfile);
  fs.writeFileSync(main, builds.length === 1 ? without : source);
}, 200);
