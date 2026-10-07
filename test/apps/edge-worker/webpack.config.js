// worker-loader builds each worker in a child compiler; the worker files are shipped next to main.js
const path = require('path');
module.exports = { mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' } };
