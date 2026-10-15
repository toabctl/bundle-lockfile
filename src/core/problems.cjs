'use strict';
// What makes a lockfile missing or incomplete: it cannot be written, packages could not be collected, a bundler could
// not be hooked, a bundled package cannot be named. By default (BUNDLE_LOCKFILE_STRICT unset) such a problem fails the
// build it belongs to - an SBOM that silently misses packages is worse than a failed build. With
// BUNDLE_LOCKFILE_STRICT=0 it is a warning and the build goes on.
//
// problem() records it; the adapter whose build it concerns takes the recorded problems at the end of its hooks and
// fails the build with failure() (a compilation error, an error from a Rollup hook). A problem belongs to the build
// whose code recorded it: adapters run their hooks within(owner) - the compiler, the Rollup or esbuild plugin of a
// build, which stays the same across watch rebuilds -, and that context reaches what the hook starts asynchronously
// (AsyncLocalStorage). failIfAny() in a hook takes the problems of its own build and those of none (a module that failed
// to load, an fs copy outside any build): two compilers of one process never fail with each other's problems. Problems
// that no build takes make the process exit with code 1.
const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config.cjs');

const KEY = Symbol.for('bundle-lockfile.problems.v2'); // v2: pending problems with their owners
/**
 * @typedef {{ pending: { text: string, owner: object | undefined }[], warned: Set<unknown>, atExit: boolean,
 *   checks?: (() => void)[], scope: AsyncLocalStorage<object> }} State
 */
/** @type {State} */
const state = /** @type {any} */ (globalThis)[KEY]
  || (/** @type {any} */ (globalThis)[KEY] = { pending: [], warned: new Set(), atExit: false, scope: new AsyncLocalStorage() });

// Runs fn(...) as part of the build `owner` (any object that stands for it): the problems recorded meanwhile, and in
// what fn starts asynchronously, are that build's (see failIfAny).
/**
 * @template T
 * @param {object} owner
 * @param {() => T} fn
 * @returns {T}
 */
const within = (owner, fn) => state.scope.run(owner, fn);
// The build the code that runs now belongs to (see within), or undefined
const current = () => state.scope.getStore();
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
  state.pending.push({ text: text(what, cause), owner: current() });
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

// The recorded problems, removed (so that each fails one build), of any build; from: only those recorded after the
// first `from` (see count).
/**
 * @param {number} [from]
 * @returns {string[]}
 */
function take(from = 0) { return state.pending.splice(from).map(p => p.text); }
// How many problems are pending: take(count()) later takes those recorded in between.
const count = () => state.pending.length;
// Whether any are pending (of any build)
const pending = () => state.pending.length > 0;

// The problems of the build `owner` and of none, removed; owner undefined (code outside any build's hooks): all of them.
/**
 * @param {object | undefined} owner
 * @returns {string[]}
 */
function takeFor(owner) {
  if (owner === undefined) return take();
  /** @type {State['pending']} */
  const mine = [];
  /** @type {State['pending']} */
  const others = [];
  for (const p of state.pending) (p.owner === undefined || p.owner === owner ? mine : others).push(p);
  state.pending = others;
  return mine.map(p => p.text);
}

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

// The problems of exactly the build `owner`, removed (see within)
/**
 * @param {object} owner
 * @returns {string[]}
 */
function takeOwn(owner) {
  const mine = state.pending.filter(p => p.owner === owner);
  if (mine.length) state.pending = state.pending.filter(p => p.owner !== owner);
  return mine.map(p => p.text);
}

// Runs fn outside of any build (see within): what continues a bundler's own work - a callback that resumes the
// compiler - must not count as part of the hook that calls it.
/**
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
const outside = (fn) => state.scope.exit(fn);

// For the end of an adapter's hook: in strict mode, if the build the hook runs for (see within) or none has problems
// pending, fail(failure) with them taken. Returns whether it did.
/**
 * @param {(err: Error & { problems: string[] }) => unknown} fail
 * @returns {boolean}
 */
function failIfAny(fail) {
  if (!config.strict || !state.pending.length) return false;
  const mine = takeFor(current());
  if (!mine.length) return false;
  fail(failure(mine));
  return true;
}

// Problems a build failed with that its bundler only printed (Parcel before 2.13 goes on after a reporter's error): kept
// for the exit, which fails the process with them - no build takes them (their owner is none of the builds').
const AT_EXIT = Object.freeze({});
/** @param {string[]} list */
function failAtExit(list) {
  for (const text of list) state.pending.push({ text, owner: AT_EXIT });
  if (list.length) onExit();
}

module.exports = { problem, take, takeOwn, count, pending, failure, failIfAny, failAtExit, isFailure, atExit, within, outside, current };
