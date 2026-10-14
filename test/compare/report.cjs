'use strict';
// Compares, per output below <out-dir>, bundle-lockfile's lockfile with every other tool's package list found there,
// and explains each difference from data the tools do not share with bundle-lockfile: the diagnostics
// (inject-webpack-tools.cjs, diag-rollup.cjs: the bundler's own module lists, webpack's stats through the oracles'
// code, the package.json files on disk) and, for Vite and Rollup, the oracle's packages of the output
// (bundle-lockfile-compare/oracle.json, written by fixtures.sh). A difference none of them explains is "unexplained":
// the exit code is 1 then. It never writes expectations; nothing here is a test of bundle-lockfile.
// usage: node test/compare/report.cjs <out-dir> [label]      prints Markdown
const fs = require('fs');
const path = require('path');
const { readLockfile } = require('../lib/check.cjs');

const [outDir, label, fixtureArg] = process.argv.slice(2);
if (!outDir) { console.error('usage: node test/compare/report.cjs <out-dir> [label [fixture-dir]]'); process.exit(2); }
const root = path.resolve(outDir);
const fixture = path.resolve(fixtureArg || path.dirname(root));

// Byte evidence, for packages none of the build's module lists has (a copied file, a worker's font the main build
// emits again under another name): a file of the package (found by walking the fixture's node_modules, not through
// any lockfile) with the same bytes as a file in the output
const crypto = require('crypto');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const filesBelow = (d, skip = () => false, out = [], limit = 50000) => {
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= limit) break;
    const p = path.join(d, e.name);
    if (skip(e.name, p)) continue;
    if (e.isDirectory()) filesBelow(p, skip, out, limit);
    else if (e.isFile() && fs.statSync(p).size <= 20 << 20) out.push(p);
  }
  return out;
};
let outputHashes = null;
const packageDirs = new Map(); // name@version -> [dir]
(function scan(nm) {
  let entries;
  try { entries = fs.readdirSync(nm, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dirs = e.name.startsWith('@') ? fs.readdirSync(path.join(nm, e.name)).map(x => path.join(nm, e.name, x))
      : e.name === '.pnpm' ? fs.readdirSync(path.join(nm, e.name)).map(x => path.join(nm, e.name, x, 'node_modules')).filter(fs.existsSync).flatMap(x => { scan(x); return []; })
        : e.name.startsWith('.') ? [] : [path.join(nm, e.name)];
    for (const d of dirs) {
      let j; try { j = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')); } catch (err) { if (err.code === 'ENOENT' || err instanceof SyntaxError) continue; throw err; }
      if (j && j.name) { const id = `${j.name}@${j.version || ''}`; packageDirs.set(id, [...(packageDirs.get(id) || []), d]); }
      scan(path.join(d, 'node_modules'));
    }
  }
})(path.join(fixture, 'node_modules'));
function inOutputByBytes(p, out) {
  if (!outputHashes) {
    outputHashes = new Set(filesBelow(path.join(root, out === '.' ? '' : out), (n) => /^(bundle-lockfile|bundle-lockfile-compare|cyclonedx)$/.test(n)).map(sha));
  }
  for (const d of packageDirs.get(p) || []) {
    for (const f of filesBelow(d, (n) => n === 'node_modules' || n === 'package.json', [], 5000)) if (outputHashes.has(sha(f))) return path.relative(d, f);
  }
  return null;
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const uniq = (l) => [...new Set(l)].sort();
const fromBom = (bom) => uniq((bom.components || []).filter(c => c.type !== 'application').map(c => `${c.group ? `${c.group}/` : ''}${c.name}@${c.version || ''}`));
const fromList = (l) => uniq(l.map(p => `${p.name}@${p.version || ''}`));
// the tools: the file each writes below an output directory, its parser, and how it lists a build
const TOOLS = {
  cyclonedx: { file: 'cyclonedx/bom.json', parse: fromBom, perCompilation: true, label: '@cyclonedx/webpack-plugin' },
  lwp: { file: 'bundle-lockfile-compare/lwp.json', parse: fromList, perCompilation: true, label: 'license-webpack-plugin' },
  wlp: { file: 'bundle-lockfile-compare/wlp.json', parse: fromList, perCompilation: true, label: 'webpack-license-plugin' },
  rpl: { file: 'bundle-lockfile-compare/rpl.json', parse: fromList, label: 'rollup-plugin-license' },
  sbom: { file: 'bundle-lockfile-compare/sbom/bom.json', parse: fromBom, label: 'rollup-plugin-sbom' },
  vite: { file: 'bundle-lockfile-compare/vite-license.json', parse: fromList, label: "Vite's build.license" },
};
const BUNDLERS = new Set(['webpack', 'rollup', 'vite', 'rolldown', 'rolldown-vite', '@rspack/core']);
const nameOf = (id) => id.slice(0, id.lastIndexOf('@'));

// output dir (relative to root) -> { ours, tools: { key: list }, diags: [], oracle }
const outputs = {};
const at = (d) => (outputs[path.relative(root, d).split(path.sep).join('/') || '.'] ||= { tools: {}, diags: [] });
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
    const rel = (n) => p.endsWith(path.join('', ...n.split('/')));
    if (path.basename(d) === 'bundle-lockfile' && e.name === 'package-lock.json') at(path.dirname(d)).ours = readLockfile(p);
    for (const [k, t] of Object.entries(TOOLS)) {
      if (!rel(t.file)) continue;
      const out = p.slice(0, p.length - path.join(...t.file.split('/')).length - 1);
      const data = readJson(p);
      at(out).tools[k] = t.parse(Array.isArray(data) ? data : data);
    }
    if (path.basename(d) === 'bundle-lockfile-compare' && /^diag-.*\.json$/.test(e.name)) at(path.dirname(d)).diags.push(readJson(p));
    if (path.basename(d) === 'bundle-lockfile-compare' && e.name === 'oracle.json') at(path.dirname(d)).oracle = readJson(p)[''] || [];
  }
})(root);

// one diagnostics file per compiler (build) writing to the output directory: merged
function merge(diags, oracle) {
  const union = (k) => uniq(diags.flatMap(d => d[k] || []));
  const nested = new Map();
  for (const d of diags) for (const x of d.nested || []) nested.set(`${x.id} ${x.root}`, x);
  return { compilers: uniq(diags.map(d => d.compiler || '(unnamed)')), processed: union('processed'), childProcessed: union('childProcessed'),
    bundled: oracle ? uniq([...oracle, ...union('bundled')]) : union('bundled'), chunk: union('chunk'), zeroOnly: union('zeroOnly'),
    assets: union('assets'), style: union('style'), copied: union('copied'), firstParty: union('firstParty'), nested: [...nested.values()],
    unlicensed: Object.assign({}, ...diags.map(d => d.unlicensed || {})),
    readBy: Object.fromEntries(['lwp', 'wlp'].map(k => [k, diags.some(d => d.readBy) ? uniq(diags.flatMap(d => (d.readBy && d.readBy[k]) || [])) : null])) };
}

// why only the tool lists p
function theirs(p, d) {
  if (BUNDLERS.has(nameOf(p))) return 'the bundler itself, for the runtime code it writes into the output: bundle-lockfile lists no bundler';
  const nested = d.nested.find(n => n.id === p);
  if (nested && !d.processed.includes(p) && !d.bundled.includes(p)) return `a package.json inside ${nested.root}: the tool takes the nearest package.json, bundle-lockfile the package root`;
  if (d.firstParty.includes(p) && !d.processed.includes(p)) return 'first-party, outside node_modules (e.g. a workspace package): bundle-lockfile leaves those out by design';
  if (d.processed.includes(p) && !d.bundled.includes(p)) return 'processed by the bundler but not in the output: tree-shaken, or only run at build time';
  if (d.childProcessed.includes(p) && !d.bundled.includes(p)) return "from a child compilation whose output is not shipped: it runs at build time (e.g. html-webpack-plugin's template)";
  return null;
}
// why only bundle-lockfile lists p
function ours(p, d, tool, theirList, ourList, out) {
  const name = nameOf(p);
  if (TOOLS[tool].perCompilation && d.compilers.length > 1 && d.bundled.includes(p))
    return `in the output of one of the ${d.compilers.length} compilers writing to this directory: the tool writes one list per compilation there, the last one wins`;
  const same = theirList.filter(t => nameOf(t) === name);
  if (same.length === 1 && ourList.includes(same[0]) && ourList.filter(o => nameOf(o) === name).length > 1)
    return `the tool lists ${same[0]}: it keeps one version per name`;
  const nested = d.nested.find(n => n.root === p && theirList.includes(n.id));
  if (nested) return `the tool lists its files as ${nested.id}, a package.json inside it`;
  if (d.unlicensed[p] && theirList.includes(d.unlicensed[p])) return `its package.json declares no license: the tool walks up to one that does, ${d.unlicensed[p]}`;
  if (tool === 'lwp' && d.readBy.lwp && !d.readBy.lwp.includes(p) && d.processed.includes(p) && d.bundled.includes(p))
    return 'its files are in the output only as inner modules of concatenated ES modules, whose stats identifiers ("javascript/esm|<path>") the tool cannot map to a file (xz64/license-webpack-plugin#116)';
  if (tool === 'wlp' && d.readBy.wlp && !d.readBy.wlp.includes(p) && d.processed.includes(p) && d.bundled.includes(p))
    return 'its files are in the output only as leaf modules of concatenated modules: the tool reads a concatenation\'s root module and the modules its imports come from, not its leaves';
  if (d.zeroOnly.includes(p)) return 'its modules in the chunks render no bytes of their own (a re-export, a style sheet imported from JavaScript): the tool skips such modules';
  // (before the style sheets: copy-webpack-plugin makes a copied style sheet a file dependency too)
  if (d.copied.includes(p) && !d.processed.includes(p)) return 'copied into the output: an asset that records the package file it was copied from (copy-webpack-plugin)';
  const copied = !d.processed.includes(p) && inOutputByBytes(p, out);
  if (copied) return `its file ${copied} is in the output byte for byte: copied there, or emitted as an asset of another build`;
  if (d.style.includes(p) && !d.chunk.includes(p)) return 'a style sheet @imported from the package: inlined into another style sheet, no module of the output';
  if (d.assets.includes(p) && !d.chunk.includes(p)) return 'a package file emitted as an asset (a font, an image), no module';
  if (d.bundled.includes(p) && !d.processed.includes(p)) return 'in the output, but not processed by the build the tool ran in: a shipped child compilation, a build that writes nothing itself (a worker, legacy polyfills, a service worker) or a copied file';
  const anyCopy = inOutputByBytes(p, out);
  if (anyCopy) return `its file ${anyCopy} is in the output byte for byte: copied there, or emitted as an asset of another build`;
  return null;
}

let unexplained = 0;
const summary = {};
const lines = [`## ${label || outDir}`, ''];
for (const [out, o] of Object.entries(outputs).sort()) {
  outputHashes = null;
  const keys = Object.keys(o.tools);
  if (!keys.length) continue;
  const d = merge(o.diags, o.oracle);
  const ourList = o.ours || [];
  lines.push(`### output \`${out}\`${d.compilers.length ? ` (${d.compilers.join(', ')})` : ''}: bundle-lockfile ${o.ours ? ourList.length : 'no lockfile'}`, '');
  if (!o.diags.length) lines.push('- no diagnostics: differences cannot be explained', '');
  for (const k of keys) {
    const list = o.tools[k];
    const onlyOurs = ourList.filter(p => !list.includes(p)), onlyTheirs = list.filter(p => !ourList.includes(p));
    const s = (summary[TOOLS[k].label] ||= { outputs: 0, both: 0, onlyOurs: 0, onlyTheirs: 0, unexplained: 0 });
    s.outputs++; s.both += ourList.length - onlyOurs.length; s.onlyOurs += onlyOurs.length; s.onlyTheirs += onlyTheirs.length;
    lines.push(`- **${TOOLS[k].label}**: ${list.length} listed, ${ourList.length - onlyOurs.length} in both`);
    for (const [side, l] of [['bundle-lockfile', onlyOurs], [TOOLS[k].label, onlyTheirs]]) {
      for (const p of l) {
        let why = side === 'bundle-lockfile' ? ours(p, d, k, list, ourList, out) : theirs(p, d);
        if (!why) {
          unexplained++; s.unexplained++;
          why = `UNEXPLAINED (processed=${d.processed.includes(p)}, in the output by the oracle=${d.bundled.includes(p)})`;
        }
        lines.push(`  - only ${side}: \`${p}\` - ${why}`);
      }
    }
  }
  lines.push('');
}
lines.push('| tool | outputs | in both | only bundle-lockfile | only the tool | unexplained |', '|---|---|---|---|---|---|');
for (const [t, s] of Object.entries(summary)) lines.push(`| ${t} | ${s.outputs} | ${s.both} | ${s.onlyOurs} | ${s.onlyTheirs} | ${s.unexplained} |`);
lines.push('', `**${unexplained} unexplained**`, '');
console.log(lines.join('\n'));
process.exitCode = unexplained ? 1 : 0;
