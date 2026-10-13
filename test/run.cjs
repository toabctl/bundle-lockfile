'use strict';
// Runs the cases from matrix.cjs against fixtures created by gen.cjs (offline).
// usage: node test/run.cjs <fixtures-dir> [case-name-regex] [--shard=<i>/<n>] [--fixtures=<fixture-name-regex>]
//   (see lib/shard.cjs; --fixtures: only the cases of these fixtures)
// Collects all lockfiles under the case's outDir ({output dir: packages}, one per top-level compiler) and checks:
//   1. they are valid for syft and match the expectation (expect / expectIncludes / expectExcludes), and their
//      records give every package's real location
//   2. they agree exactly with the bundler's oracle (independent build without bundle-lockfile), and with the canaries
//      in the output's bytes
//   3. syft (if on PATH) reads exactly those packages from outDir via javascript-lock-cataloger
//   4. Trivy (if on PATH) reads exactly those packages from outDir via its npm (package-lock.json) analyzer
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { fixtures, cases } = require('./matrix.cjs');
const { LOCKFILE, readLockfiles, checkLocations, unlocated, canaries, sameMap, same, show } = require('./lib/check.cjs');
const { parseArgs, fixturesOf } = require('./lib/shard.cjs');

const { shard, fixtures: only, rest: [fxDir, filter] } = parseArgs(process.argv.slice(2));
if (!fxDir) { console.error('usage: node test/run.cjs <fixtures-dir> [case-name-regex] [--shard=<i>/<n>]'); process.exit(2); }
const inShard = fixturesOf(shard, only);
const FX = path.resolve(fxDir);
const REGISTER = path.resolve(__dirname, '../src/register.cjs');
const hasSyft = spawnSync('syft', ['version'], { stdio: 'ignore' }).status === 0;
const hasTrivy = spawnSync('trivy', ['--version'], { stdio: 'ignore' }).status === 0;
// BLTEST_REQUIRE_SBOM=1 (CI): without syft and Trivy the matrix fails instead of skipping their checks
if (process.env.BLTEST_REQUIRE_SBOM === '1' && !(hasSyft && hasTrivy)) {
  console.error(`BLTEST_REQUIRE_SBOM=1, but ${[!hasSyft && 'syft', !hasTrivy && 'trivy'].filter(Boolean).join(' and ')} not on PATH`);
  process.exit(1);
}
const TIMEOUT = 15 * 60 * 1000; // per command: a hanging build (e.g. an installer retrying the registry offline) fails its case

function run(cmd, cwd, env) {
  const r = spawnSync('sh', ['-c', cmd], { cwd, env, encoding: 'utf8', maxBuffer: 64 << 20, timeout: TIMEOUT });
  const tail = () => `${r.stdout || ''}${r.stderr || ''}`.split('\n').slice(-15).join('\n');
  if (r.error) throw new Error(`"${cmd}" failed: ${r.error.code === 'ETIMEDOUT' ? `timed out after ${TIMEOUT / 60000} min` : r.error.message}\n${tail()}`);
  if (r.status !== 0) throw new Error(`"${cmd}" exited ${r.status === null ? `on ${r.signal}` : r.status}\n${tail()}`);
  return r;
}
const sh = (cmd, cwd, env) => run(cmd, cwd, env).stdout;
// unique, sorted name@version of syft JSON artifacts
const syftIds = (doc) => [...new Set((doc.artifacts || []).map(a => `${a.name}@${a.version}`))].sort();
// the packages of Trivy's CycloneDX output that its npm analyzer read from package-lock.json files (the components
// those files' application components depend on): [{ id: name@version, purl, licensed }]
function trivyPackages(bom) {
  const prop = (c, n) => ((c.properties || []).find(p => p.name === n) || {}).value;
  const locks = new Set((bom.components || []).filter(c => c.type === 'application' && prop(c, 'aquasecurity:trivy:Type') === 'npm').map(c => c['bom-ref']));
  const refs = new Set((bom.dependencies || []).filter(d => locks.has(d.ref)).flatMap(d => d.dependsOn || []));
  return (bom.components || []).filter(c => refs.has(c['bom-ref']))
    .map(c => ({ id: `${c.group ? `${c.group}/` : ''}${c.name}@${c.version}`, purl: c.purl || '', licensed: !!(c.licenses || []).length }));
}
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function runCase(c) {
  const fx = fixtures[c.fixture];
  const dir = path.join(FX, c.fixture);
  if (!fs.existsSync(dir)) throw new Error(`fixture ${c.fixture} missing in ${FX} (run gen.cjs)`);
  const outDir = path.join(dir, c.outDir || 'dist');
  for (const d of [outDir, 'dist-oracle', '.next-oracle', '.oracle-stats', '.sbom-root', '.sbom.spdx.json', '.cold.json', '.export', 'island/dist', 'island/dist-oracle', '.svelte-kit/output', '.netlify', 'build-oracle', '.svelte-kit-oracle', 'out', 'copied']) fs.rmSync(path.resolve(dir, d), { recursive: true, force: true });

  // {fixture} in a case's env: the fixture's directory (settings that must be absolute paths)
  const base = { ...process.env, ...Object.fromEntries(Object.entries(c.env || {}).map(([k, v]) => [k, String(v).split('{fixture}').join(dir)])) };
  // the lockfiles also (exportDir) or only (exportOnly) in an export dir, mirrored relative to the fixture
  const exportDir = (c.exportDir || c.exportOnly) && path.join(dir, '.export');
  if (exportDir) Object.assign(base, { BUNDLE_LOCKFILE_EXPORT_DIR: exportDir, BUNDLE_LOCKFILE_EXPORT_BASE: dir, BUNDLE_LOCKFILE_INLINE: c.exportOnly ? '0' : '1' });
  // settingsFile: bundle-lockfile from a copy (.bl/bin, .bl/src) with a settings file, .bl/src/config.json: true - the
  // case's BUNDLE_LOCKFILE_* settings, moved there out of the environment; a string - that content (settings stay)
  let register = REGISTER, bin = path.resolve(__dirname, '../bin');
  if (c.settingsFile) {
    const bl = path.join(dir, '.bl');
    fs.rmSync(bl, { recursive: true, force: true });
    for (const d of ['bin', 'src']) fs.cpSync(path.resolve(__dirname, '..', d), path.join(bl, d), { recursive: true });
    let content = c.settingsFile;
    if (content === true) {
      const settings = Object.fromEntries(Object.entries(base).filter(([k]) => k.startsWith('BUNDLE_LOCKFILE_')));
      for (const k of Object.keys(settings)) delete base[k];
      content = JSON.stringify(settings);
    }
    fs.writeFileSync(path.join(bl, 'src/config.json'), content);
    register = path.join(bl, 'src/register.cjs');
    bin = path.join(bl, 'bin');
  }
  if (c.shim) base.PATH = `${bin}${path.delimiter}${base.PATH}`; // the node shim first
  // vendored package manager releases of the fixture: $PNPM / $NPM in the case's cmd
  for (const [file, name] of [['.pnpm-bin', 'PNPM'], ['.npm-bin', 'NPM']]) {
    if (fs.existsSync(path.join(dir, file))) base[name] = `node ${path.join(dir, fs.readFileSync(path.join(dir, file), 'utf8').trim())}`;
  }
  const nodeOptions = [c.nodeOptions, c.inject === false ? '' : `--require ${register}`].filter(Boolean).join(' ');
  const env = { ...base, NODE_OPTIONS: nodeOptions };
  const notes = [];
  // heapMB: the build's own process records its heap limit (test/apps/webpack5/webpack.config.js), checked after it
  const heapFile = path.join(dir, '.heap');
  fs.rmSync(heapFile, { force: true });
  if (c.heapMB) env.BLTEST_HEAP_FILE = heapFile;

  for (const spec of c.installed || []) {
    const at = spec.lastIndexOf('@');
    const [name, version] = [spec.slice(0, at), spec.slice(at + 1)];
    const pj = path.join(dir, 'node_modules', name, 'package.json');
    const v = fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).version;
    if (v !== version) throw new Error(`${spec} is not installed in ${c.fixture}/node_modules (found ${v || 'nothing'})`);
  }
  if (c.installed) notes.push(`${c.installed.length} packages installed`);

  if (c.expectError) { // a known failure of the build tool: the build must fail, with this output
    const r = spawnSync('sh', ['-c', c.cmd], { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 << 20, timeout: TIMEOUT });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status === 0) throw new Error(`"${c.cmd}" succeeded, expected it to fail with ${c.expectError}`);
    if (!c.expectError.test(out)) throw new Error(`"${c.cmd}" failed, but its output does not match ${c.expectError}\n${out.split('\n').slice(-15).join('\n')}`);
    return `failed as expected (${c.expectError})`;
  }
  const build = run(c.cmd, dir, env);
  if (c.expectOutput && !c.expectOutput.test(build.stdout + build.stderr)) throw new Error(`build output does not match ${c.expectOutput}`);
  if (c.heapMB) {
    if (!fs.existsSync(heapFile)) throw new Error(`the build recorded no heap limit (${heapFile})`);
    const heap = Number(fs.readFileSync(heapFile, 'utf8'));
    if (heap < c.heapMB || heap > c.heapMB + 300) throw new Error(`the build's heap limit ${heap}MB, expected ~${c.heapMB}MB`);
    notes.push(`the build's heap ${heap}MB`);
  }
  const inline = readLockfiles(outDir, c.lockfile);
  // with an export dir, its copies are the lockfiles under test; the inline ones must be the same, or absent
  const lockDir = exportDir ? path.join(exportDir, path.relative(dir, outDir)) : outDir;
  const got = exportDir ? readLockfiles(lockDir, c.lockfile) : inline;
  if (exportDir) {
    const want = c.exportOnly ? {} : got;
    if (!sameMap(inline, want)) throw new Error(`inline lockfiles${show(inline)}\n  want${show(want) || ' none'}`);
    // the same bytes (the export copy is the lockfile, record and all); its record is the inline lockfile's
    const lf = c.lockfile || LOCKFILE;
    for (const k of Object.keys(got)) {
      const exported = path.join(lockDir, k, lf), at = path.dirname(path.join(outDir, k, lf));
      if (!c.exportOnly && fs.readFileSync(exported, 'utf8') !== fs.readFileSync(path.join(outDir, k, lf), 'utf8')) throw new Error(`${exported} is not the inline lockfile's copy`);
      checkLocations(exported, at);
    }
    notes.push(c.exportOnly ? 'export dir only' : 'export dir = inline');
  }
  const all = [...new Set(Object.values(got).flat())].sort();

  if (c.expect === null) {
    if (Object.keys(got).length) throw new Error(`expected no lockfile, got${show(got)}`);
    return `no lockfile, as expected${c.expectOutput ? `; output matches ${c.expectOutput}` : ''}`;
  }
  if (!Object.keys(got).length) throw new Error('no lockfile written');
  // packages outside the project or whose location is not known: only where the case says why (outside: '<reason>')
  const nowhere = Object.keys(got).flatMap(k => unlocated(path.join(lockDir, k, c.lockfile || LOCKFILE)));
  if (nowhere.length && !c.outside) throw new Error(`packages outside the project or of unknown location (the case does not say why): ${[...new Set(nowhere)].join(' ')}`);
  if (nowhere.length) notes.push(`${new Set(nowhere).size} outside or of unknown location (${c.outside})`);
  // also the copies SvelteKit's adapters make of Vite's output (from .svelte-kit/output/): re-anchored where they are
  const located = Object.keys(inline).reduce((n, k) => n + checkLocations(path.join(outDir, k, c.lockfile || LOCKFILE)), 0);
  if (located) notes.push(`${located} locations`);
  if (c.expect && !sameMap(got, { '': c.expect })) throw new Error(`lockfile mismatch\n  got:${show(got)}\n  want: ${c.expect.join(' ')}`);
  if (c.expectIn && !sameMap(got, c.expectIn)) throw new Error(`lockfiles mismatch\n  got:${show(got)}\n  want:${show(c.expectIn)}`);
  if (c.expectKeys) {
    const lock = JSON.parse(fs.readFileSync(path.join(lockDir, c.lockfile || LOCKFILE), 'utf8'));
    const keys = Object.entries(lock.packages).filter(([k]) => k).map(([k, p]) => `${k} = ${p.name}@${p.version}`).sort(cmp);
    const want = Object.entries(c.expectKeys).map(([k, v]) => `${k} = ${v}`).sort(cmp);
    if (JSON.stringify(keys) !== JSON.stringify(want)) throw new Error(`lockfile keys\n    got:  ${keys.join(', ')}\n    want: ${want.join(', ')}`);
    notes.push('keys as expected');
  }
  if (c.watchBuilds) {
    const builds = JSON.parse(build.stdout.trim().split('\n').pop());
    if (builds.length !== c.watchBuilds.length || !builds.every((b, i) => same(b, c.watchBuilds[i]))) throw new Error(`watch builds: ${JSON.stringify(builds)}, want ${JSON.stringify(c.watchBuilds)}`);
    notes.push(`${builds.length} watch builds`);
  }
  const missing = (c.expectIncludes || []).filter(p => !all.includes(p));
  if (missing.length) throw new Error(`missing ${missing.join(' ')} in${show(got)}`);
  const unwanted = (c.expectExcludes || []).filter(p => all.includes(p));
  if (unwanted.length) throw new Error(`unexpected ${unwanted.join(' ')} in${show(got)}`);

  // canaries (test/apps/canary): found in the output's bytes, not through the bundler - each one listed, and each listed
  // one there
  const shipped = canaries(outDir);
  const unlisted = shipped.filter(p => !all.includes(p));
  if (unlisted.length) throw new Error(`in the output, not listed: ${unlisted.join(' ')}`);
  const absent = all.filter(p => p.startsWith('bl-canary-') && !shipped.includes(p));
  if (absent.length) throw new Error(`listed, not in the output: ${absent.join(' ')}`);
  if (shipped.length) notes.push(`${shipped.length} canaries in the output, all listed`);

  // syft first: the oracle's build may write where the case's build wrote (adapter-netlify's .netlify/, Next's .next/
  // with output: 'export')
  if (hasSyft) {
    const s = JSON.parse(sh(`syft scan dir:${lockDir} -q -o json`, dir, base));
    const names = syftIds(s);
    if (!same(names, all)) throw new Error(`syft read ${names.join(' ')}\n  want ${all.join(' ')}`);
    const bad = (s.artifacts || []).filter(p => p.foundBy !== 'javascript-lock-cataloger' || !p.purl.startsWith('pkg:npm/') || !(p.licenses || []).length);
    if (bad.length) throw new Error(`syft: unexpected cataloger/purl/license for ${bad.map(p => p.name).join(', ')}`);
    notes.push('syft agrees');

    for (const sc of c.sbom || []) notes.push(sbomScenario(c, sc, dir, base));

    if (c.projectLockfile) {
      const proj = syftIds(JSON.parse(sh('syft scan file:package-lock.json -q -o json', dir, base)));
      const miss = c.projectLockfile.includes.filter(x => !proj.includes(x));
      const extra = c.projectLockfile.excludes.filter(x => proj.includes(x));
      if (miss.length || extra.length) throw new Error(`syft on the project lockfile: missing ${miss.join(' ') || '-'}, unexpected ${extra.join(' ') || '-'}\n  read: ${proj.join(' ')}`);
      notes.push(`syft on the project's own lockfile instead: ${proj.join(' ')}`);
    }
  }

  // `trivy fs` reads package-lock.json files (image and rootfs scans read none); CycloneDX output needs no
  // vulnerability database
  if (hasTrivy) {
    const pkgs = trivyPackages(JSON.parse(sh(`trivy fs -q --skip-version-check --format cyclonedx ${lockDir}`, dir, base)));
    const names = [...new Set(pkgs.map(p => p.id))].sort();
    if (!same(names, all)) throw new Error(`trivy read ${names.join(' ')}\n  want ${all.join(' ')}`);
    const bad = pkgs.filter(p => !p.purl.startsWith('pkg:npm/') || !p.licensed);
    if (bad.length) throw new Error(`trivy: unexpected purl/license for ${bad.map(p => p.id).join(', ')}`);
    notes.push('trivy agrees');
  }

  // oracle: same fixture, built without bundle-lockfile (keep only the case's own NODE_OPTIONS)
  if (c.oracle === false) notes.push('no oracle (see case)');
  else {
    const oracle = path.join(__dirname, 'oracles', `${c.oracleScript || fx.bundler || 'webpack'}.cjs`);
    const node = fs.existsSync(path.join(dir, '.pnp.cjs')) ? 'yarn node' : 'node';
    // PATH: not through the node shim, which would inject bundle-lockfile
    const truth = JSON.parse(sh(`${node} ${oracle} ${c.oracleArgs || ''}`, dir, { ...base, NODE_OPTIONS: c.nodeOptions || '', PATH: process.env.PATH }).trim().split('\n').pop());
    // packages the oracle cannot see (e.g. Vite: CSS-only packages have no source map), each also expected
    for (const k of Object.keys(truth)) truth[k] = [...new Set([...truth[k], ...(c.oracleMissing || [])])].sort();
    // ... or only in some outputs ({ "<output dir>": [...] })
    for (const [k, list] of Object.entries(c.oracleMissingIn || {})) truth[k] = [...new Set([...(truth[k] || []), ...list])].sort();
    if (!sameMap(got, truth)) throw new Error(`plugin and oracle disagree\n  plugin:${show(got)}\n  oracle:${show(truth)}`);
    notes.push(`oracle agrees on ${Object.keys(got).length} output(s)`);
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
  // the same name@version can come from several files: sort by the file too, whatever order syft writes
  const order = (a, b) => cmp(a.name, b.name) || cmp(a.version, b.version) || cmp(a.from, b.from);
  const got = (doc.packages || []).filter(p => (purlOf(p) || '').startsWith('pkg:npm/'))
    .map(p => ({ name: p.name, version: p.versionInfo, purl: purlOf(p), license: p.licenseDeclared, from: (p.sourceInfo || '').split(': ').pop() }))
    .sort(order);
  const want = [...sc.expect].sort(order);
  const fmt = (l) => l.map(p => `\n      ${p.name}@${p.version} ${p.purl} ${p.license} <- ${p.from}`).join('');
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`SBOM "${sc.name}" mismatch\n    got:${fmt(got)}\n    want:${fmt(want)}`);
  return `SBOM "${sc.name}": ${got.map(p => `${p.name}@${p.version}`).join(' ')}`;
}

let failed = 0, skipped = 0;
const selected = cases.filter(c => inShard.has(c.fixture) && (!filter || new RegExp(filter).test(c.name)));
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (!hasSyft) console.log('note: syft not on PATH, skipping syft checks');
if (!hasTrivy) console.log('note: trivy not on PATH, skipping Trivy checks');
for (const c of selected) {
  // the build tool itself does not run on this Node.js (the case says why)
  if (c.maxNode && NODE_MAJOR > c.maxNode) { skipped++; console.log(`SKIP  ${c.name}: needs Node.js <= ${c.maxNode}, this is ${process.versions.node}`); continue; }
  try { console.log(`PASS  ${c.name}: ${runCase(c)}`); } catch (e) { failed++; console.log(`FAIL  ${c.name}: ${e.message}`); }
}
console.log(`\n${selected.length - failed - skipped}/${selected.length - skipped} passed${skipped ? `, ${skipped} skipped` : ''}`);
// a selection that runs nothing (a regex that matches no case, a renamed fixture) is no pass
if (selected.length - skipped === 0) { console.log('no case ran'); process.exit(1); }
process.exit(failed ? 1 : 0);
