'use strict';
// Module-load hooks shared by all adapters.
//
// An adapter is { name, onCjsLoad?(exports, request, resolve), cjsFiles?, esmEntries?, esmPackages?, esmWrap?(id, name, fn) }.
// - onCjsLoad(exports, request, resolve) is called for every CommonJS module once it has run (and an ES module that
//   require() loads), and patches the bundler when it recognizes it. request is the module's file name as adapters
//   recognize bundler files by (see core/layout.cjs logical: a package in Yarn's store as node_modules/<name>), resolve()
//   its real file name. cjsFiles (RegExps of file paths): the modules onCjsLoad patches, which the ESM hooks report also
//   when Node loads them without the CommonJS hook (see esm-wrap.cjs cjsSource).
// - esmEntries ({ id, suffixes, wrap }, see esm-wrap.cjs) are ESM modules replaced by a wrapper whose functions in
//   `wrap` go through esmWrap(id, name, fn), which returns the function to use instead. esmPackages: npm packages
//   whose use makes a process a bundler process (see esmMode).
// A bundler module an adapter recognizes but cannot patch (it fails, or the bundler is of a shape it does not know) would
// build without a lockfile: in strict mode loading it fails, with the reason (as the loader thread does, see
// esm-loader.mjs) - in whatever process or thread it is loaded, also one whose exit code nobody reads.
const Module = require('module');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const wt = require('worker_threads');
const config = require('./core/config.cjs');
const problems = require('./core/problems.cjs');
const esmWrap = require('./esm-wrap.cjs');
const { ancestors } = require('./core/paths.cjs');
const { logical } = require('./core/layout.cjs');

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
  const cjsFiles = adapters.flatMap(a => (a.onCjsLoad && a.cjsFiles) || []);
  if (entries.length || cjsFiles.length) installEsm(entries, cjsFiles);
}

// In strict mode, the problems recorded since `before` (problems.count()) fail what is being loaded: thrown.
function failLoad(before) {
  if (config.strict && problems.count() > before) throw problems.failure(problems.take(before));
}

const failedOn = new Set(); // adapters whose inspection failed: warned once per process
function onCjsLoad(exp, filename) {
  const request = logical(filename), resolve = () => filename;
  for (const a of adapters) {
    if (!a.onCjsLoad) continue;
    const before = problems.count();
    try { a.onCjsLoad(exp, request, resolve); } catch (e) {
      // recognizing a module only reads it: a failure there is no bundler the adapter could not patch
      if (!failedOn.has(a.name)) { failedOn.add(a.name); config.warn(`${a.name} adapter failed while inspecting ${filename}:`, e); }
    }
    failLoad(before);
  }
}

// Every CommonJS module once it has run: Module.prototype._compile, which runs a module's code - also the code another
// loader hands it (tsx's handler for .js files reads and compiles the file itself, without the handler before it) - and
// the handlers of Module._extensions (.js, .cjs), which load a module's file - also an ES module that require() loads
// (require(esm): module.exports is its namespace, or its "module.exports" export), which runs no _compile. Each module
// once. Not Module._load: a wrapper of it is on the stack between a module and the built-in module it requires, and Node
// decides whether to warn about some deprecated ones (punycode, DEP0040) by the caller, the first frame of the stack that
// is not its own, looking at 10 frames: one more frame put a package's caller out of reach, and its require('punycode')
// warned - which fails builds that exit on any warning (OpenSearch Dashboards', Kibana's). _compile and the handlers of
// the module being loaded are below that module's code on the stack. A module from the cache runs neither: it was seen
// when it loaded.
function installCjs() {
  const seen = new WeakSet();
  const report = (module, filename) => {
    if (!module || seen.has(module)) return;
    seen.add(module);
    onCjsLoad(module.exports, filename);
  };
  const compile = Module.prototype._compile;
  if (typeof compile === 'function') {
    Module.prototype._compile = function (content, filename) {
      const r = compile.apply(this, arguments);
      report(this, typeof filename === 'string' ? filename : this.filename);
      return r;
    };
  }
  for (const ext of ['.js', '.cjs']) {
    const handler = Module._extensions[ext];
    if (typeof handler !== 'function') continue;
    Module._extensions[ext] = function (module, filename) {
      const r = handler.apply(this, arguments);
      report(module, filename);
      return r;
    };
  }
  // a cjsFiles module Node evaluated without the CommonJS hook reports itself here once it has run (esm-wrap.cjs cjsSource)
  globalThis[Symbol.for('bundle-lockfile.cjs-loaded')] = report;
}

// module.registerHooks (in-thread, synchronous) together with any loader-thread hook (Yarn PnP's .pnp.loader.mjs,
// tsx, ...) crashes the process ("this[#customizations].loadSync is not a function") before Node 24.12 / 25.2
// (nodejs/node#60380; not in 22.x). Removing our hooks again does not help (verified on 22.23). So it is used only
// from those versions on.
function syncHooksSafe(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return major >= 26 || (major === 25 && minor >= 2) || (major === 24 && minor >= 12);
}

// The process may build with a bundler of `packages` (or a tool built on one). Loader-thread hooks cost a thread per
// process and can conflict with other tools' in-thread hooks, so on Node versions that need them they are installed only
// there:
// - the package of its main script is one of `packages` or depends on one (node_modules/vite/bin/vite.js, a build
//   script of a project using vite, headlamp-plugin);
// - or the project it runs in has one installed: one of `packages` in a node_modules directory of the working directory
//   or above (a command line that loads its bundler through another package: nuxi, storybook's builder-vite).
function bundlerProcess(packages, main = process.argv[1], cwd = process.cwd()) {
  return mainUses(packages, main) || installedAround(packages, cwd);
}
function mainUses(packages, main) {
  if (!main) return false;
  let start;
  try { start = path.dirname(fs.realpathSync(main)); } catch { return false; }
  for (const dir of ancestors(start)) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      let j;
      try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { j = {}; }
      if (j && (j.name || j.dependencies || j.devDependencies)) {
        const deps = Object.assign({}, j.dependencies, j.devDependencies, j.optionalDependencies, j.peerDependencies);
        return packages.includes(j.name) || packages.some(p => Object.prototype.hasOwnProperty.call(deps, p));
      }
    }
  }
  return false;
}
function installedAround(packages, cwd) {
  if (!cwd) return false;
  for (const dir of ancestors(cwd)) {
    if (packages.some(p => fs.existsSync(path.join(dir, 'node_modules', p, 'package.json')))) return true;
  }
  return false;
}

// sync | async | off, see syncHooksSafe and bundlerProcess. BUNDLE_LOCKFILE_ESM_HOOKS=sync|async|off forces one
// (async: also outside bundler processes, e.g. for a programmatic build in a project without a dependency on one).
function esmMode(packages) {
  if (wt.isInternalThread) return 'off'; // Node's own loader thread, which runs --require preloads too (Node >= 22.14)
  const forced = config.esmHooksOf(process.env.BUNDLE_LOCKFILE_ESM_HOOKS);
  const sync = typeof Module.registerHooks === 'function', async = typeof Module.register === 'function';
  if (forced === 'off') return 'off';
  if (forced === 'sync') return sync ? 'sync' : 'off';
  // Node 20 has no isInternalThread: its loader thread is not the main thread (nor are user workers, which get none)
  if (forced === 'async') return async && wt.isMainThread ? 'async' : 'off';
  if (sync && syncHooksSafe(process.versions.node)) return 'sync';
  if (async && wt.isMainThread && (bundlerProcess(packages) || otherLoader())) return 'async';
  return 'off';
}

// Another loader-thread hook is configured (Yarn Plug'n'Play's --experimental-loader .pnp.loader.mjs, an --import that
// registers one): it can provide the source of CommonJS modules, which Node then loads without the CommonJS hook - only the
// ESM hooks see them (esm-wrap.cjs cjsSource).
function otherLoader(argv = [process.env.NODE_OPTIONS || '', ...process.execArgv]) {
  return /(^|\s)--(?:experimental-loader|loader|import)(?:[=\s]|$)/.test(argv.join(' '));
}

function installEsm(entries, cjsFiles) {
  globalThis[ESM] = {
    wrap(id, name, fn) {
      for (const a of adapters) {
        if (!a.esmWrap) continue;
        // the entry module is the bundler's: without the wrapped function its builds write no lockfile
        const before = problems.count();
        let w = null;
        try { w = a.esmWrap(id, name, fn); } catch (e) { problems.problem(`${a.name} adapter failed to wrap ${id} ${name}`, e); }
        failLoad(before);
        if (w) return w;
      }
      return fn;
    },
    // the wrapper of an entry module (esm-wrap.cjs) found a function to wrap in it (ok), or none: a version of the
    // bundler whose entry has none of them, which its adapter does not know
    found(id, url, names, ok) {
      if (ok) return;
      const before = problems.count();
      problems.problem(`${url} exports none of ${names.join(', ')}: a version of ${id} bundle-lockfile does not know, whose builds would write no lockfile`);
      failLoad(before);
    },
  };
  const packages = [...new Set(adapters.flatMap(a => a.esmPackages || []))];
  const mode = esmMode(packages);
  config.debug('ESM hooks:', mode, `(Node ${process.versions.node})`);
  // neither hook API (Node.js 20 before 20.6): Vite, Rollup, Rolldown and rspack 2 builds would write no lockfile
  if (mode === 'off' && typeof Module.registerHooks !== 'function' && typeof Module.register !== 'function'
    && config.esmHooksOf(process.env.BUNDLE_LOCKFILE_ESM_HOOKS) !== 'off' && !wt.isInternalThread && bundlerProcess(packages)) {
    problems.problem(`Node.js ${process.versions.node} has no ESM hooks (module.register: 20.6 and later): ES-module bundlers are not hooked`);
  }
  try {
    if (mode === 'sync') {
      Module.registerHooks({
        load(url, context, nextLoad) {
          const result = nextLoad(url, context);
          try { return esmWrap.transform(url, result, entries, cjsFiles); } catch (e) {
            // an entry module that cannot be wrapped would build without bundle-lockfile's plugin: it fails when it is
            // imported, with the reason (BUNDLE_LOCKFILE_STRICT=0: a warning, and the module as it is)
            if (config.strict) return esmWrap.unwrappable(url, e);
            config.warn(`could not wrap ${url}:`, e);
            return result;
          }
        },
      });
    } else if (mode === 'async') {
      Module.register(pathToFileURL(path.join(__dirname, 'esm-loader.mjs')).href,
        { parentURL: pathToFileURL(__filename).href, data: { entries, cjsFiles, strict: config.strict } });
    }
  } catch (e) {
    // Vite, Rollup, Rolldown builds in this process would write no lockfile: a problem in a bundler process (it fails
    // at exit, core/problems.cjs); elsewhere (npm, any script) there is nothing it would miss
    if (bundlerProcess(packages)) problems.problem('could not install the ESM hooks', e);
    else config.warn('could not install the ESM hooks:', e);
  }
}

module.exports = { register, install, syncHooksSafe, bundlerProcess, otherLoader, esmMode };
