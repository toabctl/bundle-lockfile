const path = require('path');
const plugins = [];
// EDGE_FAVICON=<file>: html-webpack-plugin's favicon (relative to the app), which it reads and emits as an asset
try { const H = require('html-webpack-plugin'); plugins.push(new H(process.env.EDGE_FAVICON ? { favicon: path.join(__dirname, process.env.EDGE_FAVICON) } : {})); } catch {} // child compiler, where installed
module.exports = { mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' }, plugins };
