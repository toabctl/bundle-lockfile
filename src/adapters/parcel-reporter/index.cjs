'use strict';
// bundle-lockfile's Parcel reporter, which src/adapters/parcel.cjs adds to every Parcel (its additionalReporters):
// on buildSuccess - after Parcel wrote the bundles - the packages of the assets of the bundles, per target directory.
// Parcel loads it by this directory's path; a plugin is the object at Symbol.for('parcel-plugin-config') of its
// default export, which @parcel/plugin's Reporter class would make (not needed for that). Parcel requires a plugin's
// modules through the project's resolver (Yarn Plug'n'Play's resolves nothing outside the project): the adapter, which
// added this reporter, is reached through the global it registers, not with require().
const API = Symbol.for('bundle-lockfile.parcel');
module.exports = { default: { [Symbol.for('parcel-plugin-config')]: { report(/** @type {unknown} */ opts) {
  const registry = /** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (globalThis));
  const api = /** @type {{ report: (opts: unknown) => unknown } | undefined} */ (registry[API]); // (what the adapter registers there)
  if (!api) throw new Error('bundle-lockfile: its Parcel reporter runs without bundle-lockfile preloaded');
  return api.report(opts);
} } } };
