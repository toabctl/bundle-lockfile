// The webpack5 app built by rspack (src/index.js), with switches as the edge apps have. It does not load rspack itself
// (tools/build.mjs imports it as an ES module only): the version comes from its package.json
const path = require('path');
// BLTEST_HEAP_FILE=<file>: the build's own heap limit (MB) written there (run.cjs checks the NODE_OPTIONS it ran with)
if (process.env.BLTEST_HEAP_FILE) require('fs').writeFileSync(process.env.BLTEST_HEAP_FILE, String(Math.round(require('v8').getHeapStatistics().heap_size_limit / 1048576)));
const major = Number(require('@rspack/core/package.json').version.split('.')[0]);
const out = path.join(__dirname, 'dist');
// RSPACK_CACHE=1: the persistent cache, so a second build restores the modules instead of building them (rspack 1:
// experiments.cache, 2: cache)
const persistent = { type: 'persistent', storage: { type: 'filesystem', directory: path.join(__dirname, '.cache-test') } };
const cache = major >= 2 ? { cache: persistent } : { cache: true, experiments: { cache: persistent } };
const app = {
  // RSPACK_MODE=development: a development build (no unused-export analysis, no inlined exports)
  // RSPACK_NAKED=1: also node_modules/naked (no package.json, made by the case), which the lockfile cannot list
  mode: process.env.RSPACK_MODE || 'production', entry: process.env.RSPACK_NAKED ? ['./src/index.js', 'naked'] : './src/index.js',
  output: { path: out, filename: 'main.js' },
  ...(process.env.RSPACK_CACHE && cache),
  // RSPACK_EXTERNALS=1: lodash-es comes from a global at runtime (e.g. a CDN script), not from the bundle
  ...(process.env.RSPACK_EXTERNALS && { externals: { 'lodash-es': 'lodashEs' } }),
  // RSPACK_HTML=1: HtmlRspackPlugin writes index.html (rspack loaded only then, see above)
  ...(process.env.RSPACK_HTML && { plugins: [new (require('@rspack/core').HtmlRspackPlugin)()] }),
  // RSPACK_WRITE_TO_DISK=1: rspack serve writes its output to disk too
  ...(process.env.RSPACK_WRITE_TO_DISK && { devServer: { devMiddleware: { writeToDisk: true } } }),
};
// RSPACK_SHARED: two compilers (app, sw) writing to dist/, as edge-shared-output's: 1 (both), clean (app empties the
// directory before writing, output.clean), clean-keep (... but keeps sw.js; rspack tests keep against the absolute
// path, webpack against the one relative to the output dir), query (app's file names carry a query string, which rspack
// does not write to disk; sw is built after it), apart (dist/a and dist/b), fullhash (output.path 'dist/[fullhash]': the
// same setting, but different directories)
const shared = () => {
  const v = process.env.RSPACK_SHARED;
  const clean = { clean: { clean: true }, 'clean-keep': { clean: { keep: /[\\/]sw\.js$/ } } }[v] || {};
  const dir = (sub) => ({ apart: path.join(out, sub), fullhash: path.join(out, '[fullhash]') }[v] || out);
  return [
    { name: 'app', mode: 'production', entry: './src/app.js', output: { path: dir('a'), filename: v === 'query' ? '[name].js?[contenthash]' : 'app.js', ...clean } },
    { name: 'sw', mode: 'production', target: 'webworker', entry: './src/sw.js', output: { path: dir('b'), filename: 'sw.js' },
      ...(v === 'query' && { dependencies: ['app'] }) },
  ];
};
// RSPACK_NESTED=1: app into dist/rspack/, inside the dist/ webpack builds sw into (webpack.config.js), cleaning its own
// directory but keeping boot.js, as Grafana's build (webpack into public/build/, then rspack into public/build/rspack/)
const nested = () => ({ name: 'app', mode: 'production', entry: './src/app.js',
  output: { path: path.join(out, 'rspack'), filename: 'app.js', clean: { keep: /[\\/]boot\.js$/ } } });
// RSPACK_PLUGIN=<path of src/adapters/rspack.cjs>: the plugin in the config, as without NODE_OPTIONS
const withPlugin = (c) => {
  if (!process.env.RSPACK_PLUGIN) return c;
  const { BundleLockfilePlugin } = require(process.env.RSPACK_PLUGIN);
  return { ...c, plugins: [...(c.plugins || []), new BundleLockfilePlugin('bundle-lockfile/package-lock.json')] };
};
module.exports = process.env.RSPACK_SHARED ? shared().map(withPlugin) : withPlugin(process.env.RSPACK_NESTED ? nested() : app);
