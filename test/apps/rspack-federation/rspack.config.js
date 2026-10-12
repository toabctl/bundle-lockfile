// Module federation on rspack (edge-federation's app): a remote exposing ./widget and a host using it at runtime, both
// sharing lodash-es (a singleton). Each ships its fallback copy of the shared package and, unlike webpack 5's, the
// federation runtime (@module-federation/*); the host does not ship the remote's code.
// RSPACK_MF=enhanced: @module-federation/enhanced/rspack's plugin instead of rspack's own
// RSPACK_MF_TS=1: lodash-es shared with tree shaking (rspack 2): rspack builds it again in a compiler of its own, into
// <output>/independent-packages/lodash_es/
const path = require('path');
const rspack = require('@rspack/core');
const { ModuleFederationPlugin } = process.env.RSPACK_MF === 'enhanced' ? require('@module-federation/enhanced/rspack') : rspack.container;
const shared = { 'lodash-es': { singleton: true, ...(process.env.RSPACK_MF_TS && { treeShaking: { mode: 'server-calc' } }) } };
module.exports = [
  { name: 'remote', mode: 'production', entry: {}, output: { path: path.join(__dirname, 'dist/remote'), publicPath: 'auto', uniqueName: 'remote' },
    plugins: [new ModuleFederationPlugin({ name: 'remote', filename: 'remoteEntry.js', exposes: { './widget': './src/widget.js' }, shared })] },
  { name: 'host', mode: 'production', entry: './src/index.js', output: { path: path.join(__dirname, 'dist/host'), publicPath: 'auto', uniqueName: 'host' },
    plugins: [new ModuleFederationPlugin({ name: 'host', remotes: { remote: 'remote@/remote/remoteEntry.js' }, shared })] },
];
