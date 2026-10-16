// rspack's own features, whose output comes from packages besides the chunks' JavaScript modules: native CSS (an
// @import of normalize.css), CssExtractRspackPlugin with style sheets loaders inline from packages (a Sass partial from
// bulma, a Less @import of normalize.less), a font from bootstrap-icons (asset/resource), a worker (is-number), files
// copied by CopyRspackPlugin (also by a glob, transformed, and minimized after the copy), and packages whose exports
// rspack inlines (consts-only, consts-default)
const path = require('path');
const rspack = require('@rspack/core');
const [major, minor] = rspack.rspackVersion.split('.').map(Number);
const extract = [rspack.CssExtractRspackPlugin.loader, 'css-loader'];
const pkg = (name) => path.join(__dirname, 'node_modules', name);
// rspack 1.4 - 1.6 inline constant exports only with experiments.inlineConst (1.7 and later: optimization.inlineExports,
// production by default in rspack 2)
const experiments = { css: true, ...(major === 1 && minor >= 4 && minor <= 6 && { inlineConst: true }) };
const persistent = { type: 'persistent', storage: { type: 'filesystem', directory: path.join(__dirname, '.cache-test') } };
// RSPACK_MODE=development: no usage analysis (optimization.usedExports), no minimizer
module.exports = {
  mode: process.env.RSPACK_MODE || 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  module: { rules: [
    { test: /\.css$/, type: 'css' },
    // (CssExtractRspackPlugin's modules are JavaScript, also with rspack 1's experiments.css)
    { test: /\.scss$/, use: [...extract, 'sass-loader'], type: 'javascript/auto' },
    { test: /\.less$/, use: [...extract, 'less-loader'], type: 'javascript/auto' },
    { test: /\.woff2$/, type: 'asset/resource' },
  ],
  // rspack 1.4 also needs the parser option (1.5 and 1.6 set it with the experiment)
  ...(major === 1 && minor === 4 && { parser: { javascript: { inlineConst: true } } }) },
  plugins: [
    new rspack.CssExtractRspackPlugin({ filename: 'extracted.css' }),
    new rspack.CopyRspackPlugin({ patterns: [
      { from: require.resolve('left-pad'), to: 'copied/left-pad.js', toType: 'file' }, // a package's file
      { from: path.dirname(require.resolve('sanitize.css/package.json')), to: 'vendor/sanitize' }, // a package's directory
      { from: 'static', to: 'static' }, // first-party files: not packages
      { from: '*.js', context: pkg('escape-html'), to: 'glob' }, // a glob in a package's directory: index.js
      // changed bytes: the adapter lists every package with a file of that name among the build's files (reset.css: one)
      { from: path.join(pkg('reset-css'), 'reset.css'), to: 'copied/reset.css', transform: (input) => `/* copied */\n${input}` },
      // the project's own package.json, changed (a library's build does this): first-party, though the build read every
      // package's package.json
      { from: 'package.json', to: 'copied/package.json', transform: (input) => JSON.stringify({ ...JSON.parse(input), private: false }) },
      // minimized by rspack's CSS minimizer after the copy
      { from: path.join(pkg('modern-normalize'), 'modern-normalize.css'), to: 'copied/modern-normalize.css' },
    ] }),
  ],
  // native CSS: rspack 1 behind experiments.css. RSPACK_CACHE=1: the persistent cache (rspack 1: experiments.cache)
  ...(major >= 2 ? {} : { experiments }),
  ...(process.env.RSPACK_CACHE && (major >= 2 ? { cache: persistent } : { cache: true, experiments: { ...experiments, cache: persistent } })),
};
