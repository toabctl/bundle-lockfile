'use strict';
// Module-load hooks shared by all adapters.
//
// An adapter is { name, onCjsLoad(exports, request, resolve) }: it is called for every CommonJS module
// that gets loaded and patches the bundler when it recognizes it. resolve() returns the module's resolved
// filename; it is lazy because resolving every require() would slow down large builds.
//
// ESM-only bundlers (e.g. rspack >= 2) are not visible to Module._load; they need module.registerHooks
// (Node >= 22.15 / 23.5), which will be added here together with the first adapter that uses it.
const Module = require('module');
const config = require('./core/config.cjs');

const INSTALLED = Symbol.for('bundle-lockfile.hooks-installed');
const adapters = [];

function register(adapter) { adapters.push(adapter); }

function install() {
  // another copy of bundle-lockfile at a different path can be preloaded too (the same path loads once: require caches it)
  if (globalThis[INSTALLED]) return;
  globalThis[INSTALLED] = true;

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const exp = origLoad.apply(this, arguments);
    let resolved;
    const resolve = () => {
      if (resolved === undefined) { try { resolved = Module._resolveFilename(request, parent); } catch { resolved = request; } }
      return resolved;
    };
    for (const a of adapters) {
      try { a.onCjsLoad(exp, request, resolve); } catch (e) { config.warn(`${a.name} adapter failed while inspecting ${request}:`, e); }
    }
    return exp;
  };
}

module.exports = { register, install };
