// Vite's part of dist/ (see webpack.config.js): a library build that leaves webpack's files there
export default { build: { outDir: 'dist', emptyOutDir: false, lib: { entry: 'src/page.js', formats: ['es'], fileName: () => 'page.js' } } };
