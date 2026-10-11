// OHIF's shape: the config takes CopyRspackPlugin from the project's rspack 1, while @rspack/cli 2 builds it with its
// own rspack 2 (node_modules/@rspack/cli/node_modules/@rspack/core): two copies of rspack in one process
const path = require('path');
const { CopyRspackPlugin } = require('@rspack/core');
module.exports = {
  mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  plugins: [new CopyRspackPlugin({ patterns: [{ from: require.resolve('normalize.css/normalize.css'), to: 'css/normalize.css' }] })],
};
