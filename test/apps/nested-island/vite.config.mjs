// The outer build when it is Vite (fixtures nested-island-vite, nested-island-rollup, nested-island-workspace):
// index.html -> src/index.js, which imports the prebuilt island as a first-party file.
// NESTED_ENTRY=<name>: src/<name>.js as the input instead (workspace: the island as the workspace package @acme/island;
// split, split-js, split-css: parts of the split island); EDGE_RESOLVE_SYMLINKS=false: through the workspace link
// (resolve.preserveSymlinks)
const input = process.env.NESTED_ENTRY ? `src/${process.env.NESTED_ENTRY}.js` : 'index.html';
export default {
  build: { outDir: 'dist', rollupOptions: { input }, rolldownOptions: { input } },
  resolve: { preserveSymlinks: process.env.EDGE_RESOLVE_SYMLINKS === 'false' },
};
