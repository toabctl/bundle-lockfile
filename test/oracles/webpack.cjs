'use strict';
// Oracle for plain webpack fixtures: builds through webpack's Node API WITHOUT bundle-lockfile.
// usage (cwd = fixture): node oracles/webpack.cjs    (Yarn PnP: yarn node ...)
// prints {"<output dir relative to the case's outDir>": [name@version, ...]} - one entry, the main compiler
const path = require('path');
const { createRequire } = require('module');
const { STATS_OPTIONS, packagesFromStats } = require('./stats.cjs');

const req = createRequire(path.join(process.cwd(), 'package.json'));
const webpack = req('webpack');
const config = req('./webpack.config.js');
config.output = { ...config.output, path: path.resolve('dist-oracle') };

webpack(config, (err, stats) => {
  if (err || stats.hasErrors()) { console.error(err || stats.toString('errors-only')); process.exit(1); }
  console.log(JSON.stringify({ '': packagesFromStats(stats.toJson(STATS_OPTIONS)) }));
});
