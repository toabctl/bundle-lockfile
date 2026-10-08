// The same app built by webpack (the build-webpack script) and by Vite (vite.config.mjs, the build script)
const path = require('path');
module.exports = { mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' } };
