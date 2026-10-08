'use strict';
// Test matrix as data: fixtures (app + bundler + installer) and cases (fixture + command + expectation).
// A new bundler or installer adds rows here; gen.cjs and run.cjs stay unchanged.
const path = require('path');

const APP_DEPS = { 'lodash-es': '4.18.1', uuid: '9.0.1', yallist: '5.0.0', debug: '2.6.9', ms: '2.1.3', nanoid: '3.3.20' };
// yallist 5 uses class fields, which webpack 4's parser (acorn 6) cannot handle
const { yallist, ...APP4_DEPS } = APP_DEPS;
const HTML = { 'html-webpack-plugin': '5.6.6' }; // adds a child compiler, which must not produce a second lockfile

const wp5 = (webpack, cli, extra = {}) => ({ app: 'webpack5', deps: { webpack, 'webpack-cli': cli, ...APP_DEPS, ...extra } });
const wp4 = (webpack, cli, extra = {}) => ({ app: 'webpack4', deps: { webpack, 'webpack-cli': cli, ...APP4_DEPS, ...extra } });
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
const WEBPACK4 = { webpack: '4.47.0', 'webpack-cli': '4.10.0' };
const WORKER = { 'worker-loader': '3.0.8', 'lodash-es': '4.18.1', ms: '2.1.3', debug: '2.6.9', 'is-number': '7.0.0' };
const BABEL7 = { 'babel-loader': '10.1.1', '@babel/core': '7.29.7', '@babel/preset-env': '7.29.7', '@babel/plugin-transform-runtime': '7.29.7', '@babel/runtime': '7.29.10', 'core-js': '3.50.0' };

// installer: npm | yarn1 | bun (the tools in the test image) or a pinned, vendored yarn berry / pnpm release
// Vite apps: package.json type module, `vite build`
// is-number: only in the second page (vite.second.config.mjs); vite-plugin-singlefile: only with VITE_SINGLEFILE=1
const VITE_SPA = { 'lodash-es': '4.18.1', debug: '2.6.9', ms: '2.1.3', 'normalize.css': '8.0.1', 'is-number': '7.0.0', 'vite-plugin-singlefile': '2.3.3' };
const vite = (version, installer = { type: 'npm' }) => ({ app: 'vite-spa', bundler: 'vite', installer,
  deps: { vite: version, ...VITE_SPA },
  // build-reset overwrites NODE_OPTIONS (drops the --require), as headlamp's and librechat's builds do: needs the node shim
  packageJson: { type: 'module', scripts: { build: 'vite build', 'build-reset': 'NODE_OPTIONS=--max-old-space-size=3072 vite build' } } });
// output that reaches dist/ besides the build's chunks: workers (separate and inlined), a CSS @import from a package,
// legacy polyfills, workbox's service worker, a static copy from node_modules. Transitive packages that end up in the
// output are pinned (core-js, systemjs: plugin-legacy; workbox-*: vite-plugin-pwa)
const FEATURES = { 'lodash-es': '4.18.1', 'is-number': '7.0.0', nanoid: '3.3.20', 'sanitize.css': '13.0.0', 'normalize.css': '8.0.1',
  terser: '5.51.2', 'core-js': '3.50.0', systemjs: '6.15.1', 'vite-plugin-pwa': '2.0.0', 'workbox-build': '7.4.1', 'workbox-window': '7.4.1',
  'vite-plugin-static-copy': '4.1.1', sass: '1.105.1', bulma: '1.0.4', less: '4.9.1', 'normalize.less': '1.0.0' };
const features = (version, legacy) => ({ app: 'vite-features', bundler: 'vite', installer: { type: 'npm' },
  deps: { vite: version, '@vitejs/plugin-legacy': legacy, ...FEATURES }, packageJson: { type: 'module', scripts: { build: 'vite build' } } });
// the rollup command line (Rollup's CommonJS build)
const rollupCli = { app: 'rollup-cli', bundler: 'rollup', installer: { type: 'npm' },
  deps: { rollup: '4.64.2', '@rollup/plugin-node-resolve': '16.0.3', 'lodash-es': '4.18.1', nanoid: '3.3.20' },
  packageJson: { type: 'module', scripts: { build: 'rollup -c' } } };
// Rollup's and Rolldown's JavaScript APIs, called by a build script (build.mjs <mode>), and the rolldown command line
const rollupApi = { app: 'rollup-api', bundler: 'rollup', installer: { type: 'npm' },
  deps: { rollup: '4.64.2', rolldown: '1.2.13', '@rollup/plugin-node-resolve': '16.0.3', 'lodash-es': '4.18.1', nanoid: '3.3.20' },
  packageJson: { type: 'module', scripts: { build: 'node build.mjs rollup' } } };
// SvelteKit: client and server builds, the service worker (a nested Vite build), adapter-static (copies the client
// output to build/) and adapter-node (SVELTEKIT_ADAPTER=node: build/client and build/server; adapter-node 5 bundles
// the server again with Rollup into build/, from a copy of its own files)
const KIT = { svelte: '5.57.2', 'lodash-es': '4.18.1', ms: '2.1.3', nanoid: '3.3.20' };
const sveltekit = (app, kit, deps) => ({ app, bundler: 'sveltekit', installer: { type: 'npm' }, deps: { '@sveltejs/kit': kit, ...deps, ...KIT },
  packageJson: { type: 'module', scripts: { build: 'vite build' } } });
// GitLab's / Element's shape: a library built by Vite into one file, bundled by webpack as a first-party file
// normalize.css: in the split island's style sheet (NESTED_SPLIT=1, see the island's config)
const ISLAND = { vite: '8.3.3', 'lodash-es': '4.18.1', 'is-number': '7.0.0', nanoid: '3.3.20', 'normalize.css': '8.0.1' };
const nested = (webpackDeps) => ({ app: 'nested-island', bundler: 'nested', installer: { type: 'npm' }, deps: { ...webpackDeps, ...ISLAND },
  packageJson: { scripts: { build: 'vite build --config island/vite.config.mjs && webpack --config webpack.config.js' } } });
// the island bundled by a Vite app: built by Vite (Vite 8 -> Vite 8) or by the rollup command line (-> Vite 7)
// the island as the workspace package @acme/island (island/package.json), imported by its name: npm links it into
// node_modules; bundled by webpack 5 or Vite 8 (NESTED_ENTRY=workspace, see the app's configs)
const nestedWorkspace = { app: 'nested-island', bundler: 'nested', installer: { type: 'npm' },
  deps: { webpack: '5.111.1', 'webpack-cli': '7.2.3', ...ISLAND, '@acme/island': '1.0.0' },
  packageJson: { workspaces: ['island'], scripts: { build: 'vite build --config island/vite.config.mjs && webpack --config webpack.config.js' } } };
const nestedVite = (island, vite, deps = {}) => ({ app: 'nested-island', bundler: 'nested-vite', installer: { type: 'npm' },
  deps: { ...ISLAND, vite, ...deps }, packageJson: { type: 'module', scripts: { build: `${island} && vite build` } } });

const fixtures = {
  'vite8-npm': vite('8.3.3'),
  'vite7-npm': vite('7.3.7'),
  'vite6-npm': vite('6.4.4'),
  'vite5-npm': vite('5.4.21'),
  'vite8-pnpm10': vite('8.3.3', { type: 'pnpm', version: '10.34.6' }),
  'vite8-yarn1': vite('8.3.3', { type: 'yarn1' }),
  'vite8-yarn4-pnp': vite('8.3.3', { type: 'yarn-berry', version: '4.18.1', linker: 'pnp' }),
  'vite7-yarn4-pnp': vite('7.3.7', { type: 'yarn-berry', version: '4.18.1', linker: 'pnp' }),
  'vite8-yarn4-node-modules': vite('8.3.3', { type: 'yarn-berry', version: '4.18.1', linker: 'node-modules' }),
  'vite8-bun': vite('8.3.3', { type: 'bun' }),
  'vite8-features': features('8.3.3', '8.2.3'),
  'vite7-features': features('7.3.7', '7.2.1'),
  // (vite-plugin-static-copy 4 needs Vite >= 6: no features fixture for Vite 5)
  'vite6-features': features('6.4.4', '6.1.1'),
  'rollup-cli': rollupCli,
  'rollup-api': rollupApi,
  'nested-island-wp5': nested({ webpack: '5.111.1', 'webpack-cli': '7.2.3' }),
  'nested-island-wp4': nested({ webpack: '4.47.0', 'webpack-cli': '4.10.0' }),
  'nested-island-workspace': nestedWorkspace,
  'nested-island-vite': nestedVite('vite build --config island/vite.config.mjs', '8.3.3'),
  'nested-island-rollup': nestedVite('rollup -c island/rollup.config.mjs', '7.3.7',
    { rollup: '4.64.2', '@rollup/plugin-node-resolve': '16.0.3', '@rollup/plugin-commonjs': '29.0.3' }),
  'sveltekit2': sveltekit('sveltekit2', '2.70.3', { vite: '7.3.7', '@sveltejs/vite-plugin-svelte': '6.2.4', '@sveltejs/adapter-static': '3.0.10', '@sveltejs/adapter-node': '5.5.7' }),
  'sveltekit3': sveltekit('sveltekit3', '3.0.1', { vite: '8.3.3', '@sveltejs/vite-plugin-svelte': '7.3.1', '@sveltejs/adapter-static': '4.0.0', '@sveltejs/adapter-node': '6.0.0' }),
  'wp4.0-npm': { ...wp4('4.0.0', '3.3.12'), installer: { type: 'npm' } },
  // html-webpack-plugin 4 takes its template's output out of the parent compilation but keeps it in its child
  'wp4.47-npm': { ...wp4('4.47.0', '4.10.0', { 'html-webpack-plugin': '4.5.2' }), installer: { type: 'npm' } },
  'wp5.0-npm': { ...wp5('5.0.0', '4.10.0'), installer: { type: 'npm' } }, // html-webpack-plugin 5 needs webpack >= 5.20
  'wp5.60-npm': { ...wp5('5.60.0', '4.10.0', HTML), installer: { type: 'npm' } },
  'wp5-npm': { ...latest, installer: { type: 'npm' } },
  'wp5-yarn1': { ...latest, installer: { type: 'yarn1' } },
  'wp5-yarn3-pnp': { ...latest, installer: { type: 'yarn-berry', version: '3.8.7', linker: 'pnp' } },
  'wp5-yarn4-pnp': { ...latest, installer: { type: 'yarn-berry', version: '4.18.1', linker: 'pnp' } },
  // yarn 4's default: packages in the global cache, outside the project
  'wp5-yarn4-pnp-global-cache': { ...latest, installer: { type: 'yarn-berry', version: '4.18.1', linker: 'pnp', globalCache: true } },
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
  'edge-alias': edge('edge-alias', { ms: '2.1.3', 'ms-old': 'npm:ms@2.0.0', debug: '2.6.9', 'debug-old': 'npm:debug@2.6.8' }),
  'edge-babel': edge('edge-babel', BABEL7),
  'edge-css': edge('edge-css', { 'css-loader': '7.1.5', 'mini-css-extract-plugin': '2.10.2', 'normalize.css': '8.0.1', 'lodash-es': '4.18.1' }),
  'edge-asset': edge('edge-asset', { 'bootstrap-icons': '1.13.1' }),
  // style sheets from packages that loaders inline: Sass partials, Less @imports, Tailwind's CSS
  'edge-style': edge('edge-style', { 'css-loader': '7.1.5', 'mini-css-extract-plugin': '2.10.2', sass: '1.105.1', 'sass-loader': '17.0.1', bulma: '1.0.4',
    less: '4.9.1', 'less-loader': '13.0.0', 'normalize.less': '1.0.0', 'normalize.css': '8.0.1', postcss: '8.5.29', 'postcss-loader': '8.2.1',
    tailwindcss: '4.3.3', '@tailwindcss/postcss': '4.3.3' }),
  'edge-style-wp4': { app: 'edge-style', installer: { type: 'npm' }, deps: { ...WEBPACK4, 'css-loader': '5.2.7', 'mini-css-extract-plugin': '1.6.2',
    sass: '1.105.1', 'sass-loader': '10.5.2', bulma: '1.0.4', less: '4.9.1', 'less-loader': '7.3.0', 'normalize.less': '1.0.0', 'normalize.css': '8.0.1' } },
  'edge-dll': edge('edge-dll', { debug: '2.6.9', ms: '2.1.3', 'lodash-es': '4.18.1' }),
  'edge-workspace': edge('edge-workspace', { '@acme/ui': '1.0.0' }, { packageJson: { workspaces: ['packages/*'] } }),
  'edge-subpkg': edge('edge-subpkg', { preact: '10.28.3' }),
  'edge-worker': edge('edge-worker', WORKER),
  'edge-worker-wp4': { app: 'edge-worker', installer: { type: 'npm' }, deps: { ...WEBPACK4, ...WORKER } },
  'edge-workbox': edge('edge-workbox', { 'workbox-webpack-plugin': '7.4.1', 'workbox-precaching': '7.4.1', 'lodash-es': '4.18.1', ...HTML }),
  'edge-copy': edge('edge-copy', { 'copy-webpack-plugin': '14.0.0', 'normalize.css': '8.0.1', 'lodash-es': '4.18.1' }),
  // copy-webpack-plugin 5 adds its files in webpack 4's emit hook, after the lockfile, without naming their source
  'edge-copy5-wp4': { app: 'edge-copy', installer: { type: 'npm' }, deps: { ...WEBPACK4, 'copy-webpack-plugin': '5.1.2', 'normalize.css': '8.0.1', 'lodash-es': '4.18.1' } },
  // copy-webpack-plugin 6 adds its files in webpack 4's additionalAssets hook
  'edge-copy-wp4': { app: 'edge-copy', installer: { type: 'npm' }, deps: { ...WEBPACK4, 'copy-webpack-plugin': '6.4.1', 'normalize.css': '8.0.1', 'lodash-es': '4.18.1' } },
  'edge-shared-output': edge('edge-shared-output', { debug: '2.6.9', ms: '2.1.3' }),
  // the build script overwrites NODE_OPTIONS with cross-env, as superset's, headlamp's, pgadmin4's (needs the node shim)
  'edge-crossenv': { app: 'webpack5', installer: { type: 'npm' }, deps: { ...WEBPACK, ...APP_DEPS, 'cross-env': '7.0.3' },
    packageJson: { scripts: { build: 'cross-env NODE_OPTIONS=--max-old-space-size=3072 webpack --config webpack.config.js' } } },
  'edge-compression': edge('edge-compression', { 'compression-webpack-plugin': '12.0.0', 'lodash-es': '4.18.1', ms: '2.1.3' }),
  // compression-webpack-plugin 6 runs in webpack 4's emit hook, after the lockfile was emitted
  'edge-compression-wp4': { app: 'edge-compression', installer: { type: 'npm' }, deps: { ...WEBPACK4, 'compression-webpack-plugin': '6.1.2', 'lodash-es': '4.18.1', ms: '2.1.3' } },
  'edge-vanilla': edge('edge-vanilla', { '@vanilla-extract/css': '1.21.2', '@vanilla-extract/webpack-plugin': '2.3.27',
    'mini-css-extract-plugin': '2.10.2', 'css-loader': '7.1.5', 'lodash-es': '4.18.1' }),
  'edge-context': edge('edge-context', { debug: '2.6.9', ms: '2.1.3' }),
  'next12': next('12.3.7', '18.3.1'),
  'next13': next('13.5.11', '18.3.1'),
  'next14': next('14.2.35', '18.3.1'),
  'next15': next('15.5.27', '19.3.0'),
  'next16': next('16.4.0', '19.3.0'),
};

const VITE_EXPECT = ['debug@2.6.9', 'lodash-es@4.18.1', 'ms@2.0.0', 'ms@2.1.3', 'normalize.css@8.0.1'];
// both pages of vite-spa (vite.config.mjs and vite.second.config.mjs)
const VITE_BOTH = [...VITE_EXPECT, 'is-number@7.0.0'].sort();
// watch mode: the build, the rebuild without the lazy chunk (ms@2.1.3), the rebuild with it again
const VITE_WATCH_BUILDS = [VITE_EXPECT, VITE_EXPECT.filter(p => p !== 'ms@2.1.3'), VITE_EXPECT];
const ROLLUP_API = ['lodash-es@4.18.1', 'nanoid@3.3.20'];
// watch modes: the build, the rebuild without nanoid, the rebuild with it again
const ROLLUP_WATCH_BUILDS = [ROLLUP_API, ['lodash-es@4.18.1'], ROLLUP_API];
const NESTED_EXPECT = ['is-number@7.0.0', 'lodash-es@4.18.1', 'nanoid@3.3.20'];
// in SvelteKit's client output: the page's lodash-es, the service worker's nanoid, the runtime
const SVELTE_CLIENT = (kit) => [`@sveltejs/kit@${kit}`, 'lodash-es@4.18.1', 'nanoid@3.3.20', 'svelte@5.57.2'];
// the exact list: core-js, systemjs are the legacy polyfills', workbox-* the service worker's
// (bulma: a Sass partial; normalize.less: a Less @import)
const FEATURES_EXPECT = ['bulma@1.0.4', 'core-js@3.50.0', 'is-number@7.0.0', 'lodash-es@4.18.1', 'nanoid@3.3.20', 'normalize.css@8.0.1', 'normalize.less@1.0.0',
  'sanitize.css@13.0.0', 'systemjs@6.15.1', 'workbox-core@7.4.1', 'workbox-precaching@7.4.1', 'workbox-routing@7.4.1', 'workbox-strategies@7.4.1'];
// not in source maps: style sheets (sanitize.css, bulma, normalize.less), the copy (normalize.css)
const FEATURES_MISSING = ['bulma@1.0.4', 'normalize.css@8.0.1', 'normalize.less@1.0.0', 'sanitize.css@13.0.0'];
const W5 = ['debug@2.6.9', 'lodash-es@4.18.1', 'ms@2.0.0', 'ms@2.1.3', 'nanoid@3.3.20', 'yallist@5.0.0'];
// webpack 4 also bundles its node polyfills (process) and webpack/buildin/* modules
const W4 = (v) => ['debug@2.6.9', 'lodash-es@4.18.1', 'ms@2.0.0', 'ms@2.1.3', 'nanoid@3.3.20', 'process@0.11.10', `webpack@${v}`];
const DEVDEPS = ['classnames@2.5.1', 'lodash-es@4.18.1'];
// edge-style: bulma's partial, normalize.less and the normalize.css it inlines, Tailwind's style sheets (webpack 5)
const STYLE_EXPECT_WP4 = ['bulma@1.0.4', 'normalize.css@8.0.1', 'normalize.less@1.0.0'];
const STYLE_EXPECT = [...STYLE_EXPECT_WP4, 'tailwindcss@4.3.3'];
// installed in node_modules but not imported: proves the absence above is not an install artefact
const DEVDEPS_INSTALLED = ['classnames@2.5.1', 'left-pad@1.3.0', 'is-number@7.0.0', 'lodash-es@4.18.1'];
// expected SPDX package in a functional SBOM check (from = file syft says it found the package in)
const npmPkg = (name, version, license, from) => ({ name, version, purl: `pkg:npm/${name}@${version}`, license, from });
const DIST_LOCK = '/usr/share/app/dist/bundle-lockfile/package-lock.json'; // syft dir scans report absolute paths
const PROJECT_LOCK = '/usr/share/app/package-lock.json';
const LEGACY_SSL = '--openssl-legacy-provider'; // webpack 4 hashes with md4
const NEXT_ENV = { NEXT_TELEMETRY_DISABLED: '1' };
const FAULT = `--require ${path.join(__dirname, 'lib/fault.cjs')}`; // makes collecting the packages throw
// watch.cjs <file> <text>: rebuilds without the lines of <file> that contain <text>, then with them again
const WATCH = `node ${path.join(__dirname, 'lib/watch.cjs')}`;
const WATCH_FAIL = `node ${path.join(__dirname, 'lib/watch-fail.cjs')}`;
// `vite build --watch` through Vite's API, run as the fixture's own build script (see the script)
// (rebuilt without src/main.js's lazy import, whose chunk has ms@2.1.3, then with it again)
const VITE_WATCH = `cp ${path.join(__dirname, 'lib/vite-watch.mjs')} .vite-watch.mjs && node .vite-watch.mjs "import('./lazy.js')"`;
// vite-spa's two builds as two processes at the same time, into one dist/ (with VITE_SHARED=1)
const VITE_BIN = './node_modules/.bin/vite';
const PARALLEL_VITE = `${VITE_BIN} build & a=$!; ${VITE_BIN} build --config vite.second.config.mjs & b=$!; wait $a && wait $b`;
// edge-shared-output's two configs as two webpack processes at the same time
const WEBPACK_BIN = './node_modules/.bin/webpack';
const PARALLEL = `${WEBPACK_BIN} --config-name app & a=$!; ${WEBPACK_BIN} --config-name sw & b=$!; wait $a && wait $b`;
// cold build, then a build that restores every module from webpack's persistent cache: identical lockfiles
const WARM = 'rm -rf .cache-test && npm run -s build && cp dist/bundle-lockfile/package-lock.json .cold.json && rm -rf dist && npm run -s build && cmp .cold.json dist/bundle-lockfile/package-lock.json';
// worker-loader workers: lodash-es in main.js, ms@2.1.3 in a worker, debug + its ms@2.0.0 in a worker inside it,
// is-number in a worker inlined into main.js - with worker-loader's runtime that starts it from a Blob
const WORKERS = ['debug@2.6.9', 'is-number@7.0.0', 'lodash-es@4.18.1', 'ms@2.0.0', 'ms@2.1.3', 'worker-loader@3.0.8'];

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
//   lockfile   lockfile path below each output dir (default bundle-lockfile/package-lock.json)
//   expectKeys {lockfile key: name@version} - exactly the keys of the single output
//   watchBuilds  the cmd prints a JSON list of per-build package lists last; it must be this list of lists
//   exportDir  BUNDLE_LOCKFILE_EXPORT_DIR=<fixture>/.export: its copies are checked and must equal the inline lockfiles
//   exportOnly the same with BUNDLE_LOCKFILE_INLINE=0: no inline lockfile may be written
//   shim       put bin/ (the node shim) first in PATH
//   oracle     false: no oracle comparison (the case's shape cannot be built by the oracle)
//   oracleScript  the oracle (test/oracles/<name>.cjs) if not the fixture's bundler's
//   maxNode    the newest Node.js major the build tool runs on: skipped (and reported) on newer ones (say why at the case)
//   oracleMissing  packages the oracle cannot see, added to every output's truth (say why at the case)
//   oracleMissingIn  the same for single outputs: { "<output dir>": [name@version, ...] }
const cases = [
  // activation
  { name: 'not active without NODE_OPTIONS', fixture: 'wp5-npm', cmd: 'npm run -s build', inject: false, expect: null },
  { name: 'BUNDLE_LOCKFILE_DISABLE=webpack', fixture: 'wp5-npm', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_DISABLE: 'webpack' }, expect: null },
  { name: 'existing NODE_OPTIONS are preserved', fixture: 'wp5-npm', cmd: 'npm run -s build', nodeOptions: '--max-old-space-size=3072', heapMB: 3072, expect: W5 },
  { name: 'BUNDLE_LOCKFILE_FILE=sbom/package-lock.json', fixture: 'wp5-npm', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_FILE: 'sbom/package-lock.json' },
    lockfile: 'sbom/package-lock.json', expect: W5 },
  // build modes
  // rebuilt without the async chunk's import('nanoid'), then with it: nanoid leaves the lockfile and comes back
  { name: 'watch mode: every rebuild emits the lockfile, with the packages of that build', fixture: 'wp5-npm', cmd: `${WATCH} src/index.js "import('nanoid')"`,
    expect: W5, watchBuilds: [W5, W5.filter(p => !p.startsWith('nanoid@')), W5] },
  { name: 'persistent cache: warm build = cold build', fixture: 'wp5-npm', env: { EDGE_CACHE: '1' }, expect: W5, cmd: WARM },
  // modules restored from the cache do not rerun their loaders, and worker-loader runs its child compilers in one
  { name: 'persistent cache with child compilers (worker-loader): warm build = cold build', fixture: 'edge-worker', env: { EDGE_CACHE: '1' }, expect: WORKERS, cmd: WARM },
  // webpack versions
  { name: 'webpack 4.0.0', fixture: 'wp4.0-npm', cmd: 'npm run -s build', nodeOptions: LEGACY_SSL, expect: W4('4.0.0') },
  { name: 'webpack 4.47.0 (child compiler: html-webpack-plugin 4)', fixture: 'wp4.47-npm', cmd: 'npm run -s build', nodeOptions: LEGACY_SSL, expect: W4('4.47.0') },
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
  // keys must not carry the path to the cache, which differs between machines
  { name: "yarn 4.18.1 Plug'n'Play, global cache", fixture: 'wp5-yarn4-pnp-global-cache', cmd: 'yarn build', expect: W5,
    expectKeys: { 'node_modules/debug': 'debug@2.6.9', 'node_modules/lodash-es': 'lodash-es@4.18.1', 'node_modules/ms': 'ms@2.0.0',
      'node_modules/ms@2.1.3': 'ms@2.1.3', 'node_modules/nanoid': 'nanoid@3.3.20', 'node_modules/yallist': 'yallist@5.0.0' } },
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
  // keys are the install paths (like npm's own lockfile); the name field carries the real name.
  // ms@2.0.0 at three paths: three lockfile entries, one package for syft and the oracle
  { name: 'edge: npm aliases (ms-old = npm:ms@2.0.0), one version at several paths', fixture: 'edge-alias', cmd: 'npm run -s build',
    expect: ['debug@2.6.8', 'debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3'],
    expectKeys: { 'node_modules/ms': 'ms@2.1.3', 'node_modules/ms-old': 'ms@2.0.0', 'node_modules/debug': 'debug@2.6.9', 'node_modules/debug-old': 'debug@2.6.8',
      'node_modules/debug/node_modules/ms': 'ms@2.0.0', 'node_modules/debug-old/node_modules/ms': 'ms@2.0.0' } },
  { name: 'edge: Babel-injected core-js / @babel/runtime', fixture: 'edge-babel', cmd: 'npm run -s build', expectIncludes: ['core-js@3.50.0', '@babel/runtime@7.29.10'] },
  { name: 'edge: CSS from packages (mini-css-extract)', fixture: 'edge-css', cmd: 'npm run -s build', expectIncludes: ['normalize.css@8.0.1', 'lodash-es@4.18.1'] },
  { name: 'edge: asset/resource from a package', fixture: 'edge-asset', cmd: 'npm run -s build', expectIncludes: ['bootstrap-icons@1.13.1'] },
  // the stats the oracle reads have no file dependencies, which is where those style sheets are
  { name: 'edge: style sheets inlined from packages (sass-loader, less-loader, Tailwind via postcss-loader)', fixture: 'edge-style', cmd: 'npm run -s build',
    expect: STYLE_EXPECT, oracleMissing: STYLE_EXPECT },
  { name: 'edge: style sheets inlined from packages (sass-loader, less-loader), webpack 4', fixture: 'edge-style-wp4', cmd: 'npm run -s build', nodeOptions: LEGACY_SSL,
    expect: STYLE_EXPECT_WP4, oracleMissing: STYLE_EXPECT_WP4 },
  // modules restored from webpack's persistent cache keep the snapshot of their build
  { name: 'edge: style sheets inlined from packages, persistent cache: warm build = cold build', fixture: 'edge-style', env: { EDGE_CACHE: '1' }, cmd: WARM,
    expect: STYLE_EXPECT, oracleMissing: STYLE_EXPECT },
  // two compilers: dist/vendor (the DLL) and dist/main, which only references what is in the DLL
  { name: 'edge: DllPlugin + multi-config array', fixture: 'edge-dll', cmd: 'npm run -s build', expectIncludes: ['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3', 'lodash-es@4.18.1'] },
  // workspace packages resolve to their real path outside node_modules and count as first-party; their dependencies are listed
  { name: 'edge: npm workspace package', fixture: 'edge-workspace', cmd: 'npm run -s build', expect: ['ms@2.1.3'] },
  // a nested package.json with its own name/version (preact/hooks -> "preact-hooks@0.1.0") is not a package
  { name: 'edge: subpath manifests (preact/hooks)', fixture: 'edge-subpkg', cmd: 'npm run -s build', expect: ['preact@10.28.3'] },
  // workspace packages count as first-party also when webpack keeps the node_modules/@acme/ui symlink path
  { name: 'edge: npm workspace package, resolve.symlinks=false', fixture: 'edge-workspace', cmd: 'npm run -s build', env: { EDGE_RESOLVE_SYMLINKS: 'false' }, expect: ['ms@2.1.3'] },
  // child compilers whose output is shipped: worker-loader (a worker inside a worker, a worker inlined into
  // main.js), workbox's service worker. html-webpack-plugin's child compiler only renders the template at build
  // time and is not counted.
  { name: 'edge: worker-loader workers, nested and inlined (child compilers)', fixture: 'edge-worker', cmd: 'npm run -s build', expect: WORKERS },
  { name: 'edge: worker-loader workers, nested and inlined, webpack 4', fixture: 'edge-worker-wp4', cmd: 'npm run -s build', nodeOptions: LEGACY_SSL,
    expectIncludes: WORKERS },
  { name: 'edge: workbox InjectManifest service worker', fixture: 'edge-workbox', cmd: 'npm run -s build',
    expectIncludes: ['workbox-core@7.4.1', 'workbox-precaching@7.4.1', 'lodash-es@4.18.1'], expectExcludes: ['html-webpack-plugin@5.6.6', 'workbox-webpack-plugin@7.4.1'] },
  // copy-webpack-plugin: a package file copied verbatim into the output is shipped; copied first-party files are not packages
  { name: 'edge: package file copied by copy-webpack-plugin', fixture: 'edge-copy', cmd: 'npm run -s build', expect: ['lodash-es@4.18.1', 'normalize.css@8.0.1'] },
  { name: 'edge: package file copied by copy-webpack-plugin 6, webpack 4', fixture: 'edge-copy-wp4', cmd: 'npm run -s build', nodeOptions: LEGACY_SSL,
    expectIncludes: ['lodash-es@4.18.1', 'normalize.css@8.0.1'] },
  // its copy is matched by content to the package file it was copied from
  { name: 'edge: package file copied by copy-webpack-plugin 5, webpack 4', fixture: 'edge-copy5-wp4', cmd: 'npm run -s build', nodeOptions: LEGACY_SSL,
    expectIncludes: ['lodash-es@4.18.1', 'normalize.css@8.0.1'] },
  // two compilers write to dist/ in parallel: one lockfile with the packages of both
  { name: 'edge: two compilers, one output dir', fixture: 'edge-shared-output', cmd: 'npm run -s build', expect: ['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3'] },
  // the first compiler's asset names carry a query string ([name].js?[contenthash]): its files are still there
  { name: 'edge: two compilers, one output dir, file names with a query string', fixture: 'edge-shared-output', cmd: 'npm run -s build',
    env: { EDGE_SHARED: 'query' }, expect: ['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3'] },
  // configs that differ only in resolve.alias, with the same name, entry, target and file name templates
  { name: 'edge: two compilers, one output dir, configs differing only in resolve.alias', fixture: 'edge-shared-output', cmd: 'npm run -s build',
    env: { EDGE_SHARED: 'alias' }, expect: ['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3'] },
  // output.path 'dist/[fullhash]': each compiler's own directory (the oracle checks each lockfile exactly)
  { name: 'edge: two compilers, output.path with [fullhash]', fixture: 'edge-shared-output', cmd: 'npm run -s build',
    env: { EDGE_SHARED: 'fullhash' }, expectIncludes: ['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3'] },
  // two webpack processes writing to one dir (grafana's two builds, swagger-ui's run-p): the lockfile has both
  { name: 'edge: two webpack processes, one output dir, in parallel', fixture: 'edge-shared-output', cmd: PARALLEL,
    expect: ['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3'] },
  { name: 'edge: two webpack processes, one output dir, then one of them again', fixture: 'edge-shared-output', cmd: `${PARALLEL} && ${WEBPACK_BIN} --config-name app`,
    expect: ['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3'] },
  // the plugin configured by hand (no NODE_OPTIONS) shares the lockfile across processes too. No oracle: it would build
  // with the plugin as well (EDGE_PLUGIN reaches it); the list is the one the oracle checks in the cases above
  { name: 'edge: plugin in the config (no NODE_OPTIONS), two webpack processes, one output dir, in parallel', fixture: 'edge-shared-output',
    cmd: PARALLEL, inject: false, env: { EDGE_PLUGIN: path.join(__dirname, '../src/adapters/webpack.cjs') }, expect: ['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3'], oracle: false },
  // app's output.clean deletes sw's files: sw's packages are dropped. The oracle builds both configs in one process,
  // where app's clean does not delete the files of sw building next to it
  { name: 'edge: two webpack processes, one output dir, the second one cleans it', fixture: 'edge-shared-output', env: { EDGE_SHARED: 'clean' },
    cmd: `${WEBPACK_BIN} --config-name sw && ${WEBPACK_BIN} --config-name app`, expect: ['ms@2.1.3'], oracle: false },
  // a failed rebuild is not emitted: the lockfile keeps the packages of the output still in dist/
  { name: 'edge: two compilers, one output dir, watch mode with a failing rebuild', fixture: 'edge-shared-output', cmd: WATCH_FAIL,
    expect: ['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3'], watchBuilds: [1, 2, 3].map(() => ['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3']) },
  { name: 'edge: compression-webpack-plugin with deleteOriginalAssets', fixture: 'edge-compression', cmd: 'npm run -s build', expect: ['lodash-es@4.18.1'] },
  { name: 'edge: compression-webpack-plugin 6 with deleteOriginalAssets, webpack 4', fixture: 'edge-compression-wp4', cmd: 'npm run -s build', nodeOptions: LEGACY_SSL,
    expectIncludes: ['lodash-es@4.18.1'] },
  // two compilers whose files are all replaced by .gz files, then one of them again in another process: the other's
  // .gz files are still there, so are its packages (webpack 4 replaces them in the emit hook, after the lockfile was rendered)
  { name: 'edge: compression-webpack-plugin with deleteOriginalAssets, two compilers, one output dir, then one of them again', fixture: 'edge-compression',
    env: { EDGE_COMPRESSION: 'two' }, cmd: `npm run -s build && ${WEBPACK_BIN} --config-name sw`, expect: ['lodash-es@4.18.1', 'ms@2.1.3'] },
  { name: 'edge: compression-webpack-plugin 6 with deleteOriginalAssets, two compilers, one output dir, then one of them again, webpack 4',
    fixture: 'edge-compression-wp4', env: { EDGE_COMPRESSION: 'two' }, cmd: `npm run -s build && ${WEBPACK_BIN} --config-name sw`, nodeOptions: LEGACY_SSL,
    expectIncludes: ['lodash-es@4.18.1', 'ms@2.1.3'] },
  // the virtual CSS module reads a placeholder file in @vanilla-extract/webpack-plugin, a build tool;
  // @vanilla-extract/css only runs at build time
  { name: 'edge: vanilla-extract virtual CSS (match resource)', fixture: 'edge-vanilla', cmd: 'npm run -s build',
    expectIncludes: ['lodash-es@4.18.1'], expectExcludes: ['@vanilla-extract/webpack-plugin@2.3.27', '@vanilla-extract/css@1.21.2'] },
  { name: 'edge: externals are not listed', fixture: 'wp5-npm', cmd: 'npm run -s build', env: { EDGE_EXTERNALS: '1' },
    expect: W5.filter(p => !p.startsWith('lodash-es@')) },
  // webpack's context is a subdirectory: keys are relative to it, syft still reads every entry by its name field
  { name: 'edge: context below the project root', fixture: 'edge-context', cmd: 'npm run -s build', expect: ['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3'],
    expectKeys: { '../node_modules/debug': 'debug@2.6.9', '../node_modules/debug/node_modules/ms': 'ms@2.0.0', '../node_modules/ms': 'ms@2.1.3' } },
  // export dir: a copy of every lockfile outside the output (go:embed, jars, copies that drop it), optionally only there
  { name: 'export: BUNDLE_LOCKFILE_EXPORT_DIR and the inline lockfile', fixture: 'wp5-npm', cmd: 'npm run -s build', exportDir: true, expect: W5 },
  { name: 'export: BUNDLE_LOCKFILE_EXPORT_DIR only (BUNDLE_LOCKFILE_INLINE=0)', fixture: 'wp5-npm', cmd: 'npm run -s build', exportOnly: true, expect: W5 },
  // NODE_OPTIONS overwritten by the build script: no lockfile, unless the node shim is first in PATH
  { name: 'shim: a script overwriting NODE_OPTIONS drops the --require (no shim)', fixture: 'wp5-npm', cmd: 'npm run -s build-reset', expect: null },
  { name: 'shim: npm, script overwriting NODE_OPTIONS', fixture: 'wp5-npm', cmd: 'npm run -s build-reset', shim: true, expect: W5 },
  { name: 'shim: pnpm, script overwriting NODE_OPTIONS', fixture: 'wp5-pnpm10', cmd: '$PNPM run build-reset', shim: true, expect: W5 },
  { name: 'shim: yarn 1, script overwriting NODE_OPTIONS', fixture: 'wp5-yarn1', cmd: 'yarn --offline -s build-reset', shim: true, expect: W5 },
  { name: 'shim: yarn 4 (node-modules), script overwriting NODE_OPTIONS', fixture: 'wp5-yarn4-node-modules', cmd: 'yarn build-reset', shim: true, expect: W5 },
  { name: 'shim: bun, script overwriting NODE_OPTIONS', fixture: 'wp5-bun', cmd: 'bun run build-reset', shim: true, expect: W5 },
  { name: 'shim: cross-env NODE_OPTIONS=... (no shim)', fixture: 'edge-crossenv', cmd: 'npm run -s build', expect: null },
  { name: 'shim: cross-env NODE_OPTIONS=...', fixture: 'edge-crossenv', cmd: 'npm run -s build', shim: true, expect: W5 },
  // argo-cd's shape: the recipe overwrites NODE_OPTIONS and the output is embedded into a Go binary
  { name: 'shim + export only: yarn 1, NODE_OPTIONS overwritten, output not shipped as files', fixture: 'wp5-yarn1', cmd: 'yarn --offline -s build-reset',
    shim: true, exportOnly: true, expect: W5 },
  { name: 'edge: failing adapter does not break the build', fixture: 'wp5-npm', cmd: 'npm run -s build', nodeOptions: FAULT,
    expect: null, expectOutput: /\[bundle-lockfile\] WARNING: webpack: could not write lockfile/ },
  // Vite (rolldown: 8, rollup: 7). The oracle reads Vite's source maps, which do not cover CSS-only packages
  { name: 'Vite 8.3.3 (rolldown)', fixture: 'vite8-npm', cmd: 'npm run -s build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 7.3.7 (rollup)', fixture: 'vite7-npm', cmd: 'npm run -s build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 8.3.3, pnpm 10', fixture: 'vite8-pnpm10', cmd: '$PNPM run build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 8.3.3, npx vite build', fixture: 'vite8-npm', cmd: 'npx vite build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  // the loader-thread hooks, which Node < 24.12 uses (CI's Node 24 would use the in-thread ones)
  { name: 'Vite 8.3.3, loader-thread hooks (BUNDLE_LOCKFILE_ESM_HOOKS=async)', fixture: 'vite8-npm', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_ESM_HOOKS: 'async' },
    expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 7.3.7, loader-thread hooks (BUNDLE_LOCKFILE_ESM_HOOKS=async)', fixture: 'vite7-npm', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_ESM_HOOKS: 'async' },
    expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  // Vite 6 and 5 build with Rollup 4 too
  ...['6.4.4', '5.4.21'].flatMap((v) => {
    const fixture = `vite${v[0]}-npm`, oracleMissing = ['normalize.css@8.0.1'];
    return [
      { name: `Vite ${v} (rollup)`, fixture, cmd: 'npm run -s build', expect: VITE_EXPECT, oracleMissing },
      { name: `Vite ${v}, loader-thread hooks (BUNDLE_LOCKFILE_ESM_HOOKS=async)`, fixture, cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_ESM_HOOKS: 'async' },
        expect: VITE_EXPECT, oracleMissing },
      { name: `Vite ${v} watch mode: every rebuild writes the lockfile, with the packages of that build`, fixture, cmd: VITE_WATCH, expect: VITE_EXPECT,
        watchBuilds: VITE_WATCH_BUILDS, oracleMissing },
      { name: `Vite ${v}, vite-plugin-singlefile`, fixture, cmd: 'npm run -s build', env: { VITE_SINGLEFILE: '1' }, expect: VITE_EXPECT, oracleMissing },
    ];
  }),
  { name: 'Vite 6.4.4: workers, CSS, Sass and Less @imports, plugin-legacy, vite-plugin-pwa, static copy', fixture: 'vite6-features', cmd: 'npm run -s build',
    expect: FEATURES_EXPECT, oracleMissing: FEATURES_MISSING },
  { name: 'Vite 8.3.3, BUNDLE_LOCKFILE_DISABLE=vite', fixture: 'vite8-npm', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_DISABLE: 'vite' }, expect: null },
  { name: 'Vite 8.3.3, export dir only', fixture: 'vite8-npm', cmd: 'npm run -s build', exportOnly: true, expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  // workers, CSS @import, legacy polyfills, workbox's sw.js (written after the build), static copy from node_modules
  { name: 'Vite 8.3.3: workers, CSS, Sass and Less @imports, plugin-legacy, vite-plugin-pwa, static copy', fixture: 'vite8-features', cmd: 'npm run -s build',
    expect: FEATURES_EXPECT, oracleMissing: FEATURES_MISSING },
  { name: 'Vite 7.3.7: workers, CSS, Sass and Less @imports, plugin-legacy, vite-plugin-pwa, static copy', fixture: 'vite7-features', cmd: 'npm run -s build',
    expect: FEATURES_EXPECT, oracleMissing: FEATURES_MISSING },
  { name: 'Vite 7.3.7 features, loader-thread hooks (BUNDLE_LOCKFILE_ESM_HOOKS=async)', fixture: 'vite7-features', cmd: 'npm run -s build',
    env: { BUNDLE_LOCKFILE_ESM_HOOKS: 'async' }, expect: FEATURES_EXPECT, oracleMissing: FEATURES_MISSING },
  { name: 'Rollup 4 command line (rollup -c)', fixture: 'rollup-cli', cmd: 'npm run -s build', expect: ['lodash-es@4.18.1', 'nanoid@3.3.20'] },
  // installers (yarn Plug'n'Play: Yarn's own loader-thread hook next to bundle-lockfile's ESM hooks)
  { name: 'Vite 8.3.3, yarn 1', fixture: 'vite8-yarn1', cmd: 'yarn --offline -s build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: "Vite 8.3.3, yarn 4.18.1 Plug'n'Play", fixture: 'vite8-yarn4-pnp', cmd: 'yarn build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: "Vite 7.3.7, yarn 4.18.1 Plug'n'Play", fixture: 'vite7-yarn4-pnp', cmd: 'yarn build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 8.3.3, yarn 4.18.1 node-modules linker', fixture: 'vite8-yarn4-node-modules', cmd: 'yarn build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 8.3.3, bun', fixture: 'vite8-bun', cmd: 'bun run build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  // vite build --watch: Rolldown's watch() (Vite 8), Rollup's (Vite 7); every rebuild writes the lockfile
  { name: 'Vite 8.3.3 watch mode: every rebuild writes the lockfile, with the packages of that build', fixture: 'vite8-npm', cmd: VITE_WATCH, expect: VITE_EXPECT,
    watchBuilds: VITE_WATCH_BUILDS,
    oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 7.3.7 watch mode: every rebuild writes the lockfile, with the packages of that build', fixture: 'vite7-npm', cmd: VITE_WATCH, expect: VITE_EXPECT,
    watchBuilds: VITE_WATCH_BUILDS,
    oracleMissing: ['normalize.css@8.0.1'] },
  // the build script overwrites NODE_OPTIONS: no lockfile, unless the node shim is first in PATH (also on Node 22, whose
  // loader-thread hooks are installed only in a process of a package that uses Vite)
  { name: 'Vite 8.3.3, script overwriting NODE_OPTIONS (no shim)', fixture: 'vite8-npm', cmd: 'npm run -s build-reset', expect: null },
  { name: 'Vite 8.3.3, script overwriting NODE_OPTIONS, node shim', fixture: 'vite8-npm', cmd: 'npm run -s build-reset', shim: true,
    expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  // vite-plugin-singlefile removes every chunk from the bundle after inlining it into index.html; its source map stays
  { name: 'Vite 8.3.3, vite-plugin-singlefile', fixture: 'vite8-npm', cmd: 'npm run -s build', env: { VITE_SINGLEFILE: '1' },
    expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 7.3.7, vite-plugin-singlefile', fixture: 'vite7-npm', cmd: 'npm run -s build', env: { VITE_SINGLEFILE: '1' },
    expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  // bundle-lockfile's Rollup plugin in the Vite config (no NODE_OPTIONS); the oracle reads source maps, which the
  // plugin does not change
  { name: 'Vite 8.3.3, plugin in the config (no NODE_OPTIONS)', fixture: 'vite8-npm', cmd: 'npm run -s build', inject: false,
    env: { VITE_PLUGIN: path.join(__dirname, '../src/adapters/rollup.cjs') }, expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 7.3.7, plugin in the config (no NODE_OPTIONS)', fixture: 'vite7-npm', cmd: 'npm run -s build', inject: false,
    env: { VITE_PLUGIN: path.join(__dirname, '../src/adapters/rollup.cjs') }, expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  // two vite build processes writing to one dir: the lockfile has both. The oracle builds only the first page
  { name: 'Vite 8.3.3: two vite build processes, one output dir, in parallel', fixture: 'vite8-npm', cmd: PARALLEL_VITE, env: { VITE_SHARED: '1' },
    expect: VITE_BOTH, oracle: false },
  { name: 'Vite 7.3.7: two vite build processes, one output dir, then one of them again', fixture: 'vite7-npm', env: { VITE_SHARED: '1' },
    cmd: `${PARALLEL_VITE} && ${VITE_BIN} build --config vite.second.config.mjs`, expect: VITE_BOTH, oracle: false },
  // Rollup's and Rolldown's JavaScript APIs (build.mjs). The oracle is the same build with Rollup's command line and
  // source maps (rollup.config.mjs), also for Rolldown's builds: the same packages
  { name: 'Rollup 4 JavaScript API: rollup()', fixture: 'rollup-api', cmd: 'node build.mjs rollup', expect: ROLLUP_API },
  { name: 'Rollup 4 JavaScript API: watch(), every rebuild writes the lockfile, with the packages of that build', fixture: 'rollup-api', cmd: 'node build.mjs rollup-watch',
    expect: ROLLUP_API, watchBuilds: ROLLUP_WATCH_BUILDS },
  { name: 'Rolldown 1 JavaScript API: rolldown()', fixture: 'rollup-api', cmd: 'node build.mjs rolldown', expect: ROLLUP_API },
  { name: 'Rolldown 1 JavaScript API: build()', fixture: 'rollup-api', cmd: 'node build.mjs rolldown-build', expect: ROLLUP_API },
  { name: 'Rolldown 1 JavaScript API: watch(), every rebuild writes the lockfile, with the packages of that build', fixture: 'rollup-api', cmd: 'node build.mjs rolldown-watch',
    expect: ROLLUP_API, watchBuilds: ROLLUP_WATCH_BUILDS },
  { name: 'Rollup 4 JavaScript API, BUNDLE_LOCKFILE_DISABLE=rollup', fixture: 'rollup-api', cmd: 'node build.mjs rollup', env: { BUNDLE_LOCKFILE_DISABLE: 'rollup' }, expect: null },
  { name: 'Rolldown 1 JavaScript API, BUNDLE_LOCKFILE_DISABLE=rolldown', fixture: 'rollup-api', cmd: 'node build.mjs rolldown', env: { BUNDLE_LOCKFILE_DISABLE: 'rolldown' }, expect: null },
  // the rolldown command line imports Rolldown's internal chunk, not its entry module, which the hooks wrap
  { name: 'Rolldown 1 command line (unsupported: no lockfile)', fixture: 'rollup-api', cmd: './node_modules/.bin/rolldown src/main.js -d dist -p browser', expect: null },
  // nested: webpack's lockfile has the island's packages, found by the island's output hash in its lockfile
  { name: 'nested: Vite 8 island bundled by webpack 5', fixture: 'nested-island-wp5', cmd: 'npm run -s build', expect: NESTED_EXPECT },
  { name: 'nested: Vite 8 island bundled by webpack 4', fixture: 'nested-island-wp4', cmd: 'npm run -s build', nodeOptions: LEGACY_SSL,
    expectIncludes: NESTED_EXPECT },
  { name: 'nested: Vite 8 island bundled by Vite 8', fixture: 'nested-island-vite', cmd: 'npm run -s build', oracleArgs: 'vite', expect: NESTED_EXPECT },
  { name: 'nested: Rollup island (rollup -c) bundled by Vite 7', fixture: 'nested-island-rollup', cmd: 'npm run -s build', oracleArgs: 'rollup', expect: NESTED_EXPECT },
  // a split island (NESTED_SPLIT=1): main.js (is-number), lazy.js (nanoid), style.css (normalize.css). Each of its files
  // brings the packages in it, not all of the island's. The oracle reads the island's source maps, which cover no CSS
  { name: 'nested: split Vite 8 island (chunks, a style sheet) bundled by Vite 8', fixture: 'nested-island-vite', env: { NESTED_SPLIT: '1', NESTED_ENTRY: 'split' },
    cmd: 'npm run -s build', oracleArgs: 'vite', expect: [...NESTED_EXPECT, 'normalize.css@8.0.1'], oracleMissing: ['normalize.css@8.0.1'] },
  { name: "nested: only the split Vite 8 island's style sheet, bundled by Vite 8", fixture: 'nested-island-vite', env: { NESTED_SPLIT: '1', NESTED_ENTRY: 'split-css' },
    cmd: 'npm run -s build', oracleArgs: 'vite', expect: ['lodash-es@4.18.1', 'normalize.css@8.0.1'], oracleMissing: ['normalize.css@8.0.1'] },
  { name: "nested: only the split Vite 8 island's JavaScript, bundled by Vite 8", fixture: 'nested-island-vite', env: { NESTED_SPLIT: '1', NESTED_ENTRY: 'split-js' },
    cmd: 'npm run -s build', oracleArgs: 'vite', expect: NESTED_EXPECT },
  { name: "nested: only the split Vite 8 island's JavaScript, bundled by webpack 5", fixture: 'nested-island-wp5', env: { NESTED_SPLIT: '1', NESTED_ENTRY: 'split-js' },
    cmd: 'npm run -s build', expect: NESTED_EXPECT },
  // the island as a workspace package: found where it really is, also when the bundler keeps the node_modules link
  { name: 'nested: Vite 8 island as a workspace package, bundled by webpack 5', fixture: 'nested-island-workspace', cmd: 'npm run -s build',
    env: { NESTED_ENTRY: 'workspace' }, expect: NESTED_EXPECT },
  { name: 'nested: Vite 8 island as a workspace package, bundled by webpack 5 with resolve.symlinks=false', fixture: 'nested-island-workspace',
    cmd: 'npm run -s build', env: { NESTED_ENTRY: 'workspace', EDGE_RESOLVE_SYMLINKS: 'false' }, expect: NESTED_EXPECT },
  { name: 'nested: Vite 8 island as a workspace package, bundled by Vite 8 with resolve.preserveSymlinks', fixture: 'nested-island-workspace',
    cmd: './node_modules/.bin/vite build --config island/vite.config.mjs && ./node_modules/.bin/vite build',
    env: { NESTED_ENTRY: 'workspace', EDGE_RESOLVE_SYMLINKS: 'false' }, oracleScript: 'nested-vite', oracleArgs: 'vite', expect: NESTED_EXPECT },
  // SvelteKit: the exact lists are the oracle's (its source maps); ms is a dependency the server loads from
  // node_modules at runtime (Vite's SSR build and adapter-node keep dependencies external), so in no lockfile.
  // SvelteKit 2 writes no source map for the service worker (nanoid's code is in build/service-worker.js); with
  // adapter-node, build/client (and with SvelteKit 3 build/server) are copies of SvelteKit's outputs, with their lockfiles
  { name: 'SvelteKit 2 (Vite 7), adapter-static', fixture: 'sveltekit2', cmd: 'npm run -s build', outDir: 'build',
    expectIncludes: SVELTE_CLIENT('2.70.3'), expectExcludes: ['ms@2.1.3'], oracleMissing: ['nanoid@3.3.20'] },
  { name: 'SvelteKit 2 (Vite 7), adapter-node', fixture: 'sveltekit2', cmd: 'npm run -s build', outDir: 'build', env: { SVELTEKIT_ADAPTER: 'node' },
    oracleArgs: 'client', expectIncludes: [...SVELTE_CLIENT('2.70.3'), '@sveltejs/adapter-node@5.5.7'], expectExcludes: ['ms@2.1.3'],
    oracleMissingIn: { client: ['nanoid@3.3.20'] } },
  { name: 'SvelteKit 3 (Vite 8), adapter-static', fixture: 'sveltekit3', cmd: 'npm run -s build', outDir: 'build',
    expectIncludes: SVELTE_CLIENT('3.0.1'), expectExcludes: ['ms@2.1.3'] },
  { name: 'SvelteKit 3 (Vite 8), adapter-node', fixture: 'sveltekit3', cmd: 'npm run -s build', outDir: 'build', env: { SVELTEKIT_ADAPTER: 'node' },
    oracleArgs: 'client,server', expectIncludes: [...SVELTE_CLIENT('3.0.1'), '@sveltejs/adapter-node@6.0.0'], expectExcludes: ['ms@2.1.3'] },
  // a changed island file is not attributed (its hash no longer matches)
  { name: 'nested: island changed after its build is not attributed', fixture: 'nested-island-wp5',
    cmd: './node_modules/.bin/vite build --config island/vite.config.mjs && echo "/* changed */" >> island/dist/main.js && ./node_modules/.bin/webpack --config webpack.config.js',
    expect: ['lodash-es@4.18.1'], oracle: false },
  // Next.js
  // Next 12's own build fails on Node.js >= 25, also without bundle-lockfile: its compiled jsonwebtoken (through
  // buffer-equal-constant-time) reads require('buffer').SlowBuffer.prototype, and Node.js 25 removed SlowBuffer
  { name: 'Next.js 12.3.7', ...nextCase('next12', '12.3.7', '18.3.1'), maxNode: 24 },
  { name: 'Next.js 13.5.11', ...nextCase('next13', '13.5.11', '18.3.1') },
  { name: 'Next.js 14.2.35', ...nextCase('next14', '14.2.35', '18.3.1') },
  { name: 'Next.js 15.5.27', ...nextCase('next15', '15.5.27', '19.3.0') },
  { name: 'Next.js 16.4.0 --webpack', ...nextCase('next16', '16.4.0', '19.3.0', '--webpack') },
  // standalone deployments copy only .next/standalone and .next/static, which drops .next/bundle-lockfile
  { name: 'Next.js 16.4.0 --webpack, export dir only', ...nextCase('next16', '16.4.0', '19.3.0', '--webpack'), exportOnly: true },
  // Next 16 builds with Turbopack by default, which bundle-lockfile does not support (yet)
  { name: 'Next.js 16.4.0 Turbopack (unsupported: no lockfile)', fixture: 'next16', cmd: './node_modules/.bin/next build', outDir: '.next', env: NEXT_ENV, expect: null },
];

module.exports = { fixtures, cases };
