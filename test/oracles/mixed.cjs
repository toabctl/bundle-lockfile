'use strict';
// Oracle for a webpack build and a Vite build writing the same output directory (fixture mixed-output): the webpack
// oracle's packages and the Vite oracle's, which build into dist-oracle one after the other (each output dir relative
// to it: "").
// usage (cwd = fixture): node oracles/mixed.cjs  -> {"": [name@version, ...]}
const path = require('path');
const { execFileSync } = require('child_process');

const run = (script) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, script)], { encoding: 'utf8' }).trim().split('\n').pop());
const out = {};
for (const result of [run('webpack.cjs'), run('vite.cjs')]) {
  for (const [k, pkgs] of Object.entries(result)) out[k] = [...new Set([...(out[k] || []), ...pkgs])].sort();
}
console.log(JSON.stringify(out));
