'use strict';
// Builds bundle-lockfile recognizes but does not hook: they would ship without a lockfile, so each is a problem (in
// strict mode the build fails, see core/problems.cjs; BUNDLE_LOCKFILE_STRICT=0: a warning), rather than no lockfile
// and no failure:
// - the rolldown command line, which imports Rolldown's internal chunk, not the entry module the ESM hooks wrap: known
//   from the process's main script
// - Next.js builds with Turbopack (next build's default from Next.js 16, --turbopack before): known when the process
//   ends - Next sets TURBOPACK when it builds with Turbopack (next/dist/lib/bundler.js), NEXT_RSPACK with next-rspack
// - @vercel/ncc, which runs a webpack of its own from a vm script, which no module hook sees: when it loads
// - Parcel 2: when Parcel.prototype.run() builds (watch() and parcel serve are for development)
// webpack before 4 and rspack 0.x are reported by their adapters, when a compiler of theirs compiles.
const fs = require('fs');
const config = require('./config.cjs');
const problems = require('./problems.cjs');

const ROLLDOWN_CLI = /[\\/]rolldown[\\/]bin[\\/]cli\.mjs$/;
const NEXT_BIN = /[\\/]next[\\/]dist[\\/]bin[\\/]next$/;
const NCC = /[\\/]@vercel[\\/]ncc[\\/]dist[\\/]ncc[\\/](?:cli|index)\.js$/;
const PARCEL = /[\\/]@parcel[\\/]core[\\/]lib[\\/]Parcel\.js$/;
const PATCHED = Symbol.for('bundle-lockfile.parcel.patched');

const real = (f) => { try { return fs.realpathSync(f); } catch { return f; } };

// At preload, in the main thread: what the process's main script tells (argv: process.argv)
function check(argv = process.argv) {
  const main = argv[1] ? real(argv[1]) : '';
  if (ROLLDOWN_CLI.test(main) && !config.isDisabled('rolldown')) {
    problems.problem("the rolldown command line is not hooked: its builds write no lockfile (build with Rolldown's JavaScript API, or with Vite)");
  }
  if (NEXT_BIN.test(main) && argv[2] === 'build') {
    problems.atExit(() => {
      if (process.env.TURBOPACK && !process.env.NEXT_RSPACK) {
        problems.problem('Next.js built with Turbopack, which bundle-lockfile does not hook: no lockfile (build with next build --webpack, or with next-rspack)');
      }
    });
  }
}

let ncc = false;
// The CommonJS hook's part (hooks.cjs; a failure in strict mode fails the module's require())
const adapter = {
  name: 'unsupported',
  onCjsLoad(exp, request) {
    if (NCC.test(request)) {
      if (ncc) return;
      ncc = true;
      problems.problem('@vercel/ncc builds with a webpack of its own, which bundle-lockfile cannot hook: its builds write no lockfile');
    } else if (PARCEL.test(request)) {
      const P = exp && exp.default;
      if (typeof P !== 'function' || !P.prototype || typeof P.prototype.run !== 'function' || P.prototype[PATCHED]) return;
      P.prototype[PATCHED] = true;
      const run = P.prototype.run;
      P.prototype.run = function (...args) {
        const before = problems.count();
        problems.problem('Parcel is not hooked: its builds write no lockfile');
        if (config.strict && problems.count() > before) return Promise.reject(problems.failure(problems.take(before)));
        return run.apply(this, args);
      };
    }
  },
};

module.exports = { check, adapter };
