// Two compilers in one array: a vendor DLL and the main build that references it.
const path = require('path');
const webpack = require('webpack');
const out = (d) => path.join(__dirname, 'dist', d);
const manifest = path.join(__dirname, 'build', 'vendor-manifest.json'); // outside dist, shared by every build of this fixture
module.exports = [
  { name: 'vendor', mode: 'production', entry: { vendor: ['debug', 'ms'] },
    output: { path: out('vendor'), filename: 'vendor.dll.js', library: 'vendor_lib' },
    plugins: [new webpack.DllPlugin({ name: 'vendor_lib', path: manifest })] },
  { name: 'main', dependencies: ['vendor'], mode: 'production', entry: './src/index.js',
    output: { path: out('main'), filename: 'main.js' },
    plugins: [new webpack.DllReferencePlugin({ manifest })] },
];
