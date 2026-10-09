'use strict';
// Oracle for an island bundled by a Vite app (fixtures nested-island-vite, nested-island-rollup, nested-island-workspace):
// the Vite oracle's packages of the outer app plus, for every file of the island's output it bundled, the packages of
// that file, from the Vite or Rollup oracle (the source map of each output file). Path-based, unlike the adapter, which
// matches each bundled file's sha256 against the island's lockfile.
// usage (cwd = fixture): node oracles/nested-vite.cjs vite|rollup  -> {"": [name@version, ...]}
const fs = require('fs');
const path = require('path');
const owner = require('./owner.cjs');
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

// The island built by Rolldown's API (island/rolldown.mjs) into island/dist-oracle with a source map, without
// bundle-lockfile: { "<output file>": [name@version, ...] } from the maps' sources (see owner.cjs)
function rolldownIsland() {
  const out = path.resolve('island/dist-oracle');
  fs.rmSync(out, { recursive: true, force: true });
  execFileSync(process.execPath, [path.resolve('island/rolldown.mjs')],
    { env: { ...process.env, NODE_OPTIONS: '', ISLAND_OUT: out, ISLAND_SOURCEMAP: '1' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const byFile = {};
  for (const name of fs.readdirSync(out).filter(n => n.endsWith('.map'))) {
    const map = JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));
    const sources = (map.sources || []).map(src => path.resolve(out, map.sourceRoot || '', src.split('?')[0]));
    byFile[name.slice(0, -'.map'.length)] = owner.packagesOf(sources); // see owner.cjs
  }
  return byFile;
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

module.exports = { islandPackages, rolldownIsland };
