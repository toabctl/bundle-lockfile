'use strict';
// Settings, all from environment variables (the tool is injected into builds we do not control).
//   BUNDLE_LOCKFILE_FILE        output path relative to the bundler's output dir
//                               (default: bundle-lockfile/package-lock.json)
//   BUNDLE_LOCKFILE_EXPORT_DIR  also write every lockfile below this directory (see core/outputs.cjs exportPath),
//                               for outputs that do not ship as files (embedded in a binary, a jar, copied away)
//   BUNDLE_LOCKFILE_EXPORT_BASE output dirs below it are mirrored relative to it into the export dir (default: their
//                               absolute path)
//   BUNDLE_LOCKFILE_INLINE      0/false/off: do not write the lockfile into the output dir (only the export dir)
//   BUNDLE_LOCKFILE_DEBUG       log what gets patched and applied to stderr (off if unset, empty, 0 or false)
//   BUNDLE_LOCKFILE_DISABLE     comma-separated adapter names to skip, or "all" (case-insensitive)

const path = require('path');
const env = process.env;
const disabled = new Set((env.BUNDLE_LOCKFILE_DISABLE || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const on = (v) => !!v && !/^(0|false|off)$/i.test(v.trim());
const dir = (v) => (v && v.trim() ? path.resolve(v.trim()) : null);

module.exports = {
  file: env.BUNDLE_LOCKFILE_FILE || 'bundle-lockfile/package-lock.json',
  exportDir: dir(env.BUNDLE_LOCKFILE_EXPORT_DIR),
  exportBase: dir(env.BUNDLE_LOCKFILE_EXPORT_BASE),
  inline: env.BUNDLE_LOCKFILE_INLINE === undefined || env.BUNDLE_LOCKFILE_INLINE.trim() === '' || on(env.BUNDLE_LOCKFILE_INLINE),
  isDisabled: (name) => disabled.has('all') || disabled.has(name.toLowerCase()),
  debug: (...a) => { if (on(env.BUNDLE_LOCKFILE_DEBUG)) console.error('[bundle-lockfile]', ...a); },
  // always printed: a failing adapter must not break the build, but the missing lockfile must not go unnoticed
  warn: (...a) => console.error('[bundle-lockfile] WARNING:', ...a),
};
