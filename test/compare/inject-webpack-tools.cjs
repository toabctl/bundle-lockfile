// Comparison tooling (not used by the tests): attaches other tools that list a webpack build's packages - the
// CycloneDX webpack plugin, license-webpack-plugin, webpack-license-plugin - and a diagnostics plugin to every
// top-level webpack 5 compiler, without config changes: through bundle-lockfile's own compiler hook (onCompiler), so
// all see the same compilers. It loads bundle-lockfile too, so one --require is enough (Next.js 15.0-16.3 mangle
// several: "--require A --require B" reaches its build workers as the single path "A B"):
//   NODE_OPTIONS="--require <repo>/test/compare/inject-webpack-tools.cjs"
//   BLTEST_COMPARE_DIR=<dir whose node_modules has the tools; one that is not installed there is left out>
// Per compiler output: cyclonedx/bom.json (CycloneDX's default), bundle-lockfile-compare/lwp.json and wlp.json (the
// license plugins' package lists), and bundle-lockfile-compare/diag-<compiler>.json: the packages of all modules webpack
// processed (also in child compilations), those in the emitted output, style sheets among the file dependencies, and
// the package.json files a nearest-manifest tool sees (one file per compiler: several can write to one output
// directory). The diagnostics share no code with bundle-lockfile's collection or attribution: what is emitted comes
// from webpack's stats through the oracles' code (test/oracles/stats.cjs, owner.cjs), as in rspack-stats.cjs; the
// manifests from test/compare/manifests.cjs - so they explain a difference independently.
const fs = require('fs');
const Module = require('module');
const path = require('path');
require('../../src/register.cjs');
const webpackAdapter = require('../../src/adapters/webpack.cjs');
const owner = require('../oracles/owner.cjs');
const { STATS_OPTIONS, packagesFromStats, copiedFiles } = require('../oracles/stats.cjs');
const { nearest } = require('./manifests.cjs');

const toolsDir = process.env.BLTEST_COMPARE_DIR;
if (!toolsDir) throw new Error('inject-webpack-tools: set BLTEST_COMPARE_DIR');
const toolRequire = Module.createRequire(path.join(path.resolve(toolsDir), 'package.json'));
const optional = (name) => { try { return toolRequire(name); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; return null; } };
// BLTEST_COMPARE_TOOLS=cyclonedx,lwp,wlp: only these (fixtures.sh retries a build that one of them breaks without it)
const only = process.env.BLTEST_COMPARE_TOOLS !== undefined ? process.env.BLTEST_COMPARE_TOOLS.split(',').filter(Boolean) : null;
const pick = (key, name) => (!only || only.includes(key) ? optional(name) : null);
const cdx = pick('cyclonedx', '@cyclonedx/webpack-plugin'), lwp = pick('lwp', 'license-webpack-plugin'), wlp = pick('wlp', 'webpack-license-plugin');

const STYLE = /\.(css|scss|sass|less|styl|stylus|pcss|postcss|sss)$/i;
const fileOf = (m) => (typeof m.nameForCondition === 'function' ? m.nameForCondition() : m.resource) || null;
const absolute = (f) => f && path.isAbsolute(f.split('?')[0]);
const modulesFiles = (modules, into = new Set()) => {
  const walk = (m) => { const f = fileOf(m); if (absolute(f)) into.add(f); (m.modules || []).forEach(walk); };
  for (const m of modules) walk(m);
  return into;
};
// packages of files OUTSIDE node_modules (first-party, e.g. workspace packages), by nearest package.json -
// to explain first-party packages the tools list
function idsFirstParty(files) {
  const out = new Set();
  for (const f of files) {
    if (f.split(path.sep).includes('node_modules')) continue;
    for (let d = path.dirname(f.split('?')[0]); d !== path.dirname(d); d = path.dirname(d)) {
      let j; try { j = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')); } catch { continue; }
      if (j.name && j.version) { out.add(`${j.name}@${j.version}`); break; }
    }
  }
  return [...out].sort();
}

// The files the license plugins read from a compilation's chunks, as they read them - from webpack's own data, to say
// why one misses a package: license-webpack-plugin takes the chunk modules' resources and the inner modules of
// concatenated modules by their stats identifiers, which for an ES module are "javascript/esm|<path>" and lead to no
// file (xz64/license-webpack-plugin#116); webpack-license-plugin takes a concatenated module's root module and the
// modules its dependencies come from, not its leaf modules.
function readByLicensePlugins(compilation) {
  const lwpFiles = new Set(), wlpFiles = new Set();
  const graph = compilation.moduleGraph;
  for (const chunk of compilation.chunks) {
    const mods = [...compilation.chunkGraph.getChunkModulesIterable(chunk), ...compilation.chunkGraph.getChunkEntryModulesIterable(chunk)];
    for (const m of mods) {
      if (absolute(m.resource)) { lwpFiles.add(m.resource); wlpFiles.add(m.resource); }
      if (m.rootModule && absolute(m.rootModule.resource)) wlpFiles.add(m.rootModule.resource);
      for (const d of m.dependencies || []) {
        for (const o of [d.originModule, graph && graph.getParentModule(d)]) if (o && absolute(o.resource)) wlpFiles.add(o.resource);
      }
      const walk = (x) => {
        for (const i of x.modules || []) {
          const id = i.identifier();
          if (!id.includes('|')) { const f = id.split('!').pop(); if (absolute(f)) lwpFiles.add(f); }
          walk(i);
        }
      };
      walk(m);
    }
  }
  return { lwpFiles, wlpFiles };
}

let unnamed = 0;
class DiagnosticsPlugin {
  apply(compiler) {
    const file = `bundle-lockfile-compare/diag-${(compiler.name || `compiler-${++unnamed}`).replace(/[^\w.-]/g, '_')}.json`;
    compiler.hooks.done.tap('bundle-lockfile-compare', (stats) => {
      try {
        const compilation = stats.compilation;
        const all = modulesFiles(compilation.modules);
        const children = new Set();
        const walkChildren = (c) => { for (const ch of c.children || []) { modulesFiles(ch.modules, children); walkChildren(ch); } };
        walkChildren(compilation);
        const style = [...(compilation.fileDependencies || [])].filter(f => STYLE.test(f) && f.split(path.sep).includes('node_modules'));
        const outputPath = compilation.getPath(compiler.outputPath, {});
        const json = stats.toJson(STATS_OPTIONS);
        const copies = copiedFiles(compilation, json, outputPath);
        const bundled = packagesFromStats(json, compiler.context, copies);
        // assets copied from a package file: the source an asset records (copy-webpack-plugin 6.3+), or the file with its bytes
        const copied = [...copies, ...(json.assets || []).map(a => a.info && a.info.sourceFilename).filter(Boolean)
          .map(f => path.resolve(compiler.context, f)).filter(f => fs.existsSync(f))];
        const { nested, unlicensed } = nearest([...all, ...children]);
        const lwpFiles = new Set(), wlpFiles = new Set();
        for (const c of [compilation, ...(function kids(c) { return (c.children || []).flatMap(ch => [ch, ...kids(ch)]); })(compilation)]) {
          const r = readByLicensePlugins(c);
          r.lwpFiles.forEach(f => lwpFiles.add(f)); r.wlpFiles.forEach(f => wlpFiles.add(f));
        }
        fs.mkdirSync(path.dirname(path.join(outputPath, file)), { recursive: true });
        fs.writeFileSync(path.join(outputPath, file), JSON.stringify({
          compiler: compiler.name || null, processed: owner.packagesOf(all, { context: compiler.context }), bundled,
          childProcessed: owner.packagesOf(children, { context: compiler.context }), style: owner.packagesOf(style, { context: compiler.context }),
          copied: owner.packagesOf(copied, { context: compiler.context }), firstParty: idsFirstParty([...all, ...children]), nested, unlicensed,
          readBy: { lwp: owner.packagesOf(lwpFiles, { context: compiler.context }), wlp: owner.packagesOf(wlpFiles, { context: compiler.context }) },
        }, null, 2));
      } catch (e) { console.error('[inject-webpack-tools] could not write the diagnostics:', e); }
    });
  }
}
// name@version of the license plugins' packages: '' for a missing version
const listOf = (mods) => JSON.stringify(mods.map(m => ({ name: m.name, version: m.version })), null, 2);
// every top-level compiler bundle-lockfile attaches to; webpack 5 only (the tools need compiler.webpack)
webpackAdapter.onCompiler((compiler) => {
  if (!compiler.webpack) return;
  if (cdx) new cdx.CycloneDxWebpackPlugin({ specVersion: '1.6', outputLocation: './cyclonedx', includeWellknown: false, validateResults: false }).apply(compiler);
  // its defaults otherwise (child compilations included); one list per compilation, not per chunk
  if (lwp) new lwp.LicenseWebpackPlugin({ perChunkOutput: false, addBanner: false, outputFilename: 'bundle-lockfile-compare/lwp.json',
    renderLicenses: (modules) => listOf(modules.map(m => ({ name: m.packageJson.name || m.name, version: m.packageJson.version || '' }))) }).apply(compiler);
  if (wlp) new (wlp.default || wlp)({ outputFilename: 'bundle-lockfile-compare/wlp.json' }).apply(compiler);
  new DiagnosticsPlugin().apply(compiler);
});
