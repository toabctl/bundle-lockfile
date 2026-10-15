// tsup bundles with esbuild (write: false) and writes the output itself. TSUP_TREESHAKE=1: tsup's treeshake option
// runs it through Rollup's generate() first and writes that. TSUP_METAFILE=1: dist/metafile-esm.json, for
// bundle-lockfile-from-metafile.
export default {
  entry: ['src/index.js'], format: ['esm'], platform: 'browser', noExternal: [/./], clean: true,
  treeshake: !!process.env.TSUP_TREESHAKE, metafile: !!process.env.TSUP_METAFILE,
};
