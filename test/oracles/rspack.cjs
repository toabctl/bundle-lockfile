'use strict';
// Oracle for rspack fixtures: builds the fixture's rspack.config.js through rspack's JavaScript API WITHOUT
// bundle-lockfile, into dist-oracle/, and derives the packages from rspack's stats (stats.cjs). Shares no code with the
// adapter, which reads the chunk graph, the files rspack copied and the modules whose exports it inlined. Two settings
// differ from the build, so that what it ships is seen:
// - no exports inlined (optimization.inlineExports: false from rspack 1.7, experiments.inlineConst and inlineEnum false
//   in 1.4 - 1.6, see stats.cjs oracleRspackConfig): rspack inlines a module's constant exports into the modules using
//   them, and the module is then in no chunk; here it stays in one
// - optimization.minimize: false: copied files (asset info.copied) keep their bytes, which are matched against the files
//   in packages the compilation depends on (CopyRspackPlugin's sourceFilename is relative to its pattern, not the context)
// Neither changes which other modules are bundled.
// usage (cwd = fixture): node oracles/rspack.cjs [--from <dir>]    (Yarn PnP: yarn node ...)
//   --from: the @rspack/core resolved from <dir> (a command line with its own rspack, e.g. node_modules/@rspack/cli)
//   --sources: prints { packages: <that>, sources: [<absolute path of every emitted source file>] } (for oracles/nested.cjs)
// prints {"<compiler output dir relative to dist>": [name@version, ...], ...}; compilers sharing an output dir share its
// lockfile, so their packages are merged
const path = require('path');
const { createRequire } = require('module');
const { rspackResult, oracleRspackConfig } = require('./stats.cjs');

const args = process.argv.slice(2);
const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : '.';
const rspack = createRequire(path.resolve(from, 'package.json'))('@rspack/core');
const config = createRequire(path.resolve('package.json'))('./rspack.config.js');
const dist = path.resolve('dist');
const oracleDist = path.resolve('dist-oracle');

const configs = Array.isArray(config) ? config : [config];
for (const c of configs) {
  const out = c.output && c.output.path ? path.resolve(c.output.path) : dist;
  c.output = { ...c.output, path: path.join(oracleDist, path.relative(dist, out)) };
  oracleRspackConfig(c, rspack.rspackVersion);
}

rspack(Array.isArray(config) ? configs : configs[0], (err, stats) => {
  if (err || stats.hasErrors()) { console.error(err || stats.toString('errors-only')); process.exit(1); }
  const sources = new Set();
  const packages = rspackResult(stats, oracleDist, sources);
  console.log(JSON.stringify(args.includes('--sources') ? { packages, sources: [...sources].sort() } : packages));
});
