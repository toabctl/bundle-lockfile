// Module federation (webpack 5's ModuleFederationPlugin): a remote exposing ./widget and a host using it at runtime,
// both sharing lodash-es. Each ships its fallback copy of the shared package; the host does not ship the remote's code.
const path = require('path');
const { ModuleFederationPlugin } = require('webpack').container;
const shared = { 'lodash-es': { singleton: true } };
module.exports = [
  { name: 'remote', mode: 'production', entry: {}, output: { path: path.join(__dirname, 'dist/remote'), publicPath: 'auto' },
    plugins: [new ModuleFederationPlugin({ name: 'remote', filename: 'remoteEntry.js', exposes: { './widget': './src/widget.js' }, shared })] },
  { name: 'host', mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist/host'), publicPath: 'auto' },
    plugins: [new ModuleFederationPlugin({ name: 'host', remotes: { remote: 'remote@/remote/remoteEntry.js' }, shared })] },
];
