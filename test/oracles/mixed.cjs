'use strict';
// Oracle for builds of two bundlers writing the same output directory (fixture mixed-output: webpack and Vite): the
// packages of each one's oracle, which build into dist-oracle one after the other (each output dir relative to it: "").
// usage (cwd = fixture): node oracles/mixed.cjs [<oracle script> ...] (default: webpack.cjs vite.cjs)
//   -> {"": [name@version, ...]}
const path = require('path');
const { execFileSync } = require('child_process');

const run = (script) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, script)], { encoding: 'utf8' }).trim().split('\n').pop());
const out = {};
const scripts = process.argv.slice(2);
for (const result of (scripts.length ? scripts : ['webpack.cjs', 'vite.cjs']).map(run)) {
  for (const [k, pkgs] of Object.entries(result)) out[k] = [...new Set([...(out[k] || []), ...pkgs])].sort();
}
console.log(JSON.stringify(out));
