'use strict';
// Oracle for Rollup command-line fixtures: builds again WITHOUT bundle-lockfile, with Rollup's own source maps
// (rollup -c --sourcemap --dir dist-oracle), and derives the packages from the maps' sources. Shares no code with the
// adapter, which reads the chunks' module lists.
// usage (cwd = fixture): node oracles/rollup.cjs [--config <file>] [--out <dir> | --out-file <file>]
// (--out-file for a config with output.file)
// prints {"": [name@version, ...]} (the output dir relative to itself)
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
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.map')) {
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const s of m.sources || []) files.add(path.resolve(path.dirname(p), m.sourceRoot || '', s.split('?')[0]));
    }
  }
};
walk(out);

// package = directory directly below the last node_modules segment, at its real location (written out here, not
// imported from the tool)
const pkgs = new Set();
for (const f of files) {
  const parts = f.split(path.sep);
  const i = parts.lastIndexOf('node_modules');
  if (i < 0) continue;
  let root = parts.slice(0, i + 1 + (parts[i + 1] && parts[i + 1].startsWith('@') ? 2 : 1)).join(path.sep);
  try { root = fs.realpathSync(root); } catch { /* keep */ }
  let p;
  try { p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { continue; }
  if (p && p.name && p.version) pkgs.add(`${p.name}@${p.version}`);
}
console.log(JSON.stringify({ '': [...pkgs].sort() }));
