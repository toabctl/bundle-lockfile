'use strict';
// Prints every lockfile below <dir> (cwd-relative) with its name@version list, one per line, in a stable order: for
// comparing the packages of two builds whose output file names differ (e.g. Next.js' build id).
// usage: node locks.cjs <dir>
const path = require('path');
const { readLockfiles } = require('./check.cjs');

const dir = path.resolve(process.argv[2] || '.');
const locks = readLockfiles(dir);
for (const k of Object.keys(locks).sort()) console.log(`${k || '.'}: ${locks[k].join(' ')}`);
