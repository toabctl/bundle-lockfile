'use strict';
// Checks shared by all bundlers: lockfiles are ones syft can read, and their package lists.
const fs = require('fs');
const path = require('path');

const LOCKFILE = 'bundle-lockfile/package-lock.json';

// Sorted, unique name@version list of one lockfile (the same name@version can sit at several paths, e.g. nested
// duplicates; keys are checked by expectKeys). Throws if it is malformed.
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
  return [...new Set(list)].sort();
}

// All lockfiles below outDir: { "<compiler output dir relative to outDir>": [name@version, ...] }.
// lockfile: path of the lockfile below each compiler output dir. Any other package-lock.json below
// outDir is an error (e.g. a child compiler writing its own).
function readLockfiles(outDir, lockfile = LOCKFILE) {
  const result = {};
  const suffix = lockfile.split('/');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name !== 'package-lock.json') continue;
      const parts = path.relative(outDir, p).split(path.sep);
      if (parts.length < suffix.length || parts.slice(-suffix.length).join('/') !== lockfile) throw new Error(`unexpected lockfile ${p}`);
      result[parts.slice(0, -suffix.length).join('/')] = readLockfile(p);
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
