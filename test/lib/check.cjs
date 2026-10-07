'use strict';
// Checks shared by all bundlers: lockfiles are ones syft can read, and their package lists.
const fs = require('fs');
const path = require('path');

const LOCKFILE_DIR = 'bundle-lockfile';
const LOCKFILE = `${LOCKFILE_DIR}/package-lock.json`;

// Sorted name@version list of one lockfile. Throws if it is malformed.
function readLockfile(f) {
  const lock = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (lock.lockfileVersion !== 3 || typeof lock.packages !== 'object') throw new Error(`${f}: not a lockfileVersion 3 package-lock`);
  if (lock.packages[''] && lock.packages[''].name) throw new Error(`${f}: root entry has a name (syft would report it as a package)`);
  const list = [];
  for (const [key, p] of Object.entries(lock.packages)) {
    if (key === '') continue;
    if (!key.includes('node_modules/')) throw new Error(`${f}: key ${key} is not a node_modules path`);
    if (typeof p.name !== 'string' || !p.name) throw new Error(`${f}: no name for ${key} (syft needs it for aliased packages)`);
    if (!p.version) throw new Error(`${f}: no version for ${key}`);
    list.push(`${p.name}@${p.version}`);
  }
  return list.sort();
}

// All lockfiles below outDir: { "<compiler output dir relative to outDir>": [name@version, ...] }.
// Any other package-lock.json below outDir is an error (e.g. a child compiler writing its own).
function readLockfiles(outDir) {
  const result = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name !== 'package-lock.json') continue;
      if (path.basename(d) !== LOCKFILE_DIR) throw new Error(`unexpected lockfile ${p}`);
      result[path.relative(outDir, path.dirname(d)).split(path.sep).join('/')] = readLockfile(p);
    }
  };
  if (fs.existsSync(outDir)) walk(outDir);
  return result;
}

const sortedKeys = (o) => Object.fromEntries(Object.keys(o).sort().map(k => [k, [...o[k]].sort()]));
const sameMap = (a, b) => JSON.stringify(sortedKeys(a)) === JSON.stringify(sortedKeys(b));
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const show = (m) => Object.entries(sortedKeys(m)).map(([k, v]) => `\n    ${k || '.'}: ${v.join(' ') || '(none)'}`).join('');

module.exports = { LOCKFILE, readLockfile, readLockfiles, sameMap, same, show };
