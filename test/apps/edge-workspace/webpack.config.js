const path = require('path');
module.exports = {
  mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  // EDGE_RESOLVE_SYMLINKS=false: modules keep the node_modules/@acme/ui symlink path instead of packages/ui
  resolve: { symlinks: process.env.EDGE_RESOLVE_SYMLINKS !== 'false' },
};
