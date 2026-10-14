'use strict';
// esbuild's JavaScript API (esbuild and esbuild-wasm 0.17 and later): build(), context() (rebuild, watch, serve) and
// buildSync(). Its CommonJS entry (lib/main.js, where esbuild's API insists on being) exports getters only, which
// cannot be patched: onCjsLoad returns a copy of its exports with build(), context() and buildSync() wrapped (see
// hooks.cjs). Every build then gets one more plugin, last, which turns on the metafile and, in onEnd - after esbuild
// has written the output - maps the input files of every output (metafile.outputs[*].inputs) to their packages and
// writes <output dir>/<BUNDLE_LOCKFILE_FILE>. A problem fails the build: onEnd returns it as an error, which rejects
// build() and rebuild() (watch mode prints it and keeps watching). buildSync() takes no plugins: its result's metafile.
// The command line and the Go API are esbuild's Go binary: not hooked.
/** @import { Package } from '../types' */
const fs = require('fs');
const path = require('path');
const config = require('../core/config.cjs');
const packages = require('../core/packages.cjs');
const via = require('../core/via.cjs');
const outputs = require('../core/outputs.cjs');
const problems = require('../core/problems.cjs');
const generated = require('../core/generated.cjs');
const { hashOf } = require('../core/hashes.cjs');
const { filesWrittenAfter } = require('../core/late.cjs');
const { portable, exportPath, inToolCache } = require('../core/paths.cjs');
const { bundlerPackage } = require('../core/bundler.cjs');

const NAME = 'bundle-lockfile';
const WRAPPED = Symbol.for('bundle-lockfile.esbuild.wrapped'); // on the original exports and on their replacement
// esbuild's API, in the package (esbuild-wasm has the same one); Yarn's pnpm linker's store: see core/layout.cjs
const MAIN = /[\\/](esbuild|esbuild-wasm)[\\/]lib[\\/]main\.js$/;
// Vite 5 - 7's own esbuild builds, never shipped: dependency pre-bundling (into its cache directory, wherever that is),
// scanning for dependencies, and bundling its config file (write: false, with these two plugins), whose packages run
// at build time
const VITE_OWN = new Set(['vite:dep-pre-bundle', 'vite:dep-scan']);
const VITE_CONFIG = ['externalize-deps', 'inject-file-scope-variables'];
const vitesOwn = (plugins) => plugins.some(p => VITE_OWN.has(p.name)) || VITE_CONFIG.every(n => plugins.some(p => p.name === n));
const JS = /\.[cm]?js$/i, CSS = /\.css$/i;
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

// The file of a metafile input key (relative to the build's absWorkingDir), or null:
// - (disabled):<file> is the empty module esbuild puts where a browser field maps a module to false: no code of it ships
// - <namespace>:<path> (a plugin's module): the file if the path is absolute, or relative to the working directory and
//   there (when in doubt, a file: listing a package too many is safer than missing one); else a virtual module
// - otherwise a path relative to the working directory; ?query and #hash are esbuild's suffixes, not the file's (a "#"
//   in a file's name: the file with it, if it is there)
function fileOfInput(key, wd) {
  if (typeof key !== 'string' || !key) return null;
  if (key.startsWith('(disabled):')) return null;
  let p = key;
  const ns = /^([^:\\/]+):(.*)$/s.exec(key);
  if (ns && !/^[A-Za-z]$/.test(ns[1])) { // (a drive letter is no namespace)
    p = ns[2];
    if (!path.isAbsolute(p)) {
      const abs = path.resolve(wd, p.split('?')[0]);
      if (!p || !fs.existsSync(abs)) return null;
    }
  }
  let f = path.resolve(wd, p);
  const q = f.indexOf('?');
  if (q >= 0) f = f.slice(0, q);
  const hash = f.lastIndexOf('#');
  if (hash > Math.max(f.lastIndexOf('/'), f.lastIndexOf('\\')) && !fs.existsSync(f)) f = f.slice(0, hash);
  return f;
}

// The output files of a metafile, absolute, with the files of their inputs: Map(output -> [file]). Inputs with no
// bytes in an output count (a module that only re-exports: its package is in the import chain of what ships); inputs
// only in the top-level "inputs" were tree-shaken away and are in no output. Externals are no inputs.
// A file a style sheet's url() names that is an input of no output was inlined into it (the dataurl, base64, text or
// binary loader: an image as a data: URL), and counts for that output too: esbuild lists it only among the style
// sheet's imports (kind url-token), not among the output's inputs. (With the file loader it is an output of its own.)
// pluginInlined(key, file): the files a plugin inlined into that input (see watched), also counted. kinds (optional):
// Map(file -> class, see core/via.cjs), told the files inlined (style sheets: style, other files: inlined).
/**
 * @param {any} metafile
 * @param {string} wd
 * @param {(key: string, file: string | null) => Iterable<string>} [pluginInlined]
 * @param {Map<string, string> | null} [kinds]
 * @returns {Map<string, string[]>}
 */
function filesOfOutputs(metafile, wd, pluginInlined = () => [], kinds = null) {
  const tag = (f) => { if (kinds && !kinds.has(f)) kinds.set(f, packages.STYLE.test(f) ? 'style' : 'inlined'); };
  const out = new Map();
  const outs = Object.entries((metafile && metafile.outputs) || {});
  const inputs = (metafile && metafile.inputs) || {};
  const inOutput = new Set(outs.flatMap(([, info]) => Object.keys((info && info.inputs) || {})));
  for (const [o, info] of outs) {
    const files = [];
    for (const key of Object.keys((info && info.inputs) || {})) {
      const f = fileOfInput(key, wd);
      if (f) files.push(f);
      const imports = inputs[key] && Array.isArray(inputs[key].imports) ? inputs[key].imports : [];
      for (const i of imports) {
        if (!i || i.kind !== 'url-token' || i.external || typeof i.path !== 'string' || inOutput.has(i.path) || !inputs[i.path]) continue;
        const inlined = fileOfInput(i.path, wd);
        if (inlined) { files.push(inlined); tag(inlined); }
      }
      for (const p of pluginInlined(key, f)) { files.push(p); tag(p); }
    }
    out.set(path.resolve(wd, o), files);
  }
  return out;
}

// The files plugins' onLoad callbacks report as watchFiles, per module they loaded: what they read to make it, e.g.
// esbuild-sass-plugin's Sass partials, which it inlines into the CSS it returns - no modules, so not in the metafile
// (esbuild #1268). Of those, the files a plugin inlines (core/packages.cjs inlinedFile: no code, no build tool's
// settings) count for a module that reaches an output, as Rollup's watch files do (adapters/rollup.cjs). Every plugin
// of a build gets a build object whose onLoad records them; everything else is the build's own. Keyed as the metafile
// names the module: its path relative to the working directory in the file namespace (absolute here, see fileOfInput),
// "<namespace>:<path>" in another.
function watched() {
  const byModule = new Map();
  const keyOf = (args) => (args.namespace && args.namespace !== 'file' ? `${args.namespace}:${args.path}` : args.path);
  const wrapBuild = (build) => new Proxy(build, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== 'onLoad' || typeof v !== 'function') return typeof v === 'function' ? v.bind(target) : v;
      return (opts, cb) => v.call(target, opts, typeof cb !== 'function' ? cb : async (args) => {
        const r = await cb(args);
        if (r && Array.isArray(r.watchFiles) && args && typeof args.path === 'string') {
          const style = r.watchFiles.filter(f => typeof f === 'string' && path.isAbsolute(f) && f !== args.path && packages.inlinedFile(f));
          if (style.length) byModule.set(keyOf(args), style); else byModule.delete(keyOf(args));
        }
        return r;
      });
    },
  });
  // the plugins of the options, each with its setup given the recording build object (a plugin object of another shape
  // is passed on as it is: esbuild rejects it)
  const plugins = (list) => list.map(p => (p && typeof p === 'object' && typeof p.setup === 'function'
    ? { ...p, setup(build) { return p.setup.call(p, wrapBuild(build)); } } : p));
  const inlined = (key, file) => byModule.get(key) || (file && byModule.get(file)) || [];
  return { plugins, inlined };
}

// The entry points of the options as files relative to the working directory, for the writer id: a list of paths, of
// { in, out }, or an object { out: in }
function entriesOf(options, wd) {
  const e = options.entryPoints;
  const rel = (v) => (typeof v === 'string' ? portable(wd, path.resolve(wd, v)) : v && typeof v.in === 'string' ? portable(wd, path.resolve(wd, v.in)) : null);
  if (Array.isArray(e)) return e.map(rel);
  if (e && typeof e === 'object') return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, rel(v)]));
  return null;
}

// Where a build writes, from its options: { dir, wd } (dir: the output directory, null if it writes no files itself:
// write: false, or neither outdir nor outfile), or null for a build that is not bundle-lockfile's to cover (below
// node_modules, other than node_modules/.cache: a tool's cache, see core/paths.cjs inToolCache).
function placeOf(options) {
  const wd = typeof options.absWorkingDir === 'string' ? options.absWorkingDir : process.cwd();
  const dir = options.write === false ? null
    : typeof options.outdir === 'string' ? path.resolve(wd, options.outdir)
      : typeof options.outfile === 'string' ? path.dirname(path.resolve(wd, options.outfile)) : null;
  if (dir && inToolCache(dir)) return null;
  return { dir, wd };
}

// The writer of a build's lockfile (see core/outputs.cjs): its entry points and output, without paths of this machine.
// A context's rebuilds are the same writer; separate builds into one directory (other entry points) are not.
function writerOf(options, wd) {
  const out = typeof options.outfile === 'string' ? ['outfile', portable(wd, path.resolve(wd, options.outfile))]
    : ['outdir', portable(wd, path.resolve(wd, options.outdir || '.'))];
  return JSON.stringify(['esbuild', entriesOf(options, wd), ...out]);
}

// The packages of a build's outputs, and the record of each JavaScript and CSS output for nested bundles: hashes
// { file: "sha256-<hex>" } and contents { file: [package paths] }.
function collect(metafile, wd, entries, inlined) {
  const kinds = new Map();
  const byOutput = filesOfOutputs(metafile, wd, inlined, kinds);
  const sources = [...new Set([...byOutput.values()].flat())];
  const result = packages.packagesOfFiles(sources, { context: realOr(wd), entries });
  // (a file that is an input of an output is a module of it: chunk, also if a plugin inlined it elsewhere)
  for (const info of Object.values((metafile && metafile.outputs) || {})) {
    for (const key of Object.keys((info && info.inputs) || {})) kinds.delete(fileOfInput(key, wd));
  }
  return { byOutput, all: result.all, byFile: result.byFile, found: via.ofFiles(result, kinds) };
}

const entryFiles = (metafile, wd) => Object.values((metafile && metafile.outputs) || {})
  .map(o => o && o.entryPoint && fileOfInput(o.entryPoint, wd)).filter(Boolean);

// A build that has run (no errors): writes its lockfile, or keeps the packages of what it generated in memory.
// Calls done() once the lockfile has landed. state (the plugin's, optional): { inlined (see watched), since: when the
// build started (ms), late: the files written into the output after the last build, version: esbuild's, as it reports
// itself, file: the esbuild module whose build() ran (its package is listed for the JavaScript it writes: esbuild's
// runtime helpers, __commonJS, __toESM and the like, are in it; see core/bundler.cjs) }.
function finish(options, result, done, state = {}) {
  const place = placeOf(options);
  if (!place) { config.debug('esbuild: output below node_modules, left alone'); return done(null); }
  const { dir, wd } = place;
  const metafile = result && result.metafile;
  try {
    if (!metafile || typeof metafile !== 'object' || !metafile.outputs) {
      problems.problem(`esbuild: a build into ${dir || 'memory'} has no metafile: its packages are unknown`);
      return done(null);
    }
    const entries = entryFiles(metafile, wd);
    const { byOutput, all: own, byFile, found } = collect(metafile, wd, entries, state.inlined);
    // esbuild itself, in an output with JavaScript
    const js = [...byOutput.keys()].some(f => JS.test(f));
    const runtime = js && state.file ? [bundlerPackage('esbuild', state.file, ['esbuild', 'esbuild-wasm'], state.version)].filter(p => p !== null) : [];
    found.add('runtime', runtime);
    const all = packages.unique(own, runtime);
    const pkgsOf = (files) => packages.unique(...files.map(f => byFile.get(f) || []));
    // written by esbuild? Not with write: false (nor without outdir and outfile)
    const written = dir && [...byOutput.keys()].some(f => fs.existsSync(f));
    if (!written) {
      for (const of of (result.outputFiles || [])) {
        const pkgs = packages.unique(pkgsOf(byOutput.get(of.path) || []), JS.test(of.path) ? runtime : []);
        if (JS.test(of.path) || CSS.test(of.path)) generated.addChunk(of.text !== undefined ? of.text : of.contents, pkgs);
        else generated.addAsset(of.contents, pkgs);
      }
      for (const e of entries) generated.addEntry(e, all);
      config.debug('esbuild: a build that writes nothing itself, with', all.length, 'packages, kept for the build that uses its output');
      return done(null);
    }
    const files = [...byOutput.keys()];
    const hashes = {}, contents = {};
    let pkgs = all;
    for (const [file, inputs] of byOutput) {
      if (!JS.test(file) && !CSS.test(file)) continue;
      const inFile = packages.unique(pkgsOf(inputs), JS.test(file) ? runtime : []);
      // a JavaScript file with the bytes of a generate-only build's chunk (core/generated.cjs)
      /** @type {Package[] | null} */
      let gen = null;
      if (JS.test(file) && generated.any()) { try { gen = generated.byContent(fs.readFileSync(file)); } catch { /* gone */ } }
      if (gen) { pkgs = packages.unique(pkgs, gen); found.add('generated', gen); }
      const h = hashOf(file);
      if (h) { hashes[file] = h; contents[file] = packages.unique(inFile, gen || []).map(p => p.path); }
    }
    const target = path.join(dir, config.file);
    const writer = writerOf(options, wd);
    // files the other plugins' onEnd callbacks wrote into the output (authentik's fs.cp of assets out of packages,
    // which run before this one: it is the last), see core/late.cjs - not those of the other writers there
    if (state.since !== undefined) {
      const known = new Set([...files, ...[...outputs.filesOf(target)].filter(f => !(state.late || new Set()).has(f))]);
      const late = filesWrittenAfter(dir, { since: state.since, cwd: realOr(wd), skip: path.dirname(target), known, roots: [realOr(wd)] });
      state.late = new Set(late.map(l => l.file));
      if (late.length) {
        config.debug('esbuild: files written into', dir, 'after the build:', late.map(l => path.relative(dir, l.file)).join(' '));
        pkgs = packages.unique(pkgs, ...late.map(l => l.pkgs));
        for (const l of late) found.add('late', l.pkgs);
        files.push(...state.late);
      }
    }
    outputs.record(target, writer, pkgs, realOr(wd), files, { disk: true, outputs: hashes, contents,
      bundler: { name: 'esbuild', ...(typeof state.version === 'string' ? { version: state.version } : {}) }, via: found });
    outputs.emitted(target, writer);
    const exists = (f, cb) => fs.lstat(f, (err) => cb(!err || err.code !== 'ENOENT'));
    outputs.prune(target, writer, exists, () => {
      outputs.rewrite(target, config.inline ? outputs.writeDisk(target) : null, (err) => {
        if (err) problems.problem(`esbuild: could not write ${target}`, err);
        else if (config.inline || exportPath(target)) config.debug('esbuild: wrote', [config.inline && target, exportPath(target)].filter(Boolean).join(' and '));
        done(null);
      });
    });
  } catch (e) {
    problems.problem(`esbuild: could not collect the bundled packages of ${dir || 'a build that writes nothing itself'}`, e);
    done(null);
  }
}

// The plugin of one build() / context() call; inlined: see watched.
function createPlugin(inlined, file) {
  /** @type {{ inlined: any, since: number | undefined, late: Set<string>, file: string, version?: string }} */
  const state = { inlined, since: undefined, late: new Set(), file };
  return {
    name: NAME,
    setup(build) {
      const options = build.initialOptions;
      // the metafile is what this plugin reads: on, also where the caller did not ask for it (and removed again from
      // the result then: the caller gets what it asked for)
      const asked = options.metafile === true;
      options.metafile = true;
      build.onStart(() => { state.since = Date.now() - 2000; }); // (file systems with coarse timestamps)
      build.onEnd((result) => new Promise((resolve) => {
        const end = () => {
          if (!asked && result) delete result.metafile;
          /** @type {{ text: string, pluginName: string }[] | null} */
          let errors = null;
          problems.failIfAny((err) => { errors = [{ text: err.message.replace(/\n$/, ''), pluginName: NAME }]; });
          resolve(errors ? { errors } : undefined);
        };
        if (!result || (result.errors && result.errors.length)) return end(); // a failed build wrote nothing
        state.version = build.esbuild && build.esbuild.version;
        finish(options, result, end, state);
      }));
    },
  };
}

const flat = (plugins) => (Array.isArray(plugins) ? plugins.filter(p => p && typeof p === 'object') : []);

// The options of a build() / context() call with the plugin, unless it has it already, is Vite's own, or writes below
// node_modules; the caller's object is left as it is.
// file: the esbuild module whose build() / context() was called (see finish)
function attach(options, file) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return options;
  const plugins = flat(options.plugins);
  if (plugins.some(p => p.name === NAME)) return options;
  if (vitesOwn(plugins)) { config.debug("esbuild: Vite's own build (dependency pre-bundling or scan, its config), left alone"); return options; }
  if (!placeOf(options)) { config.debug('esbuild: output below node_modules, left alone'); return options; }
  config.debug('esbuild: adding the plugin to a build');
  const w = watched();
  return { ...options, plugins: [...w.plugins(Array.isArray(options.plugins) ? options.plugins : []), createPlugin(w.inlined, file)] };
}

// buildSync(): no plugins in synchronous calls - the result's metafile, processed as onEnd would (finish() runs
// synchronously up to the write, which is queued: a process that exits right away still writes it - see
// core/outputs.cjs rewrite - unless it exits before the event loop runs again). A problem throws.
function wrapSync(fn, version, file) {
  return /** @this {unknown} */ function (options, ...rest) {
    if (!options || typeof options !== 'object' || !placeOf(options) || vitesOwn(flat(options.plugins))) return fn.call(this, options, ...rest);
    const asked = options.metafile === true;
    const result = fn.call(this, { ...options, metafile: true }, ...rest);
    finish(options, result, () => {}, { version, file });
    if (!asked) delete result.metafile;
    problems.failIfAny((err) => { throw err; });
    return result;
  };
}

// esbuild before 0.17 (build() with incremental / watch, no context()): not supported. A call that writes an output
// bundle-lockfile would cover fails (strict mode) instead of writing no lockfile; others (Vite 3 / 4's own builds,
// write: false) go on.
function wrapOld(fn, version, sync) {
  return /** @this {unknown} */ function (options, ...rest) {
    const place = options && typeof options === 'object' ? placeOf(options) : null;
    if (place && place.dir && !vitesOwn(flat(options.plugins))) {
      problems.problem(`esbuild ${version}: bundle-lockfile needs esbuild 0.17 or later; this build of ${place.dir} would write no lockfile`);
      /** @type {Error | null} */
      let failure = null;
      problems.failIfAny((err) => { failure = err; });
      if (failure && sync) throw failure;
      if (failure) return Promise.reject(failure);
    }
    return fn.call(this, options, ...rest);
  };
}

module.exports = {
  name: 'esbuild',
  cjsFiles: [MAIN],
  cjsPackages: ['esbuild'], // processes that build with it (see hooks.cjs installCjs)
  onCjsLoad(exp, request, resolve) {
    if (!request.endsWith('main.js') || !MAIN.test(request) || !exp || typeof exp !== 'object' || exp[WRAPPED]) return undefined;
    if (typeof exp.build !== 'function' || typeof exp.version !== 'string') {
      problems.problem(`esbuild: ${resolve()} exports no build() and version bundle-lockfile knows: its builds would write no lockfile`);
      return undefined;
    }
    const [major, minor] = exp.version.split('.').map(Number);
    const old = major === 0 && minor < 17;
    // a copy: every export as it is now (esbuild's getters return the same functions every time), with build(),
    // context() and buildSync() wrapped; "default" is the copy itself, for code compiled with ES-module interop
    // (esbuild's own default is its inner exports object, which would bypass the wrappers)
    const copy = {};
    for (const k of Object.keys(exp)) copy[k] = exp[k];
    if (old) {
      copy.build = wrapOld(exp.build, exp.version, false);
      if (typeof exp.buildSync === 'function') copy.buildSync = wrapOld(exp.buildSync, exp.version, true);
    } else {
      const build = exp.build, context = exp.context;
      const file = resolve();
      copy.build = function (options, ...rest) { return build.call(this, attach(options, file), ...rest); };
      if (typeof context === 'function') copy.context = function (options, ...rest) { return context.call(this, attach(options, file), ...rest); };
      if (typeof exp.buildSync === 'function') copy.buildSync = wrapSync(exp.buildSync, exp.version, file);
    }
    copy.default = copy;
    Object.defineProperty(copy, '__esModule', { value: true });
    Object.defineProperty(copy, WRAPPED, { value: true });
    try { Object.defineProperty(exp, WRAPPED, { value: true, configurable: true }); } catch { /* frozen: the module is replaced anyway */ }
    config.debug(`esbuild: wrapped ${exp.version} from`, resolve());
    return { exports: copy };
  },
  // for tests and the metafile importer
  fileOfInput,
  filesOfOutputs,
  writerOf,
  attach,
};
