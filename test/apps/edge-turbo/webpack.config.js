// The build run by turbo (turbo.json): its tasks get the NODE_OPTIONS of `turbo run` (in its default strict env mode too)
const path = require('path');
module.exports = { mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' } };
