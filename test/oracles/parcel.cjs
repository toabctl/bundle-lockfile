'use strict';
// Oracle for Parcel fixtures: builds again WITHOUT bundle-lockfile, with Parcel's own source maps (its default), into
// dist-oracle, and derives the packages from the maps' sources (Parcel writes them relative to the project root; one
// that is no file there, relative to the map's directory; "<anon>" and the bundle itself are none). Shares no code with the adapter, which reads the bundle
// graph. Source maps leave out what has no mappings (a font, an asset): a case names those.
// usage (cwd = fixture): node oracles/parcel.cjs [<entry>]   (default: src/index.html)
// prints {"": [name@version, ...]}
const fs = require('fs');
const path = require('path');
const owner = require('./owner.cjs');
const { spawnSync } = require('child_process');

const entry = process.argv[2] || 'src/index.html';
const out = path.resolve('dist-oracle');
fs.rmSync(out, { recursive: true, force: true });
// resolved from the fixture (also with Yarn Plug'n'Play: run with `yarn node`, see run.cjs)
const parcel = require('module').createRequire(path.resolve('package.json')).resolve('parcel/lib/bin.js');
const r = spawnSync(process.execPath, [parcel, 'build', entry, '--dist-dir', out, '--no-cache'], { encoding: 'utf8', env: process.env });
if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }

const files = new Set();
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.map')) {
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const s of m.sources || []) {
        const rel = s.split('?')[0].replace(/^\/__parcel_source_root\//, '');
        const own = path.resolve(rel), local = path.resolve(path.dirname(p), m.sourceRoot || '', rel);
        // (a file Parcel generates in a package is none on disk: its runtime, @parcel/runtime-js/lib/runtime-<hash>.js)
        const inPackage = (f) => {
          const at = f.lastIndexOf(`${path.sep}node_modules${path.sep}`) + `${path.sep}node_modules${path.sep}`.length;
          if (at < 14) return false;
          const parts = f.slice(at).split(path.sep);
          return fs.existsSync(path.join(f.slice(0, at), ...parts.slice(0, parts[0].startsWith('@') ? 2 : 1), 'package.json'));
        };
        if (fs.existsSync(own) || inPackage(own)) files.add(own); else if (fs.existsSync(local)) files.add(local);
      }
    }
  }
};
walk(out);
// and @parcel/packager-js, whose prelude and module wrappers are in the JavaScript bundles (test/lib/bundlers.cjs)
// (as Parcel resolves its plugins: from its default config, which names it)
const bl = require('../lib/bundlers.cjs');
const configDir = (() => { try { return path.dirname(require('module').createRequire(path.resolve('package.json')).resolve('@parcel/config-default/package.json')); } catch { return '.'; } })();
const packager = bl.hasJs(out) ? [bl.resolved('@parcel/packager-js', configDir) || bl.resolved('@parcel/packager-js', '.')].filter(Boolean) : [];
console.log(JSON.stringify({ '': [...new Set([...owner.packagesOf(files), ...packager])].sort() }));
