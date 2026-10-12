'use strict';
// Oracle for Rsbuild fixtures: builds the fixture's Rsbuild config again through Rsbuild's JavaScript API WITHOUT
// bundle-lockfile, into dist-oracle/, and derives the packages from the stats of each environment's compiler, as
// oracles/rspack.cjs does (and with the same two rspack settings changed, see there). An environment's own output
// directory (e.g. dist/server) goes to the same place below dist-oracle/.
// usage (cwd = fixture): node oracles/rsbuild.cjs    (Yarn PnP: yarn node ...)
// prints {"<compiler output dir relative to dist>": [name@version, ...], ...}
const path = require('path');
const { createRequire } = require('module');
const { pathToFileURL } = require('url');
const { rspackResult } = require('./stats.cjs');

const oracleDist = path.resolve('dist-oracle');
// dist/<dir> -> dist-oracle/<dir>, relative to the fixture as Rsbuild takes it
const toOracle = (root) => path.relative(process.cwd(), path.join(oracleDist, path.relative(path.resolve('dist'), path.resolve(root))));
const redirect = (output = {}, root = 'dist') => ({ ...output, distPath: { ...output.distPath, root: toOracle((output.distPath && output.distPath.root) || root) } });

(async () => {
  const { createRsbuild, loadConfig, rspack } = await import(pathToFileURL(createRequire(path.resolve('package.json')).resolve('@rsbuild/core')).href);
  const [major, minor] = rspack.rspackVersion.split('.').map(Number);
  const { content } = await loadConfig({ cwd: process.cwd() });
  const tools = content.tools || {};
  const environments = content.environments && Object.fromEntries(Object.entries(content.environments)
    .map(([name, env]) => [name, env.output && env.output.distPath && env.output.distPath.root ? { ...env, output: redirect(env.output) } : env]));
  const rsbuildConfig = { ...content, output: redirect(content.output), ...(environments && { environments }),
    tools: { ...tools, rspack: [].concat(tools.rspack || [], (config) => {
      config.optimization = { ...config.optimization, minimize: false, ...((major > 1 || minor >= 7) && { inlineExports: false }) };
    }) } };
  const rsbuild = await createRsbuild({ cwd: process.cwd(), rsbuildConfig });
  let all;
  rsbuild.onAfterBuild(({ stats }) => { all = stats; });
  await rsbuild.build();
  console.log(JSON.stringify(rspackResult(all, oracleDist)));
})().catch((e) => { console.error(e); process.exit(1); });
