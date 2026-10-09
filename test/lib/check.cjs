'use strict';
// Checks shared by all bundlers: lockfiles are ones syft and Trivy can read, and their package lists.
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
    // Trivy skips every key that does not start with node_modules (syft reads any)
    if (!key.startsWith('node_modules/')) throw new Error(`${f}: key ${key} does not start with node_modules/ (Trivy would skip it)`);
    // Yarn PnP's virtual paths are one per dependent set of one package: the key is the package in the cache
    if (/(^|\/)(__virtual__|\$\$virtual)\//.test(key)) throw new Error(`${f}: key ${key} is a Yarn virtual path`);
    if (typeof p.name !== 'string' || !p.name) throw new Error(`${f}: no name for ${key} (syft needs it for aliased packages)`);
    if (!p.version) throw new Error(`${f}: no version for ${key}`);
    // syft reads a string or an array of strings, Trivy a string or {type} objects
    if (p.license !== undefined && (typeof p.license !== 'string' || !p.license)) throw new Error(`${f}: license of ${key} is not a string: ${JSON.stringify(p.license)}`);
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

// A lockfile's record is right where the lockfile is (f: its path, inline in the output): "self" from its context
// leads back to it, and every package it lists is where the record says - its key, or its "locations" entry for a key
// that is not the location, relative to the context is a directory whose package.json has that name and version (in
// Yarn PnP's cache: in a zip that is there). Packages outside the project ("outside") and those whose location is not
// known ("unknown") have none. Returns the number checked.
function checkLocations(f) {
  const lock = JSON.parse(fs.readFileSync(f, 'utf8'));
  const m = lock['bundle-lockfile'];
  if (!m || typeof m.context !== 'string') throw new Error(`${f}: no bundle-lockfile record`);
  const outside = new Set([...(m.outside || []), ...(m.unknown || [])]), locations = m.locations || {};
  const context = path.resolve(path.dirname(f), m.context);
  if (typeof m.self !== 'string' || path.resolve(context, m.self) !== path.resolve(path.dirname(f))) {
    throw new Error(`${f}: its record is not for where it is (context ${m.context}, self ${m.self})`);
  }
  let n = 0;
  for (const [key, p] of Object.entries(lock.packages)) {
    if (key === '' || outside.has(key)) continue;
    const at = Object.prototype.hasOwnProperty.call(locations, key) ? locations[key] : key;
    const dir = path.resolve(context, at);
    const zip = dir.match(/^(.*?\.zip)(?=[\\/])/);
    if (zip) {
      if (!fs.existsSync(zip[1])) throw new Error(`${f}: ${key} is recorded at ${at}, whose zip is not there`);
    } else {
      let j = null;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* checked below */ }
      if (!j || j.name !== p.name || j.version !== p.version) {
        throw new Error(`${f}: ${key} (${p.name}@${p.version}) is recorded at ${at}, where ${j ? `${j.name}@${j.version} is` : 'no package.json is'}`);
      }
    }
    n++;
  }
  return n;
}

const sortedKeys = (o) => Object.fromEntries(Object.keys(o).sort().map(k => [k, [...o[k]].sort()]));
const sameMap = (a, b) => JSON.stringify(sortedKeys(a)) === JSON.stringify(sortedKeys(b));
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const show = (m) => Object.entries(sortedKeys(m)).map(([k, v]) => `\n    ${k || '.'}: ${v.join(' ') || '(none)'}`).join('');

module.exports = { LOCKFILE, readLockfile, readLockfiles, checkLocations, sameMap, same, show };
