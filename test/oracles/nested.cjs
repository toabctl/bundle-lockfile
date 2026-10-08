'use strict';
// Oracle for a Vite-built island bundled by webpack (fixtures nested-island-wp4, -wp5, -workspace): the webpack oracle's
// packages plus, for every file of the island's output it bundled, the packages of that file, from the Vite oracle
// (the source map of each output file). Path-based, unlike the adapter, which matches each bundled file's sha256
// against the island's lockfile.
// usage (cwd = fixture): node oracles/nested.cjs  -> {"<output dir rel to dist>": [name@version, ...]}
const path = require('path');
const { execFileSync } = require('child_process');
const { islandPackages } = require('./nested-vite.cjs');

const run = (script, args = []) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8' }).trim().split('\n').pop());
const byFile = run('vite.cjs', ['--config', 'island/vite.config.mjs', '--out', 'island/dist-oracle', '--by-file']).byFile;
const outer = run('webpack.cjs', ['--sources']);
const island = islandPackages(outer.sources, byFile);
for (const k of Object.keys(outer.packages)) outer.packages[k] = [...new Set([...outer.packages[k], ...island])].sort();
console.log(JSON.stringify(outer.packages));
