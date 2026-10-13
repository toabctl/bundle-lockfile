'use strict';
// A Map as a bounded LRU: set() re-inserts the key as the newest and drops the oldest entries beyond max, so that a
// long dev or watch session does not grow it forever.
// Returns whether an older entry was dropped.
function set(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  let dropped = false;
  while (map.size > max) { map.delete(map.keys().next().value); dropped = true; }
  return dropped;
}

module.exports = { set };
