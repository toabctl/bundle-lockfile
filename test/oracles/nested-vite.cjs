'use strict';
// Oracle for an island bundled by a Vite app (fixtures nested-island-vite, nested-island-rollup): the Vite oracle's
// packages of the outer app plus the island's, from the Vite or Rollup oracle (their source maps) - the island's
// output (island/dist/main.js) is imported by the app, so everything in it is in the app's output. Path-based, unlike
// the adapter, which matches the file's sha256 against the island's lockfile.
// usage (cwd = fixture): node oracles/nested-vite.cjs vite|rollup  -> {"": [name@version, ...]}
const path = require('path');
const { execFileSync } = require('child_process');

const run = (script, args = []) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8' }).trim().split('\n').pop());
const island = process.argv[2] === 'rollup'
  ? run('rollup.cjs', ['--config', 'island/rollup.config.mjs', '--out-file', 'island/dist-oracle/main.js'])['']
  : run('vite.cjs', ['--config', 'island/vite.config.mjs', '--out', 'island/dist-oracle'])[''];
const outer = run('vite.cjs');
for (const k of Object.keys(outer)) outer[k] = [...new Set([...outer[k], ...island])].sort();
console.log(JSON.stringify(outer));
