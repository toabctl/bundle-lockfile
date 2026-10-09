// A small app: code splitting, CSS from a package, public/ copied verbatim (first-party, not a package).
// VITE_SINGLEFILE=1: vite-plugin-singlefile inlines every chunk into index.html and removes them from the bundle.
// VITE_SHARED=1: dist/ is not emptied, another build (vite.second.config.mjs) writes there too.
// VITE_OUT_DIR=<dir>: the output directory instead of dist/
// VITE_PLUGIN=<path of src/adapters/rollup.cjs>: bundle-lockfile's plugin in the config, as without NODE_OPTIONS
// VITE_WRITE_FALSE=1: build.write false - the build writes nothing (a tool takes the output from Vite's API)
// VITE_LIB=1: library mode with two formats (es, cjs): two outputs of one build in one directory
// VITE_SSR_NOEXTERNAL=1: with `vite build --ssr`, the dependencies are bundled too (ssr.noExternal)
// VITE_APP=1: two environments for `vite build --app` (Vite 6+): the client into dist/client, an SSR build of
// src/main.js into dist/server
import { createRequire } from 'node:module';
const plugins = [];
if (process.env.VITE_SINGLEFILE) plugins.push((await import('vite-plugin-singlefile')).viteSingleFile());
if (process.env.VITE_PLUGIN) plugins.push(createRequire(import.meta.url)(process.env.VITE_PLUGIN).bundleLockfile('vite'));
export default {
  build: {
    outDir: process.env.VITE_OUT_DIR || 'dist', emptyOutDir: !process.env.VITE_SHARED,
    ...(process.env.VITE_WRITE_FALSE && { write: false }),
    ...(process.env.VITE_LIB && { lib: { entry: 'src/main.js', formats: ['es', 'cjs'], fileName: (format) => `lib.${format}.js` } }),
  },
  ...(process.env.VITE_SSR_NOEXTERNAL && { ssr: { noExternal: true } }),
  ...(process.env.VITE_APP && {
    builder: {},
    environments: {
      client: { build: { outDir: 'dist/client' } },
      ssr: { build: { outDir: 'dist/server', rollupOptions: { input: 'src/main.js' }, rolldownOptions: { input: 'src/main.js' } } },
    },
  }),
  plugins,
};
