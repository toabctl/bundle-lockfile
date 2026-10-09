// A second build of the app into the same dist/ (another page): packages of the first one (debug and its nested ms)
// and one of its own (the root's ms), all in ../../node_modules
const input = 'second.html';
export default { build: { outDir: 'dist', emptyOutDir: false, rollupOptions: { input }, rolldownOptions: { input } } };
