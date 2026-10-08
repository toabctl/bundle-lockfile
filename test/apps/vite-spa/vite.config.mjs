// A small app: code splitting, CSS from a package, public/ copied verbatim (first-party, not a package).
// VITE_SINGLEFILE=1: vite-plugin-singlefile inlines every chunk into index.html and removes them from the bundle.
// VITE_SHARED=1: dist/ is not emptied, another build (vite.second.config.mjs) writes there too.
const singlefile = process.env.VITE_SINGLEFILE ? [(await import('vite-plugin-singlefile')).viteSingleFile()] : [];
export default { build: { outDir: 'dist', emptyOutDir: !process.env.VITE_SHARED }, plugins: singlefile };
