'use strict';
// Unit tests of the settings (environment, settings file), register.cjs, the node shim and child processes.
// All unit tests: node --test test/unit/*.test.cjs (see test/README.md)
// (helpers.cjs first: see there)
const {
  strictEnv, nodeWith, SRC, J, pathToFileURLHref, project, LOCK, lockedNames, withConfig, rollupBuild, TEST,
} = require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../../src/core/config.cjs');
const problems = require('../../src/core/problems.cjs');

test('register: BUNDLE_LOCKFILE_DISABLE=all installs no hooks', () => {
  const script = `const M = require('module'); const before = M._extensions['.js']; require(${JSON.stringify(J(SRC, 'register.cjs'))}); console.log(M._extensions['.js'] === before);`;
  // the rollup, rspack, esbuild, parcel, angular and next adapters hook CommonJS modules too (Rollup's CommonJS build,
  // rspack, esbuild, @parcel/core, Angular's builder, next build): only off with all names
  for (const [disable, untouched] of [['all', 'true'], ['webpack,rollup,rolldown,vite,rspack,esbuild,parcel,angular,next', 'true'], ['ALL', 'true'], [' Webpack ,ROLLUP,rolldown, vite,RSPACK,ESBuild,Parcel,Angular,Next', 'true'],
    ['webpack,rollup,rolldown,vite,rspack,esbuild,parcel,angular', 'false'], ['next', 'false'],
    ['webpack,rollup,rolldown,vite,rspack,esbuild,parcel', 'false'], ['webpack,rollup,rolldown,vite,rspack,esbuild', 'false'], ['webpack,rollup,rolldown,vite,rspack', 'false'], ['webpack,rollup,rolldown,vite', 'false'], ['webpack', 'false'], ['webpack,vite', 'false'], ['', 'false'], ['rspack', 'false'], ['esbuild', 'false']]) {
    const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, BUNDLE_LOCKFILE_DISABLE: disable }, encoding: 'utf8' });
    assert.equal(r.stdout.trim(), untouched, `BUNDLE_LOCKFILE_DISABLE=${disable}: ${r.stderr}`);
  }
});

test('node shim: puts the --require back into NODE_OPTIONS, runs the real node, also behind a wrapper pointing at it', { skip: process.platform === 'win32' }, () => {
  const SHIM = J(TEST, '../bin/node'), REGISTER = fs.realpathSync(J(SRC, 'register.cjs'));
  const root = project({
    // prints whether bundle-lockfile was preloaded, NODE_OPTIONS and process.execPath
    'probe.cjs': `console.log(JSON.stringify({ loaded: !!globalThis[Symbol.for('bundle-lockfile.hooks-installed')], options: process.env.NODE_OPTIONS || '', execPath: process.execPath }));`,
  });
  fs.mkdirSync(J(root, 'yarn/bin'), { recursive: true });
  fs.writeFileSync(J(root, 'yarn/bin/yarn.js'), `require(${JSON.stringify(J(root, 'probe.cjs'))});`);
  fs.mkdirSync(J(root, 'shim')); fs.copyFileSync(SHIM, J(root, 'shim/node')); fs.chmodSync(J(root, 'shim/node'), 0o755);
  fs.mkdirSync(J(root, 'src')); fs.symlinkSync(REGISTER, J(root, 'src/register.cjs')); // ../src/register.cjs next to the shim
  // yarn's temporary wrapper: `node` first in PATH, running the shim (as yarn does after register.cjs pointed its execPath there)
  fs.mkdirSync(J(root, 'wrapper')); fs.writeFileSync(J(root, 'wrapper/node'), `#!/bin/sh\nexec "${J(root, 'shim/node')}" "$@"\n`, { mode: 0o755 });
  const realDir = path.dirname(fs.realpathSync(process.execPath));
  const run = (script, { nodeOptions, pathDirs = [J(root, 'wrapper'), J(root, 'shim'), realDir] } = {}) => {
    const env = { ...process.env, PATH: [...pathDirs, '/usr/bin', '/bin'].join(':') };
    delete env.NODE_OPTIONS; delete env.BUNDLE_LOCKFILE_NODE_SHIM;
    if (nodeOptions !== undefined) env.NODE_OPTIONS = nodeOptions;
    const r = spawnSync(J(root, 'shim/node'), [J(root, script)], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  const plain = run('probe.cjs');
  assert.equal(plain.loaded, true);
  assert.equal(plain.options, `--require ${REGISTER}`);
  assert.equal(fs.realpathSync(plain.execPath), fs.realpathSync(process.execPath)); // the real node, not a wrapper
  assert.equal(run('probe.cjs', { nodeOptions: '--max-old-space-size=1024' }).options, `--require ${REGISTER} --max-old-space-size=1024`);
  for (const form of [`--require ${REGISTER}`, `--require=${REGISTER}`, `-r ${REGISTER}`]) {
    assert.equal(run('probe.cjs', { nodeOptions: `--max-old-space-size=1024 ${form}` }).options, `--max-old-space-size=1024 ${form}`, form); // never twice
  }
  // quoted, with a space, through a symlinked directory: the same register.cjs, not added again
  fs.symlinkSync(path.dirname(REGISTER), J(root, 'a b'));
  for (const form of [`--require "${J(root, 'a b/register.cjs')}"`, `--require="${J(root, 'a b/register.cjs')}"`]) {
    assert.equal(run('probe.cjs', { nodeOptions: `${form} --max-old-space-size=1024` }).options, `${form} --max-old-space-size=1024`, form);
  }
  // another copy of bundle-lockfile: no second --require (Next.js 15.0 - 16.3 break with several)
  fs.cpSync(SRC, J(root, 'other copy/src'), { recursive: true });
  const other = `--require "${J(root, 'other copy/src/register.cjs')}"`;
  const withOther = run('probe.cjs', { nodeOptions: other });
  assert.equal(withOther.options, other);
  assert.equal(withOther.loaded, true);
  // another tool's register.cjs is no copy
  fs.mkdirSync(J(root, 'tool')); fs.writeFileSync(J(root, 'tool/register.cjs'), '// another tool\n');
  assert.equal(run('probe.cjs', { nodeOptions: `--require ${J(root, 'tool/register.cjs')}` }).options, `--require ${REGISTER} --require ${J(root, 'tool/register.cjs')}`);
  // in yarn's process (and only there) process.execPath is the shim
  const yarn = run('yarn/bin/yarn.js');
  assert.equal(yarn.execPath, fs.realpathSync(J(root, 'shim/node')));
  const script = (rel) => { fs.mkdirSync(path.dirname(J(root, rel)), { recursive: true }); fs.writeFileSync(J(root, rel), `require(${JSON.stringify(J(root, 'probe.cjs'))});`); return rel; };
  for (const rel of ['.yarn/releases/yarn-4.9.2.cjs', 'corepack/v1/yarn/4.9.2/yarn.js', 'corepack/v1/yarn/1.22.22/bin/yarn.js', 'corepack/dist/yarn.js']) {
    assert.equal(run(script(rel)).execPath, fs.realpathSync(J(root, 'shim/node')), rel);
  }
  // scripts named after yarn are not yarn
  for (const rel of ['node_modules/yarn-deduplicate/yarn-deduplicate.js', 'scripts/yarn-audit-fix.js', 'build/yarn.js']) {
    assert.equal(fs.realpathSync(run(script(rel)).execPath), fs.realpathSync(process.execPath), rel);
  }
  // no node binary in PATH: a clear error, no loop through the wrapper
  fs.mkdirSync(J(root, 'tools')); // only what the shim needs
  for (const t of ['readlink', 'dirname', 'head']) fs.symlinkSync(spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim(), J(root, 'tools', t));
  const env = { ...process.env, PATH: [J(root, 'wrapper'), J(root, 'shim'), J(root, 'tools')].join(':') };
  const none = spawnSync(J(root, 'shim/node'), [J(root, 'probe.cjs')], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(none.status, 127);
  assert.match(none.stderr, /no node binary in PATH/);
});

test('node shim: runs version managers\' script shims, skips itself and scripts it passed through; a --require through a symlink counts', { skip: process.platform === 'win32' }, () => {
  const SHIM = J(TEST, '../bin/node'), REGISTER = fs.realpathSync(J(SRC, 'register.cjs'));
  const realNode = fs.realpathSync(process.execPath);
  const root = project({
    'probe.cjs': `console.log(JSON.stringify({ loaded: !!globalThis[Symbol.for('bundle-lockfile.hooks-installed')], options: process.env.NODE_OPTIONS || '',
      execPath: process.execPath, seen: process.env.BUNDLE_LOCKFILE_NODE_SEEN === undefined ? null : process.env.BUNDLE_LOCKFILE_NODE_SEEN,
      child: process.argv[2] === 'child' ? null : JSON.parse(require('child_process').execFileSync('node', [__filename, 'child'], { encoding: 'utf8' })) }));`,
  });
  const dir = (d, files) => { fs.mkdirSync(J(root, d), { recursive: true }); for (const [f, c] of Object.entries(files)) fs.writeFileSync(J(root, d, f), c, { mode: 0o755 }); };
  dir('install/bin', {}); fs.copyFileSync(SHIM, J(root, 'install/bin/node')); fs.chmodSync(J(root, 'install/bin/node'), 0o755);
  dir('install/src', {}); fs.symlinkSync(REGISTER, J(root, 'install/src/register.cjs'));
  fs.symlinkSync(J(root, 'install'), J(root, 'linked'), 'dir'); // e.g. /opt/bundle-lockfile -> /usr/lib/bundle-lockfile
  // asdf's and nodenv's shims: scripts that run the real node by its path
  dir('asdf/shims', { node: `#!/bin/sh\n# asdf-plugin: nodejs\nexec "${realNode}" "$@"\n` });
  // a script that runs whatever `node` is in PATH: back to the shim, which must not run it again
  dir('loop', { node: '#!/bin/sh\nexec node "$@"\n' });
  dir('copy', {}); fs.copyFileSync(SHIM, J(root, 'copy/node')); fs.chmodSync(J(root, 'copy/node'), 0o755); // another copy of the shim
  const run = (shim, pathDirs, nodeOptions) => {
    const env = { ...process.env, PATH: [...pathDirs.map(d => J(root, d)), '/usr/bin', '/bin'].join(':') };
    delete env.NODE_OPTIONS; delete env.BUNDLE_LOCKFILE_NODE_SHIM; delete env.BUNDLE_LOCKFILE_NODE_SEEN;
    if (nodeOptions !== undefined) env.NODE_OPTIONS = nodeOptions;
    const r = spawnSync(J(root, shim), [J(root, 'probe.cjs')], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  // (a script running `node` first in PATH would run itself, with or without the shim: the shim comes first)
  for (const pathDirs of [['install/bin', 'asdf/shims'], ['install/bin', 'loop', 'copy', 'asdf/shims'], ['install/bin', 'copy', 'loop', 'asdf/shims']]) {
    const r = run('install/bin/node', pathDirs);
    assert.equal(r.loaded, true, pathDirs.join(' '));
    assert.equal(r.options, `--require ${REGISTER}`, pathDirs.join(' '));
    assert.equal(fs.realpathSync(r.execPath), realNode, pathDirs.join(' '));
    assert.equal(r.seen, null, `${pathDirs.join(' ')}: what the shim passed through is not passed on`);
    // a node this one starts through PATH (with NODE_OPTIONS overwritten, as cross-env does) goes through the same scripts again
    assert.equal(r.child.loaded, true, pathDirs.join(' '));
    assert.equal(fs.realpathSync(r.child.execPath), realNode, pathDirs.join(' '));
  }
  // NODE_OPTIONS already has the --require, through the symlinked install directory: not a second one (Next 15-16.3
  // fail with two)
  for (const form of [`--require ${J(root, 'linked/src/register.cjs')}`, `--require=${J(root, 'linked/src/register.cjs')}`, `-r "${J(root, 'linked/src/register.cjs')}"`]) {
    assert.equal(run('linked/bin/node', ['linked/bin', 'asdf/shims'], form).options, form, form);
  }
  // no node at all: a clear error, also with scripts in PATH that lead back to the shim
  fs.mkdirSync(J(root, 'tools'));
  for (const t of ['readlink', 'dirname', 'head']) fs.symlinkSync(spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim(), J(root, 'tools', t));
  const env = { ...process.env, PATH: ['install/bin', 'loop', 'copy', 'tools'].map(d => J(root, d)).join(':') };
  delete env.BUNDLE_LOCKFILE_NODE_SEEN;
  const none = spawnSync(J(root, 'install/bin/node'), [J(root, 'probe.cjs')], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(none.status, 127, none.stderr);
  assert.match(none.stderr, /no node binary in PATH/);
});

test('node shim: without a register.cjs it fails (BUNDLE_LOCKFILE_STRICT=0: warns and runs node; BUNDLE_LOCKFILE_DISABLE=all: runs node)', { skip: process.platform === 'win32' }, () => {
  const SHIM = J(TEST, '../bin/node');
  const root = project({ 'probe.cjs': `console.log(JSON.stringify({ loaded: !!globalThis[Symbol.for('bundle-lockfile.hooks-installed')], options: process.env.NODE_OPTIONS || '' }));` });
  fs.mkdirSync(J(root, 'bin')); fs.copyFileSync(SHIM, J(root, 'bin/node')); fs.chmodSync(J(root, 'bin/node'), 0o755); // no ../src/register.cjs, no ../register.cjs
  const realDir = path.dirname(fs.realpathSync(process.execPath));
  const run = (vars) => {
    const env = { ...process.env, PATH: [J(root, 'bin'), realDir, '/usr/bin', '/bin'].join(':') };
    for (const k of ['NODE_OPTIONS', 'BUNDLE_LOCKFILE_NODE_SHIM', 'BUNDLE_LOCKFILE_NODE_SEEN', 'BUNDLE_LOCKFILE_REGISTER', 'BUNDLE_LOCKFILE_STRICT', 'BUNDLE_LOCKFILE_DISABLE']) delete env[k];
    Object.assign(env, vars);
    return spawnSync(J(root, 'bin/node'), [J(root, 'probe.cjs')], { env, encoding: 'utf8', timeout: 20000 });
  };
  // strict (the default, also for values that are not 0, false or off): node is not run
  for (const strict of [undefined, '', '1', 'yes', '0 1']) {
    const r = run(strict === undefined ? {} : { BUNDLE_LOCKFILE_STRICT: strict });
    assert.equal(r.status, 1, `${JSON.stringify(strict)}: ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^\[bundle-lockfile\] ERROR: node shim: no register\.cjs next to .*bin\/node \(\.\.\/src\/register\.cjs or \.\.\/register\.cjs\); set BUNDLE_LOCKFILE_REGISTER \(BUNDLE_LOCKFILE_STRICT=0 makes this a warning\)\n$/);
  }
  // a BUNDLE_LOCKFILE_REGISTER that names no file
  const named = run({ BUNDLE_LOCKFILE_REGISTER: J(root, 'gone/register.cjs') });
  assert.equal(named.status, 1);
  assert.match(named.stderr, /ERROR: node shim: BUNDLE_LOCKFILE_REGISTER names no file: .*gone\/register\.cjs;/);
  // BUNDLE_LOCKFILE_STRICT=0 (any case, spaces around it): a warning, node runs without bundle-lockfile
  for (const strict of ['0', 'false', ' OFF ']) {
    const r = run({ BUNDLE_LOCKFILE_STRICT: strict });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^\[bundle-lockfile\] WARNING: node shim: no register\.cjs next to .* - node runs without bundle-lockfile\n$/);
    assert.deepEqual(JSON.parse(r.stdout), { loaded: false, options: '' });
  }
  // bundle-lockfile disabled: nothing to preload, nothing to say
  for (const disable of ['all', 'webpack, ALL']) {
    const r = run({ BUNDLE_LOCKFILE_DISABLE: disable });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.deepEqual(JSON.parse(r.stdout), { loaded: false, options: '' });
  }
  assert.equal(run({ BUNDLE_LOCKFILE_DISABLE: 'webpack' }).status, 1); // not all of it
});

test('config: BUNDLE_LOCKFILE_DEBUG is on with 1, true or on; off when unset, empty (also only spaces), 0, false, off or not recognized', () => {
  const script = `require(${JSON.stringify(J(SRC, 'core/config.cjs'))}).debug('on');`;
  for (const [value, on] of [[undefined, false], ['', false], ['  ', false], ['0', false], ['false', false], ['FALSE', false], ['off', false],
    ['1', true], ['true', true], [' ON ', true], ['yes', false]]) {
    const env = { ...process.env };
    delete env.BUNDLE_LOCKFILE_DEBUG;
    if (value !== undefined) env.BUNDLE_LOCKFILE_DEBUG = value;
    const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
    assert.equal(r.stderr.includes('[bundle-lockfile] on'), on, `BUNDLE_LOCKFILE_DEBUG=${value}`);
  }
});

// settings file (src/core/config.cjs): bundle-lockfile from a copy with src/config.json; prints what the
// settings are in a child process
function withSettingsFile(content, env = {}) {
  const root = project({});
  for (const d of ['src', 'bin']) fs.cpSync(J(TEST, '..', d), J(root, d), { recursive: true });
  if (content !== null) fs.writeFileSync(J(root, 'src/config.json'), typeof content === 'string' ? content : JSON.stringify(content));
  const script = `const c = require(${JSON.stringify(J(root, 'src/core/config.cjs'))});
    console.log(JSON.stringify({ file: c.file, exportDir: c.exportDir, strict: c.strict, settings: c.settingsFile.file, error: c.settingsFile.error && c.settingsFile.error.message,
      other: process.env.OTHER_SETTING, invalid: c.invalid, child: require('child_process').execSync('node -p process.env.BUNDLE_LOCKFILE_EXPORT_DIR', { encoding: 'utf8' }).trim() }));`;
  const e = { ...process.env };
  for (const k of ['BUNDLE_LOCKFILE_EXPORT_DIR', 'BUNDLE_LOCKFILE_FILE', 'BUNDLE_LOCKFILE_CONFIG']) delete e[k];
  Object.assign(e, env);
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: e });
  assert.equal(r.status, 0, r.stderr);
  return { root, ...JSON.parse(r.stdout) };
}

test('settings file: config.json next to register.cjs sets what the environment does not; only BUNDLE_LOCKFILE_* keys', () => {
  const s = withSettingsFile({ BUNDLE_LOCKFILE_EXPORT_DIR: '/x/export', BUNDLE_LOCKFILE_FILE: 'sbom/package-lock.json', OTHER_SETTING: 'no',
    BUNDLE_LOCKFILE_CONFIG: '/elsewhere.json', BUNDLE_LOCKFILE_INLINE: 0 });
  assert.equal(s.settings, J(s.root, 'src/config.json'));
  assert.equal(s.exportDir, '/x/export');
  assert.equal(s.file, 'sbom/package-lock.json');
  assert.equal(s.other, undefined);
  assert.equal(s.child, '/x/export'); // processes the build starts get them
  assert.equal(s.error, null);
  // keys it cannot set are not used, and are invalid (register.cjs reports them)
  assert.deepEqual(s.invalid, [`the settings file ${s.settings} sets OTHER_SETTING, which is no setting of bundle-lockfile`,
    `the settings file ${s.settings} sets BUNDLE_LOCKFILE_CONFIG, which only the environment can set`]);
  const odd = withSettingsFile({ BUNDLE_LOCKFILE_EXPORT_DIR: { dir: '/x' }, BUNDLE_LOCKFILE_FILE: null, BUNDLE_LOCKFILE_REGISTER: '/r.cjs', BUNDLE_LOCKFILE_EXPORTDIR: '/x' });
  assert.equal(odd.exportDir, null);
  assert.deepEqual(odd.invalid.map(m => m.replace(odd.settings, 'F')), ['the settings file F sets BUNDLE_LOCKFILE_EXPORT_DIR to {"dir":"/x"}: not a string, number or boolean',
    'the settings file F sets BUNDLE_LOCKFILE_FILE to null: not a string, number or boolean', 'the settings file F sets BUNDLE_LOCKFILE_REGISTER, which only the environment can set',
    'the settings file F sets BUNDLE_LOCKFILE_EXPORTDIR, which is no setting of bundle-lockfile']);
  assert.deepEqual(withSettingsFile({ BUNDLE_LOCKFILE_EXPORT_DIR: '/x/export', BUNDLE_LOCKFILE_INLINE: 0, BUNDLE_LOCKFILE_STRICT: true }).invalid, []);
  // the environment wins, also set to '' (the file's value is not used)
  assert.equal(withSettingsFile({ BUNDLE_LOCKFILE_FILE: 'sbom/package-lock.json' }, { BUNDLE_LOCKFILE_FILE: 'env/package-lock.json' }).file, 'env/package-lock.json');
  assert.equal(withSettingsFile({ BUNDLE_LOCKFILE_EXPORT_DIR: '/x/export' }, { BUNDLE_LOCKFILE_EXPORT_DIR: '' }).exportDir, null);
  // none: nothing to say
  const none = withSettingsFile(null);
  assert.deepEqual([none.settings, none.error, none.exportDir], [null, null, null]);
});

// what config.cjs finds invalid for an environment (BUNDLE_LOCKFILE_* variables of this process removed first)
function invalidFor(vars) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BUNDLE_LOCKFILE_')));
  const r = spawnSync(process.execPath, ['-e', `const c = require(${JSON.stringify(J(SRC, 'core/config.cjs'))}); console.log(JSON.stringify({ invalid: c.invalid, strict: c.strict, inline: c.inline, firstParty: c.firstParty, tree: c.tree, file: c.file }))`],
    { env: { ...env, ...vars }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('config: a setting that is not recognized or cannot work is invalid', () => {
  assert.deepEqual(invalidFor({}).invalid, []);
  // every setting with a value it takes
  assert.deepEqual(invalidFor({ BUNDLE_LOCKFILE_FILE: 'sbom/package-lock.json', BUNDLE_LOCKFILE_EXPORT_DIR: '/x', BUNDLE_LOCKFILE_EXPORT_BASE: '/y',
    BUNDLE_LOCKFILE_INLINE: 'OFF', BUNDLE_LOCKFILE_STRICT: ' true ', BUNDLE_LOCKFILE_DEBUG: '', BUNDLE_LOCKFILE_FIRST_PARTY: '/app/lib/**, /**',
    BUNDLE_LOCKFILE_DISABLE: ' Vite , rolldown', BUNDLE_LOCKFILE_ESM_HOOKS: 'Async', BUNDLE_LOCKFILE_TREE: ' On ', BUNDLE_LOCKFILE_REGISTER: '/r.cjs',
    BUNDLE_LOCKFILE_NODE_SHIM: '/s', BUNDLE_LOCKFILE_NODE_SEEN: '/a:/b' }).invalid, []);
  const one = (vars) => { const { invalid } = invalidFor(vars); assert.equal(invalid.length, 1, JSON.stringify(invalid)); return invalid[0]; };
  assert.equal(one({ BUNDLE_LOCKFILE_EXPORTDIR: '/x' }), 'BUNDLE_LOCKFILE_EXPORTDIR is set, but is no setting of bundle-lockfile');
  // a name in another case: case-sensitive, it would not be read (Windows: it is)
  if (process.platform !== 'win32') assert.equal(one({ bundle_lockfile_strict: '0' }), 'bundle_lockfile_strict is set, but the settings of bundle-lockfile are named in upper case (BUNDLE_LOCKFILE_STRICT)');
  assert.equal(one({ BUNDLE_LOCKFILE_DISABLE: 'webpack,rsbuild' }), 'BUNDLE_LOCKFILE_DISABLE names rsbuild, which is none of webpack, rspack, vite, rollup, rolldown, esbuild, parcel, angular, next or all');
  assert.equal(one({ BUNDLE_LOCKFILE_ESM_HOOKS: 'asnyc' }), 'BUNDLE_LOCKFILE_ESM_HOOKS=asnyc is none of auto, sync, async, off');
  assert.equal(one({ BUNDLE_LOCKFILE_TREE: 'both' }), 'BUNDLE_LOCKFILE_TREE=both is none of off, on, only');
  // the tree: off unless asked for (also for a value not recognized); only: the record in record.json, which no SBOM
  // tool reads, next to the tree
  assert.deepEqual([invalidFor({}).tree, invalidFor({ BUNDLE_LOCKFILE_TREE: 'both' }).tree, invalidFor({ BUNDLE_LOCKFILE_TREE: 'ON' }).tree], ['off', 'off', 'on']);
  assert.deepEqual(invalidFor({ BUNDLE_LOCKFILE_TREE: 'on' }).file, 'bundle-lockfile/package-lock.json');
  assert.deepEqual(invalidFor({ BUNDLE_LOCKFILE_TREE: 'only' }).file, 'bundle-lockfile/record.json');
  assert.deepEqual(invalidFor({ BUNDLE_LOCKFILE_TREE: 'only', BUNDLE_LOCKFILE_FILE: 'sbom/package-lock.json' }).file, 'sbom/record.json');
  for (const k of ['INLINE', 'STRICT', 'DEBUG']) {
    for (const v of ['yes', 'no', '2', 'disabled']) assert.equal(one({ [`BUNDLE_LOCKFILE_${k}`]: v }), `BUNDLE_LOCKFILE_${k}=${v} is not recognized (1, true or on; 0, false or off)`);
  }
  // a value not recognized: the default (strict stays on, and the build fails for the value)
  assert.deepEqual(invalidFor({ BUNDLE_LOCKFILE_STRICT: 'no', BUNDLE_LOCKFILE_INLINE: 'no' }).strict, true);
  assert.deepEqual(invalidFor({ BUNDLE_LOCKFILE_INLINE: 'no' }).inline, true);
  assert.match(one({ BUNDLE_LOCKFILE_EXPORT_DIR: 'out/export' }), /^BUNDLE_LOCKFILE_EXPORT_DIR is not an absolute path: out\/export/);
  assert.match(one({ BUNDLE_LOCKFILE_EXPORT_DIR: '/x', BUNDLE_LOCKFILE_EXPORT_BASE: '.' }), /^BUNDLE_LOCKFILE_EXPORT_BASE is not an absolute path: \./);
  assert.equal(one({ BUNDLE_LOCKFILE_EXPORT_BASE: '/y' }), 'BUNDLE_LOCKFILE_EXPORT_BASE is set without BUNDLE_LOCKFILE_EXPORT_DIR: it has no effect');
  assert.equal(one({ BUNDLE_LOCKFILE_FIRST_PARTY: '/app/lib/**,tools/**' }), 'BUNDLE_LOCKFILE_FIRST_PARTY names tools/**, which is not an absolute path (each process would match it against its own working directory)');
  assert.deepEqual(invalidFor({ BUNDLE_LOCKFILE_FIRST_PARTY: '/app/lib/**,tools/**' }).firstParty, ['/app/lib/**']);
  // the commas in braces are the glob's: /src/{a,b}/** is one glob, not "/src/{a" and "b}/**"
  assert.deepEqual(invalidFor({ BUNDLE_LOCKFILE_FIRST_PARTY: '/src/{a,b}/**, /x/{c,{d,e}}' }), { ...invalidFor({}), firstParty: ['/src/{a,b}/**', '/x/{c,{d,e}}'] });
  const { globTest } = require('../../src/core/vendored.cjs');
  assert.deepEqual(['/src/a/x', '/src/b', '/src/ab', '/x/e'].map(globTest('/src/{a,b}/**')), [true, true, false, false]);
  assert.match(one({ BUNDLE_LOCKFILE_CONFIG: 'config.json' }), /^BUNDLE_LOCKFILE_CONFIG is not an absolute path: config\.json/); // (and the file is missing: settingsFile.error)
  // the lockfile only where syft and Trivy read it
  for (const v of ['sbom/lock.json', '/abs/package-lock.json', '../package-lock.json', 'a/../../package-lock.json', 'node_modules/x/package-lock.json', 'package-lock.json/x']) {
    assert.match(one({ BUNDLE_LOCKFILE_FILE: v }), /^BUNDLE_LOCKFILE_FILE=.* is not a relative path inside the output directory to a file named package-lock\.json outside node_modules/, v);
  }
  for (const v of ['package-lock.json', 'a/b/package-lock.json', 'main.js/package-lock.json']) assert.deepEqual(invalidFor({ BUNDLE_LOCKFILE_FILE: v }).invalid, [], v);
  // normalized: "." and empty parts dropped, so that counting its directories finds the output directory
  for (const v of ['./sbom/package-lock.json', 'sbom//package-lock.json', 'sbom/./package-lock.json', './/sbom/package-lock.json']) {
    assert.deepEqual([invalidFor({ BUNDLE_LOCKFILE_FILE: v }).invalid, invalidFor({ BUNDLE_LOCKFILE_FILE: v }).file], [[], 'sbom/package-lock.json'], v);
  }
  assert.equal(invalidFor({ BUNDLE_LOCKFILE_FILE: './package-lock.json', BUNDLE_LOCKFILE_TREE: 'only' }).file, 'record.json');
  for (const v of ['./', '.', 'sbom/.']) assert.match(one({ BUNDLE_LOCKFILE_FILE: v }), /^BUNDLE_LOCKFILE_FILE=.* is not a relative path inside the output directory/, v);
});

test('config: BUNDLE_LOCKFILE_DISABLE takes exactly the adapters\' names', () => {
  const names = ['webpack', 'rollup', 'rspack', 'esbuild', 'parcel', 'angular', 'next'].flatMap(a => { const ad = require(J(SRC, 'adapters', `${a}.cjs`)); return ad.names || [ad.name]; });
  assert.deepEqual([...names].sort(), [...config.ADAPTER_NAMES].sort());
});

test('register: invalid settings fail the process (BUNDLE_LOCKFILE_STRICT=0: warnings; BUNDLE_LOCKFILE_DISABLE=all: nothing is checked)', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BUNDLE_LOCKFILE_')));
  const run = (vars) => spawnSync(process.execPath, ['--require', J(SRC, 'register.cjs'), '-e', '0'], { env: { ...env, ...vars }, encoding: 'utf8' });
  const strict = run({ BUNDLE_LOCKFILE_EXPORTDIR: '/x', BUNDLE_LOCKFILE_DEBUG: 'yes' });
  assert.equal(strict.status, 1, strict.stderr);
  assert.match(strict.stderr, /\[bundle-lockfile\] ERROR: BUNDLE_LOCKFILE_EXPORTDIR is set, but is no setting of bundle-lockfile\n\[bundle-lockfile\] ERROR: BUNDLE_LOCKFILE_DEBUG=yes is not recognized/);
  const off = run({ BUNDLE_LOCKFILE_EXPORTDIR: '/x', BUNDLE_LOCKFILE_STRICT: '0' });
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stderr, /\[bundle-lockfile\] WARNING: BUNDLE_LOCKFILE_EXPORTDIR is set, but is no setting of bundle-lockfile/);
  const all = run({ BUNDLE_LOCKFILE_EXPORTDIR: '/x', BUNDLE_LOCKFILE_DISABLE: 'all' });
  assert.deepEqual([all.status, all.stderr], [0, '']);
  assert.deepEqual([run({}).status, run({}).stderr], [0, '']);
});

test('register: another copy of bundle-lockfile preloaded too fails the process, whichever comes first; the same one through a link does not', () => {
  const root = project({ 'other/note.txt': '' });
  for (const d of ['src', 'bin']) fs.cpSync(J(TEST, '..', d), J(root, 'copy', d), { recursive: true });
  fs.symlinkSync(J(TEST, '..'), J(root, 'link'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BUNDLE_LOCKFILE_') && k !== 'NODE_OPTIONS'));
  const run = (nodeOptions, args = []) => spawnSync(process.execPath, [...args, '-e', '0'], { env: { ...env, NODE_OPTIONS: nodeOptions }, encoding: 'utf8' });
  const ours = J(SRC, 'register.cjs'), copy = J(root, 'copy/src/register.cjs');
  for (const opts of [`--require ${ours} --require ${copy}`, `--require=${copy} --require=${ours}`, `-r "${copy}" -r ${ours}`]) {
    const r = run(opts);
    assert.equal(r.status, 1, `${opts}: ${r.stderr}`);
    assert.match(r.stderr, /\[bundle-lockfile\] ERROR: another copy of bundle-lockfile is preloaded too: \S*register\.cjs \(only the first one runs; preload one\)/, opts);
  }
  // on the command line
  const cli = run(`--require ${ours}`, ['--require', copy]);
  assert.equal(cli.status, 1, cli.stderr);
  // one copy, also through a symbolic link to it, and a register.cjs of something else
  fs.writeFileSync(J(root, 'other/register.cjs'), '// ts-node style\n');
  for (const opts of [`--require ${ours}`, `--require ${ours} --require ${J(root, 'link/src/register.cjs')}`, `--require ${ours} --require ${J(root, 'other/register.cjs')}`]) {
    const r = run(opts);
    assert.deepEqual([r.status, r.stderr], [0, ''], opts);
  }
});

test('settings file: BUNDLE_LOCKFILE_CONFIG names it; one that cannot be used is an error the build fails with', () => {
  const named = J(project({ 's.json': { BUNDLE_LOCKFILE_EXPORT_DIR: '/named' } }), 's.json');
  const s = withSettingsFile({ BUNDLE_LOCKFILE_EXPORT_DIR: '/default' }, { BUNDLE_LOCKFILE_CONFIG: named });
  assert.deepEqual([s.settings, s.exportDir], [named, '/named']);
  assert.match(withSettingsFile(null, { BUNDLE_LOCKFILE_CONFIG: '/does/not/exist.json' }).error, /ENOENT/);
  assert.match(withSettingsFile('{not json').error, /JSON/);
  assert.equal(withSettingsFile('[1]').error, 'not a JSON object');
  // register.cjs reports it: strict mode fails the process (no build took it), BUNDLE_LOCKFILE_STRICT=0 warns
  const root = withSettingsFile('{not json').root;
  const reg = J(root, 'src/register.cjs');
  const strict = nodeWith(strictEnv(undefined), ['--require', reg, '-e', '0']);
  assert.equal(strict.status, 1, strict.stderr);
  assert.match(strict.stderr, /\[bundle-lockfile\] ERROR: could not read the settings file .*config\.json: .*JSON/);
  const off = nodeWith(strictEnv('0'), ['--require', reg, '-e', '0']);
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stderr, /\[bundle-lockfile\] WARNING: could not read the settings file/);
});

// --- settings, the preload and the shim

test('config: BUNDLE_LOCKFILE_FILE is trimmed (only spaces: the default), a backslash is no separator on POSIX; REGISTER must be absolute', () => {
  const fileFor = (v) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BUNDLE_LOCKFILE_')));
    const r = spawnSync(process.execPath, ['-e', `const c = require(${JSON.stringify(J(SRC, 'core/config.cjs'))}); console.log(JSON.stringify({ file: c.file, invalid: c.invalid }))`],
      { env: { ...env, BUNDLE_LOCKFILE_FILE: v }, encoding: 'utf8' });
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(fileFor('   '), { file: 'bundle-lockfile/package-lock.json', invalid: [] });
  assert.deepEqual(fileFor(' sbom/package-lock.json '), { file: 'sbom/package-lock.json', invalid: [] });
  if (path.sep === '/') {
    // a file literally named "sbom\package-lock.json": syft and Trivy read no such file
    for (const v of ['sbom\\package-lock.json', 'node_modules\\x\\package-lock.json']) {
      const { invalid } = fileFor(v);
      assert.equal(invalid.length, 1, v);
      assert.match(invalid[0], /^BUNDLE_LOCKFILE_FILE=.* is not a relative path inside the output directory to a file named package-lock\.json/);
    }
  }
  const one = (vars) => { const { invalid } = invalidFor(vars); assert.equal(invalid.length, 1, JSON.stringify(invalid)); return invalid[0]; };
  assert.match(one({ BUNDLE_LOCKFILE_REGISTER: 'bl/src/register.cjs' }), /^BUNDLE_LOCKFILE_REGISTER is not an absolute path: bl\/src\/register\.cjs/);
});

test('settings file: a value it sets that is not recognized names the file it comes from', () => {
  const s = withSettingsFile({ BUNDLE_LOCKFILE_INLINE: 'yes', BUNDLE_LOCKFILE_ESM_HOOKS: 'later', BUNDLE_LOCKFILE_EXPORT_DIR: 'rel', BUNDLE_LOCKFILE_FILE: 'x.json' });
  const F = `(from the settings file ${s.settings})`;
  assert.ok(s.invalid.some(m => m.startsWith(`BUNDLE_LOCKFILE_INLINE=yes ${F} is not recognized`)), JSON.stringify(s.invalid));
  assert.ok(s.invalid.some(m => m.startsWith(`BUNDLE_LOCKFILE_ESM_HOOKS=later ${F} is none of`)), JSON.stringify(s.invalid));
  assert.ok(s.invalid.some(m => m.startsWith(`BUNDLE_LOCKFILE_EXPORT_DIR is not an absolute path: rel ${F}`)), JSON.stringify(s.invalid));
  assert.ok(s.invalid.some(m => m.startsWith(`BUNDLE_LOCKFILE_FILE=x.json ${F} is not a relative path`)), JSON.stringify(s.invalid));
});

test('register: Node\'s own loader thread (which runs preloads too: Node.js 20, 22.14 and later) reports nothing a second time', { skip: process.platform === 'win32' }, () => {
  const root = project({ 'noop.mjs': 'export async function load(u, c, next) { return next(u, c); }' });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BUNDLE_LOCKFILE_') && k !== 'NODE_OPTIONS'));
  const r = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', pathToFileURLHref(J(root, 'noop.mjs')), '--require', J(SRC, 'register.cjs'), '-e', '0'],
    { encoding: 'utf8', env: { ...env, BUNDLE_LOCKFILE_BOGUS: '1', BUNDLE_LOCKFILE_STRICT: '0' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stderr.match(/BUNDLE_LOCKFILE_BOGUS is set, but is no setting of bundle-lockfile/g) || []).length, 1, r.stderr);
});

test('node shim: a relative BUNDLE_LOCKFILE_REGISTER fails (Node would take it for a package name, in every directory)', { skip: process.platform === 'win32' }, () => {
  const root = project({});
  const env = { PATH: `${path.join(TEST, '../bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root };
  const run = (vars) => spawnSync('sh', [J(TEST, '../bin/node'), '-e', 'console.log(process.env.NODE_OPTIONS || "")'], { cwd: J(TEST, '..'), env: { ...env, ...vars }, encoding: 'utf8' });
  const strict = run({ BUNDLE_LOCKFILE_REGISTER: 'src/register.cjs' }); // there, relative to this directory
  assert.equal(strict.status, 1, strict.stderr);
  assert.match(strict.stderr, /\[bundle-lockfile\] ERROR: node shim: BUNDLE_LOCKFILE_REGISTER is not an absolute path: src\/register\.cjs/);
  const off = run({ BUNDLE_LOCKFILE_REGISTER: 'src/register.cjs', BUNDLE_LOCKFILE_STRICT: '0' });
  assert.equal(off.status, 0, off.stderr);
  assert.equal(off.stdout.trim(), '');
  // a newline around the value: trimmed, as config.cjs does
  assert.equal(run({ BUNDLE_LOCKFILE_REGISTER: 'src/register.cjs', BUNDLE_LOCKFILE_STRICT: '0\n' }).status, 0);
  const abs = run({ BUNDLE_LOCKFILE_REGISTER: J(SRC, 'register.cjs') });
  assert.equal(abs.status, 0, abs.stderr);
  assert.match(abs.stdout, /--require \S*register\.cjs/);
});

test('config: BUNDLE_LOCKFILE_ESM_HOOKS=sync is invalid on a Node.js without module.registerHooks', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BUNDLE_LOCKFILE_')));
  const run = (value, without) => {
    const r = spawnSync(process.execPath, ['-e', `${without ? "require('module').registerHooks = undefined;" : "require('module').registerHooks = () => {};"}
      console.log(JSON.stringify(require(${JSON.stringify(J(SRC, 'core/config.cjs'))}).invalid))`], { env: { ...env, BUNDLE_LOCKFILE_ESM_HOOKS: value }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(run('sync', true), [`BUNDLE_LOCKFILE_ESM_HOOKS=sync needs module.registerHooks, which Node.js ${process.versions.node} does not have (22.15 and later): ES-module bundlers would not be hooked`]);
  assert.deepEqual(run(' Sync ', false), []);
  assert.deepEqual(run('async', true), []);
  assert.deepEqual(run('off', true), []);
});

test('STRICT=0: a Rolldown build with style whose inlined files cannot be read warns and writes its lockfile', () => withConfig({ strict: false }, async () => {
  const rollupAdapter = require('../../src/adapters/rollup.cjs');
  const root = project({ 'node_modules/a/package.json': { name: 'a', version: '1.0.0' } });
  const cwd = process.cwd();
  process.chdir(root);
  const orig = config.warn, seen = [];
  config.warn = (...a) => seen.push(a.join(' '));
  try {
    problems.take();
    const ctx = { meta: { rolldownVersion: '9.0.0' }, data: {}, error(e) { throw e; } };
    await rollupBuild(rollupAdapter.bundleLockfile('vite'), { outDir: J(root, 'dist'), ctx,
      chunks: [{ fileName: 'main.js', code: 'main', modules: [J(root, 'src/app.css'), J(root, 'node_modules/a/i.js')] }] });
    assert.match(seen.join('\n'), /Rolldown 9\.0\.0: could not read the files its plugins inlined/);
    assert.deepEqual(lockedNames(fs.readFileSync(J(root, 'dist', LOCK), 'utf8')), ['a']);
  } finally { config.warn = orig; process.chdir(cwd); }
}));

test('children: a node started with an environment that drops bundle-lockfile\'s --require warns once (the node shim: put back)', () => {
  const root = project({
    'parent.cjs': `const cp = require('child_process'), { Worker, SHARE_ENV } = require('worker_threads'), util = require('util');
      const has = "process.stdout.write(String((process.env.NODE_OPTIONS || '').includes('register.cjs')))";
      const out = (r) => String(r.stdout);
      const results = [];
      results.push(out(cp.spawnSync(process.execPath, ['-e', has], { env: { PATH: process.env.PATH } })));      // dropped
      results.push(out(cp.spawnSync(process.execPath, ['-e', has], { env: { ...process.env } })));             // kept
      results.push(out(cp.spawnSync(process.execPath, ['-e', has])));                                          // inherited
      results.push(String(cp.execFileSync('sh', ['-c', 'printf %s "$NODE_OPTIONS" | grep -c register.cjs || true'], { env: { PATH: process.env.PATH } })).trim()); // no node
      util.promisify(cp.execFile)(process.execPath, ['-e', has], { env: { ...process.env } }).then(async (r) => {
        results.push(typeof r === 'object' && 'stdout' in r && 'stderr' in r ? 'promisified' : 'broken');
        for (const env of [{}, SHARE_ENV]) {
          await new Promise((resolve) => { const w = new Worker('1', { eval: true, env }); w.on('exit', resolve); });
        }
        results.push(Worker.name);
        console.log(JSON.stringify(results));
      });`,
  });
  const run = (env) => spawnSync(process.execPath, [J(root, 'parent.cjs')], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: `--require ${J(SRC, 'register.cjs')}`, ...env } });
  const r = run({});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), ['false', 'true', 'true', '0', 'promisified', 'Worker']);
  assert.equal((r.stderr.match(/WARNING: node \(spawnSync -e\) is started with an environment whose NODE_OPTIONS lacks bundle-lockfile's --require: a bundler in it is not hooked/g) || []).length, 1, r.stderr);
  assert.equal((r.stderr.match(/WARNING:/g) || []).length, 1, r.stderr); // once per process: not again for the worker
  // with the node shim: the --require is put back, no warning
  const shim = run({ BUNDLE_LOCKFILE_NODE_SHIM: '/opt/bl/bin/node' });
  assert.equal(shim.status, 0, shim.stderr);
  assert.deepEqual(JSON.parse(shim.stdout.trim().split('\n').pop()).slice(0, 3), ['true', 'true', 'true']);
  assert.doesNotMatch(shim.stderr, /WARNING/);
  // the --require on the command line (not in NODE_OPTIONS) reaches no child anyway: nothing to say
  const cmdline = spawnSync(process.execPath, ['--require', J(SRC, 'register.cjs'), J(root, 'parent.cjs')], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(cmdline.status, 0, cmdline.stderr);
  assert.doesNotMatch(cmdline.stderr, /WARNING/);
  // a relative --require is put back by its absolute path: a child in another directory finds it
  fs.symlinkSync(SRC, J(root, 'bl'), 'dir');
  fs.mkdirSync(J(root, 'elsewhere'));
  fs.writeFileSync(J(root, 'rel.cjs'), `const r = require('child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(String(!!globalThis[Symbol.for("bundle-lockfile.settings-reported")]))'],
    { cwd: ${JSON.stringify(J(root, 'elsewhere'))}, env: { PATH: process.env.PATH }, encoding: 'utf8' });
    console.log(JSON.stringify([r.status, r.stdout]));`);
  const rel = spawnSync(process.execPath, [J(root, 'rel.cjs')], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '--require ./bl/register.cjs', BUNDLE_LOCKFILE_NODE_SHIM: '/opt/bl/bin/node' } });
  assert.equal(rel.status, 0, rel.stderr);
  assert.deepEqual(JSON.parse(rel.stdout.trim()), [0, 'true'], rel.stderr);
});
