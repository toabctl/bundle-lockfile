// Builds through the JavaScript APIs of Rollup and Rolldown, as tools and build scripts do (no Vite, no command
// line): node build.mjs <mode>
//   rollup          rollup() + write()
//   rollup-wasm     the same with @rollup/wasm-node (Rollup's WebAssembly build, for platforms without its native one)
//   rolldown        rolldown() + write()
//   rolldown-build  Rolldown's build()
//   rolldown-nodir  rolldown() + write() without dir or file (Rolldown writes to dist/)
//   rollup-outputs, rolldown-outputs  two outputs into dist/ at the same time (main.js, main.min.js), as the rollup
//                   command line writes them; fails unless the lockfile records each with its own file
//   rollup-plugin, rolldown-plugin  the plugin in the build's options (BUNDLE_LOCKFILE_PLUGIN: adapters/rollup.cjs, no
//                   NODE_OPTIONS), two builds into dist/: src/main.js, then src/second.js; the lockfile must keep both
//   rollup-watch, rolldown-watch  watch(): builds, rebuilds without src/main.js's nanoid lines (nanoid must leave the
//                   lockfile), rebuilds with them (it must come back); the lockfile is deleted before every build;
//                   prints the package list of every build as JSON last. src/main.js is restored also on failure
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const mode = process.argv[2];
const input = 'src/main.js';
const dir = path.resolve('dist');
const lockfile = path.join(dir, 'bundle-lockfile/package-lock.json');
const fail = (msg) => { console.error(msg); process.exit(1); };
const rollupOptions = async () => ({ input, plugins: [(await import('@rollup/plugin-node-resolve')).nodeResolve({ browser: true })] });
const rolldownOptions = { input, platform: 'browser' };
const output = { dir, format: 'es' };

if (mode === 'rollup' || mode === 'rollup-wasm') {
  const bundle = await (await import(mode === 'rollup' ? 'rollup' : '@rollup/wasm-node')).rollup(await rollupOptions());
  await bundle.write(output);
  await bundle.close();
} else if (mode === 'rolldown') {
  const bundle = await (await import('rolldown')).rolldown(rolldownOptions);
  await bundle.write(output);
  await bundle.close();
} else if (mode === 'rolldown-nodir') {
  const bundle = await (await import('rolldown')).rolldown(rolldownOptions);
  await bundle.write({ format: 'es' });
  await bundle.close();
} else if (mode === 'rolldown-build') {
  await (await import('rolldown')).build({ ...rolldownOptions, output });
} else if (mode === 'rollup-outputs' || mode === 'rolldown-outputs') {
  const rollup = mode === 'rollup-outputs';
  const bundle = rollup ? await (await import('rollup')).rollup(await rollupOptions()) : await (await import('rolldown')).rolldown(rolldownOptions);
  await Promise.all(['[name].js', '[name].min.js'].map(entryFileNames => bundle.write({ ...output, entryFileNames })));
  await bundle.close();
  // each output is a writer of its own, with its file and its hash (for a build that bundles it)
  const writers = JSON.parse(fs.readFileSync(lockfile, 'utf8'))['bundle-lockfile'].writers;
  const got = JSON.stringify(writers.map(w => [w.files, Object.keys(w.outputs || {})]).sort());
  if (got !== JSON.stringify([[['../main.js'], ['../main.js']], [['../main.min.js'], ['../main.min.js']]])) fail(`${mode}: writers ${got}`);
} else if (mode === 'rollup-plugin' || mode === 'rolldown-plugin') {
  const { bundleLockfile } = createRequire(import.meta.url)(process.env.BUNDLE_LOCKFILE_PLUGIN);
  const rollup = mode === 'rollup-plugin';
  for (const entry of [input, 'src/second.js']) {
    const options = rollup ? await rollupOptions() : { ...rolldownOptions, plugins: [] };
    options.input = entry;
    options.plugins.push(bundleLockfile(rollup ? 'rollup' : 'rolldown'));
    const bundle = rollup ? await (await import('rollup')).rollup(options) : await (await import('rolldown')).rolldown(options);
    await bundle.write(output);
    await bundle.close();
  }
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
