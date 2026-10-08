const path = require('path');
const plugins = [];
try { const H = require('html-webpack-plugin'); plugins.push(new H()); } catch {} // child compiler, where installed
module.exports = {
  // EDGE_MODE=development: a development build (no unused-export analysis or scope hoisting; sideEffects flags still
  // drop the unused uuid)
  mode: process.env.EDGE_MODE || 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' }, plugins,
  // EDGE_CACHE=1: webpack's persistent cache, so a second build restores the modules instead of building them
  ...(process.env.EDGE_CACHE && { cache: { type: 'filesystem', cacheDirectory: path.join(__dirname, '.cache-test') } }),
  // EDGE_EXTERNALS=1: lodash-es comes from a global at runtime (e.g. a CDN script), not from the bundle
  ...(process.env.EDGE_EXTERNALS && { externals: { 'lodash-es': 'lodashEs' } }),
};
