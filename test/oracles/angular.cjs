'use strict';
// Oracle for Angular fixtures: builds again WITHOUT bundle-lockfile, with source maps (the fixture's "oracle"
// configuration: no packages' own source maps, vendor: false), into dist-oracle, and derives the packages from the
// maps' sources (Angular writes them relative to the workspace root; else relative to the map's directory). Shares no code with the adapter, which reads Angular's stats metafile. Source maps leave out what has no
// mappings (an asset Angular copies): a case names those.
// usage (cwd = fixture): node oracles/angular.cjs [--browser-as-root]
// prints {"browser": [name@version, ...]} (the browser output, relative to the output path dist/), or with
// --browser-as-root {"": [...]} (a case whose output directory is dist/browser)
const fs = require('fs');
const path = require('path');
const owner = require('./owner.cjs');
const { spawnSync } = require('child_process');

const out = path.resolve('dist-oracle');
fs.rmSync(out, { recursive: true, force: true });
const ng = require('module').createRequire(path.resolve('package.json')).resolve('@angular/cli/bin/ng.js');
// without the chunk optimizer: the maps of the chunks it re-bundles (with Rolldown) no longer name the source files.
// Its view is esbuild's before the optimizer, which does not add packages, and may leave some out (a case says so).
const r = spawnSync(process.execPath, [ng, 'build', '--configuration', 'production,oracle', '--output-path', out],
  { encoding: 'utf8', env: { ...process.env, NG_CLI_ANALYTICS: 'false', NG_BUILD_OPTIMIZE_CHUNKS: '0' } });
if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }

const files = new Set();
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.map')) {
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const s of m.sources || []) {
        const rel = s.split('?')[0], own = path.resolve(rel), local = path.resolve(path.dirname(p), m.sourceRoot || '', rel);
        if (fs.existsSync(own)) files.add(own); else if (fs.existsSync(local)) files.add(local);
      }
    }
  }
};
walk(path.join(out, 'browser'));
console.log(JSON.stringify({ [process.argv.includes('--browser-as-root') ? '' : 'browser']: owner.packagesOf(files) }));
