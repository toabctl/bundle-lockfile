// The Monaco editor with monaco-editor-webpack-plugin, which builds its language workers in child compilations (as
// redpanda-console does): the JSON worker, the editor worker, and a worker of a custom language (src/custom.worker.js,
// the only one with ms). The app also starts the editor worker and a worker of its own (src/url.worker.js, the only
// one with is-number) with new Worker(new URL(...)), which rspack builds in the same compilation.
const path = require('path');
const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin');
module.exports = {
  mode: 'production',
  entry: './src/index.js',
  output: { path: path.join(__dirname, 'dist'), filename: 'main.js', clean: true },
  module: { rules: [{ test: /\.css$/, type: 'css' }, { test: /\.ttf$/, type: 'asset/resource' }] },
  experiments: { css: true },
  plugins: [
    new MonacoWebpackPlugin({ languages: ['json'], features: ['!gotoSymbol'],
      customLanguages: [{ label: 'custom', entry: undefined, worker: { id: 'vs/custom/worker', entry: path.join(__dirname, 'src/custom.worker.js') } }] }),
  ],
};
