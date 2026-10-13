// Comparison tooling (not used by the tests): attaches @cyclonedx/webpack-plugin and a diagnostics
// plugin to every top-level webpack 5 compiler, without config changes - through bundle-lockfile's own
// compiler hook (onCompiler), so both see the same compilers. It loads bundle-lockfile too, so one --require is enough (Next.js 15.0-16.3 mangle several:
// "--require A --require B" reaches its build workers as the single path "A B"):
//   NODE_OPTIONS="--require <repo>/test/compare/inject-cyclonedx.cjs"
//   BLTEST_CDX_DIR=<dir whose node_modules contains @cyclonedx/webpack-plugin>
// Per compiler output it writes cyclonedx/bom.json (the plugin's default) and
// bundle-lockfile-compare/diag-<compiler>.json: packages of all modules webpack processed vs. those in the emitted
// output (one file per compiler: several can write to one output directory). The diagnostics share no code with
// bundle-lockfile's collection or attribution: what is emitted comes from webpack's stats through the oracles' code
// (test/oracles/stats.cjs, owner.cjs), as in rspack-stats.cjs - so they explain a difference independently.
const fs = require('fs');
const Module = require('module');
const path = require('path');
require('../../src/register.cjs');
const webpackAdapter = require('../../src/adapters/webpack.cjs');
const owner = require('../oracles/owner.cjs');
const { STATS_OPTIONS, packagesFromStats, copiedFiles } = require('../oracles/stats.cjs');

const cdxDir = process.env.BLTEST_CDX_DIR;
if (!cdxDir) throw new Error('inject-cyclonedx: set BLTEST_CDX_DIR');
const { CycloneDxWebpackPlugin } = Module.createRequire(path.join(path.resolve(cdxDir), 'package.json'))('@cyclonedx/webpack-plugin');

const fileOf = (m) => (typeof m.nameForCondition === 'function' ? m.nameForCondition() : m.resource) || null;
// packages of files OUTSIDE node_modules (first-party, e.g. workspace packages), by nearest package.json -
// to explain first-party packages CycloneDX lists
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
// the directory below the last node_modules of a file (@scope/name: two levels), or null
function rootOf(file) {
  const parts = file.split(path.sep);
  const i = parts.lastIndexOf('node_modules');
  if (i < 0 || i + 2 >= parts.length) return null;
  const n = parts[i + 1].startsWith('@') ? 2 : 1;
  return i + n + 1 < parts.length ? parts.slice(0, i + 1 + n).join(path.sep) : null;
}
// packages vendored INSIDE another package (e.g. next/dist/compiled/@edge-runtime/cookies): the nearest
// package.json with name and version is below the package root - to explain what CycloneDX lists for them
function idsVendored(files) {
  const out = new Set();
  for (const f of files) {
    const file = f.split('?')[0];
    const root = rootOf(file);
    if (!root) continue;
    for (let d = path.dirname(file); d.startsWith(root + path.sep); d = path.dirname(d)) {
      let j; try { j = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')); } catch { continue; }
      if (j.name && j.version) { out.add(`${j.name}@${j.version}`); break; }
    }
  }
  return [...out].sort();
}

let unnamed = 0;
class DiagnosticsPlugin {
  apply(compiler) {
    const file = `bundle-lockfile-compare/diag-${(compiler.name || `compiler-${++unnamed}`).replace(/[^\w.-]/g, '_')}.json`;
    compiler.hooks.done.tap('bundle-lockfile-compare', (stats) => {
      try {
        const compilation = stats.compilation;
        const all = new Set();
        const walk = (m) => { const f = fileOf(m); if (f && path.isAbsolute(f.split('?')[0])) all.add(f); (m.modules || []).forEach(walk); };
        for (const m of compilation.modules) walk(m);
        const outputPath = compilation.getPath(compiler.outputPath, {});
        const json = stats.toJson(STATS_OPTIONS);
        const bundled = packagesFromStats(json, compiler.context, copiedFiles(compilation, json, outputPath));
        fs.mkdirSync(path.dirname(path.join(outputPath, file)), { recursive: true });
        fs.writeFileSync(path.join(outputPath, file), JSON.stringify({
          compiler: compiler.name || null, processed: owner.packagesOf(all, { context: compiler.context }), bundled,
          firstParty: idsFirstParty(all), vendored: idsVendored(all),
        }, null, 2));
      } catch (e) { console.error('[inject-cyclonedx] could not write the diagnostics:', e); }
    });
  }
}
// every top-level compiler bundle-lockfile attaches to; webpack 5 only (CycloneDX needs compiler.webpack)
webpackAdapter.onCompiler((compiler) => {
  if (!compiler.webpack) return;
  new CycloneDxWebpackPlugin({ specVersion: '1.6', outputLocation: './cyclonedx', includeWellknown: false, validateResults: false }).apply(compiler);
  new DiagnosticsPlugin().apply(compiler);
});
