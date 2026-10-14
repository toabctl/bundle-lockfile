// The canary app's JavaScript built by tsdown (npx tsdown): Rolldown, with tsdown's own plugins and Rolldown's
// importGlobPlugin (builtin:vite-import-glob, tsdown's globImport default) - no Vite build
import include from './include-plugin.mjs';

export default {
  entry: ['src/main.js'],
  format: 'esm',
  platform: 'browser',
  outDir: 'dist',
  dts: false,
  report: false,
  plugins: [include()],
  deps: { onlyBundle: false }, // the canaries are in no dependencies list: bundled, without a warning per package
};
