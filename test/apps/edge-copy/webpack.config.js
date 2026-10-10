// copy-webpack-plugin copies a package's file and a package's directory into the output verbatim; they are in no chunk
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const patterns = [
  { from: require.resolve('normalize.css/normalize.css'), to: 'css/normalize.css' },
  { from: path.dirname(require.resolve('left-pad/package.json')), to: 'vendor/left-pad' },
  { from: 'static', to: 'static' },  // first-party files: not packages
];
// copy-webpack-plugin 5 (webpack 4) takes the patterns as an array; it copies in the emit hook, and its assets
// do not name the file they were copied from. 6.0 - 6.2 copy while webpack processes the assets, also without naming
// it; 6.2 adds a copied directory only as a context dependency
const v5 = require('copy-webpack-plugin/package.json').version.startsWith('5.');
module.exports = {
  mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  plugins: [v5 ? new CopyPlugin(patterns) : new CopyPlugin({ patterns })],
};
