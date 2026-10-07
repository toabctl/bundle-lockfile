'use strict';
// Maps bundled source files to the npm packages they belong to.
const fs = require('fs');
const path = require('path');

// Nearest package.json with name+version, walking up from dir.
// Skips nested manifests like dist/esm/package.json = {"type":"module"}.
function findPackage(dir, cache) {
  const seen = [];
  for (let d = dir; d && d !== path.dirname(d); d = path.dirname(d)) {
    if (cache.has(d)) { const r = cache.get(d); seen.forEach(s => cache.set(s, r)); return r; }
    seen.push(d);
    const f = path.join(d, 'package.json');
    if (fs.existsSync(f)) {
      let j;
      try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
      if (typeof j.name === 'string' && typeof j.version === 'string') {
        const license = typeof j.license === 'string' ? j.license
          : Array.isArray(j.licenses) ? j.licenses.map(l => (l && l.type) || l).filter(x => typeof x === 'string') : undefined;
        const r = { name: j.name, version: j.version, path: d, license };
        seen.forEach(s => cache.set(s, r));
        return r;
      }
    }
  }
  seen.forEach(s => cache.set(s, null));
  return null;
}

// files: absolute paths of source files that ended up in the bundle (query strings allowed).
// Returns one entry per package directory; files outside node_modules (the project itself) are ignored.
function packagesForFiles(files) {
  const cache = new Map();
  const pkgs = new Map();
  for (const f of files) {
    const file = f.split('?')[0];
    if (!path.isAbsolute(file) || !file.split(path.sep).includes('node_modules')) continue;
    const p = findPackage(path.dirname(file), cache);
    if (p) pkgs.set(p.path, p);
  }
  return [...pkgs.values()];
}

module.exports = { findPackage, packagesForFiles };
