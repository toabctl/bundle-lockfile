// Watch-mode build through Vite's Node API (`vite build --watch`; Vite 7: Rollup's watch(), Vite 8: Rolldown's).
// Copied into the fixture and run from there (cwd = fixture), as a project's own build script would be: on Node < 24.12
// the loader-thread hooks are installed only in processes of a package that uses Vite. Builds, rebuilds with the lines
// of src/main.js that contain <text> removed (an import whose packages must leave the lockfile), rebuilds with them
// restored (they must come back), then exits: node .vite-watch.mjs <text>. The lockfile is deleted before every
// build, so only the file shows that this build wrote it. Fails if a build does not write it; prints the package list
// of every build as JSON on the last line. src/main.js is restored also when this fails.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const text = process.argv[2];
const lockfile = path.resolve('dist/bundle-lockfile/package-lock.json');
const main = path.resolve('src/main.js');
const source = fs.readFileSync(main, 'utf8');
process.on('exit', () => fs.writeFileSync(main, source));
const without = source.split('\n').filter(l => !l.includes(text)).join('\n');
const fail = (msg) => { console.error(msg); process.exit(1); };
if (!text || without === source) fail(`vite-watch: no line of src/main.js contains ${text}`);
const { build } = await import(pathToFileURL(path.resolve('node_modules/vite/dist/node/index.js')).href);
const builds = [];
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
  if (builds.length === 3) {
    await watcher.close();
    console.log(JSON.stringify(builds));
    return;
  }
  fs.rmSync(lockfile);
  const next = builds.length === 1 ? without : source;
  setTimeout(() => fs.writeFileSync(main, next), 200); // after the watcher has settled
});
