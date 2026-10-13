// The canary app built with esbuild's JavaScript API (src/index.js: the JavaScript and the CSS)
// BLTEST_ESBUILD_ORACLE=<dir> (oracles/esbuild.cjs): with source maps, into <dir>
import * as esbuild from 'esbuild';

const oracle = process.env.BLTEST_ESBUILD_ORACLE;
await esbuild.build({ entryPoints: ['src/index.js'], bundle: true, outdir: oracle || 'dist', format: 'esm', ...(oracle && { sourcemap: true }) });
