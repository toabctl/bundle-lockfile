'use strict';
// Settings, from environment variables (the tool is injected into builds we do not control), and from a settings file
// for builds whose tools do not pass them on (see readSettingsFile).
//   BUNDLE_LOCKFILE_FILE        output path relative to the bundler's output dir
//                               (default: bundle-lockfile/package-lock.json)
//   BUNDLE_LOCKFILE_EXPORT_DIR  also write every lockfile below this directory (see core/paths.cjs exportPath),
//                               for outputs that do not ship as files (embedded in a binary, a jar, copied away)
//   BUNDLE_LOCKFILE_EXPORT_BASE output dirs below it are mirrored relative to it into the export dir (default: their
//                               absolute path)
//   BUNDLE_LOCKFILE_INLINE      0/false/off: do not write the lockfile into the output dir (only the export dir)
//   BUNDLE_LOCKFILE_DEBUG       log what gets patched and applied to stderr (off if unset, empty, 0, false or off)
//   BUNDLE_LOCKFILE_DISABLE     comma-separated adapter names to skip, or "all" (case-insensitive)
//   BUNDLE_LOCKFILE_FIRST_PARTY comma-separated globs of directories (relative to the working directory) that are
//                               first-party, never vendored copies (see core/vendored.cjs); "**": none is
//   BUNDLE_LOCKFILE_STRICT      0/false/off: a lockfile that cannot be written, or would be incomplete, is a warning;
//                               by default it fails the build (see core/problems.cjs)
//   BUNDLE_LOCKFILE_CONFIG      the settings file (default: config.json next to register.cjs: src/ in a checkout,
//                               the installed directory in a package)

const fs = require('fs');
const path = require('path');
const env = process.env;

// The settings file: { "BUNDLE_LOCKFILE_EXPORT_DIR": "/x", ... }. Some build tools pass on NODE_OPTIONS and PATH but
// not these variables (turbo's strict env mode), or start the build with an environment of their own (Metabase's
// build): the preload, or the node shim through PATH, still gets there, and finds the file next to register.cjs. Its
// settings go into process.env where the variable is not set (a variable set, also to '', wins), so that the
// processes the build starts get them too. Only BUNDLE_LOCKFILE_* keys, and only from bundle-lockfile's own directory or
// the file BUNDLE_LOCKFILE_CONFIG names: never from the project, which must not redirect a package build's lockfiles.
// Returns { file, error } (error: the file could not be used; core/problems.cjs reports it, see register.cjs).
function readSettingsFile() {
  const named = env.BUNDLE_LOCKFILE_CONFIG && env.BUNDLE_LOCKFILE_CONFIG.trim();
  const file = named ? path.resolve(named) : path.join(__dirname, '..', 'config.json');
  let settings;
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT' && !named) return { file: null, error: null }; // no settings file: none
    return { file, error: e };
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { file, error: new Error('not a JSON object') };
  for (const [k, v] of Object.entries(settings)) {
    if (!k.startsWith('BUNDLE_LOCKFILE_') || k === 'BUNDLE_LOCKFILE_CONFIG') continue;
    if (env[k] === undefined && v !== null && typeof v !== 'object') env[k] = String(v);
  }
  return { file, error: null };
}
const settingsFile = readSettingsFile();
const disabled = new Set((env.BUNDLE_LOCKFILE_DISABLE || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const on = (v) => !!v && !/^(0|false|off)$/i.test(v.trim());
const dir = (v) => (v && v.trim() ? path.resolve(v.trim()) : null);

module.exports = {
  settingsFile, // { file: the settings file read, or null; error: why it could not be used, or null }
  file: env.BUNDLE_LOCKFILE_FILE || 'bundle-lockfile/package-lock.json',
  exportDir: dir(env.BUNDLE_LOCKFILE_EXPORT_DIR),
  exportBase: dir(env.BUNDLE_LOCKFILE_EXPORT_BASE),
  inline: env.BUNDLE_LOCKFILE_INLINE === undefined || env.BUNDLE_LOCKFILE_INLINE.trim() === '' || on(env.BUNDLE_LOCKFILE_INLINE),
  isDisabled: (name) => disabled.has('all') || disabled.has(name.toLowerCase()),
  firstParty: (env.BUNDLE_LOCKFILE_FIRST_PARTY || '').split(',').map(s => s.trim()).filter(Boolean),
  strict: env.BUNDLE_LOCKFILE_STRICT === undefined || env.BUNDLE_LOCKFILE_STRICT.trim() === '' || on(env.BUNDLE_LOCKFILE_STRICT),
  debug: (...a) => { if (on(env.BUNDLE_LOCKFILE_DEBUG)) console.error('[bundle-lockfile]', ...a); },
  // always printed: what is wrong but does not fail the build (with BUNDLE_LOCKFILE_STRICT=0: also what makes a
  // lockfile missing or incomplete, see core/problems.cjs)
  warn: (...a) => console.error('[bundle-lockfile] WARNING:', ...a),
  // what fails the build (see core/problems.cjs)
  error: (...a) => console.error('[bundle-lockfile] ERROR:', ...a),
  // always printed too: what a build lists that it might not expect (vendored copies, see core/vendored.cjs)
  note: (...a) => console.error('[bundle-lockfile] note:', ...a),
};
