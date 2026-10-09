'use strict';
// Oracle for Vite fixtures: builds again WITHOUT bundle-lockfile, with Vite's own source maps
// (vite build --sourcemap --outDir dist-oracle), and derives the packages from the maps' sources. Shares no code with
// the adapter, which reads the chunks' module lists. Vite writes no source maps for CSS in builds, so packages that
// only contribute CSS are not seen here (cases list them in oracleMissing).
// usage (cwd = fixture): node oracles/vite.cjs [vite build options, e.g. --config island/vite.config.mjs] [--out <dir>]
//   [--sources] [--by-file]
// prints {"": [name@version, ...]} (the output dir relative to itself); --sources / --by-file (for the nested oracles):
// { packages: <that>, sources: [absolute path of every source in a map], byFile: { "<output file relative to the
// output dir>": [name@version, ...] } (the packages of each output file with a map) }
const fs = require('fs');
const path = require('path');
const owner = require('./owner.cjs');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const flag = (name) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const args = process.argv.slice(2);
const listSources = flag('--sources'), byFile = flag('--by-file');
const outIdx = args.indexOf('--out');
const out = path.resolve(outIdx >= 0 ? args.splice(outIdx, 2)[1] : 'dist-oracle');
// resolved from the fixture (also with Yarn Plug'n'Play: run with `yarn node`, whose NODE_OPTIONS load PnP, which the
// build keeps; run.cjs passes no --require of bundle-lockfile)
const vite = path.join(path.dirname(createRequire(path.resolve('package.json')).resolve('vite/package.json')), 'bin/vite.js');
const r = spawnSync(process.execPath, [vite, 'build', ...args, '--sourcemap', '--outDir', out, '--emptyOutDir'], { encoding: 'utf8', env: process.env });
if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }

// Relative sources are relative to the map in most maps, but not in all: a worker's map (in assets/) is relative to
// the output dir, workbox's (sw.js, workbox-<hash>.js) to the project, plugin-legacy's polyfills to the output dir of
// its nested build (below node_modules/@vitejs/plugin-legacy). The first candidate that exists is the source.
const resolveSource = (map, root, s) => {
  const candidates = [path.resolve(path.dirname(map), root, s), path.resolve(out, s), path.resolve(s), path.resolve('node_modules', s.replace(/^(\.\.\/)+/, ''))];
  return candidates.find(f => fs.existsSync(f)) || candidates[0];
};
const files = new Set();
const filesOf = new Map(); // output file (relative to out) -> its sources
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.map')) {
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      const own = (m.sources || []).map(s => resolveSource(p, m.sourceRoot || '', s.split('?')[0]));
      own.forEach(f => files.add(f));
      filesOf.set(path.relative(out, p.slice(0, -'.map'.length)).split(path.sep).join('/'), own);
    }
  }
};
walk(out);

// the packages of source files: see owner.cjs (the build's working directory is its context)
const packagesOf = (list) => owner.packagesOf(list);
const result = { '': packagesOf(files) };
console.log(JSON.stringify(listSources || byFile ? {
  packages: result, sources: [...files].sort(), byFile: Object.fromEntries([...filesOf].map(([f, list]) => [f, packagesOf(list)])),
} : result));
