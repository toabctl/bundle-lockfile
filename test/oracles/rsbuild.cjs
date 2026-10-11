'use strict';
// Oracle for Rsbuild fixtures: builds the fixture's Rsbuild config again through Rsbuild's JavaScript API WITHOUT
// bundle-lockfile, into dist-oracle/, and derives the packages from the stats of each environment's compiler, as
// oracles/rspack.cjs does (and with the same two rspack settings changed, see there).
// usage (cwd = fixture): node oracles/rsbuild.cjs    (Yarn PnP: yarn node ...)
// prints {"<compiler output dir relative to dist>": [name@version, ...], ...}
const path = require('path');
const { createRequire } = require('module');
const { pathToFileURL } = require('url');
const { STATS_OPTIONS, packagesFromStats, rspackCopies } = require('./stats.cjs');

const oracleDist = path.resolve('dist-oracle');

(async () => {
  const { createRsbuild, loadConfig, rspack } = await import(pathToFileURL(createRequire(path.resolve('package.json')).resolve('@rsbuild/core')).href);
  const [major, minor] = rspack.rspackVersion.split('.').map(Number);
  const { content } = await loadConfig({ cwd: process.cwd() });
  const output = content.output || {}, tools = content.tools || {};
  const rsbuildConfig = { ...content,
    output: { ...output, distPath: { ...output.distPath, root: path.relative(process.cwd(), oracleDist) } },
    tools: { ...tools, rspack: [].concat(tools.rspack || [], (config) => {
      config.optimization = { ...config.optimization, minimize: false, ...((major > 1 || minor >= 7) && { inlineExports: false }) };
    }) } };
  const rsbuild = await createRsbuild({ cwd: process.cwd(), rsbuildConfig });
  let all;
  rsbuild.onAfterBuild(({ stats }) => { all = stats; });
  await rsbuild.build();
  const result = {};
  for (const s of all.stats || [all]) {
    const outputPath = s.compilation.outputOptions.path;
    const rel = path.relative(oracleDist, outputPath).split(path.sep).join('/');
    const json = s.toJson(STATS_OPTIONS);
    const pkgs = packagesFromStats(json, s.compilation.compiler.context, rspackCopies(s.compilation, json, outputPath));
    result[rel] = [...new Set([...(result[rel] || []), ...pkgs])].sort();
  }
  console.log(JSON.stringify(result));
})().catch((e) => { console.error(e); process.exit(1); });
