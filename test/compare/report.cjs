'use strict';
// Compares, per compiler output below <out-dir>, bundle-lockfile's lockfile with CycloneDX's bom.json and
// explains every difference with the diagnostics written by inject-cyclonedx.cjs.
// usage: node test/compare/report.cjs <out-dir> [label]      prints Markdown
const fs = require('fs');
const path = require('path');
const { readLockfile } = require('../lib/check.cjs');

const [outDir, label] = process.argv.slice(2);
if (!outDir) { console.error('usage: node test/compare/report.cjs <out-dir> [label]'); process.exit(2); }
const root = path.resolve(outDir);

// output dir (relative to root) -> { ours, cdx, diag }
const outputs = {};
const at = (d) => (outputs[path.relative(root, d).split(path.sep).join('/') || '.'] ||= {});
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    const parent = path.basename(d), out = path.dirname(d);
    if (parent === 'bundle-lockfile' && e.name === 'package-lock.json') at(out).ours = readLockfile(p);
    if (parent === 'cyclonedx' && e.name === 'bom.json') {
      const bom = JSON.parse(fs.readFileSync(p, 'utf8'));
      at(out).cdx = [...new Set((bom.components || []).map(c => `${c.group ? c.group + '/' : ''}${c.name}@${c.version}`))].sort();
    }
    if (parent === 'bundle-lockfile-compare' && /^diag-.*\.json$/.test(e.name)) (at(out).diags ||= []).push(JSON.parse(fs.readFileSync(p, 'utf8')));
  }
})(root);

// one diagnostics file per compiler writing to the output directory: merged
function merge(diags) {
  if (!diags) return null;
  const union = (k) => [...new Set(diags.flatMap(d => d[k] || []))].sort();
  return { compilers: diags.map(d => d.compiler || '(unnamed)').sort(), processed: union('processed'), bundled: union('bundled'),
    firstParty: union('firstParty'), vendored: union('vendored') };
}

function explain(pkg, side, diag) {
  if (!diag) return 'no diagnostics';
  if (side === 'ours' && diag.compilers.length > 1 && diag.bundled.includes(pkg))
    return `in the emitted output of one of the ${diag.compilers.length} compilers writing to this directory (${diag.compilers.join(', ')}); CycloneDX writes one bom.json per compiler there, the last one wins`;
  if (side === 'cdx' && diag.firstParty.includes(pkg) && !diag.processed.includes(pkg)) return 'first-party package outside node_modules (e.g. a workspace package) - bundle-lockfile leaves those out by design';
  if (side === 'cdx' && (diag.vendored || []).includes(pkg) && !diag.processed.includes(pkg)) return 'vendored inside another package (a nested package.json such as next/dist/compiled/...) - bundle-lockfile lists the package that contains it';
  const processed = diag.processed.includes(pkg), bundled = diag.bundled.includes(pkg);
  if (side === 'cdx' && processed && !bundled) return 'processed by webpack but not in the emitted output (e.g. tree-shaken, or only executed at build time like css-loader)';
  if (side === 'ours' && bundled && !processed) return 'in the emitted output but not processed by the main compilation: from a child compilation (e.g. a worker) or copied verbatim';
  if (side === 'ours' && bundled) return 'in the emitted output';
  return `unexplained (processed=${processed}, bundled=${bundled})`;
}

let totalDiff = 0, unexplained = 0;
const lines = [`## ${label || outDir}`, ''];
for (const [out, o] of Object.entries(outputs).sort()) {
  o.diag = merge(o.diags);
  if (!o.cdx) { lines.push(`### output \`${out}\``, '', 'CycloneDX did not run (it needs webpack >= 5 with compiler.webpack); not compared', ''); continue; }
  const ours = o.ours || [], cdx = o.cdx || [];
  const onlyOurs = ours.filter(p => !cdx.includes(p)), onlyCdx = cdx.filter(p => !ours.includes(p));
  const both = ours.filter(p => cdx.includes(p)).length;
  lines.push(`### output \`${out}\`${o.diag ? ` (compiler${o.diag.compilers.length > 1 ? 's' : ''} ${o.diag.compilers.join(', ')})` : ''}`, '',
    `| | packages |`, `|---|---|`,
    `| bundle-lockfile | ${o.ours ? ours.length : 'no lockfile'} |`, `| CycloneDX | ${o.cdx ? cdx.length : 'no bom'} |`,
    `| in both | ${both} |`, `| only bundle-lockfile | ${onlyOurs.length} |`, `| only CycloneDX | ${onlyCdx.length} |`, '');
  for (const [side, list] of [['ours', onlyOurs], ['cdx', onlyCdx]]) {
    for (const p of list) {
      const why = explain(p, side, o.diag);
      if (why.startsWith('unexplained')) unexplained++;
      lines.push(`- only ${side === 'ours' ? 'bundle-lockfile' : 'CycloneDX'}: \`${p}\` - ${why}`);
    }
  }
  totalDiff += onlyOurs.length + onlyCdx.length;
  lines.push('');
}
lines.push(`**${Object.keys(outputs).length} output(s), ${totalDiff} difference(s), ${unexplained} unexplained**`, '');
console.log(lines.join('\n'));
