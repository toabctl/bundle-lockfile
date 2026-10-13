'use strict';
// Settings, from environment variables (the tool is injected into builds we do not control), and from a settings file
// for builds whose tools do not pass them on (see readSettingsFile).
//   BUNDLE_LOCKFILE_FILE        output path relative to the bundler's output dir
//                               (default: bundle-lockfile/package-lock.json)
//   BUNDLE_LOCKFILE_EXPORT_DIR  also write every lockfile below this directory (see core/paths.cjs exportPath),
//                               for outputs that do not ship as files (embedded in a binary, a jar, copied away)
//   BUNDLE_LOCKFILE_EXPORT_BASE output dirs below it are mirrored relative to it into the export dir (default: their
//                               absolute path)
//   BUNDLE_LOCKFILE_INLINE      0/false/off: do not write the lockfile into the output dir (only the export dir);
//                               on/off settings take 1/true/on and 0/false/off (any case), anything else is invalid
//   BUNDLE_LOCKFILE_DEBUG       log what gets patched and applied to stderr (1/true/on; off if unset or empty)
//   BUNDLE_LOCKFILE_DISABLE     comma-separated adapter names to skip, or "all" (case-insensitive)
//   BUNDLE_LOCKFILE_FIRST_PARTY comma-separated absolute globs of directories that are first-party, never vendored
//                               copies (see core/vendored.cjs); "/**": none is
//   BUNDLE_LOCKFILE_STRICT      0/false/off: a lockfile that cannot be written, or would be incomplete, is a warning;
//                               by default it fails the build (see core/problems.cjs)
//   BUNDLE_LOCKFILE_CONFIG      the settings file (default: config.json next to register.cjs: src/ in a checkout,
//                               the installed directory in a package)
//   BUNDLE_LOCKFILE_ESM_HOOKS   auto/sync/async/off (read by hooks.cjs)
//   BUNDLE_LOCKFILE_TREE        off (default), on: also a package.json per package next to the lockfile, for image
//                               scans (see core/tree.cjs); only: those instead of a package-lock.json (the record in
//                               record.json, which no SBOM tool reads)
// Any other BUNDLE_LOCKFILE_* variable, or a value that is not recognized, is invalid: reported by register.cjs.

const fs = require('fs');
const path = require('path');
const env = process.env;

// Every BUNDLE_LOCKFILE_* variable bundle-lockfile reads. A name that is not one of them is a mistake (a typo such as
// BUNDLE_LOCKFILE_EXPORTDIR would leave the export directory unset): it is reported, as are values that are not
// recognized (see invalid). FROM_FILE: those a settings file may set (CONFIG names the file; REGISTER is read by the
// node shim, a shell script, which does not read the file; NODE_SHIM and NODE_SEEN are the shim's own).
const NAMES = ['FILE', 'EXPORT_DIR', 'EXPORT_BASE', 'INLINE', 'STRICT', 'DEBUG', 'FIRST_PARTY', 'DISABLE', 'ESM_HOOKS', 'TREE',
  'REGISTER', 'CONFIG', 'NODE_SHIM', 'NODE_SEEN'].map(n => `BUNDLE_LOCKFILE_${n}`);
const FROM_FILE = NAMES.filter(n => !/_(CONFIG|REGISTER|NODE_SHIM|NODE_SEEN)$/.test(n));
// The names BUNDLE_LOCKFILE_DISABLE takes: the adapters' names (src/adapters/*.cjs name, names), and all
const ADAPTER_NAMES = ['webpack', 'rspack', 'vite', 'rollup', 'rolldown', 'esbuild', 'parcel', 'angular', 'next'];
const ESM_HOOKS = ['auto', 'sync', 'async', 'off'];
const TREES = ['off', 'on', 'only'];
const invalid = []; // what is set but not recognized, or cannot work: register.cjs reports each (core/problems.cjs)
const fromFile = new Set(); // the settings the settings file set (not the environment)

// The settings file: { "BUNDLE_LOCKFILE_EXPORT_DIR": "/x", ... }. Some build tools pass on NODE_OPTIONS and PATH but
// not these variables (turbo's strict env mode), or start the build with an environment of their own (Metabase's
// build): the preload, or the node shim through PATH, still gets there, and finds the file next to register.cjs. Its
// settings go into process.env where the variable is not set (a variable set, also to '', wins), so that the
// processes the build starts get them too. Only BUNDLE_LOCKFILE_* settings it may set, with string, number or boolean
// values: any other key or value is invalid. Only from bundle-lockfile's own directory or the file
// BUNDLE_LOCKFILE_CONFIG names: never from the project, which must not redirect a package build's lockfiles.
// Returns { file, error } (error: the file could not be used; core/problems.cjs reports it, see register.cjs).
function readSettingsFile() {
  const named = env.BUNDLE_LOCKFILE_CONFIG && env.BUNDLE_LOCKFILE_CONFIG.trim();
  if (named && !path.isAbsolute(named)) invalid.push(`BUNDLE_LOCKFILE_CONFIG is not an absolute path: ${named} (each process would look for it in its own working directory)`);
  const file = named ? path.resolve(named) : path.join(__dirname, '..', 'config.json');
  let settings;
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT' && !named) return { file: null, error: null }; // no settings file: none
    return { file, error: e };
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { file, error: new Error('not a JSON object') };
  for (const [k, v] of Object.entries(settings)) {
    if (!FROM_FILE.includes(k)) {
      invalid.push(`the settings file ${file} sets ${k}, which ${NAMES.includes(k) ? 'only the environment can set' : 'is no setting of bundle-lockfile'}`);
    } else if (v === null || typeof v === 'object') {
      invalid.push(`the settings file ${file} sets ${k} to ${JSON.stringify(v)}: not a string, number or boolean`);
    } else if (env[k] === undefined) { env[k] = String(v); fromFile.add(k); }
  }
  return { file, error: null };
}
const settingsFile = readSettingsFile();
for (const k of Object.keys(env)) {
  if (k.startsWith('BUNDLE_LOCKFILE_') && !NAMES.includes(k)) invalid.push(`${k} is set, but is no setting of bundle-lockfile`);
}

const value = (k) => (env[k] === undefined ? '' : env[k].trim());
// where a setting comes from, for messages: nothing for the environment, the settings file for one it set
const from = (k) => (fromFile.has(k) ? ` (from the settings file ${settingsFile.file})` : '');
const shown = (k) => `${k}=${env[k]}${from(k)}`;
// an on/off setting: unset or empty - the default; 1, true, on / 0, false, off (any case); anything else is invalid
// (the default then: BUNDLE_LOCKFILE_STRICT=yes stays strict, and fails the build for the invalid value)
function flag(k, dflt) {
  const v = value(k);
  if (!v) return dflt;
  if (/^(1|true|on)$/i.test(v)) return true;
  if (/^(0|false|off)$/i.test(v)) return false;
  invalid.push(`${shown(k)} is not recognized (1, true or on; 0, false or off)`);
  return dflt;
}
// an absolute directory, or null: a relative one would resolve against each process's working directory
function dir(k) {
  const v = value(k);
  if (!v) return null;
  if (!path.isAbsolute(v)) invalid.push(`${k} is not an absolute path: ${v}${from(k)} (each process would resolve it in its own working directory)`);
  return path.resolve(v);
}
// the lockfile's path below an output directory: relative, inside it, named package-lock.json and not below a
// node_modules directory - the only files syft and Trivy read. Unset or empty: the default. A backslash separates
// directories only on Windows: elsewhere it is part of a name (sbom\package-lock.json is no file named package-lock.json).
// With BUNDLE_LOCKFILE_TREE=only, the file next to it named record.json instead (see tree).
function lockfilePath() {
  const v = value('BUNDLE_LOCKFILE_FILE') || 'bundle-lockfile/package-lock.json';
  const parts = path.sep === '\\' ? v.split(/[\\/]/) : v.split('/');
  if (path.isAbsolute(v) || parts.includes('..') || parts[parts.length - 1] !== 'package-lock.json' || parts.includes('node_modules')) {
    invalid.push(`BUNDLE_LOCKFILE_FILE=${v}${from('BUNDLE_LOCKFILE_FILE')} is not a relative path inside the output directory to a file named package-lock.json outside node_modules (the only files syft and Trivy read)`);
  }
  return tree === 'only' ? [...parts.slice(0, -1), 'record.json'].join('/') : v;
}

// BUNDLE_LOCKFILE_TREE: any case, spaces ignored; unset or empty: off
const tree = value('BUNDLE_LOCKFILE_TREE').trim().toLowerCase() || 'off';
if (!TREES.includes(tree)) invalid.push(`${shown('BUNDLE_LOCKFILE_TREE')} is none of ${TREES.join(', ')}`);

const disabled = new Set(value('BUNDLE_LOCKFILE_DISABLE').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
for (const n of disabled) if (n !== 'all' && !ADAPTER_NAMES.includes(n)) invalid.push(`BUNDLE_LOCKFILE_DISABLE names ${n}${from('BUNDLE_LOCKFILE_DISABLE')}, which is none of ${ADAPTER_NAMES.join(', ')} or all`);
// BUNDLE_LOCKFILE_ESM_HOOKS as hooks.cjs reads it when it installs the hooks: any case, spaces ignored; unset or empty: auto
const esmHooksOf = (v) => (v === undefined ? '' : String(v).trim()).toLowerCase() || 'auto';
if (!ESM_HOOKS.includes(esmHooksOf(env.BUNDLE_LOCKFILE_ESM_HOOKS))) invalid.push(`${shown('BUNDLE_LOCKFILE_ESM_HOOKS')} is none of ${ESM_HOOKS.join(', ')}`);
// sync needs module.registerHooks: without it no ES-module bundler would be hooked
else if (esmHooksOf(env.BUNDLE_LOCKFILE_ESM_HOOKS) === 'sync' && typeof require('module').registerHooks !== 'function') {
  invalid.push(`${shown('BUNDLE_LOCKFILE_ESM_HOOKS')} needs module.registerHooks, which Node.js ${process.versions.node} does not have (22.15 and later): ES-module bundlers would not be hooked`);
}
const exportDir = dir('BUNDLE_LOCKFILE_EXPORT_DIR'), exportBase = dir('BUNDLE_LOCKFILE_EXPORT_BASE');
if (exportBase && !exportDir) invalid.push(`BUNDLE_LOCKFILE_EXPORT_BASE is set${from('BUNDLE_LOCKFILE_EXPORT_BASE')} without BUNDLE_LOCKFILE_EXPORT_DIR: it has no effect`);
// the node shim (bin/node) preloads it in every process, wherever that runs: Node's --require takes a relative path as
// a package name (the shim refuses it too)
const register = value('BUNDLE_LOCKFILE_REGISTER');
if (register && !path.isAbsolute(register)) invalid.push(`BUNDLE_LOCKFILE_REGISTER is not an absolute path: ${register} (the node shim preloads it in every process, wherever it runs)`);
const debugOn = flag('BUNDLE_LOCKFILE_DEBUG', false);
// absolute globs: a relative one would match different directories in each process (turbo's tasks, workspace builds
// run in their package's directory); one that is not is left out (with BUNDLE_LOCKFILE_STRICT=0: more vendored copies
// listed, rather than other directories' left out)
const firstParty = value('BUNDLE_LOCKFILE_FIRST_PARTY').split(',').map(s => s.trim()).filter(Boolean).filter((g) => {
  if (path.isAbsolute(g)) return true;
  invalid.push(`BUNDLE_LOCKFILE_FIRST_PARTY names ${g}${from('BUNDLE_LOCKFILE_FIRST_PARTY')}, which is not an absolute path (each process would match it against its own working directory)`);
  return false;
});

module.exports = {
  settingsFile, // { file: the settings file read, or null; error: why it could not be used, or null }
  invalid, // settings that are set but not recognized, or cannot work (messages)
  ADAPTER_NAMES,
  esmHooksOf,
  file: lockfilePath(),
  tree: TREES.includes(tree) ? tree : 'off',
  exportDir,
  exportBase,
  inline: flag('BUNDLE_LOCKFILE_INLINE', true),
  isDisabled: (name) => disabled.has('all') || disabled.has(name.toLowerCase()),
  firstParty,
  strict: flag('BUNDLE_LOCKFILE_STRICT', true),
  debug: (...a) => { if (debugOn) console.error('[bundle-lockfile]', ...a); },
  // always printed: what is wrong but does not fail the build (with BUNDLE_LOCKFILE_STRICT=0: also what makes a
  // lockfile missing or incomplete, see core/problems.cjs)
  warn: (...a) => console.error('[bundle-lockfile] WARNING:', ...a),
  // what fails the build (see core/problems.cjs)
  error: (...a) => console.error('[bundle-lockfile] ERROR:', ...a),
  // always printed too: what a build lists that it might not expect (vendored copies, see core/vendored.cjs)
  note: (...a) => console.error('[bundle-lockfile] note:', ...a),
};
