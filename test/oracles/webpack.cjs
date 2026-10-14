'use strict';
// Oracle for plain webpack fixtures: builds through webpack's Node API WITHOUT bundle-lockfile.
// Supports single configs and arrays (multi-compiler); outputs are redirected from dist/ to dist-oracle/.
// usage (cwd = fixture): node oracles/webpack.cjs    (Yarn PnP: yarn node ...)
// prints {"<compiler output dir relative to dist>": [name@version, ...], ...}; compilers sharing an output dir
// share its lockfile, so their packages are merged. --sources: prints { packages: <that>, sources: [<absolute path of
// every emitted source file>] } (for oracles/nested.cjs)
const path = require('path');
const { createRequire } = require('module');
const { STATS_OPTIONS, filesFromStats, packagesFromStats, copiedFiles, bundlerOf, compilerBundler } = require('./stats.cjs');
const { workboxRollup } = require('../lib/bundlers.cjs');
const helpers = require('../lib/helpers.cjs');

const req = createRequire(path.join(process.cwd(), 'package.json'));
const webpack = req('webpack');
const config = req('./webpack.config.js');
const dist = path.resolve(process.env.BLTEST_OUT_DIR || 'dist'); // (the case's output directory, as test/run.cjs passes it)
const oracleDist = path.resolve('dist-oracle');

const configs = Array.isArray(config) ? config : [config];
for (const c of configs) {
  const out = c.output && c.output.path ? path.resolve(c.output.path) : dist;
  c.output = { ...c.output, path: path.join(oracleDist, path.relative(dist, out)) };
}

webpack(Array.isArray(config) ? configs : configs[0], (err, stats) => {
  if (err || stats.hasErrors()) { console.error(err || stats.toString('errors-only')); process.exit(1); }
  const result = {}, sources = new Set();
  for (const s of stats.stats || [stats]) {
    const outputPath = s.compilation.getPath(s.compilation.outputOptions.path, {}); // e.g. dist/[fullhash]
    const rel = path.relative(oracleDist, outputPath).split(path.sep).join('/');
    const json = s.toJson(STATS_OPTIONS);
    const copied = copiedFiles(s.compilation, json, outputPath);
    // and the webpack that built it (webpack 4: no compiler.webpack, the module's version)
    // the transpilers whose helpers their loaders inlined (test/lib/helpers.cjs; the modules' sources only where a
    // transpiler loader ran)
    const transpiled = (json.modules || []).some(function has(m) { return /[\\/](babel|swc|ts)-loader[\\/]/.test(m.identifier || '') || (m.modules || []).some(has); });
    const inlined = transpiled ? helpers.ofStats(s.toJson({ modules: true, nestedModules: true, chunks: true, source: true })) : [];
    const pkgs = [...packagesFromStats(json, s.compilation.compiler.context, copied), ...bundlerOf(json, compilerBundler(s.compilation.compiler, `webpack@${req('webpack/package.json').version}`)),
      ...workboxRollup(outputPath), ...inlined]; // (GenerateSW's service worker, workbox-build's Rollup)
    result[rel] = [...new Set([...(result[rel] || []), ...pkgs])].sort();
    for (const f of filesFromStats(json, s.compilation.compiler.context, copied)) sources.add(f);
  }
  console.log(JSON.stringify(process.argv.includes('--sources') ? { packages: result, sources: [...sources].sort() } : result));
});
