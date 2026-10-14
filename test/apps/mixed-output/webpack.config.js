// webpack and Vite (vite.config.mjs) write to the same dist/, in separate processes: one lockfile with both
const path = require('path');
// MIXED_OUT: the output directory instead of dist/ (see vite.config.mjs)
module.exports = { mode: 'production', entry: './src/app.js', output: { path: path.resolve(__dirname, process.env.MIXED_OUT || 'dist'), filename: 'app.js' } };
