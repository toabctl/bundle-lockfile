// Vendored copies (see src/index.js): the vendor alias as GitLab's, third_party as a module directory
const path = require('path');
module.exports = {
  mode: 'production', entry: './src/index.js',
  resolve: { alias: { vendor: path.join(__dirname, 'vendor/assets/javascripts') }, modules: ['node_modules', path.join(__dirname, 'third_party')] },
  output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  optimization: { minimize: false },
};
