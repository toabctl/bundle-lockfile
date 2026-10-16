'use strict';
// Values whose shape the type check cannot know: parsed JSON, thrown errors, state that the modules of a process share
// through globalThis. Each is unknown until checked. No dependencies: anything may use it.

// A JSON object (or any object but an array): its fields are unknown, each checked where it is read
/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// An array, of values that are unknown (Array.isArray makes them any)
/** @type {(v: unknown) => v is unknown[]} */
const isArray = (v) => Array.isArray(v);

// The strings in v, if it is an array; else none
/** @type {(v: unknown) => string[]} */
const strings = (v) => (isArray(v) ? v.filter(s => typeof s === 'string') : []);

// JSON.parse, which returns any
/** @type {(text: string) => unknown} */
const parseJson = (text) => JSON.parse(text);

// The code of a Node.js error (ENOENT, EEXIST, ...), else undefined
/** @type {(e: unknown) => string | undefined} */
const codeOf = (e) => (isObject(e) && typeof e.code === 'string' ? e.code : undefined);

// The state of a module that the copies of it in this process share (another release's, or this one loaded through
// another path): made by make() if no copy made it first. Its key names the version of its shape
// (Symbol.for('bundle-lockfile.<module>.v<n>')): copies of another shape keep their own.
/**
 * @template T
 * @param {symbol} key
 * @param {() => T} make
 * @returns {T}
 */
function perProcess(key, make) {
  const g = /** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (globalThis));
  if (!g[key]) g[key] = make();
  return /** @type {T} */ (g[key]);
}

module.exports = { isObject, isArray, strings, parseJson, codeOf, perProcess };
