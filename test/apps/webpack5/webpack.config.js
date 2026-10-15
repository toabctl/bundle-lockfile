const path = require('path');
// BLTEST_HEAP_FILE=<file>: the build's own heap limit (MB) written there (run.cjs checks the NODE_OPTIONS it ran with)
if (process.env.BLTEST_HEAP_FILE) require('fs').writeFileSync(process.env.BLTEST_HEAP_FILE, String(Math.round(require('v8').getHeapStatistics().heap_size_limit / 1048576)));
const plugins = [];
// EDGE_FAVICON=<file>: html-webpack-plugin's favicon (relative to the app), which it reads and emits as an asset
try { const H = require('html-webpack-plugin'); plugins.push(new H(process.env.EDGE_FAVICON ? { favicon: path.join(__dirname, process.env.EDGE_FAVICON) } : {})); } catch {} // child compiler, where installed
module.exports = {
  // EDGE_MODE=development: a development build (no unused-export analysis or scope hoisting; sideEffects flags still
  // drop the unused uuid)
  // EDGE_NAKED=1: also node_modules/naked (no package.json, made by the case), which the lockfile cannot list
  mode: process.env.EDGE_MODE || 'production', entry: process.env.EDGE_NAKED ? ['./src/index.js', 'naked'] : './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' }, plugins,
  // EDGE_CACHE=1: webpack's persistent cache, so a second build restores the modules instead of building them
  ...(process.env.EDGE_CACHE && { cache: { type: 'filesystem', cacheDirectory: path.join(__dirname, '.cache-test') } }),
  // EDGE_EXTERNALS=1: lodash-es comes from a global at runtime (e.g. a CDN script), not from the bundle
  ...(process.env.EDGE_EXTERNALS && { externals: { 'lodash-es': 'lodashEs' } }),
};
