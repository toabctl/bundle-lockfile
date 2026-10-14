// Builds through Parcel's JavaScript API (@parcel/core), as tools do: node build.mjs <mode>
//   api    new Parcel({ entries, defaultConfig }).run() into dist/
//   watch  .watch(): builds, rebuilds without src/main.js's is-number line (is-number must leave the lockfile), rebuilds
//          with it (it must come back); the lockfile is deleted before every build; prints the package list of every
//          build as JSON last. src/main.js is restored also on failure. (Not without the lazy import of nanoid: Parcel
//          2.16.4's rebuild then fails, "bundleInfoMap[bundleId] is not iterable", also without bundle-lockfile.)
import fs from 'node:fs';
import path from 'node:path';
import { Parcel } from '@parcel/core';

const mode = process.argv[2];
const dist = path.resolve('dist');
const lockfile = path.join(dist, 'bundle-lockfile/package-lock.json');
const fail = (msg) => { console.error(msg); process.exit(1); };
// (mode: production, as parcel build: the API's default is development, without scope hoisting and tree shaking)
const options = { entries: 'src/index.html', defaultConfig: '@parcel/config-default', mode: 'production', defaultTargetOptions: { distDir: dist }, shouldDisableCache: true };
const names = () => Object.entries(JSON.parse(fs.readFileSync(lockfile, 'utf8')).packages).filter(([k]) => k).map(([, p]) => `${p.name}@${p.version}`).sort();

if (mode === 'api') {
  await new Parcel(options).run();
} else if (mode === 'watch') {
  const input = 'src/main.js';
  const source = fs.readFileSync(input, 'utf8');
  const without = source.split('\n').filter(l => !l.includes('is-number')).join('\n');
  process.on('exit', () => fs.writeFileSync(input, source));
  fs.rmSync(lockfile, { force: true });
  const builds = [];
  let done;
  const finished = new Promise(r => { done = r; });
  const sub = await new Parcel(options).watch((err, event) => {
    if (err || event.type === 'buildFailure') fail(`watch: ${err || JSON.stringify(event.diagnostics)}`);
    if (!fs.existsSync(lockfile)) fail(`watch: build ${builds.length + 1} wrote no lockfile`);
    builds.push(names());
    if (builds.length === 3) return done();
    fs.rmSync(lockfile);
    setTimeout(() => fs.writeFileSync(input, builds.length === 1 ? without : source), 200);
  });
  await Promise.race([finished, new Promise((_, rej) => setTimeout(() => rej(new Error('watch: timeout')), 120000))]).catch(e => fail(e.message));
  await sub.unsubscribe();
  console.log(JSON.stringify(builds));
} else fail(`unknown mode ${mode}`);
