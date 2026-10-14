'use strict';
// Checks shared by all bundlers: lockfiles are ones syft and Trivy can read, and their package lists.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

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

// A lockfile's record is right where the lockfile is (f: its path; at: the directory its record is for - its own, or for
// an export copy the one of the lockfile in the output): "self" from its context leads back to it, and every package it
// lists is where the record says - its key, or its "locations" entry for a key that is not the location, relative to
// the context is a directory whose package.json has that name and version (in Yarn PnP's cache: in a zip that is
// there). Packages outside the project ("outside") and those whose location is not known ("unknown") have none.
// A record without its paths (an output outside the project: "contextId" and "selfId", docs/format.md) is checked
// against the case's contexts: one of them must have its ids. Returns the number checked.
function checkLocations(f, at = path.dirname(f), contexts = []) {
  const lock = JSON.parse(fs.readFileSync(f, 'utf8'));
  const m = lock['bundle-lockfile'];
  if (!m || (typeof m.context !== 'string' && typeof m.contextId !== 'string')) throw new Error(`${f}: no bundle-lockfile record`);
  const outside = new Set([...(m.outside || []), ...(m.unknown || [])]), locations = m.locations || {};
  let context;
  if (typeof m.context === 'string') {
    context = path.resolve(at, m.context);
    if (typeof m.self !== 'string' || path.resolve(context, m.self) !== path.resolve(at)) {
      throw new Error(`${f}: its record is not for where it is (context ${m.context}, self ${m.self})`);
    }
  } else {
    context = contexts.find(c => anchorIds(c, at).contextId === m.contextId);
    if (!context) throw new Error(`${f}: its record's contextId ${m.contextId} is none of ${contexts.join(', ') || '(no contexts)'}`);
    if (anchorIds(context, at).selfId !== m.selfId) throw new Error(`${f}: its record's selfId ${m.selfId} is not for where it is`);
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

// The ids of a record without its paths, as docs/format.md defines them: of the context's real path, device and inode,
// and of the lockfile's directory relative to the context (both real)
function anchorIds(context, dir) {
  const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
  const real = fs.realpathSync(context), st = fs.statSync(real);
  const secret = sha(`bundle-lockfile\0${real}\0${st.dev}\0${st.ino}`);
  const rel = path.relative(real, fs.realpathSync(dir)).split(path.sep).join('/');
  return { contextId: sha(`context\0${secret}`).slice(0, 16), selfId: sha(`self\0${secret}\0${rel}`).slice(0, 16) };
}

const sortedKeys = (o) => Object.fromEntries(Object.keys(o).sort().map(k => [k, [...o[k]].sort()]));
const sameMap = (a, b) => JSON.stringify(sortedKeys(a)) === JSON.stringify(sortedKeys(b));
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const show = (m) => Object.entries(sortedKeys(m)).map(([k, v]) => `\n    ${k || '.'}: ${v.join(' ') || '(none)'}`).join('');

// The keys of a lockfile's packages outside the project ("outside") or whose location is not known ("unknown")
function unlocated(f) {
  const m = JSON.parse(fs.readFileSync(f, 'utf8'))['bundle-lockfile'] || {};
  return [...(m.outside || []), ...(m.unknown || [])];
}

// The data: URLs in a text, decoded (base64, or percent-encoded): what a bundler inlined into a file - an image a style
// sheet uses, below the inline limit
function dataUrls(text) {
  const out = [];
  for (const m of text.matchAll(/data:[\w.+-]+\/[\w.+-]+((?:;[\w.+-]+=[\w.+-]+)*)(;base64)?,([^"'()\s]*)/g)) {
    try { out.push(m[2] ? Buffer.from(m[3], 'base64').toString('latin1') : decodeURIComponent(m[3])); } catch { /* not decodable */ }
  }
  return out;
}

// The canaries in the files below dir (test/apps/canary): name@version of each BLCANARY:<name>@<version> in their bytes,
// gzip and brotli copies unpacked, data: URLs in them decoded - what is shipped, whatever the bundler reports. Sorted,
// unique
const MARKER = /BLCANARY:((?:@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+)/g;
function canaries(dir) {
  const found = new Set();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      let bytes = fs.readFileSync(p);
      try { if (p.endsWith('.gz')) bytes = zlib.gunzipSync(bytes); else if (p.endsWith('.br')) bytes = zlib.brotliDecompressSync(bytes); } catch { /* not compressed */ }
      const text = bytes.toString('latin1');
      for (const t of [text, ...dataUrls(text)]) for (const m of t.matchAll(MARKER)) found.add(m[1]);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return [...found].sort();
}

// How the writers of a lockfile found its packages (its record's "via", see src/core/via.cjs): { class: [name@version] },
// over all writers, sorted and unique
function viaOf(f) {
  const lock = JSON.parse(fs.readFileSync(f, 'utf8'));
  const out = {};
  for (const w of (lock['bundle-lockfile'] || {}).writers || []) {
    for (const [cls, list] of Object.entries(w.via || {})) {
      for (const i of list) {
        const p = lock.packages[w.packages[i]];
        if (!p) throw new Error(`${f}: via ${cls} names package ${i} of writer ${w.id}, which it does not have`);
        (out[cls] = out[cls] || new Set()).add(`${p.name}@${p.version}`);
      }
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

module.exports = { LOCKFILE, readLockfile, readLockfiles, checkLocations, anchorIds, unlocated, canaries, dataUrls, viaOf, sameMap, same, show };
