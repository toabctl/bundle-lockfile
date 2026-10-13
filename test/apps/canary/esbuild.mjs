// The canary app built with esbuild's JavaScript API (src/index.js: the JavaScript and the CSS); the shader through an
// esbuild plugin (what include-plugin.mjs does for Rollup and Vite, in onLoad: the included file in watchFiles), the image
// a style sheet uses inlined as a data: URL
// BLTEST_ESBUILD_ORACLE=<dir> (oracles/esbuild.cjs): with source maps, into <dir>
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const include = {
  name: 'canary-include',
  setup(build) {
    build.onLoad({ filter: /\.glsl$/ }, (args) => {
      const require = createRequire(args.path);
      const watchFiles = [];
      const code = fs.readFileSync(args.path, 'utf8').replace(/^#include "(.+)"$/gm, (_, request) => {
        const file = require.resolve(request);
        watchFiles.push(file);
        return fs.readFileSync(file, 'utf8');
      });
      return { contents: `export default ${JSON.stringify(code)};`, loader: 'js', watchFiles };
    });
  },
};
const oracle = process.env.BLTEST_ESBUILD_ORACLE;
await esbuild.build({ entryPoints: ['src/index.js'], bundle: true, outdir: oracle || 'dist', format: 'esm', loader: { '.svg': 'dataurl' }, plugins: [include],
  ...(oracle && { sourcemap: true }) });
