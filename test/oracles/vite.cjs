'use strict';
// Oracle for Vite fixtures: builds again WITHOUT bundle-lockfile, with Vite's own source maps
// (vite build --sourcemap --outDir dist-oracle), and derives the packages from the maps' sources. Shares no code with
// the adapter, which reads the chunks' module lists. Vite writes no source maps for CSS in builds, so packages that
// only contribute CSS are not seen here (cases list them in oracleMissing).
// usage (cwd = fixture): node oracles/vite.cjs [vite build options, e.g. --config island/vite.config.mjs] [--out <dir>]
// prints {"": [name@version, ...]} (the output dir relative to itself)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = path.resolve(outIdx >= 0 ? args.splice(outIdx, 2)[1] : 'dist-oracle');
const vite = path.resolve('node_modules/vite/bin/vite.js');
const r = spawnSync(process.execPath, [vite, 'build', ...args, '--sourcemap', '--outDir', out, '--emptyOutDir'], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
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
