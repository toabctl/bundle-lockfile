const path = require('path');
module.exports = {
  mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  target: ['web', 'es5'],
  module: { rules: [{ test: /\.js$/, exclude: /node_modules/, use: { loader: 'babel-loader', options: {
    presets: [['@babel/preset-env', { targets: 'ie 11', useBuiltIns: 'usage', corejs: '3.50' }]],
    plugins: [['@babel/plugin-transform-runtime', { corejs: false }]],
  } } }] },
};
