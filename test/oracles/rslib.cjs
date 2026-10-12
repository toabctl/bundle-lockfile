'use strict';
// Oracle for Rslib fixtures: builds the fixture's Rslib config again through Rslib's JavaScript API WITHOUT
// bundle-lockfile, into dist-oracle/, and derives the packages from the stats of each library format's compiler, as
// oracles/rsbuild.cjs does for Rsbuild (Rslib builds with Rsbuild; the same two rspack settings changed, see
// oracles/rspack.cjs).
// usage (cwd = fixture): node oracles/rslib.cjs
// prints {"<compiler output dir relative to dist>": [name@version, ...], ...}
const path = require('path');
const { createRequire } = require('module');
const { pathToFileURL } = require('url');
const { rspackResult } = require('./stats.cjs');

const oracleDist = path.resolve('dist-oracle');

(async () => {
  const { createRslib, loadConfig, rspack } = await import(pathToFileURL(createRequire(path.resolve('package.json')).resolve('@rslib/core')).href);
  const [major, minor] = rspack.rspackVersion.split('.').map(Number);
  const { content } = await loadConfig({ cwd: process.cwd() });
  if (content.lib.some(lib => lib.output && lib.output.distPath)) throw new Error('rslib oracle: a library with its own output directory');
  const output = content.output || {}, tools = content.tools || {};
  const config = { ...content,
    output: { ...output, distPath: { ...output.distPath, root: path.relative(process.cwd(), oracleDist) } },
    tools: { ...tools, rspack: [].concat(tools.rspack || [], (c) => {
      c.optimization = { ...c.optimization, minimize: false, ...((major > 1 || minor >= 7) && { inlineExports: false }) };
    }) } };
  const rslib = await createRslib({ cwd: process.cwd(), config });
  let all;
  rslib.onAfterCreateRsbuild(({ rsbuild }) => { rsbuild.onAfterBuild(({ stats }) => { all = stats; }); });
  await rslib.build();
  console.log(JSON.stringify(rspackResult(all, oracleDist)));
})().catch((e) => { console.error(e); process.exit(1); });
