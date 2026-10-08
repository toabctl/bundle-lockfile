// The outer build: webpack bundles the Vite-built island as a first-party file
const path = require('path');
module.exports = { mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' } };
