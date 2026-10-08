'use strict';
// Oracle for an island bundled by a Vite app (fixtures nested-island-vite, nested-island-rollup, nested-island-workspace):
// the Vite oracle's packages of the outer app plus, for every file of the island's output it bundled, the packages of
// that file, from the Vite or Rollup oracle (the source map of each output file). Path-based, unlike the adapter, which
// matches each bundled file's sha256 against the island's lockfile.
// usage (cwd = fixture): node oracles/nested-vite.cjs vite|rollup  -> {"": [name@version, ...]}
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// The packages of the island's output files among sources (absolute paths, also through a node_modules link), by
// byFile: { "<file relative to the island's output dir>": [name@version, ...] }. The island oracle builds the same
// files (the same names) into island/dist-oracle.
function islandPackages(sources, byFile) {
  const dist = fs.realpathSync(path.resolve('island/dist'));
  const out = new Set();
  for (const s of sources) {
    let f = s;
    try { f = fs.realpathSync(s); } catch { /* keep */ }
    const rel = path.relative(dist, f);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    for (const p of byFile[rel.split(path.sep).join('/')] || []) out.add(p);
  }
  return [...out];
}

if (require.main === module) {
  const run = (script, args = []) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8' }).trim().split('\n').pop());
  const byFile = process.argv[2] === 'rollup'
    ? run('rollup.cjs', ['--config', 'island/rollup.config.mjs', '--out-file', 'island/dist-oracle/main.js', '--by-file']).byFile
    : run('vite.cjs', ['--config', 'island/vite.config.mjs', '--out', 'island/dist-oracle', '--by-file']).byFile;
  const outer = run('vite.cjs', ['--sources']);
  const island = islandPackages(outer.sources, byFile);
  for (const k of Object.keys(outer.packages)) outer.packages[k] = [...new Set([...outer.packages[k], ...island])].sort();
  console.log(JSON.stringify(outer.packages));
}

module.exports = { islandPackages };
