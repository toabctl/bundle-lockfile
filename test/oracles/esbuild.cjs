'use strict';
// Oracle for esbuild fixtures: builds again WITHOUT bundle-lockfile, with esbuild's own source maps (the fixture's
// build script with BLTEST_ESBUILD_ORACLE=dist-oracle: the same build, sourcemap: true, into dist-oracle), and derives
// the packages from the maps' sources. Shares no code with the adapter, which reads the metafile. Source maps leave out
// what has no mappings (a file loader's asset, a module that only re-exports): a case names those.
// usage (cwd = fixture): node oracles/esbuild.cjs [--script <file>] [<mode>]   (default: build.mjs build)
// prints {"": [name@version, ...]}
const fs = require('fs');
const path = require('path');
const owner = require('./owner.cjs');
const { spawnSync } = require('child_process');
const { hasJs, resolved } = require('../lib/bundlers.cjs');

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const script = arg('--script', 'build.mjs');
const rest = process.argv.slice(2).filter((a, i, all) => a !== '--script' && all[i - 1] !== '--script');
const out = path.resolve('dist-oracle');
fs.rmSync(out, { recursive: true, force: true });
const r = spawnSync(process.execPath, [script, ...(rest.length ? rest : ['build'])], { encoding: 'utf8', env: { ...process.env, BLTEST_ESBUILD_ORACLE: out } });
if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }

const files = new Set();
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.map')) {
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const s of m.sources || []) files.add(path.resolve(path.dirname(p), m.sourceRoot || '', s.split('?')[0]));
    }
  }
};
walk(out);
// and esbuild, whose runtime helpers are in its JavaScript (test/lib/bundlers.cjs)
const esbuild = hasJs(out) ? [resolved(process.env.BLTEST_ORACLE_BUNDLER || 'esbuild', '.')].filter(Boolean) : []; // (run.cjs: esbuild-wasm)
console.log(JSON.stringify({ '': [...new Set([...owner.packagesOf(files), ...esbuild])].sort() }));
