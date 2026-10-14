'use strict';
// Node.js processes and worker threads this process starts with an environment of its own that drops bundle-lockfile's
// --require (NODE_OPTIONS): a bundler in them is not hooked and its builds write no lockfile. Child processes and
// workers inherit NODE_OPTIONS from the environment they get (a worker reads it from its env option; its execArgv does
// not matter); a caller that passes an env without it (env: { PATH }) leaves them out. A warning, once per process -
// and with the node shim (BUNDLE_LOCKFILE_NODE_SHIM: the build asked for the preload to reach every node), the
// --require is put back, as the shim does for a NODE_OPTIONS a script overwrote.
// Only a node started directly: by process.execPath, a `node` command, fork(); a child that is a shell, npm or another
// program gets the environment it was given, and the node it starts the node shim's help (PATH) or none.
// `next build` (Next.js 15.0 - 16.3) rewrites NODE_OPTIONS for its build workers and keeps only the last of several
// `--require=` (vercel/next.js#96582): the --require is put back there too - those workers build.
const fs = require('fs');
const path = require('path');
const config = require('./config.cjs');

const S = Symbol.for('bundle-lockfile.children.v1');
const own = path.join(__dirname, '..', 'register.cjs');
const real = (f) => { try { return fs.realpathSync(f); } catch { return f; } };

// The words of NODE_OPTIONS that name this preload's register.cjs (also through a symbolic link)
function ours(opts) {
  return String(opts || '').split(/\s+/).map(w => w.replace(/^--require=/, '').replace(/^["']|["']$/g, ''))
    .filter(w => w.endsWith('register.cjs') && real(w) === real(own));
}
// The --require of this preload as this process's NODE_OPTIONS holds it, or null when this process did not get it from
// NODE_OPTIONS (a --require on the command line reaches no child anyway). (Paths with spaces: in quotes, not split.)
let mine;
const ourRequire = () => (mine === undefined ? (mine = ours(process.env.NODE_OPTIONS)[0] || (String(process.env.NODE_OPTIONS || '').includes(own) ? own : null)) : mine);
const isNode = (cmd) => typeof cmd === 'string' && (cmd === process.execPath || /^node(\.exe)?$/i.test(path.basename(cmd)));
const quoted = (f) => (/\s/.test(f) ? `"${f}"` : f);

let isNext;
const nextBuild = () => (isNext === undefined
  ? (isNext = /[\\/]next[\\/]dist[\\/]bin[\\/]next$/.test(real(process.argv[1] || '')) && process.argv[2] === 'build') : isNext);

// env (an options.env) as the child gets it: unchanged, or with our --require put back (shim mode). what: for the
// warning.
function checked(env, what) {
  if (!env || typeof env !== 'object' || !ourRequire()) return env;
  if (String(env.NODE_OPTIONS || '').includes(ourRequire()) || ours(env.NODE_OPTIONS).length) return env;
  if (process.env.BUNDLE_LOCKFILE_NODE_SHIM || nextBuild()) {
    config.debug('the --require put back for', what);
    return { ...env, NODE_OPTIONS: `--require ${quoted(ourRequire())}${env.NODE_OPTIONS ? ` ${env.NODE_OPTIONS}` : ''}` };
  }
  config.debug('without bundle-lockfile:', what);
  if (!globalThis[S].warned) {
    globalThis[S].warned = true;
    config.warn(`${what} is started with an environment whose NODE_OPTIONS lacks bundle-lockfile's --require: a bundler in it is not hooked, its builds write no lockfile (with the node shim in PATH, the --require is put back)`);
  }
  return env;
}

// options is the argument at index i of args (or absent): a copy of args with its env checked
function withEnv(args, i, what) {
  const opts = args[i];
  if (!opts || typeof opts !== 'object' || Array.isArray(opts) || !('env' in opts)) return args;
  const env = checked(opts.env, what);
  if (env === opts.env) return args;
  const out = [...args];
  out[i] = { ...opts, env };
  return out;
}

// wrapper with the own properties of orig (util.promisify.custom of execFile and exec: promisify(execFile) resolves to
// { stdout, stderr })
function like(wrapper, orig) {
  for (const k of Reflect.ownKeys(orig)) {
    if (k === 'length' || k === 'name' || k === 'prototype') continue;
    try { Object.defineProperty(wrapper, k, Object.getOwnPropertyDescriptor(orig, k)); } catch { /* not configurable */ }
  }
  Object.defineProperty(wrapper, 'name', { value: orig.name });
  return wrapper;
}

function install() {
  if (globalThis[S]) return;
  globalThis[S] = { warned: false };
  const cp = require('child_process');
  // spawn(cmd, [args], [options]), execFile(cmd, [args], [options], [cb]) and their sync versions; fork(module, [args],
  // [options]) always starts a node (options.execPath: another one); exec(command, [options], [cb]) runs a shell
  const optionsAt = (args) => (Array.isArray(args[1]) ? 2 : 1);
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const orig = cp[name];
    if (typeof orig !== 'function') continue;
    cp[name] = like(function (cmd, ...rest) {
      const args = [cmd, ...rest];
      return orig.apply(this, isNode(cmd) ? withEnv(args, optionsAt(args), `node (${name} ${[].concat(rest[0] || []).slice(0, 1).join(' ') || cmd})`) : args);
    }, orig);
  }
  if (typeof cp.fork === 'function') {
    const fork = cp.fork;
    cp.fork = like(function (...args) { return fork.apply(this, withEnv(args, optionsAt(args), `node (fork ${args[0]})`)); }, fork);
  }
  for (const name of ['exec', 'execSync']) {
    const orig = cp[name];
    if (typeof orig !== 'function') continue;
    cp[name] = like(function (command, ...rest) {
      const first = typeof command === 'string' ? command.trim().split(/\s+/)[0].replace(/^["']|["']$/g, '') : '';
      return orig.apply(this, isNode(first) ? withEnv([command, ...rest], 1, `node (${name} ${command.slice(0, 80)})`) : [command, ...rest]);
    }, orig);
  }
  const wt = require('worker_threads');
  const Worker = wt.Worker;
  if (typeof Worker === 'function') {
    const Checked = class extends Worker {
      constructor(file, options) {
        // (SHARE_ENV: the worker shares this process's environment)
        const opts = options && typeof options === 'object' && options.env && options.env !== wt.SHARE_ENV
          ? { ...options, env: checked(options.env, `a worker thread (${file})`) } : options;
        super(file, opts);
      }
    };
    Object.defineProperty(Checked, 'name', { value: 'Worker' });
    wt.Worker = Checked;
  }
}

module.exports = { install, checked, isNode };
