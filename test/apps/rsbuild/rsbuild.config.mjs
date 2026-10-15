// The webpack5 app (src/index.js, Rsbuild's default entry) built by Rsbuild into dist/, with a package's file copied
// into the output (output.copy)
// RSBUILD_ENVS=1: two environments, web into dist/ and node into dist/server/ (an output directory inside another)
// RSBUILD_CONSTS=1: the entry src/consts.js, which also uses a constant of consts-only (pkgs/, copied into node_modules
// by the case): Rsbuild 1.5 and 1.6 have rspack inline it in production (experiments.inlineConst)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export default {
  output: { copy: [{ from: require.resolve('normalize.css/normalize.css'), to: 'css/normalize.css' }] },
  ...(process.env.RSBUILD_ENVS && { environments: { web: {}, node: { output: { target: 'node', distPath: { root: 'dist/server' } } } } }),
  ...(process.env.RSBUILD_CONSTS && { source: { entry: { index: './src/consts.js' } } }),
};
