// rspack's own features, whose output comes from packages besides the chunks' JavaScript modules: native CSS (an
// @import of normalize.css), CssExtractRspackPlugin with style sheets loaders inline from packages (a Sass partial from
// bulma, a Less @import of normalize.less), a font from bootstrap-icons (asset/resource), a worker (is-number), files
// copied by CopyRspackPlugin (also by a glob, transformed, and minimized after the copy), and packages whose exports
// rspack inlines (consts-only, consts-default)
const path = require('path');
const rspack = require('@rspack/core');
const major = Number(rspack.rspackVersion.split('.')[0]);
const extract = [rspack.CssExtractRspackPlugin.loader, 'css-loader'];
const pkg = (name) => path.join(__dirname, 'node_modules', name);
const persistent = { type: 'persistent', storage: { type: 'filesystem', directory: path.join(__dirname, '.cache-test') } };
module.exports = {
  mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  module: { rules: [
    { test: /\.css$/, type: 'css' },
    // (CssExtractRspackPlugin's modules are JavaScript, also with rspack 1's experiments.css)
    { test: /\.scss$/, use: [...extract, 'sass-loader'], type: 'javascript/auto' },
    { test: /\.less$/, use: [...extract, 'less-loader'], type: 'javascript/auto' },
    { test: /\.woff2$/, type: 'asset/resource' },
  ] },
  plugins: [
    new rspack.CssExtractRspackPlugin({ filename: 'extracted.css' }),
    new rspack.CopyRspackPlugin({ patterns: [
      { from: require.resolve('left-pad'), to: 'copied/left-pad.js', toType: 'file' }, // a package's file
      { from: path.dirname(require.resolve('sanitize.css/package.json')), to: 'vendor/sanitize' }, // a package's directory
      { from: 'static', to: 'static' }, // first-party files: not packages
      { from: '*.js', context: pkg('escape-html'), to: 'glob' }, // a glob in a package's directory: index.js
      // changed bytes: the adapter lists every package with a file of that name among the build's files (reset.css: one)
      { from: path.join(pkg('reset-css'), 'reset.css'), to: 'copied/reset.css', transform: (input) => `/* copied */\n${input}` },
      // minimized by rspack's CSS minimizer after the copy
      { from: path.join(pkg('modern-normalize'), 'modern-normalize.css'), to: 'copied/modern-normalize.css' },
    ] }),
  ],
  // native CSS: rspack 1 behind experiments.css. RSPACK_CACHE=1: the persistent cache (rspack 1: experiments.cache)
  ...(major >= 2 ? {} : { experiments: { css: true } }),
  ...(process.env.RSPACK_CACHE && (major >= 2 ? { cache: persistent } : { cache: true, experiments: { css: true, cache: persistent } })),
};
