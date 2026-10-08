// compression-webpack-plugin with deleteOriginalAssets ships only the .gz files. It also gets the assets added
// after it ran (webpack 5: processAssets' additionalAssets; webpack 4: it runs in the emit hook), so it must
// not replace the lockfile by a .gz no SBOM tool reads.
// EDGE_COMPRESSION=two: two compilers (app, sw) writing to dist/, whose files are all replaced by .gz ones - on
// webpack 4 in the emit hook, after the lockfile was rendered. Another process writing dist/ later must still find
// them there.
const path = require('path');
const CompressionPlugin = require('compression-webpack-plugin');
const config = (name, entry, filename, extra = {}) => ({
  name, mode: 'production', entry, output: { path: path.join(__dirname, 'dist'), filename },
  plugins: [new CompressionPlugin({ deleteOriginalAssets: true })], ...extra,
});
module.exports = process.env.EDGE_COMPRESSION === 'two'
  ? [config('app', './src/index.js', 'main.js'), config('sw', './src/sw.js', 'sw.js', { target: 'webworker' })]
  : config(undefined, './src/index.js', 'main.js');
