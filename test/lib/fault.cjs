'use strict';
// Test-only preload, put before register.cjs in NODE_OPTIONS: makes collecting the packages fail, to prove that a
// failing adapter fails the build with the reason (strict mode, the default) - and with BUNDLE_LOCKFILE_STRICT=0 does
// not break it. BLTEST_FAULT_IN=<adapter>: only where src/adapters/<adapter>.cjs collects, to reach its own failure
// path in a build that runs builds of other adapters first (Angular's builder: its esbuild and Rolldown builds).
const packages = require('../../src/core/packages.cjs');
const original = packages.packagesOfFiles;
const only = process.env.BLTEST_FAULT_IN && new RegExp(`[\\\\/]adapters[\\\\/]${process.env.BLTEST_FAULT_IN}\\.cjs:`);
packages.packagesOfFiles = function (...args) {
  if (only && !only.test(new Error().stack || '')) return original.apply(this, args);
  throw new Error('injected fault (test/lib/fault.cjs)');
};
