// Style sheets from packages that a style sheet @imports: sass-loader, less-loader and PostCSS (Tailwind) inline
// them into its CSS, mini-css-extract-plugin extracts that - they are file dependencies of the style module, no modules
const path = require('path');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const webpack4 = require('webpack/package.json').version.startsWith('4.');
const css = [MiniCssExtractPlugin.loader, 'css-loader'];
module.exports = {
  mode: 'production', entry: webpack4 ? './src/index4.js' : './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  module: { rules: [
    { test: /\.scss$/, use: [...css, 'sass-loader'] },
    { test: /\.less$/, use: [...css, 'less-loader'] },
    { test: /\.css$/, use: [...css, { loader: 'postcss-loader', options: { postcssOptions: { plugins: ['@tailwindcss/postcss'] } } }] },
  ] },
  plugins: [new MiniCssExtractPlugin()],
  // EDGE_CACHE=1: webpack's persistent cache, so a second build restores the modules instead of building them
  ...(process.env.EDGE_CACHE && { cache: { type: 'filesystem', cacheDirectory: path.join(__dirname, '.cache-test') } }),
};
