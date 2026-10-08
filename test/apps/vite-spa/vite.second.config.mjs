// A second build of the app into the same dist/ (another page, is-number), e.g. run in parallel by run-p
const input = 'second.html';
export default { build: { outDir: 'dist', emptyOutDir: false, rollupOptions: { input }, rolldownOptions: { input } } };
