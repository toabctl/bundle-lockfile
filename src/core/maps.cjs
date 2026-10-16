'use strict';
// Map helpers shared by the core modules and the adapters. No dependencies: anything may use it.

// The value of `key` in `map`, made with make() and set first if there is none: a Map of lists or sets filled one
// entry at a time.
/**
 * @template K, V
 * @param {Map<K, V>} map
 * @param {K} key
 * @param {() => NoInfer<V>} make
 * @returns {V}
 */
function getOr(map, key, make) {
  let v = map.get(key);
  if (v === undefined && !map.has(key)) map.set(key, (v = make()));
  return /** @type {V} */ (v);
}

module.exports = { getOr };
