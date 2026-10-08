// The outer build: webpack bundles the Vite-built island as a first-party file.
// NESTED_WORKSPACE=1: it imports the island as the workspace package @acme/island (fixture nested-island-workspace);
// EDGE_RESOLVE_SYMLINKS=false: through its node_modules link
const path = require('path');
module.exports = {
  mode: 'production', entry: process.env.NESTED_WORKSPACE ? './src/workspace.js' : './src/index.js',
  resolve: { symlinks: process.env.EDGE_RESOLVE_SYMLINKS !== 'false' },
  output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
};
