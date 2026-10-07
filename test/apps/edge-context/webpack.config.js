// context below the project root: node_modules is outside it, so lockfile keys are ../node_modules/...
const path = require('path');
module.exports = {
  mode: 'production', context: path.join(__dirname, 'src'), entry: './index.js',
  output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
};
