'use strict';
// Oracle for plain webpack fixtures: builds through webpack's Node API WITHOUT bundle-lockfile.
// Supports single configs and arrays (multi-compiler); outputs are redirected from dist/ to dist-oracle/.
// usage (cwd = fixture): node oracles/webpack.cjs    (Yarn PnP: yarn node ...)
// prints {"<compiler output dir relative to dist>": [name@version, ...], ...}; compilers sharing an output dir
// share its lockfile, so their packages are merged
const fs = require('fs');
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

// Files copied without naming their source (copy-webpack-plugin 5): assets in no chunk and without
// info.sourceFilename whose bytes are those of a non-empty file dependency in node_modules.
function copiedFiles(compilation, json, outputPath) {
  const candidates = (json.assets || []).filter(a => !(a.chunks || []).length && !(a.info && a.info.sourceFilename))
    .map(a => { try { return fs.readFileSync(path.join(outputPath, a.name.split('?')[0])); } catch { return null; } })
    .filter(bytes => bytes && bytes.length);
  if (!candidates.length) return [];
  const deps = [...compilation.fileDependencies].filter(f => f.split(path.sep).includes('node_modules'));
  const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return -1; } };
  return candidates.map(bytes => deps.find(f => sizeOf(f) === bytes.length && fs.readFileSync(f).equals(bytes))).filter(Boolean);
}

webpack(Array.isArray(config) ? configs : configs[0], (err, stats) => {
  if (err || stats.hasErrors()) { console.error(err || stats.toString('errors-only')); process.exit(1); }
  const result = {};
  for (const s of stats.stats || [stats]) {
    const outputPath = s.compilation.getPath(s.compilation.outputOptions.path, {}); // e.g. dist/[fullhash]
    const rel = path.relative(oracleDist, outputPath).split(path.sep).join('/');
    const json = s.toJson(STATS_OPTIONS);
    const pkgs = packagesFromStats(json, s.compilation.compiler.context, copiedFiles(s.compilation, json, outputPath));
    result[rel] = [...new Set([...(result[rel] || []), ...pkgs])].sort();
  }
  console.log(JSON.stringify(result));
});
