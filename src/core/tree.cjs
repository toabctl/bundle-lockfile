'use strict';
// BUNDLE_LOCKFILE_TREE: a package.json per package of a lockfile, next to it, for the scans that read no lockfiles -
// image scans (syft's image catalogers, grype, Trivy's image and rootfs scans) read installed package.json files
// instead. Directory scans read no package.json files (syft dir:, trivy fs), so the packages are not reported twice
// there. Each package's at packages/<id>/node_modules/<name>/package.json below the lockfile's directory: a package
// root by Trivy's rules (the directory below the last node_modules), one per lockfile key (id: of the key), with only
// name, version and license. Never resolved by Node.js or a bundler: no output file is below it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = 'packages';
// a file of a tree: <lockfile dir>/packages/<id>/node_modules/... (see copies.cjs, late.cjs: no package's file)
const IN_TREE = /[\\/]packages[\\/][0-9a-f]{16}[\\/]node_modules[\\/]/;
const unique = () => `${process.pid}.${crypto.randomBytes(8).toString('hex')}`;

// The stubs of a lockfile's content: [[path relative to the lockfile's directory, content]], sorted.
function stubsOf(json) {
  const doc = JSON.parse(json);
  const out = [];
  for (const [key, p] of Object.entries((doc && doc.packages) || {})) {
    if (!key || !p || typeof p.name !== 'string' || typeof p.version !== 'string') continue;
    const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
    const stub = { name: p.name, version: p.version, ...(typeof p.license === 'string' ? { license: p.license } : {}) };
    out.push([[DIR, id, 'node_modules', ...p.name.split('/'), 'package.json'].join('/'), JSON.stringify(stub, null, 2) + '\n']);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// Writes the tree of the lockfile content `json` into dir (the lockfile's directory), replacing the one there: built
// aside and renamed into place, so a reader sees the old tree or the new one (and between the two renames, none).
// Under the lockfile's lock (core/outputs.cjs rewrite). Throws if it cannot.
function writeTree(dir, json) {
  const stubs = stubsOf(json);
  const target = path.join(dir, DIR);
  if (sameTree(target, stubs)) return;
  const tmp = path.join(dir, `.${DIR}.${unique()}.tmp`);
  try {
    for (const [rel, content] of stubs) {
      const f = path.join(tmp, ...rel.split('/').slice(1));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content, { flag: 'wx' });
    }
    fs.mkdirSync(tmp, { recursive: true }); // (no packages: an empty tree)
    let old = null;
    if (fs.existsSync(target)) { old = path.join(dir, `.${DIR}.${unique()}.old`); fs.renameSync(target, old); }
    fs.renameSync(tmp, target);
    if (old) fs.rmSync(old, { recursive: true, force: true });
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
}

// The tree at target has exactly these stubs (a rewrite with the same packages leaves it as it is)
function sameTree(target, stubs) {
  const want = new Map(stubs.map(([rel, c]) => [path.join(path.dirname(target), ...rel.split('/')), c]));
  let n = 0, same = true;
  const walk = (d) => {
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { same = false; return; }
    for (const e of list) {
      if (!same) return;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (++n > want.size || want.get(f) !== readOr(f)) same = false;
    }
  };
  walk(target);
  return same && n === want.size;
}
const readOr = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

const inTree = (file) => IN_TREE.test(file);

module.exports = { DIR, stubsOf, writeTree, inTree };
