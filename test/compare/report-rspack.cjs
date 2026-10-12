'use strict';
// Compares what rspack-stats.cjs recorded with the lockfiles: per output directory, the packages of its compilers' stats
// (all builds recorded for it, merged) and those of its lockfile (inline, or the export copy).
//   node report-rspack.cjs <truth dir> [<export dir> <export base>]
// "only in the stats" is a package bundle-lockfile missed (a bug, unless explained); "only in the lockfile" is expected
// for style sheets loaders inlined, modules whose exports rspack inlined, and copies minimized after copying.
const fs = require('fs');
const path = require('path');

const [truthDir, exportDir, exportBase] = process.argv.slice(2);
if (!truthDir) { console.error('usage: node report-rspack.cjs <truth dir> [<export dir> <export base>]'); process.exit(2); }
const LOCK = 'bundle-lockfile/package-lock.json';

const byDir = new Map();
for (const f of fs.readdirSync(truthDir).filter(f => f.endsWith('.json'))) {
  const t = JSON.parse(fs.readFileSync(path.join(truthDir, f), 'utf8'));
  if (t.errors) continue;
  const e = byDir.get(t.outputPath) || { packages: new Set(), compilers: new Set() };
  for (const p of t.packages) e.packages.add(p);
  e.compilers.add(t.name || '(unnamed)');
  byDir.set(t.outputPath, e);
}

const lockfileOf = (out) => {
  const inline = path.join(out, LOCK);
  if (fs.existsSync(inline)) return inline;
  if (!exportDir) return null;
  const rel = exportBase && (out === exportBase || out.startsWith(exportBase + path.sep)) ? path.relative(exportBase, out) : out.replace(/^\//, '');
  const exported = path.join(exportDir, rel, LOCK);
  return fs.existsSync(exported) ? exported : null;
};

let missing = 0;
for (const [out, { packages, compilers }] of [...byDir].sort()) {
  const file = lockfileOf(out);
  console.log(`== ${out} (${[...compilers].join(', ')})`);
  if (!file) { console.log(`   NO LOCKFILE (stats: ${packages.size} packages)`); missing++; continue; }
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  const locked = new Set(Object.entries(lock.packages).filter(([k]) => k).map(([, p]) => `${p.name}@${p.version}`));
  const onlyStats = [...packages].filter(p => !locked.has(p)).sort();
  const onlyLock = [...locked].filter(p => !packages.has(p)).sort();
  console.log(`   lockfile ${locked.size}, stats ${packages.size}, both ${[...packages].filter(p => locked.has(p)).length} (${path.relative(process.cwd(), file)})`);
  if (onlyStats.length) { missing += onlyStats.length; console.log(`   ONLY IN THE STATS: ${onlyStats.join(' ')}`); }
  if (onlyLock.length) console.log(`   only in the lockfile: ${onlyLock.join(' ')}`);
}
console.log(missing ? `\n${missing} package(s) or output(s) missing from the lockfiles` : '\nno package missing from the lockfiles');
process.exit(missing ? 1 : 0);
