'use strict';
// BUNDLE_LOCKFILE_TREE: a package.json per package of a lockfile, next to it, for the scans that read no lockfiles -
// image scans (syft's image catalogers, grype, Trivy's image and rootfs scans) read installed package.json files
// instead. Directory scans read no package.json files (syft dir:, trivy fs), so the packages are not reported twice
// there. Each package's at packages/<id>/node_modules/<name>/package.json below the lockfile's directory: a package
// root by Trivy's rules (the directory below the last node_modules), one per lockfile key (id: of the key), with only
// name, version and license. Never resolved by Node.js or a bundler: no output file is below it.
const fs = require('fs');
const path = require('path');
const { shortHash } = require('./hashes.cjs');
const { unique } = require('./lock.cjs');

const DIR = 'packages';
// a file of a tree: <lockfile dir>/packages/<id>/node_modules/... (see copies.cjs, late.cjs: no package's file)
const IN_TREE = /[\\/]packages[\\/][0-9a-f]{16}[\\/]node_modules[\\/]/;

// The directories of a package's name below node_modules: <name>, or @<scope> and <name>. The name is a bundled
// package's package.json says, which can be any string: one that is no such path (.., another /, a \, an empty part)
// would put its stub somewhere else - up out of the tree. Throws then (the tree is not written: a problem, see
// core/outputs.cjs).
/** @param {string} name */
function nameDirs(name) {
  const parts = name.split('/');
  /** @param {string} s */
  const ok = (s) => s !== '' && s !== '.' && s !== '..' && !/[\\\0]/.test(s);
  if ((parts.length === 1 && ok(parts[0]) && !parts[0].startsWith('@'))
    || (parts.length === 2 && parts[0].startsWith('@') && ok(parts[0].slice(1)) && ok(parts[1]))) return parts;
  throw new Error(`${JSON.stringify(name)} is no package name a package.json can be at below node_modules: no tree with it`);
}

// The stubs of a lockfile's content: [[path relative to the lockfile's directory, content]], sorted.
/**
 * @param {string} json
 * @returns {[string, string][]}
 */
function stubsOf(json) {
  /** @type {any} */
  const doc = JSON.parse(json);
  /** @type {[string, string][]} */
  const out = [];
  for (const [key, p] of Object.entries(/** @type {Record<string, any>} */ ((doc && doc.packages) || {}))) {
    if (!key || !p || typeof p.name !== 'string' || typeof p.version !== 'string') continue;
    const dirs = nameDirs(p.name);
    const id = shortHash(key);
    const stub = { name: p.name, version: p.version, ...(typeof p.license === 'string' ? { license: p.license } : {}) };
    out.push([[DIR, id, 'node_modules', ...dirs, 'package.json'].join('/'), JSON.stringify(stub, null, 2) + '\n']);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// Writes the tree of the lockfile content `json` into dir (the lockfile's directory), replacing the one there: built
// aside and renamed into place, so a reader sees the old tree or the new one (and between the two renames, none).
// Under the lockfile's lock (core/outputs.cjs rewrite). Throws if it cannot.
/**
 * @param {string} dir
 * @param {string} json
 */
function writeTree(dir, json) {
  const stubs = stubsOf(json);
  const target = path.join(dir, DIR);
  if (sameTree(target, stubs)) return;
  if (!ours(target)) throw new Error(`${target} is there and is no tree bundle-lockfile wrote (with BUNDLE_LOCKFILE_FILE=package-lock.json it is the output's own packages directory): it is not replaced`);
  const tmp = path.join(dir, `.${DIR}.${unique()}.tmp`);
  try {
    for (const [rel, content] of stubs) {
      const f = path.join(tmp, ...rel.split('/').slice(1));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content, { flag: 'wx' });
    }
    fs.mkdirSync(tmp, { recursive: true }); // (no packages: an empty tree)
    /** @type {string | null} */
    let old = null;
    if (fs.existsSync(target)) { old = path.join(dir, `.${DIR}.${unique()}.old`); fs.renameSync(target, old); }
    fs.renameSync(tmp, target);
    if (old) fs.rmSync(old, { recursive: true, force: true });
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
}

// The tree at target has exactly these stubs (a rewrite with the same packages leaves it as it is)
/**
 * @param {string} target
 * @param {[string, string][]} stubs
 */
function sameTree(target, stubs) {
  const want = new Map(stubs.map(([rel, c]) => [path.join(path.dirname(target), ...rel.split('/')), c]));
  let n = 0, same = true;
  /** @param {string} d */
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
// The directory at target is not there, or holds a tree and nothing else (stubs below <id>/node_modules/): it may be
// replaced. Another one - the output's own packages/ next to a lockfile at the output's top (BUNDLE_LOCKFILE_FILE=
// package-lock.json), a project's packages/ when the output directory is the project - must not be deleted.
const STUB = /^[0-9a-f]{16}\/node_modules\/(@[^/]+\/)?[^/]+\/package\.json$/;
/** @param {string} target */
function ours(target) {
  let st;
  try { st = fs.lstatSync(target); } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
  if (!st.isDirectory()) return false;
  /** @type {(d: string, rel: string) => boolean} */
  const walk = (d, rel) => fs.readdirSync(d, { withFileTypes: true }).every((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return (rel || /^[0-9a-f]{16}$/.test(e.name)) && walk(path.join(d, e.name), r);
    return e.isFile() && STUB.test(r);
  });
  return walk(target, '');
}

/** @param {string} f */
const readOr = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

/** @param {string} file */
const inTree = (file) => IN_TREE.test(file);

module.exports = { DIR, stubsOf, writeTree, inTree };
