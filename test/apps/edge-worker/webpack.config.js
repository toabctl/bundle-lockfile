// worker-loader builds each worker in a child compiler; the worker files are shipped next to main.js
const path = require('path');
module.exports = {
  mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  // EDGE_CACHE=1: webpack's persistent cache, so a second build restores the modules instead of building them
  ...(process.env.EDGE_CACHE && { cache: { type: 'filesystem', cacheDirectory: path.join(__dirname, '.cache-test') } }),
};
