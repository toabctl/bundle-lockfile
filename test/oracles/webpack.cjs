'use strict';
// Oracle for plain webpack fixtures: builds through webpack's Node API WITHOUT bundle-lockfile.
// Supports single configs and arrays (multi-compiler); outputs are redirected from dist/ to dist-oracle/.
// usage (cwd = fixture): node oracles/webpack.cjs    (Yarn PnP: yarn node ...)
// prints {"<compiler output dir relative to dist>": [name@version, ...], ...}; compilers sharing an output dir
// share its lockfile, so their packages are merged
const path = require('path');
const { createRequire } = require('module');
const { STATS_OPTIONS, packagesFromStats } = require('./stats.cjs');

const req = createRequire(path.join(process.cwd(), 'package.json'));
const webpack = req('webpack');
const config = req('./webpack.config.js');
const dist = path.resolve('dist');
const oracleDist = path.resolve('dist-oracle');

const configs = Array.isArray(config) ? config : [config];
for (const c of configs) {
  const out = c.output && c.output.path ? path.resolve(c.output.path) : dist;
  c.output = { ...c.output, path: path.join(oracleDist, path.relative(dist, out)) };
}

webpack(Array.isArray(config) ? configs : configs[0], (err, stats) => {
  if (err || stats.hasErrors()) { console.error(err || stats.toString('errors-only')); process.exit(1); }
  const result = {};
  for (const s of stats.stats || [stats]) {
    const rel = path.relative(oracleDist, s.compilation.outputOptions.path).split(path.sep).join('/');
    result[rel] = [...new Set([...(result[rel] || []), ...packagesFromStats(s.toJson(STATS_OPTIONS), s.compilation.compiler.context)])].sort();
  }
  console.log(JSON.stringify(result));
});
