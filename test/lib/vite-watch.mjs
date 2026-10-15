// Watch-mode build through Vite's Node API (`vite build --watch`; Vite 7: Rollup's watch(), Vite 8: Rolldown's).
// Copied into the fixture and run from there (cwd = fixture), as a project's own build script would be: on older
// Node.js (hooks.cjs syncHooksSafe) the loader-thread hooks are installed only in processes of a package that uses
// Vite. Builds, rebuilds with the lines of src/main.js that contain <text> removed (an import whose packages must
// leave the lockfile), rebuilds with them restored (they must come back), then exits: node .vite-watch.mjs <text>.
// The lockfile is deleted before every build, so only the file shows that this build wrote it. Fails if a build does not write it; prints the package list
// of every build as JSON on the last line. src/main.js is restored also when this fails.
// BLTEST_VITE_WATCH=late: a plugin copies is-number's index.js into dist/vendor/ with fs in its closeBundle, after
// every build (as vite-plugin-static-copy does): it must be listed after every build (in the lockfile written again
// after the plugins' closeBundle, which Vite does not wait for).
// BLTEST_VITE_WATCH=problem: the rebuild imports node_modules/naked/index.js instead (a package without package.json,
// made here; <text> is not used): it must fail with the problem and leave the lockfile of the output still in dist/
// (an empty list for that build if nothing of it is there); the next rebuild (without it) must write the lockfile again.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const text = process.argv[2];
const variant = process.env.BLTEST_VITE_WATCH || '';
const lockfile = path.resolve('dist/bundle-lockfile/package-lock.json');
const main = path.resolve('src/main.js');
const naked = path.resolve('node_modules/naked');
const source = fs.readFileSync(main, 'utf8');
process.on('exit', () => { fs.writeFileSync(main, source); if (variant === 'problem') fs.rmSync(naked, { recursive: true, force: true }); });
const without = variant === 'problem' ? `import '../node_modules/naked/index.js';\n${source}` : source.split('\n').filter(l => !l.includes(text)).join('\n');
const fail = (msg) => { console.error(msg); process.exit(1); };
if (!text || without === source) fail(`vite-watch: no line of src/main.js contains ${text}`);
if (variant === 'problem') { fs.mkdirSync(naked, { recursive: true }); fs.writeFileSync(path.join(naked, 'index.js'), "console.log('naked');\n"); }
const plugins = variant === 'late' ? [{ name: 'bltest-copy', closeBundle() {
  fs.mkdirSync(path.resolve('dist/vendor'), { recursive: true });
  fs.copyFileSync(createRequire(main).resolve('is-number/index.js'), path.resolve('dist/vendor/is-number.js'));
} }] : [];
const { build } = await import(pathToFileURL(path.resolve('node_modules/vite/dist/node/index.js')).href);
const builds = [];
let error = null;
setTimeout(() => fail(`vite-watch: timed out after ${builds.length} build(s)`), 120000).unref();

fs.rmSync(lockfile, { force: true });
const watcher = await build({ logLevel: 'warn', build: { watch: {} }, plugins });
watcher.on('event', async (event) => {
  if (event.code === 'BUNDLE_END' && event.result && typeof event.result.close === 'function') await event.result.close();
  if (event.code === 'ERROR') {
    if (variant !== 'problem' || builds.length !== 1) fail(`vite-watch: ${event.error && (event.error.stack || event.error.message)}`);
    error = String(event.error && event.error.message);
    if (event.result && typeof event.result.close === 'function') await event.result.close();
  }
  if (event.code !== 'END') return;
  // late: Vite closes the build itself, without waiting (Vite 5 - 8): the lockfile is written again after the copy,
  // once the plugin's closeBundle has run - wait for that write (its record names the copy), at most 10 s
  for (let i = 0; variant === 'late' && i < 100; i++) {
    try { if (fs.readFileSync(lockfile, 'utf8').includes('vendor/is-number.js')) break; } catch { /* not yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (variant === 'problem' && builds.length === 1 && !/no package\.json with name and version in \S*node_modules\/naked - its bundled files are not listed/.test(error || '')) {
    fail(`vite-watch: the rebuild with naked did not fail with its problem: ${error}`);
  }
  // (Vite 8 empties dist/ before a rebuild, also one that fails: nothing of it ships, no lockfile - an empty list)
  const js = () => fs.readdirSync(path.resolve('dist'), { recursive: true }).filter(f => /\.js$/.test(f));
  if (error && !fs.existsSync(lockfile) && !js().length) { builds.push([]); error = null; }
  else if (!fs.existsSync(lockfile)) fail(`vite-watch: build ${builds.length + 1} did not write ${path.relative(process.cwd(), lockfile)}`);
  else builds.push(Object.entries(JSON.parse(fs.readFileSync(lockfile, 'utf8')).packages).filter(([k]) => k).map(([, p]) => `${p.name}@${p.version}`).sort());
  if (builds.length === 3) {
    await watcher.close();
    console.log(JSON.stringify(builds));
    return;
  }
  if (variant !== 'problem' || builds.length === 2) fs.rmSync(lockfile, { force: true }); // (not before the failing rebuild)
  const next = builds.length === 1 ? without : source;
  setTimeout(() => fs.writeFileSync(main, next), 200); // after the watcher has settled
});
