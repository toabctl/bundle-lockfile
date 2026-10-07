'use strict';
// Test matrix as data: fixtures (app + bundler + installer) and cases (fixture + command + expectation).
// A new bundler or installer adds rows here; gen.cjs and run.cjs stay unchanged.

const APP_DEPS = { 'lodash-es': '4.18.1', uuid: '9.0.1', yallist: '5.0.0', debug: '2.6.9', ms: '2.1.3', nanoid: '3.3.20' };
// yallist 5 uses class fields, which webpack 4's parser (acorn 6) cannot handle
const APP4_DEPS = { 'lodash-es': '4.18.1', uuid: '9.0.1', debug: '2.6.9', ms: '2.1.3', nanoid: '3.3.20' };
const HTML = { 'html-webpack-plugin': '5.6.6' }; // adds a child compiler, which must not produce a second lockfile

const wp5 = (webpack, cli, extra = {}) => ({ app: 'webpack5', deps: { webpack, 'webpack-cli': cli, ...APP_DEPS, ...extra } });
const wp4 = (webpack, cli) => ({ app: 'webpack4', deps: { webpack, 'webpack-cli': cli, ...APP4_DEPS } });
const latest = wp5('5.111.1', '7.2.3', HTML);
// Next.js vendors its own webpack; pages router so one app works for every version
const next = (version, react) => ({
  app: 'next', bundler: 'next', installer: { type: 'npm' },
  deps: { next: version, react, 'react-dom': react, 'lodash-es': '4.18.1', uuid: '9.0.1', ms: '2.1.3' },
});

// dependencies vs devDependencies: what is shipped depends on what is imported, not on the section.
// Build tools are devDependencies as in real projects.
const devdeps = (installer) => ({
  app: 'webpack5-devdeps', installer,
  deps: { 'lodash-es': '4.18.1', 'is-number': '7.0.0' },                                        // is-number: never imported
  devDeps: { webpack: '5.111.1', 'webpack-cli': '7.2.3', classnames: '2.5.1', 'left-pad': '1.3.0' }, // classnames: imported
});

// edge cases, all webpack 5 + npm
const WEBPACK = { webpack: '5.111.1', 'webpack-cli': '7.2.3' };
const edge = (app, deps, extra = {}) => ({ app, installer: { type: 'npm' }, deps: { ...WEBPACK, ...deps }, ...extra });
const BABEL7 = { 'babel-loader': '10.1.1', '@babel/core': '7.29.7', '@babel/preset-env': '7.29.7', '@babel/plugin-transform-runtime': '7.29.7', '@babel/runtime': '7.29.10', 'core-js': '3.50.0' };

// installer: npm | yarn1 | bun (the tools in the test image) or a pinned, vendored yarn berry / pnpm release
const fixtures = {
  'wp4.0-npm': { ...wp4('4.0.0', '3.3.12'), installer: { type: 'npm' } },
  'wp4.47-npm': { ...wp4('4.47.0', '4.10.0'), installer: { type: 'npm' } },
  'wp5.0-npm': { ...wp5('5.0.0', '4.10.0'), installer: { type: 'npm' } }, // html-webpack-plugin 5 needs webpack >= 5.20
  'wp5.60-npm': { ...wp5('5.60.0', '4.10.0', HTML), installer: { type: 'npm' } },
  'wp5-npm': { ...latest, installer: { type: 'npm' } },
  'wp5-yarn1': { ...latest, installer: { type: 'yarn1' } },
  'wp5-yarn3-pnp': { ...latest, installer: { type: 'yarn-berry', version: '3.8.7', linker: 'pnp' } },
  'wp5-yarn4-pnp': { ...latest, installer: { type: 'yarn-berry', version: '4.18.1', linker: 'pnp' } },
  'wp5-yarn4-node-modules': { ...latest, installer: { type: 'yarn-berry', version: '4.18.1', linker: 'node-modules' } },
  'wp5-npm8': { ...latest, installer: { type: 'npm', version: '8.19.4' } },
  'wp5-npm9': { ...latest, installer: { type: 'npm', version: '9.9.4' } },
  'wp5-npm10': { ...latest, installer: { type: 'npm', version: '10.9.9' } },
  'wp5-npm11': { ...latest, installer: { type: 'npm', version: '11.21.0' } },
  'wp5-pnpm8': { ...latest, installer: { type: 'pnpm', version: '8.15.9' } },
  'wp5-pnpm9': { ...latest, installer: { type: 'pnpm', version: '9.15.9' } },
  'wp5-pnpm10': { ...latest, installer: { type: 'pnpm', version: '10.34.6' } },
  'wp5-pnpm11': { ...latest, installer: { type: 'pnpm', version: '11.28.5' } },
  'wp5-pnpm12': { ...latest, installer: { type: 'pnpm', version: '12.9.1' } },
  'wp5-bun': { ...latest, installer: { type: 'bun' } },
  'wp5-devdeps-npm': devdeps({ type: 'npm' }),
  'wp5-devdeps-yarn1': devdeps({ type: 'yarn1' }),
  'wp5-devdeps-pnpm11': devdeps({ type: 'pnpm', version: '11.28.5' }),
  'edge-alias': edge('edge-alias', { ms: '2.1.3', 'ms-old': 'npm:ms@2.0.0' }),
  'edge-babel': edge('edge-babel', BABEL7),
  'edge-css': edge('edge-css', { 'css-loader': '7.1.5', 'mini-css-extract-plugin': '2.10.2', 'normalize.css': '8.0.1', 'lodash-es': '4.18.1' }),
  'edge-asset': edge('edge-asset', { 'bootstrap-icons': '1.13.1' }),
  'edge-dll': edge('edge-dll', { debug: '2.6.9', ms: '2.1.3', 'lodash-es': '4.18.1' }),
  'edge-workspace': edge('edge-workspace', { '@acme/ui': '1.0.0' }, { packageJson: { workspaces: ['packages/*'] } }),
  'edge-subpkg': edge('edge-subpkg', { preact: '10.28.3' }),
  'next12': next('12.3.7', '18.3.1'),
  'next13': next('13.5.11', '18.3.1'),
  'next14': next('14.2.35', '18.3.1'),
  'next15': next('15.5.27', '19.3.0'),
  'next16': next('16.4.0', '19.3.0'),
};

const W5 = ['debug@2.6.9', 'lodash-es@4.18.1', 'ms@2.0.0', 'ms@2.1.3', 'nanoid@3.3.20', 'yallist@5.0.0'];
// webpack 4 also bundles its node polyfills (process) and webpack/buildin/* modules
const W4 = (v) => ['debug@2.6.9', 'lodash-es@4.18.1', 'ms@2.0.0', 'ms@2.1.3', 'nanoid@3.3.20', 'process@0.11.10', `webpack@${v}`];
const DEVDEPS = ['classnames@2.5.1', 'lodash-es@4.18.1'];
// installed in node_modules but not imported: proves the absence above is not an install artefact
const DEVDEPS_INSTALLED = ['classnames@2.5.1', 'left-pad@1.3.0', 'is-number@7.0.0', 'lodash-es@4.18.1'];
// expected SPDX package in a functional SBOM check (from = file syft says it found the package in)
const npmPkg = (name, version, license, from) => ({ name, version, purl: `pkg:npm/${name}@${version}`, license, from });
const DIST_LOCK = '/usr/share/app/dist/bundle-lockfile/package-lock.json'; // syft dir scans report absolute paths
const PROJECT_LOCK = '/usr/share/app/package-lock.json';
const LEGACY_SSL = '--openssl-legacy-provider'; // webpack 4 hashes with md4
const NEXT_ENV = { NEXT_TELEMETRY_DISABLED: '1' };

// Next.js: one lockfile per compiler (client, server, edge-server); the exact per-compiler lists come from the oracle
function nextCase(fixture, version, react, flags = '') {
  return {
    fixture, cmd: `./node_modules/.bin/next build ${flags}`.trim(), oracleArgs: flags, outDir: '.next', env: NEXT_ENV,
    expectIncludes: ['ms@2.1.3', 'lodash-es@4.18.1', `next@${version}`, `react@${react}`], expectExcludes: ['uuid@9.0.1'],
  };
}

// case fields:
//   cmd        build command, run with sh in the fixture dir; $PNPM is the fixture's vendored pnpm
//   inject     put --require <register.cjs> into NODE_OPTIONS (default true)
//   nodeOptions extra NODE_OPTIONS (kept for the oracle build too)
//   env        extra environment variables
//   expect     expected name@version list of the single output, or null = no lockfile must be written
//   expectIncludes / expectExcludes  packages that must / must not appear in any output (multi-compiler builds)
//   outDir     where the bundler writes (default dist); every lockfile below it is checked against the oracle
//   oracleArgs extra arguments for the oracle (e.g. next build flags)
//   installed  name@version that must be installed in the fixture's node_modules (checked before the build)
//   projectLockfile  syft on the project's own lockfile (not ours) must include / exclude these - documents the difference
//   sbom       functional checks: stage files into a package-like root, `syft scan dir:` it as SPDX JSON and
//              require exactly these npm packages (name, version, purl, declared license, source file)
//   heapMB     assert the configured --max-old-space-size reached node
//   expectOutput  RegExp the build's stdout+stderr must match
const cases = [
  // activation
  { name: 'not active without NODE_OPTIONS', fixture: 'wp5-npm', cmd: 'npm run -s build', inject: false, expect: null },
  { name: 'BUNDLE_LOCKFILE_DISABLE=webpack', fixture: 'wp5-npm', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_DISABLE: 'webpack' }, expect: null },
  { name: 'existing NODE_OPTIONS are preserved', fixture: 'wp5-npm', cmd: 'npm run -s build', nodeOptions: '--max-old-space-size=3072', heapMB: 3072, expect: W5 },
  // webpack versions
  { name: 'webpack 4.0.0', fixture: 'wp4.0-npm', cmd: 'npm run -s build', nodeOptions: LEGACY_SSL, expect: W4('4.0.0') },
  { name: 'webpack 4.47.0', fixture: 'wp4.47-npm', cmd: 'npm run -s build', nodeOptions: LEGACY_SSL, expect: W4('4.47.0') },
  { name: 'webpack 4.47.0, default-if-unset NODE_OPTIONS script via yarn 1', fixture: 'wp4.47-npm', cmd: 'yarn -s webpack-prod', nodeOptions: `${LEGACY_SSL} --max_old_space_size=4096`, expect: W4('4.47.0') },
  { name: 'webpack 5.0.0', fixture: 'wp5.0-npm', cmd: 'npm run -s build', expect: W5 },
  { name: 'webpack 5.60.0 (child compiler)', fixture: 'wp5.60-npm', cmd: 'npm run -s build', expect: W5 },
  { name: 'webpack 5.111.1 (child compiler)', fixture: 'wp5-npm', cmd: 'npm run -s build', expect: W5 },
  // runners / installers
  { name: 'npx webpack', fixture: 'wp5-npm', cmd: 'npx webpack', expect: W5 },
  { name: 'direct node_modules/.bin/webpack', fixture: 'wp5-npm', cmd: './node_modules/.bin/webpack', expect: W5 },
  { name: 'yarn 1.22 (yarn.lock)', fixture: 'wp5-yarn1', cmd: 'yarn --offline -s build', expect: W5 },
  { name: "yarn 3.8.7 Plug'n'Play", fixture: 'wp5-yarn3-pnp', cmd: 'yarn build', expect: W5 },
  { name: "yarn 4.18.1 Plug'n'Play", fixture: 'wp5-yarn4-pnp', cmd: 'yarn build', expect: W5 },
  { name: 'yarn 4.18.1 node-modules linker', fixture: 'wp5-yarn4-node-modules', cmd: 'yarn build', expect: W5 },
  // older npm releases (installed and run with that npm); the default fixtures use the npm on PATH
  { name: 'npm 8.19.4', fixture: 'wp5-npm8', cmd: '$NPM run -s build', expect: W5 },
  { name: 'npm 9.9.4', fixture: 'wp5-npm9', cmd: '$NPM run -s build', expect: W5 },
  { name: 'npm 10.9.9', fixture: 'wp5-npm10', cmd: '$NPM run -s build', expect: W5 },
  { name: 'npm 11.21.0', fixture: 'wp5-npm11', cmd: '$NPM run -s build', expect: W5 },
  { name: 'npm 10.9.9 npx webpack', fixture: 'wp5-npm10', cmd: '$NPM exec -- webpack', expect: W5 },
  { name: 'pnpm 8.15.9', fixture: 'wp5-pnpm8', cmd: '$PNPM run build', expect: W5 },
  { name: 'pnpm 9.15.9', fixture: 'wp5-pnpm9', cmd: '$PNPM run build', expect: W5 },
  { name: 'pnpm 10.34.6', fixture: 'wp5-pnpm10', cmd: '$PNPM run build', expect: W5 },
  { name: 'pnpm 11.28.5', fixture: 'wp5-pnpm11', cmd: '$PNPM run build', expect: W5 },
  // pnpm 12 verifies the lockfile against the registry before `run`; offline that retries for minutes
  { name: 'pnpm 12.9.1', fixture: 'wp5-pnpm12', cmd: '$PNPM --config.verify-deps-before-run=false run build', expect: W5 },
  { name: 'bun', fixture: 'wp5-bun', cmd: 'bun run build', expect: W5 },
  // dependencies vs devDependencies: only imported packages, whatever section they are declared in
  { name: 'devDependencies: npm', fixture: 'wp5-devdeps-npm', cmd: 'npm run -s build', expect: DEVDEPS, installed: DEVDEPS_INSTALLED,
    // syft on the project's own package-lock.json goes by section, not by what is shipped: it reports the
    // unused dependency is-number and skips all devDependencies (dev: true) - including the shipped classnames
    projectLockfile: { includes: ['is-number@7.0.0', 'lodash-es@4.18.1'], excludes: ['classnames@2.5.1', 'left-pad@1.3.0', 'webpack@5.111.1'] },
    sbom: [
      // the package ships only the build output: the SBOM lists exactly what is in the bundle
      { name: 'build output', stage: { 'usr/share/app/dist': 'dist' },
        expect: [npmPkg('classnames', '2.5.1', 'MIT', DIST_LOCK), npmPkg('lodash-es', '4.18.1', 'MIT', DIST_LOCK)] },
      // the package also ships the project's own lockfile: the SBOM gets the union, incl. the never-bundled
      // is-number and the project itself (see README)
      { name: 'build output + project lockfile', stage: { 'usr/share/app/dist': 'dist', 'usr/share/app/package-lock.json': 'package-lock.json' },
        expect: [npmPkg('classnames', '2.5.1', 'MIT', DIST_LOCK), npmPkg('lodash-es', '4.18.1', 'MIT', DIST_LOCK),
          npmPkg('lodash-es', '4.18.1', 'MIT', PROJECT_LOCK), npmPkg('is-number', '7.0.0', 'MIT', PROJECT_LOCK),
          npmPkg('fixture-wp5-devdeps-npm', '1.0.0', 'NOASSERTION', PROJECT_LOCK)] },
    ] },
  { name: 'devDependencies: yarn 1', fixture: 'wp5-devdeps-yarn1', cmd: 'yarn --offline -s build', expect: DEVDEPS, installed: DEVDEPS_INSTALLED },
  { name: 'devDependencies: pnpm 11', fixture: 'wp5-devdeps-pnpm11', cmd: '$PNPM run build', expect: DEVDEPS, installed: DEVDEPS_INSTALLED },
  // edge cases
  // keys are the install paths (like npm's own lockfile); the name field carries the real name
  { name: 'edge: npm alias (ms-old = npm:ms@2.0.0)', fixture: 'edge-alias', cmd: 'npm run -s build', expect: ['ms@2.0.0', 'ms@2.1.3'],
    expectKeys: { 'node_modules/ms': 'ms@2.1.3', 'node_modules/ms-old': 'ms@2.0.0' } },
  { name: 'edge: Babel-injected core-js / @babel/runtime', fixture: 'edge-babel', cmd: 'npm run -s build', expectIncludes: ['core-js@3.50.0', '@babel/runtime@7.29.10'] },
  { name: 'edge: CSS from packages (mini-css-extract)', fixture: 'edge-css', cmd: 'npm run -s build', expectIncludes: ['normalize.css@8.0.1', 'lodash-es@4.18.1'] },
  { name: 'edge: asset/resource from a package', fixture: 'edge-asset', cmd: 'npm run -s build', expectIncludes: ['bootstrap-icons@1.13.1'] },
  // two compilers: dist/vendor (the DLL) and dist/main, which only references what is in the DLL
  { name: 'edge: DllPlugin + multi-config array', fixture: 'edge-dll', cmd: 'npm run -s build', expectIncludes: ['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3', 'lodash-es@4.18.1'] },
  // workspace packages resolve to their real path outside node_modules and count as first-party; their dependencies are listed
  { name: 'edge: npm workspace package', fixture: 'edge-workspace', cmd: 'npm run -s build', expect: ['ms@2.1.3'] },
  // a nested package.json with its own name/version (preact/hooks -> "preact-hooks@0.1.0") is not a package
  { name: 'edge: subpath manifests (preact/hooks)', fixture: 'edge-subpkg', cmd: 'npm run -s build', expect: ['preact@10.28.3'] },
  { name: 'edge: failing adapter does not break the build', fixture: 'wp5-npm', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_TEST_FAULT: 'collect' },
    expect: null, expectOutput: /\[bundle-lockfile\] WARNING: webpack: could not write lockfile/ },
  // Next.js
  { name: 'Next.js 12.3.7', ...nextCase('next12', '12.3.7', '18.3.1') },
  { name: 'Next.js 13.5.11', ...nextCase('next13', '13.5.11', '18.3.1') },
  { name: 'Next.js 14.2.35', ...nextCase('next14', '14.2.35', '18.3.1') },
  { name: 'Next.js 15.5.27', ...nextCase('next15', '15.5.27', '19.3.0') },
  { name: 'Next.js 16.4.0 --webpack', ...nextCase('next16', '16.4.0', '19.3.0', '--webpack') },
  // Next 16 builds with Turbopack by default, which bundle-lockfile does not support (yet)
  { name: 'Next.js 16.4.0 Turbopack (unsupported: no lockfile)', fixture: 'next16', cmd: './node_modules/.bin/next build', outDir: '.next', env: NEXT_ENV, expect: null },
];

module.exports = { fixtures, cases };
