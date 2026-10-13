// Modules that exist only in webpack's input file system (webpack-virtual-modules): one in the project, one in a
// package directory that is not on disk (no package: generated code), one inside an installed package (ms's: listed as
// ms); and an unplugin plugin's virtual module
const path = require('path');
const VirtualModulesPlugin = require('webpack-virtual-modules');
const unplugin = require('./unplugin-virtual.cjs');
module.exports = {
  mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  plugins: [
    new VirtualModulesPlugin({
      'src/virtual.js': 'export default "first-party, in memory";',
      'node_modules/virtual-pkg/index.js': 'export default "no package, in memory";',
      'node_modules/ms/virtual-inside.js': 'export default "inside ms, in memory";',
    }),
    unplugin.webpack(),
  ],
};
