// webpack 5 with its own CSS support (experiments.css): the CSS of bl-canary-css in main.css; shaders through
// include-loader.cjs
const path = require('path');
module.exports = { mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' }, experiments: { css: true },
  module: { rules: [{ test: /\.glsl$/, use: path.join(__dirname, 'include-loader.cjs') }] } };
