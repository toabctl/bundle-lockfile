'use strict';
// Comparison tooling (not used by the tests): attaches @cyclonedx/webpack-plugin and a diagnostics
// plugin to every top-level webpack 5 compiler, without config changes - the same way bundle-lockfile
// attaches itself. It loads bundle-lockfile too, so one --require is enough (Next.js 15 mangles several:
// "--require A --require B" reaches its build workers as the single path "A B"):
//   NODE_OPTIONS="--require <repo>/test/compare/inject-cyclonedx.cjs"
//   BUNDLE_LOCKFILE_CDX_DIR=<dir whose node_modules contains @cyclonedx/webpack-plugin>
// Per compiler output it writes cyclonedx/bom.json (the plugin's default) and
// bundle-lockfile-compare/diag.json: packages of all modules webpack processed vs. those in emitted chunks.
const Module = require('module');
const path = require('path');
require('../../src/register.cjs');
const { packagesForFiles } = require('../../src/core/packages.cjs');

const APPLIED = Symbol.for('bundle-lockfile.compare.applied');
const PATCHED = Symbol.for('bundle-lockfile.compare.patched');
const NEXT_WEBPACK = /[\\/]next[\\/]dist[\\/]compiled[\\/]webpack[\\/]webpack(\.js)?$/;
const cdxDir = process.env.BUNDLE_LOCKFILE_CDX_DIR;
if (!cdxDir) throw new Error('inject-cyclonedx: set BUNDLE_LOCKFILE_CDX_DIR');
const { CycloneDxWebpackPlugin } = Module.createRequire(path.join(path.resolve(cdxDir), 'package.json'))('@cyclonedx/webpack-plugin');

const fileOf = (m) => m.resource || (typeof m.nameForCondition === 'function' ? m.nameForCondition() : null);
const ids = (files) => packagesForFiles(files).map(p => `${p.name}@${p.version}`).sort();
// like ids(), but also counts packages outside node_modules (to explain first-party packages CycloneDX lists)
const fs = require('fs');
function idsAll(files) {
  const out = new Set();
  for (const f of files) {
    for (let d = path.dirname(f.split('?')[0]); d !== path.dirname(d); d = path.dirname(d)) {
      let j; try { j = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')); } catch { continue; }
      if (j.name && j.version) { out.add(`${j.name}@${j.version}`); break; }
    }
  }
  return [...out].sort();
}

class DiagnosticsPlugin {
  apply(compiler) {
    const { Compilation, sources } = compiler.webpack;
    compiler.hooks.thisCompilation.tap('bundle-lockfile-compare', (compilation) => {
      compilation.hooks.processAssets.tap({ name: 'bundle-lockfile-compare', stage: Compilation.PROCESS_ASSETS_STAGE_REPORT }, () => {
        const all = new Set(), inChunks = new Set();
        const walk = (set) => (m) => { const f = fileOf(m); if (f) set.add(f); (m.modules || []).forEach(walk(set)); };
        for (const m of compilation.modules) walk(all)(m);
        for (const c of compilation.chunks) for (const m of compilation.chunkGraph.getChunkModulesIterable(c)) walk(inChunks)(m);
        compilation.emitAsset('bundle-lockfile-compare/diag.json', new sources.RawSource(JSON.stringify({
          compiler: compiler.name || null, processed: ids(all), inChunks: ids(inChunks), processedAll: idsAll(all),
        }, null, 2)));
      });
    });
  }
}

function patch(Compiler) {
  if (typeof Compiler !== 'function' || !Compiler.prototype || Compiler.prototype[PATCHED]) return;
  const p = Compiler.prototype;
  if (!['compile', 'run', 'watch', 'newCompilation', 'isChild'].every(k => typeof p[k] === 'function')) return;
  p[PATCHED] = true;
  const orig = p.compile;
  p.compile = function (...args) {
    if (!this[APPLIED] && this.webpack && !this.isChild()) { // webpack 5 only (CycloneDX needs it)
      this[APPLIED] = true;
      new CycloneDxWebpackPlugin({ specVersion: '1.6', outputLocation: './cyclonedx', includeWellknown: false, validateResults: false }).apply(this);
      new DiagnosticsPlugin().apply(this);
    }
    return orig.apply(this, args);
  };
}

const origLoad = Module._load;
Module._load = function (request, parent) {
  const exp = origLoad.apply(this, arguments);
  try {
    if (typeof exp === 'function') {
      if (exp.name === 'Compiler') patch(exp);
      else if (exp.Compiler && exp.Compilation && exp.version) patch(exp.Compiler);
    } else if (exp && typeof exp === 'object' && request.includes('webpack') && exp.webpack && exp.webpack.Compiler) {
      let where = request; try { where = Module._resolveFilename(request, parent); } catch { /* keep request */ }
      if (NEXT_WEBPACK.test(where)) patch(exp.webpack.Compiler);
    }
  } catch (e) { console.error('[bundle-lockfile-compare] WARNING:', e); }
  return exp;
};
