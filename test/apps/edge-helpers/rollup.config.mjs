// Rollup with @rollup/plugin-babel, babelHelpers 'bundled': Babel's helpers become one module of the bundle
// (\0rollupPluginBabelHelpers.js), the code of @babel/helpers (core/helpers.cjs)
import { babel } from '@rollup/plugin-babel';
export default {
  input: 'src/index.js', output: { dir: 'dist', format: 'iife' },
  plugins: [babel({ babelHelpers: 'bundled', babelrc: false, configFile: false, presets: [['@babel/preset-env', { targets: 'ie 11' }]] })],
};
