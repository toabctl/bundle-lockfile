// Builds through the JavaScript APIs of Rollup and Rolldown, as tools and build scripts do (no Vite, no command
// line): node build.mjs <mode>
//   rollup          rollup() + write()
//   rolldown        rolldown() + write()
//   rolldown-build  Rolldown's build()
//   rollup-watch, rolldown-watch  watch(): builds, rebuilds without src/main.js's nanoid lines (nanoid must leave the
//                   lockfile), rebuilds with them (it must come back); the lockfile is deleted before every build;
//                   prints the package list of every build as JSON last. src/main.js is restored also on failure
import fs from 'node:fs';
import path from 'node:path';

const mode = process.argv[2];
const input = 'src/main.js';
const dir = path.resolve('dist');
const lockfile = path.join(dir, 'bundle-lockfile/package-lock.json');
const fail = (msg) => { console.error(msg); process.exit(1); };
const rollupOptions = async () => ({ input, plugins: [(await import('@rollup/plugin-node-resolve')).nodeResolve({ browser: true })] });
const rolldownOptions = { input, platform: 'browser' };
const output = { dir, format: 'es' };

if (mode === 'rollup') {
  const bundle = await (await import('rollup')).rollup(await rollupOptions());
  await bundle.write(output);
  await bundle.close();
} else if (mode === 'rolldown') {
  const bundle = await (await import('rolldown')).rolldown(rolldownOptions);
  await bundle.write(output);
  await bundle.close();
} else if (mode === 'rolldown-build') {
  await (await import('rolldown')).build({ ...rolldownOptions, output });
} else if (mode === 'rollup-watch' || mode === 'rolldown-watch') {
  const { watch } = await import(mode === 'rollup-watch' ? 'rollup' : 'rolldown');
  const options = mode === 'rollup-watch' ? await rollupOptions() : rolldownOptions;
  const source = fs.readFileSync(input, 'utf8');
  process.on('exit', () => fs.writeFileSync(input, source));
  const without = source.split('\n').filter(l => !l.includes('nanoid')).join('\n');
  const builds = [];
  setTimeout(() => fail(`${mode}: timed out after ${builds.length} build(s)`), 120000).unref();
  fs.rmSync(lockfile, { force: true });
  const watcher = watch({ ...options, output });
  watcher.on('event', async (event) => {
    if (event.code === 'ERROR') fail(`${mode}: ${event.error && (event.error.stack || event.error.message)}`);
    if (event.code === 'BUNDLE_END' && event.result) await event.result.close();
    if (event.code !== 'END') return;
    if (!fs.existsSync(lockfile)) fail(`${mode}: build ${builds.length + 1} did not write the lockfile`);
    const lock = JSON.parse(fs.readFileSync(lockfile, 'utf8'));
    builds.push(Object.entries(lock.packages).filter(([k]) => k).map(([, p]) => `${p.name}@${p.version}`).sort());
    if (builds.length === 3) {
      await watcher.close();
      console.log(JSON.stringify(builds));
      return;
    }
    fs.rmSync(lockfile);
    const next = builds.length === 1 ? without : source;
    setTimeout(() => fs.writeFileSync(input, next), 200); // after the watcher has settled
  });
} else fail(`unknown mode ${mode}`);
