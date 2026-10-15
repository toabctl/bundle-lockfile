'use strict';
// Rollup, Rolldown and everything built on them: Vite 5-7 (rollup), Vite 8 (rolldown), Vite-based frameworks,
// programmatic rollup()/rolldown()/build() calls. Their public entry modules (ESM) are wrapped (see hooks.cjs,
// esm-wrap.cjs) so that every rollup()/rolldown()/watch()/build() call gets one more plugin, which writes
// <output dir>/<BUNDLE_LOCKFILE_FILE> for every output the build writes (which packages are in an output is
// rollup-collect.cjs's part). Rollup's CommonJS build (require('rollup'):
// workbox-build, the rollup command line, tools in CommonJS) is patched when it loads (onCjsLoad).
const fs = require('fs');
const path = require('path');
const config = require('../core/config.cjs');
const packages = require('../core/packages.cjs');
const outputs = require('../core/outputs.cjs');
const problems = require('../core/problems.cjs');
const { filesWrittenAfter } = require('../core/late.cjs');
const rolldownWatch = require('./rolldown-watch.cjs');
const { portable, inToolCache } = require('../core/paths.cjs');
const { createRequire } = require('module');
const { bundlerPackage, callerFiles, packageOnStack, viteOf, VITE_NAMES } = require('../core/bundler.cjs');
const { moduleIds, fileOf, watchFilesOf, keepGenerated, collectOutput } = require('./rollup-collect.cjs');

const NAME = 'bundle-lockfile';
// A build Vite makes has Vite's own JavaScript plugins (vite:css, vite:build-html, ..., in every version, also in its
// worker, SSR and @vitejs/plugin-legacy builds). Not the plugins Rolldown ships for Vite (builtin:vite-*): Rolldown's
// experimental ones carry those names in builds without Vite (tsdown's importGlobPlugin is builtin:vite-import-glob).
const VITE = /^vite:/;
// Vite 8's dependency pre-bundling (vite dev): a build into its cache directory, never shipped
const PRE_BUNDLE = 'vite:dep-pre-bundle';
const { STYLE } = packages;

/** @type {(plugins: unknown) => any[]} */
const flat = (plugins) => /** @type {any[]} */ ([]).concat(plugins == null ? [] : plugins).flat(Infinity).filter(p => p && typeof p === 'object' && !(typeof p.then === 'function'));
const realCwd = () => { try { return fs.realpathSync(process.cwd()); } catch { return process.cwd(); } };

// The writer of one output (see core/outputs.cjs): the same input, format, position in the build's outputs, file names
// and output file (separate builds of one input, e.g. the configs of `rollup -c`, can write their own output.file into
// one directory), without paths of this machine (see core/paths.cjs portable).
function outputWriter(kind, input, out, ordinal, cwd) {
  const rel = (v) => portable(cwd, v);
  const inputs = typeof input === 'string' ? rel(input) : Array.isArray(input) ? input.map(rel)
    : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).map(([k, v]) => [k, rel(v)])) : null;
  const file = typeof out.file === 'string' ? portable(cwd, path.resolve(cwd, out.file)) : null;
  return JSON.stringify([kind, inputs, out.format || null, ordinal, typeof out.entryFileNames === 'string' ? out.entryFileNames : null, ...(file ? [file] : [])]);
}

// { name, version } of the bundler that runs a build (core/lockfile.cjs), from the plugin context's meta: Vite's version
// where Vite gives it, Rolldown's, Rollup's
function bundlerOf(kind, meta) {
  const m = meta || {};
  const version = kind === 'vite' ? m.viteVersion : kind === 'rolldown' ? m.rolldownVersion : m.rollupVersion;
  return { name: kind, ...(typeof version === 'string' && version ? { version } : {}) };
}

// closeBundle's failure (strict mode): thrown, which fails the build - except in watch mode, where a throw there
// crashes `vite build --watch` (Vite 5 - 8) and Rolldown's watch() unless its caller catches result.close(): printed
// then, and the next rebuild tries again.
function failClose(ctx, err) {
  if (ctx && ctx.meta && ctx.meta.watchMode) { config.error(err.message); return; }
  throw err;
}

// The packages of the bundler code in a build's chunks (see core/bundler.cjs): the Rollup or Rolldown copy whose rollup()
// or rolldown() was called (its entry module, as the hooks saw it: `from.file`), and for a build Vite made, Vite's
// package (`from.vite`: package.json of the vite or rolldown-vite around a file of the caller; Vite 5 - 7 build with
// Rollup, 8 with Rolldown). A plugin configured by hand, in a build without the preload: the copies that ran its hooks
// (`from.runner`: buildStart's caller; Vite: the config hook's), else those the working directory resolves, if they are
// of the version the build runs - else a problem. ctx: a hook's plugin context (meta.rollupVersion,
// meta.rolldownVersion - Rolldown sets rollupVersion too, to a compatible value -, meta.viteVersion from Vite 7 on).
const ROLLUP_NAMES = ['rollup', '@rollup/wasm-node'];
function bundlersOf(kind, from, ctx, cwd) {
  const meta = (ctx && ctx.meta) || {};
  const rolldown = typeof meta.rolldownVersion === 'string';
  const id = from.id || (rolldown ? 'rolldown' : 'rollup');
  const names = id === 'rolldown' ? ['rolldown'] : ROLLUP_NAMES;
  const version = id === 'rolldown' ? meta.rolldownVersion : rolldown ? undefined : meta.rollupVersion;
  const resolved = (pkgNames, v, what) => {
    /** @type {string | null} */
    let found = null;
    for (const n of pkgNames) { try { found = createRequire(path.join(cwd, 'x')).resolve(`${n}/package.json`); break; } catch { /* next */ } }
    const p = found ? bundlerPackage(kind, found, pkgNames, v) : null;
    if (p && (!v || p.version === v)) return p;
    problems.problem(`${kind}: the build runs ${what}${v ? `@${v}` : ''}, which was not loaded with the preload, and ${found ? `${found} is another copy` : `${cwd} resolves none`}: the lockfile would miss the bundler, whose code is in the output`);
    return null;
  };
  const runner = from.runner && from.runner[id];
  const out = [from.file || runner ? bundlerPackage(kind, from.file || runner, names, version) : resolved(names, version, id)];
  if (kind === 'vite') {
    const vite = from.vite ? bundlerPackage(kind, from.vite, VITE_NAMES) : resolved(VITE_NAMES, meta.viteVersion, 'vite');
    if (vite && typeof meta.viteVersion === 'string' && meta.viteVersion !== vite.version) {
      problems.problem(`vite: the build runs Vite ${meta.viteVersion}, its caller is in ${vite.path} (${vite.name}@${vite.version}): the lockfile would list another copy`);
    } else out.push(vite);
  }
  return out.filter(p => p !== null);
}

// kind: rollup, rolldown or vite (for messages and BUNDLE_LOCKFILE_DISABLE); engine: rollup or rolldown, the bundler
// the plugin is added to (undefined: not known, a plugin from a config); from: where the bundler packages are (bundlersOf)
function createPlugin(kind, inputOptions, engine, from = {}) {
  const cwd = realCwd();
  const run = {}; // this build, across its watch rebuilds (see core/outputs.cjs record)
  const isRolldown = (ctx) => !!(ctx && ctx.meta && ctx.meta.rolldownVersion);
  /** @type {string | null} */
  let unreadable = null; // what keeps the files Rolldown's plugins inlined from being recorded (see rolldown-watch.cjs)
  // Rollup: a build's watch files are only those of the modules it transforms (graph.watchFiles). A rebuild in watch mode
  // takes unchanged modules from the previous build's cache, with their transform dependencies but without adding them
  // there: a style sheet's @imports would leave the lockfile on every rebuild that does not change it. So the cache's
  // modules' transform dependencies (from the options hook: Rollup drops the cache before buildStart) are taken for the
  // modules this build did not transform (bundle-lockfile's transform hook did not see them).
  let cachedDependencies = new Map(); // module id -> its transform dependencies, in the cache the build started from
  let transformed = new Set();        // module ids this build transformed
  // per output of the build, by its output options object: Rollup and Rolldown pass the same one to every hook of an
  // output, and outputs written at the same time (Promise.all of write()s, as the rollup command line does) can share
  // their directory and format. Kept until the build is closed (closeBundle): Rolldown runs buildStart again for every
  // write() of one build, Rollup once per build.
  const modulesOf = new Map(); // output -> Set(module id), from renderChunk
  const written = new Map();   // output -> { target, writer, dir, pkgs, files, hashes, landed }
  const ordinals = new Map();  // output -> its position among the build's outputs (part of its writer id)
  let closed = true;           // no build since the last closeBundle
  let build = null; // the RolldownBuild of this plugin's rolldown() call (see esmWrap)
  // the build's input, part of its writer ids: from the options of the rollup()/rolldown() call the plugin was added to
  // (as given, see attach), else - a plugin configured by hand - from the options Rollup and Rolldown pass to buildStart
  let input = inputOptions && inputOptions.input;
  let since = 0;
  let outCwd = cwd; // what the output's dir and file are relative to
  // writes the lockfile of an output; in strict mode rejects with what went wrong (core/problems.cjs), which fails the
  // build: a hook's rejection is the build's error
  const write = async (w) => {
    await outputs.land(w.target, w.writer, kind);
    problems.failIfAny((err) => { throw err; });
  };
  return withinBuild({
    name: NAME,
    api: { setBuild(b) { build = b; } },
    // Vite bundles workers with the plugins of worker.plugins, not with the config's (the preload adds this plugin to
    // every build itself): a plugin from the config adds a copy of itself there. Vite 5 and later take a function.
    ...(kind === 'vite' && {
      config(cfg) {
        // Vite calls this hook (also when the plugin is in the config, without the preload): its caller is Vite
        if (!from.vite) from.vite = viteOf(callerFiles());
        if (!cfg || typeof cfg !== 'object') return;
        const prev = cfg.worker && cfg.worker.plugins;
        const user = typeof prev === 'function' ? prev : Array.isArray(prev) ? () => prev : () => [];
        cfg.worker = { ...cfg.worker, plugins(...args) {
          const list = [].concat(user(...args) || []);
          return flat(list).some(p => p.name === NAME) ? list : [...list, createPlugin(kind, undefined, undefined, { vite: from.vite })];
        } };
      },
    }),
    // (Rollup: the options of the build, before Rollup takes the cache out of them)
    ...(engine !== 'rolldown' && {
      options(raw) {
        cachedDependencies = new Map();
        const modules = raw && raw.cache && Array.isArray(raw.cache.modules) ? raw.cache.modules : [];
        for (const m of modules) if (m && typeof m.id === 'string' && Array.isArray(m.transformDependencies)) cachedDependencies.set(m.id, m.transformDependencies);
        return null;
      },
    }),
    /** @this {any} a plugin context */
    buildStart(options) {
      // a plugin configured by hand: the bundler that runs this hook (see bundlersOf)
      if (!from.file && !from.runner) from.runner = { rollup: packageOnStack(ROLLUP_NAMES), rolldown: packageOnStack(['rolldown']) };
      // (Rolldown runs it for every write() of a build: the state, and the time the build started, from its first)
      if (closed || !(this && this.meta && this.meta.rolldownVersion)) {
        written.clear(); modulesOf.clear(); ordinals.clear();
        since = Date.now() - 2000; // file systems with coarse timestamps
      }
      closed = false;
      transformed = new Set();
      if (isRolldown(this)) unreadable = rolldownWatch.start(this);
      if (!inputOptions || inputOptions.input === undefined) input = options && options.input;
      // Rolldown resolves the output's dir and file against its cwd option
      outCwd = isRolldown(this) && options && typeof options.cwd === 'string' && path.isAbsolute(options.cwd) ? options.cwd : cwd;
    },
    // Rolldown: the load and transform hooks' plugin contexts, whose addWatchFile records the files plugins inline (see
    // rolldown-watch.cjs); before every other plugin's normal hooks (Vite's CSS plugin: a transform). Rollup: the
    // modules a build transforms (see cachedDependencies)
    ...(engine !== 'rollup' && {
      load: {
        order: 'pre',
        handler(id) {
          if (!isRolldown(this)) return null;
          const problem = rolldownWatch.wrap(this);
          if (problem) unreadable = problem;
          rolldownWatch.loading(this, id);
          return null;
        },
      },
    }),
    transform: {
      order: 'pre',
      handler(code, id) {
        if (!isRolldown(this)) { transformed.add(id); return null; }
        const problem = rolldownWatch.wrap(this);
        if (problem) unreadable = problem;
        return null;
      },
    },
    renderStart(out) {
      if (!ordinals.has(out)) ordinals.set(out, ordinals.size);
      modulesOf.set(out, new Set());
    },
    // before generateBundle: plugins that remove chunks there (vite-plugin-singlefile) cannot hide their modules
    renderChunk(code, chunk, out) {
      const ids = modulesOf.get(out);
      if (ids) for (const id of moduleIds(chunk)) ids.add(id);
      return null;
    },
    generateBundle: {
      order: 'post',
      async handler(out, bundle, isWrite) {
        try {
          // generate-only builds (Vite's workers and legacy polyfills, write: false, workbox-build, Vite 8 bundling its
          // config) write nothing themselves: their chunks' packages are kept for the build that uses them. An output
          // below node_modules is a tool's cache (Vite's dependency pre-bundling) or such a build too - except below
          // node_modules/.cache/, where tools build what ships: `nuxi build` builds into node_modules/.cache/nuxt/.nuxt
          // when .nuxt is there, and Nitro copies the client's files from there into .output/public (see core/outputs.cjs
          // outputCopy). Without dir and file, Rolldown writes to dist/ (Rollup does not write at all); the hooks get neither
          const dir = path.resolve(outCwd, out.dir || (out.file ? path.dirname(out.file) : this.meta && this.meta.rolldownVersion ? 'dist' : '.'));
          // the bundler's code is in every chunk
          const bundlers = Object.values(bundle).some(f => f.type === 'chunk') ? bundlersOf(kind, from, this, cwd) : [];
          const generateOnly = isWrite === false || inToolCache(dir);
          // the output's modules: those its chunks had when they were rendered (also of chunks a plugin removed since),
          // and those they have now
          const ids = new Set(modulesOf.get(out) || []);
          for (const f of Object.values(bundle)) if (f.type === 'chunk') for (const id of moduleIds(f)) ids.add(id);
          // Rolldown: the files plugins inlined into this output's modules, as recorded (rolldown-watch.cjs), and the
          // build's watch files if rolldown() returned the build. Neither, in a build with style (style modules, CSS
          // files): the style sheets @imported from packages would be missing - a problem
          const watched = [...await watchFilesOf(this, build)];
          if (isRolldown(this)) {
            const recorded = unreadable ? null : rolldownWatch.filesOf(this, ids);
            if (recorded) watched.push(...recorded);
            const style = [...ids].some(id => STYLE.test(fileOf(id) || '')) || Object.values(bundle).some(f => f.type !== 'chunk' && /\.css$/i.test(f.fileName));
            if (!recorded && !build && style) {
              problems.problem(`${kind}: Rolldown ${this.meta.rolldownVersion}: could not read the files its plugins inlined (${unreadable || 'the build was not seen starting'}): style sheets @imported from packages would be missing from ${generateOnly ? 'the output of a build that writes nothing itself' : path.join(dir, config.file)}`);
            }
          }
          if (!isRolldown(this) && cachedDependencies.size) {
            let all = [];
            try { all = [...this.getModuleIds()]; } catch { /* none */ }
            for (const id of all) if (!transformed.has(id) && cachedDependencies.has(id)) watched.push(...cachedDependencies.get(id));
          }
          if (generateOnly) {
            const pkgs = keepGenerated(this, bundle, { cwd, bundlers, watched });
            config.debug(`${kind}: generate-only output with`, pkgs.length, 'packages, kept for the build that uses it');
            return; // (its problems, such as a package without a package.json: below)
          }
          const { files, pkgs, found, hashes, contents } = collectOutput(this, bundle, { dir, cwd, ids, watched, bundlers });
          const target = path.join(dir, config.file);
          const writer = outputWriter(kind, input, out, ordinals.get(out) || 0, cwd);
          const bundler = bundlerOf(kind, this && this.meta);
          written.set(out, { target, writer, dir, pkgs, files: new Set(files), hashes, contents, bundler, via: found, landed: false });
          outputs.record(target, writer, pkgs, cwd, files, { disk: true, outputs: hashes, contents, bundler, via: found, run });
        } catch (e) {
          problems.problem(`${kind}: could not collect the bundled packages of ${out.dir || out.file || 'a build that writes nothing itself'}`, e);
        } finally {
          // what went wrong fails the build (strict mode, see core/problems.cjs): this.error throws the build's error
          problems.failIfAny((err) => this.error(err));
        }
      },
    },
    writeBundle: {
      order: 'post',
      handler(out) {
        const w = written.get(out);
        if (!w) return undefined;
        w.landed = true;
        return write(w);
      },
    },
    // after every other plugin's closeBundle (vite-plugin-pwa writes sw.js in its sequential one): the files they put
    // into the output directory, see filesWrittenAfter. Rollup calls closeBundle on bundle.close(), Vite does that after the
    // write; a build closed without it keeps the lockfile of writeBundle.
    closeBundle: {
      order: 'post',
      sequential: true,
      async handler(error) {
        closed = true;
        if (error) return;
        for (const w of written.values()) {
          if (!w.landed) continue;
          try {
            const late = filesWrittenAfter(w.dir, { since, cwd, skip: path.dirname(w.target), known: new Set([...w.files, ...outputs.filesOf(w.target)]) });
            const add = packages.unique(...late.map(l => l.pkgs)).filter(p => !w.pkgs.some(q => q.path === p.path));
            if (!add.length) continue;
            config.debug(`${kind}: files written into`, w.dir, 'after the build:', late.map(l => path.relative(w.dir, l.file)).join(' '), '- adding', add.map(p => `${p.name}@${p.version}`).join(' '));
            w.pkgs = packages.unique(w.pkgs, add);
            w.via.add('late', add);
            for (const l of late) w.files.add(l.file);
            outputs.record(w.target, w.writer, w.pkgs, cwd, [...w.files],
              { disk: true, outputs: w.hashes, contents: w.contents, bundler: w.bundler, via: w.via, run });
            await write(w);
          } catch (e) {
            if (problems.isFailure(e)) { failClose(this, e); return; } // from write()
            problems.problem(`${kind}: could not add the files written into ${w.dir} after the build`, e);
          }
        }
        problems.failIfAny((err) => failClose(this, err));
      },
    },
  });
}

// The hooks of the plugin that record problems or take them run as part of its build (core/problems.cjs within): the
// problems fail that build, never another build of the process. The plugin is the build's owner, across its watch
// rebuilds. Not the hooks that run for every module or chunk (load, transform, renderChunk), which record none: an
// AsyncLocalStorage context costs time there (on Node.js before 24, every promise of the process once it is used).
const SCOPED = new Set(['config', 'options', 'buildStart', 'generateBundle', 'writeBundle', 'closeBundle']);
function withinBuild(plugin) {
  const scoped = (fn) => /** @this {unknown} */ function (...args) { return problems.within(plugin, () => fn.apply(this, args)); };
  for (const [k, v] of Object.entries(plugin)) {
    if (!SCOPED.has(k)) continue;
    if (typeof v === 'function') plugin[k] = scoped(v);
    else if (v && typeof v === 'object' && typeof v.handler === 'function') plugin[k] = { ...v, handler: scoped(v.handler) };
  }
  return plugin;
}

// One more plugin for the options of a rollup()/rolldown() call (also each config of watch()/build()), unless it
// has one already (configured by hand, or build() calling rolldown()) or its kind is disabled.
// file: the entry module of the Rollup or Rolldown copy whose function was called (see bundlersOf).
function attach(id, options, file) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return options;
  const plugins = flat(options.plugins);
  if (plugins.some(p => p.name === NAME)) return options;
  // Vite 8's dependency pre-bundling (dev server): its output, in Vite's cache directory, is never shipped - wherever
  // that directory is (cacheDir outside node_modules)
  if (plugins.some(p => p.name === PRE_BUNDLE)) { config.debug(`${id}: Vite's dependency pre-bundling, left alone`); return options; }
  const kind = plugins.some(p => typeof p.name === 'string' && VITE.test(p.name)) ? 'vite' : id;
  if (config.isDisabled(kind)) { config.debug(`${kind}: disabled`); return options; }
  config.debug(`${kind}: adding the plugin to a ${id}() call`);
  // a build Vite makes: Vite's package is around its caller, a file on the stack now (core/bundler.cjs)
  const from = { id, file, vite: kind === 'vite' ? viteOf(callerFiles()) : null };
  const own = /** @type {unknown[]} */ ([]).concat(options.plugins == null ? [] : options.plugins);
  return { ...options, plugins: [...own, createPlugin(kind, options, id, from)] };
}

const each = (id, v, file) => (Array.isArray(v) ? v.map(o => attach(id, o, file)) : attach(id, v, file));

// rollup()/rolldown() with the plugin; the plugin gets the build the call returns (Rolldown's watch files, see
// watchFilesOf) - also one that was in the options already (configured by hand): only the caller of rolldown() has it.
function wrapBuild(id, fn, file) {
  return /** @this {unknown} */ function (options, ...rest) {
    const o = attach(id, options, file);
    const result = fn.call(this, o, ...rest);
    const plugin = o && typeof o === 'object' && !Array.isArray(o) && flat(o.plugins).find(p => p.name === NAME && p.api && p.api.setBuild);
    if (plugin && result && typeof result.then === 'function') result.then(b => plugin.api.setBuild(b), () => {});
    return result;
  };
}

const PATCHED = Symbol.for('bundle-lockfile.rollup.cjs');
// Rollup's CommonJS build: dist/shared/rollup.js has rollup() and rollupInternal(), which the rollup command line
// (rollup.rollup), watch() (rollup.rollupInternal) and dist/rollup.js (require('rollup'), which copies rollup when it
// loads, after this patch) call.
const CJS_ROLLUP = /[\\/](rollup|@rollup[\\/]wasm-node)[\\/]dist[\\/]shared[\\/]rollup\.js$/;

module.exports = {
  name: 'rollup',
  names: ['rollup', 'rolldown', 'vite'],
  esmEntries: [
    { id: 'rollup', suffixes: ['/rollup/dist/es/rollup.js', '/@rollup/wasm-node/dist/es/rollup.js'], wrap: ['rollup', 'watch'] },
    { id: 'rolldown', suffixes: ['/rolldown/dist/index.mjs'], wrap: ['rolldown', 'watch', 'build'] },
  ],
  esmPackages: ['vite', 'rollup', 'rolldown', 'rolldown-vite'],
  cjsFiles: [CJS_ROLLUP], // the module onCjsLoad patches
  // CommonJS files the ES-module builds load (hooks.cjs esmCompanions): Rollup's native parser, which its ES build
  // loads with no CommonJS module of Rollup's before it (its CommonJS build: from dist/shared/parseAst.js), and
  // Rolldown's binding (its package.json and the .node file), which its ES build loads from dist/shared/*.mjs
  esmCompanions: [
    { id: 'rollup', names: ['rollup', 'vite'], file: /[\\/]node_modules[\\/](?:rollup|@rollup[\\/]wasm-node)[\\/]dist[\\/]native\.js$/ },
    { id: 'rolldown', names: ['rolldown', 'vite'], file: /[\\/]node_modules[\\/]@rolldown[\\/]binding-[^\\/]+[\\/](?:package\.json|[^\\/]+\.node)$/ },
  ],

  esmWrap(id, name, fn, url) {
    if (typeof fn !== 'function') return null;
    if (name === 'rollup' || name === 'rolldown') return wrapBuild(id, fn, url);
    if (name === 'watch' || name === 'build') return /** @this {unknown} */ function (options, ...rest) { return fn.call(this, each(id, options, url), ...rest); };
    return null;
  },
  onCjsLoad(exp, request, resolve) {
    // the path first: reading a missing property of a module in a circular require() makes Node warn. request: the path
    // Rollup's files are recognized by (see hooks.cjs)
    if (!request.endsWith('rollup.js') || !CJS_ROLLUP.test(request) || !exp || typeof exp !== 'object' || exp[PATCHED]) return;
    // Rollup's: a version without rollupInternal(), or older than the object hooks the plugin has (2.78), would build
    // without a lockfile - a problem (in strict mode its require() fails, see hooks.cjs)
    // (the version: exports.version in early 4.x releases, exports.package_ in later ones; else the package's package.json)
    let version = typeof exp.version === 'string' ? exp.version : exp.package_ && typeof exp.package_.version === 'string' ? exp.package_.version : null;
    if (!version) try { version = JSON.parse(fs.readFileSync(path.join(path.dirname(resolve()), '../../package.json'), 'utf8')).version; } catch { /* unknown */ }
    const [major, minor] = String(version || '').split('.').map(Number);
    if (typeof exp.rollupInternal !== 'function' || (version && !(major > 2 || (major === 2 && minor >= 78)))) {
      problems.problem(`rollup: ${resolve()} (Rollup ${version || 'of an unknown version'}) is no Rollup bundle-lockfile can hook (2.78 or later, with rollupInternal): its builds would write no lockfile`);
      return;
    }
    try {
      exp[PATCHED] = true;
      const rollup = exp.rollup, internal = exp.rollupInternal;
      if (typeof rollup === 'function') exp.rollup = wrapBuild('rollup', rollup, resolve());
      exp.rollupInternal = wrapBuild('rollup', internal, resolve()); // (options, watcher hooks)
      config.debug('rollup: patched its CommonJS build', resolve());
    } catch (e) { problems.problem(`rollup: could not patch ${resolve()}`, e); } // its builds would write no lockfile
  },
  bundleLockfile: (kind = 'rollup', options = {}) => createPlugin(kind, options), // for a rollup/vite config, without injection
  attach,
  fileOf,
};
