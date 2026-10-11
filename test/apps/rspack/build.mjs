// A programmatic build through rspack's JavaScript API, imported (rspack 1: a CommonJS module, rspack 2: an ES module)
// from a package that depends on it
import * as core from '@rspack/core';
import config from './rspack.config.js';

const { rspack } = core.rspack ? core : core.default;
const compiler = rspack(config);
compiler.run((err, stats) => {
  if (err || stats.hasErrors()) { console.error(err || stats.toString('errors-only')); process.exitCode = 1; }
  compiler.close(() => {});
});
