const path = require('path');
const plugins = [];
try { const H = require('html-webpack-plugin'); plugins.push(new H()); } catch {} // child compiler, where installed
module.exports = { mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' }, plugins };
