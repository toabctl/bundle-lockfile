'use strict';
// The output format against the tools that read it: lockfiles with every kind of key and license bundle-lockfile
// writes (see docs/format.md), read by syft and Trivy, which must both report exactly the packages and
// licenses in them. Needs syft and trivy on PATH (CI installs both); no network, no fixtures:
//   node --test test/contract.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { toPackageLock } = require('../src/core/lockfile.cjs');

const J = (...p) => path.join(...p);
const has = (cmd, arg) => spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0;
const hasSyft = has('syft', 'version'), hasTrivy = has('trivy', '--version');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// A project below a temporary directory, its webpack context in app/ (as GitLab's: packages in ../node_modules), and
// a Yarn global cache outside of it. Nothing is read from these paths: toPackageLock gets the packages.
const tmp = fs.realpathSync(fs.mkdtempSync(J(os.tmpdir(), 'blr-contract-')));
const root = J(tmp, 'proj'), ctx = J(root, 'app'), cache = J(tmp, 'home/.yarn/berry/cache');
fs.mkdirSync(ctx, { recursive: true });
const pkg = (name, version, dir, license) => ({ name, version, path: dir, ...(license ? { license } : {}) });
const PACKAGES = [
  pkg('a', '1.0.0', J(ctx, 'node_modules/a'), 'MIT'),                                   // node_modules/a
  pkg('a', '2.0.0', J(root, 'node_modules/a'), 'MIT'),                                  // node_modules/a taken: node_modules/a@2.0.0
  pkg('@scope/b', '1.0.0', J(root, 'node_modules/@scope/b'), 'ISC'),                    // ../node_modules/@scope/b
  pkg('c', '1.0.0', J(root, 'node_modules/@scope/b/node_modules/c'), 'Apache-2.0'),     // nested
  pkg('ms', '2.0.0', J(root, 'node_modules/ms-old'), 'MIT'),                            // an alias: the key is not the name
  pkg('d', '1.0.0', J(ctx, 'node_modules/.pnpm/d@1.0.0/node_modules/d'), 'BSD-3-Clause'), // pnpm
  pkg('e', '1.0.0', J(ctx, 'packages/w/node_modules/e'), '(MIT OR Apache-2.0)'),        // a workspace's own node_modules
  pkg('f', '1.0.0', J(ctx, '.yarn/cache/f-npm-1.0.0-abc.zip/node_modules/f'), ['MIT', 'ISC']), // Yarn PnP; legacy licenses
  pkg('g', '1.0.0', J(cache, 'g-npm-1.0.0-def.zip/node_modules/g'), ['0BSD']),          // outside the project
  pkg('h', '1.0.0', J(ctx, 'node_modules/h')),                                          // no license
];
// name@version -> its license as bundle-lockfile writes it (one string), or null
const WANT = {
  'a@1.0.0': 'MIT', 'a@2.0.0': 'MIT', '@scope/b@1.0.0': 'ISC', 'c@1.0.0': 'Apache-2.0', 'ms@2.0.0': 'MIT', 'd@1.0.0': 'BSD-3-Clause',
  'e@1.0.0': 'MIT OR Apache-2.0', 'f@1.0.0': 'MIT OR ISC', 'g@1.0.0': '0BSD', 'h@1.0.0': null,
};
// the license in the output: an SPDX expression's outer parentheses are a detail of how a tool writes it
const norm = (l) => (l ? l.replace(/^\((.*)\)$/, '$1') : null);

// as an output's lockfile, with the bundle-lockfile record (a field neither tool knows)
const out = J(ctx, 'dist'), dir = J(out, 'bundle-lockfile');
fs.mkdirSync(dir, { recursive: true });
const json = toPackageLock(PACKAGES, ctx, { dir, writers: [{ id: 'w', files: [J(out, 'main.js')], paths: PACKAGES.map(p => p.path) }] });
fs.writeFileSync(J(dir, 'package-lock.json'), json);
fs.writeFileSync(J(out, 'main.js'), '');

test('the lockfile: every key in node_modules/, every license one string', () => {
  const lock = JSON.parse(json);
  const entries = Object.entries(lock.packages).filter(([k]) => k);
  for (const [k] of entries) assert.ok(k.startsWith('node_modules/'), k);
  assert.deepEqual(Object.fromEntries(entries.map(([, p]) => [`${p.name}@${p.version}`, norm(p.license || null)])), WANT);
});

test('syft reads every package, with its license', { skip: !hasSyft && 'syft not on PATH' }, () => {
  const doc = run('syft', ['scan', `dir:${out}`, '-q', '-o', 'json']);
  const got = {};
  for (const a of doc.artifacts || []) {
    assert.equal(a.foundBy, 'javascript-lock-cataloger', a.name);
    assert.ok(a.purl.startsWith('pkg:npm/'), a.purl);
    // syft lists an SPDX expression as one license, an array of strings as several
    got[`${a.name}@${a.version}`] = (a.licenses || []).map(l => norm(l.value)).sort().join(' OR ') || null;
  }
  assert.deepEqual(got, WANT);
});

test('Trivy (trivy fs) reads every package, with its license', { skip: !hasTrivy && 'trivy not on PATH' }, () => {
  const bom = run('trivy', ['fs', '-q', '--skip-version-check', '--format', 'cyclonedx', out]);
  const got = {};
  for (const c of bom.components || []) {
    if (c.type !== 'library') continue;
    assert.ok((c.purl || '').startsWith('pkg:npm/'), c.purl);
    const licenses = (c.licenses || []).map(l => norm(l.expression || (l.license && (l.license.id || l.license.name))));
    got[`${c.group ? `${c.group}/` : ''}${c.name}@${c.version}`] = licenses.sort().join(' OR ') || null;
  }
  assert.deepEqual(got, WANT);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
