// webpack and Vite (vite.config.mjs) write to the same dist/, in separate processes: one lockfile with both
const path = require('path');
module.exports = { mode: 'production', entry: './src/app.js', output: { path: path.join(__dirname, 'dist'), filename: 'app.js' } };
