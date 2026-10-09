// The outer build: webpack bundles the Vite-built island as a first-party file.
// NESTED_ENTRY=<name>: src/<name>.js instead of src/index.js (workspace: the island as the workspace package
// @acme/island; split-js: the split island's JavaScript; vendored: the island's output copied to copied/island/dist); EDGE_RESOLVE_SYMLINKS=false: through the workspace link
const path = require('path');
module.exports = {
  mode: 'production', entry: `./src/${process.env.NESTED_ENTRY || 'index'}.js`,
  resolve: { symlinks: process.env.EDGE_RESOLVE_SYMLINKS !== 'false' },
  output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
};
