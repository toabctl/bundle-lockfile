// Builds through the JavaScript APIs of Rollup and Rolldown, as tools and build scripts do (no Vite, no command
// line): node build.mjs <mode>
//   rollup          rollup() + write()
//   rollup-wasm     the same with @rollup/wasm-node (Rollup's WebAssembly build, for platforms without its native one)
//   rollup-asset    rollup() + write() with a plugin that emits a package's file (lodash-es' LICENSE) as an asset, naming
//                   it (originalFileName: Rollup 4.20 and later keep it; before, no asset names its file)
//   rolldown        rolldown() + write()
//   rolldown-build  Rolldown's build()
//   rolldown-nodir  rolldown() + write() without dir or file (Rolldown writes to dist/)
//   rolldown-writes two write()s of one rolldown() build, into dist/ and dist/cjs/, then a package's file copied into
//                   dist/ with fs before close(), as another plugin's closeBundle would (Rolldown runs buildStart for
//                   every write())
//   rollup-outputs, rolldown-outputs  two outputs into dist/ at the same time (main.js, main.min.js), as the rollup
//                   command line writes them; fails unless the lockfile records each with its own file
//   rollup-plugin, rolldown-plugin  the plugin in the build's options (BLTEST_PLUGIN: adapters/rollup.cjs, no
//                   NODE_OPTIONS), two builds into dist/: src/main.js, then src/second.js; the lockfile must keep both
//   rollup-watch, rolldown-watch  watch(): builds, rebuilds without src/main.js's nanoid lines (nanoid must leave the
//                   lockfile), rebuilds with them (it must come back); the lockfile is deleted before every build;
//                   prints the package list of every build as JSON last. src/main.js is restored also on failure
//   rolldown-watch-outputs  the same with two outputs (dist/, dist/cjs/: Rolldown runs a build per output, both with
//                   the one plugin): both lockfiles must have the same packages after every build
//   rollup-watch-problem, rolldown-watch-problem  watch(): builds, rebuilds with an import of node_modules/naked (a
//                   package without package.json, made here): that rebuild must fail with the problem and leave the
//                   lockfile of the output still in dist/; rebuilds without it (the lockfile must be written again)
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

if (mode === 'rollup-asset') {
  const license = path.join(path.dirname(createRequire(import.meta.url).resolve('lodash-es/package.json')), 'LICENSE');
  const emit = { name: 'emit-license', buildStart() { this.emitFile({ type: 'asset', fileName: 'LICENSE.lodash-es.txt', source: fs.readFileSync(license), originalFileName: license }); } };
  const options = await rollupOptions();
  const bundle = await (await import('rollup')).rollup({ ...options, plugins: [...options.plugins, emit] });
  await bundle.write(output);
  await bundle.close();
} else if (mode === 'rollup' || mode === 'rollup-wasm') {
  const bundle = await (await import(mode === 'rollup' ? 'rollup' : '@rollup/wasm-node')).rollup(await rollupOptions());
  await bundle.write(output);
  await bundle.close();
} else if (mode === 'rolldown') {
  const bundle = await (await import('rolldown')).rolldown(rolldownOptions);
  await bundle.write(output);
  await bundle.close();
} else if (mode === 'rolldown-writes') {
  const bundle = await (await import('rolldown')).rolldown(rolldownOptions);
  await bundle.write(output);
  await bundle.write({ dir: path.join(dir, 'cjs'), format: 'cjs' });
  fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
  fs.copyFileSync(createRequire(import.meta.url).resolve('normalize.css/normalize.css'), path.join(dir, 'vendor/normalize.css'));
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
  const { bundleLockfile } = createRequire(import.meta.url)(process.env.BLTEST_PLUGIN);
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
} else if (mode === 'rolldown-watch-outputs' || mode === 'rollup-watch-problem' || mode === 'rolldown-watch-problem') {
  const rollup = mode.startsWith('rollup');
  const problem = mode.endsWith('-problem');
  const { watch } = await import(rollup ? 'rollup' : 'rolldown');
  const options = rollup ? await rollupOptions() : rolldownOptions;
  const outputs = problem ? output : [output, { dir: path.join(dir, 'cjs'), format: 'cjs' }];
  const locks = [lockfile, ...(problem ? [] : [path.join(dir, 'cjs/bundle-lockfile/package-lock.json')])];
  const naked = path.resolve('node_modules/naked');
  const source = fs.readFileSync(input, 'utf8');
  process.on('exit', () => { fs.writeFileSync(input, source); fs.rmSync(naked, { recursive: true, force: true }); });
  const changed = problem ? `import 'naked';\n${source}` : source.split('\n').filter(l => !l.includes('nanoid')).join('\n');
  if (problem) { fs.mkdirSync(naked, { recursive: true }); fs.writeFileSync(path.join(naked, 'index.js'), "console.log('naked');\n"); }
  const listOf = (file) => Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')).packages).filter(([k]) => k).map(([, p]) => `${p.name}@${p.version}`).sort();
  const builds = [];
  let error = null;
  setTimeout(() => fail(`${mode}: timed out after ${builds.length} build(s)`), 120000).unref();
  for (const l of locks) fs.rmSync(l, { force: true });
  const watcher = watch({ ...options, output: outputs });
  watcher.on('event', async (event) => {
    if (event.code === 'BUNDLE_END' && event.result) await event.result.close();
    if (event.code === 'ERROR') {
      if (!problem || builds.length !== 1) fail(`${mode}: ${event.error && (event.error.stack || event.error.message)}`);
      error = String(event.error && event.error.message);
      if (event.result) await event.result.close();
    }
    if (event.code !== 'END') return;
    // the rebuild with naked: failed with the problem, the lockfile of build 1 still there (Rollup and Rolldown write
    // nothing of a failed build)
    if (problem && builds.length === 1 && !/no package\.json with name and version in \S*node_modules\/naked - its bundled files are not listed/.test(error || '')) {
      fail(`${mode}: the rebuild with naked did not fail with its problem: ${error}`);
    }
    const lists = locks.map(l => (fs.existsSync(l) ? listOf(l) : fail(`${mode}: build ${builds.length + 1} did not write ${path.relative(process.cwd(), l)}`)));
    if (lists.some(l => JSON.stringify(l) !== JSON.stringify(lists[0]))) fail(`${mode}: build ${builds.length + 1}: the outputs' lockfiles differ: ${JSON.stringify(lists)}`);
    builds.push(lists[0]);
    if (builds.length === 3) {
      console.log(JSON.stringify(builds));
      await Promise.race([watcher.close(), new Promise(resolve => setTimeout(resolve, 5000))]);
      process.exit(0);
    }
    if (!problem || builds.length === 2) for (const l of locks) fs.rmSync(l); // (not before the failing rebuild)
    const next = builds.length === 1 ? changed : source;
    setTimeout(() => fs.writeFileSync(input, next), 200); // after the watcher has settled
  });
} else fail(`unknown mode ${mode}`);
