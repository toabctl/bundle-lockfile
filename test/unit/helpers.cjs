'use strict';
// What the unit tests (test/unit/*.test.cjs) share. Each test file requires it first, before anything of src/:
// most tests check what is collected and written, with BUNDLE_LOCKFILE_STRICT=0 (problems are warnings, as they were
// before strict mode): set here, before src/core/config.cjs is loaded, and inherited by the child processes they start.
// The tests of strict mode (the default) set it themselves (strict.test.cjs).
process.env.BUNDLE_LOCKFILE_STRICT = '0';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const packages = require('../../src/core/packages.cjs');
const config = require('../../src/core/config.cjs');
const webpackAdapter = require('../../src/adapters/webpack.cjs');
// test/, where the unit tests' paths (bin/, oracles/, src/) are relative to
const TEST = path.join(__dirname, '..');

const { packagesForFiles } = packages;
// the environment of a child process with BUNDLE_LOCKFILE_STRICT unset (undefined) or set to v; a node run with it
const strictEnv = (v) => { const env = { ...process.env }; if (v === undefined) delete env.BUNDLE_LOCKFILE_STRICT; else env.BUNDLE_LOCKFILE_STRICT = v; return env; };
const nodeWith = (env, args) => spawnSync(process.execPath, args, { encoding: 'utf8', env });
const SRC = path.join(TEST, '../src');
const PATCHED = Symbol.for('bundle-lockfile.webpack.patched');
const J = (...p) => path.join(...p);
const pathToFileURLHref = (p) => require('url').pathToFileURL(p).href;
// a temporary project: { 'node_modules/a/package.json': {...} | 'text', ... }; returns its real path
function project(files) {
  const root = fs.realpathSync(fs.mkdtempSync(J(os.tmpdir(), 'blr-unit-')));
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(J(root, f)), { recursive: true });
    fs.writeFileSync(J(root, f), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}
// The bundlers of the tests' compilers and builds, in a project of their own: every output with JavaScript lists the
// bundler (core/bundler.cjs; tests of that in core.test.cjs), at version 0.0.0-unit - which the helpers that compare package lists
// leave out (ids, entries, lockedNames). The fake webpack compilers are patched ones (BUNDLER_FILE: their webpack's
// lib/Compiler.js); the Rollup plugin's hooks run from a file of rollup's or rolldown's (rollupBuild), as in a build of
// a plugin from the config, and Vite's config hook from one of vite's.
const UNIT = '0.0.0-unit';
const BUNDLER_FILE = Symbol.for('bundle-lockfile.webpack.bundler-file');
const BUNDLERS = (() => {
  const files = {};
  const CALL = 'module.exports = (fn, self, args) => fn.apply(self, args);\n';
  for (const [name, call] of [['webpack', 'lib/Compiler.js'], ['@rspack/core', 'dist/index.js'], ['rollup', 'dist/shared/rollup.js'], ['rolldown', 'dist/shared/call.js'], ['vite', 'dist/node/chunks/call.js']]) {
    files[`node_modules/${name}/package.json`] = { name, version: UNIT, license: 'MIT' };
    files[`node_modules/${name}/${call}`] = CALL;
  }
  const root = fs.realpathSync(fs.mkdtempSync(J(os.tmpdir(), 'blr-bundlers-')));
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(J(root, f)), { recursive: true });
    fs.writeFileSync(J(root, f), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return {
    root, webpack: J(root, 'node_modules/webpack/lib/Compiler.js'), rspack: J(root, 'node_modules/@rspack/core/dist/index.js'),
    rollup: require(J(root, 'node_modules/rollup/dist/shared/rollup.js')), rolldown: require(J(root, 'node_modules/rolldown/dist/shared/call.js')),
    vite: require(J(root, 'node_modules/vite/dist/node/chunks/call.js')),
  };
})();
const notUnit = (p) => p.version !== UNIT;
const ids = (pkgs) => pkgs.filter(notUnit).map(p => `${p.name}@${p.version}`).sort();
const pkg = (name, version, dir) => ({ name, version, path: dir });
// runs fn with config.warn recorded; returns the messages
function warnings(fn) {
  const orig = config.warn, seen = [];
  config.warn = (...a) => seen.push(a.join(' '));
  try { fn(); } finally { config.warn = orig; }
  return seen;
}
async function warningsOf(fn) {
  const orig = config.warn, seen = [];
  config.warn = (...a) => seen.push(a.join(' '));
  try { await fn(); } finally { config.warn = orig; }
  return seen;
}
const entries = (json) => Object.entries(JSON.parse(json).packages).filter(([k, p]) => k && notUnit(p));
const allEntries = (json) => Object.entries(JSON.parse(json).packages).filter(([k]) => k); // with the bundler
// a class that looks like webpack's Compiler
const fakeCompiler = () => class Compiler { compile() {} run() {} watch() {} newCompilation() {} isChild() { return false; } };
// minimal webpack 5 compilation: chunks of modules (entry: the chunk's entry modules), child compilations,
// assets with info
let outputDirs = 0;
// a new output directory below root: each compilation writes into its own
const newOutputDir = (root) => J(root, `dist-${++outputDirs}`);
function compilation({ context, outputPath = newOutputDir(context), chunks, children = [], assets = {}, clean }) {
  return {
    compiler: { context, outputPath, [BUNDLER_FILE]: BUNDLERS.webpack },
    outputOptions: { clean },
    chunks: chunks.map(c => ({ files: new Set(c.files || []), modules: c.modules, entry: c.entry || [] })),
    chunkGraph: { getChunkModulesIterable: (chunk) => chunk.modules, getChunkEntryModulesIterable: (chunk) => chunk.entry },
    moduleGraph: { getIssuer: (m) => m.issuer },
    children: children.map(c => compilation({ context, ...c })),
    getAsset: (name) => (name in assets ? { name, info: assets[name] } : undefined),
    getAssets: () => Object.entries(assets).map(([name, info]) => ({ name, info })),
  };
}
const LOCK = 'bundle-lockfile/package-lock.json';
const plugin = () => new webpackAdapter.BundleLockfilePlugin(LOCK);
const lockedNames = (json) => entries(json).map(([k]) => k.replace(/^node_modules\//, '')).sort();
// runs fn with config fields set (they are read when used); restores them afterwards
async function withConfig(fields, fn) {
  const saved = Object.fromEntries(Object.keys(fields).map(k => [k, config[k]]));
  Object.assign(config, fields);
  try { return await fn(); } finally { Object.assign(config, saved); }
}
// webpack-like compiler for apply(): records taps, runs them on demand
function fakeCompiler5({ outputPath, withWebpack = true }) {
  const taps = {};
  const hook = (name) => ({ tap: (o, fn) => (taps[name] = fn), tapAsync: (o, fn) => (taps[name] = fn) });
  const compiler = {
    context: path.dirname(outputPath), outputPath, name: 'fake', [BUNDLER_FILE]: BUNDLERS.webpack,
    hooks: { thisCompilation: hook('thisCompilation'), emit: hook('emit'), afterEmit: hook('afterEmit') },
    outputFileSystem: { writeFile: (f, c, cb) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); cb(); } },
  };
  if (withWebpack) compiler.webpack = { sources: { RawSource: class { constructor(s) { this.s = s; } source() { return this.s; } } } };
  return { compiler, taps };
}
// A compiler writing to outputPath through the plugin's real hooks (webpack 5 shape). Returns build(assets),
// which "emits" by writing the asset files (asset name -> file name on disk; null: none) and resolves once
// afterEmit has finished. Default: one asset <name>.js. Its module is in node_modules/<name>. onEmitAsset(name):
// called for assets the plugin emits. emitted: the assets after the emit hook, if a plugin replaced them there (asset
// name -> file name on disk).
function sharedCompiler(root, outputPath, name, onEmitAsset = () => {}) {
  const { compiler, taps } = fakeCompiler5({ outputPath });
  compiler.name = name;
  Object.assign(compiler.outputFileSystem, { stat: fs.stat, lstat: fs.lstat });
  compiler.options = { entry: { main: { import: [`./src/${name}.js`] } } };
  new webpackAdapter.BundleLockfilePlugin(LOCK).apply(compiler);
  return async (assets = { [`${name}.js`]: `${name}.js` }, emitted = assets) => {
    const infos = Object.fromEntries(Object.keys(assets).map(n => [n, {}]));
    const comp = compilation({ context: root, outputPath, chunks: [{ files: Object.keys(assets), modules: [{ resource: J(root, 'node_modules', name, 'i.js') }] }],
      assets: infos });
    comp.compiler = compiler;
    comp.emitAsset = (file) => onEmitAsset(file);
    comp.hooks = { afterProcessAssets: { tap: (o, fn) => (comp.stage = fn) } };
    taps.thisCompilation(comp);
    comp.stage();
    for (const n of Object.keys(infos)) if (!(n in emitted)) delete infos[n]; // the emit hook
    for (const n of Object.keys(emitted)) infos[n] = infos[n] || {};
    for (const file of Object.values(emitted)) if (file) fs.writeFileSync(J(outputPath, file), '');
    await new Promise(resolve => taps.afterEmit(comp, resolve));
  };
}
// runs the plugin's hooks like a rollup/rolldown build writing `outDir`; chunks: [{ fileName, code, modules, entry }]
// (entry: its facade module), assets: [{ fileName, originalFileNames, source }]; ctx: the plugin context (Rollup's
// getWatchFiles); late(): what other plugins do after the write, before the plugin's closeBundle
async function rollupBuild(rollupPlugin, { outDir, chunks = [], assets = [], isWrite = true, ctx = {}, late, input }) {
  const out = { dir: outDir, format: 'es' };
  if (rollupPlugin.config) BUNDLERS.vite(rollupPlugin.config, ctx, [{}]); // Vite runs it (core/bundler.cjs: Vite's package)
  // Rollup or Rolldown run the hooks
  BUNDLERS[ctx.meta && ctx.meta.rolldownVersion ? 'rolldown' : 'rollup'](rollupPlugin.buildStart, ctx, [{ input }]); // the (normalized) input options
  rollupPlugin.renderStart.call(ctx, out);
  for (const c of chunks) rollupPlugin.renderChunk.call(ctx, c.code, { moduleIds: c.modules }, out);
  // (a chunk `removed`: rendered, then taken out of the bundle by a plugin - Vite's chunks of style only)
  const bundle = Object.fromEntries([...chunks.filter(c => !c.removed).map(c => [c.fileName, { type: 'chunk', fileName: c.fileName, code: c.code, moduleIds: c.modules,
    isEntry: !!c.entry, facadeModuleId: c.entry || null, ...(c.css && { viteMetadata: { importedCss: new Set(c.css) } }) }]), ...assets.map(a => [a.fileName, { type: 'asset', fileName: a.fileName, ...a }])]);
  await rollupPlugin.generateBundle.handler.call(ctx, out, bundle, isWrite);
  if (isWrite) {
    for (const f of Object.values(bundle)) {
      fs.mkdirSync(path.dirname(J(outDir, f.fileName)), { recursive: true });
      fs.writeFileSync(J(outDir, f.fileName), f.type === 'chunk' ? f.code : f.source || '');
    }
    await rollupPlugin.writeBundle.handler.call(ctx, out);
  }
  if (late) late();
  await rollupPlugin.closeBundle.handler.call(ctx);
}
// runs node with a script; returns { status, stdout, stderr }
const node = (args, env = {}) => spawnSync(process.execPath, args, { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000 });
const recordOf = (json) => JSON.parse(json)['bundle-lockfile'];
const APPLIED_SYM = Symbol.for('bundle-lockfile.webpack.applied');
// the export of @rspack/core: the rspack() function with its classes; its Compiler has no newCompilation
function fakeRspack(rspackVersion) {
  class Compiler {
    compile(cb) { this.compiled = (this.compiled || 0) + 1; if (cb) cb(null); }
    run() {} watch() {} isChild() { return false; } runAsChild() {} createChildCompiler() {}
  }
  return Object.assign(function rspack() {}, { Compiler, Compilation: class {}, version: '5.75.0', rspackVersion });
}
// a compilation of rspack 2: chunks, assets with their bytes (assets: name -> { info, bytes }), file dependencies,
// all modules, options
function rspackCompilation(root, { chunks, assets = {}, fileDependencies = [], modules = [], optimization = {}, experiments = {}, exportsUsed = () => false, rspackVersion = '2.2.8' }) {
  const c = compilation({ context: root, chunks, assets: Object.fromEntries(Object.entries(assets).map(([n, a]) => [n, a.info || {}])) });
  c.compiler.webpack = { rspackVersion };
  c.compiler[BUNDLER_FILE] = BUNDLERS.rspack;
  c.compiler.options = { optimization, experiments };
  c.getAsset = (name) => (name in assets ? { name, info: assets[name].info || {}, source: { source: () => assets[name].bytes, size: () => Buffer.byteLength(assets[name].bytes) } } : undefined);
  c.fileDependencies = fileDependencies;
  c.modules = new Set([...chunks.flatMap(ch => ch.modules), ...modules]);
  c.moduleGraph = { getIssuer: () => null, getExportsInfo: (m) => ({ isModuleUsed: () => exportsUsed(m) }) };
  return c;
}
const esbuildAdapter = () => require('../../src/adapters/esbuild.cjs');
const ESBUILD_MAIN = '/p/node_modules/esbuild/lib/main.js';
// sets up the plugins of one build() or context() call (the caller's and bundle-lockfile's, last) on a fake build
// object: { loads (the onLoad callbacks, as wrapped), build(result) (one build: every onEnd in order; returns
// bundle-lockfile's) }. Builds of one call share the plugin, as a context's rebuilds do.
function esbuildCall(options, file) {
  const attached = esbuildAdapter().attach(options, file);
  const loads = [], ends = [];
  const b = { initialOptions: attached, onLoad: (o, cb) => loads.push(cb), onEnd: (cb) => ends.push(cb), onStart() {}, onResolve() {} };
  for (const p of attached.plugins) p.setup(b);
  return { loads, async build(result) { let r; for (const cb of ends) r = await cb(result); return r; } };
}
// The CommonJS hook in a child process: hooks.cjs with `adapter` (source of an object), after `before` ran; no ESM hooks
const cjsHookScript = (adapter, before = '', after = '') => `const Module = require('module');
  ${before}
  const hooks = require(${JSON.stringify(J(SRC, 'hooks.cjs'))});
  hooks.register(${adapter});
  hooks.install();
  ${after}`;
const cjsEnv = (strict) => ({ ...strictEnv(strict), BUNDLE_LOCKFILE_ESM_HOOKS: 'off' });
const nft = (files, extra = {}) => ({ version: 1, files, ...extra });

module.exports = {
  TEST, packagesForFiles, strictEnv, nodeWith, SRC, PATCHED, J, pathToFileURLHref, project, UNIT, BUNDLER_FILE,
  BUNDLERS, notUnit, ids, pkg, warnings, warningsOf, entries, allEntries, fakeCompiler, newOutputDir, compilation,
  LOCK, plugin, lockedNames, withConfig, fakeCompiler5, sharedCompiler, rollupBuild, node, recordOf, APPLIED_SYM,
  fakeRspack, rspackCompilation, esbuildAdapter, ESBUILD_MAIN, esbuildCall, cjsHookScript, cjsEnv, nft,
};
