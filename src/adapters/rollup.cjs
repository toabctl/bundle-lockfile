'use strict';
// Rollup, Rolldown and everything built on them: Vite 5-7 (rollup), Vite 8 (rolldown), Vite-based frameworks,
// programmatic rollup()/rolldown()/build() calls. Their public entry modules (ESM) are wrapped (see hooks.cjs,
// esm-wrap.cjs) so that every rollup()/rolldown()/watch()/build() call gets one more plugin, which writes
// <output dir>/<BUNDLE_LOCKFILE_FILE> for every output the build writes. Rollup's CommonJS build (require('rollup'):
// workbox-build, the rollup command line, tools in CommonJS) is patched when it loads (onCjsLoad).
const fs = require('fs');
const path = require('path');
const config = require('../core/config.cjs');
const packages = require('../core/packages.cjs');
const outputs = require('../core/outputs.cjs');
const problems = require('../core/problems.cjs');
const generated = require('../core/generated.cjs');
const { sha256 } = require('../core/hashes.cjs');
const { filesWrittenAfter } = require('../core/late.cjs');
const { portable, exportPath } = require('../core/paths.cjs');

const NAME = 'bundle-lockfile';
const VITE = /^(vite:|builtin:vite-)/; // Vite's own plugins (Vite 8 has native builtin: ones)
// Vite 8's dependency pre-bundling (vite dev): a build into its cache directory, never shipped
const PRE_BUNDLE = 'vite:dep-pre-bundle';
const JS = /\.[cm]?js$/i;
const { STYLE } = packages;

const flat = (plugins) => [].concat(plugins == null ? [] : plugins).flat(Infinity).filter(p => p && typeof p === 'object' && !(typeof p.then === 'function'));
const moduleIds = (chunk) => chunk.moduleIds || Object.keys(chunk.modules || {});
const realCwd = () => { try { return fs.realpathSync(process.cwd()); } catch { return process.cwd(); } };

// Source file of a module id: virtual modules (\0vite/..., \0commonjsHelpers.js, virtual:...) have none; a
// \0-prefixed absolute id (rollup's commonjs proxies) and ids with queries (?vue&type=style, ?inline, ?worker) are
// the file before them. Directories and files can have a "#" in their name (~/c#/app): a "#" in the last part of the
// path is a fragment only if the file with it is not there.
function fileOf(id) {
  if (typeof id !== 'string') return null;
  let f = id.replace(/^\0/, '').split('?')[0];
  const hash = f.lastIndexOf('#');
  if (hash > Math.max(f.lastIndexOf('/'), f.lastIndexOf('\\')) && !fs.existsSync(f)) f = f.slice(0, hash);
  return path.isAbsolute(f) ? path.normalize(f) : null;
}

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

// The build's watch files: its modules, and the files its plugins read and inlined into a module (this.addWatchFile:
// Vite's CSS plugin adds the style sheets a style sheet @imports, and from Vite 6.1 on the images and fonts it inlines
// as data: URLs). Rollup has them in the plugin context; Rolldown only on the RolldownBuild that rolldown() returned.
async function watchFilesOf(ctx, build) {
  try { if (typeof ctx.getWatchFiles === 'function') return ctx.getWatchFiles(); } catch { /* none */ }
  try { if (build) { const w = await build.watchFiles; if (Array.isArray(w)) return w; } } catch { /* none */ }
  return [];
}

// The files among the build's watch files that its plugins inlined (packages.inlinedFile), absolute: those that are no
// module of the build (also not one that was tree-shaken: modules are bundled or not, never inlined).
function inlinedFiles(watchFiles, ctx) {
  let ids;
  try { ids = new Set([...ctx.getModuleIds()].map(fileOf).filter(Boolean)); } catch { ids = new Set(); }
  const out = [];
  for (const f of watchFiles) {
    if (typeof f !== 'string' || !path.isAbsolute(f) || !packages.inlinedFile(f)) continue;
    const file = path.normalize(f);
    if (!ids.has(file)) out.push(file);
  }
  return out;
}

// Packages of the output of generate-only builds that ends up in this bundle (see core/generated.cjs): chunks and
// JavaScript assets with the content of a generate-only chunk (Vite's worker chunks, legacy polyfills), and modules
// with a query on the entry file of a generate-only build (Vite's /src/w.js?worker&inline, which inlines the worker).
function generatedIn(bundle, ids) {
  const out = new Map();
  const add = (pkgs) => { if (pkgs) for (const p of pkgs) out.set(p.path, p); };
  for (const f of Object.values(bundle)) {
    if (f.type === 'chunk') add(generated.byContent(f.code));
    else { if (JS.test(f.fileName)) add(generated.byContent(f.source)); add(generated.byAsset(f.source)); }
  }
  for (const id of ids) if (typeof id === 'string' && id.includes('?')) add(generated.byEntry(fileOf(id)));
  return out;
}

// The JavaScript and CSS files of a written bundle that another build may bundle (see core/nested.cjs): hashes
// { absolute path: "sha256-<hex>" } and contents { absolute path: [package paths] }, the packages in each.
// - a chunk: its modules' packages and those of generate-only builds in it - not those of style sheets Vite took out
//   of it into CSS files (a style module without ?inline, ?raw or ?url, if the bundle has CSS files)
// - a CSS file: the style modules of the chunks that import it (Vite's viteMetadata.importedCss; if no chunk does,
//   all of the bundle's), the files the build's plugins inlined (inlined: watch files, not known per CSS file), the
//   files it was emitted from
// - a chunk also: the files the build's plugins inlined that are no style sheets (a shader's #includes: not known per
//   chunk either)
// - a JavaScript asset (Vite's worker chunks): the generate-only chunk it is, the files it was emitted from
// ids: the bundle's module ids; originals: asset -> files it was emitted from; byFile: packagesOfFiles(sources).byFile.
function outputContents(bundle, dir, ids, originals, inlined, byFile) {
  const hashes = {}, contents = {};
  const all = Object.values(bundle);
  const css = all.filter(f => f.type !== 'chunk' && /\.css$/i.test(f.fileName));
  const isStyle = (id) => STYLE.test(fileOf(id) || '');
  const extracted = (id) => css.length > 0 && isStyle(id) && !/[?&](inline|raw|url)\b/.test(id);
  const add = (into, pkgs) => { if (pkgs) for (const p of pkgs) into.add(p.path); };
  const ofFiles = (into, list) => { for (const f of list) add(into, byFile.get(f)); };
  for (const f of all) {
    const file = path.join(dir, f.fileName);
    const into = new Set();
    if (f.type === 'chunk') {
      const own = moduleIds(f).filter(id => !extracted(id));
      ofFiles(into, own.map(fileOf).filter(Boolean));
      ofFiles(into, inlined.filter(i => !STYLE.test(i)));
      for (const p of generatedIn({ [f.fileName]: f }, own).values()) into.add(p.path);
      hashes[file] = sha256(f.code);
    } else if (css.includes(f)) {
      const importers = all.filter(c => c.type === 'chunk' && c.viteMetadata && c.viteMetadata.importedCss && c.viteMetadata.importedCss.has(f.fileName));
      const from = importers.length ? importers.flatMap(moduleIds) : [...ids];
      ofFiles(into, from.filter(extracted).map(fileOf));
      ofFiles(into, inlined);
      ofFiles(into, originals.get(f) || []);
      hashes[file] = sha256(f.source);
    } else if (JS.test(f.fileName)) {
      add(into, generated.byContent(f.source));
      ofFiles(into, originals.get(f) || []);
      hashes[file] = sha256(f.source);
    } else continue; // (another asset - a worker's font or wasm (core/generated.cjs) - is no file another build bundles)
    contents[file] = [...into];
  }
  return { hashes, contents };
}

// The directories of the bundle's entry modules and the ones above them, nearest first.
function entryDirs(bundle) {
  const dirs = new Set();
  for (const f of Object.values(bundle)) {
    const entry = f.type === 'chunk' && f.isEntry && fileOf(f.facadeModuleId);
    for (let d = entry && path.dirname(entry); d && !dirs.has(d); d = path.dirname(d) === d ? null : path.dirname(d)) dirs.add(d);
  }
  return [...dirs];
}

// The file has these bytes (a string as Rollup writes it, or a Buffer / Uint8Array).
function hasBytes(file, data) {
  if (data == null) return false;
  try {
    const buf = Buffer.from(data);
    return fs.statSync(file).size === buf.length && fs.readFileSync(file).equals(buf);
  } catch { return false; }
}

const once = (fn) => { let v; return () => (v === undefined ? (v = fn()) : v); };

// The file an asset was emitted from, given its originalFileName (or null). Rollup leaves the name's base to the plugin
// that emits the asset: Vite's are relative to its root, which is not always the working directory (root: 'web',
// `vite build web`) and which this plugin, added to the build by bundle-lockfile, does not see. The asset is the file
// with its bytes: the name relative to the working directory, else to an entry module's directory or one above it
// (Vite's root holds its entries); without one, the file relative to the working directory if it exists (an asset
// transformed on the way, e.g. a style sheet). bases(): those directories.
function originalFile(name, source, cwd, bases) {
  if (typeof name !== 'string') return null;
  const own = path.resolve(cwd, name);
  if (hasBytes(own, source)) return own;
  for (const base of bases()) {
    const file = path.resolve(base, name);
    if (file !== own && hasBytes(file, source)) return file;
  }
  return fs.existsSync(own) ? own : null;
}

// closeBundle's failure (strict mode): thrown, which fails the build - except in watch mode, where a throw there
// crashes `vite build --watch` (Vite 5 - 8) and Rolldown's watch() unless its caller catches result.close(): printed
// then, and the next rebuild tries again.
function failClose(ctx, err) {
  if (ctx && ctx.meta && ctx.meta.watchMode) { config.error(err.message); return; }
  throw err;
}

function createPlugin(kind, inputOptions) {
  const cwd = realCwd();
  const buildOf = (bundle) => ({ context: cwd, entries: Object.values(bundle).filter(f => f.type === 'chunk' && f.isEntry).map(f => fileOf(f.facadeModuleId)).filter(Boolean) });
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
  // writes the lockfile of an output; in strict mode rejects with what went wrong (core/problems.cjs), which fails the
  // build: a hook's rejection is the build's error
  const write = (w) => new Promise((resolve, reject) => {
    const end = () => { if (!problems.failIfAny(reject)) resolve(); };
    try {
      outputs.emitted(w.target, w.writer);
      const exists = (f, cb) => fs.lstat(f, (err) => cb(!err || err.code !== 'ENOENT'));
      outputs.prune(w.target, w.writer, exists, () => {
        outputs.rewrite(w.target, config.inline ? outputs.writeDisk(w.target) : null, (err) => {
          if (err) problems.problem(`${kind}: could not write ${w.target}`, err);
          else if (config.inline || exportPath(w.target)) config.debug(`${kind}: wrote`, [config.inline && w.target, exportPath(w.target)].filter(Boolean).join(' and '));
          end();
        });
      });
    } catch (e) { problems.problem(`${kind}: could not write ${w.target}`, e); end(); }
  });
  return {
    name: NAME,
    api: { setBuild(b) { build = b; } },
    // Vite bundles workers with the plugins of worker.plugins, not with the config's (the preload adds this plugin to
    // every build itself): a plugin from the config adds a copy of itself there. Vite 5 and later take a function.
    ...(kind === 'vite' && {
      config(cfg) {
        if (!cfg || typeof cfg !== 'object') return;
        const prev = cfg.worker && cfg.worker.plugins;
        const user = typeof prev === 'function' ? prev : Array.isArray(prev) ? () => prev : () => [];
        cfg.worker = { ...cfg.worker, plugins(...args) {
          const list = [].concat(user(...args) || []);
          return flat(list).some(p => p.name === NAME) ? list : [...list, createPlugin(kind)];
        } };
      },
    }),
    buildStart(options) {
      if (closed || !(this && this.meta && this.meta.rolldownVersion)) { written.clear(); modulesOf.clear(); ordinals.clear(); }
      closed = false;
      if (!inputOptions || inputOptions.input === undefined) input = options && options.input;
      since = Date.now() - 2000; // file systems with coarse timestamps
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
          const dir = path.resolve(cwd, out.dir || (out.file ? path.dirname(out.file) : this.meta && this.meta.rolldownVersion ? 'dist' : '.'));
          if (isWrite === false || (dir.split(path.sep).includes('node_modules') && !CACHE.test(dir + path.sep))) {
            const all = [];
            const bases = once(() => entryDirs(bundle));
            for (const f of Object.values(bundle)) {
              let pkgs;
              if (f.type === 'chunk') {
                const own = packages.packagesOfFiles(moduleIds(f).map(fileOf).filter(Boolean), buildOf(bundle)).all;
                pkgs = packages.unique(own, generatedIn({ [f.fileName]: f }, moduleIds(f)).values());
                generated.addChunk(f.code, pkgs);
              } else {
                // an asset emitted from a package file (a worker's font or wasm): the build that uses it emits its bytes
                // again, without naming the file
                const from = (f.originalFileNames || (f.originalFileName ? [f.originalFileName] : [])).map(n => originalFile(n, f.source, cwd, bases)).filter(Boolean);
                pkgs = from.length ? packages.packagesForFiles(from) : [];
                generated.addAsset(f.source, pkgs);
              }
              all.push(pkgs);
            }
            const pkgs = packages.unique(...all);
            for (const f of Object.values(bundle)) if (f.type === 'chunk' && f.isEntry) generated.addEntry(fileOf(f.facadeModuleId), pkgs);
            config.debug(`${kind}: generate-only output with`, pkgs.length, 'packages, kept for the build that uses it');
            problems.failIfAny((err) => this.error(err)); // (this build's problems, such as a package without a package.json)
            return;
          }
          const ids = new Set(modulesOf.get(out) || []);
          const sources = [], files = [], originals = new Map(); // asset -> its source files
          const bases = once(() => entryDirs(bundle));
          for (const f of Object.values(bundle)) {
            files.push(path.join(dir, f.fileName));
            if (f.type === 'chunk') {
              for (const id of moduleIds(f)) ids.add(id);
            } else {
              // assets emitted from a file (see originalFile)
              const own = [];
              for (const n of f.originalFileNames || (f.originalFileName ? [f.originalFileName] : [])) {
                const p = originalFile(n, f.source, cwd, bases);
                if (p) own.push(p);
              }
              originals.set(f, own);
              sources.push(...own);
            }
          }
          for (const id of ids) { const file = fileOf(id); if (file) sources.push(file); }
          const inlined = inlinedFiles(await watchFilesOf(this, build), this);
          sources.push(...inlined);
          const { all, byFile } = packages.packagesOfFiles(sources, buildOf(bundle));
          const pkgs = packages.unique(all, generatedIn(bundle, ids).values());
          const { hashes, contents } = outputContents(bundle, dir, ids, originals, inlined, byFile);
          const target = path.join(dir, config.file);
          const writer = outputWriter(kind, input, out, ordinals.get(out) || 0, cwd);
          written.set(out, { target, writer, dir, pkgs, files: new Set(files), hashes, contents, landed: false });
          outputs.record(target, writer, pkgs, cwd, files, { disk: true, outputs: hashes, contents });
        } catch (e) { problems.problem(`${kind}: could not collect the bundled packages of ${out.dir || out.file || 'a build that writes nothing itself'}`, e); }
        // what went wrong fails the build (strict mode, see core/problems.cjs): this.error throws the build's error
        problems.failIfAny((err) => this.error(err));
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
            for (const l of late) w.files.add(l.file);
            outputs.record(w.target, w.writer, w.pkgs, cwd, [...w.files], { disk: true, outputs: w.hashes, contents: w.contents });
            await write(w);
          } catch (e) {
            if (problems.isFailure(e)) { failClose(this, e); return; } // from write()
            problems.problem(`${kind}: could not add the files written into ${w.dir} after the build`, e);
          }
        }
        problems.failIfAny((err) => failClose(this, err));
      },
    },
  };
}

// One more plugin for the options of a rollup()/rolldown() call (also each config of watch()/build()), unless it
// has one already (configured by hand, or build() calling rolldown()) or its kind is disabled.
function attach(id, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return options;
  const plugins = flat(options.plugins);
  if (plugins.some(p => p.name === NAME)) return options;
  // Vite 8's dependency pre-bundling (dev server): its output, in Vite's cache directory, is never shipped - wherever
  // that directory is (cacheDir outside node_modules)
  if (plugins.some(p => p.name === PRE_BUNDLE)) { config.debug(`${id}: Vite's dependency pre-bundling, left alone`); return options; }
  const kind = plugins.some(p => typeof p.name === 'string' && VITE.test(p.name)) ? 'vite' : id;
  if (config.isDisabled(kind)) { config.debug(`${kind}: disabled`); return options; }
  config.debug(`${kind}: adding the plugin to a ${id}() call`);
  return { ...options, plugins: [...[].concat(options.plugins == null ? [] : options.plugins), createPlugin(kind, options)] };
}

const each = (id, v) => (Array.isArray(v) ? v.map(o => attach(id, o)) : attach(id, v));

// rollup()/rolldown() with the plugin; the plugin gets the build the call returns (Rolldown's watch files, see
// watchFilesOf) - also one that was in the options already (configured by hand): only the caller of rolldown() has it.
function wrapBuild(id, fn) {
  return function (options, ...rest) {
    const o = attach(id, options);
    const result = fn.call(this, o, ...rest);
    const plugin = o && typeof o === 'object' && !Array.isArray(o) && flat(o.plugins).find(p => p.name === NAME && p.api && p.api.setBuild);
    if (plugin && result && typeof result.then === 'function') result.then(b => plugin.api.setBuild(b), () => {});
    return result;
  };
}

const PATCHED = Symbol.for('bundle-lockfile.rollup.cjs');
const CACHE = /[\\/]node_modules[\\/]\.cache[\\/]/; // tools' build directories below node_modules (see generateBundle)
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

  esmWrap(id, name, fn) {
    if (typeof fn !== 'function') return null;
    if (name === 'rollup' || name === 'rolldown') return wrapBuild(id, fn);
    if (name === 'watch' || name === 'build') return function (options, ...rest) { return fn.call(this, each(id, options), ...rest); };
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
      if (typeof rollup === 'function') exp.rollup = wrapBuild('rollup', rollup);
      exp.rollupInternal = wrapBuild('rollup', internal); // (options, watcher hooks)
      config.debug('rollup: patched its CommonJS build', resolve());
    } catch (e) { problems.problem(`rollup: could not patch ${resolve()}`, e); } // its builds would write no lockfile
  },
  bundleLockfile: (kind = 'rollup', options = {}) => createPlugin(kind, options), // for a rollup/vite config, without injection
  attach,
  fileOf,
};
