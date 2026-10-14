'use strict';
// Oracle for Rollup command-line fixtures: builds again WITHOUT bundle-lockfile, with Rollup's own source maps
// (rollup -c --sourcemap --dir dist-oracle), and derives the packages from the maps' sources. Shares no code with the
// adapter, which reads the chunks' module lists.
// usage (cwd = fixture): node oracles/rollup.cjs [--config <file>] [--out <dir> | --out-file <file>]
// (--out-file for a config with output.file)
// prints {"": [name@version, ...]} (the output dir relative to itself); --by-file (for oracles/nested-vite.cjs):
// { packages: <that>, byFile: { "<output file relative to the output dir>": [name@version, ...] } }; --sources:
// { packages: <that>, sources: [absolute path of every source in a map] }
const fs = require('fs');
const path = require('path');
const owner = require('./owner.cjs');
const { spawnSync } = require('child_process');
const { hasJs, resolved } = require('../lib/bundlers.cjs');

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const outFile = arg('--out-file', null);
const out = path.resolve(outFile ? path.dirname(outFile) : arg('--out', 'dist-oracle'));
const configFile = arg('--config', null);
fs.rmSync(out, { recursive: true, force: true });
// resolved from the fixture (also with Yarn Plug'n'Play: run with `yarn node`, whose NODE_OPTIONS load PnP, which the
// build keeps; run.cjs passes no --require of bundle-lockfile)
// (rollup's main entry is dist/rollup.js; early 4.x releases export no ./package.json)
const rollup = path.join(path.dirname(require('module').createRequire(path.resolve('package.json')).resolve('rollup')), 'bin/rollup');
const target = outFile ? ['--file', path.resolve(outFile)] : ['--dir', out];
const r = spawnSync(process.execPath, [rollup, '-c', ...(configFile ? [configFile] : []), '--sourcemap', ...target], { encoding: 'utf8', env: process.env });
if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }

const files = new Set();
const filesOf = new Map(); // output file (relative to out) -> its sources
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.map')) {
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      const own = (m.sources || []).map(s => path.resolve(path.dirname(p), m.sourceRoot || '', s.split('?')[0]));
      own.forEach(f => files.add(f));
      filesOf.set(path.relative(out, p.slice(0, -'.map'.length)).split(path.sep).join('/'), own);
    }
  }
};
walk(out);

// the packages of source files: see owner.cjs (the build's working directory is its context); with JavaScript in the
// output, also the Rollup that wrote it (test/lib/bundlers.cjs)
const packagesOf = (list) => owner.packagesOf(list);
const bundler = [resolved(process.env.BLTEST_ORACLE_BUNDLER || 'rollup', '.')].filter(Boolean); // (run.cjs: the case's bundler)
const result = { '': [...new Set([...packagesOf(files), ...(hasJs(out) ? bundler : [])])].sort() };
const extra = {
  ...(process.argv.includes('--by-file') && { byFile: Object.fromEntries([...filesOf].map(([f, list]) => [f, [...packagesOf(list), ...(/\.[cm]?js$/.test(f) ? bundler : [])].sort()])) }),
  ...(process.argv.includes('--sources') && { sources: [...files].sort() }),
};
console.log(JSON.stringify(Object.keys(extra).length ? { packages: result, ...extra } : result));
