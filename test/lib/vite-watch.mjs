// Watch-mode build through Vite's Node API (`vite build --watch`; Vite 7: Rollup's watch(), Vite 8: Rolldown's).
// Copied into the fixture and run from there (cwd = fixture), as a project's own build script would be: on Node < 24.12
// the loader-thread hooks are installed only in processes of a package that uses Vite. Builds, rebuilds once after
// src/main.js is written again (same bytes), then exits. The lockfile is deleted before every build, so only the file
// shows that this build wrote it. Fails if a build does not write it; prints the package list of every build as JSON
// on the last line.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { build } = await import(pathToFileURL(path.resolve('node_modules/vite/dist/node/index.js')).href);
const lockfile = path.resolve('dist/bundle-lockfile/package-lock.json');
const main = path.resolve('src/main.js');
const builds = [];
const fail = (msg) => { console.error(msg); process.exit(1); };
setTimeout(() => fail(`vite-watch: timed out after ${builds.length} build(s)`), 120000).unref();

fs.rmSync(lockfile, { force: true });
const watcher = await build({ logLevel: 'warn', build: { watch: {} } });
watcher.on('event', async (event) => {
  if (event.code === 'ERROR') fail(`vite-watch: ${event.error && (event.error.stack || event.error.message)}`);
  if (event.code === 'BUNDLE_END' && event.result && typeof event.result.close === 'function') await event.result.close();
  if (event.code !== 'END') return;
  if (!fs.existsSync(lockfile)) fail(`vite-watch: build ${builds.length + 1} did not write ${path.relative(process.cwd(), lockfile)}`);
  const lock = JSON.parse(fs.readFileSync(lockfile, 'utf8'));
  builds.push(Object.entries(lock.packages).filter(([k]) => k).map(([, p]) => `${p.name}@${p.version}`).sort());
  if (builds.length === 1) {
    fs.rmSync(lockfile);
    setTimeout(() => fs.writeFileSync(main, fs.readFileSync(main)), 200); // after the watcher has settled
    return;
  }
  await watcher.close();
  console.log(JSON.stringify(builds));
});
