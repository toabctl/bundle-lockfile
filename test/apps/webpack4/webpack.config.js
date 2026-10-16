const path = require('path');
const plugins = [];
// EDGE_FAVICON=<file>: html-webpack-plugin's favicon (relative to the app), which it reads and emits as an asset
try { const H = require('html-webpack-plugin'); plugins.push(new H(process.env.EDGE_FAVICON ? { favicon: path.join(__dirname, process.env.EDGE_FAVICON) } : {})); } catch {} // child compiler, where installed
// EDGE_FUTURE_EMIT=1: output.futureEmitAssets, as react-scripts 4 sets it (webpack keeps only the sizes of emitted assets)
const future = process.env.EDGE_FUTURE_EMIT ? { futureEmitAssets: true } : {};
module.exports = { mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js', ...future }, plugins };
