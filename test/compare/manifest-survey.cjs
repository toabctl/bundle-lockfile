'use strict';
// Comparison tooling: every package.json INSIDE an installed package (not in a node_modules below it) in the given
// directories, and what bundle-lockfile's rule makes of the files below it - read from the package.json files only,
// nothing is run or bundled. The rule (docs/format.md, "Which package a file belongs to"), written out again here:
// a nested package.json with a name npm accepts and a version, not private, no VS Code extension's, and a name no
// package.json further out (up to the package root) has, is a vendored copy, listed for its files; any other is part
// of the package. The "copy" rows are the ones to look at by hand: a real copy (next/dist/compiled/*), or a helper
// with a name and a version that would be listed under a made-up name.
// usage: node test/compare/manifest-survey.cjs <dir>...     prints TSV: decision, package, nested path, name, version, private
const fs = require('fs');
const path = require('path');

const json = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const NAME = /^(@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/;
const vendorable = (j) => !!j && typeof j.name === 'string' && j.name.length <= 214 && NAME.test(j.name) && typeof j.version === 'string' && !!j.version
  && j.private !== true && !(j.publisher && j.engines && j.engines.vscode);

const rows = [], seenRoots = new Set();
// package roots below a node_modules directory (scopes, pnpm's .pnpm/<x>/node_modules, Yarn's .store/<x>/package)
function roots(nm, into) {
  let entries;
  try { entries = fs.readdirSync(nm, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const p = path.join(nm, e.name);
    if (e.name === '.pnpm') { for (const x of safeDirs(p)) roots(path.join(p, x, 'node_modules'), into); continue; }
    if (e.name === '.store') { for (const x of safeDirs(p)) into.push(path.join(p, x, 'package')); continue; }
    if (e.name.startsWith('.')) continue;
    if (e.name.startsWith('@')) { for (const x of safeDirs(p)) into.push(path.join(p, x)); continue; }
    into.push(p);
  }
}
function safeDirs(d) { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name); } catch { return []; } }

function survey(root) {
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { return; }
  if (seenRoots.has(realRoot)) return;
  seenRoots.add(realRoot);
  const rj = json(path.join(realRoot, 'package.json'));
  if (!rj) return;
  const pkg = `${rj.name}@${rj.version}`;
  const walk = (d, chain) => {
    for (const e of safeDirs(d)) {
      if (e === 'node_modules') { const inner = []; roots(path.join(d, e), inner); inner.forEach(survey); continue; }
      const sub = path.join(d, e);
      const j = json(path.join(sub, 'package.json'));
      const next = j ? [j, ...chain] : chain;
      if (j) {
        const copy = vendorable(j) && !chain.some(o => o.name === j.name);
        rows.push([copy ? 'copy' : 'package', pkg, path.relative(realRoot, sub), j.name || '', j.version || '', j.private === true ? 'private' : '']);
      }
      walk(sub, next);
    }
  };
  walk(realRoot, [rj]);
}

const dirs = process.argv.slice(2);
if (!dirs.length) { console.error('usage: node test/compare/manifest-survey.cjs <dir>...'); process.exit(2); }
for (const d of dirs) { const r = []; roots(path.join(path.resolve(d), 'node_modules'), r); r.forEach(survey); }
console.log(['decision', 'package', 'nested', 'name', 'version', 'private'].join('\t'));
for (const r of rows.sort((a, b) => a.join('\t').localeCompare(b.join('\t')))) console.log(r.join('\t'));
