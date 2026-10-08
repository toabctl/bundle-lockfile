'use strict';
// Rollup, Rolldown and everything built on them: Vite 5-7 (rollup), Vite 8 (rolldown), Vite-based frameworks,
// programmatic rollup()/rolldown()/build() calls. Their public entry modules (ESM) are wrapped (see hooks.cjs,
// esm-wrap.cjs) so that every rollup()/rolldown()/watch()/build() call gets one more plugin, which writes
// <output dir>/<BUNDLE_LOCKFILE_FILE> for every output the build writes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../core/config.cjs');
const packages = require('../core/packages.cjs');
const outputs = require('../core/outputs.cjs');

const NAME = 'bundle-lockfile';
const VITE = /^(vite:|builtin:vite-)/; // Vite's own plugins (Vite 8 has native builtin: ones)

const flat = (plugins) => [].concat(plugins == null ? [] : plugins).flat(Infinity).filter(p => p && typeof p === 'object' && !(typeof p.then === 'function'));
const sha256 = (s) => `sha256-${crypto.createHash('sha256').update(s).digest('hex')}`;
const realCwd = () => { try { return fs.realpathSync(process.cwd()); } catch { return process.cwd(); } };

// Source file of a module id: virtual modules (\0vite/..., \0commonjsHelpers.js, virtual:...) have none; a
// \0-prefixed absolute id (rollup's commonjs proxies) and ids with queries (?vue&type=style, ?inline, ?worker) are
// the file before them.
function fileOf(id) {
  if (typeof id !== 'string') return null;
  const f = id.replace(/^\0/, '').split(/[?#]/)[0];
  return path.isAbsolute(f) ? path.normalize(f) : null;
}

// The writer of one output (see core/outputs.cjs): the same input, format and position in the build's outputs,
// without paths of this machine.
function writerOf(kind, input, out, ordinal, cwd) {
  const rel = (v) => (typeof v === 'string' && path.isAbsolute(v) ? path.relative(cwd, v).split(path.sep).join('/') : v);
  const inputs = typeof input === 'string' ? rel(input) : Array.isArray(input) ? input.map(rel)
    : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).map(([k, v]) => [k, rel(v)])) : null;
  return JSON.stringify([kind, inputs, out.format || null, ordinal, typeof out.entryFileNames === 'string' ? out.entryFileNames : null]);
}

function createPlugin(kind, inputOptions) {
  const cwd = realCwd();
  const modulesOf = new Map(); // output key -> Set(module id), from renderChunk
  const written = new Map();   // output key -> { target, writer }
  const ordinals = new Map();
  const keyOf = (out) => `${out.dir || ''}\0${out.file || ''}\0${out.format || ''}`;
  return {
    name: NAME,
    renderStart(out) {
      const key = keyOf(out);
      if (!ordinals.has(key)) ordinals.set(key, ordinals.size);
      modulesOf.set(key, new Set());
    },
    // before generateBundle: plugins that remove chunks there (vite-plugin-singlefile) cannot hide their modules
    renderChunk(code, chunk, out) {
      const ids = modulesOf.get(keyOf(out));
      if (ids) for (const id of chunk.moduleIds || Object.keys(chunk.modules || {})) ids.add(id);
      return null;
    },
    generateBundle: {
      order: 'post',
      handler(out, bundle, isWrite) {
        try {
          // generate-only builds (Vite's workers and legacy polyfills, write: false, Vite 8 bundling its config) write
          // nothing; an output below node_modules is a tool's cache (Vite's dependency pre-bundling)
          if (isWrite === false) return;
          const dir = path.resolve(cwd, out.dir || (out.file ? path.dirname(out.file) : '.'));
          if (dir.split(path.sep).includes('node_modules')) return;
          const key = keyOf(out);
          const ids = new Set(modulesOf.get(key) || []);
          const sources = [], files = [], hashes = {};
          for (const f of Object.values(bundle)) {
            files.push(path.join(dir, f.fileName));
            if (f.type === 'chunk') {
              for (const id of f.moduleIds || Object.keys(f.modules || {})) ids.add(id);
              hashes[path.join(dir, f.fileName)] = sha256(f.code); // to find its packages when another build bundles it
            } else {
              // assets emitted from a file (Vite: relative to its root, usually the working directory)
              for (const n of f.originalFileNames || (f.originalFileName ? [f.originalFileName] : [])) {
                const p = path.resolve(cwd, n);
                if (fs.existsSync(p)) sources.push(p);
              }
            }
          }
          for (const id of ids) { const file = fileOf(id); if (file) sources.push(file); }
          const target = path.join(dir, config.file);
          const writer = writerOf(kind, inputOptions && inputOptions.input, out, ordinals.get(key) || 0, cwd);
          written.set(key, { target, writer });
          outputs.record(target, writer, packages.packagesOfOutput(sources), cwd, files, { disk: true, outputs: hashes });
        } catch (e) { config.warn(`${kind}: could not collect the bundled packages:`, e); }
      },
    },
    writeBundle: {
      order: 'post',
      handler(out) {
        const w = written.get(keyOf(out));
        if (!w) return undefined;
        return new Promise((resolve) => {
          try {
            outputs.emitted(w.target, w.writer);
            const exists = (f, cb) => fs.lstat(f, (err) => cb(!err || err.code !== 'ENOENT'));
            const writeFile = (json, cb) => {
              try { fs.mkdirSync(path.dirname(w.target), { recursive: true }); fs.writeFile(w.target, json, cb); } catch (e) { cb(e); }
            };
            outputs.prune(w.target, w.writer, exists, () => {
              outputs.rewrite(w.target, config.inline ? writeFile : null, (err) => {
                if (err) config.warn(`${kind}: could not write lockfile:`, err);
                resolve();
              });
            });
          } catch (e) { config.warn(`${kind}: could not write lockfile:`, e); resolve(); }
        });
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

module.exports = {
  name: 'rollup',
  names: ['rollup', 'rolldown', 'vite'],
  esmEntries: [
    { id: 'rollup', suffixes: ['/rollup/dist/es/rollup.js', '/@rollup/wasm-node/dist/es/rollup.js'], wrap: ['rollup', 'watch'] },
    { id: 'rolldown', suffixes: ['/rolldown/dist/index.mjs'], wrap: ['rolldown', 'watch', 'build'] },
  ],
  esmPackages: ['vite', 'rollup', 'rolldown', 'rolldown-vite'],
  esmWrap(id, name, fn) {
    if (typeof fn !== 'function') return null;
    if (name === 'rollup' || name === 'rolldown') return function (options, ...rest) { return fn.call(this, attach(id, options), ...rest); };
    if (name === 'watch' || name === 'build') return function (options, ...rest) { return fn.call(this, each(id, options), ...rest); };
    return null;
  },
  bundleLockfile: (kind = 'rollup', options = {}) => createPlugin(kind, options), // for a rollup/vite config, without injection
  attach,
  fileOf,
};
