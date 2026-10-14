// Vite's part of dist/ (see webpack.config.js): a library build that leaves webpack's files there
// MIXED_OUT: the output directory instead of dist/ (relative to the project: ../elsewhere is outside it)
export default { build: { outDir: process.env.MIXED_OUT || 'dist', emptyOutDir: false, lib: { entry: 'src/page.js', formats: ['es'], fileName: () => 'page.js' } } };
