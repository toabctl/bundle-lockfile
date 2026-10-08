// The outer build when it is Vite (fixtures nested-island-vite, nested-island-rollup, nested-island-workspace):
// index.html -> src/index.js, which imports the prebuilt island as a first-party file.
// NESTED_WORKSPACE=1: workspace.html -> src/workspace.js, which imports it as the workspace package @acme/island;
// EDGE_RESOLVE_SYMLINKS=false: through its node_modules link (resolve.preserveSymlinks)
const input = process.env.NESTED_WORKSPACE ? 'workspace.html' : 'index.html';
export default {
  build: { outDir: 'dist', rollupOptions: { input }, rolldownOptions: { input } },
  resolve: { preserveSymlinks: process.env.EDGE_RESOLVE_SYMLINKS === 'false' },
};
