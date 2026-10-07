'use strict';
// Runs the cases from matrix.cjs against fixtures created by gen.cjs (offline).
// usage: node test/run.cjs <fixtures-dir> [case-name-regex]
// Collects all lockfiles under the case's outDir ({output dir: packages}, one per top-level compiler) and checks:
//   1. they are valid for syft and match the expectation (expect / expectIncludes / expectExcludes)
//   2. they agree exactly with the bundler's oracle (independent build without bundle-lockfile)
//   3. syft (if on PATH) reads exactly those packages from outDir via javascript-lock-cataloger
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { fixtures, cases } = require('./matrix.cjs');
const { LOCKFILE, readLockfiles, sameMap, same, show } = require('./lib/check.cjs');

const [fxDir, filter] = process.argv.slice(2);
if (!fxDir) { console.error('usage: node test/run.cjs <fixtures-dir> [case-name-regex]'); process.exit(2); }
const FX = path.resolve(fxDir);
const REGISTER = path.resolve(__dirname, '../src/register.cjs');
const hasSyft = spawnSync('syft', ['version'], { stdio: 'ignore' }).status === 0;

function run(cmd, cwd, env) {
  const r = spawnSync('sh', ['-c', cmd], { cwd, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`"${cmd}" exited ${r.status}\n${(r.stdout + r.stderr).split('\n').slice(-15).join('\n')}`);
  return r;
}
const sh = (cmd, cwd, env) => run(cmd, cwd, env).stdout;

function runCase(c) {
  const fx = fixtures[c.fixture];
  const dir = path.join(FX, c.fixture);
  if (!fs.existsSync(dir)) throw new Error(`fixture ${c.fixture} missing in ${FX} (run gen.cjs)`);
  const outDir = path.join(dir, c.outDir || 'dist');
  for (const d of [outDir, 'dist-oracle', '.next-oracle', '.oracle-stats', '.sbom-root', '.sbom.spdx.json', '.cold.json']) fs.rmSync(path.resolve(dir, d), { recursive: true, force: true });

  const base = { ...process.env, ...(c.env || {}) };
  // vendored package manager releases of the fixture: $PNPM / $NPM in the case's cmd
  for (const [file, name] of [['.pnpm-bin', 'PNPM'], ['.npm-bin', 'NPM']]) {
    if (fs.existsSync(path.join(dir, file))) base[name] = `node ${path.join(dir, fs.readFileSync(path.join(dir, file), 'utf8').trim())}`;
  }
  const nodeOptions = [c.nodeOptions, c.inject === false ? '' : `--require ${REGISTER}`].filter(Boolean).join(' ');
  const env = { ...base, NODE_OPTIONS: nodeOptions };
  const notes = [];

  if (c.heapMB) {
    const heap = Number(sh('node -p \'Math.round(require("v8").getHeapStatistics().heap_size_limit/1048576)\'', dir, env));
    if (heap < c.heapMB || heap > c.heapMB + 300) throw new Error(`heap limit ${heap}MB, expected ~${c.heapMB}MB`);
    notes.push(`heap ${heap}MB`);
  }

  for (const spec of c.installed || []) {
    const at = spec.lastIndexOf('@');
    const [name, version] = [spec.slice(0, at), spec.slice(at + 1)];
    const pj = path.join(dir, 'node_modules', name, 'package.json');
    const v = fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).version;
    if (v !== version) throw new Error(`${spec} is not installed in ${c.fixture}/node_modules (found ${v || 'nothing'})`);
  }
  if (c.installed) notes.push(`${c.installed.length} packages installed`);

  const build = run(c.cmd, dir, env);
  if (c.expectOutput && !c.expectOutput.test(build.stdout + build.stderr)) throw new Error(`build output does not match ${c.expectOutput}`);
  const got = readLockfiles(outDir, c.lockfile);
  const all = [...new Set(Object.values(got).flat())].sort();

  if (c.expect === null) {
    if (Object.keys(got).length) throw new Error(`expected no lockfile, got${show(got)}`);
    return `no lockfile, as expected${c.expectOutput ? `; output matches ${c.expectOutput}` : ''}`;
  }
  if (!Object.keys(got).length) throw new Error('no lockfile written');
  if (c.expect && !sameMap(got, { '': c.expect })) throw new Error(`lockfile mismatch\n  got:${show(got)}\n  want: ${c.expect.join(' ')}`);
  if (c.expectKeys) {
    const lock = JSON.parse(fs.readFileSync(path.join(outDir, c.lockfile || LOCKFILE), 'utf8'));
    const keys = Object.fromEntries(Object.entries(lock.packages).filter(([k]) => k).map(([k, p]) => [k, `${p.name}@${p.version}`]));
    if (!sameMap(Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, [v]])), Object.fromEntries(Object.entries(c.expectKeys).map(([k, v]) => [k, [v]]))))
      throw new Error(`lockfile keys ${JSON.stringify(keys)}, expected ${JSON.stringify(c.expectKeys)}`);
    notes.push('keys as expected');
  }
  if (c.watchBuilds) {
    const builds = JSON.parse(build.stdout.trim().split('\n').pop());
    if (builds.length !== c.watchBuilds || !builds.every(b => same(b, c.expect))) throw new Error(`watch builds: ${JSON.stringify(builds)}, want ${c.watchBuilds} x ${c.expect.join(' ')}`);
    notes.push(`${builds.length} watch builds`);
  }
  const missing = (c.expectIncludes || []).filter(p => !all.includes(p));
  if (missing.length) throw new Error(`missing ${missing.join(' ')} in${show(got)}`);
  const unwanted = (c.expectExcludes || []).filter(p => all.includes(p));
  if (unwanted.length) throw new Error(`unexpected ${unwanted.join(' ')} in${show(got)}`);

  // oracle: same fixture, built without bundle-lockfile (keep only the case's own NODE_OPTIONS)
  const oracle = path.join(__dirname, 'oracles', `${fx.bundler || 'webpack'}.cjs`);
  const node = fs.existsSync(path.join(dir, '.pnp.cjs')) ? 'yarn node' : 'node';
  const truth = JSON.parse(sh(`${node} ${oracle} ${c.oracleArgs || ''}`, dir, { ...base, NODE_OPTIONS: c.nodeOptions || '' }).trim().split('\n').pop());
  if (!sameMap(got, truth)) throw new Error(`plugin and oracle disagree\n  plugin:${show(got)}\n  oracle:${show(truth)}`);
  notes.push(`oracle agrees on ${Object.keys(got).length} output(s)`);

  if (hasSyft) {
    const s = JSON.parse(sh(`syft scan dir:${outDir} -q -o json`, dir, base));
    const arts = s.artifacts || [];
    const names = [...new Set(arts.map(p => `${p.name}@${p.version}`))];
    if (!same(names, all)) throw new Error(`syft read ${names.sort().join(' ')}\n  want ${all.join(' ')}`);
    const bad = arts.filter(p => p.foundBy !== 'javascript-lock-cataloger' || !p.purl.startsWith('pkg:npm/') || !(p.licenses || []).length);
    if (bad.length) throw new Error(`syft: unexpected cataloger/purl/license for ${bad.map(p => p.name).join(', ')}`);
    notes.push('syft agrees');

    for (const sc of c.sbom || []) notes.push(sbomScenario(c, sc, dir, base));

    if (c.projectLockfile) {
      const p = JSON.parse(sh('syft scan file:package-lock.json -q -o json', dir, base));
      const proj = [...new Set((p.artifacts || []).map(a => `${a.name}@${a.version}`))].sort();
      const miss = c.projectLockfile.includes.filter(x => !proj.includes(x));
      const extra = c.projectLockfile.excludes.filter(x => proj.includes(x));
      if (miss.length || extra.length) throw new Error(`syft on the project lockfile: missing ${miss.join(' ') || '-'}, unexpected ${extra.join(' ') || '-'}\n  read: ${proj.join(' ')}`);
      notes.push(`syft on the project's own lockfile instead: ${proj.join(' ')}`);
    }
  }
  return `${Object.keys(got).length > 1 ? show(got) + '\n   ' : all.join(' ')} (${notes.join(', ')})`;
}

// Functional SBOM check: stage files like a package would install them, run `syft scan dir:` on that
// root with SPDX JSON output, and require exactly the expected npm packages (name, version, purl,
// declared license) - each one found in the expected file.
function sbomScenario(c, sc, dir, env) {
  const root = path.join(dir, '.sbom-root');
  fs.rmSync(root, { recursive: true, force: true });
  for (const [to, from] of Object.entries(sc.stage)) {
    fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
    fs.cpSync(path.join(dir, from), path.join(root, to), { recursive: true });
  }
  const spdxFile = path.join(dir, '.sbom.spdx.json');
  sh(`syft scan dir:${root} -q -o spdx-json=${spdxFile}`, dir, env);
  const doc = JSON.parse(fs.readFileSync(spdxFile, 'utf8'));
  const purlOf = (p) => ((p.externalRefs || []).find(r => r.referenceType === 'purl') || {}).referenceLocator;
  const got = (doc.packages || []).filter(p => (purlOf(p) || '').startsWith('pkg:npm/'))
    .map(p => ({ name: p.name, version: p.versionInfo, purl: purlOf(p), license: p.licenseDeclared, from: (p.sourceInfo || '').split(': ').pop() }))
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  const want = [...sc.expect].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  const fmt = (l) => l.map(p => `\n      ${p.name}@${p.version} ${p.purl} ${p.license} <- ${p.from}`).join('');
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`SBOM "${sc.name}" mismatch\n    got:${fmt(got)}\n    want:${fmt(want)}`);
  return `SBOM "${sc.name}": ${got.map(p => `${p.name}@${p.version}`).join(' ')}`;
}

let failed = 0;
const selected = cases.filter(c => !filter || new RegExp(filter).test(c.name));
if (!hasSyft) console.log('note: syft not on PATH, skipping syft checks');
for (const c of selected) {
  try { console.log(`PASS  ${c.name}: ${runCase(c)}`); } catch (e) { failed++; console.log(`FAIL  ${c.name}: ${e.message}`); }
}
console.log(`\n${selected.length - failed}/${selected.length} passed`);
process.exit(failed ? 1 : 0);
