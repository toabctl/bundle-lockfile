// A Vue 3 app with a single-file component whose <style lang="scss"> block @imports Bootstrap's Sass: vue-loader makes
// it the module App.vue?vue&type=style&index=0&lang=scss, whose file is App.vue (no style sheet); sass-loader inlines
// Bootstrap's partials into it, mini-css-extract-plugin puts the CSS into main.css
const path = require('path');
const { VueLoaderPlugin } = require('vue-loader');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
module.exports = {
  mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  module: { rules: [{ test: /\.vue$/, loader: 'vue-loader' }, { test: /\.scss$/, use: [MiniCssExtractPlugin.loader, 'css-loader', 'sass-loader'] }] },
  plugins: [new VueLoaderPlugin(), new MiniCssExtractPlugin()],
};
