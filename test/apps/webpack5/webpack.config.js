const path = require('path');
const plugins = [];
try { const H = require('html-webpack-plugin'); plugins.push(new H()); } catch {} // child compiler, where installed
module.exports = {
  mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' }, plugins,
  // EDGE_CACHE=1: webpack's persistent cache, so a second build restores the modules instead of building them
  ...(process.env.EDGE_CACHE && { cache: { type: 'filesystem', cacheDirectory: path.join(__dirname, '.cache-test') } }),
};
