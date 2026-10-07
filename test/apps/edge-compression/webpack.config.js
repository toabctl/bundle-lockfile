// compression-webpack-plugin with deleteOriginalAssets ships only the .gz files. It also gets the assets added
// after it ran (webpack 5: processAssets' additionalAssets; webpack 4: it runs in the emit hook), so it must
// not replace the lockfile by a .gz no SBOM tool reads.
const path = require('path');
const CompressionPlugin = require('compression-webpack-plugin');
module.exports = {
  mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist'), filename: 'main.js' },
  plugins: [new CompressionPlugin({ deleteOriginalAssets: true })],
};
