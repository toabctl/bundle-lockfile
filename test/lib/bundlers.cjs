'use strict';
// The bundler packages of the tests, independent of bundle-lockfile's src/core/bundler.cjs: every output with
// JavaScript lists the bundler whose code is in it (webpack, @rspack/core, Rollup, Rolldown, Vite, esbuild, Parcel's
// @parcel/packager-js). The oracles name the
// copies their own builds ran (their versions from those packages' package.json files, or the bundler's own version);
// run.cjs checks the rest of every case with these helpers.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const NAMES = new Set(['webpack', '@rspack/core', 'rollup', '@rollup/wasm-node', 'rolldown', 'vite', 'rolldown-vite', 'esbuild', 'esbuild-wasm', '@parcel/packager-js']);
const nameOf = (id) => id.slice(0, id.lastIndexOf('@'));
const isBundler = (id) => NAMES.has(nameOf(id));
const without = (list) => list.filter(id => !isBundler(id));

// The output directory has a JavaScript file (not below its bundle-lockfile directory, not a source map)
function hasJs(dir) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of list) {
    if (e.isDirectory()) { if (e.name !== 'bundle-lockfile' && hasJs(path.join(dir, e.name))) return true; }
    else if (/\.[cm]?js$/.test(e.name)) return true;
  }
  return false;
}

// name@version of the package.json of the package `name` that `from` (a directory) resolves (also a package without
// ./package.json in its exports: the directory of its main file, upwards), or null
function resolved(name, from) {
  const req = createRequire(path.join(path.resolve(from), 'x.js'));
  try { const j = JSON.parse(fs.readFileSync(req.resolve(`${name}/package.json`), 'utf8')); return `${j.name}@${j.version}`; } catch { /* below */ }
  let f;
  try { f = req.resolve(name); } catch { return null; }
  for (let d = path.dirname(f); d !== path.dirname(d); d = path.dirname(d)) {
    try { const j = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')); if (j.name === name) return `${j.name}@${j.version}`; } catch { /* up */ }
  }
  return null;
}
const dirOf = (name, from) => { try { return path.dirname(createRequire(path.join(path.resolve(from), 'x.js')).resolve(`${name}/package.json`)); } catch { return null; } };

// Vite's package that `from` resolves (vite, or rolldown-vite installed as vite) and the bundler it builds with: Rollup
// (Vite 5 - 7) or Rolldown (Vite 8, rolldown-vite), as its package.json depends on - name@version of both
function viteBundlers(from = '.') {
  const dir = dirOf('vite', from);
  if (!dir) return [];
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const deps = { ...j.dependencies, ...j.peerDependencies };
  const inner = deps.rolldown ? 'rolldown' : 'rollup';
  return [`${j.name}@${j.version}`, resolved(inner, dir)].filter(Boolean);
}

// Every bundler package installed below dir (node_modules trees, pnpm's .pnpm, nested copies): name@version
function installed(dir) {
  const out = new Set();
  const seen = new Set();
  const nm = (d) => {
    let real;
    try { real = fs.realpathSync(d); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.name.startsWith('@')) {
        let inner = [];
        try { inner = fs.readdirSync(p); } catch { /* none */ }
        for (const n of inner) pkg(path.join(p, n));
      } else if (e.name === '.pnpm' || e.name === '.store') {
        for (const n of fs.readdirSync(p)) { nm(path.join(p, n, 'node_modules')); pkg(path.join(p, n, 'package')); }
      } else pkg(p);
    }
  };
  const pkg = (p) => {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')); } catch { /* none */ }
    if (j && NAMES.has(j.name)) out.add(`${j.name}@${j.version}`); // (also under an alias)
    nm(path.join(p, 'node_modules'));
  };
  nm(path.join(dir, 'node_modules'));
  // Next.js' webpack (next/dist/compiled/webpack, its package.json without a version): the version webpack says
  const next = dirOf('next', dir);
  if (next) {
    try {
      const w = require(path.join(next, 'dist/compiled/webpack/webpack.js'));
      if (typeof w.init === 'function' && !w.webpack) w.init();
      if (w.webpack && w.webpack.version) out.add(`webpack@${w.webpack.version}`);
    } catch { /* no compiled webpack */ }
  }
  return out;
}

// The Rollup of workbox-build, which generates a service worker (GenerateSW: workbox-webpack-plugin's, vite-plugin-pwa's)
// with Rollup's generate() - its runtime chunk workbox-<hash>.js in the output dir says so: name@version, or none
function workboxRollup(outDir, from = '.') {
  let names;
  try { names = fs.readdirSync(outDir); } catch { return []; }
  if (!names.some(n => /^workbox-[0-9a-f]+\.js$/.test(n))) return [];
  const wb = dirOf('workbox-build', from);
  return wb ? [resolved('rollup', wb)].filter(Boolean) : [];
}

module.exports = { NAMES, isBundler, without, hasJs, resolved, viteBundlers, installed, workboxRollup };
