'use strict';
// Path helpers shared by the core modules and the adapters.
const path = require('path');

// A directory and every directory above it, up to the root.
function* ancestors(dir) {
  for (;;) {
    yield dir;
    const up = path.dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}

// A relative path with "/" separators, as the lockfile records paths (the same on every platform).
const posix = (p) => p.split(path.sep).join('/');

module.exports = { ancestors, posix };
