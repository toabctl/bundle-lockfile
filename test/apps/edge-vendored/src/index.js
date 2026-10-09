// every kind of vendored copy and first-party library (see the matrix cases for what is listed)
const leftPad = require('vendor/left-pad');          // alias: vendor/assets/javascripts (as GitLab's)
const yaml = require('vendor/vscode-yaml');          // a VS Code extension manifest: no npm package
const client = require('vendor/languageclient');     // engines.vscode without publisher: an npm package
const bad = require('vendor/bad-name');              // a name npm does not accept
const vendoredMs = require('vendor/ms');             // a copy of the ms@2.1.3 that is also installed
const ms = require('ms');
const isOdd = require('is-odd');                     // resolve.modules: third_party
const priv = require('./private-lib');
const appLib = require('../lib/app-lib');            // an in-repo library nothing marks first-party: listed
const ws = require('../ws/w');                       // an npm workspace
const pnpmLib = require('../pnpm-packages/p');
const lernaLib = require('../lerna-packages/l');
const rushLib = require('../rush/lib');
const nxLib = require('../libs/nx-lib');
const container = require('container');              // copies inside an installed package
console.log([leftPad, yaml, client, bad, vendoredMs, ms, isOdd, priv, appLib, ws, pnpmLib, lernaLib, rushLib, nxLib, container].map(String).join());
