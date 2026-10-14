'use strict';
// Comparison tooling: what tools that take the NEAREST package.json see for bundled files - read from the package.json
// files on disk, sharing no code with bundle-lockfile (nor with the oracles' attribution). For each file below
// node_modules: the package root (the directory below the last node_modules), every package.json with a name between
// the file and the root, and whether the root's package.json declares a license.
const fs = require('fs');
const path = require('path');

const json = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const idOf = (j) => `${j.name}@${typeof j.version === 'string' ? j.version : ''}`;
const hasLicense = (j) => !!j && (j.license !== undefined || j.licenses !== undefined);

// the package root of a file (Yarn's pnpm linker: node_modules/.store/<slug>/package), or null
function rootOf(file) {
  const parts = file.split(path.sep);
  const i = parts.lastIndexOf('node_modules');
  if (i < 0 || i + 2 >= parts.length) return null;
  if (parts[i + 1] === '.store' && parts[i + 3] === 'package') return i + 4 < parts.length ? parts.slice(0, i + 4).join(path.sep) : null;
  const n = parts[i + 1].startsWith('@') ? 2 : 1;
  return i + n + 1 < parts.length ? parts.slice(0, i + 1 + n).join(path.sep) : null;
}

// files: absolute paths (query strings allowed). Returns
//   nested: [{ id: name@version ('' without one), root: the root's name@version }] - package.json files inside packages
//   unlicensed: { "<root name@version>": "<name@version of the package root around it>" } - roots without a license
//     field inside another package (a tool that walks up to a package.json with a license lists the outer one)
function nearest(files) {
  const nested = new Map(), unlicensed = {};
  for (const f of files) {
    const file = real(f.split('?')[0]);
    const root = rootOf(file);
    if (!root) continue;
    const rj = json(path.join(root, 'package.json'));
    if (!rj || !rj.name) continue;
    const rootId = idOf(rj);
    for (let d = path.dirname(file); d.startsWith(root + path.sep); d = path.dirname(d)) {
      const j = json(path.join(d, 'package.json'));
      if (j && typeof j.name === 'string' && j.name) nested.set(`${idOf(j)} ${rootId}`, { id: idOf(j), root: rootId });
    }
    if (!hasLicense(rj)) {
      // .../node_modules/a/node_modules/b: the package around b is a
      const parts = root.split(path.sep);
      const outer = rootOf(path.join(parts.slice(0, parts.lastIndexOf('node_modules')).join(path.sep), 'x'));
      const oj = outer && json(path.join(outer, 'package.json'));
      if (oj && oj.name) unlicensed[rootId] = idOf(oj);
    }
  }
  return { nested: [...nested.values()], unlicensed };
}

module.exports = { nearest, rootOf };
