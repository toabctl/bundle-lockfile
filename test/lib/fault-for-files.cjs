'use strict';
// Test-only preload, as fault.cjs - and also collecting the packages of given files fails (packagesForFiles), which the
// adapters that list files without a bundler's modules call: Next.js' runtime packages (adapters/next.cjs).
require('./fault.cjs');
require('../../src/core/packages.cjs').packagesForFiles = () => { throw new Error('injected fault (test/lib/fault-for-files.cjs)'); };
