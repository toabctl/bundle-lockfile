// An app in a monorepo, built in its own directory; its dependencies are installed (hoisted) in the root's node_modules
// VITE_SHARED=1: dist/ is not emptied, another build (vite.second.config.mjs) writes there too.
export default { build: { outDir: 'dist', emptyOutDir: !process.env.VITE_SHARED } };
