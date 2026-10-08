'use strict';
// Oracle for a Vite-built island bundled by webpack (fixture nested-island): the webpack oracle's packages plus the
// island's, from the Vite oracle (its source maps) - the island's output (island/dist/main.js) is imported by the
// webpack app, so everything in it is in webpack's output. Path-based, unlike the adapter, which matches the file's
// sha256 against the island's lockfile.
// usage (cwd = fixture): node oracles/nested.cjs  -> {"<output dir rel to dist>": [name@version, ...]}
const path = require('path');
const { execFileSync } = require('child_process');

const run = (script, args = []) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8' }).trim().split('\n').pop());
const island = run('vite.cjs', ['--config', 'island/vite.config.mjs', '--out', 'island/dist-oracle'])[''];
const outer = run('webpack.cjs');
for (const k of Object.keys(outer)) outer[k] = [...new Set([...outer[k], ...island])].sort();
console.log(JSON.stringify(outer));
