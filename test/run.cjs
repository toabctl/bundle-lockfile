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
//   5. the build printed no Node.js warning that the matrix does not expect (warnings / allowWarnings in matrix.cjs);
//      BLTEST_WARNINGS=collect records every one in <fixtures-dir>/.warnings.jsonl instead (a census)
//   6. the ES-module entries the adapters wrap, as installed in the fixture, agree with their wrappers when Node.js
//      loads both (oracles/esm-entries.cjs; once per fixture)
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const os = require('os');
const { fixtures, cases, warnings: WARNINGS } = require('./matrix.cjs');
const { LOCKFILE, readLockfiles, checkLocations, unlocated, canaries, viaOf, treeOf, sameMap, same, show } = require('./lib/check.cjs');
const { parseArgs, fixturesOf } = require('./lib/shard.cjs');
const bundlers = require('./lib/bundlers.cjs');

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
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
// per command: a hanging build (e.g. an installer retrying the registry offline) fails its case (BLTEST_TIMEOUT_S: shorter)
const TIMEOUT = (Number(process.env.BLTEST_TIMEOUT_S) || 15 * 60) * 1000;

// A command that hangs is killed at TIMEOUT: by then nothing shows where it hung. A watchdog started with it (a process of
// its own: spawnSync blocks this one) writes, 30 s before the timeout, every process with its state and the kernel
// function it waits in (/proc/<pid>/wchan), to a file the timeout's error then shows.
function watched(cmd, opts) {
  const file = path.join(os.tmpdir(), `bltest-hang-${process.pid}-${Date.now()}.txt`);
  const dog = spawn('sh', ['-c', `sleep ${Math.max(1, TIMEOUT / 1000 - 30)} && sh ${path.join(__dirname, 'lib/ps-dump.sh')} > ${file} 2>&1`],
    { stdio: 'ignore', detached: true });
  dog.unref();
  try {
    const r = spawnSync('sh', ['-c', cmd], opts);
    if (r.error && r.error.code === 'ETIMEDOUT') { try { r.hang = fs.readFileSync(file, 'utf8'); } catch { r.hang = '(no process dump)'; } }
    return r;
  } finally {
    try { process.kill(-dog.pid); } catch { /* done */ }
    fs.rmSync(file, { force: true });
  }
}

function run(cmd, cwd, env) {
  const r = watched(cmd, { cwd, env, encoding: 'utf8', maxBuffer: 64 << 20, timeout: TIMEOUT });
  const tail = () => `${r.stdout || ''}${r.stderr || ''}`.split('\n').slice(-15).join('\n');
  if (r.error) throw new Error(`"${cmd}" failed: ${r.error.code === 'ETIMEDOUT' ? `timed out after ${TIMEOUT / 1000} s; the processes 30 s before (pid, state, wchan, command):\n${r.hang}` : r.error.message}\n${tail()}`);
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
// The npm packages of a `trivy rootfs` (or image) scan: from installed package.json files, components of no lockfile
const trivyInstalled = (bom) => [...new Set((bom.components || []).filter(c => c.type === 'library' && (c.purl || '').startsWith('pkg:npm/'))
  .map(c => `${c.group ? `${c.group}/` : ''}${c.name}@${c.version}`))].sort();
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Node.js's warnings in a build's output, "(node:<pid>) [<code>] <Type>Warning: <message>": each one expected by the
// matrix (warnings), or by the case (allowWarnings) - a new one may come from bundle-lockfile, and builds that fail
// on any warning would fail with it. module.register() is deprecated from Node.js 26 on (DEP0205):
// BUNDLE_LOCKFILE_ESM_HOOKS=async calls it, so there DEP0205 is expected, and nowhere else.
const WARNING = /^\(node:\d+\) ((?:\[([A-Z]+\d+)\] )?[A-Za-z]*Warning: .*)$/gm;
function checkWarnings(c, output, env) {
  const all = [...output.matchAll(WARNING)].map(m => ({ text: m[1], code: m[2] || '' }));
  if (process.env.BLTEST_WARNINGS === 'collect') {
    for (const w of all) fs.appendFileSync(path.join(FX, '.warnings.jsonl'), `${JSON.stringify({ case: c.name, fixture: c.fixture, node: process.versions.node, warning: w.text })}\n`);
    return all.length ? `${all.length} warning(s) collected` : null;
  }
  const dep0205 = env.BUNDLE_LOCKFILE_ESM_HOOKS === 'async' && NODE_MAJOR >= 26;
  const expected = [...WARNINGS.map(w => w.match), ...(c.allowWarnings || [])];
  const other = all.filter(w => !(dep0205 && w.code === 'DEP0205') && !expected.some(re => re.test(w.text)));
  if (other.length) throw new Error(`Node.js warnings the case does not expect:\n    ${[...new Set(other.map(w => w.text))].join('\n    ')}`);
  if (dep0205 && !all.some(w => w.code === 'DEP0205')) throw new Error('BUNDLE_LOCKFILE_ESM_HOOKS=async on Node.js 26+: expected DEP0205 (module.register() is deprecated)');
  return all.length ? `${all.length} expected warning(s)` : null;
}

// The ES-module entries the adapters wrap, against Node.js (oracles/esm-entries.cjs): once per fixture, without
// bundle-lockfile; a fixture with a copy whose wrapper does not agree fails every case of it
const entryChecks = new Map(); // fixture -> note | null | Error
function checkEntries(c, dir) {
  if (!entryChecks.has(c.fixture)) {
    try {
      const node = fs.existsSync(path.join(dir, '.pnp.cjs')) ? 'yarn node' : 'node';
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BUNDLE_LOCKFILE_')));
      const list = JSON.parse(sh(`${node} ${path.join(__dirname, 'oracles/esm-entries.cjs')}`, dir, { ...env, NODE_OPTIONS: '' }).trim().split('\n').pop());
      const bad = list.filter(r => !r.ok);
      entryChecks.set(c.fixture, bad.length ? new Error(`ESM entries whose wrapper disagrees with Node.js:\n    ${bad.map(r => `${r.file} (${r.id}@${r.version}): ${r.error}`).join('\n    ')}`)
        : list.length ? `ESM entries agree: ${[...new Set(list.map(r => `${r.id}@${r.version}`))].join(' ')}` : null);
    } catch (e) { entryChecks.set(c.fixture, e); }
  }
  const r = entryChecks.get(c.fixture);
  if (r instanceof Error) throw r;
  return r;
}

// runtimeTrace: starts the standalone Next.js server in outDir with test/oracles/runtime-tracer.cjs, requests each route,
// stops it; every package it loaded from node_modules (the directory below the last node_modules) must be listed (by
// name: Next copies no package.json of some of them into .next/standalone)
function runtimeTrace(c, outDir, listed, env) {
  const trace = path.join(outDir, '..', '.runtime-trace.txt'), port = String(41000 + Math.floor(Math.random() * 2000));
  const script = `
    const { spawn } = require('child_process');
    const srv = spawn(process.execPath, ['--require', ${JSON.stringify(path.join(__dirname, 'oracles/runtime-tracer.cjs'))}, 'server.js'],
      { cwd: ${JSON.stringify(outDir)}, env: { ...process.env, PORT: ${JSON.stringify(port)}, HOSTNAME: '127.0.0.1', BLTEST_RUNTIME_TRACE: ${JSON.stringify(trace)}, NODE_OPTIONS: '' }, stdio: 'ignore' });
    const get = (r) => fetch('http://127.0.0.1:${port}' + r).then(x => x.status, () => 0);
    (async () => {
      for (let i = 0; i < 100 && !(await get('/')); i++) await new Promise(r => setTimeout(r, 200));
      const codes = [];
      for (const r of ${JSON.stringify(c.runtimeTrace.routes)}) codes.push(r + ' ' + await get(r));
      srv.on('exit', () => console.log(JSON.stringify(codes)));
      srv.kill('SIGTERM');
    })();`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env, timeout: 120000 });
  const codes = JSON.parse((r.stdout || '[]').trim().split('\n').pop() || '[]');
  const bad = codes.filter(x => !/ 200$/.test(x));
  if (!codes.length || bad.length) throw new Error(`runtimeTrace: the standalone server answered ${codes.join(', ') || 'nothing'}${r.stderr ? `\n${r.stderr}` : ''}`);
  const nameOf = (f) => { const p = f.split(path.sep), i = p.lastIndexOf('node_modules'); return p[i + 1].startsWith('@') ? `${p[i + 1]}/${p[i + 2]}` : p[i + 1]; };
  const loaded = [...new Set(fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(nameOf))].sort();
  const names = new Set(listed.map(p => p.replace(/@[^@]*$/, '')));
  const missing = loaded.filter(n => !names.has(n));
  if (missing.length) throw new Error(`runtimeTrace: the server loaded ${missing.join(' ')} from node_modules, which the lockfile does not list`);
  return `the standalone server loaded ${loaded.length} packages, all listed`;
}

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
  // {fixture} in NODE_OPTIONS too: other tools' preloads and loaders installed in the fixture
  const caseOptions = (o) => (o ? o.split('{fixture}').join(dir) : '');
  const nodeOptions = c.nodeOptionsWith ? c.nodeOptionsWith(register)
    : [caseOptions(c.nodeOptions), c.inject === false ? '' : `--require ${register}`, caseOptions(c.nodeOptionsAfter)].filter(Boolean).join(' ');
  const env = { ...base, NODE_OPTIONS: nodeOptions };
  const notes = [];
  const entries = checkEntries(c, dir);
  if (entries) notes.push(entries);
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
    const r = watched(c.cmd, { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 << 20, timeout: TIMEOUT });
    if (r.error && r.error.code === 'ETIMEDOUT') throw new Error(`"${c.cmd}" timed out after ${TIMEOUT / 1000} s; the processes 30 s before (pid, state, wchan, command):\n${r.hang}`);
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status === 0) throw new Error(`"${c.cmd}" succeeded, expected it to fail with ${c.expectError}`);
    if (!c.expectError.test(out)) throw new Error(`"${c.cmd}" failed, but its output does not match ${c.expectError}\n${out.split('\n').slice(-15).join('\n')}`);
    // a failed build writes no lockfile: with an export dir, no copy there either
    const left = exportDir ? readLockfiles(exportDir, c.lockfile) : {};
    if (Object.keys(left).length) throw new Error(`"${c.cmd}" failed as expected, but wrote lockfiles to the export dir${show(left)}`);
    return `failed as expected (${c.expectError})${exportDir ? ', no export copy' : ''}`;
  }
  const build = run(c.cmd, dir, env);
  const warned = checkWarnings(c, build.stdout + build.stderr, env);
  if (warned) notes.push(warned);
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
      checkLocations(exported, at, [dir]);
    }
    notes.push(c.exportOnly ? 'export dir only' : 'export dir = inline');
  }
  const all = [...new Set(Object.values(got).flat())].sort();
  // BUNDLE_LOCKFILE_TREE (src/core/tree.cjs): next to each lockfile under test, a package.json per entry - its name,
  // version and license, at a package root; none without the setting
  const tree = String(base.BUNDLE_LOCKFILE_TREE || '').trim().toLowerCase() || 'off';
  for (const k of Object.keys(got)) {
    const lf = path.join(lockDir, k, c.lockfile || LOCKFILE);
    const stubs = treeOf(path.dirname(lf));
    if (tree === 'off') { if (stubs) throw new Error(`${lf}: a package.json tree without BUNDLE_LOCKFILE_TREE`); continue; }
    const lock = JSON.parse(fs.readFileSync(lf, 'utf8'));
    const want = Object.entries(lock.packages).filter(([key]) => key).map(([, p]) => `${p.name}@${p.version} ${p.license || '-'}`).sort();
    if (!stubs || JSON.stringify(stubs) !== JSON.stringify(want)) throw new Error(`${lf}: its tree has ${(stubs || ['(none)']).join(', ')}\n  want ${want.join(', ')}`);
  }
  if (tree !== 'off') notes.push(`tree ${tree}: a package.json per entry`);

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
  const located = Object.keys(inline).reduce((n, k) => n + checkLocations(path.join(outDir, k, c.lockfile || LOCKFILE), undefined, [dir]), 0);
  if (located) notes.push(`${located} locations`);
  // expectAnchor: 'ids' - the records have no paths (an output outside the project, docs/format.md), 'paths' (default
  // for a case that names it) - they have context and self
  if (c.expectAnchor) {
    for (const k of Object.keys(inline)) {
      const m = JSON.parse(fs.readFileSync(path.join(outDir, k, c.lockfile || LOCKFILE), 'utf8'))['bundle-lockfile'];
      const ids = typeof m.contextId === 'string' && typeof m.selfId === 'string' && m.context === undefined && m.self === undefined;
      if (ids !== (c.expectAnchor === 'ids')) throw new Error(`record of ${k || '.'}: ${JSON.stringify({ context: m.context, self: m.self, contextId: m.contextId })}, want ${c.expectAnchor}`);
    }
    notes.push(`records with ${c.expectAnchor}`);
  }
  // the bundler of each output (whose code is in it): with JavaScript, at least one, each a package installed in the
  // fixture (or Next.js' webpack, at its version) - which one exactly, the oracle says. The expectations below are about
  // the other packages: the bundlers' versions are not pinned in the fixtures (Vite's Rollup, workbox-build's)
  // (Yarn PnP: none; a case whose packages are outside the project - pnpm's global store - neither)
  const inFixture = fs.existsSync(path.join(dir, 'node_modules')) && !c.outside ? bundlers.installed(dir) : null;
  // (JavaScript: a file its writers wrote - an output directory can hold other compilers' outputs, Next.js' .next/server)
  const writesJs = (k) => {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(lockDir, k, c.lockfile || LOCKFILE), 'utf8'))['bundle-lockfile']; } catch { return false; }
    return !!m && (m.writers || []).some(w => (w.files || []).some(f => /\.[cm]?js$/.test(f)));
  };
  for (const [k, list] of Object.entries(got)) {
    const listed = list.filter(bundlers.isBundler);
    // (with an oracle, the oracle says exactly which bundler, and whether one: a JavaScript asset a plugin writes - Next.js'
    // manifests - has no bundler code; without one, JavaScript means a bundler)
    if (!listed.length && c.oracle === false && writesJs(k)) throw new Error(`${k || '.'}: its writers wrote JavaScript, its lockfile lists no bundler`);
    const strange = inFixture ? listed.filter(id => !inFixture.has(id)) : [];
    if (strange.length) throw new Error(`${k || '.'}: listed as the bundler, installed nowhere in the fixture: ${strange.join(' ')}`);
  }
  if (Object.values(got).some(l => l.some(bundlers.isBundler))) notes.push('bundlers installed');
  const plain = Object.fromEntries(Object.entries(got).map(([k, l]) => [k, bundlers.without(l)]));
  const strip = (m) => Object.fromEntries(Object.entries(m).map(([k, l]) => [k, bundlers.without(l)]));
  if (c.expect && !sameMap(plain, { '': bundlers.without(c.expect) })) throw new Error(`lockfile mismatch\n  got:${show(got)}\n  want: ${c.expect.join(' ')}`);
  if (c.expectIn) {
    // "oracle": the output must be there; what it lists is the oracle's (compared below)
    if (Object.values(c.expectIn).includes('oracle') && c.oracle === false) throw new Error('expectIn: "oracle" needs the oracle');
    const want = Object.fromEntries(Object.entries(c.expectIn).map(([k, v]) => [k, v === 'oracle' ? got[k] || ['(missing)'] : v]));
    if (!sameMap(plain, strip(want))) throw new Error(`lockfiles mismatch\n  got:${show(got)}\n  want:${show(want)}`);
  }
  if (c.expectKeys) {
    const lock = JSON.parse(fs.readFileSync(path.join(lockDir, c.lockfile || LOCKFILE), 'utf8'));
    const keys = Object.entries(lock.packages).filter(([k, p]) => k && !bundlers.isBundler(`${p.name}@${p.version}`)).map(([k, p]) => `${k} = ${p.name}@${p.version}`).sort(cmp);
    const want = Object.entries(c.expectKeys).filter(([, v]) => !bundlers.isBundler(v)).map(([k, v]) => `${k} = ${v}`).sort(cmp);
    if (JSON.stringify(keys) !== JSON.stringify(want)) throw new Error(`lockfile keys\n    got:  ${keys.join(', ')}\n    want: ${want.join(', ')}`);
    notes.push('keys as expected');
  }
  // expectVia: { class: [name@version] } - exactly these packages are recorded as found that way (src/core/via.cjs),
  // as the case knows from its fixture (which files are workers, copies, style sheets); the classes it does not name are
  // not checked
  if (c.expectVia) {
    const v = viaOf(path.join(lockDir, c.lockfile || LOCKFILE));
    for (const [cls, want] of Object.entries(c.expectVia)) {
      // (the bundlers, whose versions the fixtures do not pin - workbox-build's Rollup -, only where the case names them:
      // the runtime class; the check above and the oracle cover them)
      const ofCls = cls === 'runtime' ? (v[cls] || []) : bundlers.without(v[cls] || []);
      if (!same(ofCls, cls === 'runtime' ? want : bundlers.without(want))) throw new Error(`via ${cls}: ${(v[cls] || []).join(' ') || '(none)'}, want ${want.join(' ') || '(none)'}`);
    }
    notes.push(`via ${Object.keys(c.expectVia).join(', ')} as expected`);
  }
  if (c.watchBuilds) {
    const builds = JSON.parse(build.stdout.trim().split('\n').pop()).map(b => (Array.isArray(b) ? bundlers.without(b) : b));
    const want = c.watchBuilds.map(b => (Array.isArray(b) ? bundlers.without(b) : b));
    if (builds.length !== want.length || !builds.every((b, i) => same(b, want[i]))) throw new Error(`watch builds: ${JSON.stringify(builds)}, want ${JSON.stringify(c.watchBuilds)}`);
    notes.push(`${builds.length} watch builds`);
  }
  const missing = (c.expectIncludes || []).filter(p => !all.includes(p));
  if (missing.length) throw new Error(`missing ${missing.join(' ')} in${show(got)}`);
  const unwanted = (c.expectExcludes || []).filter(p => all.includes(p));
  if (unwanted.length) throw new Error(`unexpected ${unwanted.join(' ')} in${show(got)}`);
  for (const [k, list] of Object.entries(c.expectIncludesIn || {})) {
    const miss = list.filter(p => !(got[k] || []).includes(p));
    if (miss.length) throw new Error(`missing ${miss.join(' ')} in output ${k || '.'}:${show(got)}`);
  }
  for (const [k, list] of Object.entries(c.expectExcludesIn || {})) {
    const extra = list.filter(p => (got[k] || []).includes(p));
    if (extra.length) throw new Error(`unexpected ${extra.join(' ')} in output ${k || '.'}:${show(got)}`);
  }

  // canaries (test/apps/canary): found in the output's bytes, not through the bundler - each one listed (except exactly
  // the case's canaryUnlisted: a documented limit, pinned), and each listed one there
  const shipped = [...new Set([outDir, ...(c.canaryDirs || []).map(d => path.resolve(dir, d))].flatMap(canaries))].sort();
  const unlisted = shipped.filter(p => !all.includes(p));
  if (!same(unlisted, c.canaryUnlisted || [])) {
    throw new Error(`in the output, not listed: ${unlisted.join(' ') || '(none)'}${c.canaryUnlisted ? `; want exactly ${c.canaryUnlisted.join(' ')}` : ''}`);
  }
  const absent = all.filter(p => p.startsWith('bl-canary-') && !shipped.includes(p));
  if (absent.length) throw new Error(`listed, not in the output: ${absent.join(' ')}`);
  if (shipped.length) notes.push(`${shipped.length} canaries in the output, ${unlisted.length ? `all listed but ${unlisted.join(' ')}, as expected` : 'all listed'}`);

  if (c.runtimeTrace) notes.push(runtimeTrace(c, outDir, got[''] || [], base));

  // syft first: the oracle's build may write where the case's build wrote (adapter-netlify's .netlify/, Next's .next/
  // with output: 'export')
  if (hasSyft) {
    // a directory scan reads the lockfile - none with BUNDLE_LOCKFILE_TREE=only, whose record no SBOM tool reads; one as
    // of an image reads the tree (each package once)
    const s = JSON.parse(sh(`syft scan dir:${lockDir} -q -o json`, dir, base));
    const names = syftIds(s);
    if (!same(names, tree === 'only' ? [] : all)) throw new Error(`syft read ${names.join(' ')}\n  want ${tree === 'only' ? '(none)' : all.join(' ')}`);
    const bad = (s.artifacts || []).filter(p => p.foundBy !== 'javascript-lock-cataloger' || !p.purl.startsWith('pkg:npm/') || !(p.licenses || []).length);
    if (bad.length) throw new Error(`syft: unexpected cataloger/purl/license for ${bad.map(p => p.name).join(', ')}`);
    if (tree !== 'off') {
      const img = JSON.parse(sh(`syft scan dir:${lockDir} --override-default-catalogers image -q -o json`, dir, base));
      const ids = (img.artifacts || []).filter(a => a.type === 'npm').map(a => `${a.name}@${a.version}`).sort();
      if (JSON.stringify(ids) !== JSON.stringify([...new Set(ids)]) || !same(ids, all)) throw new Error(`syft (image catalogers) read ${ids.join(' ')}\n  want ${all.join(' ')}`);
      notes.push('syft agrees, also as an image');
    } else notes.push('syft agrees');

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
    if (!same(names, tree === 'only' ? [] : all)) throw new Error(`trivy read ${names.join(' ')}\n  want ${tree === 'only' ? '(none)' : all.join(' ')}`);
    const bad = pkgs.filter(p => !p.purl.startsWith('pkg:npm/') || !p.licensed);
    if (bad.length) throw new Error(`trivy: unexpected purl/license for ${bad.map(p => p.id).join(', ')}`);
    if (tree !== 'off') {
      const root = trivyInstalled(JSON.parse(sh(`trivy rootfs -q --skip-version-check --format cyclonedx ${lockDir}`, dir, base)));
      if (!same(root, all)) throw new Error(`trivy rootfs read ${root.join(' ')}\n  want ${all.join(' ')}`);
      notes.push('trivy agrees, also on the root file system');
    } else notes.push('trivy agrees');
  }

  // oracle: same fixture, built without bundle-lockfile (keep only the case's own NODE_OPTIONS)
  if (c.oracle === false && c.expectSources) throw new Error('expectSources needs the oracle');
  if (c.oracle === false) notes.push('no oracle (see case)');
  else {
    const oracle = path.join(__dirname, 'oracles', `${c.oracleScript || fx.bundler || 'webpack'}.cjs`);
    const node = fs.existsSync(path.join(dir, '.pnp.cjs')) ? 'yarn node' : 'node';
    // PATH: not through the node shim, which would inject bundle-lockfile
    // (the Rollup oracle builds with Rollup's command line: the bundler of a case whose command runs Rolldown's API -
    // build.mjs rolldown-*, rolldown.mjs - is Rolldown, BLTEST_ORACLE_BUNDLER)
    const oracleBundler = c.oracleBundler || (fx.bundler === 'esbuild' ? (/wasm/.test(c.fixture) ? 'esbuild-wasm' : '')
      : fx.bundler !== 'rollup' ? '' : /\brolldown(\.mjs|-|\b)/.test(c.cmd) ? 'rolldown' : /wasm/.test(c.cmd) ? '@rollup/wasm-node' : '');
    const printed = JSON.parse(sh(`${node} ${oracle} ${c.oracleArgs || ''}${c.expectSources ? ' --sources' : ''}`, dir, { ...base, NODE_OPTIONS: caseOptions(c.nodeOptions), PATH: process.env.PATH, BLTEST_OUT_DIR: outDir, BLTEST_ORACLE_BUNDLER: oracleBundler }).trim().split('\n').pop());
    const truth = c.expectSources ? printed.packages : printed;
    // expectSources: the files the case is about are in the output, by the oracle - without them it would test nothing
    if (c.expectSources) {
      if (!Array.isArray(printed.sources)) throw new Error(`expectSources: oracle ${path.basename(oracle)} lists no sources`);
      const sources = printed.sources.map(f => f.split(path.sep).join('/'));
      const missingSources = c.expectSources.filter(p => !sources.some(f => f.includes(p)));
      if (missingSources.length) throw new Error(`the oracle's build has no source file from ${missingSources.join(' ')}: the case does not test what it is for`);
      notes.push(`${c.expectSources.length} source path(s) bundled, by the oracle`);
    }
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
// minNode { <major>: <oldest minor> }: a listed major from that minor on, a newer major than every listed one
const minNodeOk = (min) => {
  const [ma, mi] = process.versions.node.split('.').map(Number);
  if (min[ma] !== undefined) return mi >= min[ma];
  return ma > Math.max(...Object.keys(min).map(Number));
};
if (!hasSyft) console.log('note: syft not on PATH, skipping syft checks');
if (!hasTrivy) console.log('note: trivy not on PATH, skipping Trivy checks');
for (const c of selected) {
  // the build tool itself does not run on this Node.js (the case says why)
  if (c.maxNode && NODE_MAJOR > c.maxNode) { skipped++; console.log(`SKIP  ${c.name}: needs Node.js <= ${c.maxNode}, this is ${process.versions.node}`); continue; }
  if (c.minNode && !minNodeOk(c.minNode)) { skipped++; console.log(`SKIP  ${c.name}: needs Node.js ${Object.entries(c.minNode).map(([ma, mi]) => `${ma}.${mi}+`).join(' / ')}, this is ${process.versions.node}`); continue; }
  try { console.log(`PASS  ${c.name}: ${runCase(c)}`); } catch (e) { failed++; console.log(`FAIL  ${c.name}: ${e.message}`); }
}
console.log(`\n${selected.length - failed - skipped}/${selected.length - skipped} passed${skipped ? `, ${skipped} skipped` : ''}`);
// a selection that runs nothing (a regex that matches no case, a renamed fixture) is no pass
if (selected.length - skipped === 0) { console.log('no case ran'); process.exit(1); }
process.exit(failed ? 1 : 0);
