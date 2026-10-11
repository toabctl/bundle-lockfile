// A programmatic build through rspack's JavaScript API, loaded with require() (rspack 2: require(esm))
const { rspack } = require('@rspack/core');
const compiler = rspack(require('./rspack.config.js'));
compiler.run((err, stats) => {
  if (err || stats.hasErrors()) { console.error(err || stats.toString('errors-only')); process.exitCode = 1; }
  compiler.close(() => {});
});
