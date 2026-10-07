'use strict';
// Settings, all from environment variables (the tool is injected into builds we do not control).
//   BUNDLE_LOCKFILE_FILE     output path relative to the bundler's output dir
//                            (default: bundle-lockfile/package-lock.json)
//   BUNDLE_LOCKFILE_DEBUG    log what gets patched and applied to stderr
//   BUNDLE_LOCKFILE_DISABLE  comma-separated adapter names to skip, or "all"

const env = process.env;
const disabled = new Set((env.BUNDLE_LOCKFILE_DISABLE || '').split(',').map(s => s.trim()).filter(Boolean));

module.exports = {
  file: env.BUNDLE_LOCKFILE_FILE || 'bundle-lockfile/package-lock.json',
  isDisabled: (name) => disabled.has('all') || disabled.has(name),
  debug: (...a) => { if (env.BUNDLE_LOCKFILE_DEBUG) console.error('[bundle-lockfile]', ...a); },
  // always printed: a failing adapter must not break the build, but the missing lockfile must not go unnoticed
  warn: (...a) => console.error('[bundle-lockfile] WARNING:', ...a),
};
