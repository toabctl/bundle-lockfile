'use strict';
// Test-only preload, put before register.cjs in NODE_OPTIONS: makes collecting the packages fail, to prove
// that a failing adapter does not break the build.
require('../../src/core/lockfile.cjs').lockfileForFiles = () => { throw new Error('injected fault (test/lib/fault.cjs)'); };
