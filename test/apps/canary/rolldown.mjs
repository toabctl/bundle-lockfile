// The canary app's JavaScript built by Rolldown's API (no Vite): node rolldown.mjs <mode>
//   rolldown  rolldown() + write(): the build object has the watch files
//   build     build(): the files plugins inlined only from the plugin contexts (see src/adapters/rolldown-watch.cjs)
//   watch     watch(): builds, rebuilds without src/main.js's line that imports the shader (bl-canary-glsl must leave
//             the lockfile), rebuilds with it (it must come back); the lockfile is deleted before every build; prints the
//             package list of every build as JSON last. src/main.js is restored also on failure
import fs from 'node:fs';
import path from 'node:path';
import include from './include-plugin.mjs';

const mode = process.argv[2];
const input = 'src/main.js';
const dir = path.resolve('dist');
const lockfile = path.join(dir, 'bundle-lockfile/package-lock.json');
const fail = (msg) => { console.error(msg); process.exit(1); };
const options = () => ({ input, platform: 'browser', plugins: [include()] });
const output = { dir, format: 'es' };
const rolldown = await import('rolldown');

if (mode === 'rolldown') {
  const bundle = await rolldown.rolldown(options());
  await bundle.write(output);
  await bundle.close();
} else if (mode === 'build') {
  await rolldown.build({ ...options(), output });
} else if (mode === 'watch') {
  const source = fs.readFileSync(input, 'utf8');
  process.on('exit', () => fs.writeFileSync(input, source));
  const without = source.split('\n').filter(l => !l.includes('./shader.glsl')).join('\n');
  if (without === source) fail('watch: no line of src/main.js imports ./shader.glsl');
  const builds = [];
  setTimeout(() => fail(`watch: timed out after ${builds.length} build(s)`), 120000).unref();
  fs.rmSync(lockfile, { force: true });
  const watcher = rolldown.watch({ ...options(), output });
  watcher.on('event', async (event) => {
    if (event.code === 'ERROR') fail(`watch: ${event.error && (event.error.stack || event.error.message)}`);
    if (event.code === 'BUNDLE_END' && event.result) await event.result.close();
    if (event.code !== 'END') return;
    if (!fs.existsSync(lockfile)) fail(`watch: build ${builds.length + 1} did not write the lockfile`);
    const lock = JSON.parse(fs.readFileSync(lockfile, 'utf8'));
    builds.push(Object.entries(lock.packages).filter(([k]) => k).map(([, p]) => `${p.name}@${p.version}`).sort());
    if (builds.length === 3) {
      console.log(JSON.stringify(builds));
      // Rolldown 1.0.0's watcher.close() does not resolve after a rebuild (also without bundle-lockfile)
      await Promise.race([watcher.close(), new Promise(resolve => setTimeout(resolve, 5000))]);
      process.exit(0);
    }
    fs.rmSync(lockfile);
    const next = builds.length === 1 ? without : source;
    setTimeout(() => fs.writeFileSync(input, next), 200); // after the watcher has settled
  });
} else fail(`unknown mode ${mode}`);
