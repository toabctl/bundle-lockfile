'use strict';
// Oracle for Rollup command-line fixtures: builds again WITHOUT bundle-lockfile, with Rollup's own source maps
// (rollup -c --sourcemap --dir dist-oracle), and derives the packages from the maps' sources. Shares no code with the
// adapter, which reads the chunks' module lists.
// usage (cwd = fixture): node oracles/rollup.cjs [--config <file>] [--out <dir> | --out-file <file>]
// (--out-file for a config with output.file)
// prints {"": [name@version, ...]} (the output dir relative to itself); --by-file (for oracles/nested-vite.cjs):
// { packages: <that>, byFile: { "<output file relative to the output dir>": [name@version, ...] } }
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const outFile = arg('--out-file', null);
const out = path.resolve(outFile ? path.dirname(outFile) : arg('--out', 'dist-oracle'));
const configFile = arg('--config', null);
fs.rmSync(out, { recursive: true, force: true });
const rollup = path.resolve('node_modules/rollup/dist/bin/rollup');
const target = outFile ? ['--file', path.resolve(outFile)] : ['--dir', out];
const r = spawnSync(process.execPath, [rollup, '-c', ...(configFile ? [configFile] : []), '--sourcemap', ...target], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }

const files = new Set();
const filesOf = new Map(); // output file (relative to out) -> its sources
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.map')) {
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      const own = (m.sources || []).map(s => path.resolve(path.dirname(p), m.sourceRoot || '', s.split('?')[0]));
      own.forEach(f => files.add(f));
      filesOf.set(path.relative(out, p.slice(0, -'.map'.length)).split(path.sep).join('/'), own);
    }
  }
};
walk(out);

// package = directory directly below the last node_modules segment, at its real location, which must be in a
// node_modules directory (written out here, not imported from the tool)
function packagesOf(list) {
  const pkgs = new Set();
  for (const f of list) {
    const parts = f.split(path.sep);
    const i = parts.lastIndexOf('node_modules');
    if (i < 0) continue;
    let root = parts.slice(0, i + 1 + (parts[i + 1] && parts[i + 1].startsWith('@') ? 2 : 1)).join(path.sep);
    try { root = fs.realpathSync(root); } catch { /* keep */ }
    // a package that really is elsewhere (a workspace package linked into node_modules) is first-party
    const parent = path.basename(path.dirname(root));
    if (parent !== 'node_modules' && !(parent.startsWith('@') && path.basename(path.dirname(path.dirname(root))) === 'node_modules')) continue;
    let p;
    try { p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { continue; }
    if (p && p.name && p.version) pkgs.add(`${p.name}@${p.version}`);
  }
  return [...pkgs].sort();
}
const result = { '': packagesOf(files) };
console.log(JSON.stringify(process.argv.includes('--by-file')
  ? { packages: result, byFile: Object.fromEntries([...filesOf].map(([f, list]) => [f, packagesOf(list)])) } : result));
