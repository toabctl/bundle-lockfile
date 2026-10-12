// The outer build with rspack (fixture nested-island-rspack): the Vite-built island bundled as a first-party file, as
// webpack.config.js does
const path = require('path');
module.exports = { mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' } };
