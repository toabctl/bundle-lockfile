// CSS from a package. EDGE_CSS=native: webpack 5's own CSS support (experiments.css) instead of
// mini-css-extract-plugin + css-loader
const path = require('path');
const native = process.env.EDGE_CSS === 'native';
const MiniCssExtractPlugin = native ? null : require('mini-css-extract-plugin');
module.exports = {
  mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  ...(native
    ? { experiments: { css: true } }
    : { module: { rules: [{ test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] }] }, plugins: [new MiniCssExtractPlugin()] }),
};
