// Two compilers, built in parallel, write to the same output dir (like an app and its service worker):
// they share dist/bundle-lockfile/package-lock.json, which must list the packages of both.
const path = require('path');
const out = { path: path.join(__dirname, 'dist') };
const variants = {
  default: () => [
    { name: 'app', mode: 'production', entry: './src/app.js', output: { ...out, filename: 'app.js' } },
    { name: 'sw', mode: 'production', target: 'webworker', entry: './src/sw.js', output: { ...out, filename: 'sw.js' } },
  ],
  // EDGE_SHARED=query: app's file names carry a query string, which webpack does not write to disk. sw lands
  // last and checks whether app's files are still there
  query: () => [
    { name: 'app', mode: 'production', entry: './src/app.js', output: { ...out, filename: '[name].js?[contenthash]' } },
    { name: 'sw', dependencies: ['app'], mode: 'production', target: 'webworker', entry: './src/sw.js', output: { ...out, filename: 'sw.js' } },
  ],
  // EDGE_SHARED=alias: two configs that differ only in resolve.alias (like modern and legacy builds), with the same
  // name, entry, target and file name templates: their [contenthash] files differ, both are shipped
  alias: () => ['ms', 'debug'].map(dep => ({
    mode: 'production', entry: './src/dep.js', resolve: { alias: { dep } }, output: { ...out, filename: '[name].[contenthash].js' },
  })),
  // EDGE_SHARED=fullhash: output.path 'dist/[fullhash]' - the same setting, but different directories: nothing shared
  fullhash: () => variants.default().map(c => ({ ...c, output: { ...c.output, path: path.join(out.path, '[fullhash]') } })),
};
module.exports = variants[process.env.EDGE_SHARED || 'default']();
