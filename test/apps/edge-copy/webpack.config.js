// copy-webpack-plugin copies a package's file into the output verbatim; it is in no chunk
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
module.exports = {
  mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  plugins: [new CopyPlugin({ patterns: [
    { from: require.resolve('normalize.css/normalize.css'), to: 'css/normalize.css' },
    { from: 'static', to: 'static' },  // first-party files: not packages
  ] })],
};
