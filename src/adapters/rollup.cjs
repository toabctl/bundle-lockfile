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
const generated = require('../core/generated.cjs');
const { sha256 } = require('../core/hashes.cjs');
const copies = require('../core/copies.cjs');
const { ancestors, posix, packageRoot } = require('../core/paths.cjs');

const NAME = 'bundle-lockfile';
const VITE = /^(vite:|builtin:vite-)/; // Vite's own plugins (Vite 8 has native builtin: ones)
const JS = /\.[cm]?js$/i;
const { STYLE } = packages; // those a style sheet @imports from packages are inlined by Vite's CSS plugin, no modules
const MAX_SCAN = 20000;           // entries of an output directory looked at for files written after the build
const MAX_LATE = 20 * 1024 * 1024; // larger files written after the build are not compared

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

// The writer of one output (see core/outputs.cjs): the same input, format and position in the build's outputs,
// without paths of this machine.
function outputWriter(kind, input, out, ordinal, cwd) {
  const rel = (v) => (typeof v === 'string' && path.isAbsolute(v) ? posix(path.relative(cwd, v)) : v);
  const inputs = typeof input === 'string' ? rel(input) : Array.isArray(input) ? input.map(rel)
    : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).map(([k, v]) => [k, rel(v)])) : null;
  return JSON.stringify([kind, inputs, out.format || null, ordinal, typeof out.entryFileNames === 'string' ? out.entryFileNames : null]);
}

// Files the build depends on besides its modules (this.addWatchFile: Vite's CSS plugin adds the files a style sheet
// @imports). Rollup has them in the plugin context; Rolldown only on the RolldownBuild that rolldown() returned.
async function watchFilesOf(ctx, build) {
  try { if (typeof ctx.getWatchFiles === 'function') return ctx.getWatchFiles(); } catch { /* none */ }
  try { if (build) { const w = await build.watchFiles; if (Array.isArray(w)) return w; } } catch { /* none */ }
  return [];
}

// Packages of the output of generate-only builds that ends up in this bundle (see core/generated.cjs): chunks and
// JavaScript assets with the content of a generate-only chunk (Vite's worker chunks, legacy polyfills), and modules
// with a query on the entry file of a generate-only build (Vite's /src/w.js?worker&inline, which inlines the worker).
function generatedIn(bundle, ids) {
  const out = new Map();
  const add = (pkgs) => { if (pkgs) for (const p of pkgs) out.set(p.path, p); };
  for (const f of Object.values(bundle)) {
    if (f.type === 'chunk') add(generated.byContent(f.code));
    else if (JS.test(f.fileName)) add(generated.byContent(f.source));
  }
  for (const id of ids) if (typeof id === 'string' && id.includes('?')) add(generated.byEntry(fileOf(id)));
  return out;
}

// The JavaScript and CSS files of a written bundle that another build may bundle (see core/nested.cjs): hashes
// { absolute path: "sha256-<hex>" } and contents { absolute path: [package paths] }, the packages in each.
// - a chunk: its modules' packages and those of generate-only builds in it - not those of style sheets Vite took out
//   of it into CSS files (a style module without ?inline, ?raw or ?url, if the bundle has CSS files)
// - a CSS file: the style modules of the chunks that import it (Vite's viteMetadata.importedCss; if no chunk does,
//   all of the bundle's), the style sheets they @import from packages (styles: watch files, not known per CSS file),
//   the files it was emitted from
// - a JavaScript asset (Vite's worker chunks): the generate-only chunk it is, the files it was emitted from
// ids: the bundle's module ids; originals: asset -> files it was emitted from; byFile: packagesOfFiles(sources).byFile.
function outputContents(bundle, dir, ids, originals, styles, byFile) {
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
      for (const p of generatedIn({ [f.fileName]: f }, own).values()) into.add(p.path);
      hashes[file] = sha256(f.code);
    } else if (css.includes(f)) {
      const importers = all.filter(c => c.type === 'chunk' && c.viteMetadata && c.viteMetadata.importedCss && c.viteMetadata.importedCss.has(f.fileName));
      const from = importers.length ? importers.flatMap(moduleIds) : [...ids];
      ofFiles(into, from.filter(extracted).map(fileOf));
      ofFiles(into, styles);
      ofFiles(into, originals.get(f) || []);
      hashes[file] = sha256(f.source);
    } else if (JS.test(f.fileName)) {
      add(into, generated.byContent(f.source));
      ofFiles(into, originals.get(f) || []);
      hashes[file] = sha256(f.source);
    } else continue;
    contents[file] = [...into];
  }
  return { hashes, contents };
}

// The package a file copied into the output comes from: one this process copied out of a package with fs (see
// core/copies.cjs), or dist/vendor/node_modules/normalize.css/normalize.css (e.g. vite-plugin-static-copy with a
// node_modules path) is node_modules/normalize.css/normalize.css with the same bytes, looked up like Node does from
// the working directory upwards (the copy may have been made by another process).
function copiedFrom(file, rel, cwd) {
  const copy = copies.sourceOf(file);
  if (copy) { const pkgs = packages.packagesForFiles([copy]); if (pkgs.length) return pkgs; }
  if (!packageRoot(rel)) return null;
  const parts = rel.split(path.sep);
  const sub = parts.slice(parts.lastIndexOf('node_modules') + 1).join(path.sep);
  try { if (fs.statSync(file).size > MAX_LATE) return null; } catch { return null; }
  for (const dir of ancestors(cwd)) {
    const src = path.join(dir, 'node_modules', sub);
    if (copies.sameBytes(src, file)) { const pkgs = packages.packagesForFiles([src]); if (pkgs.length) return pkgs; }
  }
  return null;
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

// Files another plugin wrote into the output directory after the build had written its bundle, e.g.
// vite-plugin-pwa's sw.js and workbox-<hash>.js (workbox-build generates them with Rollup and writes them with fs in
// closeBundle) or vite-plugin-static-copy's copies: their packages, or none. Only files changed since the build
// started count, and none another output of this process writes there (plugin-legacy's legacy and modern outputs share
// dist/); the output directory must not contain the working directory (it would be the whole project).
function filesWrittenAfter(w, since, cwd) {
  const found = [];
  if (w.dir === cwd || cwd.startsWith(w.dir + path.sep)) return found;
  const skip = path.dirname(w.target);
  const known = outputs.filesOf(w.target);
  let seen = 0;
  const walk = (dir) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (++seen > MAX_SCAN) return;
      const file = path.join(dir, e.name);
      if (e.isDirectory()) { if (file !== skip) walk(file); continue; }
      if (!e.isFile() || w.files.has(file) || known.has(file)) continue;
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < since) continue;
      let pkgs = null;
      if (JS.test(file) && st.size <= MAX_LATE) { try { pkgs = generated.byContent(fs.readFileSync(file)); } catch { /* gone */ } }
      if (!pkgs) pkgs = copiedFrom(file, path.relative(w.dir, file), cwd);
      if (pkgs) found.push({ file, pkgs });
    }
  };
  walk(w.dir);
  if (seen > MAX_SCAN) config.debug(`more than ${MAX_SCAN} entries in`, w.dir, '- files written after the build not all checked');
  return found;
}

function createPlugin(kind, inputOptions) {
  const cwd = realCwd();
  const buildOf = (bundle) => ({ context: cwd, entries: Object.values(bundle).filter(f => f.type === 'chunk' && f.isEntry).map(f => fileOf(f.facadeModuleId)).filter(Boolean) });
  // per output of the build, by its output options object: Rollup and Rolldown pass the same one to every hook of an
  // output, and outputs written at the same time (Promise.all of write()s, as the rollup command line does) can share
  // their directory and format
  const modulesOf = new Map(); // output -> Set(module id), from renderChunk
  const written = new Map();   // output -> { target, writer, dir, pkgs, files, hashes, landed }
  const ordinals = new Map();  // output -> its position among the build's outputs (part of its writer id)
  let build = null; // the RolldownBuild of this plugin's rolldown() call (see esmWrap)
  // the build's input, part of its writer ids: from the options of the rollup()/rolldown() call the plugin was added to
  // (as given, see attach), else - a plugin configured by hand - from the options Rollup and Rolldown pass to buildStart
  let input = inputOptions && inputOptions.input;
  let since = 0;
  const write = (w) => new Promise((resolve) => {
    try {
      outputs.emitted(w.target, w.writer);
      const exists = (f, cb) => fs.lstat(f, (err) => cb(!err || err.code !== 'ENOENT'));
      outputs.prune(w.target, w.writer, exists, () => {
        outputs.rewrite(w.target, config.inline ? outputs.writeDisk(w.target) : null, (err) => {
          if (err) config.warn(`${kind}: could not write lockfile:`, err);
          resolve();
        });
      });
    } catch (e) { config.warn(`${kind}: could not write lockfile:`, e); resolve(); }
  });
  return {
    name: NAME,
    api: { setBuild(b) { build = b; } },
    buildStart(options) {
      written.clear(); modulesOf.clear(); ordinals.clear();
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
          // below node_modules is a tool's cache (Vite's dependency pre-bundling) or such a build too (plugin-legacy's).
          // without dir and file, Rolldown writes to dist/ (Rollup does not write at all); the hooks get neither
          const dir = path.resolve(cwd, out.dir || (out.file ? path.dirname(out.file) : this.meta && this.meta.rolldownVersion ? 'dist' : '.'));
          if (isWrite === false || dir.split(path.sep).includes('node_modules')) {
            const all = [];
            for (const f of Object.values(bundle)) {
              if (f.type !== 'chunk') continue;
              const own = packages.packagesOfFiles(moduleIds(f).map(fileOf).filter(Boolean), buildOf(bundle)).all;
              const pkgs = packages.unique(own, generatedIn({ [f.fileName]: f }, moduleIds(f)).values());
              generated.addChunk(f.code, pkgs);
              all.push(pkgs);
            }
            const pkgs = packages.unique(...all);
            for (const f of Object.values(bundle)) if (f.type === 'chunk' && f.isEntry) generated.addEntry(fileOf(f.facadeModuleId), pkgs);
            config.debug(`${kind}: generate-only output with`, pkgs.length, 'packages, kept for the build that uses it');
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
          const styles = [];
          for (const f of await watchFilesOf(this, build)) if (typeof f === 'string' && STYLE.test(f) && path.isAbsolute(f)) styles.push(f);
          sources.push(...styles);
          const { all, byFile } = packages.packagesOfFiles(sources, buildOf(bundle));
          const pkgs = packages.unique(all, generatedIn(bundle, ids).values());
          const { hashes, contents } = outputContents(bundle, dir, ids, originals, styles, byFile);
          const target = path.join(dir, config.file);
          const writer = outputWriter(kind, input, out, ordinals.get(out) || 0, cwd);
          written.set(out, { target, writer, dir, pkgs, files: new Set(files), hashes, contents, landed: false });
          outputs.record(target, writer, pkgs, cwd, files, { disk: true, outputs: hashes, contents });
        } catch (e) { config.warn(`${kind}: could not collect the bundled packages:`, e); }
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
        if (error) return;
        for (const w of written.values()) {
          if (!w.landed) continue;
          try {
            const late = filesWrittenAfter(w, since, cwd);
            const add = packages.unique(...late.map(l => l.pkgs)).filter(p => !w.pkgs.some(q => q.path === p.path));
            if (!add.length) continue;
            config.debug(`${kind}: files written into`, w.dir, 'after the build:', late.map(l => path.relative(w.dir, l.file)).join(' '), '- adding', add.map(p => `${p.name}@${p.version}`).join(' '));
            w.pkgs = packages.unique(w.pkgs, add);
            for (const l of late) w.files.add(l.file);
            outputs.record(w.target, w.writer, w.pkgs, cwd, [...w.files], { disk: true, outputs: w.hashes, contents: w.contents });
            await write(w);
          } catch (e) { config.warn(`${kind}: could not add the files written after the build:`, e); }
        }
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
  const kind = plugins.some(p => typeof p.name === 'string' && VITE.test(p.name)) ? 'vite' : id;
  if (config.isDisabled(kind)) { config.debug(`${kind}: disabled`); return options; }
  config.debug(`${kind}: adding the plugin to a ${id}() call`);
  return { ...options, plugins: [...[].concat(options.plugins == null ? [] : options.plugins), createPlugin(kind, options)] };
}

const each = (id, v) => (Array.isArray(v) ? v.map(o => attach(id, o)) : attach(id, v));

// rollup()/rolldown() with the plugin; the plugin gets the build the call returns (Rolldown's watch files, see
// watchFilesOf).
function wrapBuild(id, fn) {
  return function (options, ...rest) {
    const o = attach(id, options);
    const result = fn.call(this, o, ...rest);
    const plugin = o !== options && flat(o.plugins).find(p => p.name === NAME && p.api && p.api.setBuild);
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

  esmWrap(id, name, fn) {
    if (typeof fn !== 'function') return null;
    if (name === 'rollup' || name === 'rolldown') return wrapBuild(id, fn);
    if (name === 'watch' || name === 'build') return function (options, ...rest) { return fn.call(this, each(id, options), ...rest); };
    return null;
  },
  onCjsLoad(exp, request, resolve) {
    // the request first: reading a missing property of a module in a circular require() makes Node warn
    if (!request.endsWith('rollup.js') || !exp || typeof exp !== 'object' || typeof exp.rollupInternal !== 'function' || exp[PATCHED]) return;
    if (!CJS_ROLLUP.test(resolve())) return;
    exp[PATCHED] = true;
    const rollup = exp.rollup, internal = exp.rollupInternal;
    if (typeof rollup === 'function') exp.rollup = wrapBuild('rollup', rollup);
    exp.rollupInternal = wrapBuild('rollup', internal); // (options, watcher hooks)
    config.debug('rollup: patched its CommonJS build', resolve());
  },
  bundleLockfile: (kind = 'rollup', options = {}) => createPlugin(kind, options), // for a rollup/vite config, without injection
  attach,
  fileOf,
};
