// rspack 2 with its own CSS support: the CSS of bl-canary-css in main.css; shaders through include-loader.cjs
const path = require('path');
module.exports = { mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  module: { rules: [{ test: /\.css$/, type: 'css' }, { test: /\.glsl$/, use: path.join(__dirname, 'include-loader.cjs') }] } };
