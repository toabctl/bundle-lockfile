// workbox's InjectManifest compiles src/sw.js in a child compiler into dist/sw.js;
// html-webpack-plugin adds a child compiler that only runs at build time.
// EDGE_SW=generate: GenerateSW instead, which generates sw.js and workbox-<hash>.js with workbox-build (Rollup's
// generate(), no webpack modules) and emits them as assets
const path = require('path');
const { InjectManifest, GenerateSW } = require('workbox-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
module.exports = {
  mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  plugins: [new HtmlWebpackPlugin(), process.env.EDGE_SW === 'generate' ? new GenerateSW({ swDest: 'sw.js' }) : new InjectManifest({ swSrc: './src/sw.js', swDest: 'sw.js' })],
};
