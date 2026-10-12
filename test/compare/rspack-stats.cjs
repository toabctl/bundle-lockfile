'use strict';
// Comparison tooling (not used by the tests), for real rspack projects: loads bundle-lockfile and, through its own
// compiler hook (rspack adapter onCompiler: the same compilers it attaches to), records for every top-level rspack
// compiler what rspack's stats say is in its output - computed by the oracles' code (test/oracles/stats.cjs, owner.cjs),
// which shares nothing with the adapter's collection:
//   NODE_OPTIONS="--require <repo>/test/compare/rspack-stats.cjs" BLTEST_TRUTH_DIR=<dir>
// Per compiler and build: <dir>/<pid>-<n>.json { outputPath, context, name, packages, copies } (packages: name@version
// from the stats' modules, child compilations and the copies matched by their bytes). report-rspack.cjs compares them
// with the lockfiles. Stats cannot see what loaders inline (style partials) nor modules whose exports rspack inlined;
// copies minimized after copying do not match by bytes: the report lists those as "only in the lockfile".
const fs = require('fs');
const path = require('path');
require('../../src/register.cjs');
const rspackAdapter = require('../../src/adapters/rspack.cjs');
const { STATS_OPTIONS, packagesFromStats, rspackCopies } = require('../oracles/stats.cjs');

const dir = process.env.BLTEST_TRUTH_DIR;
if (!dir) throw new Error('rspack-stats: set BLTEST_TRUTH_DIR');
fs.mkdirSync(dir, { recursive: true });
let n = 0;

rspackAdapter.onCompiler((compiler) => {
  compiler.hooks.done.tap('bundle-lockfile-truth', (stats) => {
    try {
      const compilation = stats.compilation;
      const outputPath = compilation.getPath(compiler.outputPath, {});
      const json = stats.toJson(STATS_OPTIONS);
      const copies = rspackCopies(compilation, json, outputPath);
      const packages = packagesFromStats(json, compiler.context, copies);
      fs.writeFileSync(path.join(dir, `${process.pid}-${++n}.json`), JSON.stringify({
        outputPath, context: compiler.context, name: compiler.name || null, errors: stats.hasErrors(), packages, copies,
      }, null, 1));
    } catch (e) { console.error('[rspack-stats] could not record the stats:', e); }
  });
});
