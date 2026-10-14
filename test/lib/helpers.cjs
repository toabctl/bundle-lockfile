'use strict';
// The transpiler helpers the tests expect, independent of src/core/helpers.cjs (which reads the module objects, their
// loaders and the process's loaded copies): from webpack's stats - a module's source after its loaders, and the loader
// chain its identifier names - and from Rollup's source maps (the helpers module @rollup/plugin-babel adds). A helper
// is a function (Babel: function _classCallCheck(, swc: function _class_call_check() or TypeScript's
// var __awaiter = (this && this.__awaiter) || that a module's code has and its file does not; it is the code of the
// package the loader resolves: babel-loader's @babel/core's @babel/helpers, swc-loader's @swc/core, ts-loader's
// typescript. name@version, as the package.json says.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const LOADERS = [
  { test: /[\\/]babel-loader[\\/]/, chain: ['@babel/core', '@babel/helpers'], names: /function _(\w+)\s*\(/g },
  { test: /[\\/]swc-loader[\\/]/, chain: ['@swc/core'], names: /function _(\w+)\s*\(/g },
  { test: /[\\/]ts-loader[\\/]/, chain: ['typescript'], names: /var (__\w+) = \(this && this\.\1\) \|\|/g },
];
const idOf = (file) => { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return `${j.name}@${j.version}`; };
// the package.json of the last package of `chain`, each resolved from the one before (the first from `from`)
// (a package whose exports have no ./package.json: its main file's directory, upwards)
function resolveChain(from, chain) {
  let at = from;
  for (const name of chain) {
    const req = createRequire(at);
    let next = null;
    try { next = req.resolve(`${name}/package.json`); } catch {
      let main;
      try { main = req.resolve(name); } catch { return null; }
      for (let d = path.dirname(main); d !== path.dirname(d); d = path.dirname(d)) {
        const pj = path.join(d, 'package.json');
        try { if (JSON.parse(fs.readFileSync(pj, 'utf8')).name === name) { next = pj; break; } } catch { /* up */ }
      }
    }
    if (!next) return null;
    at = next;
  }
  return at;
}
const namesIn = (code, re) => new Set([...String(code || '').matchAll(re)].map(m => m[1]));

// The loaders of a stats module (its identifier: "<loader>??<ident>!<loader>?<options>!<resource>"), as absolute paths
const loadersOf = (identifier) => String(identifier || '').split('!').slice(0, -1).map(p => p.split('?')[0]).filter(p => path.isAbsolute(p));
const resourceOf = (identifier) => (String(identifier || '').split('!').pop().split('|').find(s => path.isAbsolute(s)) || '').split('?')[0];

// name@version of the transpilers whose helpers are in the shipped modules of a webpack stats JSON (toJson with
// modules, nestedModules, chunks and source)
function ofStats(json) {
  const out = new Set();
  const look = (m) => {
    for (const l of LOADERS) {
      const loader = loadersOf(m.identifier).find(f => l.test.test(f));
      if (!loader) continue;
      const file = resourceOf(m.identifier);
      let original = '';
      try { original = fs.readFileSync(file, 'utf8'); } catch { /* none */ }
      const had = namesIn(original, l.names);
      if (![...namesIn(m.source, l.names)].some(n => !had.has(n))) continue;
      const pj = resolveChain(loader, l.chain);
      if (pj) out.add(idOf(pj));
    }
    (m.modules || []).forEach(look);
  };
  for (const m of json.modules || []) if ((m.chunks || []).length) look(m);
  return [...out].sort();
}

// Rollup: Babel's helpers in the JavaScript an output has (the oracle builds without a minifier), not in any of its
// source files - with @rollup/plugin-babel's bundled helpers a module of their own that no map names (it has none): the
// @babel/helpers of the @babel/core the plugin resolves (from the fixture). out: the output directory; sources: the
// maps' source files.
function ofRollupOutput(out, sources, cwd = '.') {
  const js = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.[cm]?js$/.test(e.name)) js.push(p); } };
  try { walk(out); } catch { return []; }
  const re = LOADERS[0].names;
  const inOutput = new Set(js.flatMap(f => [...namesIn(fs.readFileSync(f, 'utf8'), re)]));
  const had = new Set();
  for (const f of sources) { try { for (const n of namesIn(fs.readFileSync(f, 'utf8'), re)) had.add(n); } catch { /* virtual */ } }
  if (![...inOutput].some(n => !had.has(n))) return [];
  const pj = resolveChain(path.join(path.resolve(cwd), 'x.js'), ['@rollup/plugin-babel', '@babel/core', '@babel/helpers']);
  return pj ? [idOf(pj)] : [];
}

module.exports = { ofStats, ofRollupOutput };
