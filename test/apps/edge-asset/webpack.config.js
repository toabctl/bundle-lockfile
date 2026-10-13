// A package's file as an asset module. EDGE_ASSET=inline: asset/inline (a data: URL inside main.js) instead of
// asset/resource (a file next to it); EDGE_ASSET=data-js: also a JavaScript module from a data: URL (src/data.js)
const path = require('path');
module.exports = {
  mode: 'production', entry: process.env.EDGE_ASSET === 'data-js' ? './src/data.js' : './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  module: { rules: [{ test: /\.svg$/, type: process.env.EDGE_ASSET === 'inline' ? 'asset/inline' : 'asset/resource' }] },
};
