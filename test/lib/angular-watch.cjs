'use strict';
// `ng build --watch` (cwd = fixture, NODE_OPTIONS inherited): builds, rebuilds with the lines of <file> that contain
// <text> removed (imports whose packages must leave the lockfile), rebuilds with the file restored (they must come
// back), then stops. usage: node angular-watch.cjs <file> <text> [<lockfile below the output path>]
// A build counts once Angular says it completed and its lockfile was written again (a rebuild that changes the
// packages rewrites it: Angular writes the files of a rebuild that changed). Prints the package list of every build as
// JSON on the last line. The file is restored also when this fails.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createRequire } = require('module');
const { LOCKFILE, readLockfile } = require('./check.cjs');

const [file, text, rel = path.join('browser', LOCKFILE)] = process.argv.slice(2);
if (!file || !text) { console.error('usage: node angular-watch.cjs <file> <text> [<lockfile>]'); process.exit(2); }
const source = fs.readFileSync(file, 'utf8');
const without = source.split('\n').filter(l => !l.includes(text)).join('\n');
if (without === source) { console.error(`angular-watch: no line of ${file} contains ${text}`); process.exit(2); }
const lockfile = path.resolve('dist', rel);
fs.rmSync('dist', { recursive: true, force: true });

const ng = createRequire(path.resolve('package.json')).resolve('@angular/cli/bin/ng.js');
const child = spawn(process.execPath, [ng, 'build', '--watch'], { env: { ...process.env, NG_CLI_ANALYTICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
const done = (code, msg) => {
  fs.writeFileSync(file, source);
  child.kill();
  if (msg) console.error(msg, `\n${log.slice(-3000)}`);
  process.exit(code);
};
process.on('exit', () => fs.writeFileSync(file, source));
const timer = setTimeout(() => done(1, 'angular-watch: timed out'), 240000);

const builds = [];
let completed = 0, lastMtime = 0, waiting = false;
const mtime = () => { try { return fs.statSync(lockfile).mtimeMs; } catch { return 0; } };
// after Angular reported a build: wait until its lockfile is newer than the last build's, and a moment longer
function settle() {
  if (waiting) return;
  waiting = true;
  const start = Date.now();
  const poll = setInterval(() => {
    const m = mtime();
    if (m > lastMtime && Date.now() - m > 300) {
      clearInterval(poll); waiting = false; lastMtime = m;
      builds.push(readLockfile(lockfile));
      if (builds.length === 3) { clearTimeout(timer); console.log(JSON.stringify(builds)); return done(0); }
      fs.writeFileSync(file, builds.length === 1 ? without : source);
    } else if (Date.now() - start > 60000) { clearInterval(poll); done(1, `angular-watch: build ${builds.length + 1} did not write ${rel}`); }
  }, 100);
}
const read = (chunk) => {
  log += chunk;
  const n = (log.match(/Application bundle generation (complete|failed)/g) || []).length;
  if (/Application bundle generation failed/.test(log)) return done(1, 'angular-watch: a build failed');
  if (n > completed) { completed = n; settle(); }
};
child.stdout.on('data', read);
child.stderr.on('data', read);
child.on('exit', (code) => { if (builds.length < 3) done(1, `angular-watch: ng exited (${code}) after ${builds.length} build(s)`); });
