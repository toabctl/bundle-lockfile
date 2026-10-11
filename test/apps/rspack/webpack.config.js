// webpack builds sw (src/sw.js) into the dist/ rspack writes app to (RSPACK_SHARED=1, --config-name app), in another
// process: one lockfile with both
const path = require('path');
module.exports = { mode: 'production', target: 'webworker', entry: './src/sw.js', output: { path: path.join(__dirname, 'dist'), filename: 'sw.js' } };
