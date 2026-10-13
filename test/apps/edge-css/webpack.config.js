// CSS from a package. EDGE_CSS=native: webpack 5's own CSS support (experiments.css) instead of
// mini-css-extract-plugin + css-loader.
// EDGE_CSS=inline: a first-party style sheet (src/icons.css) whose url() of a package's image is inlined as a data: URL
// (asset/inline): mini-css-extract-plugin builds that asset module at build time, in no chunk
const path = require('path');
const native = process.env.EDGE_CSS === 'native', inline = process.env.EDGE_CSS === 'inline';
const MiniCssExtractPlugin = native ? null : require('mini-css-extract-plugin');
module.exports = {
  mode: 'production', entry: inline ? './src/icons.js' : './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  ...(native
    ? { experiments: { css: true } }
    : { module: { rules: [{ test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] }, ...(inline ? [{ test: /\.svg$/, type: 'asset/inline' }] : [])] },
      plugins: [new MiniCssExtractPlugin()] }),
};
