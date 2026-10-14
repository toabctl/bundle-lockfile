'use strict';
// The bundler package whose code is in an output. Every bundle has code the bundler writes itself, not a package's
// file: webpack's and rspack's runtime and chunk wrappers, Rollup's and Rolldown's format wrappers and helpers (also
// their import.meta.url code), Vite's preload helper and asset URLs. Advisories about that code name the bundler's
// package (webpack's AutoPublicPathRuntimeModule, CVE-2024-43788; Rollup's document.currentScript code, CVE-2024-47068;
// Vite's, CVE-2024-45812): the lockfile lists it, at the copy that ran - the file the adapter patched or wrapped, or
// for Vite the caller of rollup()/rolldown() (see viteOf).
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const config = require('./config.cjs');
const problems = require('./problems.cjs');
const { readManifest } = require('./manifest.cjs');
const { ancestors, unvirtual } = require('./paths.cjs');

const real = (p) => { try { return unvirtual(fs.realpathSync(p)); } catch { return unvirtual(p); } };
const fileOf = (f) => (typeof f === 'string' && f.startsWith('file:') ? fileURLToPath(f.split('?')[0]) : f);
// "license": "MIT", the legacy {"type": "MIT"} (see core/manifest.cjs)
const licenseOf = (j) => (typeof j.license === 'string' ? j.license : j.license && typeof j.license.type === 'string' ? j.license.type : undefined);

// The package of one of `names` that `file` (a path or file: URL) belongs to: the innermost directory around it whose
// package.json has one of the names - its package root (node_modules/webpack for lib/Compiler.js), or a copy inside
// another package (next/dist/compiled/webpack, whose package.json is {"name": "webpack"} without a version). Its version
// is that package.json's; only a copy without one gets `version` (the bundler's own, e.g. compiler.webpack.version) -
// strings in a bundler's code can be stale. Neither: a problem (the lockfile would miss the bundler; in strict mode on
// every build), and null. { name, version, license, path } as core/packages.cjs's, cached per file.
const cache = new Map();
const paths = new Set(); // of the bundler packages found (isBundlerPath)
// The package at that path is a bundler, as found here (core/generated.cjs: a generate-only chunk of nothing but the
// bundler's code is no package that went missing)
const isBundlerPath = (p) => paths.has(p);
function bundlerPackage(kind, file, names, version) {
  const f = fileOf(file);
  const key = `${f}\0${names.join(',')}\0${version || ''}`;
  if (cache.has(key)) return cache.get(key);
  let found = null;
  if (typeof f === 'string' && path.isAbsolute(f)) {
    for (const d of ancestors(path.dirname(real(f)))) {
      const j = readManifest(d);
      if (j && typeof j.name === 'string' && names.includes(j.name)) { found = { dir: d, j }; break; }
    }
  }
  let p = null;
  if (!found) {
    problems.problem(`${kind}: no package.json of ${names.join(' or ')} around ${f || '(unknown file)'}: the lockfile would miss the bundler, whose code is in the output`, null, { once: key });
  } else {
    const own = typeof found.j.version === 'string' && found.j.version ? found.j.version : null;
    const v = own || (typeof version === 'string' && version ? version : null);
    if (!v) problems.problem(`${kind}: ${found.dir} (${found.j.name}) has no version, nor does the bundler say it: the lockfile would miss the bundler, whose code is in the output`, null, { once: key });
    else {
      if (own && version && own !== version) config.debug(`${kind}: ${found.dir} is ${found.j.name}@${own}, its code says ${version}`);
      p = { name: found.j.name, version: v, path: found.dir, license: licenseOf(found.j) };
      paths.add(p.path);
      config.debug(`${kind}: bundler package ${p.name}@${p.version} (from ${f})`);
    }
  }
  if (p) cache.set(key, p);
  return p;
}

// The first file outside bundle-lockfile (src/) on the stack of the caller, as Node.js gives it (CallSites, not the
// text of error.stack, which tools such as source-map-support rewrite). The tool may have set Error.stackTraceLimit
// to 0 (or a few): set for the call, as is prepareStackTrace.
const SRC = path.resolve(__dirname, '..');
function callerFiles() {
  const limit = Error.stackTraceLimit, prepare = Error.prepareStackTrace;
  try {
    Error.stackTraceLimit = 100;
    Error.prepareStackTrace = (_, sites) => sites;
    const holder = {};
    Error.captureStackTrace(holder, callerFiles);
    const sites = holder.stack;
    if (!Array.isArray(sites)) return [];
    const out = [];
    for (const s of sites) {
      const f = fileOf(typeof s.getFileName === 'function' ? s.getFileName() : null);
      if (typeof f !== 'string' || !path.isAbsolute(f) || f.startsWith(SRC + path.sep)) continue;
      out.push(f);
    }
    return out;
  } catch { return []; } finally {
    Error.stackTraceLimit = limit;
    Error.prepareStackTrace = prepare;
  }
}

// The package.json of the package named one of `names` that a file of the caller's stack is in (`files`, see
// callerFiles), the innermost package around each file: Vite calls rollup()/rolldown() from its own code
// (dist/node/chunks/*), also when SvelteKit or another tool calls Vite; webpack applies the plugins of a config, Rollup
// and Rolldown run the hooks of the plugins of theirs. null if none.
function packageOnStack(names, files = callerFiles()) {
  for (const f of files) {
    for (const d of ancestors(path.dirname(real(f)))) {
      const j = readManifest(d);
      if (!j || typeof j.name !== 'string') continue;
      if (names.includes(j.name)) return path.join(d, 'package.json');
      if (typeof j.version === 'string') break; // another package's file
    }
  }
  return null;
}
const VITE_NAMES = ['vite', 'rolldown-vite'];
const viteOf = (files) => packageOnStack(VITE_NAMES, files);

module.exports = { bundlerPackage, isBundlerPath, callerFiles, packageOnStack, viteOf, VITE_NAMES };
