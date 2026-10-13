// Builds through esbuild's JavaScript API, as build scripts do (mailpit, authentik): node build.mjs <mode>
//   build        build() into dist/ (ES modules, splitting: a lazily loaded chunk)
//   context      context(), rebuild(), dispose()
//   watch        context().watch(): builds, rebuilds without src/main.js's nanoid line (nanoid must leave the lockfile),
//                rebuilds with it (it must come back); the lockfile is deleted before every build; prints the package
//                list of every build as JSON last. src/main.js is restored also on failure
//   outfile      build() into dist/app.js (no outdir, no splitting)
//   sync         buildSync() into dist/app.js
//   two          two build()s into dist/: src/main.js, then src/second.js; the lockfile must keep both
//   write-false  build() with write: false: nothing written, no lockfile
//   features     src/features.js with esbuild-sass-plugin (a Sass partial from bulma, which the plugin inlines), and a
//                plugin whose onEnd copies sanitize.css out of its package into the output with fs (as authentik's
//                copies its assets)
// BLTEST_ESBUILD_ORACLE=<dir> (oracles/esbuild.cjs, without bundle-lockfile): the same build with source maps, into <dir>;
// BLTEST_ESBUILD_PKG=esbuild-wasm: esbuild's WebAssembly build
import fs from 'node:fs';
import path from 'node:path';
const esbuild = await import(process.env.BLTEST_ESBUILD_PKG || 'esbuild');

const mode = process.argv[2] || 'build';
const oracle = process.env.BLTEST_ESBUILD_ORACLE;
const out = oracle || 'dist';
const lockfile = path.resolve(out, 'bundle-lockfile/package-lock.json');
const fail = (msg) => { console.error(msg); process.exit(1); };
const common = { bundle: true, loader: { '.woff2': 'file' }, logLevel: 'warning', ...(oracle && { sourcemap: true }) };
const split = { ...common, entryPoints: ['src/main.js'], outdir: out, format: 'esm', splitting: true };
const single = { ...common, entryPoints: ['src/main.js'], outfile: path.join(out, 'app.js'), format: 'iife' };
const names = () => {
  const lock = JSON.parse(fs.readFileSync(lockfile, 'utf8'));
  return Object.entries(lock.packages).filter(([k]) => k).map(([, p]) => `${p.name}@${p.version}`).sort();
};

if (mode === 'build') await esbuild.build(split);
else if (mode === 'context') {
  const ctx = await esbuild.context(split);
  await ctx.rebuild();
  await ctx.dispose();
} else if (mode === 'outfile') await esbuild.build(single);
else if (mode === 'sync') esbuild.buildSync(single);
else if (mode === 'two') {
  await esbuild.build(split);
  await esbuild.build({ ...split, entryPoints: ['src/second.js'] });
} else if (mode === 'write-false') {
  const r = await esbuild.build({ ...split, write: false });
  if (!r.outputFiles.length) fail('write-false: no output files');
} else if (mode === 'features') {
  const { sassPlugin } = await import('esbuild-sass-plugin');
  const copy = { name: 'copy-assets', setup(build) { build.onEnd(() => { fs.cpSync('node_modules/sanitize.css/sanitize.css', path.join(out, 'sanitize.css')); }); } };
  await esbuild.build({ ...common, entryPoints: ['src/features.js'], outdir: out, format: 'esm', plugins: [sassPlugin(), copy] });
} else if (mode === 'watch') {
  const input = 'src/main.js';
  const source = fs.readFileSync(input, 'utf8');
  const without = source.split('\n').filter(l => !l.includes('nanoid')).join('\n');
  process.on('exit', () => fs.writeFileSync(input, source));
  const builds = [];
  fs.rmSync(lockfile, { force: true });
  const ctx = await esbuild.context(split);
  await ctx.watch();
  const deadline = Date.now() + 60000;
  while (builds.length < 3) {
    if (Date.now() > deadline) fail(`watch: build ${builds.length + 1} wrote no lockfile`);
    await new Promise(r => setTimeout(r, 100));
    if (!fs.existsSync(lockfile)) continue;
    builds.push(names());
    if (builds.length === 3) break; // (the last build's lockfile stays, for the case to check)
    fs.rmSync(lockfile);
    fs.writeFileSync(input, builds.length === 1 ? without : source);
  }
  await ctx.dispose();
  console.log(JSON.stringify(builds));
} else fail(`unknown mode ${mode}`);
