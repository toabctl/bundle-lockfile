// workbox's InjectManifest compiles src/sw.js in a child compiler into dist/sw.js;
// html-webpack-plugin adds a child compiler that only runs at build time
const path = require('path');
const { InjectManifest } = require('workbox-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
module.exports = {
  mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  plugins: [new HtmlWebpackPlugin(), new InjectManifest({ swSrc: './src/sw.js', swDest: 'sw.js' })],
};
