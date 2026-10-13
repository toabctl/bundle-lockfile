'use strict';
// Oracle for the ES-module entries the adapters wrap (their esmEntries, see src/esm-wrap.cjs): every copy of them
// installed in the fixture (node_modules, pnpm's and bun's stores, Yarn's store, Yarn Plug'n'Play's packages) is
// imported by Node.js as it is - no preload, no hooks - and through the wrapper bundle-lockfile generates for it,
// with a stub of bundle-lockfile's hooks API that wraps nothing and records what the wrapper reports. The wrapper must
// link (a default the module does not have,
// or one it misses, is a SyntaxError), and its namespace must have every name of the real one with the same value; the
// names of the functions it wraps may be extra (undefined where the module has none). One of those must be a function
// (else the version is one the adapter does not know: its builds would fail). Run in the fixture's directory (with
// `yarn node` under Plug'n'Play); prints JSON: [{ file, id, version, ok, error?, names, wrapped }].
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const esmWrap = require('../../src/esm-wrap.cjs');

const ENTRIES = ['../../src/adapters/rollup.cjs', '../../src/adapters/rspack.cjs'].flatMap(f => require(f).esmEntries || []);
// the package and the file in it of each suffix: /@rspack/core/dist/index.js -> @rspack/core, dist/index.js
const wanted = ENTRIES.flatMap(e => e.suffixes.map((s) => {
  const parts = s.split('/').filter(Boolean);
  const n = parts[0].startsWith('@') ? 2 : 1;
  return { name: parts.slice(0, n).join('/'), file: parts.slice(n).join('/') };
}));
const names = new Set(wanted.map(w => w.name));

const found = new Set(); // real paths of entry files
const seen = new Set(); // real paths of directories walked
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const list = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const nameOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name; } catch { return null; } };
// name: the package's (null: from its package.json, as in Yarn's store)
function visitPackage(dir, name) {
  const r = real(dir);
  if (!r || seen.has(r)) return;
  seen.add(r);
  if (name === null) name = nameOf(r);
  if (names.has(name)) for (const w of wanted) if (w.name === name && fs.existsSync(path.join(r, w.file))) found.add(path.join(r, w.file));
  visitModules(path.join(r, 'node_modules'));
}
function visitModules(nm) {
  const r = real(nm);
  if (!r || seen.has(r)) return;
  seen.add(r);
  for (const e of list(r)) {
    if (e === '.pnpm' || e === '.bun') for (const s of list(path.join(r, e))) visitModules(path.join(r, e, s, 'node_modules'));
    else if (e === '.store') for (const s of list(path.join(r, e))) visitPackage(path.join(r, e, s, 'package'), null);
    else if (e.startsWith('@')) for (const s of list(path.join(r, e))) visitPackage(path.join(r, e, s), `${e}/${s}`);
    else if (!e.startsWith('.')) visitPackage(path.join(r, e), e);
  }
}
// the project and its workspaces: every node_modules outside node_modules, a few levels down
(function walk(dir, depth) {
  for (const e of list(dir)) {
    if (e === 'node_modules') visitModules(path.join(dir, e));
    else if (depth < 3 && !e.startsWith('.') && fs.statSync(path.join(dir, e), { throwIfNoEntry: false })?.isDirectory()) walk(path.join(dir, e), depth + 1);
  }
})(process.cwd(), 0);
// Yarn Plug'n'Play: its packages (in zip files, which its fs patch reads)
if (process.versions.pnp) {
  const pnp = require('module').findPnpApi(path.join(process.cwd(), 'x')); // (no require('pnpapi') from outside the project)
  const locators = pnp.getAllLocators().filter(l => names.has(l.name));
  // a package with peer dependencies runs as its virtual instances (the copy in the cache has not all its dependencies)
  const virtual = new Set(locators.filter(l => l.reference.startsWith('virtual:')).map(l => `${l.name}@${l.reference.split('#').pop()}`));
  for (const loc of locators) {
    if (!loc.reference.startsWith('virtual:') && virtual.has(`${loc.name}@${loc.reference}`)) continue;
    const dir = pnp.getPackageInformation(loc).packageLocation;
    for (const w of wanted) if (w.name === loc.name && fs.existsSync(path.join(dir, w.file))) found.add(path.join(dir, w.file));
  }
}

// Node.js's module format of a .js file: the "type" of the nearest package.json
function isModule(file) {
  if (file.endsWith('.mjs')) return true;
  if (!file.endsWith('.js')) return false;
  for (let d = path.dirname(file); ; d = path.dirname(d)) {
    const pj = path.join(d, 'package.json');
    if (fs.existsSync(pj)) { try { return JSON.parse(fs.readFileSync(pj, 'utf8')).type === 'module'; } catch { return false; } }
    if (path.dirname(d) === d) return false;
  }
}
function versionOf(file) {
  for (let d = path.dirname(file); path.dirname(d) !== d; d = path.dirname(d)) {
    const v = nameOf(d) && JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).version;
    if (v) return v;
  }
  return null;
}

// the hooks' API, as in a thread with bundle-lockfile (hooks.cjs installEsm): a function to wrap stays as it is
const reported = new Map(); // url -> whether the wrapper found one of the functions to wrap
globalThis[Symbol.for('bundle-lockfile.esm')] = { wrap: (id, name, fn) => fn, found: (id, url, names, ok) => reported.set(url, ok) };

(async () => {
  const tmp = fs.mkdtempSync(path.join(process.cwd(), '.esm-entries-'));
  const results = [];
  try {
    let n = 0;
    for (const file of [...found].sort()) {
      const url = pathToFileURL(file).href;
      const entry = esmWrap.match(url, ENTRIES);
      if (!entry || !isModule(file)) continue; // rspack 1's CommonJS dist/index.js: not wrapped
      const r = { file: path.relative(process.cwd(), file), id: entry.id, version: versionOf(file), ok: false };
      results.push(r);
      try {
        // the real module, as the wrapper imports it (the same URL: the same instance)
        const ns = await import(`${url}?${esmWrap.MARK}`);
        const wrapperFile = path.join(tmp, `w${n++}.mjs`);
        fs.writeFileSync(wrapperFile, esmWrap.source(url, fs.readFileSync(file, 'utf8'), entry));
        const w = await import(pathToFileURL(wrapperFile).href);
        const realNames = Object.keys(ns), wrapperNames = Object.keys(w);
        r.names = realNames.length;
        r.wrapped = entry.wrap.filter(k => typeof ns[k] === 'function');
        const problems = [
          ...realNames.filter(k => !(k in w)).map(k => `the wrapper lacks ${k}`),
          ...realNames.filter(k => k in w && w[k] !== ns[k]).map(k => `the wrapper's ${k} is not the module's`),
          ...wrapperNames.filter(k => !(k in ns) && !(entry.wrap.includes(k) && w[k] === undefined)).map(k => `the wrapper has ${k}, the module does not`),
          ...(r.wrapped.length ? [] : [`none of ${entry.wrap.join(', ')} is a function`]),
          ...(reported.get(url) === !!r.wrapped.length ? [] : [`the wrapper reported ${reported.get(url)} for whether one of ${entry.wrap.join(', ')} is a function`]),
        ];
        if (problems.length) r.error = problems.join('; ');
        else r.ok = true;
      } catch (e) {
        r.error = String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(JSON.stringify(results));
})();
