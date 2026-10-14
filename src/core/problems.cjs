'use strict';
// What makes a lockfile missing or incomplete: it cannot be written, packages could not be collected, a bundler could
// not be hooked, a bundled package cannot be named. By default (BUNDLE_LOCKFILE_STRICT unset) such a problem fails the
// build it belongs to - an SBOM that silently misses packages is worse than a failed build. With
// BUNDLE_LOCKFILE_STRICT=0 it is a warning and the build goes on.
//
// problem() records it; the adapter whose build it concerns takes the recorded problems at the end of its hooks and
// fails the build with failure() (a compilation error, an error from a Rollup hook). Problems are taken process-wide,
// not per build: one compiler may fail with a problem another one recorded - a build fails either way. Problems that no
// build takes (a hook that failed outside any build) make the process exit with code 1.
const config = require('./config.cjs');

const KEY = Symbol.for('bundle-lockfile.problems.v1');
/** @typedef {{ pending: string[], warned: Set<unknown>, atExit: boolean, checks?: (() => void)[] }} State */
/** @type {State} */
const state = /** @type {any} */ (globalThis)[KEY] || (/** @type {any} */ (globalThis)[KEY] = { pending: [], warned: new Set(), atExit: false });
const HINT = 'BUNDLE_LOCKFILE_STRICT=0 makes this a warning';

/** @type {(what: string, cause: unknown) => string} */
const text = (what, cause) => (cause == null ? what : `${what}: ${cause instanceof Error ? cause.message : cause}`);

// Records a problem: what (a sentence naming the output or file it is about), cause (an Error or text, optional).
// opts.once: a key - without strict mode the warning is printed once per process for it (e.g. a package directory, on
// every watch rebuild); with strict mode every build fails.
/**
 * @param {string} what
 * @param {unknown} [cause]
 * @param {{ once?: unknown }} [opts]
 */
function problem(what, cause, opts = {}) {
  if (!config.strict) {
    if (opts.once !== undefined) {
      if (state.warned.has(opts.once)) return;
      state.warned.add(opts.once);
    }
    if (cause == null) config.warn(what); else config.warn(`${what}:`, cause);
    return;
  }
  state.pending.push(text(what, cause));
  if (cause instanceof Error) config.debug(what, cause);
  onExit();
}

// Problems no build took make the process exit with code 1; checks that can only be made when the process ends
// (core/unsupported.cjs) run first, and may record more.
function onExit() {
  if (state.atExit) return;
  state.atExit = true;
  process.on('exit', () => {
    for (const fn of state.checks || []) {
      try { fn(); } catch (e) { config.debug('a check at exit failed:', e); }
    }
    const left = take();
    if (!left.length) return;
    for (const t of left) config.error(t);
    config.error(`the process fails because a lockfile would be missing or incomplete (${HINT})`);
    if (!process.exitCode) process.exitCode = 1;
  });
}
/** @param {() => void} fn */
function atExit(fn) {
  (state.checks || (state.checks = [])).push(fn);
  onExit();
}

// The recorded problems, removed (so that each fails one build); from: only those recorded after the first `from`
// (see count).
/**
 * @param {number} [from]
 * @returns {string[]}
 */
function take(from = 0) { return state.pending.splice(from); }
// How many problems are pending: take(count()) later takes those recorded in between.
const count = () => state.pending.length;

const pending = () => state.pending.length > 0;

// The error a build fails with: every problem taken, and how to only warn. Its stack is only its first line: the
// problems say where. With the newline: the rollup command line strips exactly "<name>: <message>\n" off a stack it
// prints (without it, the message would be printed twice), Vite 5-7 print the stack only (an empty one shows nothing).
/**
 * @param {string[]} list
 * @returns {Error & { problems: string[] }}
 */
function failure(list) {
  const msg = `bundle-lockfile: the lockfile would be missing or incomplete (${HINT}):\n${list.map(t => `  ${t}`).join('\n')}`;
  const err = Object.assign(new Error(msg), { problems: list }); // problems: marks it as bundle-lockfile's (isFailure)
  err.stack = `Error: ${msg}\n`;
  return err;
}
/** @type {(e: any) => boolean} */
const isFailure = (e) => !!(e && Array.isArray(e.problems));

// For the end of an adapter's hook: in strict mode, if problems are pending, fail(failure) with all of them taken.
// Returns whether it did.
/**
 * @param {(err: Error & { problems: string[] }) => unknown} fail
 * @returns {boolean}
 */
function failIfAny(fail) {
  if (!config.strict || !pending()) return false;
  fail(failure(take()));
  return true;
}

module.exports = { problem, take, count, pending, failure, failIfAny, isFailure, atExit };
