// A small app: code splitting, CSS from a package, public/ copied verbatim (first-party, not a package).
// VITE_SINGLEFILE=1: vite-plugin-singlefile inlines every chunk into index.html and removes them from the bundle.
// VITE_SHARED=1: dist/ is not emptied, another build (vite.second.config.mjs) writes there too.
// VITE_PLUGIN=<path of src/adapters/rollup.cjs>: bundle-lockfile's plugin in the config, as without NODE_OPTIONS
import { createRequire } from 'node:module';
const plugins = [];
if (process.env.VITE_SINGLEFILE) plugins.push((await import('vite-plugin-singlefile')).viteSingleFile());
if (process.env.VITE_PLUGIN) plugins.push(createRequire(import.meta.url)(process.env.VITE_PLUGIN).bundleLockfile('vite'));
export default { build: { outDir: 'dist', emptyOutDir: !process.env.VITE_SHARED }, plugins };
