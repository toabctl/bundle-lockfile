// rspack: its API is webpack's, but bundle-lockfile does not support it (yet) - its Compiler is no webpack Compiler
const path = require('path');
module.exports = { mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' } };
