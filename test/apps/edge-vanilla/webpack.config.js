// vanilla-extract turns src/styles.css.js into CSS through a virtual module whose request reads a placeholder
// file of the plugin: "<file>.vanilla.css!=!<loader>?<css>!@vanilla-extract/webpack-plugin/extracted.js"
const path = require('path');
const { VanillaExtractPlugin } = require('@vanilla-extract/webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
module.exports = {
  mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  module: { rules: [{ test: /\.vanilla\.css$/i, use: [MiniCssExtractPlugin.loader, { loader: 'css-loader', options: { url: false } }] }] },
  plugins: [new VanillaExtractPlugin(), new MiniCssExtractPlugin()],
};
