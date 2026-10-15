'use strict';
// Builds bundle-lockfile recognizes but does not hook: they would ship without a lockfile, so each is a problem (in
// strict mode the build fails, see core/problems.cjs; BUNDLE_LOCKFILE_STRICT=0: a warning), rather than no lockfile
// and no failure:
// - the rolldown command line, which imports Rolldown's internal chunk, not the entry module the ESM hooks wrap: known
//   from the process's main script
// - Next.js builds with Turbopack (next build's default from Next.js 16, --turbopack before): known when the process
//   ends - Next sets TURBOPACK when it builds with Turbopack (next/dist/lib/bundler.js), NEXT_RSPACK with next-rspack
// - @vercel/ncc, which runs a webpack of its own from a vm script, which no module hook sees: when it loads
// webpack before 4 and rspack 0.x are reported by their adapters, when a compiler of theirs compiles. Each follows
// BUNDLE_LOCKFILE_DISABLE as the adapter of what it stands in for: the rolldown command line `rolldown`, Turbopack and ncc
// `webpack` (the bundler of Next.js, and ncc's) - a disabled bundler is not expected to write a lockfile.
/** @import { Adapter } from '../types' */
const fs = require('fs');
const config = require('./config.cjs');
const problems = require('./problems.cjs');
const { logical } = require('./layout.cjs');

const ROLLDOWN_CLI = /[\\/]rolldown[\\/]bin[\\/]cli\.mjs$/;
const NEXT_BIN = /[\\/]next[\\/]dist[\\/]bin[\\/]next$/;
const NCC = /[\\/]@vercel[\\/]ncc[\\/]dist[\\/]ncc[\\/](?:cli|index)\.js$/;

const real = (/** @type {string} */ f) => { try { return fs.realpathSync(f); } catch { return f; } };
// The process's main script by its real path, a package in Yarn's store as node_modules/<name> (core/layout.cjs)
/** @param {string[]} argv */
const mainOf = (argv) => (argv[1] ? logical(real(argv[1])) : '');
// The process is `next build` (argv: process.argv)
/** @param {string[]} [argv] */
const isNextBuild = (argv = process.argv) => NEXT_BIN.test(mainOf(argv)) && argv[2] === 'build';

// At preload, in the main thread: what the process's main script tells (argv: process.argv)
/** @param {string[]} [argv] */
function check(argv = process.argv) {
  if (ROLLDOWN_CLI.test(mainOf(argv)) && !config.isDisabled('rolldown')) {
    problems.problem("the rolldown command line is not hooked: its builds write no lockfile (build with Rolldown's JavaScript API, or with Vite)");
  }
  if (isNextBuild(argv) && !config.isDisabled('webpack')) {
    problems.atExit(() => {
      if (process.env.TURBOPACK && !process.env.NEXT_RSPACK) {
        problems.problem('Next.js built with Turbopack, which bundle-lockfile does not hook: no lockfile (build with next build --webpack, or with next-rspack)');
      }
    });
  }
}

let ncc = false;
// The CommonJS hook's part (hooks.cjs; a failure in strict mode fails the module's require())
/** @type {Adapter} */
const adapter = {
  name: 'unsupported',
  onCjsLoad(exp, request) {
    if (NCC.test(request) && !config.isDisabled('webpack')) {
      if (ncc) return;
      ncc = true;
      problems.problem('@vercel/ncc builds with a webpack of its own, which bundle-lockfile cannot hook: its builds write no lockfile');
    }
  },
};

module.exports = { check, adapter, isNextBuild };
