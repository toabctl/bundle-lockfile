'use strict';
// Test-only preload, put before register.cjs in NODE_OPTIONS: makes collecting the packages fail, to prove that a
// failing adapter fails the build with the reason (strict mode, the default) - and with BUNDLE_LOCKFILE_STRICT=0 does
// not break it.
require('../../src/core/packages.cjs').packagesOfFiles = () => { throw new Error('injected fault (test/lib/fault.cjs)'); };
