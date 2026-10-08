'use strict';
// Module-load hooks shared by all adapters.
//
// An adapter is { name, onCjsLoad?(exports, request, resolve), esmEntries?, esmPackages?, esmWrap?(id, name, fn) }.
// - onCjsLoad is called for every CommonJS module that gets loaded and patches the bundler when it recognizes it.
//   resolve() returns the module's resolved filename; it is lazy because resolving every require() would slow down
//   large builds.
// - esmEntries ({ id, suffixes, wrap }, see esm-wrap.cjs) are ESM modules replaced by a wrapper whose functions in
//   `wrap` go through esmWrap(id, name, fn), which returns the function to use instead. esmPackages: npm packages
//   whose use makes a process a bundler process (see esmMode).
const Module = require('module');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const wt = require('worker_threads');
const config = require('./core/config.cjs');
const esmWrap = require('./esm-wrap.cjs');

const INSTALLED = Symbol.for('bundle-lockfile.hooks-installed');
const ESM = Symbol.for('bundle-lockfile.esm');
const adapters = [];

function register(adapter) { adapters.push(adapter); }

function install() {
  // another copy of bundle-lockfile at a different path can be preloaded too (the same path loads once: require caches it)
  if (globalThis[INSTALLED]) return;
  globalThis[INSTALLED] = true;
  if (adapters.some(a => a.onCjsLoad)) installCjs();
  const entries = adapters.flatMap(a => a.esmEntries || []);
  if (entries.length) installEsm(entries);
}

function installCjs() {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const exp = origLoad.apply(this, arguments);
    let resolved;
    const resolve = () => {
      if (resolved === undefined) { try { resolved = Module._resolveFilename(request, parent); } catch { resolved = request; } }
      return resolved;
    };
    for (const a of adapters) {
      if (!a.onCjsLoad) continue;
      try { a.onCjsLoad(exp, request, resolve); } catch (e) { config.warn(`${a.name} adapter failed while inspecting ${request}:`, e); }
    }
    return exp;
  };
}

// module.registerHooks (in-thread, synchronous) together with any loader-thread hook (Yarn PnP's .pnp.loader.mjs,
// tsx, ...) crashes the process ("this[#customizations].loadSync is not a function") before Node 24.12 / 25.2
// (nodejs/node#60380; not in 22.x). Removing our hooks again does not help (verified on 22.23). So it is used only
// from those versions on.
function syncHooksSafe(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return major >= 26 || (major === 25 && minor >= 2) || (major === 24 && minor >= 12);
}

// The process runs a bundler (or a tool built on one): the package of its main script is one of `packages` or
// depends on one (e.g. node_modules/vite/bin/vite.js, a build script of a project using vite, headlamp-plugin).
// Loader-thread hooks cost a thread per process and can conflict with other tools' in-thread hooks, so on Node
// versions that need them they are installed only there.
function bundlerProcess(packages, main = process.argv[1]) {
  if (!main) return false;
  let dir;
  try { dir = path.dirname(fs.realpathSync(main)); } catch { return false; }
  for (;;) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      let j;
      try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { j = {}; }
      if (j && (j.name || j.dependencies || j.devDependencies)) {
        const deps = Object.assign({}, j.dependencies, j.devDependencies, j.optionalDependencies, j.peerDependencies);
        return packages.includes(j.name) || packages.some(p => Object.prototype.hasOwnProperty.call(deps, p));
      }
    }
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

// sync | async | off, see syncHooksSafe and bundlerProcess. BUNDLE_LOCKFILE_ESM_HOOKS=sync|async|off forces one
// (async: also outside bundler processes, e.g. for a programmatic build in a project without a dependency on one).
function esmMode(packages) {
  if (wt.isInternalThread) return 'off'; // Node's own loader thread, which runs --require preloads too (Node >= 22.14)
  const forced = (process.env.BUNDLE_LOCKFILE_ESM_HOOKS || 'auto').trim().toLowerCase();
  const sync = typeof Module.registerHooks === 'function', async = typeof Module.register === 'function';
  if (forced === 'off') return 'off';
  if (forced === 'sync') return sync ? 'sync' : 'off';
  // Node 20 has no isInternalThread: its loader thread is not the main thread (nor are user workers, which get none)
  if (forced === 'async') return async && wt.isMainThread ? 'async' : 'off';
  if (sync && syncHooksSafe(process.versions.node)) return 'sync';
  if (async && wt.isMainThread && bundlerProcess(packages)) return 'async';
  return 'off';
}

function installEsm(entries) {
  if (globalThis[ESM]) return;
  globalThis[ESM] = {
    wrap(id, name, fn) {
      for (const a of adapters) {
        if (!a.esmWrap) continue;
        try { const w = a.esmWrap(id, name, fn); if (w) return w; } catch (e) { config.warn(`${a.name} adapter failed to wrap ${id} ${name}:`, e); }
      }
      return fn;
    },
  };
  const mode = esmMode([...new Set(adapters.flatMap(a => a.esmPackages || []))]);
  config.debug('ESM hooks:', mode, `(Node ${process.versions.node})`);
  try {
    if (mode === 'sync') {
      Module.registerHooks({
        load(url, context, nextLoad) {
          const entry = esmWrap.match(url, entries);
          if (!entry) return nextLoad(url, context);
          const result = nextLoad(url, context);
          try {
            const src = esmWrap.source(url, String(result.source == null ? '' : Buffer.from(result.source)), entry);
            return src ? { format: 'module', source: src, shortCircuit: true } : result;
          } catch (e) { config.warn('could not wrap', url, e); return result; }
        },
      });
    } else if (mode === 'async') {
      Module.register(pathToFileURL(path.join(__dirname, 'esm-loader.mjs')).href, { parentURL: pathToFileURL(__filename).href, data: { entries } });
    }
  } catch (e) { config.warn('could not install the ESM hooks:', e); }
}

module.exports = { register, install, syncHooksSafe, bundlerProcess, esmMode };
