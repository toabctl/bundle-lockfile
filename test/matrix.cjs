'use strict';
// Test matrix as data: fixtures (app + bundler + installer) and cases (fixture + command + expectation).
// A new bundler or installer adds rows here; gen.cjs and run.cjs stay unchanged.
const path = require('path');

const APP_DEPS = { 'lodash-es': '4.18.1', uuid: '9.0.1', yallist: '5.0.0', debug: '2.6.9', ms: '2.1.3', nanoid: '3.3.20' };
// yallist 5 uses class fields, which webpack 4's parser (acorn 6) cannot handle
const { yallist, ...APP4_DEPS } = APP_DEPS;
const HTML = { 'html-webpack-plugin': '5.6.6' }; // adds a child compiler, which must not produce a second lockfile
// tracing agents that preload themselves as bundle-lockfile does (see the cases)
const APM = { '@opentelemetry/instrumentation': '0.223.0', 'dd-trace': '6.20.1' };

const wp5 = (webpack, cli, extra = {}) => ({ app: 'webpack5', deps: { webpack, 'webpack-cli': cli, ...APP_DEPS, ...extra } });
const wp4 = (webpack, cli, extra = {}) => ({ app: 'webpack4', deps: { webpack, 'webpack-cli': cli, ...APP4_DEPS, ...extra } });
const latest = wp5('5.111.1', '7.2.3', HTML);
// Next.js vendors its own webpack; pages router so one app works for every version
const next = (version, react) => ({
  app: 'next', bundler: 'next', installer: { type: 'npm' },
  deps: { next: version, react, 'react-dom': react, 'lodash-es': '4.18.1', uuid: '9.0.1', ms: '2.1.3' },
});

// the App Router app (test/apps/next-app): server and client components, an edge route handler, middleware
const nextApp = (version, react) => ({
  app: 'next-app', bundler: 'next', installer: { type: 'npm' },
  deps: { next: version, react, 'react-dom': react, 'lodash-es': '4.18.1', uuid: '9.0.1', ms: '2.1.3', nanoid: '3.3.20', 'is-number': '7.0.0' },
});

// test/apps/next-runtime: canaries (BLCANARY markers) required by the server at request time, moved into node_modules
// after the install (as test/apps/canary's)
const nextRuntime = (version, react, installer = { type: 'npm' }) => ({
  app: 'next-runtime', bundler: 'next', installer, deps: { next: version, react, 'react-dom': react },
  postInstall: 'cd pkgs && mv bl-canary-rt bl-canary-legacy bl-canary-ext bl-canary-bundled ../node_modules/ && cd .. && rmdir pkgs',
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
// edge-copy: a package file (normalize.css) and a package directory (left-pad) copied into the output
const COPIED = { 'normalize.css': '8.0.1', 'left-pad': '1.3.0', 'lodash-es': '4.18.1' };
const COPIED_EXPECT = ['left-pad@1.3.0', 'lodash-es@4.18.1', 'normalize.css@8.0.1'];
const WORKER = { 'worker-loader': '3.0.8', 'lodash-es': '4.18.1', ms: '2.1.3', debug: '2.6.9', 'is-number': '7.0.0' };
const BABEL7 = { 'babel-loader': '10.1.1', '@babel/core': '7.29.7', '@babel/preset-env': '7.29.7', '@babel/plugin-transform-runtime': '7.29.7', '@babel/runtime': '7.29.10', 'core-js': '3.50.0' };
// edge-helpers: the transpilers whose helpers are inlined into modules (src/core/helpers.cjs), each pinned, also the
// @babel/helpers that @babel/core 7.29.7 takes (^7.29.7: the newest, hoisted)
const HELPERS = { 'babel-loader': '10.1.1', '@babel/core': '7.29.7', '@babel/preset-env': '7.29.7', '@babel/helpers': '7.29.10',
  '@babel/plugin-transform-runtime': '7.29.7', '@babel/runtime': '7.29.10', 'ts-loader': '9.6.2', typescript: '5.9.3', tslib: '2.8.1',
  'swc-loader': '0.2.7', '@swc/core': '1.16.18', '@swc/helpers': '0.5.23' };

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
  'vite-plugin-static-copy': '4.1.1', sass: '1.105.1', bulma: '1.0.4', less: '4.9.1', 'normalize.less': '1.0.0',
  // the service worker's own imports with PWA_INJECT=1 (injectManifest)
  'workbox-precaching': '7.4.1', 'workbox-routing': '7.4.1', 'workbox-strategies': '7.4.1',
  // a font only the worker loads (new URL(...)): emitted by the worker's build, again by the app's
  'bootstrap-icons': '1.13.2' };
const features = (version, legacy) => ({ app: 'vite-features', bundler: 'vite', installer: { type: 'npm' },
  deps: { vite: version, '@vitejs/plugin-legacy': legacy, ...FEATURES }, packageJson: { type: 'module', scripts: { build: 'vite build' } } });
// the rollup command line (Rollup's CommonJS build)
// (@rollup/plugin-typescript, typescript 5, tslib: for rollup.config.ts)
const rollupCli = { app: 'rollup-cli', bundler: 'rollup', installer: { type: 'npm' },
  deps: { rollup: '4.64.2', '@rollup/plugin-node-resolve': '16.0.3', 'lodash-es': '4.18.1', nanoid: '3.3.20',
    '@rollup/plugin-typescript': '12.3.0', typescript: '5.9.3', tslib: '2.8.1' },
  packageJson: { type: 'module', scripts: { build: 'rollup -c' } } };
// Rollup's and Rolldown's JavaScript APIs, called by a build script (build.mjs <mode>), and the rolldown command line
// Parcel 2 (test/apps/parcel): the parcel command line, and build.mjs for its JavaScript API
const parcelApp = (parcel, installer = { type: 'npm' }) => ({ app: 'parcel', bundler: 'parcel', installer,
  deps: { parcel, '@parcel/core': parcel, '@parcel/config-default': parcel, 'lodash-es': '4.18.1', uuid: '9.0.1', debug: '2.6.9', ms: '2.1.3', nanoid: '3.3.20',
    'normalize.css': '8.0.1', 'bootstrap-icons': '1.13.2', 'is-number': '7.0.0' },
  packageJson: { scripts: { build: 'parcel build src/index.html --dist-dir dist' } } });
// Angular's application builder (test/apps/angular): ng build, with the Angular packages of one release
// (tools: @angular/cli and @angular/build; fw: the framework's packages, released with their own patch versions)
const angularApp = (tools, fw, ts, installer = { type: 'npm' }) => ({ app: 'angular', bundler: 'angular', installer,
  deps: Object.fromEntries([...['cli', 'build'].map(p => [`@angular/${p}`, tools]), ...['core', 'common', 'compiler', 'compiler-cli', 'platform-browser'].map(p => [`@angular/${p}`, fw]),
    ['typescript', ts], ['rxjs', '7.8.2'], ['tslib', '2.8.1'], ['lodash-es', '4.18.1'], ['uuid', '9.0.1'], ['ms', '2.1.3'], ['nanoid', '3.3.20'],
    ['normalize.css', '8.0.1'], ['bootstrap-icons', '1.13.2'], ['is-number', '7.0.0'], ['debug', '2.6.9']]),
  packageJson: { scripts: { build: 'ng build' } } });
// test/apps/angular-ssr: the same app with server-side rendering (@angular/ssr: a server bundle, prerendered routes),
// left-pad only in the server; canaries (test/apps/canary's packages): bl-canary-dup 2.0.0 in the component (both
// outputs), bl-canary-used with its own bl-canary-dup 1.0.0 only in the server, bl-canary-unused imported, unused
const ANGULAR_CANARIES = 'rm -rf node_modules/bl-canary-* && cd pkgs && mv bl-canary-used bl-canary-unused ../node_modules/'
  + ' && mv bl-canary-dup-2 ../node_modules/bl-canary-dup && mkdir ../node_modules/bl-canary-used/node_modules'
  + ' && mv bl-canary-dup-1 ../node_modules/bl-canary-used/node_modules/bl-canary-dup && cd .. && rmdir pkgs';
const angularSsrApp = (tools, fw, ts) => { const a = angularApp(tools, fw, ts);
  return { ...a, app: 'angular-ssr', deps: { ...a.deps, '@angular/ssr': tools, '@angular/platform-server': fw, '@angular/router': fw,
    '@angular/localize': fw, 'left-pad': '1.3.0', '@types/node': '24.19.2' }, postInstall: ANGULAR_CANARIES }; }; // (localize: its i18n configuration)
// test/apps/angular-i18n: the same app localized (en-US, de: a copy of the output per locale, translations inlined)
const angularI18nApp = (tools, fw, ts) => { const a = angularApp(tools, fw, ts);
  return { ...a, app: 'angular-i18n', deps: { ...a.deps, '@angular/localize': fw } }; };
const esbuildApp = (esbuild, installer = { type: 'npm' }, extra = {}) => ({ app: 'esbuild', bundler: 'esbuild', installer,
  deps: { esbuild, 'lodash-es': '4.18.1', uuid: '9.0.1', debug: '2.6.9', ms: '2.1.3', nanoid: '3.3.20', 'normalize.css': '8.0.1', 'bootstrap-icons': '1.13.2', 'is-number': '7.0.0', ...extra },
  packageJson: { type: 'module', scripts: { build: 'node build.mjs build' } } });
const rollupApi = (rollup = '4.64.2', rolldown = '1.2.13', extra = {}) => ({ app: 'rollup-api', bundler: 'rollup', installer: { type: 'npm' },
  deps: { rollup, rolldown, '@rollup/plugin-node-resolve': '16.0.3', 'lodash-es': '4.18.1', nanoid: '3.3.20', 'normalize.css': '8.0.1', ...extra },
  packageJson: { type: 'module', scripts: { build: 'node build.mjs rollup' } } });
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
const nestedVite = (island, viteVersion, deps = {}) => ({ app: 'nested-island', bundler: 'nested-vite', installer: { type: 'npm' },
  deps: { ...ISLAND, vite: viteVersion, ...deps }, packageJson: { type: 'module', scripts: { build: `${island} && vite build` } } });
// rspack: the webpack5 app (test/apps/rspack) built by `rspack build` (@rspack/cli of the same version)
const RSPACK_SCRIPTS = { build: 'rspack build', 'build-reset': 'NODE_OPTIONS=--max-old-space-size=3072 rspack build' };
const rspack = (version, installer = { type: 'npm' }, extra = {}, scripts = {}) => ({ app: 'rspack', bundler: 'rspack', installer,
  deps: { '@rspack/core': version, '@rspack/cli': version, ...APP_DEPS, ...extra }, packageJson: { scripts: { ...RSPACK_SCRIPTS, ...scripts } } });
// rspack's own features (test/apps/rspack-features): native CSS, CssExtractRspackPlugin with Sass and Less, an asset, a
// worker, CopyRspackPlugin, packages whose exports rspack inlines (consts-only, consts-default: file: dependencies, copied
// into node_modules by the cases, see RSPACK_FEATURES_CMD)
const RSPACK_FEATURES_DEPS = { 'css-loader': '7.1.5', sass: '1.105.1', 'sass-loader': '17.0.1', bulma: '1.0.4', less: '4.9.1', 'less-loader': '13.0.0',
  'normalize.less': '1.0.0', 'normalize.css': '8.0.1', 'bootstrap-icons': '1.13.1', 'is-number': '7.0.0', 'left-pad': '1.3.0', 'sanitize.css': '13.0.0',
  'lodash-es': '4.18.1', 'consts-only': 'file:./pkgs/consts-only', 'consts-default': 'file:./pkgs/consts-default', 'escape-html': '1.0.3',
  'reset-css': '5.0.2', 'modern-normalize': '3.0.1' };
const rspackFeatures = (version) => ({ app: 'rspack-features', bundler: 'rspack', installer: { type: 'npm' },
  deps: { '@rspack/core': version, '@rspack/cli': version, ...RSPACK_FEATURES_DEPS }, packageJson: { scripts: { build: 'rspack build' } } });
// Rsbuild: the webpack5 app (test/apps/rsbuild, src/index.js) built by `rsbuild build`, with normalize.css copied
const rsbuild = (version, installer = { type: 'npm' }, extra = {}) => ({ app: 'rsbuild', bundler: 'rsbuild', installer,
  deps: { '@rsbuild/core': version, ...APP_DEPS, 'normalize.css': '8.0.1', ...extra }, packageJson: { scripts: { build: 'rsbuild build' } } });
// module federation on rspack (test/apps/rspack-federation): rspack 2's ModuleFederationPlugin needs
// @module-federation/runtime-tools installed (rspack 1.7 depends on its own); @module-federation/enhanced: RSPACK_MF=enhanced
const rspackFederation = (version, extra = {}) => ({ app: 'rspack-federation', bundler: 'rspack', installer: { type: 'npm' },
  deps: { '@rspack/core': version, '@rspack/cli': version, 'lodash-es': '4.18.1', ms: '2.1.3', ...extra }, packageJson: { scripts: { build: 'rspack build' } } });
// the Monaco editor with monaco-editor-webpack-plugin, which builds workers in child compilations (test/apps/rspack-monaco)
const rspackMonaco = (version) => ({ app: 'rspack-monaco', bundler: 'rspack', installer: { type: 'npm' },
  deps: { '@rspack/core': version, '@rspack/cli': version, 'monaco-editor': '0.52.2', 'monaco-editor-webpack-plugin': '7.1.1', 'lodash-es': '4.18.1',
    ms: '2.1.3', 'is-number': '7.0.0' }, packageJson: { scripts: { build: 'rspack build' } } });
// Next.js with next-rspack of the same version, which builds with rspack (next.config.js: NEXT_RSPACK_APP=1)
const nextRspack = (fx, version) => ({ ...fx, deps: { ...fx.deps, 'next-rspack': version } });

// canaries (test/apps/canary): packages whose shipped code carries BLCANARY:<name>@<version>, which run.cjs finds in the
// output's bytes - not through the bundler's own reporting, which the oracles read. Moved into node_modules after the
// install (npm links a file: directory): bl-canary-dup 2.0.0 at the top, 1.0.0 inside bl-canary-used
const CANARY_INSTALL = 'rm -rf node_modules/bl-canary-* && cd pkgs && mv bl-canary-used bl-canary-unused bl-canary-css bl-canary-import bl-canary-icon bl-canary-url bl-canary-glsl bl-canary-scss bl-canary-less ../node_modules/'
  + ' && mv bl-canary-dup-2 ../node_modules/bl-canary-dup && mkdir ../node_modules/bl-canary-used/node_modules'
  + ' && mv bl-canary-dup-1 ../node_modules/bl-canary-used/node_modules/bl-canary-dup && cd .. && rmdir pkgs';
// edge-manifests: engine.io-client pinned too (socket.io-client takes ~6.6.1), as the package whose build/esm/package.json
// has a name and no version
const MANIFESTS = { preact: '10.29.8', '@duetds/date-picker': '1.4.0', 'socket.io-client': '4.8.4', 'engine.io-client': '6.6.7' };
const manifests = (bundler, deps, packageJson = {}) => ({ app: 'edge-manifests', bundler, installer: { type: 'npm' }, deps: { ...MANIFESTS, ...deps }, packageJson });
const canary = (bundler, deps, packageJson = {}) => ({ app: 'canary', bundler, installer: { type: 'npm' }, deps, packageJson, postInstall: CANARY_INSTALL });

// fixture fields: app (test/apps/<app>), bundler (the oracle, test/oracles/<bundler>.cjs; default webpack), installer,
// deps, devDeps, packageJson (more package.json fields), postInstall (a command run in the fixture after the install,
// with network)
const fixtures = {
  'vite8-npm': vite('8.3.3'),
  'vite7-npm': vite('7.3.7'),
  'vite6-npm': vite('6.4.4'),
  'vite5-npm': vite('5.4.21'),
  'vite8-pnpm10': vite('8.3.3', { type: 'pnpm', version: '10.34.6' }),
  'vite8-pnpm9': vite('8.3.3', { type: 'pnpm', version: '9.15.9' }),
  'vite8-pnpm11': vite('8.3.3', { type: 'pnpm', version: '11.28.5' }),
  // packages outside the project: pnpm's global virtual store, Yarn's global cache
  'vite8-pnpm10-global-store': vite('8.3.3', { type: 'pnpm', version: '10.34.6', globalVirtualStore: true }),
  'vite8-yarn4-pnp-global-cache': vite('8.3.3', { type: 'yarn-berry', version: '4.18.1', linker: 'pnp', globalCache: true }),
  // an app of a monorepo built in its directory (packages/app), its dependencies hoisted to the root's node_modules
  'vite-monorepo': { app: 'vite-monorepo', bundler: 'vite', installer: { type: 'npm' }, deps: { vite: '8.3.3', 'lodash-es': '4.18.1', debug: '2.6.9', ms: '2.1.3' },
    packageJson: { workspaces: ['packages/app'] } },
  'vite8-yarn1': vite('8.3.3', { type: 'yarn1' }),
  'vite8-yarn4-pnp': vite('8.3.3', { type: 'yarn-berry', version: '4.18.1', linker: 'pnp' }),
  'vite7-yarn4-pnp': vite('7.3.7', { type: 'yarn-berry', version: '4.18.1', linker: 'pnp' }),
  'vite8-yarn4-node-modules': vite('8.3.3', { type: 'yarn-berry', version: '4.18.1', linker: 'node-modules' }),
  'vite8-yarn4-pnpm': vite('8.3.3', { type: 'yarn-berry', version: '4.18.1', linker: 'pnpm' }),
  'vite8-apm': { ...vite('8.3.3'), deps: { ...vite('8.3.3').deps, ...APM } }, // see wp5-apm
  'pkgmap-vite8-yarn4-node-modules': vite('8.3.3', { type: 'yarn-berry', version: '4.18.1', linker: 'node-modules', packageMap: true }),
  // Vitest, which transforms the tests with Vite and ships nothing (test/apps/vite-spa/test)
  'vite8-vitest': { ...vite('8.3.3'), devDeps: { vitest: '5.0.4' } },
  'vite8-bun': vite('8.3.3', { type: 'bun' }),
  'vite8-features': features('8.3.3', '8.2.3'),
  'vite7-features': features('7.3.7', '7.2.1'),
  // (vite-plugin-static-copy 4 needs Vite >= 6: no features fixture for Vite 5)
  'vite6-features': features('6.4.4', '6.1.1'),
  // Tailwind CSS 4 through @tailwindcss/vite: its own style sheets are inlined into the CSS output
  'vite8-tailwind': { app: 'tailwind', bundler: 'vite', installer: { type: 'npm' }, deps: { vite: '8.3.3', tailwindcss: '4.3.3', '@tailwindcss/vite': '4.3.3' },
    packageJson: { type: 'module', scripts: { build: 'vite build' } } },
  // Vite's root is not the working directory (test/apps/vite-root): a font from bootstrap-icons, an asset Vite names
  // relative to its root
  ...Object.fromEntries([['vite8-root', '8.3.3'], ['vite7-root', '7.3.7']].map(([name, version]) => [name, { app: 'vite-root', bundler: 'vite', installer: { type: 'npm' },
    deps: { vite: version, 'lodash-es': '4.18.1', 'bootstrap-icons': '1.13.2' }, packageJson: { type: 'module', scripts: { build: 'vite build' } } }])),
  'rollup-cli': rollupCli,
  // Rollup's CommonJS build under Yarn Plug'n'Play (on Node 22.22.3+ Node loads it without Module._load, see hooks.cjs)
  'rollup-cli-yarn4-pnp': { ...rollupCli, installer: { type: 'yarn-berry', version: '4.18.1', linker: 'pnp' } },
  'rollup-cli-yarn4-pnpm': { ...rollupCli, installer: { type: 'yarn-berry', version: '4.18.1', linker: 'pnpm' } },
  // (@rollup/wasm-node: Rollup's WebAssembly build, its own entry modules)
  'rollup-api': rollupApi('4.64.2', '1.2.13', { '@rollup/wasm-node': '4.64.2' }),
  // the oldest releases of the supported majors
  'rollup-api-floor': rollupApi('4.0.2', '1.0.0'),
  // esbuild's JavaScript API (test/apps/esbuild/build.mjs): the floor, the version of Vite 5, the latest; installers
  'esbuild': esbuildApp('0.28.2'),
  'esbuild-0.19': esbuildApp('0.19.12'),
  'esbuild-floor': esbuildApp('0.17.0'),
  'esbuild-0.16': esbuildApp('0.16.17'),
  'esbuild-pnpm10': esbuildApp('0.28.2', { type: 'pnpm', version: '10.34.6' }),
  'esbuild-yarn4-pnp': esbuildApp('0.28.2', { type: 'yarn-berry', version: '4.18.1', linker: 'pnp' }),
  'esbuild-wasm': esbuildApp('0.28.2', { type: 'npm' }, { 'esbuild-wasm': '0.28.2' }),
  'esbuild-features': esbuildApp('0.28.2', { type: 'npm' }, { 'esbuild-sass-plugin': '3.7.0', sass: '1.105.1', bulma: '1.0.4', 'sanitize.css': '13.0.0' }),
  // Parcel 2: the latest, the first release; installers
  'parcel': parcelApp('2.16.4'),
  'parcel-floor': parcelApp('2.0.0'),
  'parcel-pnpm10': parcelApp('2.16.4', { type: 'pnpm', version: '10.34.6' }),
  'parcel-yarn4-pnp': parcelApp('2.16.4', { type: 'yarn-berry', version: '4.18.1', linker: 'pnp' }),
  // Angular 22 (the latest), 21, 20
  'angular22': angularApp('22.2.2', '22.2.2', '6.0.3'),
  'angular21': angularApp('21.2.26', '21.2.25', '5.9.3'),
  'angular20': angularApp('20.3.39', '20.3.33', '5.8.3'),
  'angular22-pnpm10': angularApp('22.2.2', '22.2.2', '6.0.3', { type: 'pnpm', version: '10.34.6' }),
  'angular22-yarn4-pnp': angularApp('22.2.2', '22.2.2', '6.0.3', { type: 'yarn-berry', version: '4.18.1', linker: 'pnp' }),
  'angular22-i18n': angularI18nApp('22.2.2', '22.2.2', '6.0.3'),
  'angular20-i18n': angularI18nApp('20.3.39', '20.3.33', '5.8.3'),
  'angular22-ssr': angularSsrApp('22.2.2', '22.2.2', '6.0.3'),
  'angular21-ssr': angularSsrApp('21.2.26', '21.2.25', '5.9.3'),
  'angular20-ssr': angularSsrApp('20.3.39', '20.3.33', '5.8.3'),
  // a project directory with "#" in its name, which is no fragment of the module ids
  'rollup-api-c#': rollupApi('4.64.2', '1.2.13'),
  // rolldown-vite, Vite on Rolldown before Vite 8, installed as vite (npm alias): its package is named rolldown-vite
  'vite-rolldown7-npm': { ...vite('npm:rolldown-vite@7.3.1') },
  'nested-island-wp5': nested({ webpack: '5.111.1', 'webpack-cli': '7.2.3' }),
  'nested-island-wp4': nested({ webpack: '4.47.0', 'webpack-cli': '4.10.0' }),
  // the island built by Vite 7 (Rollup), and by Rolldown's API, each bundled by webpack 5
  'nested-island-vite7-wp5': { ...nested({ webpack: '5.111.1', 'webpack-cli': '7.2.3' }), deps: { webpack: '5.111.1', 'webpack-cli': '7.2.3', ...ISLAND, vite: '7.3.7' } },
  'nested-island-rolldown-wp5': { ...nested({ webpack: '5.111.1', 'webpack-cli': '7.2.3', rolldown: '1.2.13' }),
    packageJson: { scripts: { build: 'node island/rolldown.mjs && webpack --config webpack.config.js' } } },
  'nested-island-workspace': nestedWorkspace,
  'nested-island-vite': nestedVite('vite build --config island/vite.config.mjs', '8.3.3'),
  'nested-island-rollup': nestedVite('rollup -c island/rollup.config.mjs', '7.3.7',
    { rollup: '4.64.2', '@rollup/plugin-node-resolve': '16.0.3', '@rollup/plugin-commonjs': '29.0.3' }),
  // Nuxt 4 (Vite 8 client and server builds, Nitro): with pnpm, vite is only in pnpm's hidden node_modules/.pnpm/node_modules
  // (nuxt depends on it, the project does not); Nitro copies the client output's _nuxt/ files into .output/public/
  'nuxt4-pnpm10': { app: 'nuxt', bundler: 'nuxt', installer: { type: 'pnpm', version: '10.34.6' },
    deps: { nuxt: '4.6.1', nuxi: '4.0.1', vue: '3.5.44', 'lodash-es': '4.18.1' }, packageJson: { type: 'module', scripts: { build: 'nuxt build' } } },
  'sveltekit2': sveltekit('sveltekit2', '2.70.3', { vite: '7.3.7', '@sveltejs/vite-plugin-svelte': '6.2.4', '@sveltejs/adapter-static': '3.0.10', '@sveltejs/adapter-node': '5.5.7',
    '@sveltejs/adapter-netlify': '5.2.4' }),
  'sveltekit3': sveltekit('sveltekit3', '3.0.1', { vite: '8.3.3', '@sveltejs/vite-plugin-svelte': '7.3.1', '@sveltejs/adapter-static': '4.0.0', '@sveltejs/adapter-node': '6.0.0',
    '@sveltejs/adapter-netlify': '7.0.1' }),
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
  // yarn 4's pnpm linker: every package in node_modules/.store/<slug>/package, node_modules/<name> links to it
  'wp5-yarn4-pnpm': { ...latest, installer: { type: 'yarn-berry', version: '4.18.1', linker: 'pnpm' } },
  // the build run by tsx from a TypeScript build script (test/apps/webpack5/build.ts)
  'wp5-tsx': { ...latest, installer: { type: 'npm' }, deps: { ...latest.deps, tsx: '4.23.15' } },
  // webpack-cli loading a TypeScript config through a register hook (interpret/rechoir: the config has an enum, which
  // Node.js' type stripping cannot load), compiled by it - Module._extensions['.ts'] hooks next to bundle-lockfile's
  'wp5-ts-node': { ...latest, installer: { type: 'npm' }, deps: { ...latest.deps, 'ts-node': '10.9.2', typescript: '5.9.3' } },
  'wp5-swc-register': { ...latest, installer: { type: 'npm' }, deps: { ...latest.deps, '@swc/register': '0.1.10', '@swc/core': '1.15.3' } },
  'wp5-esbuild-register': { ...latest, installer: { type: 'npm' }, deps: { ...latest.deps, 'esbuild-register': '3.6.0', esbuild: '0.25.12' } },
  // tracing agents preloaded with bundle-lockfile: OpenTelemetry's loader (import-in-the-middle, which wraps every ES
  // module), dd-trace (--require, --import: in-thread hooks on Node.js 22.22.3+ / 24.11.1+, a loader thread before)
  'wp5-apm': { ...latest, installer: { type: 'npm' }, deps: { ...latest.deps, ...APM } },
  // yarn 4.17+'s package maps (nodeExperimentalPackageMap: --experimental-package-map in NODE_OPTIONS of what it runs)
  'pkgmap-wp5-yarn4-pnpm': { ...latest, installer: { type: 'yarn-berry', version: '4.18.1', linker: 'pnpm', packageMap: true } },
  // a project directory with "#" in its name: webpack's resolver escapes it in module paths
  'wp5-c#': { ...latest, installer: { type: 'npm' } },
  'wp5-npm8': { ...latest, installer: { type: 'npm', version: '8.19.4' } },
  'wp5-npm9': { ...latest, installer: { type: 'npm', version: '9.9.4' } },
  'wp5-npm10': { ...latest, installer: { type: 'npm', version: '10.9.9' } },
  'wp5-npm11': { ...latest, installer: { type: 'npm', version: '11.21.0' } },
  'wp5-pnpm8': { ...latest, installer: { type: 'pnpm', version: '8.15.9' } },
  'wp5-pnpm9': { ...latest, installer: { type: 'pnpm', version: '9.15.9' } },
  'wp5-pnpm10': { ...latest, installer: { type: 'pnpm', version: '10.34.6' } },
  'wp4-pnpm10': { ...wp4('4.47.0', '4.10.0'), installer: { type: 'pnpm', version: '10.34.6' } },
  'wp5-pnpm10-global-store': { ...latest, installer: { type: 'pnpm', version: '10.34.6', globalVirtualStore: true } },
  'wp5-pnpm11': { ...latest, installer: { type: 'pnpm', version: '11.28.5' } },
  'wp5-pnpm12': { ...latest, installer: { type: 'pnpm', version: '12.9.1' } },
  'wp5-bun': { ...latest, installer: { type: 'bun' } },
  'wp5-devdeps-npm': devdeps({ type: 'npm' }),
  'wp5-devdeps-yarn1': devdeps({ type: 'yarn1' }),
  'wp5-devdeps-pnpm11': devdeps({ type: 'pnpm', version: '11.28.5' }),
  'edge-alias': edge('edge-alias', { ms: '2.1.3', 'ms-old': 'npm:ms@2.0.0', debug: '2.6.9', 'debug-old': 'npm:debug@2.6.8' }),
  'edge-babel': edge('edge-babel', BABEL7),
  'edge-helpers': edge('edge-helpers', HELPERS),
  'edge-helpers-rollup': { app: 'edge-helpers', bundler: 'rollup', installer: { type: 'npm' },
    deps: { rollup: '4.64.6', '@rollup/plugin-babel': '7.1.0', '@babel/core': '7.29.7', '@babel/preset-env': '7.29.7', '@babel/helpers': '7.29.10' },
    packageJson: { type: 'module', scripts: { build: 'rollup -c' } } },
  // (bootstrap-icons: an image src/icons.css inlines as a data: URL, EDGE_CSS=inline)
  'edge-css': edge('edge-css', { 'css-loader': '7.1.5', 'mini-css-extract-plugin': '2.10.2', 'normalize.css': '8.0.1', 'lodash-es': '4.18.1', 'bootstrap-icons': '1.13.1' }),
  // a Vue 3 single-file component whose <style lang="scss"> @imports Bootstrap's Sass (test/apps/edge-vue)
  'edge-vue': edge('edge-vue', { vue: '3.5.43', 'vue-loader': '17.4.2', sass: '1.105.1', 'sass-loader': '16.0.8', 'css-loader': '7.1.5', 'mini-css-extract-plugin': '2.10.2',
    bootstrap: '5.3.8' }),
  'edge-asset': edge('edge-asset', { 'bootstrap-icons': '1.13.1' }),
  // style sheets from packages that loaders inline: Sass partials, Less @imports, Tailwind's CSS
  'edge-style': edge('edge-style', { 'css-loader': '7.1.5', 'mini-css-extract-plugin': '2.10.2', sass: '1.105.1', 'sass-loader': '17.0.1', bulma: '1.0.4',
    less: '4.9.1', 'less-loader': '13.0.0', 'normalize.less': '1.0.0', 'normalize.css': '8.0.1', postcss: '8.5.29', 'postcss-loader': '8.2.1',
    tailwindcss: '4.3.3', '@tailwindcss/postcss': '4.3.3' }),
  'edge-style-wp4': { app: 'edge-style', installer: { type: 'npm' }, deps: { ...WEBPACK4, 'css-loader': '5.2.7', 'mini-css-extract-plugin': '1.6.2',
    sass: '1.105.1', 'sass-loader': '10.5.2', bulma: '1.0.4', less: '4.9.1', 'less-loader': '7.3.0', 'normalize.less': '1.0.0', 'normalize.css': '8.0.1' } },
  'edge-dll': edge('edge-dll', { debug: '2.6.9', ms: '2.1.3', 'lodash-es': '4.18.1' }),
  'edge-federation': edge('edge-federation', { 'lodash-es': '4.18.1', ms: '2.1.3' }),
  // the build run by turbo (its package manager field is required)
  'edge-turbo': edge('edge-turbo', { 'lodash-es': '4.18.1', turbo: '2.11.7' }, { packageJson: { packageManager: 'npm@11.21.0' } }),
  'edge-workspace': edge('edge-workspace', { '@acme/ui': '1.0.0' }, { packageJson: { workspaces: ['packages/*'] } }),
  // vendored copies outside node_modules and inside an installed package (container: a file: dependency, copied into
  // node_modules by the cases, see VENDORED_CMD), and first-party members of the monorepo (npm workspaces, pnpm,
  // lerna, rush, Nx)
  'edge-vendored': edge('edge-vendored', { ms: '2.1.3', container: 'file:./pkgs/container' }, { packageJson: { workspaces: ['ws/*'] } }),
  'edge-subpkg': edge('edge-subpkg', { preact: '10.28.3' }),
  // modules only in the bundler's input file system (test/apps/edge-virtual)
  'edge-virtual': edge('edge-virtual', { 'webpack-virtual-modules': '0.6.2', unplugin: '2.3.11', ms: '2.1.3' }),
  'edge-virtual-vite8': { app: 'edge-virtual', bundler: 'vite', installer: { type: 'npm' }, deps: { vite: '8.3.3', unplugin: '2.3.11', ms: '2.1.3' },
    packageJson: { type: 'module', scripts: { build: 'vite build' } } },
  // a directory of the project as a dependency (local-lib, which depends on ms): npm links file: (first-party), yarn 2+
  // and pnpm copy it into node_modules (a package); link: and portal: link it (first-party). ms is a direct dependency
  // too where the linked directory's dependencies are not installed (link:)
  'edge-local-file-npm': edge('edge-local-dep', { 'local-lib': 'file:./local-lib' }),
  'edge-local-file-pnpm10': edge('edge-local-dep', { 'local-lib': 'file:./local-lib' }, { installer: { type: 'pnpm', version: '10.34.6' } }),
  'edge-local-link-pnpm10': edge('edge-local-dep', { 'local-lib': 'link:./local-lib', ms: '2.1.3' }, { installer: { type: 'pnpm', version: '10.34.6' } }),
  'edge-local-file-yarn4-pnp': edge('edge-local-dep', { 'local-lib': 'file:./local-lib' }, { installer: { type: 'yarn-berry', version: '4.18.1', linker: 'pnp' } }),
  'edge-local-portal-yarn4-pnp': edge('edge-local-dep', { 'local-lib': 'portal:./local-lib' }, { installer: { type: 'yarn-berry', version: '4.18.1', linker: 'pnp' } }),
  'edge-local-link-yarn4-nm': edge('edge-local-dep', { 'local-lib': 'link:./local-lib', ms: '2.1.3' },
    { installer: { type: 'yarn-berry', version: '4.18.1', linker: 'node-modules' } }),
  'edge-worker': edge('edge-worker', WORKER),
  'edge-worker-wp4': { app: 'edge-worker', installer: { type: 'npm' }, deps: { ...WEBPACK4, ...WORKER } },
  'edge-workbox': edge('edge-workbox', { 'workbox-webpack-plugin': '7.4.1', 'workbox-precaching': '7.4.1', 'lodash-es': '4.18.1', ...HTML }),
  'edge-copy': edge('edge-copy', { 'copy-webpack-plugin': '14.0.0', ...COPIED }),
  // copy-webpack-plugin 5 adds its files in webpack 4's emit hook, after the lockfile, without naming their source
  'edge-copy5-wp4': { app: 'edge-copy', installer: { type: 'npm' }, deps: { ...WEBPACK4, 'copy-webpack-plugin': '5.1.2', ...COPIED } },
  // copy-webpack-plugin 6 adds its files in webpack 4's additionalAssets hook; 6.3 and later name their source
  'edge-copy-wp4': { app: 'edge-copy', installer: { type: 'npm' }, deps: { ...WEBPACK4, 'copy-webpack-plugin': '6.4.1', ...COPIED } },
  // 6.0 - 6.2 do not (6.1, 6.2: only info.copied), before the lockfile is rendered; 6.2 adds a copied directory only
  // as a context dependency
  'edge-copy60-wp4': { app: 'edge-copy', installer: { type: 'npm' }, deps: { ...WEBPACK4, 'copy-webpack-plugin': '6.0.4', ...COPIED } },
  'edge-copy62': edge('edge-copy', { 'copy-webpack-plugin': '6.2.1', ...COPIED }),
  'edge-shared-output': edge('edge-shared-output', { debug: '2.6.9', ms: '2.1.3' }),
  // the build script overwrites NODE_OPTIONS with cross-env, as superset's, headlamp's, pgadmin4's (needs the node shim)
  'edge-crossenv': { app: 'webpack5', installer: { type: 'npm' }, deps: { ...WEBPACK, ...APP_DEPS, 'cross-env': '7.0.3' },
    packageJson: { scripts: { build: 'cross-env NODE_OPTIONS=--max-old-space-size=3072 webpack --config webpack.config.js' } } },
  'edge-compression': edge('edge-compression', { 'compression-webpack-plugin': '12.0.0', 'lodash-es': '4.18.1', ms: '2.1.3' }),
  // compression-webpack-plugin 6 runs in webpack 4's emit hook, after the lockfile was emitted
  // (memfs: in-memory output, see test/lib/memfs-build.cjs)
  'edge-compression-wp4': { app: 'edge-compression', installer: { type: 'npm' },
    deps: { ...WEBPACK4, 'compression-webpack-plugin': '6.1.2', 'lodash-es': '4.18.1', ms: '2.1.3', memfs: '4.80.0' } },
  // the webpack 5 app built into an in-memory output file system (memfs, as webpack-dev-middleware does)
  'edge-memfs': edge('webpack5', { ...APP_DEPS, memfs: '4.80.0' }),
  'edge-vanilla': edge('edge-vanilla', { '@vanilla-extract/css': '1.21.2', '@vanilla-extract/webpack-plugin': '2.3.27',
    'mini-css-extract-plugin': '2.10.2', 'css-loader': '7.1.5', 'lodash-es': '4.18.1' }),
  'edge-context': edge('edge-context', { debug: '2.6.9', ms: '2.1.3' }),
  // packages with peer dependencies (react-dom, use-sync-external-store): Yarn PnP's virtual paths, pnpm's peer-suffixed
  // directories; built by Vite (build) and webpack (build-webpack)
  ...Object.fromEntries([['peer-deps-yarn4-pnp', { type: 'yarn-berry', version: '4.18.1', linker: 'pnp' }], ['peer-deps-pnpm10', { type: 'pnpm', version: '10.34.6' }]]
    .map(([name, installer]) => [name, { app: 'peer-deps', bundler: 'vite', installer,
      deps: { ...WEBPACK, vite: '8.3.3', react: '19.3.0', 'react-dom': '19.3.0', 'use-sync-external-store': '1.6.0' },
      packageJson: { scripts: { build: 'vite build', 'build-webpack': 'webpack --config webpack.config.js' } } }])),
  // a webpack build (ms) and a Vite build (nanoid) into one dist/, as separate processes
  'mixed-output': { app: 'mixed-output', bundler: 'mixed', installer: { type: 'npm' },
    deps: { ...WEBPACK, vite: '8.3.3', ms: '2.1.3', nanoid: '3.3.20' } },
  ...Object.fromEntries(['1.0.14', '1.1.8', '1.2.8', '1.3.15', '1.5.8', '1.6.8', '2.0.8', '2.1.10']
    .map(v => [`rspack${v.split('.').slice(0, 2).join('.')}-npm`, rspack(v)])),
  // (@rspack/dev-server: the command line's, pinned - rspack serve bundles its client)
  'rspack1.7-npm': rspack('1.7.12', { type: 'npm' }, { '@rspack/dev-server': '1.1.5' }),
  // (webpack: a webpack process writing to rspack's output dir; memfs: test/lib/memfs-build.cjs; cross-env: build-crossenv)
  // (@rspack/dev-server: rspack serve)
  'rspack2.2-npm': rspack('2.2.8', { type: 'npm' }, { ...WEBPACK, memfs: '4.80.0', 'cross-env': '7.0.3', '@rspack/dev-server': '2.2.1' },
    { 'build-crossenv': 'cross-env NODE_OPTIONS=--max-old-space-size=3072 rspack build' }),
  'rspack2.2-apm': rspack('2.2.8', { type: 'npm' }, APM), // see wp5-apm
  'rspack2.2-ts-node': rspack('2.2.8', { type: 'npm' }, { 'ts-node': '10.9.2', typescript: '5.9.3' }), // see wp5-ts-node
  ...Object.fromEntries([['1.7', '1.7.12'], ['2.2', '2.2.8']].flatMap(([line, v]) => [
    [`rspack${line}-pnpm10`, rspack(v, { type: 'pnpm', version: '10.34.6' })],
    [`rspack${line}-yarn1`, rspack(v, { type: 'yarn1' })],
    [`rspack${line}-yarn4-pnp`, rspack(v, { type: 'yarn-berry', version: '4.18.1', linker: 'pnp' })],
    [`rspack${line}-yarn4-node-modules`, rspack(v, { type: 'yarn-berry', version: '4.18.1', linker: 'node-modules' })],
    [`rspack${line}-bun`, rspack(v, { type: 'bun' })]])),
  'rspack2.2-pnpm11': rspack('2.2.8', { type: 'pnpm', version: '11.28.5' }),
  'rspack2.2-yarn4-pnpm': rspack('2.2.8', { type: 'yarn-berry', version: '4.18.1', linker: 'pnpm' }),
  'rspack2.2-c#': rspack('2.2.8'),
  'rspack2.2-pnpm10-global-store': rspack('2.2.8', { type: 'pnpm', version: '10.34.6', globalVirtualStore: true }),
  'rspack-features1.2': rspackFeatures('1.2.8'),
  'rspack-features1.7': rspackFeatures('1.7.12'),
  'rspack-features2.2': rspackFeatures('2.2.8'),
  // OHIF's shape (test/apps/rspack-copies): the project's rspack 1.7 (the config's CopyRspackPlugin) and @rspack/cli 2
  // with its own rspack 2, which builds. npm does not install that (the command line's peer dependency on rspack 2
  // conflicts with the project's rspack 1, also with an override): installed without peer dependencies (the app's
  // .npmrc), then rspack 2 below the command line's directory
  'rspack-copies': { app: 'rspack-copies', bundler: 'rspack', installer: { type: 'npm' },
    deps: { '@rspack/core': '1.7.12', '@rspack/cli': '2.2.8', ...APP_DEPS, 'normalize.css': '8.0.1' },
    postInstall: 'cd node_modules/@rspack/cli && npm install -q --no-audit --no-fund --no-save @rspack/core@2.2.8',
    packageJson: { scripts: { build: 'node node_modules/@rspack/cli/bin/rspack.js build' } } },
  'rsbuild1.1-npm': rsbuild('1.1.10'),
  'rsbuild1.2-npm': rsbuild('1.2.19'),
  'rsbuild1.7-npm': rsbuild('1.7.6'),
  // (@rstest/core: Rstest, which bundles the tests with this Rsbuild)
  // @rspack/core pinned: rsbuild dev serves it (DEV_RSBUILD), and @rsbuild/core 2.2.12 takes any ~2.2.8
  'rsbuild2.2-npm': { ...rsbuild('2.2.12', { type: 'npm' }, { '@rspack/core': '2.2.8' }), devDeps: { '@rstest/core': '0.12.3' } },
  'rsbuild2.2-bun': rsbuild('2.2.12', { type: 'bun' }),
  'rsbuild2.2-yarn4-pnp': rsbuild('2.2.12', { type: 'yarn-berry', version: '4.18.1', linker: 'pnp' }),
  'rspack-federation2.2': rspackFederation('2.2.8', { '@module-federation/runtime-tools': '2.9.2', '@module-federation/enhanced': '2.9.2' }),
  'rspack-federation1.7': rspackFederation('1.7.12'),
  'rspack-monaco2.2': rspackMonaco('2.2.8'),
  'rspack-monaco1.2': rspackMonaco('1.2.8'),
  // a library built by Rslib (test/apps/rslib): ms a dependency, lodash-es a devDependency
  // a Vite-built island bundled by rspack (test/apps/nested-island, rspack.config.js)
  'nested-island-rspack': { ...nested({ '@rspack/core': '2.2.8', '@rspack/cli': '2.2.8' }),
    packageJson: { scripts: { build: 'vite build --config island/vite.config.mjs && rspack build' } } },
  // an npm workspace package (test/apps/edge-workspace, rspack.config.js)
  'rspack-workspace2.2': { app: 'edge-workspace', bundler: 'rspack', installer: { type: 'npm' },
    deps: { '@rspack/core': '2.2.8', '@rspack/cli': '2.2.8', '@acme/ui': '1.0.0' }, packageJson: { workspaces: ['packages/*'], scripts: { build: 'rspack build' } } },
  'rslib1.0-npm': { app: 'rslib', bundler: 'rslib', installer: { type: 'npm' }, deps: { ms: '2.1.3' }, devDeps: { '@rslib/core': '1.0.3', 'lodash-es': '4.18.1' },
    packageJson: { type: 'module', scripts: { build: 'rslib build' } } },
  'next12': next('12.3.7', '18.3.1'),
  'next13': next('13.5.11', '18.3.1'),
  'next14': next('14.2.35', '18.3.1'),
  'next15': next('15.5.27', '19.3.0'),
  'next16': next('16.4.0', '19.3.0'),
  'next15-app': nextApp('15.5.27', '19.3.0'),
  // the server's runtime packages (test/apps/next-runtime): canaries the server loads from node_modules at runtime
  'next16-runtime': nextRuntime('16.4.0', '19.3.0'),
  'next15-runtime': nextRuntime('15.5.27', '19.3.0'),
  'next16-runtime-pnpm10': nextRuntime('16.4.0', '19.3.0', { type: 'pnpm', version: '10.34.6' }),
  'next16-app': nextApp('16.4.0', '19.3.0'),
  // next-rspack 15.5: @rspack/core 1.4 (CommonJS); 16.4: @next/rspack-core 1.0.3, which is @rspack/core 2.0 (an ES module)
  'next15-rspack': nextRspack(next('15.5.27', '19.3.0'), '15.5.27'),
  'next16-rspack': nextRspack(next('16.4.0', '19.3.0'), '16.4.0'),
  'next16-app-rspack': nextRspack(nextApp('16.4.0', '19.3.0'), '16.4.0'),
  'canary-wp5': canary('webpack', WEBPACK),
  'canary-rspack2.2': canary('rspack', { '@rspack/core': '2.2.8', '@rspack/cli': '2.2.8' }, { scripts: { build: 'rspack build' } }),
  'canary-vite8': canary('vite', { vite: '8.3.3' }, { type: 'module', scripts: { build: 'vite build' } }),
  ...Object.fromEntries(['7.3.7', '6.1.6', '6.0.11', '5.4.21'].map(v => [`canary-vite${v}`, canary('vite', { vite: v }, { type: 'module', scripts: { build: 'vite build' } })])),
  'canary-rolldown-vite7': canary('vite', { vite: 'npm:rolldown-vite@7.3.1' }, { type: 'module', scripts: { build: 'vite build' } }),
  // Rolldown's API (rolldown.mjs); rollup for the oracle, which builds src/main.js with rollup.config.mjs
  ...Object.fromEntries(['1.2.13', '1.0.0'].map(v => [`canary-rolldown${v}`, canary('rollup', { rolldown: v, rollup: '4.64.2', '@rollup/plugin-node-resolve': '16.0.3' },
    { type: 'module', scripts: { build: 'node rolldown.mjs build' } })])),
  'canary-rollup': canary('rollup', { rollup: '4.64.2', '@rollup/plugin-node-resolve': '16.0.3' }, { type: 'module', scripts: { build: 'rollup -c' } }),
  // tsdown (tsdown.config.mjs; Rolldown ~1.1); rollup for the oracle, which builds src/main.js with rollup.config.mjs
  'canary-tsdown': canary('rollup', { tsdown: '0.22.2', rollup: '4.64.2', '@rollup/plugin-node-resolve': '16.0.3' }, { type: 'module', scripts: { build: 'tsdown' } }),
  'canary-esbuild': canary('esbuild', { esbuild: '0.28.2' }, { type: 'module', scripts: { build: 'node esbuild.mjs' } }),
  'canary-parcel': canary('parcel', { parcel: '2.16.4', '@parcel/transformer-glsl': '2.16.4', '@parcel/transformer-sass': '2.16.4', '@parcel/transformer-less': '2.16.4' }, { scripts: { build: 'parcel build parcel.html --dist-dir dist --no-optimize' } }), // (optimized SVGs lose their markers, comments)
  // package.json files inside real packages (test/apps/edge-manifests), built by webpack 5, Vite 8 and Rollup
  'edge-manifests-wp5': manifests('webpack', WEBPACK),
  'edge-manifests-vite8': manifests('vite', { vite: '8.3.3' }, { type: 'module', scripts: { build: 'vite build' } }),
  'edge-manifests-rollup': manifests('rollup', { rollup: '4.64.2', '@rollup/plugin-node-resolve': '16.0.3', '@rollup/plugin-commonjs': '29.0.3' },
    { type: 'module', scripts: { build: 'rollup -c' } }),
};

const VITE_EXPECT = ['debug@2.6.9', 'lodash-es@4.18.1', 'ms@2.0.0', 'ms@2.1.3', 'normalize.css@8.0.1'];
// both pages of vite-spa (vite.config.mjs and vite.second.config.mjs)
const VITE_BOTH = [...VITE_EXPECT, 'is-number@7.0.0'].sort();
// watch mode: the build, the rebuild without the lazy chunk (ms@2.1.3), the rebuild with it again
const VITE_WATCH_BUILDS = [VITE_EXPECT, VITE_EXPECT.filter(p => p !== 'ms@2.1.3'), VITE_EXPECT];
const ROLLUP_API = ['lodash-es@4.18.1', 'nanoid@3.3.20'];
// test/apps/esbuild: not uuid (imported, unused); debug with its own ms@2.0.0; bootstrap-icons' font (the file loader)
// and normalize.css (@imported by the CSS)
const ESBUILD = ['bootstrap-icons@1.13.2', 'debug@2.6.9', 'lodash-es@4.18.1', 'ms@2.0.0', 'ms@2.1.3', 'nanoid@3.3.20', 'normalize.css@8.0.1'];
// test/apps/parcel: as ESBUILD (the font through a style sheet's url()), is-number; and Parcel's runtime, which loads
// the lazy bundle (a file Parcel generates in @parcel/runtime-js)
const PARCEL = (v) => [...ESBUILD, 'is-number@7.0.0', `@parcel/runtime-js@${v}`].sort();
// test/apps/angular: the framework's packages of the fixture's release, rxjs (the framework imports it), the app's
const ANGULAR = (fixture) => { const fw = fixtures[fixture].deps['@angular/core'];
  return [...['common', 'core', 'platform-browser'].map(p => `@angular/${p}@${fw}`), 'bootstrap-icons@1.13.2', 'debug@2.6.9', 'is-number@7.0.0', 'lodash-es@4.18.1',
    'ms@2.0.0', 'ms@2.1.3', 'nanoid@3.3.20', 'normalize.css@8.0.1', 'rxjs@7.8.2'].sort(); };
// watch modes: the build, the rebuild without nanoid, the rebuild with it again
const ROLLUP_WATCH_BUILDS = [ROLLUP_API, ['lodash-es@4.18.1'], ROLLUP_API];
const CANARY_JS = ['bl-canary-dup@1.0.0', 'bl-canary-dup@2.0.0', 'bl-canary-used@1.0.0'];
// the canaries of files inlined into a module (the shader include) and of the style sheets (Rollup's canary build has no CSS)
const CANARY_INLINED = { js: ['bl-canary-glsl@1.0.0'], all: ['bl-canary-css@1.0.0', 'bl-canary-glsl@1.0.0', 'bl-canary-icon@1.0.0', 'bl-canary-import@1.0.0'] };
// the image JavaScript inlines with new URL(): a module of webpack's and rspack's builds, inlined by Vite's (Rollup leaves
// the URL as it is: not in the output)
const CANARY_URL = 'bl-canary-url@1.0.0';
// the Sass partial and the Less file Parcel's canary build inlines into its own style sheets
const CANARY_PARCEL_STYLE = ['bl-canary-less@1.0.0', 'bl-canary-scss@1.0.0'];
const CANARY_VITE = [...CANARY_JS, ...CANARY_INLINED.all, CANARY_URL].sort();
const CANARY_ROLLDOWN = [...CANARY_JS, ...CANARY_INLINED.js].sort();
// what a Rolldown build without its plugin contexts' records and without a build object (watch()) does not list: every
// file a plugin inlined (bl-canary-css is a module)
const UNRECORDED_WITHOUT_CONTEXTS = ['bl-canary-glsl@1.0.0', 'bl-canary-icon@1.0.0', 'bl-canary-import@1.0.0', 'bl-canary-url@1.0.0'];
const NESTED_EXPECT = ['is-number@7.0.0', 'lodash-es@4.18.1', 'nanoid@3.3.20'];
// edge-vendored (src/index.js): the copies outside node_modules (left-pad by an alias, is-odd by resolve.modules,
// vscode-languageclient with engines.vscode but no publisher, a copy of ms@2.1.3, the in-repo app-lib), container and
// the copy inside it; not: the VS Code extension manifest (yaml), the name npm does not accept, private-lib, the
// workspace members (npm, pnpm, lerna, rush, Nx)
// container as an installed package (npm links a file: directory; Wolfi's npm 12 does so with install-links too)
const VENDORED_CMD = 'rm -rf node_modules/container && cp -r pkgs/container node_modules/container && npm run -s build';
const VENDORED = ['app-lib@1.0.0', 'container@1.0.0', 'inner-vendored@2.0.0', 'is-odd@3.0.1', 'left-pad@1.3.0', 'ms@2.1.3', 'vscode-languageclient@10.1.2'];
// in SvelteKit's client output: the page's lodash-es, the service worker's nanoid, the runtime
const SVELTE_CLIENT = (kit) => [`@sveltejs/kit@${kit}`, 'lodash-es@4.18.1', 'nanoid@3.3.20', 'svelte@5.57.2'];
// the exact list: core-js, systemjs are the legacy polyfills', workbox-* the service worker's
// (bulma: a Sass partial; normalize.less: a Less @import)
const FEATURES_EXPECT = ['bootstrap-icons@1.13.2', 'bulma@1.0.4', 'core-js@3.50.0', 'is-number@7.0.0', 'lodash-es@4.18.1', 'nanoid@3.3.20', 'normalize.css@8.0.1', 'normalize.less@1.0.0',
  'sanitize.css@13.0.0', 'systemjs@6.15.1', 'workbox-core@7.4.1', 'workbox-precaching@7.4.1', 'workbox-routing@7.4.1', 'workbox-strategies@7.4.1'];
// not in source maps: style sheets (sanitize.css, bulma, normalize.less), the copy (normalize.css), the worker's font
// (bootstrap-icons)
const FEATURES_MISSING = ['bootstrap-icons@1.13.2', 'bulma@1.0.4', 'normalize.css@8.0.1', 'normalize.less@1.0.0', 'sanitize.css@13.0.0'];
const W5 = ['debug@2.6.9', 'lodash-es@4.18.1', 'ms@2.0.0', 'ms@2.1.3', 'nanoid@3.3.20', 'yallist@5.0.0'];
// webpack 4 also bundles its node polyfills (process) and webpack/buildin/* modules
const W4 = (v) => ['debug@2.6.9', 'lodash-es@4.18.1', 'ms@2.0.0', 'ms@2.1.3', 'nanoid@3.3.20', 'process@0.11.10', `webpack@${v}`];
const DEVDEPS = ['classnames@2.5.1', 'lodash-es@4.18.1'];
// keys of packages outside the project (Yarn's global cache, pnpm's global virtual store): node_modules/<name>, then
// node_modules/<name>@<version> for another version
const OUTSIDE_KEYS_VITE = { 'node_modules/debug': 'debug@2.6.9', 'node_modules/lodash-es': 'lodash-es@4.18.1', 'node_modules/ms': 'ms@2.0.0',
  'node_modules/ms@2.1.3': 'ms@2.1.3', 'node_modules/normalize.css': 'normalize.css@8.0.1' };
const OUTSIDE_KEYS_W5 = { 'node_modules/debug': 'debug@2.6.9', 'node_modules/lodash-es': 'lodash-es@4.18.1', 'node_modules/ms': 'ms@2.0.0',
  'node_modules/ms@2.1.3': 'ms@2.1.3', 'node_modules/nanoid': 'nanoid@3.3.20', 'node_modules/yallist': 'yallist@5.0.0' };
const PEER_DEPS = ['react-dom@19.3.0', 'react@19.3.0', 'scheduler@0.28.0', 'use-sync-external-store@1.6.0'];
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
// every lockfile below .next and its packages (the files they record differ: Next's build id is new on every build)
const NEXT_LOCKS = `node ${path.join(__dirname, 'lib/locks.cjs')} .next`;
const FAULT = `--require ${path.join(__dirname, 'lib/fault.cjs')}`; // makes collecting the packages throw
const FAULT_FILES = `--require ${path.join(__dirname, 'lib/fault-for-files.cjs')}`; // ... also those of given files (Next's runtime packages)
// a favicon from a package, which the HTML plugins read and emit as an asset of their own: uuid's LICENSE.md (uuid is in
// no bundle: imported, unused). The oracles read the bundlers' modules, which it is none of
const FAVICON = 'node_modules/uuid/LICENSE.md';
const ROLLDOWN_SHAPE = `--require ${path.join(__dirname, 'lib/rolldown-shape.cjs')}`; // Rolldown's plugin contexts of a shape bundle-lockfile does not know
// node_modules/naked: bundled code in node_modules without a package.json (webpack5 app with EDGE_NAKED=1), removed afterwards
const NAKED = "mkdir -p node_modules/naked && echo \"console.log('naked')\" > node_modules/naked/index.js && npm run -s build; s=$?; rm -rf node_modules/naked; exit $s";
const PRELOAD = `--require ${path.join(__dirname, 'lib/preload.cjs')}`; // another preload, which does nothing
const LIB = path.join(__dirname, 'lib');
// the tracing agents of the *-apm fixtures, from the fixture (run.cjs: {fixture}); dd-trace without an agent to send to
const OTEL = '--experimental-loader={fixture}/node_modules/@opentelemetry/instrumentation/hook.mjs';
const DD = '{fixture}/node_modules/dd-trace';
// Node.js's warnings about those agents' ways in (see the cases)
const EXPERIMENTAL_LOADER = /^ExperimentalWarning: `--experimental-loader` may be removed in the future; instead use `register\(\)`:$/;
const MODULE_REGISTER = /^\[DEP0205\] DeprecationWarning: `module\.register\(\)` is deprecated\. Use `module\.registerHooks\(\)` instead\.$/;
const DD_ENV = { DD_TRACE_AGENT_URL: 'http://127.0.0.1:9', DD_TRACE_TELEMETRY_ENABLED: 'false', DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
  DD_TRACE_STARTUP_LOGS: 'false', DD_REMOTE_CONFIGURATION_ENABLED: 'false' };
// watch.cjs <file> <text>: rebuilds without the lines of <file> that contain <text>, then with them again
const WATCH = `node ${path.join(__dirname, 'lib/watch.cjs')}`;
const ANGULAR_WATCH = `node ${path.join(__dirname, 'lib/angular-watch.cjs')}`;
const ANGULAR_SERVE = `node ${path.join(__dirname, 'lib/angular-serve.cjs')}`;
// the metafile importer (bin/bundle-lockfile-from-metafile), for the esbuild command line
const FROM_METAFILE = `node ${path.join(__dirname, '../bin/bundle-lockfile-from-metafile')}`;
// the esbuild command line building what build.mjs's "build" mode builds, with a metafile
const ESBUILD_CLI = './node_modules/.bin/esbuild src/main.js --bundle --outdir=dist --format=esm --splitting --loader:.woff2=file --log-level=warning --metafile=meta.json';
const WATCH_FAIL = `node ${path.join(__dirname, 'lib/watch-fail.cjs')}`;
const MEMFS = `node ${path.join(__dirname, 'lib/memfs-build.cjs')}`; // into memfs, then copied to the disk
const ROLLUP_CLI_WATCH = `node ${path.join(__dirname, 'lib/rollup-cli-watch.cjs')}`; // rollup -c -w, rebuilt twice
// this Node.js has the in-thread ESM hooks (docs/bundlers.md: 22.22.3, 24.11.1, 25.1 and later), which every process gets
const [NODE_MA, NODE_MI, NODE_PA] = process.versions.node.split('.').map(Number);
const SYNC_HOOKS = NODE_MA >= 26 || (NODE_MA === 25 && NODE_MI >= 1) || (NODE_MA === 24 && (NODE_MI > 11 || (NODE_MI === 11 && NODE_PA >= 1)))
  || (NODE_MA === 22 && (NODE_MI > 22 || (NODE_MI === 22 && NODE_PA >= 3)));
// `vite build --watch` through Vite's API, run as the fixture's own build script (see the script)
// (rebuilt without src/main.js's lazy import, whose chunk has ms@2.1.3, then with it again)
const VITE_WATCH = `cp ${path.join(__dirname, 'lib/vite-watch.mjs')} .vite-watch.mjs && node .vite-watch.mjs "import('./lazy.js')"`;
// `vite build` in a worker thread (see the script), run as the fixture's own script
const VITE_WORKER = `cp ${path.join(__dirname, 'lib/vite-worker.mjs')} .vite-worker.mjs && node .vite-worker.mjs`;
// the canary app: rebuilt without the shader's import (bl-canary-glsl leaves the lockfile), then with it
const VITE_WATCH_CANARY = `cp ${path.join(__dirname, 'lib/vite-watch.mjs')} .vite-watch.mjs && node .vite-watch.mjs "./shader.glsl"`;
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
// workbox GenerateSW: the app's lodash-es; in workbox-<hash>.js the runtime its precaching needs (checked in the file: its
// modules from workbox-core, -precaching, -routing and -strategies)
const WORKBOX_GENERATE = ['lodash-es@4.18.1', 'workbox-core@7.4.1', 'workbox-precaching@7.4.1', 'workbox-routing@7.4.1', 'workbox-strategies@7.4.1'];
// edge-vue: Vue's runtime (vue's own entry re-exports it and is left out: sideEffects false), vue-loader's
// exportHelper, Bootstrap's Sass in main.css
const VUE_EXPECT = ['@vue/reactivity@3.5.43', '@vue/runtime-core@3.5.43', '@vue/runtime-dom@3.5.43', '@vue/shared@3.5.43', 'bootstrap@5.3.8', 'vue-loader@17.4.2'];
// rspack's two compilers (app, sw; RSPACK_SHARED) as two processes at the same time
const RSPACK_BIN = './node_modules/.bin/rspack';
const PARALLEL_RSPACK = `${RSPACK_BIN} build --config-name app & a=$!; ${RSPACK_BIN} build --config-name sw & b=$!; wait $a && wait $b`;
// the packages of app (ms@2.1.3) and sw (debug and its ms@2.0.0) of edge-shared-output and the rspack app
const SHARED = ['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3'];
// the rspack app's two compilers into dist/[fullhash] (RSPACK_SHARED=fullhash): exactly two directories, app.js next
// to a lockfile with app's packages, sw.js next to one with sw's
const RSPACK_FULLHASH = `npm run -s build && test "$(for d in dist/*/; do echo "$(cd "$d" && ls app.js sw.js 2>/dev/null) $(node ${path.join(__dirname, 'lib/locks.cjs')} "$d")"; done | sort)" = "$(printf 'app.js .: @rspack/core@2.2.8 ms@2.1.3\\nsw.js .: @rspack/core@2.2.8 debug@2.6.9 ms@2.0.0')"`;
// consts-only and consts-default as installed packages (npm links a file: directory)
const RSPACK_CONSTS = 'rm -rf node_modules/consts-only node_modules/consts-default && cp -r pkgs/consts-only pkgs/consts-default node_modules/';
// (and the copy of modern-normalize.css was minimized: not the package file's bytes)
const RSPACK_FEATURES_CMD = `${RSPACK_CONSTS} && npm run -s build && ! cmp -s dist/copied/modern-normalize.css node_modules/modern-normalize/modern-normalize.css`;
// rspack-features: the font, the style sheets' packages (bulma's partial, normalize.less, normalize.css @imported by
// app.css and by normalize.less), the worker's is-number, the copies (left-pad's file, sanitize.css' directory), the
// packages whose exports rspack 1.7 and later inline (consts-only; consts-default only rspack 2), the glob's copy
// (escape-html), the transformed copy (reset-css), the minimized copy (modern-normalize)
const RSPACK_FEATURES = ['bootstrap-icons@1.13.1', 'bulma@1.0.4', 'consts-default@1.0.0', 'consts-only@1.0.0', 'escape-html@1.0.3', 'is-number@7.0.0',
  'left-pad@1.3.0', 'lodash-es@4.18.1', 'modern-normalize@3.0.1', 'normalize.css@8.0.1', 'normalize.less@1.0.0', 'reset-css@5.0.2', 'sanitize.css@13.0.0'];
// style sheets loaders inline (no modules, and the stats have no file dependencies), and the transformed copy (the
// oracle matches copies by their bytes)
const RSPACK_FEATURES_MISSING = ['bulma@1.0.4', 'normalize.less@1.0.0', 'reset-css@5.0.2'];
// the webpack5 app and a copied normalize.css (Rsbuild's output.copy, rspack-copies' CopyRspackPlugin)
const W5_COPY = [...W5, 'normalize.css@8.0.1'].sort();
// rspack-federation: rspack bundles the federation runtime (@module-federation/*: 2.9.2 from runtime-tools with rspack 2,
// rspack 1.7's own 0.22.0) into both outputs; the host ships its fallback copy of lodash-es, the remote also its ms
const MF_RUNTIME = (v) => ['error-codes', 'runtime', 'runtime-core', 'sdk', 'webpack-bundler-runtime'].map(p => `@module-federation/${p}@${v}`);
const FEDERATION = (v) => ({ host: [...MF_RUNTIME(v), 'lodash-es@4.18.1'], remote: [...MF_RUNTIME(v), 'lodash-es@4.18.1', 'ms@2.1.3'] });
// with tree shaking of the shared lodash-es (RSPACK_MF_TS=1), rspack builds it again for each, in a compiler of its own
// (IndependentSharedPlugin's, created while the build runs) into <output>/independent-packages/lodash_es/. The oracle
// builds the config's compilers and does not see those: they are lodash-es and rspack (the fixture's 2.2.8), whose
// runtime is in each
const FEDERATION_TS = { 'host/independent-packages/lodash_es': ['@rspack/core@2.2.8', 'lodash-es@4.18.1'], 'remote/independent-packages/lodash_es': ['@rspack/core@2.2.8', 'lodash-es@4.18.1'] };
// rspack-monaco: Monaco, its workers' (ms only in the custom language's), lodash-es, the own worker's is-number
const MONACO = ['is-number@7.0.0', 'lodash-es@4.18.1', 'monaco-editor@0.52.2', 'ms@2.1.3'];
// dev-server.cjs <command>: the lockfile a dev server serves from memory, written to dist/ afterwards
const DEV_SERVER = `node ${path.join(__dirname, 'lib/dev-server.cjs')}`;
// Vite's dev and preview servers (test/lib/vite-servers.cjs), and a vitest run, then no lockfile anywhere in the project
const VITE_SERVERS = (mode) => `node ${path.join(__dirname, 'lib/vite-servers.cjs')} ${mode}`;
const VITEST = "./node_modules/.bin/vitest run && test -z \"$(find . -path ./node_modules -prune -o -path '*/bundle-lockfile/package-lock.json' -print)\"";
// what a dev server's first build bundles of the webpack5 app: rspack serve and rsbuild dev compile dynamic imports
// lazily (lazyCompilation imports: true, their default for web apps), so nanoid's chunk is not built until the page
// asks for it; and they add their client to the entries (HMR runtime from @rspack/core, the dev server's client)
const DEV_W5 = W5.filter(p => !p.startsWith('nanoid@'));
const DEV_RSPACK2 = [...DEV_W5, '@rspack/core@2.2.8', '@rspack/dev-server@2.2.1'];
const DEV_RSPACK1 = [...DEV_W5, '@rspack/core@1.7.12', '@rspack/dev-server@1.1.5', 'webpack-dev-server@5.2.2'];
const DEV_RSBUILD = [...DEV_W5, '@rsbuild/core@2.2.12', '@rspack/core@2.2.8', 'normalize.css@8.0.1'];
// Rstest's run, then no lockfile anywhere in the project (outside node_modules)
const RSTEST = "./node_modules/.bin/rstest run && test -z \"$(find . -path ./node_modules -prune -o -path '*/bundle-lockfile/package-lock.json' -print)\"";
// Next.js with next-rspack: the lockfiles of the webpack builds of the same app and version (their oracle's lists;
// @edge-runtime/cookies and server-only: Next's vendored copies in next/dist/compiled/)
// runtime: the server's runtime packages, the oracle's (Next's optional dependencies, sharp and its platform packages,
// are not pinned)
const NEXT_PAGES = (nextVersion, swc) => ({ '': [`@swc/helpers@${swc}`, 'lodash-es@4.18.1', 'ms@2.1.3', `next@${nextVersion}`, 'react-dom@19.3.0', 'react@19.3.0', 'scheduler@0.28.0'],
  server: [], 'server/chunks': ['@edge-runtime/cookies@6.0.0', `@swc/helpers@${swc}`, 'lodash-es@4.18.1', `next@${nextVersion}`], runtime: 'oracle' });
const NEXT_APP = (nextVersion, swc) => ({ '': [`@swc/helpers@${swc}`, 'ms@2.1.3', `next@${nextVersion}`, 'react-dom@19.3.0', 'react@19.3.0', 'scheduler@0.28.0'],
  server: ['@edge-runtime/cookies@6.0.0', 'is-number@7.0.0', 'nanoid@3.3.20', `next@${nextVersion}`],
  'server/chunks': ['@edge-runtime/cookies@6.0.0', `@swc/helpers@${swc}`, 'lodash-es@4.18.1', 'ms@2.1.3', `next@${nextVersion}`, 'server-only@0.0.1'], runtime: 'oracle' });
const NEXT_RSPACK_ENV = { ...NEXT_ENV, NEXT_RSPACK_APP: '1' };

// Next.js: one lockfile per compiler (client, server, edge-server); the exact per-compiler lists come from the oracle
function nextCase(fixture, version, react, flags = '') {
  return {
    fixture, cmd: `./node_modules/.bin/next build ${flags}`.trim(), oracleArgs: flags, outDir: '.next', env: NEXT_ENV,
    expectIncludes: ['ms@2.1.3', 'lodash-es@4.18.1', `next@${version}`, `react@${react}`],
    // uuid: imported and unused, so in no bundle - but the server output keeps it external, and Next copies it into
    // the standalone output (also for a page it prerendered): a runtime package
    expectExcludesIn: Object.fromEntries(['', 'server', 'server/chunks'].map(k => [k, ['uuid@9.0.1']])),
  };
}

// case fields:
//   cmd        build command, run with sh in the fixture dir; $PNPM is the fixture's vendored pnpm
//   inject     put --require <register.cjs> into NODE_OPTIONS (default true)
//   nodeOptions extra NODE_OPTIONS before the --require (kept for the oracle build too); {fixture}: the fixture's directory
//   nodeOptionsAfter  extra NODE_OPTIONS after the --require (not for the oracle build)
//   env        extra environment variables
//   nodeOptionsWith  (register) => NODE_OPTIONS of the build, instead of nodeOptions + bundle-lockfile's --require
//   expect     expected name@version list of the single output, or null = no lockfile must be written
//   expectIncludes / expectExcludes  packages that must / must not appear in any output (multi-compiler builds)
//   expectIn   { "<output dir relative to outDir>": [name@version, ...] | "oracle" }: exactly these outputs with these
//              packages ("oracle": the output must be there, its packages are the oracle's - lists that would drift)
//   expectIncludesIn / expectExcludesIn  { "<output dir>": [name@version, ...] }: packages that must / must not be in
//              that output
//   outDir     where the bundler writes (default dist); every lockfile below it is checked against the oracle
//   oracleArgs extra arguments for the oracle (e.g. next build flags)
//   installed  name@version that must be installed in the fixture's node_modules (checked before the build)
//   projectLockfile  syft on the project's own lockfile (not ours) must include / exclude these - documents the difference
//   sbom       functional checks: stage files into a package-like root, `syft scan dir:` it as SPDX JSON and
//              require exactly these npm packages (name, version, purl, declared license, source file)
//   heapMB     the build's own process has about this heap limit: the configured --max-old-space-size reached it (the app's
//              config writes it to BLTEST_HEAP_FILE: test/apps/webpack5, test/apps/rspack)
//   outside    why the lockfiles may list packages outside the project or of unknown location ("outside", "unknown"
//              in the record: a global store or cache, copies of outputs): without it, any such package fails the case
//   expectOutput  RegExp the build's stdout+stderr must match
//   expectError  RegExp: a known failure of the build tool - the build must fail, its output match (nothing else checked)
//   lockfile   lockfile path below each output dir (default bundle-lockfile/package-lock.json)
//   expectKeys {lockfile key: name@version} - exactly the keys of the single output
//   watchBuilds  the cmd prints a JSON list of per-build package lists last; it must be this list of lists
//   exportDir  BUNDLE_LOCKFILE_EXPORT_DIR=<fixture>/.export: its copies are checked and must equal the inline lockfiles
//   exportOnly the same with BUNDLE_LOCKFILE_INLINE=0: no inline lockfile may be written
//   shim       put bin/ (the node shim) first in PATH
//   oracle     false: no oracle comparison (the case's shape cannot be built by the oracle)
//   oracleScript  the oracle (test/oracles/<name>.cjs) if not the fixture's bundler's
//   settingsFile  bundle-lockfile from a copy with a settings file (config.json, see src/core/config.cjs): true - the
//              case's BUNDLE_LOCKFILE_* settings (exportDir included) moved there out of the environment; a string -
//              that file content, the environment as it is
//   maxNode    the newest Node.js major the build tool runs on: skipped (and reported) on newer ones (say why at the case)
//   minNode    { <major>: <minor> }: the Node.js versions a feature the case uses came with (a listed major from that minor
//              on, majors newer than every listed one): skipped (and reported) on others (say why at the case)
//   oracleMissing  packages the oracle cannot see, added to every output's truth (say why at the case)
//   oracleMissingIn  the same for single outputs: { "<output dir>": [name@version, ...] }
//   canaryUnlisted  canaries (test/apps/canary) in the output that are not listed - a documented limit (say why at the
//              case); exactly these, so the limit is pinned
//   canaryDirs  directories (relative to the fixture) whose canaries count as shipped too: where a server loads its runtime
//              packages from (node_modules, for a Next.js server that is not standalone)
//   runtimeTrace  { routes: [...] }: the output is a standalone Next.js server (server.js); it is started with
//              test/oracles/runtime-tracer.cjs, every route is requested, and every package it loaded from node_modules
//              must be in the output's lockfile ("" output) - a lower bound, independent of Next's traces
//   expectSources  path fragments ("/"-separated, e.g. "node_modules/preact/hooks/"): each must be part of a source file
//              of the oracle's build (its --sources), so the files the case is about are bundled at all
//   allowWarnings  [RegExp]: Node.js warnings the build may print (the text after "(node:<pid>) "), besides `warnings`
const cases = [
  // activation
  { name: 'not active without NODE_OPTIONS', fixture: 'wp5-npm', cmd: 'npm run -s build', inject: false, expect: null },
  { name: 'BUNDLE_LOCKFILE_DISABLE=webpack', fixture: 'wp5-npm', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_DISABLE: 'webpack' }, expect: null },
  { name: 'existing NODE_OPTIONS are preserved', fixture: 'wp5-npm', cmd: 'npm run -s build', nodeOptions: '--max-old-space-size=3072', heapMB: 3072, expect: W5 },
  // html-webpack-plugin 5 reads its favicon and emits it while webpack processes the assets: the package is listed
  { name: 'webpack 5.111.1: html-webpack-plugin 5 favicon from a package', fixture: 'wp5-npm', cmd: 'npm run -s build', env: { EDGE_FAVICON: FAVICON },
    expect: [...W5, 'uuid@9.0.1'].sort(), oracleMissing: ['uuid@9.0.1'] },
  { name: 'webpack 4.47.0: html-webpack-plugin 4 favicon from a package (emitted in the emit hook)', fixture: 'wp4.47-npm', cmd: 'npm run -s build',
    nodeOptions: LEGACY_SSL, env: { EDGE_FAVICON: FAVICON }, expect: [...W4('4.47.0'), 'uuid@9.0.1'].sort(), oracleMissing: ['uuid@9.0.1'] },
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
  // webpack 4's hooks fail a build only with a compilation error (a throw there exits 0): strict mode does that too
  { name: 'strict: failing adapter fails the build (webpack 4.0.0)', fixture: 'wp4.0-npm', cmd: 'npm run -s build', nodeOptions: `${LEGACY_SSL} ${FAULT}`,
    expectError: /bundle-lockfile: the lockfile would be missing or incomplete[\s\S]*webpack: could not collect the packages of \S*dist: injected fault/ },
  { name: 'STRICT=0: failing adapter does not break the build (webpack 4.0.0)', fixture: 'wp4.0-npm', cmd: 'npm run -s build', nodeOptions: `${LEGACY_SSL} ${FAULT}`,
    env: { BUNDLE_LOCKFILE_STRICT: '0' }, expect: null, expectOutput: /\[bundle-lockfile\] WARNING: webpack: could not collect the packages of \S*dist: Error: injected fault/ },
  { name: 'webpack 4.47.0 (child compiler: html-webpack-plugin 4)', fixture: 'wp4.47-npm', cmd: 'npm run -s build', nodeOptions: LEGACY_SSL, expect: W4('4.47.0') },
  { name: 'webpack 4.47.0, default-if-unset NODE_OPTIONS script via yarn 1', fixture: 'wp4.47-npm', cmd: 'yarn -s webpack-prod', nodeOptions: `${LEGACY_SSL} --max_old_space_size=4096`, expect: W4('4.47.0') },
  { name: 'webpack 5.0.0', fixture: 'wp5.0-npm', cmd: 'npm run -s build', expect: W5 },
  // a development build: no unused-export analysis or scope hoisting (what it bundles, the oracle says from the stats)
  { name: 'webpack 5.111.1, development mode', fixture: 'wp5-npm', cmd: 'npm run -s build', env: { EDGE_MODE: 'development' }, expect: W5 },
  { name: 'webpack 4.47.0, pnpm 10.34.6', fixture: 'wp4-pnpm10', cmd: '$PNPM run build', nodeOptions: LEGACY_SSL, expect: W4('4.47.0') },
  { name: 'webpack 5.60.0 (child compiler)', fixture: 'wp5.60-npm', cmd: 'npm run -s build', expect: W5 },
  { name: 'webpack 5.111.1 (child compiler)', fixture: 'wp5-npm', cmd: 'npm run -s build', expect: W5 },
  // runners / installers
  { name: 'npx webpack', fixture: 'wp5-npm', cmd: 'npx webpack', expect: W5 },
  { name: 'direct node_modules/.bin/webpack', fixture: 'wp5-npm', cmd: './node_modules/.bin/webpack', expect: W5 },
  // turbo passes NODE_OPTIONS to its tasks, also in its default strict env mode (no turbo cache: the task runs)
  { name: 'turbo run build (turbo 2.11.7)', fixture: 'edge-turbo', cmd: './node_modules/.bin/turbo run build --cache=local:,remote:',
    env: { TURBO_TELEMETRY_DISABLED: '1' }, expect: ['lodash-es@4.18.1'] },
  // settings that do not reach the build through the environment: turbo's strict env mode passes NODE_OPTIONS and PATH
  // to its tasks, not BUNDLE_LOCKFILE_* (without the settings file the export copy is missing), and a build started with
  // an environment of its own (Metabase's) - the preload (or the node shim) finds the settings file next to itself
  { name: 'settings file: the export directory through turbo, whose strict env mode drops BUNDLE_LOCKFILE_*', fixture: 'edge-turbo',
    cmd: './node_modules/.bin/turbo run build --cache=local:,remote:', env: { TURBO_TELEMETRY_DISABLED: '1' }, exportDir: true, settingsFile: true,
    expect: ['lodash-es@4.18.1'] },
  { name: 'settings file: a build in an environment of its own (env -i) through the node shim, export directory only', fixture: 'wp5-npm',
    cmd: 'env -i PATH="$PATH" HOME="$HOME" npm run -s build', shim: true, exportOnly: true, settingsFile: true, expect: W5 },
  { name: 'strict: a settings file that cannot be read fails the build', fixture: 'wp5-npm', cmd: 'npm run -s build', settingsFile: '{not json',
    expectError: /bundle-lockfile: the lockfile would be missing or incomplete[\s\S]*could not read the settings file \S*\.bl\/src\/config\.json/ },
  { name: 'STRICT=0: a settings file that cannot be read is a warning', fixture: 'wp5-npm', cmd: 'npm run -s build', settingsFile: '{not json',
    env: { BUNDLE_LOCKFILE_STRICT: '0' }, expect: W5, expectOutput: /\[bundle-lockfile\] WARNING: could not read the settings file \S*\.bl\/src\/config\.json/ },
  { name: 'yarn 1.22 (yarn.lock)', fixture: 'wp5-yarn1', cmd: 'yarn --offline -s build', expect: W5 },
  { name: "yarn 3.8.7 Plug'n'Play", fixture: 'wp5-yarn3-pnp', cmd: 'yarn build', expect: W5 },
  // the packages are in .yarn/cache/<zip>/node_modules/: keyed node_modules/<name>[@<version>], as those in a global cache
  { name: "yarn 4.18.1 Plug'n'Play", fixture: 'wp5-yarn4-pnp', cmd: 'yarn build', expect: W5, expectKeys: OUTSIDE_KEYS_W5 },
  // keys must not carry the path to the cache, which differs between machines
  { name: "yarn 4.18.1 Plug'n'Play, global cache", outside: 'Yarn\'s global cache, outside the project', fixture: 'wp5-yarn4-pnp-global-cache', cmd: 'yarn build', expect: W5,
    expectKeys: { 'node_modules/debug': 'debug@2.6.9', 'node_modules/lodash-es': 'lodash-es@4.18.1', 'node_modules/ms': 'ms@2.0.0',
      'node_modules/ms@2.1.3': 'ms@2.1.3', 'node_modules/nanoid': 'nanoid@3.3.20', 'node_modules/yallist': 'yallist@5.0.0' } },
  { name: 'yarn 4.18.1 node-modules linker', fixture: 'wp5-yarn4-node-modules', cmd: 'yarn build', expect: W5 },
  // the pnpm linker: the packages below node_modules/.store, each keyed by its location there; webpack is hooked there too
  { name: 'yarn 4.18.1 pnpm linker', fixture: 'wp5-yarn4-pnpm', cmd: 'yarn build', expect: W5 },
  // a TypeScript build script run by tsx, which compiles webpack's modules itself (Module.prototype._compile)
  { name: 'webpack API from a TypeScript build script, tsx build.ts', fixture: 'wp5-tsx', cmd: './node_modules/.bin/tsx build.ts', expect: W5 },
  { name: 'webpack API from a TypeScript build script, node --import tsx build.ts', fixture: 'wp5-tsx', cmd: 'node --import tsx build.ts', expect: W5 },
  // a TypeScript config through a register hook (ts-node needs its tsconfig.json to say CommonJS, also without bundle-lockfile)
  { name: 'webpack-cli, webpack.config.ts through ts-node/register', fixture: 'wp5-ts-node', expect: W5,
    cmd: `printf '{"compilerOptions":{"module":"commonjs"}}' > tsconfig.json && cp ${LIB}/webpack.config.enum.ts webpack.config.ts && ./node_modules/.bin/webpack --config webpack.config.ts` },
  ...[['@swc/register', 'wp5-swc-register'], ['esbuild-register', 'wp5-esbuild-register']].map(([what, fixture]) => (
    { name: `webpack-cli, webpack.config.ts through ${what}`, fixture, expect: W5,
      cmd: `cp ${LIB}/webpack.config.enum.ts webpack.config.ts && ./node_modules/.bin/webpack --config webpack.config.ts` })),
  // Node.js' type stripping loads the config itself (22.18, 23.6 and later)
  { name: 'webpack-cli, webpack.config.ts by Node.js\' type stripping', fixture: 'wp5-npm', expect: W5, minNode: { 22: 18, 23: 6 },
    cmd: `cp ${LIB}/webpack.config.strip.ts webpack.config.ts && ./node_modules/.bin/webpack --config webpack.config.ts; s=$?; rm -f webpack.config.ts; exit $s` },
  { name: 'rspack 2.2.8, rspack.config.ts through ts-node/register', fixture: 'rspack2.2-ts-node', expect: W5,
    cmd: `printf '{"compilerOptions":{"module":"commonjs"}}' > tsconfig.json && cp ${LIB}/rspack.config.enum.ts rspack.config.ts && ./node_modules/.bin/rspack build -c rspack.config.ts` },
  // tracing agents next to bundle-lockfile, before and after its --require (see wp5-apm): exactly the build's packages.
  // Node.js warns about OpenTelemetry's --experimental-loader, and on 26 about dd-trace's initialize.mjs, which calls
  // module.register() (DEP0205; bundle-lockfile uses module.registerHooks there)
  ...[['webpack 5', 'wp5-apm', W5, {}], ['Vite 8.3.3', 'vite8-apm', VITE_EXPECT, { oracleMissing: ['normalize.css@8.0.1'] }],
    ['rspack 2.2.8', 'rspack2.2-apm', W5, {}]].flatMap(([what, fixture, expect, extra]) => [
    ['OpenTelemetry\'s loader before', { nodeOptions: OTEL, allowWarnings: [EXPERIMENTAL_LOADER] }],
    ['OpenTelemetry\'s loader after', { nodeOptionsAfter: OTEL, allowWarnings: [EXPERIMENTAL_LOADER] }],
    ['dd-trace --import initialize.mjs', { nodeOptionsAfter: `--import ${DD}/initialize.mjs`, allowWarnings: [MODULE_REGISTER] }],
    ['dd-trace --import register.js', { nodeOptionsAfter: `--import ${DD}/register.js` }],
    ['dd-trace --require before', { nodeOptions: `--require ${DD}/init` }], ['dd-trace --require after', { nodeOptionsAfter: `--require ${DD}/init` }],
  ].map(([how, opts]) => ({ name: `${what}, ${how} bundle-lockfile`, fixture, cmd: 'npm run -s build', env: DD_ENV, expect, ...extra, ...opts }))),
  // yarn 4.17+'s package maps: yarn puts --experimental-package-map into NODE_OPTIONS (Node.js 24.20, 26.4 and later)
  ...[['webpack 5, yarn 4.18.1 pnpm linker', 'pkgmap-wp5-yarn4-pnpm', W5, {}],
    ['Vite 8.3.3, yarn 4.18.1 node-modules linker', 'pkgmap-vite8-yarn4-node-modules', VITE_EXPECT, { oracleMissing: ['normalize.css@8.0.1'] }]].map(([what, fixture, expect, extra]) => (
    { name: `${what}, package maps (nodeExperimentalPackageMap)`, fixture, cmd: 'yarn build', expect, ...extra, minNode: { 24: 20, 26: 4 },
      expectOutput: /Package maps is an experimental feature/, allowWarnings: [/^ExperimentalWarning: Package maps is an experimental feature and might change at any time$/] })),
  { name: 'webpack 5.111.1 in a directory with "#" in its name', fixture: 'wp5-c#', cmd: 'npm run -s build', expect: W5 },
  // older npm releases (installed and run with that npm); the default fixtures use the npm on PATH
  { name: 'npm 8.19.4', fixture: 'wp5-npm8', cmd: '$NPM run -s build', expect: W5 },
  { name: 'npm 9.9.4', fixture: 'wp5-npm9', cmd: '$NPM run -s build', expect: W5 },
  { name: 'npm 10.9.9', fixture: 'wp5-npm10', cmd: '$NPM run -s build', expect: W5 },
  { name: 'npm 11.21.0', fixture: 'wp5-npm11', cmd: '$NPM run -s build', expect: W5 },
  { name: 'npm 10.9.9 npx webpack', fixture: 'wp5-npm10', cmd: '$NPM exec -- webpack', expect: W5 },
  { name: 'pnpm 8.15.9', fixture: 'wp5-pnpm8', cmd: '$PNPM run build', expect: W5 },
  { name: 'pnpm 9.15.9', fixture: 'wp5-pnpm9', cmd: '$PNPM run build', expect: W5 },
  { name: 'pnpm 10.34.6', fixture: 'wp5-pnpm10', cmd: '$PNPM run build', expect: W5 },
  // packages in pnpm's global virtual store, outside the project: keys without the machine-specific path, like Yarn's
  // global cache
  { name: 'pnpm 10.34.6, global virtual store', outside: 'pnpm\'s global virtual store, outside the project', fixture: 'wp5-pnpm10-global-store', cmd: '$PNPM run build', expect: W5, expectKeys: OUTSIDE_KEYS_W5 },
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
        expect: [npmPkg('classnames', '2.5.1', 'MIT', DIST_LOCK), npmPkg('lodash-es', '4.18.1', 'MIT', DIST_LOCK), npmPkg('webpack', '5.111.1', 'MIT', DIST_LOCK)] },
      // the package also ships the project's own lockfile: the SBOM gets the union, incl. the never-bundled
      // is-number and the project itself (see README)
      { name: 'build output + project lockfile', stage: { 'usr/share/app/dist': 'dist', 'usr/share/app/package-lock.json': 'package-lock.json' },
        expect: [npmPkg('classnames', '2.5.1', 'MIT', DIST_LOCK), npmPkg('lodash-es', '4.18.1', 'MIT', DIST_LOCK), npmPkg('webpack', '5.111.1', 'MIT', DIST_LOCK),
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
  // @babel/runtime's ES-module helpers are below helpers/esm/, whose package.json is only {"type": "module"}
  { name: 'edge: Babel-injected core-js / @babel/runtime', fixture: 'edge-babel', cmd: 'npm run -s build', expectIncludes: ['core-js@3.50.0', '@babel/runtime@7.29.10'],
    expectSources: ['node_modules/@babel/runtime/helpers/esm/'] },
  // transpiler helpers inlined into modules (src/core/helpers.cjs): the transpiler the loader resolves, as the fixture
  // pins it - helpers imported instead (@babel/runtime, tslib, @swc/helpers) are modules, listed as such; the oracle
  // finds the inlined ones in webpack's stats and Rollup's maps (test/lib/helpers.cjs)
  ...[['babel', ['@babel/helpers@7.29.10']],
    // (transform-runtime still inlines the helpers it wraps: _objectSpread around @babel/runtime's defineProperty)
    ['babel-runtime', ['@babel/helpers@7.29.10', '@babel/runtime@7.29.10']],
    ['ts', ['typescript@5.9.3']], ['ts-tslib', ['tslib@2.8.1']], ['swc', ['@swc/core@1.16.18']], ['swc-external', ['@swc/helpers@0.5.23']]]
    .map(([mode, expect]) => ({ name: `edge: transpiler helpers, ${mode}`, fixture: 'edge-helpers', cmd: 'npm run -s build', env: { EDGE_HELPERS: mode },
      expect, expectVia: { helpers: expect.filter(id => /^(@babel\/helpers|typescript|@swc\/core)@/.test(id)) } })),
  { name: 'edge: transpiler helpers, Rollup with @rollup/plugin-babel (bundled helpers module)', fixture: 'edge-helpers-rollup', cmd: 'npm run -s build',
    expect: ['@babel/helpers@7.29.10'], expectVia: { helpers: ['@babel/helpers@7.29.10'] } },
  { name: 'edge: CSS from packages (mini-css-extract)', fixture: 'edge-css', cmd: 'npm run -s build', expectIncludes: ['normalize.css@8.0.1', 'lodash-es@4.18.1'] },
  // a package's image inlined as a data: URL into the extracted CSS: mini-css-extract-plugin built the asset module at
  // build time (importModule), in no chunk - not in the stats' modules of a chunk (oracleMissing)
  { name: 'edge: a package image inlined as a data: URL into extracted CSS (mini-css-extract)', fixture: 'edge-css', cmd: 'npm run -s build',
    env: { EDGE_CSS: 'inline' }, expect: ['bootstrap-icons@1.13.1', 'lodash-es@4.18.1'], oracleMissing: ['bootstrap-icons@1.13.1'] },
  // a Vue single-file component's <style lang="scss"> @imports Bootstrap's Sass (no module of its own: oracleMissing);
  // vue-loader's exportHelper is a module of the bundle
  { name: 'edge: Sass from a package in a Vue single-file component\'s style block (vue-loader)', fixture: 'edge-vue', cmd: 'npm run -s build',
    expect: VUE_EXPECT, oracleMissing: ['bootstrap@5.3.8'] },
  { name: 'edge: asset/resource from a package', fixture: 'edge-asset', cmd: 'npm run -s build', expectIncludes: ['bootstrap-icons@1.13.1'] },
  // a JavaScript module from a data: URL is no file of any package: the build lists only the asset's package
  { name: 'edge: a JavaScript module from a data: URL', fixture: 'edge-asset', cmd: 'npm run -s build', env: { EDGE_ASSET: 'data-js' },
    expect: ['bootstrap-icons@1.13.1'] },
  { name: 'edge: CSS from packages, webpack 5 native CSS (experiments.css)', fixture: 'edge-css', cmd: 'npm run -s build', env: { EDGE_CSS: 'native' },
    expect: ['lodash-es@4.18.1', 'normalize.css@8.0.1'] },
  { name: 'edge: asset/inline from a package (a data: URL in main.js)', fixture: 'edge-asset', cmd: 'npm run -s build', env: { EDGE_ASSET: 'inline' },
    expect: ['bootstrap-icons@1.13.1'] },
  // module federation: each build ships its fallback copy of the shared lodash-es; the host loads the remote's
  // widget (and its ms) at runtime from the remote's output, so ms is only the remote's
  { name: 'edge: module federation (a host, a remote, a shared package)', fixture: 'edge-federation', cmd: 'npm run -s build',
    expectIn: { host: ['lodash-es@4.18.1'], remote: ['lodash-es@4.18.1', 'ms@2.1.3'] } },
  // the stats the oracle reads have no file dependencies, which is where those style sheets are
  { name: 'edge: style sheets inlined from packages (sass-loader, less-loader, Tailwind via postcss-loader)', fixture: 'edge-style', cmd: 'npm run -s build',
    expect: STYLE_EXPECT, oracleMissing: STYLE_EXPECT, expectVia: { style: STYLE_EXPECT } },
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
  { name: 'edge: subpath manifests (preact/hooks)', fixture: 'edge-subpkg', cmd: 'npm run -s build', expect: ['preact@10.28.3'],
    expectSources: ['node_modules/preact/hooks/'] },
  // virtual modules: one in a package directory that is not on disk is generated code (a warning, not a failure), one
  // inside an installed package counts as that package; unplugin's (webpack: <context>/_virtual_/, Vite: a \0 id) are none
  { name: 'edge: virtual modules (webpack-virtual-modules, unplugin), webpack 5', fixture: 'edge-virtual', cmd: 'npm run -s build', expect: ['ms@2.1.3'],
    expectOutput: /node_modules\/virtual-pkg is not on disk: its bundled files are generated in memory/,
    expectSources: ['node_modules/virtual-pkg/index.js', 'node_modules/ms/virtual-inside.js', '_virtual_'] },
  { name: 'edge: virtual modules (unplugin), Vite 8.3.3', fixture: 'edge-virtual-vite8', cmd: 'npm run -s build', expect: ['ms@2.1.3'] },
  // workspace packages count as first-party also when webpack keeps the node_modules/@acme/ui symlink path
  { name: 'edge: npm workspace package, resolve.symlinks=false', fixture: 'edge-workspace', cmd: 'npm run -s build', env: { EDGE_RESOLVE_SYMLINKS: 'false' }, expect: ['ms@2.1.3'] },
  // a project directory as a dependency: linked (first-party, its dependency listed) or copied into node_modules (a package)
  { name: 'edge: file: directory dependency, npm (linked)', fixture: 'edge-local-file-npm', cmd: 'npm run -s build', expect: ['ms@2.1.3'] },
  { name: 'edge: file: directory dependency, pnpm 10 (copied into node_modules)', fixture: 'edge-local-file-pnpm10', cmd: '$PNPM run build',
    expect: ['local-lib@1.0.0', 'ms@2.1.3'] },
  { name: 'edge: link: dependency, pnpm 10 (linked)', fixture: 'edge-local-link-pnpm10', cmd: '$PNPM run build', expect: ['ms@2.1.3'] },
  { name: "edge: file: directory dependency, yarn 4 Plug'n'Play (packed into the cache)", fixture: 'edge-local-file-yarn4-pnp', cmd: 'yarn build',
    expect: ['local-lib@1.0.0', 'ms@2.1.3'] },
  { name: "edge: portal: dependency, yarn 4 Plug'n'Play (linked)", fixture: 'edge-local-portal-yarn4-pnp', cmd: 'yarn build', expect: ['ms@2.1.3'] },
  { name: 'edge: link: dependency, yarn 4 node-modules linker (linked)', fixture: 'edge-local-link-yarn4-nm', cmd: 'yarn build', expect: ['ms@2.1.3'] },
  // child compilers whose output is shipped: worker-loader (a worker inside a worker, a worker inlined into
  // main.js), workbox's service worker. html-webpack-plugin's child compiler only renders the template at build
  // time and is not counted.
  // via: lodash-es and worker-loader's runtime for the inlined worker in main.js; the rest only in the workers
  { name: 'edge: worker-loader workers, nested and inlined (child compilers)', fixture: 'edge-worker', cmd: 'npm run -s build', expect: WORKERS,
    expectVia: { chunk: ['lodash-es@4.18.1', 'worker-loader@3.0.8'], child: ['debug@2.6.9', 'is-number@7.0.0', 'ms@2.0.0', 'ms@2.1.3'] } },
  { name: 'edge: worker-loader workers, nested and inlined, webpack 4', fixture: 'edge-worker-wp4', cmd: 'npm run -s build', nodeOptions: LEGACY_SSL,
    expectIncludes: WORKERS },
  { name: 'edge: workbox InjectManifest service worker', fixture: 'edge-workbox', cmd: 'npm run -s build',
    expectIncludes: ['workbox-core@7.4.1', 'workbox-precaching@7.4.1', 'lodash-es@4.18.1'], expectExcludes: ['html-webpack-plugin@5.6.6', 'workbox-webpack-plugin@7.4.1'] },
  // GenerateSW: sw.js and workbox-<hash>.js (workbox-core and -precaching inside) come from workbox-build's Rollup
  // generate(): no webpack modules, so not in webpack's stats (oracleMissing)
  { name: 'edge: workbox GenerateSW service worker (generated by workbox-build, emitted as assets)', fixture: 'edge-workbox', cmd: 'npm run -s build',
    env: { EDGE_SW: 'generate' }, expect: WORKBOX_GENERATE, oracleMissing: WORKBOX_GENERATE.filter(p => p.startsWith('workbox-')),
    expectVia: { generated: WORKBOX_GENERATE.filter(p => p.startsWith('workbox-')) } },
  // copy-webpack-plugin: a package file copied verbatim into the output is shipped; copied first-party files are not packages
  { name: 'edge: package file and directory copied by copy-webpack-plugin', fixture: 'edge-copy', cmd: 'npm run -s build', expect: COPIED_EXPECT,
    expectVia: { chunk: ['lodash-es@4.18.1'], 'copy-source': ['left-pad@1.3.0', 'normalize.css@8.0.1'], 'copy-bytes': [] } },
  // a plugin copies normalize.css into the output with fs in afterEmit (filemanager-webpack-plugin's copy action): no
  // asset of webpack's (oracleMissing)
  { name: 'edge: a package file copied into the output with fs after the build (afterEmit)', fixture: 'edge-copy', cmd: 'npm run -s build',
    env: { EDGE_COPY: 'after-emit' }, expect: ['lodash-es@4.18.1', 'normalize.css@8.0.1'], oracleMissing: ['normalize.css@8.0.1'],
    expectVia: { chunk: ['lodash-es@4.18.1'], late: ['normalize.css@8.0.1'] } },
  { name: 'edge: package file and directory copied by copy-webpack-plugin 6.4, webpack 4', fixture: 'edge-copy-wp4', cmd: 'npm run -s build', nodeOptions: LEGACY_SSL,
    expectIncludes: COPIED_EXPECT },
  // copies that do not name their source are matched by content to the package file they were copied from
  { name: 'edge: package file and directory copied by copy-webpack-plugin 5, webpack 4', fixture: 'edge-copy5-wp4', cmd: 'npm run -s build', nodeOptions: LEGACY_SSL,
    expectIncludes: COPIED_EXPECT, expectVia: { 'copy-bytes': ['left-pad@1.3.0', 'normalize.css@8.0.1'], 'copy-source': [] } },
  { name: 'edge: package file and directory copied by copy-webpack-plugin 6.0, webpack 4', fixture: 'edge-copy60-wp4', cmd: 'npm run -s build', nodeOptions: LEGACY_SSL,
    expectIncludes: COPIED_EXPECT },
  // webpack 5 minimizes those copies (6.2 does not mark them as copied for the minimizers): matched before that; the
  // oracle compares the output's bytes and so sees left-pad by its files that are not minimized, normalize.css not
  { name: 'edge: package file and directory copied by copy-webpack-plugin 6.2', fixture: 'edge-copy62', cmd: 'npm run -s build', expect: COPIED_EXPECT,
    oracleMissing: ['normalize.css@8.0.1'] },
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
  // ... unless its clean keeps sw's file (output.clean.keep): sw's packages stay
  { name: 'edge: two webpack processes, one output dir, the second one cleans it but keeps the first one\'s file', fixture: 'edge-shared-output',
    env: { EDGE_SHARED: 'clean-keep' }, cmd: `${WEBPACK_BIN} --config-name sw && ${WEBPACK_BIN} --config-name app`, expect: ['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3'] },
  // a failed rebuild is not emitted: the lockfile keeps the packages of the output still in dist/
  { name: 'edge: two compilers, one output dir, watch mode with a failing rebuild', fixture: 'edge-shared-output', cmd: WATCH_FAIL,
    expect: ['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3'], watchBuilds: [1, 2, 3].map(() => ['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3']) },
  { name: 'edge: compression-webpack-plugin with deleteOriginalAssets', fixture: 'edge-compression', cmd: 'npm run -s build', expect: ['lodash-es@4.18.1'] },
  { name: 'edge: compression-webpack-plugin 6 with deleteOriginalAssets, webpack 4', fixture: 'edge-compression-wp4', cmd: 'npm run -s build', nodeOptions: LEGACY_SSL,
    expectIncludes: ['lodash-es@4.18.1'] },
  // an in-memory output file system (webpack-dev-middleware's memfs): the lockfile is an asset, nothing reaches the disk
  // (memfs-build.cjs copies the in-memory output there afterwards)
  { name: 'edge: in-memory output file system (memfs): the lockfile is an asset', fixture: 'edge-memfs', cmd: MEMFS, expect: W5 },
  // ... which compression-webpack-plugin 6 deletes in webpack 4's emit hook: emitted again
  { name: 'edge: in-memory output file system, compression-webpack-plugin 6 deleting the lockfile asset, webpack 4', fixture: 'edge-compression-wp4',
    cmd: MEMFS, nodeOptions: LEGACY_SSL, expectIncludes: ['lodash-es@4.18.1'] },
  // two compilers whose files are all replaced by .gz files, then one of them again in another process: the other's
  // .gz files are still there, so are its packages (webpack 4 replaces them in the emit hook, after the lockfile was rendered)
  { name: 'edge: compression-webpack-plugin with deleteOriginalAssets, two compilers, one output dir, then one of them again', fixture: 'edge-compression',
    env: { EDGE_COMPRESSION: 'two' }, cmd: `npm run -s build && ${WEBPACK_BIN} --config-name sw`, expect: ['lodash-es@4.18.1', 'ms@2.1.3'] },
  { name: 'edge: compression-webpack-plugin 6 with deleteOriginalAssets, two compilers, one output dir, then one of them again, webpack 4',
    fixture: 'edge-compression-wp4', env: { EDGE_COMPRESSION: 'two' }, cmd: `npm run -s build && ${WEBPACK_BIN} --config-name sw`, nodeOptions: LEGACY_SSL,
    expectIncludes: ['lodash-es@4.18.1', 'ms@2.1.3'] },
  // the virtual CSS module reads a placeholder file in @vanilla-extract/webpack-plugin, a build tool;
  // @vanilla-extract/css only runs at build time. On Node.js 26 the `eval` package that @vanilla-extract/integration
  // evaluates style files with reads every global, localStorage too, which warns (without bundle-lockfile as well)
  { name: 'edge: vanilla-extract virtual CSS (match resource)', fixture: 'edge-vanilla', cmd: 'npm run -s build',
    expectIncludes: ['lodash-es@4.18.1'], expectExcludes: ['@vanilla-extract/webpack-plugin@2.3.27', '@vanilla-extract/css@1.21.2'],
    allowWarnings: [/^ExperimentalWarning: localStorage is not available because --localstorage-file was not provided\.$/] },
  // vendored copies: outside node_modules the innermost package.json of a package npm could have published (a name it
  // accepts, a version, not private, no VS Code extension's) below the first-party boundaries; inside a package, one
  // of another name; a package root without a package.json counts as the package around it. Hand-written: what is
  // listed and how it is keyed (the copy of ms@2.1.3 next to the installed one, the copy inside container)
  { name: 'edge: vendored copies (webpack 5)', fixture: 'edge-vendored', cmd: VENDORED_CMD, expect: VENDORED,
    expectKeys: { 'node_modules/app-lib': 'app-lib@1.0.0', 'node_modules/container': 'container@1.0.0', 'node_modules/container/vendor/inner': 'inner-vendored@2.0.0',
      'node_modules/is-odd': 'is-odd@3.0.1', 'node_modules/left-pad': 'left-pad@1.3.0', 'node_modules/ms': 'ms@2.1.3', 'node_modules/ms@2.1.3': 'ms@2.1.3',
      'node_modules/vscode-languageclient': 'vscode-languageclient@10.1.2' },
    // in any order: the note on a vendored copy, the warning on the package root without a package.json
    expectOutput: /^(?=[\s\S]*note: \S*left-pad is a vendored copy of left-pad@1\.3\.0)(?=[\s\S]*no package\.json with name and version in \S*lib\/esm\/node_modules\/flat - its bundled files are listed as container@1\.0\.0)/ },
  { name: 'edge: vendored copies, BUNDLE_LOCKFILE_FIRST_PARTY=<fixture>/lib/** (an in-repo library)', fixture: 'edge-vendored', cmd: VENDORED_CMD,
    env: { BUNDLE_LOCKFILE_FIRST_PARTY: '{fixture}/lib/**' }, expect: VENDORED.filter(p => p !== 'app-lib@1.0.0') },
  { name: 'edge: vendored copies, BUNDLE_LOCKFILE_FIRST_PARTY=/** (none outside node_modules)', fixture: 'edge-vendored', cmd: VENDORED_CMD,
    env: { BUNDLE_LOCKFILE_FIRST_PARTY: '/**' }, expect: ['container@1.0.0', 'inner-vendored@2.0.0', 'ms@2.1.3'],
    expectKeys: { 'node_modules/container': 'container@1.0.0', 'node_modules/container/vendor/inner': 'inner-vendored@2.0.0', 'node_modules/ms': 'ms@2.1.3' } },
  { name: 'edge: externals are not listed', fixture: 'wp5-npm', cmd: 'npm run -s build', env: { EDGE_EXTERNALS: '1' },
    expect: W5.filter(p => !p.startsWith('lodash-es@')) },
  // webpack's context is a subdirectory: the packages are in ../node_modules, keyed without the ../ (Trivy reads only
  // keys that start with node_modules/)
  { name: 'edge: context below the project root', fixture: 'edge-context', cmd: 'npm run -s build', expect: ['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3'],
    expectKeys: { 'node_modules/debug': 'debug@2.6.9', 'node_modules/debug/node_modules/ms': 'ms@2.0.0', 'node_modules/ms': 'ms@2.1.3' } },
  // export dir: a copy of every lockfile outside the output (go:embed, jars, copies that drop it), optionally only there
  { name: 'export: BUNDLE_LOCKFILE_EXPORT_DIR and the inline lockfile', fixture: 'wp5-npm', cmd: 'npm run -s build', exportDir: true, expect: W5 },
  { name: 'export: BUNDLE_LOCKFILE_EXPORT_DIR only (BUNDLE_LOCKFILE_INLINE=0)', fixture: 'wp5-npm', cmd: 'npm run -s build', exportOnly: true, expect: W5 },
  // BUNDLE_LOCKFILE_TREE (src/core/tree.cjs): a package.json per entry next to each lockfile, which image scans read
  // (syft's image catalogers, trivy rootfs) - the same packages, each once; the runner checks the tree and both scans
  ...[['webpack 5.111.1', 'wp5-npm', 'npm run -s build', W5, {}], ['rspack 2.2.8', 'rspack2.2-npm', 'npm run -s build', W5, {}],
    ['Vite 8.3.3', 'vite8-npm', 'npm run -s build', VITE_EXPECT, { oracleMissing: ['normalize.css@8.0.1'] }],
    ['Rollup 4 command line', 'rollup-cli', 'npm run -s build', ['lodash-es@4.18.1', 'nanoid@3.3.20'], {}]].map(([what, fixture, cmd, expect, more]) => (
    { name: `tree: BUNDLE_LOCKFILE_TREE=on, ${what}`, fixture, cmd, env: { BUNDLE_LOCKFILE_TREE: 'on' }, expect, ...more })),
  { name: 'tree: BUNDLE_LOCKFILE_TREE=on, watch mode: the tree follows every rebuild', fixture: 'wp5-npm', cmd: `${WATCH} src/index.js "import('nanoid')"`,
    env: { BUNDLE_LOCKFILE_TREE: 'on' }, expect: W5, watchBuilds: [W5, W5.filter(p => !p.startsWith('nanoid@')), W5] },
  { name: 'tree: BUNDLE_LOCKFILE_TREE=on, two webpack processes, one output dir, in parallel', fixture: 'edge-shared-output', cmd: PARALLEL,
    env: { BUNDLE_LOCKFILE_TREE: 'on' }, expect: ['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3'] },
  { name: 'tree: BUNDLE_LOCKFILE_TREE=on with BUNDLE_LOCKFILE_EXPORT_DIR: the tree in the export directory too', fixture: 'wp5-npm', cmd: 'npm run -s build',
    env: { BUNDLE_LOCKFILE_TREE: 'on' }, exportDir: true, expect: W5 },
  // only: no package-lock.json (directory scans read nothing), the record in record.json; image scans read the tree
  { name: 'tree: BUNDLE_LOCKFILE_TREE=only, webpack 5.111.1', fixture: 'wp5-npm', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_TREE: 'only' },
    lockfile: 'bundle-lockfile/record.json', expect: W5 },
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
  // strict mode (the default): what would leave the lockfile missing or incomplete fails the build, with the reason;
  // with BUNDLE_LOCKFILE_STRICT=0 the build succeeds without it and a warning says why (see core/problems.cjs)
  { name: 'strict: failing adapter fails the build (webpack 5)', fixture: 'wp5-npm', cmd: 'npm run -s build', nodeOptions: FAULT,
    expectError: /bundle-lockfile: the lockfile would be missing or incomplete[\s\S]*webpack: could not collect the packages of \S*dist: injected fault/ },
  { name: 'STRICT=0: failing adapter does not break the build (webpack 5)', fixture: 'wp5-npm', cmd: 'npm run -s build', nodeOptions: FAULT, env: { BUNDLE_LOCKFILE_STRICT: '0' },
    expect: null, expectOutput: /\[bundle-lockfile\] WARNING: webpack: could not collect the packages of \S*dist: Error: injected fault/ },
  // the same for the Rollup adapter, in each kind of build it hooks
  ...[['Vite 8.3.3', 'vite8-npm', 'npm run -s build', 'vite'], ['Vite 7.3.7', 'vite7-npm', 'npm run -s build', 'vite'],
    ['Rollup 4 command line', 'rollup-cli', 'npm run -s build', 'rollup'], ['Rollup 4 JavaScript API', 'rollup-api', 'node build.mjs rollup', 'rollup'],
    ['Rolldown 1 JavaScript API', 'rollup-api', 'node build.mjs rolldown', 'rolldown'], ['esbuild 0.28.2 build()', 'esbuild', 'node build.mjs build', 'esbuild'],
    ['esbuild 0.28.2 context()', 'esbuild', 'node build.mjs context', 'esbuild'], ['esbuild 0.28.2 buildSync()', 'esbuild', 'node build.mjs sync', 'esbuild']].flatMap(([what, fixture, cmd, kind]) => [
    { name: `strict: failing adapter fails the build (${what})`, fixture, cmd, nodeOptions: FAULT,
      // (Vite 8 fails already when it bundles its config with Rolldown: a build that writes nothing itself)
      expectError: new RegExp(`bundle-lockfile: the lockfile would be missing or incomplete[\\s\\S]*${kind}: could not collect the bundled packages of .+: injected fault`) },
    { name: `STRICT=0: failing adapter does not break the build (${what})`, fixture, cmd, nodeOptions: FAULT, env: { BUNDLE_LOCKFILE_STRICT: '0' }, expect: null,
      expectOutput: new RegExp(`\\[bundle-lockfile\\] WARNING: ${kind}: could not collect the bundled packages`) }]),
  // a lockfile that cannot be written: a file is where its directory must go (main.js / index.html, the build's own)
  ...[['webpack 5', 'wp5-npm', 'main.js', 'webpack'], ['Vite 8.3.3', 'vite8-npm', 'index.html', 'vite'], ['Rollup 4 command line', 'rollup-cli', 'main.js', 'rollup']]
    .flatMap(([what, fixture, file, kind]) => [
      { name: `strict: a lockfile that cannot be written fails the build (${what})`, fixture, cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_FILE: `${file}/package-lock.json` },
        expectError: new RegExp(`bundle-lockfile: the lockfile would be missing or incomplete[\\s\\S]*${kind}: could not write \\S*dist/${file.replace('.', '\\.')}/package-lock\\.json`) },
      { name: `STRICT=0: a lockfile that cannot be written is a warning (${what})`, fixture, cmd: 'npm run -s build',
        env: { BUNDLE_LOCKFILE_FILE: `${file}/package-lock.json`, BUNDLE_LOCKFILE_STRICT: '0' }, lockfile: `${file}/package-lock.json`, expect: null,
        expectOutput: new RegExp(`\\[bundle-lockfile\\] WARNING: ${kind}: could not write`) }]),
  // an export directory that cannot be written (a file); the inline lockfile is written, the export copy not
  { name: 'strict: an export directory that cannot be written fails the build', fixture: 'wp5-npm', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_EXPORT_DIR: '{fixture}/package.json' },
    expectError: /bundle-lockfile: the lockfile would be missing or incomplete[\s\S]*webpack: could not write \S*bundle-lockfile\/package-lock\.json/ },
  { name: 'STRICT=0: an export directory that cannot be written is a warning', fixture: 'wp5-npm', cmd: 'npm run -s build',
    env: { BUNDLE_LOCKFILE_EXPORT_DIR: '{fixture}/package.json', BUNDLE_LOCKFILE_STRICT: '0' }, expect: W5, expectOutput: /\[bundle-lockfile\] WARNING: webpack: could not write/ },
  // settings that are set but not recognized (a misspelled name, a value bundle-lockfile does not know) or cannot work:
  // the build would not do what was asked of it
  ...[['webpack 5', 'wp5-npm'], ['Vite 8.3.3', 'vite8-npm'], ['rspack 2.2.8', 'rspack2.2-npm']].flatMap(([what, fixture]) => [
    { name: `strict: a misspelled setting fails the build (${what})`, fixture, cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_EXPORTDIR: '{fixture}/.export' },
      expectError: /BUNDLE_LOCKFILE_EXPORTDIR is set, but is no setting of bundle-lockfile/ },
    { name: `strict: a value that is not recognized fails the build (${what})`, fixture, cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_DISABLE: 'rsbuild' },
      expectError: /BUNDLE_LOCKFILE_DISABLE names rsbuild, which is none of webpack, rspack, vite, rollup, rolldown, esbuild, parcel, angular, next or all/ }]),
  ...[['webpack 5', 'wp5-npm'], ['rspack 2.2.8', 'rspack2.2-npm']].map(([what, fixture]) => (
    { name: `STRICT=0: a misspelled setting is a warning (${what})`, fixture, cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_EXPORTDIR: '{fixture}/.export', BUNDLE_LOCKFILE_STRICT: '0' },
      expect: W5, expectOutput: /\[bundle-lockfile\] WARNING: BUNDLE_LOCKFILE_EXPORTDIR is set, but is no setting of bundle-lockfile/ })),
  // nowhere to write: BUNDLE_LOCKFILE_INLINE=0 without BUNDLE_LOCKFILE_EXPORT_DIR
  ...[['webpack 5', 'wp5-npm'], ['Vite 8.3.3', 'vite8-npm']].flatMap(([what, fixture]) => [
    { name: `strict: INLINE=0 without an export directory fails the build (${what})`, fixture, cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_INLINE: '0' },
      expectError: /bundle-lockfile: the lockfile would be missing or incomplete[\s\S]*BUNDLE_LOCKFILE_INLINE is off and BUNDLE_LOCKFILE_EXPORT_DIR is not set/ },
    { name: `STRICT=0: INLINE=0 without an export directory is a warning (${what})`, fixture, cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_INLINE: '0', BUNDLE_LOCKFILE_STRICT: '0' },
      expect: null, expectOutput: /\[bundle-lockfile\] WARNING: BUNDLE_LOCKFILE_INLINE is off and BUNDLE_LOCKFILE_EXPORT_DIR is not set/ }]),
  // a bundled package without a package.json and no package around it (node_modules/naked, made by the case): it
  // cannot be listed. No oracle: it names packages by their package.json too, and finds none for naked
  { name: 'strict: a bundled package that cannot be listed fails the build', fixture: 'wp5-npm', env: { EDGE_NAKED: '1' }, cmd: NAKED,
    expectError: /bundle-lockfile: the lockfile would be missing or incomplete[\s\S]*no package\.json with name and version in \S*node_modules\/naked - its bundled files are not listed/ },
  { name: 'STRICT=0: a bundled package that cannot be listed is a warning', fixture: 'wp5-npm', env: { EDGE_NAKED: '1', BUNDLE_LOCKFILE_STRICT: '0' }, cmd: NAKED,
    expect: W5, expectOutput: /\[bundle-lockfile\] WARNING: no package\.json with name and version in \S*node_modules\/naked - its bundled files are not listed/, oracle: false },
  // Vite (rolldown: 8, rollup: 7). The oracle reads Vite's source maps, which do not cover CSS-only packages
  { name: 'Vite 8.3.3 (rolldown)', fixture: 'vite8-npm', cmd: 'npm run -s build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 7.3.7 (rollup)', fixture: 'vite7-npm', cmd: 'npm run -s build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 8.3.3, pnpm 10', fixture: 'vite8-pnpm10', cmd: '$PNPM run build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 8.3.3, pnpm 9', fixture: 'vite8-pnpm9', cmd: '$PNPM run build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 8.3.3, pnpm 11', fixture: 'vite8-pnpm11', cmd: '$PNPM run build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  // packages outside the project (pnpm's global virtual store, Yarn's global cache): keys without the machine-specific path
  { name: 'Vite 8.3.3, pnpm 10 global virtual store', outside: 'pnpm\'s global virtual store, outside the project', fixture: 'vite8-pnpm10-global-store', cmd: '$PNPM run build', expect: VITE_EXPECT,
    expectKeys: OUTSIDE_KEYS_VITE, oracleMissing: ['normalize.css@8.0.1'] },
  { name: "Vite 8.3.3, yarn 4.18.1 Plug'n'Play, global cache", outside: 'Yarn\'s global cache, outside the project', fixture: 'vite8-yarn4-pnp-global-cache', cmd: 'yarn build', expect: VITE_EXPECT,
    expectKeys: OUTSIDE_KEYS_VITE, oracleMissing: ['normalize.css@8.0.1'] },
  // a monorepo's app built in its directory: the packages are in the root's node_modules, keyed without the ../../
  { name: 'Vite 8.3.3, an app of an npm workspaces monorepo', fixture: 'vite-monorepo', cmd: 'npm run -s build -w packages/app', outDir: 'packages/app/dist',
    oracleArgs: 'packages/app', expect: ['debug@2.6.9', 'lodash-es@4.18.1', 'ms@2.0.0'],
    expectKeys: { 'node_modules/debug': 'debug@2.6.9', 'node_modules/debug/node_modules/ms': 'ms@2.0.0', 'node_modules/lodash-es': 'lodash-es@4.18.1' } },
  // two vite build processes, one after the other, into the app's dist/: each keeps the other's packages, which it
  // knows only from the lockfile's record, at their locations there ("locations": the keys are without ../../); the
  // packages of both (debug and its nested ms) are listed once
  { name: 'Vite 8.3.3, an app of an npm workspaces monorepo: two vite build processes, one output dir, then the first again', fixture: 'vite-monorepo',
    cmd: 'npm run -s build -w packages/app && cd packages/app && ../../node_modules/.bin/vite build --config vite.second.config.mjs && ../../node_modules/.bin/vite build',
    env: { VITE_SHARED: '1' }, outDir: 'packages/app/dist', expect: ['debug@2.6.9', 'lodash-es@4.18.1', 'ms@2.0.0', 'ms@2.1.3'],
    expectKeys: { 'node_modules/debug': 'debug@2.6.9', 'node_modules/debug/node_modules/ms': 'ms@2.0.0', 'node_modules/lodash-es': 'lodash-es@4.18.1',
      'node_modules/ms': 'ms@2.1.3' }, oracle: false },
  { name: 'Vite 8.3.3, npx vite build', fixture: 'vite8-npm', cmd: 'npx vite build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  // the loader-thread hooks, which older Node.js uses (CI's Node 24 would use the in-thread ones)
  { name: 'Vite 8.3.3, loader-thread hooks (BUNDLE_LOCKFILE_ESM_HOOKS=async)', fixture: 'vite8-npm', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_ESM_HOOKS: 'async' },
    expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  // rolldown-vite: its process is a bundler process by the package name rolldown-vite (Node 22: loader-thread hooks)
  { name: 'Vite (rolldown-vite 7.3.1)', fixture: 'vite-rolldown7-npm', cmd: 'npm run -s build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite (rolldown-vite 7.3.1) watch mode: every rebuild writes the lockfile, with the packages of that build', fixture: 'vite-rolldown7-npm',
    cmd: VITE_WATCH, expect: VITE_EXPECT, watchBuilds: VITE_WATCH_BUILDS, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 7.3.7, loader-thread hooks (BUNDLE_LOCKFILE_ESM_HOOKS=async)', fixture: 'vite7-npm', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_ESM_HOOKS: 'async' },
    expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  // @import "tailwindcss": Tailwind's preflight and theme are in dist/assets/*.css (no source map: oracleMissing)
  // Vite's root is web/, the build runs in the project: bootstrap-icons' font (url() in a style sheet) is only an asset
  // named relative to the root; source maps do not show it
  ...[['Vite 8.3.3', 'vite8-root'], ['Vite 7.3.7', 'vite7-root']].map(([what, fixture]) => ({ name: `${what}, root not the working directory: an asset from a package`,
    fixture, cmd: 'npm run -s build', expect: ['bootstrap-icons@1.13.2', 'lodash-es@4.18.1'], oracleMissing: ['bootstrap-icons@1.13.2'] })),
  { name: 'Vite 8.3.3, Tailwind CSS 4 (@tailwindcss/vite)', fixture: 'vite8-tailwind', cmd: 'npm run -s build', expect: ['tailwindcss@4.3.3'],
    oracleMissing: ['tailwindcss@4.3.3'] },
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
  // build modes. build.write false: Vite writes nothing (a tool takes the output from Vite's API), neither does bundle-lockfile
  { name: 'Vite 8.3.3, build.write false (no lockfile)', fixture: 'vite8-npm', cmd: 'npm run -s build', env: { VITE_WRITE_FALSE: '1' }, expect: null },
  // library mode with two formats: two outputs of one build in one directory, one lockfile
  { name: 'Vite 8.3.3, library mode with two formats', fixture: 'vite8-npm', cmd: 'npm run -s build', env: { VITE_LIB: '1' }, expect: VITE_EXPECT,
    oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 7.3.7, library mode with two formats', fixture: 'vite7-npm', cmd: 'npm run -s build', env: { VITE_LIB: '1' }, expect: VITE_EXPECT,
    oracleMissing: ['normalize.css@8.0.1'] },
  // an SSR build keeps the dependencies external (the server loads them from node_modules): none of them is listed;
  // with ssr.noExternal it bundles them. normalize.css is listed although an SSR build emits no CSS (docs/coverage.md:
  // listed although not shipped; a plugin can also put CSS into the JavaScript, so its style modules count)
  { name: 'Vite 8.3.3, SSR build (vite build --ssr): dependencies external', fixture: 'vite8-npm', cmd: './node_modules/.bin/vite build --ssr src/main.js',
    oracleArgs: '--ssr src/main.js', expect: ['normalize.css@8.0.1'], oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 8.3.3, SSR build with ssr.noExternal', fixture: 'vite8-npm', cmd: './node_modules/.bin/vite build --ssr src/main.js', env: { VITE_SSR_NOEXTERNAL: '1' },
    oracleArgs: '--ssr src/main.js', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 7.3.7, SSR build with ssr.noExternal', fixture: 'vite7-npm', cmd: './node_modules/.bin/vite build --ssr src/main.js', env: { VITE_SSR_NOEXTERNAL: '1' },
    oracleArgs: '--ssr src/main.js', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  // vite build --app: one build per environment, each with its lockfile (client: the app; server: the SSR build, its
  // dependencies external). No oracle: it builds one environment into one directory; the cases above compare the
  // same client and SSR builds with it
  ...['8.3.3', '6.4.4'].map(v => ({ name: `Vite ${v}, vite build --app (client and SSR environments)`, fixture: `vite${v[0]}-npm`,
    cmd: './node_modules/.bin/vite build --app', env: { VITE_APP: '1' }, expectIn: { client: VITE_EXPECT, server: ['normalize.css@8.0.1'] }, oracle: false })),
  // a programmatic build from a package without a dependency on Vite (tools/build.mjs): hooked with the in-thread hooks;
  // older Node versions install the loader-thread ones there because the project (the working directory) has Vite
  // installed (CI's Node 22 job; see the unit tests for a project without it)
  { name: `Vite 8.3.3, programmatic build from a package without Vite, in a project with it installed (Node ${process.versions.node}: ${SYNC_HOOKS ? 'in-thread' : 'loader-thread'} hooks)`,
    fixture: 'vite8-npm', cmd: 'node tools/build.mjs', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 8.3.3, programmatic build from a package without Vite, BUNDLE_LOCKFILE_ESM_HOOKS=async', fixture: 'vite8-npm', cmd: 'node tools/build.mjs',
    env: { BUNDLE_LOCKFILE_ESM_HOOKS: 'async' }, expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  // the same build started from outside the project (/): no bundler process by what bundlerProcess sees, so Node.js
  // before 22.22.3 / 24.11.1 installs no ESM hooks - the safety net (hooks.cjs companion) fails the build instead of a silent miss
  ...[['8.3.3', 'vite8-npm', 'rolldown'], ['7.3.7', 'vite7-npm', 'rollup']].map(([v, fixture, inner]) => ({
    name: `Vite ${v}, programmatic build started outside the project (Node ${process.versions.node}: ${SYNC_HOOKS ? 'in-thread hooks' : 'no ESM hooks, fails'})`,
    fixture, cmd: 'D=$PWD && cd / && node "$D/tools/build.mjs"',
    ...(SYNC_HOOKS ? { expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] }
      : { expectError: new RegExp(`${inner} is loaded as an ES module in a process without bundle-lockfile's ESM hooks .*set BUNDLE_LOCKFILE_ESM_HOOKS=async`) }) })),
  { name: 'Vite 8.3.3, BUNDLE_LOCKFILE_DISABLE=vite', fixture: 'vite8-npm', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_DISABLE: 'vite' }, expect: null },
  // disabling the bundlers Vite builds with does not disable Vite's builds
  { name: 'Vite 8.3.3, BUNDLE_LOCKFILE_DISABLE=rollup,rolldown: still hooked', fixture: 'vite8-npm', cmd: 'npm run -s build',
    env: { BUNDLE_LOCKFILE_DISABLE: 'rollup,rolldown' }, expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 8.3.3, BUNDLE_LOCKFILE_FILE=sbom/package-lock.json', fixture: 'vite8-npm', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_FILE: 'sbom/package-lock.json' },
    lockfile: 'sbom/package-lock.json', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 8.3.3, export dir only', fixture: 'vite8-npm', cmd: 'npm run -s build', exportOnly: true, expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  // workers, CSS @import, legacy polyfills, workbox's sw.js (written after the build), static copy from node_modules
  { name: 'Vite 8.3.3: workers, CSS, Sass and Less @imports, plugin-legacy, vite-plugin-pwa, static copy', fixture: 'vite8-features', cmd: 'npm run -s build',
    expect: FEATURES_EXPECT, oracleMissing: FEATURES_MISSING },
  { name: 'Vite 7.3.7: workers, CSS, Sass and Less @imports, plugin-legacy, vite-plugin-pwa, static copy', fixture: 'vite7-features', cmd: 'npm run -s build',
    expect: FEATURES_EXPECT, oracleMissing: FEATURES_MISSING },
  // vite-plugin-pwa's injectManifest: the service worker (src/sw.js) is a nested Vite build that writes dist/sw.js
  ...['8.3.3', '7.3.7'].map(v => ({ name: `Vite ${v}: vite-plugin-pwa injectManifest (the service worker a nested Vite build)`, fixture: `vite${v[0]}-features`,
    cmd: 'npm run -s build', env: { PWA_INJECT: '1' }, expect: FEATURES_EXPECT, oracleMissing: FEATURES_MISSING })),
  { name: 'Vite 7.3.7 features, loader-thread hooks (BUNDLE_LOCKFILE_ESM_HOOKS=async)', fixture: 'vite7-features', cmd: 'npm run -s build',
    env: { BUNDLE_LOCKFILE_ESM_HOOKS: 'async' }, expect: FEATURES_EXPECT, oracleMissing: FEATURES_MISSING },
  // bundle-lockfile's plugin in the Vite config and NODE_OPTIONS: the preload adds no second plugin, and hands the
  // configured one the build rolldown() returns, which alone has the style sheets @imported from packages (Vite 8)
  ...['8.3.3', '7.3.7'].map(v => ({ name: `Vite ${v} features, plugin in the config and NODE_OPTIONS`, fixture: `vite${v[0]}-features`,
    cmd: 'npm run -s build', env: { VITE_PLUGIN: path.join(__dirname, '../src/adapters/rollup.cjs') }, expect: FEATURES_EXPECT, oracleMissing: FEATURES_MISSING })),
  // the plugin in the config without NODE_OPTIONS: it adds itself to worker.plugins, with which Vite bundles the
  // workers (nanoid; is-number inlined; the worker's font, bootstrap-icons, which the app's build emits again). The
  // static copy keeps its path (vendor/node_modules/normalize.css/normalize.css): found as a file written after the
  // build. The style sheets @imported from packages: Rollup's watch files (Vite 7), Rolldown's plugin contexts (Vite 8,
  // which gives them to the caller of rolldown() only). Not reached without the preload: workbox-build's service
  // worker (a build with plugins of its own), and on Vite 8 plugin-legacy's polyfills (their chunk, which it puts into
  // the bundle, is no chunk of this build there). On Vite 7 the polyfills' chunk (core-js, systemjs) is this build's.
  // Checked in the output (2026-10-13): each package's code or file is where its list says. The oracle sees all of
  // them, so it is not compared
  { name: 'Vite 8.3.3 features, plugin in the config (no NODE_OPTIONS)', fixture: 'vite8-features', cmd: 'npm run -s build', inject: false,
    env: { VITE_PLUGIN: path.join(__dirname, '../src/adapters/rollup.cjs') },
    expect: ['bootstrap-icons@1.13.2', 'bulma@1.0.4', 'is-number@7.0.0', 'lodash-es@4.18.1', 'nanoid@3.3.20', 'normalize.css@8.0.1', 'normalize.less@1.0.0', 'sanitize.css@13.0.0'], oracle: false },
  { name: 'Vite 7.3.7 features, plugin in the config (no NODE_OPTIONS)', fixture: 'vite7-features', cmd: 'npm run -s build', inject: false,
    env: { VITE_PLUGIN: path.join(__dirname, '../src/adapters/rollup.cjs') },
    expect: FEATURES_EXPECT.filter(p => !p.startsWith('workbox-')), oracle: false },
  { name: 'Rollup 4 command line (rollup -c)', fixture: 'rollup-cli', cmd: 'npm run -s build', expect: ['lodash-es@4.18.1', 'nanoid@3.3.20'] },
  { name: "Rollup 4 command line (rollup -c), yarn 4.18.1 Plug'n'Play", fixture: 'rollup-cli-yarn4-pnp', cmd: 'yarn build', expect: ROLLUP_API },
  { name: 'Rollup 4 command line (rollup -c), yarn 4.18.1 pnpm linker', fixture: 'rollup-cli-yarn4-pnpm', cmd: 'yarn build', expect: ROLLUP_API },
  // two configs of one input, each its own output.file in dist/: the bundle (lodash-es and nanoid inside), and the build
  // with them external (none). No oracle: its --dir cannot take configs with output.file; the packages are the same
  // ones as in the cases above (the same src/main.js, bundled)
  { name: 'Rollup 4 command line: two configs of one input, each with its own output.file in dist/', fixture: 'rollup-cli',
    cmd: './node_modules/.bin/rollup -c two.config.mjs', expect: ROLLUP_API, oracle: false },
  // BUNDLE_LOCKFILE_FILE=package-lock.json and output.file in the project's directory: the project's package-lock.json is
  // not replaced, and the build fails for it
  { name: 'Rollup 4 command line: BUNDLE_LOCKFILE_FILE=package-lock.json in the project\'s directory never replaces its own lockfile', fixture: 'rollup-cli',
    cmd: 'cp package-lock.json .project-lock.json && ./node_modules/.bin/rollup -c root.config.mjs; s=$?; cmp package-lock.json .project-lock.json && exit $s',
    env: { BUNDLE_LOCKFILE_FILE: 'package-lock.json' }, expectError: /package-lock\.json is there and was not written by bundle-lockfile/ },
  { name: 'Rollup 4 command line, watch mode (rollup -c -w): every rebuild writes the lockfile, with the packages of that build', fixture: 'rollup-cli',
    cmd: `${ROLLUP_CLI_WATCH} nanoid`, expect: ROLLUP_API, watchBuilds: ROLLUP_WATCH_BUILDS },
  // the command line bundles a TypeScript config first, with a build that only generates: no lockfile of its own
  { name: 'Rollup 4 command line, rollup.config.ts (--configPlugin typescript)', fixture: 'rollup-cli',
    cmd: './node_modules/.bin/rollup -c rollup.config.ts --configPlugin typescript', expect: ROLLUP_API },
  // installers (yarn Plug'n'Play: Yarn's own loader-thread hook next to bundle-lockfile's ESM hooks)
  // a build in a worker thread: the worker installs its own ESM hooks (older Node.js: its own loader thread)
  { name: 'Vite 8.3.3, vite build in a worker thread', fixture: 'vite8-npm', cmd: VITE_WORKER, expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 7.3.7, vite build in a worker thread', fixture: 'vite7-npm', cmd: VITE_WORKER, expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 8.3.3, vite build in a worker thread, loader-thread hooks (BUNDLE_LOCKFILE_ESM_HOOKS=async)', fixture: 'vite8-npm', cmd: VITE_WORKER,
    env: { BUNDLE_LOCKFILE_ESM_HOOKS: 'async' }, expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 8.3.3, yarn 1', fixture: 'vite8-yarn1', cmd: 'yarn --offline -s build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: "Vite 8.3.3, yarn 4.18.1 Plug'n'Play", fixture: 'vite8-yarn4-pnp', cmd: 'yarn build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  // the packages are in .yarn/cache/<zip>/node_modules/, not at their keys: a process that writes after the other one
  // knows the other's packages only from the record's "locations"
  { name: "Vite 8.3.3, yarn 4.18.1 Plug'n'Play: two vite build processes, one output dir, then the first again", fixture: 'vite8-yarn4-pnp',
    cmd: 'yarn vite build && yarn vite build --config vite.second.config.mjs && yarn vite build', env: { VITE_SHARED: '1' }, expect: VITE_BOTH,
    expectKeys: { 'node_modules/debug': 'debug@2.6.9', 'node_modules/is-number': 'is-number@7.0.0', 'node_modules/lodash-es': 'lodash-es@4.18.1',
      'node_modules/ms': 'ms@2.0.0', 'node_modules/ms@2.1.3': 'ms@2.1.3', 'node_modules/normalize.css': 'normalize.css@8.0.1' }, oracle: false },
  { name: "Vite 7.3.7, yarn 4.18.1 Plug'n'Play", fixture: 'vite7-yarn4-pnp', cmd: 'yarn build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 8.3.3, yarn 4.18.1 node-modules linker', fixture: 'vite8-yarn4-node-modules', cmd: 'yarn build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vite 8.3.3, yarn 4.18.1 pnpm linker', fixture: 'vite8-yarn4-pnpm', cmd: 'yarn build', expect: VITE_EXPECT, oracleMissing: ['normalize.css@8.0.1'] },
  // Vite's servers and Vitest ship nothing and write no lockfile (docs/bundlers.md): the dev server's dependency
  // pre-bundling (a Rolldown build on Vite 8), also into a cache directory outside node_modules; vite preview; vitest run
  { name: 'Vite 8.3.3, vite dev: dependency pre-bundling writes no lockfile', fixture: 'vite8-npm', cmd: VITE_SERVERS('dev'), expect: null },
  { name: 'Vite 8.3.3, vite dev with cacheDir outside node_modules: no lockfile', fixture: 'vite8-npm', cmd: VITE_SERVERS('dev'), env: { VITE_CACHE_DIR: '.vite-cache' },
    expect: null },
  { name: 'Vite 8.3.3, vite preview: the build\'s lockfile, nothing more', fixture: 'vite8-npm', cmd: `npm run -s build && ${VITE_SERVERS('preview')}`, expect: VITE_EXPECT,
    oracleMissing: ['normalize.css@8.0.1'] },
  { name: 'Vitest 5 (Vite 8.3.3): no lockfile anywhere in the project', fixture: 'vite8-vitest', cmd: VITEST, expect: null },
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
  // a build writes into a directory holding a copy (cp: not seen by bundle-lockfile) of a deeper output, whose record's
  // context is then above the project: the copy's packages are kept by name and version, keyed as packages whose
  // location is not known, and the lockfile's context is the project's
  { name: 'Vite 8.3.3: a vite build into a copy (cp) of another output', fixture: 'vite8-npm', env: { VITE_SHARED: '1' },
    cmd: `VITE_OUT_DIR=out/deeper/dist ${VITE_BIN} build && cp -r out/deeper/dist dist && ${VITE_BIN} build --config vite.second.config.mjs`,
    expect: VITE_BOTH, expectKeys: { 'node_modules/debug': 'debug@2.6.9', 'node_modules/is-number': 'is-number@7.0.0', 'node_modules/lodash-es': 'lodash-es@4.18.1',
      'node_modules/ms': 'ms@2.0.0', 'node_modules/ms@2.1.3': 'ms@2.1.3', 'node_modules/normalize.css': 'normalize.css@8.0.1' }, outside: 'the copy\'s record (another place than its output) does not know the packages\' locations: unknown', oracle: false },
  { name: 'Vite 7.3.7: two vite build processes, one output dir, then one of them again', fixture: 'vite7-npm', env: { VITE_SHARED: '1' },
    cmd: `${PARALLEL_VITE} && ${VITE_BIN} build --config vite.second.config.mjs`, expect: VITE_BOTH, oracle: false },
  // Rollup's and Rolldown's JavaScript APIs (build.mjs). The oracle is the same build with Rollup's command line and
  // source maps (rollup.config.mjs), also for Rolldown's builds: the same packages
  // esbuild's JavaScript API: every build() and context() gets the plugin; buildSync() its metafile
  ...['build', 'context', 'outfile', 'sync'].map(mode => (
    { name: `esbuild 0.28.2 JavaScript API: ${mode}`, fixture: 'esbuild', cmd: `node build.mjs ${mode}`, expect: ESBUILD, oracleArgs: mode, oracleMissing: ['bootstrap-icons@1.13.2'] })),
  { name: 'esbuild 0.28.2 JavaScript API: context().watch(), every rebuild writes the lockfile, with the packages of that build', fixture: 'esbuild',
    cmd: 'node build.mjs watch', expect: ESBUILD, watchBuilds: [ESBUILD, ESBUILD.filter(p => p !== 'nanoid@3.3.20'), ESBUILD], oracleMissing: ['bootstrap-icons@1.13.2'] },
  { name: 'esbuild 0.28.2: two build()s into one directory, one lockfile with the packages of both', fixture: 'esbuild', cmd: 'node build.mjs two',
    expect: [...ESBUILD, 'is-number@7.0.0'].sort(), oracleArgs: 'two', oracleMissing: ['bootstrap-icons@1.13.2'] },
  { name: 'esbuild 0.28.2: write: false writes no lockfile', fixture: 'esbuild', cmd: 'node build.mjs write-false', expect: null },
  // the command line is esbuild's binary: not hooked; its metafile, read by the importer, gives the lockfile
  { name: 'esbuild 0.28.2 command line: not hooked, no lockfile', fixture: 'esbuild', cmd: ESBUILD_CLI, expect: null },
  { name: 'esbuild 0.28.2 command line, its metafile read by bundle-lockfile-from-metafile', fixture: 'esbuild', cmd: `${ESBUILD_CLI} && ${FROM_METAFILE} meta.json`,
    expect: ESBUILD, oracleMissing: ['bootstrap-icons@1.13.2'] },
  // a style sheet a plugin inlines (esbuild-sass-plugin's watchFiles), a file another plugin's onEnd copies out of a
  // package; the oracle's source maps see neither (the partial is inlined, the copy is none of esbuild's outputs)
  { name: 'esbuild 0.28.2: a Sass partial esbuild-sass-plugin inlines, a package file another plugin copies in onEnd', fixture: 'esbuild-features',
    cmd: 'node build.mjs features', oracleArgs: 'features', expect: ['bulma@1.0.4', 'lodash-es@4.18.1', 'sanitize.css@13.0.0'],
    oracleMissing: ['bulma@1.0.4', 'sanitize.css@13.0.0'], expectVia: { chunk: ['lodash-es@4.18.1'], style: ['bulma@1.0.4'], late: ['sanitize.css@13.0.0'] } },
  { name: 'esbuild 0.28.2: export directory only (an output Go embeds)', fixture: 'esbuild', cmd: 'node build.mjs build', exportOnly: true, expect: ESBUILD,
    oracleMissing: ['bootstrap-icons@1.13.2'] },
  { name: 'esbuild: BUNDLE_LOCKFILE_DISABLE=esbuild', fixture: 'esbuild', cmd: 'node build.mjs build', env: { BUNDLE_LOCKFILE_DISABLE: 'esbuild' }, expect: null },
  // Parcel 2: every Parcel gets the reporter (the command line, the JavaScript API, watch mode); not uuid (unused); the
  // font has no source map (the oracle's)
  // via: the font (a style sheet's url()) is an asset of its own, everything else the modules of the bundles
  { name: 'Parcel 2.16.4: parcel build', fixture: 'parcel', cmd: 'npm run -s build', expect: PARCEL('2.16.4'), oracleMissing: ['bootstrap-icons@1.13.2'],
    expectVia: { chunk: PARCEL('2.16.4').filter(p => p !== 'bootstrap-icons@1.13.2'), asset: ['bootstrap-icons@1.13.2'] } },
  { name: 'Parcel 2.16.4: JavaScript API, run()', fixture: 'parcel', cmd: 'node build.mjs api', expect: PARCEL('2.16.4'), oracleMissing: ['bootstrap-icons@1.13.2'] },
  { name: 'Parcel 2.16.4: JavaScript API, watch(): every rebuild writes the lockfile, with the packages of that build', fixture: 'parcel', cmd: 'node build.mjs watch',
    expect: PARCEL('2.16.4'), watchBuilds: [PARCEL('2.16.4'), PARCEL('2.16.4').filter(p => p !== 'is-number@7.0.0'), PARCEL('2.16.4')],
    oracleMissing: ['bootstrap-icons@1.13.2'] },
  // reporters are no part of Parcel's cache: a build after one without bundle-lockfile (a warm .parcel-cache) writes it
  { name: 'Parcel 2.16.4: a build with a cache from a build without bundle-lockfile', fixture: 'parcel', cmd: 'NODE_OPTIONS= npm run -s build && rm -rf dist && npm run -s build',
    expect: PARCEL('2.16.4'), oracleMissing: ['bootstrap-icons@1.13.2'] },
  { name: 'Parcel 2.16.4: export directory only', fixture: 'parcel', cmd: 'npm run -s build', exportOnly: true, expect: PARCEL('2.16.4'), oracleMissing: ['bootstrap-icons@1.13.2'] },
  { name: 'Parcel: BUNDLE_LOCKFILE_DISABLE=parcel', fixture: 'parcel', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_DISABLE: 'parcel' }, expect: null },
  // a failing adapter (Parcel's command line wraps the lines of an error at the terminal's width: \s+)
  { name: 'strict: failing adapter fails the build (Parcel 2.16.4)', fixture: 'parcel', cmd: 'npm run -s build', nodeOptions: FAULT,
    expectError: /bundle-lockfile: the lockfile would be missing or incomplete[\s\S]*parcel: could not collect the bundled packages of\s+\S+:\s+injected fault/ },
  { name: 'STRICT=0: failing adapter does not break the build (Parcel 2.16.4)', fixture: 'parcel', cmd: 'npm run -s build', nodeOptions: FAULT, env: { BUNDLE_LOCKFILE_STRICT: '0' },
    expect: null, expectOutput: /\[bundle-lockfile\] WARNING: parcel: could not collect the bundled packages/ },
  // (Parcel 2.0.0's own dependencies are ranges, ^2.0.0: its runtime, @parcel/runtime-js, is the latest 2.x)
  ...[['2.0.0 (the first release)', 'parcel-floor', '2.16.4'], ['2.16.4, pnpm 10', 'parcel-pnpm10', '2.16.4'], ['2.16.4, yarn 4 Plug\'n\'Play', 'parcel-yarn4-pnp', '2.16.4']].map(([what, fixture, v]) => (
    { name: `Parcel ${what}: parcel build`, fixture, cmd: fixture.endsWith('pnp') ? 'yarn build' : 'npm run -s build', expect: PARCEL(v), oracleMissing: ['bootstrap-icons@1.13.2'],
      ...(fixture === 'parcel-floor' && { installed: ['@parcel/core@2.0.0'] }) })),
  // Angular's application builder: the lockfile with its output files (dist/browser/), from its final metafile (after
  // its chunk optimizer, which three lazy chunks turn on) and its asset files (bootstrap-icons' font, copied from
  // node_modules: in no source map, the oracle's); not uuid (unused)
  ...[['22.2.2', 'angular22'], ['21.2.26', 'angular21'], ['20.3.39', 'angular20']].map(([v, fixture]) => (
    // via: the asset glob's font copied from node_modules, the rest modules of the chunks (the browser output as outDir:
    // expectVia reads its lockfile)
    { name: `Angular ${v}: ng build`, fixture, cmd: 'npm run -s build', outDir: 'dist/browser', expect: ANGULAR(fixture), oracleArgs: '--browser-as-root',
      oracleMissing: ['bootstrap-icons@1.13.2'], expectVia: { asset: ['bootstrap-icons@1.13.2'], chunk: ANGULAR(fixture).filter(p => p !== 'bootstrap-icons@1.13.2') } })),
  // other package managers: pnpm's isolated layout, Yarn Plug'n'Play's zip cache (Angular's builder, its esbuild and the
  // framework's packages from there). With Plug'n'Play there is no node_modules: the app's asset glob
  // (node_modules/bootstrap-icons/font/fonts) copies nothing, no font is shipped, bootstrap-icons is not listed
  { name: 'Angular 22.2.2, pnpm 10: ng build', fixture: 'angular22-pnpm10', cmd: 'npm run -s build', outDir: 'dist/browser', expect: ANGULAR('angular22-pnpm10'),
    oracleArgs: '--browser-as-root', oracleMissing: ['bootstrap-icons@1.13.2'] },
  { name: 'Angular 22.2.2, yarn 4 Plug\'n\'Play: ng build', fixture: 'angular22-yarn4-pnp', cmd: 'yarn build', outDir: 'dist/browser',
    expect: ANGULAR('angular22-yarn4-pnp').filter(p => p !== 'bootstrap-icons@1.13.2'), oracleArgs: '--browser-as-root' },
  { name: 'Angular 22.2.2: ng build without the chunk optimizer (NG_BUILD_OPTIMIZE_CHUNKS=0)', fixture: 'angular22', cmd: 'npm run -s build',
    env: { NG_BUILD_OPTIMIZE_CHUNKS: '0' }, expectIn: { browser: ANGULAR('angular22') }, oracleMissing: ['bootstrap-icons@1.13.2'] },
  { name: 'Angular 22.2.2: export directory only', fixture: 'angular22', cmd: 'npm run -s build', exportOnly: true, expectIn: { browser: ANGULAR('angular22') },
    oracleMissing: ['bootstrap-icons@1.13.2'] },
  { name: 'Angular: BUNDLE_LOCKFILE_DISABLE=angular', fixture: 'angular22', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_DISABLE: 'angular' }, expect: null },
  // i18n (localize: en-US, de): Angular writes a copy of the output per locale, translations inlined - each gets the
  // lockfile, in dist/browser/<locale>/ (the oracle reads each locale's source maps)
  ...[['22.2.2', 'angular22-i18n'], ['20.3.39', 'angular20-i18n']].map(([v, fixture]) => (
    { name: `Angular ${v}: ng build with i18n, a lockfile in each locale's output`, fixture, cmd: 'npm run -s build', oracleArgs: '--locales de,en-US',
      oracleMissing: ['bootstrap-icons@1.13.2'], expectIncludes: ANGULAR(fixture) })),
  // ng serve: the dev server builds into memory and serves it - no lockfile, served or written, not even an export copy
  ...[['22.2.2', 'angular22'], ['20.3.39', 'angular20']].map(([v, fixture]) => (
    { name: `Angular ${v}: ng serve writes no lockfile`, fixture, cmd: ANGULAR_SERVE, env: { BUNDLE_LOCKFILE_EXPORT_DIR: '/tmp/bl-angular-serve-export' }, expect: null })),
  // ng build --watch: every rebuild writes the lockfile with that build's packages - without the lazy imports' line
  // (nanoid, is-number, debug with its own ms 2.0.0) and with it again
  ...[['22.2.2', 'angular22'], ['20.3.39', 'angular20']].map(([v, fixture]) => (
    { name: `Angular ${v}: ng build --watch, every rebuild writes the lockfile with the packages of that build`, fixture,
      cmd: `${ANGULAR_WATCH} src/app/app.ts "import('nanoid')"`, outDir: 'dist/browser', expect: ANGULAR(fixture), oracleArgs: '--browser-as-root',
      oracleMissing: ['bootstrap-icons@1.13.2'],
      watchBuilds: [ANGULAR(fixture), ANGULAR(fixture).filter(p => !['nanoid@3.3.20', 'is-number@7.0.0', 'debug@2.6.9', 'ms@2.0.0'].includes(p)), ANGULAR(fixture)] })),
  // server-side rendering (outputMode server): a lockfile for each side, dist/browser/ and dist/server/ (the oracle
  // reads each side's source maps: left-pad and bl-canary-used only in the server's). Angular 17 - 21 write one
  // metafile for both sides, keyed by each output's path in its side's directory; 22 one per side. outputMode static
  // only prerenders: Angular writes no server, so there is no server lockfile. On Node.js 26 Angular's prerendering
  // prints DEP0205 itself: its in-memory ESM loader calls module.register() (@angular/build
  // src/utils/server-rendering/esm-in-memory-loader/register-hooks.js; the same without bundle-lockfile)
  ...[['22.2.2', 'angular22-ssr'], ['21.2.26', 'angular21-ssr'], ['20.3.39', 'angular20-ssr']].flatMap(([v, fixture]) => [
    { name: `Angular ${v}: ng build with server-side rendering, a lockfile per side`, fixture, cmd: 'npm run -s build',
      oracleMissingIn: { browser: ['bootstrap-icons@1.13.2'] }, allowWarnings: [MODULE_REGISTER],
      expectIncludes: ['left-pad@1.3.0', `@angular/ssr@${v}`, `@angular/platform-server@${fixtures[fixture].deps['@angular/platform-server']}`, 'bl-canary-used@1.0.0', 'bl-canary-dup@1.0.0', 'bl-canary-dup@2.0.0'],
      expectExcludes: ['bl-canary-unused@1.0.0', 'uuid@9.0.1'] },
    // server-side rendering and i18n: a copy of each side's output per locale, dist/browser/<locale>/ and
    // dist/server/<locale>/, each with its lockfile; the server's entry (server.mjs, with left-pad and bl-canary-used)
    // and its chunks Angular writes once, in dist/server/: their own lockfile there
    ...(v === '21.2.26' ? [] : [{ name: `Angular ${v}: ng build with server-side rendering and i18n, a lockfile per side and locale`, fixture,
      cmd: 'npm run -s build -- --configuration production,i18n', oracleArgs: '--configuration i18n --locales de,en-US',
      oracleMissingIn: { 'browser/de': ['bootstrap-icons@1.13.2'], 'browser/en-US': ['bootstrap-icons@1.13.2'] }, allowWarnings: [MODULE_REGISTER],
      expectIncludes: ['left-pad@1.3.0', `@angular/ssr@${v}`, 'bl-canary-used@1.0.0', 'bl-canary-dup@1.0.0', 'bl-canary-dup@2.0.0'],
      expectExcludes: ['bl-canary-unused@1.0.0', 'uuid@9.0.1'] }]),
    { name: `Angular ${v}: ng build, server-side rendering with outputMode static (no server written, no server lockfile)`, fixture,
      cmd: 'npm run -s build -- --configuration production,static', oracleArgs: '--configuration static', oracleMissingIn: { browser: ['bootstrap-icons@1.13.2'] },
      allowWarnings: [MODULE_REGISTER],
      expectExcludes: ['left-pad@1.3.0', 'bl-canary-used@1.0.0', 'bl-canary-unused@1.0.0', 'bl-canary-dup@1.0.0'] },
  ]),
  { name: 'esbuild-wasm 0.28.2: build()', fixture: 'esbuild-wasm', cmd: 'node build.mjs build', env: { BLTEST_ESBUILD_PKG: 'esbuild-wasm' }, expect: ESBUILD,
    oracleMissing: ['bootstrap-icons@1.13.2'] },
  ...[['0.19.12 (Vite 5\'s)', 'esbuild-0.19'], ['0.17.0 (the oldest supported)', 'esbuild-floor'], ['0.28.2, pnpm 10', 'esbuild-pnpm10'], ['0.28.2, yarn 4 Plug\'n\'Play', 'esbuild-yarn4-pnp']].map(([what, fixture]) => (
    { name: `esbuild ${what}: build()`, fixture, cmd: fixture.endsWith('pnp') ? 'yarn build' : 'node build.mjs build', expect: ESBUILD, oracleMissing: ['bootstrap-icons@1.13.2'] })),
  { name: 'esbuild 0.16.17 (before context()): a build fails instead of writing no lockfile', fixture: 'esbuild-0.16', cmd: 'node build.mjs build',
    expectError: /bundle-lockfile needs esbuild 0\.17 or later/ },
  { name: 'esbuild 0.16.17, BUNDLE_LOCKFILE_STRICT=0: a warning, no lockfile', fixture: 'esbuild-0.16', cmd: 'node build.mjs build', env: { BUNDLE_LOCKFILE_STRICT: '0' },
    expect: null, expectOutput: /WARNING: esbuild 0\.16\.17: bundle-lockfile needs esbuild 0\.17 or later/ },
  { name: 'Rollup 4 JavaScript API: rollup()', fixture: 'rollup-api', cmd: 'node build.mjs rollup', expect: ROLLUP_API },
  // Rollup's WebAssembly build: its ES entry (JavaScript API) and its CommonJS build (command line) are hooked too
  { name: 'Rollup 4 (@rollup/wasm-node) JavaScript API: rollup()', fixture: 'rollup-api', cmd: 'node build.mjs rollup-wasm', expect: ROLLUP_API },
  { name: 'Rollup 4 (@rollup/wasm-node) command line', fixture: 'rollup-api', cmd: 'node node_modules/@rollup/wasm-node/dist/bin/rollup -c', expect: ROLLUP_API },
  // the oldest Rollup 4 and Rolldown 1 releases
  ...[['Rollup 4.0.2 JavaScript API: rollup()', 'rollup'], ['Rollup 4.0.2 JavaScript API: watch(), every rebuild writes the lockfile', 'rollup-watch'],
    ['Rolldown 1.0.0 JavaScript API: rolldown()', 'rolldown'], ['Rolldown 1.0.0 JavaScript API: build()', 'rolldown-build'],
    ['Rolldown 1.0.0 JavaScript API: watch(), every rebuild writes the lockfile', 'rolldown-watch']].map(([name, mode]) => (
    { name, fixture: 'rollup-api-floor', cmd: `node build.mjs ${mode}`, expect: ROLLUP_API, ...(mode.endsWith('watch') && { watchBuilds: ROLLUP_WATCH_BUILDS }) })),
  { name: 'Rollup 4.0.2 command line (rollup -c)', fixture: 'rollup-api-floor', cmd: './node_modules/.bin/rollup -c', expect: ROLLUP_API },
  { name: 'Rollup 4 JavaScript API: watch(), every rebuild writes the lockfile, with the packages of that build', fixture: 'rollup-api', cmd: 'node build.mjs rollup-watch',
    expect: ROLLUP_API, watchBuilds: ROLLUP_WATCH_BUILDS },
  { name: 'Rolldown 1 JavaScript API: rolldown()', fixture: 'rollup-api', cmd: 'node build.mjs rolldown', expect: ROLLUP_API },
  { name: 'Rolldown 1 JavaScript API: build()', fixture: 'rollup-api', cmd: 'node build.mjs rolldown-build', expect: ROLLUP_API },
  { name: 'Rolldown 1 JavaScript API: write() without dir or file (dist/)', fixture: 'rollup-api', cmd: 'node build.mjs rolldown-nodir', expect: ROLLUP_API },
  // two write()s of one build (Rolldown runs buildStart for each), then a file copied into the first output before
  // close(): found there (normalize.css; copied, so not in the source maps: oracleMissingIn)
  { name: 'Rolldown 1 JavaScript API: two write()s of one build, a package file copied into the first output before close()', fixture: 'rollup-api',
    cmd: 'node build.mjs rolldown-writes', expectIn: { '': [...ROLLUP_API, 'normalize.css@8.0.1'].sort(), cjs: ROLLUP_API }, oracle: false },
  ...[['Rollup 4', 'rollup'], ['Rolldown 1', 'rolldown']].map(([what, mode]) => (
    { name: `${what} JavaScript API in a directory with "#" in its name`, fixture: 'rollup-api-c#', cmd: `node build.mjs ${mode}`, expect: ROLLUP_API })),
  // two outputs written at the same time into one directory, in one format: each a writer with its own files and hashes
  { name: 'Rollup 4 JavaScript API: two outputs into one directory at the same time', fixture: 'rollup-api', cmd: 'node build.mjs rollup-outputs', expect: ROLLUP_API },
  { name: 'Rolldown 1 JavaScript API: two outputs into one directory at the same time', fixture: 'rollup-api', cmd: 'node build.mjs rolldown-outputs', expect: ROLLUP_API },
  // the plugin in the build's options, no NODE_OPTIONS: two builds of different inputs into one directory, both kept
  ...[['Rollup 4', 'rollup'], ['Rolldown 1', 'rolldown']].map(([what, mode]) => ({ name: `${what} JavaScript API, plugin in the options (no NODE_OPTIONS): two builds into one directory`,
    fixture: 'rollup-api', cmd: `node build.mjs ${mode}-plugin`, inject: false, env: { BLTEST_PLUGIN: path.join(__dirname, '../src/adapters/rollup.cjs') }, expect: ROLLUP_API })),
  { name: 'Rolldown 1 JavaScript API: watch(), every rebuild writes the lockfile, with the packages of that build', fixture: 'rollup-api', cmd: 'node build.mjs rolldown-watch',
    expect: ROLLUP_API, watchBuilds: ROLLUP_WATCH_BUILDS },
  { name: 'Rollup 4 JavaScript API, BUNDLE_LOCKFILE_DISABLE=rollup', fixture: 'rollup-api', cmd: 'node build.mjs rollup', env: { BUNDLE_LOCKFILE_DISABLE: 'rollup' }, expect: null },
  { name: 'Rolldown 1 JavaScript API, BUNDLE_LOCKFILE_DISABLE=rolldown', fixture: 'rollup-api', cmd: 'node build.mjs rolldown', env: { BUNDLE_LOCKFILE_DISABLE: 'rolldown' }, expect: null },
  // the other kinds stay hooked
  { name: 'Rollup 4 JavaScript API, BUNDLE_LOCKFILE_DISABLE=vite,rolldown: still hooked', fixture: 'rollup-api', cmd: 'node build.mjs rollup',
    env: { BUNDLE_LOCKFILE_DISABLE: 'vite,rolldown' }, expect: ROLLUP_API },
  { name: 'Rolldown 1 JavaScript API, BUNDLE_LOCKFILE_DISABLE=vite,rollup,webpack: still hooked', fixture: 'rollup-api', cmd: 'node build.mjs rolldown',
    env: { BUNDLE_LOCKFILE_DISABLE: 'vite,rollup,webpack' }, expect: ROLLUP_API },
  // the rolldown command line imports Rolldown's internal chunk, not its entry module, which the hooks wrap: it is
  // recognized, and fails (strict); STRICT=0: no lockfile
  { name: 'Rolldown 1 command line (unsupported: fails)', fixture: 'rollup-api', cmd: './node_modules/.bin/rolldown src/main.js -d dist -p browser',
    expectError: /the rolldown command line is not hooked: its builds write no lockfile/ },
  { name: 'Rolldown 1 command line, BUNDLE_LOCKFILE_STRICT=0 (unsupported: no lockfile)', fixture: 'rollup-api', cmd: './node_modules/.bin/rolldown src/main.js -d dist -p browser',
    env: { BUNDLE_LOCKFILE_STRICT: '0' }, expect: null },
  // nested: webpack's lockfile has the island's packages, found by the island's output hash in its lockfile
  { name: 'nested: Vite 8 island bundled by webpack 5', fixture: 'nested-island-wp5', cmd: 'npm run -s build', expect: NESTED_EXPECT },
  // the island's main.js changed after its build (a post-processing step): its record still names it by path, so its
  // packages are listed, with a warning
  { name: 'nested: Vite 8 island post-processed after its build, bundled by webpack 5', fixture: 'nested-island-wp5',
    cmd: "./node_modules/.bin/vite build --config island/vite.config.mjs && printf '/* post-processed */\\n' >> island/dist/main.js && ./node_modules/.bin/webpack --config webpack.config.js",
    expect: NESTED_EXPECT, expectOutput: /WARNING: \S*island\/dist\/main\.js changed after the build that wrote it into \S*island\/dist: listed with that build's packages/ },
  { name: 'nested: Vite 8 island bundled by webpack 4', fixture: 'nested-island-wp4', cmd: 'npm run -s build', nodeOptions: LEGACY_SSL,
    expectIncludes: NESTED_EXPECT },
  { name: 'nested: Vite 8 island bundled by Vite 8', fixture: 'nested-island-vite', cmd: 'npm run -s build', oracleArgs: 'vite', expect: NESTED_EXPECT },
  { name: 'nested: Rollup island (rollup -c) bundled by Vite 7', fixture: 'nested-island-rollup', cmd: 'npm run -s build', oracleArgs: 'rollup', expect: NESTED_EXPECT },
  { name: 'nested: Vite 7 island bundled by webpack 5', fixture: 'nested-island-vite7-wp5', cmd: 'npm run -s build', expect: NESTED_EXPECT },
  { name: "nested: island built by Rolldown's API, bundled by webpack 5", fixture: 'nested-island-rolldown-wp5', cmd: 'npm run -s build',
    oracleArgs: 'rolldown', expect: NESTED_EXPECT },
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
  // Nuxt: the shipped client is .output/public (Nitro's copies of .nuxt/dist/client/_nuxt/): it gets a copy of the
  // client's lockfile (core/outputs.cjs outputCopy); the server's is in .output/server. No oracle: Nitro bundles the
  // server again with Rollup (its own build, hooked too), Nuxt's client build is Vite's
  ...[['nuxt build', '$PNPM run build'], ['nuxi build (nuxi names no bundler: a bundler process by pnpm\'s hidden node_modules)', '$PNPM exec nuxi build']].map(([what, cmd]) => ({
    name: `Nuxt 4.6.1, pnpm 10: ${what}`, fixture: 'nuxt4-pnpm10', outDir: '.output', oracle: false,
    cmd: `${cmd} && test -f .output/public/bundle-lockfile/package-lock.json && test -f .output/server/bundle-lockfile/package-lock.json`,
    expectIncludes: ['lodash-es@4.18.1'] })),
  { name: 'SvelteKit 2 (Vite 7), adapter-static', fixture: 'sveltekit2', cmd: 'npm run -s build', outDir: 'build',
    expectIncludes: SVELTE_CLIENT('2.70.3'), expectExcludes: ['ms@2.1.3'], oracleMissing: ['nanoid@3.3.20'] },
  { name: 'SvelteKit 2 (Vite 7), adapter-node', fixture: 'sveltekit2', cmd: 'npm run -s build', outDir: 'build', env: { SVELTEKIT_ADAPTER: 'node' },
    oracleArgs: 'client', expectIncludes: [...SVELTE_CLIENT('2.70.3'), '@sveltejs/adapter-node@5.5.7'], expectExcludes: ['ms@2.1.3'],
    oracleMissingIn: { client: ['nanoid@3.3.20'] } },
  // BUNDLE_LOCKFILE_DISABLE=vite: SvelteKit's Vite builds write no lockfile (none in build/client), adapter-node 5's own
  // Rollup build (no Vite plugins: a rollup build) still does - its files and what it bundles from node_modules besides
  // the project's dependencies (the server runtime's imports left by Vite's SSR build), not what the disabled server
  // build bundled (no lockfile there to find): not svelte, the kit's runtime, the client's packages. No oracle: it
  // derives everything the output has. (Which versions of the runtime's imports it bundles depends on npm's hoisting.)
  // Checked in build/ (2026-10-13): set-cookie-parser's and devalue's code in server/chunks/chunks/utils.js, cookie's in
  // server/chunks/index.js, clsx's (svelte's server runtime imports it) in server/chunks/chunks/root.js
  { name: 'SvelteKit 2 (Vite 7), adapter-node, BUNDLE_LOCKFILE_DISABLE=vite', fixture: 'sveltekit2', cmd: 'npm run -s build', outDir: 'build',
    env: { SVELTEKIT_ADAPTER: 'node', BUNDLE_LOCKFILE_DISABLE: 'vite' }, oracle: false,
    expect: ['@sveltejs/adapter-node@5.5.7', 'clsx@2.1.1', 'cookie@0.6.0', 'devalue@5.9.4', 'set-cookie-parser@2.7.2'] },
  { name: 'SvelteKit 3 (Vite 8), adapter-static', fixture: 'sveltekit3', cmd: 'npm run -s build', outDir: 'build',
    expectIncludes: SVELTE_CLIENT('3.0.1'), expectExcludes: ['ms@2.1.3'] },
  { name: 'SvelteKit 3 (Vite 8), adapter-node', fixture: 'sveltekit3', cmd: 'npm run -s build', outDir: 'build', env: { SVELTEKIT_ADAPTER: 'node' },
    oracleArgs: 'client,server', expectIncludes: [...SVELTE_CLIENT('3.0.1'), '@sveltejs/adapter-node@6.0.0'], expectExcludes: ['ms@2.1.3'] },
  // adapter-netlify: a serverless function gets a copy of the server output, with its lockfile (ms stays external, the
  // function loads it from node_modules); an edge function bundles the server output with all its dependencies -
  // with Rolldown (adapter-netlify 7, SvelteKit 3), with esbuild's API (adapter-netlify 5, SvelteKit 2): a lockfile, ms
  // in it
  { name: 'SvelteKit 2 (Vite 7), adapter-netlify, serverless function', fixture: 'sveltekit2', cmd: 'npm run -s build', outDir: '.netlify/server',
    env: { SVELTEKIT_ADAPTER: 'netlify' }, oracleArgs: '--dir .netlify/server', expectIncludes: ['@sveltejs/kit@2.70.3', 'svelte@5.57.2'], expectExcludes: ['ms@2.1.3'] },
  { name: 'SvelteKit 2 (Vite 7), adapter-netlify, edge function (esbuild)', fixture: 'sveltekit2', cmd: 'npm run -s build', outDir: '.netlify/edge-functions',
    env: { SVELTEKIT_ADAPTER: 'netlify', NETLIFY_EDGE: '1' }, oracleArgs: '--dir .netlify/edge-functions',
    expectIncludes: ['@sveltejs/kit@2.70.3', 'lodash-es@4.18.1', 'ms@2.1.3', 'svelte@5.57.2'] },
  { name: 'SvelteKit 3 (Vite 8), adapter-netlify, serverless function', fixture: 'sveltekit3', cmd: 'npm run -s build', outDir: '.netlify/v1/server',
    env: { SVELTEKIT_ADAPTER: 'netlify' }, oracleArgs: '--dir .netlify/v1/server', expectIncludes: ['@sveltejs/kit@3.0.1', 'svelte@5.57.2'], expectExcludes: ['ms@2.1.3'] },
  { name: 'SvelteKit 3 (Vite 8), adapter-netlify, edge function (Rolldown)', fixture: 'sveltekit3', cmd: 'npm run -s build', outDir: '.netlify/v1/edge-functions',
    env: { SVELTEKIT_ADAPTER: 'netlify', NETLIFY_EDGE: '1' }, oracleArgs: '--dir .netlify/v1/edge-functions',
    expectIncludes: ['@sveltejs/adapter-netlify@7.0.1', '@sveltejs/kit@3.0.1', 'lodash-es@4.18.1', 'ms@2.1.3', 'svelte@5.57.2'] },
  // with BUNDLE_LOCKFILE_INLINE=0 the island's lockfile is only in the export directory: it is found there
  { name: 'nested: Vite 8 island bundled by webpack 5, export dir only', fixture: 'nested-island-wp5', cmd: 'npm run -s build', exportOnly: true,
    expect: NESTED_EXPECT },
  // the island's output vendored with cp into the app (copied/island/dist, one level deeper): its lockfile is a copy's,
  // whose packages are kept by name and version
  { name: 'nested: Vite 8 island copied (cp) into the app, bundled by webpack 5', outside: 'the copy\'s record (another place than the island\'s output) does not know the packages\' locations: unknown', fixture: 'nested-island-wp5', env: { NESTED_ENTRY: 'vendored' },
    cmd: './node_modules/.bin/vite build --config island/vite.config.mjs && mkdir -p copied/island && cp -r island/dist copied/island/dist && ./node_modules/.bin/webpack --config webpack.config.js',
    expect: NESTED_EXPECT, expectKeys: { 'node_modules/is-number': 'is-number@7.0.0', 'node_modules/lodash-es': 'lodash-es@4.18.1', 'node_modules/nanoid': 'nanoid@3.3.20' },
    oracle: false },
  // Next.js
  // Next 12's own build fails on Node.js >= 25, also without bundle-lockfile: its compiled jsonwebtoken (through
  // buffer-equal-constant-time) reads require('buffer').SlowBuffer.prototype, and Node.js 25 removed SlowBuffer
  { name: 'Next.js 12.3.7', ...nextCase('next12', '12.3.7', '18.3.1'), maxNode: 24 },
  { name: 'Next.js 13.5.11', ...nextCase('next13', '13.5.11', '18.3.1') },
  { name: 'Next.js 14.2.35', ...nextCase('next14', '14.2.35', '18.3.1') },
  { name: 'Next.js 15.5.27', ...nextCase('next15', '15.5.27', '19.3.0') },
  // Next 15.0 - 16.3 merge repeated --require flags into one path for their build workers (vercel/next.js#96582): with
  // another preload the build fails, also without bundle-lockfile's; 16.4 passes both (#96651)
  { name: 'Next.js 15.5.27 with another --require preload (Next bug: the build fails)', fixture: 'next15', cmd: './node_modules/.bin/next build',
    nodeOptions: PRELOAD, env: NEXT_ENV, expectError: /Cannot find module '[^']*preload\.cjs [^']*register\.cjs'/ },
  // with --require= both reach Next 15's main process, only the last its build workers: bundle-lockfile's first, the
  // workers would build without it - it puts its --require back into their NODE_OPTIONS (core/children.cjs)
  { name: 'Next.js 15.5.27, --require=bundle-lockfile then --require=another preload (Next passes only the last to its workers: put back)',
    ...nextCase('next15', '15.5.27', '19.3.0'), nodeOptionsWith: (register) => `--require=${register} ${PRELOAD.replace('--require ', '--require=')}` },
  { name: 'Next.js 16.4.0 --webpack with another --require preload', ...nextCase('next16', '16.4.0', '19.3.0', '--webpack'), nodeOptions: PRELOAD },
  { name: 'Next.js 16.4.0 --webpack', ...nextCase('next16', '16.4.0', '19.3.0', '--webpack') },
  // standalone deployments copy only .next/standalone and .next/static, which drops .next/bundle-lockfile
  { name: 'Next.js 16.4.0 --webpack, export dir only', ...nextCase('next16', '16.4.0', '19.3.0', '--webpack'), exportOnly: true },
  // a second build restores the modules from webpack's persistent cache in .next/cache: the same packages in each lockfile
  { name: 'Next.js 16.4.0 --webpack, warm build from .next/cache = cold build', ...nextCase('next16', '16.4.0', '19.3.0', '--webpack'),
    cmd: ['./node_modules/.bin/next build --webpack', `${NEXT_LOCKS} > .cold.json`, './node_modules/.bin/next build --webpack', `${NEXT_LOCKS} | cmp .cold.json -`].join(' && ') },
  // output: 'standalone': .next/standalone has the traced server files: the runtime packages' lockfile, and the copies of
  // the lockfiles of the outputs Next copied there (the oracle's: BLTEST_ORACLE_STANDALONE)
  { name: "Next.js 16.4.0 --webpack, output: 'standalone': .next/standalone gets the runtime packages and the bundles' lockfiles", fixture: 'next16',
    cmd: './node_modules/.bin/next build --webpack', outDir: '.next/standalone', env: { ...NEXT_ENV, NEXT_STANDALONE: '1', BLTEST_ORACLE_STANDALONE: '1' },
    oracleArgs: '--webpack', expectIncludes: ['next@16.4.0', 'react@19.3.0', 'ms@2.1.3'], runtimeTrace: { routes: ['/'] } },
  // the server's runtime packages (.next/runtime): bl-canary-rt (a page's require at request time), bl-canary-legacy (no
  // package.json in .next/standalone: a deep .cjs require), bl-canary-ext (serverExternalPackages, App Router) - and not
  // bl-canary-bundled, which the server output bundles (its lockfile lists it); every listed canary is in node_modules
  ...[['16.4.0', 'next16-runtime'], ['15.5.27', 'next15-runtime']].flatMap(([v, fixture]) => [
    { name: `Next.js ${v} --webpack: the server's runtime packages in .next/runtime`, fixture, cmd: `./node_modules/.bin/next build${v.startsWith('16') ? ' --webpack' : ''}`,
      outDir: '.next', env: NEXT_ENV, oracleArgs: v.startsWith('16') ? '--webpack' : '', canaryDirs: ['node_modules'],
      expectIncludes: ['bl-canary-rt@1.0.0', 'bl-canary-legacy@1.0.0', 'bl-canary-ext@1.0.0', 'bl-canary-bundled@1.0.0', `next@${v}`] },
    { name: `Next.js ${v} --webpack, output: 'standalone': the runtime packages where the standalone server loads them`, fixture,
      cmd: `./node_modules/.bin/next build${v.startsWith('16') ? ' --webpack' : ''}`, outDir: '.next/standalone',
      env: { ...NEXT_ENV, NEXT_STANDALONE: '1', BLTEST_ORACLE_STANDALONE: '1' }, oracleArgs: v.startsWith('16') ? '--webpack' : '',
      expectIncludes: ['bl-canary-rt@1.0.0', 'bl-canary-legacy@1.0.0', 'bl-canary-ext@1.0.0', 'bl-canary-bundled@1.0.0'], runtimeTrace: { routes: ['/', '/r'] } },
  ]),
  // pnpm: Next and its dependencies below node_modules/.pnpm, which .next/standalone mirrors
  { name: "Next.js 16.4.0 --webpack, pnpm 10.34.6, output: 'standalone': the runtime packages", fixture: 'next16-runtime-pnpm10',
    cmd: './node_modules/.bin/next build --webpack', outDir: '.next/standalone', env: { ...NEXT_ENV, NEXT_STANDALONE: '1', BLTEST_ORACLE_STANDALONE: '1' },
    oracleArgs: '--webpack', expectIncludes: ['bl-canary-rt@1.0.0', 'bl-canary-legacy@1.0.0', 'bl-canary-ext@1.0.0', 'bl-canary-bundled@1.0.0', 'next@16.4.0'],
    runtimeTrace: { routes: ['/', '/r'] } },
  // Turbopack is not hooked (STRICT=0: a warning): no bundle lockfiles, but the runtime packages, from Turbopack's
  // traces; bl-canary-bundled is in Turbopack's server output, which no lockfile covers
  { name: "Next.js 16.4.0 Turbopack, output: 'standalone', STRICT=0: only the runtime packages", fixture: 'next16-runtime',
    cmd: './node_modules/.bin/next build --turbopack', outDir: '.next/standalone',
    env: { ...NEXT_ENV, NEXT_STANDALONE: '1', BLTEST_ORACLE_STANDALONE: '1', BUNDLE_LOCKFILE_STRICT: '0' }, oracleArgs: '--turbopack',
    expectIncludes: ['bl-canary-rt@1.0.0', 'bl-canary-legacy@1.0.0', 'bl-canary-ext@1.0.0'], canaryUnlisted: ['bl-canary-bundled@1.0.0'],
    runtimeTrace: { routes: ['/', '/r'] } },
  // a static export copies the pages and .next/static into out/ (out/_next/static): the client's lockfile goes along, to
  // out/_next/ (adapters/next.cjs) - also where the compilers ran in build workers (Next.js 14 and later without a
  // webpack() in the config: the export's process knows nothing of them), and from `next export` (Next.js 12)
  ...[['16.4.0', 'next16', '--webpack', '19.3.0', {}], ['16.4.0', 'next16', '--webpack', '19.3.0', { NEXT_WEBPACK_FN: '1' }],
    ['14.2.35', 'next14', '', '18.3.1', {}], ['13.5.11', 'next13', '', '18.3.1', {}]].map(([v, fixture, flags, react, env]) => (
    { name: `Next.js ${v}${flags ? ` ${flags}` : ''}, output: 'export'${env.NEXT_WEBPACK_FN ? ', a webpack() in next.config.js (no build workers)' : ''}: out/_next gets the client's lockfile`,
      fixture, cmd: `./node_modules/.bin/next build ${flags}`.trim(), outDir: 'out', oracleArgs: flags,
      env: { ...NEXT_ENV, NEXT_EXPORT: '1', BLTEST_ORACLE_EXPORT: '1', ...env }, expectIncludes: [`react@${react}`] })),
  { name: 'Next.js 12.3.7, next export: out/_next gets the client\'s lockfile', fixture: 'next12', cmd: './node_modules/.bin/next build && ./node_modules/.bin/next export',
    outDir: 'out', env: { ...NEXT_ENV, BLTEST_ORACLE_EXPORT: '1' }, expectIncludes: ['react@18.3.1'], maxNode: 24 },
  { name: "Next.js 16.4.0 --webpack, output: 'export', export dir only", ...nextCase('next16', '16.4.0', '19.3.0', '--webpack'),
    env: { ...NEXT_ENV, NEXT_EXPORT: '1' }, exportOnly: true },
  // a webpack() in next.config.js (as real apps have) turns Next.js 14 and later's build workers off: the compilers run in
  // next build's own process - the same lockfiles
  { name: 'Next.js 16.4.0 --webpack, a webpack() in next.config.js (no build workers)', ...nextCase('next16', '16.4.0', '19.3.0', '--webpack'),
    env: { ...NEXT_ENV, NEXT_WEBPACK_FN: '1' } },
  { name: 'Next.js 15.5.27, a webpack() in next.config.js (no build workers)', ...nextCase('next15', '15.5.27', '19.3.0'), env: { ...NEXT_ENV, NEXT_WEBPACK_FN: '1' } },
  { name: 'Next.js 14.2.35, a webpack() in next.config.js (no build workers)', ...nextCase('next14', '14.2.35', '18.3.1'), env: { ...NEXT_ENV, NEXT_WEBPACK_FN: '1' } },
  { name: "Next.js 16.4.0 --webpack, a webpack() in next.config.js (no build workers), output: 'standalone'", fixture: 'next16',
    cmd: './node_modules/.bin/next build --webpack', outDir: '.next/standalone', env: { ...NEXT_ENV, NEXT_STANDALONE: '1', BLTEST_ORACLE_STANDALONE: '1', NEXT_WEBPACK_FN: '1' },
    oracleArgs: '--webpack', expectIncludes: ['next@16.4.0', 'react@19.3.0', 'ms@2.1.3'], runtimeTrace: { routes: ['/'] } },
  // Next's own failure: the runtime packages cannot be collected (webpack disabled: its builds would fail first)
  { name: "strict: failing adapter fails the build (Next.js 16.4.0, the server's runtime packages)", fixture: 'next16-runtime', cmd: './node_modules/.bin/next build --webpack',
    outDir: '.next', nodeOptions: FAULT_FILES, env: { ...NEXT_ENV, BUNDLE_LOCKFILE_DISABLE: 'webpack' },
    expectError: /bundle-lockfile: the lockfile would be missing or incomplete[\s\S]*Next\.js: could not collect the server's runtime packages: injected fault/ },
  { name: "STRICT=0: failing adapter does not break the build (Next.js 16.4.0, the server's runtime packages)", fixture: 'next16-runtime',
    cmd: './node_modules/.bin/next build --webpack', outDir: '.next', nodeOptions: FAULT_FILES, env: { ...NEXT_ENV, BUNDLE_LOCKFILE_DISABLE: 'webpack', BUNDLE_LOCKFILE_STRICT: '0' },
    expect: null, expectOutput: /\[bundle-lockfile\] WARNING: Next\.js: could not collect the server's runtime packages: Error: injected fault/ },
  // App Router: the exact per-compiler lists are the oracle's; nanoid (edge route) and is-number (middleware) are in the
  // edge-server output
  { name: 'Next.js 15.5.27 App Router, edge route handler, middleware', ...nextCase('next15-app', '15.5.27', '19.3.0'),
    expectIncludes: ['ms@2.1.3', 'lodash-es@4.18.1', 'nanoid@3.3.20', 'is-number@7.0.0', 'next@15.5.27'] },
  { name: 'Next.js 16.4.0 --webpack App Router, edge route handler, middleware', ...nextCase('next16-app', '16.4.0', '19.3.0', '--webpack'),
    expectIncludes: ['ms@2.1.3', 'lodash-es@4.18.1', 'nanoid@3.3.20', 'is-number@7.0.0', 'next@16.4.0'] },
  // peer dependencies: every virtual path / peer-suffixed directory of a package is that one package (check.cjs: no
  // virtual paths in keys)
  { name: "Vite 8.3.3, packages with peer dependencies, yarn 4.18.1 Plug'n'Play", fixture: 'peer-deps-yarn4-pnp', cmd: 'yarn build', expect: PEER_DEPS },
  { name: "webpack 5.111.1, packages with peer dependencies, yarn 4.18.1 Plug'n'Play", fixture: 'peer-deps-yarn4-pnp', cmd: 'yarn build-webpack',
    oracleScript: 'webpack', expect: PEER_DEPS },
  { name: 'Vite 8.3.3, packages with peer dependencies, pnpm 10.34.6', fixture: 'peer-deps-pnpm10', cmd: '$PNPM run build', expect: PEER_DEPS },
  { name: 'webpack 5.111.1, packages with peer dependencies, pnpm 10.34.6', fixture: 'peer-deps-pnpm10', cmd: '$PNPM run build-webpack', oracleScript: 'webpack',
    expect: PEER_DEPS },
  // a Vite and a webpack process writing one output dir: one lockfile with both (writers of different bundlers, with
  // different contexts); each one run again keeps the other's packages
  { name: 'edge: a Vite and a webpack process, one output dir, then each of them again', fixture: 'mixed-output',
    cmd: `${VITE_BIN} build && ${WEBPACK_BIN} && ${VITE_BIN} build && ${WEBPACK_BIN}`, expect: ['ms@2.1.3', 'nanoid@3.3.20'] },
  // the same into a directory outside the project: the record has no paths there (contextId, selfId), and each process
  // still keeps the other's packages, at their locations
  { name: 'edge: a Vite and a webpack process, one output dir outside the project: a record without its paths', fixture: 'mixed-output',
    env: { MIXED_OUT: '../mixed-output-elsewhere' }, outDir: '../mixed-output-elsewhere', expectAnchor: 'ids',
    cmd: `${VITE_BIN} build && ${WEBPACK_BIN} && ${VITE_BIN} build && ${WEBPACK_BIN}`, expect: ['ms@2.1.3', 'nanoid@3.3.20'] },
  // Bun's own runtime (bun --bun) does not load NODE_OPTIONS' --require: not supported (yet), no lockfile
  { name: 'bun --bun (Bun\'s runtime, unsupported: no lockfile), webpack', fixture: 'wp5-bun', cmd: 'bun --bun run build', expect: null },
  { name: 'bun --bun (Bun\'s runtime, unsupported: no lockfile), Vite 8.3.3', fixture: 'vite8-bun', cmd: 'bun --bun run build', expect: null },
  // rspack: hooked through its Compiler, with webpack's plugin; the oracle builds again and reads rspack's stats
  // activation
  { name: 'rspack 2.2.8: not active without NODE_OPTIONS', fixture: 'rspack2.2-npm', cmd: 'npm run -s build', inject: false, expect: null },
  { name: 'rspack 2.2.8: BUNDLE_LOCKFILE_DISABLE=rspack', fixture: 'rspack2.2-npm', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_DISABLE: 'rspack' }, expect: null },
  { name: 'rspack 2.2.8: BUNDLE_LOCKFILE_DISABLE=webpack: still hooked', fixture: 'rspack2.2-npm', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_DISABLE: 'webpack' },
    expect: W5 },
  { name: 'rspack 2.2.8: existing NODE_OPTIONS are preserved', fixture: 'rspack2.2-npm', cmd: 'npm run -s build', nodeOptions: '--max-old-space-size=3072', heapMB: 3072,
    expect: W5 },
  { name: 'rspack 2.2.8: BUNDLE_LOCKFILE_FILE=sbom/package-lock.json', fixture: 'rspack2.2-npm', cmd: 'npm run -s build',
    env: { BUNDLE_LOCKFILE_FILE: 'sbom/package-lock.json' }, lockfile: 'sbom/package-lock.json', expect: W5 },
  ...[['1.7.12', 'rspack1.7-npm'], ['2.2.8', 'rspack2.2-npm']].flatMap(([v, fixture]) => [
    { name: `strict: failing adapter fails the build (rspack ${v})`, fixture, cmd: 'npm run -s build', nodeOptions: FAULT,
      expectError: /bundle-lockfile: the lockfile would be missing or incomplete[\s\S]*rspack: could not collect the packages of \S*dist: injected fault/ },
    { name: `STRICT=0: failing adapter does not break the build (rspack ${v})`, fixture, cmd: 'npm run -s build', nodeOptions: FAULT,
      env: { BUNDLE_LOCKFILE_STRICT: '0' }, expect: null,
      expectOutput: /\[bundle-lockfile\] WARNING: rspack: could not collect the packages of \S*dist: Error: injected fault/ }]),
  // versions: what rspack bundles of the app is what webpack 5 does
  ...['1.1.8', '1.2.8', '1.3.15', '1.5.8', '1.6.8', '1.7.12', '2.0.8', '2.1.10', '2.2.8'].map(v => (
    { name: `rspack ${v}`, fixture: `rspack${v.split('.').slice(0, 2).join('.')}-npm`, cmd: 'npm run -s build', expect: W5 })),
  // rspack 1.0 lacks what the plugin needs: its builds fail, with STRICT=0 they succeed without the lockfile
  { name: 'strict: rspack 1.0.14 is not supported, fails the build', fixture: 'rspack1.0-npm', cmd: 'npm run -s build',
    expectError: /bundle-lockfile: the lockfile would be missing or incomplete[\s\S]*rspack 1\.0\.14 is not supported/ },
  { name: 'STRICT=0: rspack 1.0.14 is not supported, a warning', fixture: 'rspack1.0-npm', cmd: 'npm run -s build', env: { BUNDLE_LOCKFILE_STRICT: '0' },
    expect: null, expectOutput: /\[bundle-lockfile\] WARNING: rspack 1\.0\.14 is not supported/ },
  // runners / installers
  { name: 'rspack 2.2.8: npx rspack build', fixture: 'rspack2.2-npm', cmd: 'npx rspack build', expect: W5 },
  { name: 'rspack 2.2.8: direct node_modules/.bin/rspack', fixture: 'rspack2.2-npm', cmd: `${RSPACK_BIN} build`, expect: W5 },
  ...[['1.7.12', '1.7'], ['2.2.8', '2.2']].flatMap(([v, line]) => [
    { name: `rspack ${v}, pnpm 10.34.6`, fixture: `rspack${line}-pnpm10`, cmd: '$PNPM run build', expect: W5 },
    { name: `rspack ${v}, yarn 1.22`, fixture: `rspack${line}-yarn1`, cmd: 'yarn --offline -s build', expect: W5 },
    // the packages are in .yarn/cache/<zip>/node_modules/: keyed as those in a global cache
    { name: `rspack ${v}, yarn 4.18.1 Plug'n'Play`, fixture: `rspack${line}-yarn4-pnp`, cmd: 'yarn build', expect: W5, expectKeys: OUTSIDE_KEYS_W5 },
    { name: `rspack ${v}, yarn 4.18.1 node-modules linker`, fixture: `rspack${line}-yarn4-node-modules`, cmd: 'yarn build', expect: W5 },
    { name: `rspack ${v}, bun`, fixture: `rspack${line}-bun`, cmd: 'bun run build', expect: W5 }]),
  { name: 'rspack 2.2.8, pnpm 11.28.5', fixture: 'rspack2.2-pnpm11', cmd: '$PNPM run build', expect: W5 },
  { name: 'rspack 2.2.8, pnpm 10.34.6, global virtual store', outside: 'pnpm\'s global virtual store, outside the project', fixture: 'rspack2.2-pnpm10-global-store', cmd: '$PNPM run build', expect: W5,
    expectKeys: OUTSIDE_KEYS_W5 },
  // programmatic builds through rspack's JavaScript API
  ...[['1.7.12', '1.7'], ['2.2.8', '2.2']].flatMap(([v, line]) => [
    { name: `rspack ${v}: programmatic build, require()`, fixture: `rspack${line}-npm`, cmd: 'node build.cjs', expect: W5 },
    { name: `rspack ${v}: programmatic build, import`, fixture: `rspack${line}-npm`, cmd: 'node build.mjs', expect: W5 }]),
  // from a package without a dependency on rspack (tools/build.mjs), which imports rspack 2 only as an ES module:
  // hooked with the in-thread hooks; older Node versions install the loader-thread ones there because the project has
  // rspack installed (CI's Node 22 job)
  { name: `rspack 2.2.8: programmatic build from a package without rspack, in a project with it installed (Node ${process.versions.node}: ${SYNC_HOOKS ? 'in-thread' : 'loader-thread'} hooks)`,
    fixture: 'rspack2.2-npm', cmd: 'node tools/build.mjs', expect: W5 },
  { name: 'rspack 2.2.8: programmatic build from a package without rspack, BUNDLE_LOCKFILE_ESM_HOOKS=async', fixture: 'rspack2.2-npm',
    cmd: 'node tools/build.mjs', env: { BUNDLE_LOCKFILE_ESM_HOOKS: 'async' }, expect: W5 },
  { name: `rspack 2.2.8: programmatic build started outside the project (Node ${process.versions.node}: ${SYNC_HOOKS ? 'in-thread hooks' : 'no ESM hooks, fails'})`,
    fixture: 'rspack2.2-npm', cmd: 'D=$PWD && cd / && node "$D/tools/build.mjs"',
    ...(SYNC_HOOKS ? { expect: W5 } : { expectError: /rspack is loaded as an ES module in a process without bundle-lockfile's ESM hooks .*set BUNDLE_LOCKFILE_ESM_HOOKS=async/ }) },
  // build modes
  ...[['1.7.12', '1.7'], ['2.2.8', '2.2']].flatMap(([v, line]) => [
    { name: `rspack ${v}, development mode`, fixture: `rspack${line}-npm`, cmd: 'npm run -s build', env: { RSPACK_MODE: 'development' }, expect: W5 },
    // rebuilt without the async chunk's import('nanoid'), then with it: nanoid leaves the lockfile and comes back
    { name: `rspack ${v}, watch mode: every rebuild writes the lockfile, with the packages of that build`, fixture: `rspack${line}-npm`,
      cmd: `${WATCH} src/index.js "import('nanoid')"`, expect: W5, watchBuilds: [W5, W5.filter(p => !p.startsWith('nanoid@')), W5] },
    { name: `rspack ${v}, persistent cache: warm build = cold build`, fixture: `rspack${line}-npm`, env: { RSPACK_CACHE: '1' }, cmd: WARM, expect: W5 }]),
  { name: 'rspack 2.2.8: externals are not listed', fixture: 'rspack2.2-npm', cmd: 'npm run -s build', env: { RSPACK_EXTERNALS: '1' },
    expect: W5.filter(p => !p.startsWith('lodash-es@')) },
  // what reaches the output besides the chunks' JavaScript modules (test/apps/rspack-features); the oracle builds without
  // inlining exports, so the modules of consts-only and consts-default are in its chunks, and matches the copies by bytes
  ...[['1.2.8', '1.2'], ['1.7.12', '1.7'], ['2.2.8', '2.2']].map(([v, line]) => (
    { name: `rspack ${v}: native CSS, extracted Sass and Less, an asset, a worker, copies, inlined exports`, fixture: `rspack-features${line}`,
      cmd: RSPACK_FEATURES_CMD, expect: RSPACK_FEATURES, oracleMissing: RSPACK_FEATURES_MISSING })),
  // modules restored from the cache keep the files their loaders read (the style sheets inlined from packages)
  { name: 'rspack 2.2.8: native CSS, extracted Sass and Less, an asset, a worker, copies, inlined exports, persistent cache: warm build = cold build',
    fixture: 'rspack-features2.2', env: { RSPACK_CACHE: '1' }, cmd: `${RSPACK_CONSTS} && ${WARM}`, expect: RSPACK_FEATURES, oracleMissing: RSPACK_FEATURES_MISSING },
  // outputs: two compilers writing to dist/ (one process and two), as edge-shared-output's
  { name: 'rspack 2.2.8: two compilers, one output dir', fixture: 'rspack2.2-npm', cmd: 'npm run -s build', env: { RSPACK_SHARED: '1' }, expect: SHARED },
  { name: 'rspack 2.2.8: two rspack processes, one output dir, in parallel', fixture: 'rspack2.2-npm', cmd: PARALLEL_RSPACK, env: { RSPACK_SHARED: '1' },
    expect: SHARED },
  { name: 'rspack 2.2.8: two rspack processes, one output dir, then one of them again', fixture: 'rspack2.2-npm',
    cmd: `${PARALLEL_RSPACK} && ${RSPACK_BIN} build --config-name app`, env: { RSPACK_SHARED: '1' }, expect: SHARED },
  // the plugin configured by hand (no NODE_OPTIONS). No oracle: it would build with the plugin as well (RSPACK_PLUGIN
  // reaches it); the list is the one the oracle checks in the cases above
  { name: 'rspack 2.2.8: plugin in the config (no NODE_OPTIONS), two rspack processes, one output dir, in parallel', fixture: 'rspack2.2-npm',
    cmd: PARALLEL_RSPACK, inject: false, env: { RSPACK_SHARED: '1', RSPACK_PLUGIN: path.join(__dirname, '../src/adapters/rspack.cjs') }, expect: SHARED,
    oracle: false },
  // app's output.clean deletes sw's files: sw's packages are dropped. The oracle builds both configs in one process,
  // where app's clean does not delete the files of sw building next to it
  { name: 'rspack 2.2.8: two rspack processes, one output dir, the second one cleans it', fixture: 'rspack2.2-npm', env: { RSPACK_SHARED: 'clean' },
    cmd: `${RSPACK_BIN} build --config-name sw && ${RSPACK_BIN} build --config-name app`, expect: ['ms@2.1.3'], oracle: false },
  { name: 'rspack 2.2.8: two rspack processes, one output dir, the second one cleans it but keeps the first one\'s file', fixture: 'rspack2.2-npm',
    env: { RSPACK_SHARED: 'clean-keep' }, cmd: `${RSPACK_BIN} build --config-name sw && ${RSPACK_BIN} build --config-name app`, expect: SHARED },
  // an rspack (app) and a webpack process (sw, webpack.config.js) writing to one dir, each run again: one lockfile with
  // both. The oracle: rspack's (both configs) and webpack's
  { name: 'rspack 2.2.8: an rspack and a webpack process, one output dir, then each of them again', fixture: 'rspack2.2-npm', env: { RSPACK_SHARED: '1' },
    cmd: `${RSPACK_BIN} build --config-name app && ${WEBPACK_BIN} && ${RSPACK_BIN} build --config-name app && ${WEBPACK_BIN}`, expect: SHARED,
    oracleScript: 'mixed', oracleArgs: 'rspack.cjs webpack.cjs' },
  { name: 'rspack 2.2.8: in-memory output file system (memfs): the lockfile is an asset', fixture: 'rspack2.2-npm', cmd: MEMFS, expect: W5 },
  { name: 'rspack 2.2.8, export: BUNDLE_LOCKFILE_EXPORT_DIR and the inline lockfile', fixture: 'rspack2.2-npm', cmd: 'npm run -s build', exportDir: true, expect: W5 },
  { name: 'rspack 2.2.8, export: BUNDLE_LOCKFILE_EXPORT_DIR only (BUNDLE_LOCKFILE_INLINE=0)', fixture: 'rspack2.2-npm', cmd: 'npm run -s build', exportOnly: true,
    expect: W5 },
  // NODE_OPTIONS overwritten by the build script: no lockfile, unless the node shim is first in PATH
  { name: 'rspack 2.2.8, shim: a script overwriting NODE_OPTIONS drops the --require (no shim)', fixture: 'rspack2.2-npm', cmd: 'npm run -s build-reset', expect: null },
  ...[['npm', 'rspack2.2-npm', 'npm run -s build-reset'], ['pnpm 10', 'rspack2.2-pnpm10', '$PNPM run build-reset'],
    ['yarn 1', 'rspack2.2-yarn1', 'yarn --offline -s build-reset'], ['yarn 4 (node-modules)', 'rspack2.2-yarn4-node-modules', 'yarn build-reset'],
    ['bun', 'rspack2.2-bun', 'bun run build-reset']].map(([what, fixture, cmd]) => (
    { name: `rspack 2.2.8, shim: ${what}, script overwriting NODE_OPTIONS`, fixture, cmd, shim: true, expect: W5 })),
  { name: 'rspack 2.2.8, shim: cross-env NODE_OPTIONS=... (no shim)', fixture: 'rspack2.2-npm', cmd: 'npm run -s build-crossenv', expect: null },
  { name: 'rspack 2.2.8, shim: cross-env NODE_OPTIONS=...', fixture: 'rspack2.2-npm', cmd: 'npm run -s build-crossenv', shim: true, expect: W5 },
  // strict mode: a lockfile that cannot be written (main.js is a file), a bundled package that cannot be listed
  { name: 'strict: a lockfile that cannot be written fails the build (rspack 2.2.8)', fixture: 'rspack2.2-npm', cmd: 'npm run -s build',
    env: { BUNDLE_LOCKFILE_FILE: 'main.js/package-lock.json' },
    expectError: /bundle-lockfile: the lockfile would be missing or incomplete[\s\S]*rspack: could not write \S*dist\/main\.js\/package-lock\.json/ },
  { name: 'STRICT=0: a lockfile that cannot be written is a warning (rspack 2.2.8)', fixture: 'rspack2.2-npm', cmd: 'npm run -s build',
    env: { BUNDLE_LOCKFILE_FILE: 'main.js/package-lock.json', BUNDLE_LOCKFILE_STRICT: '0' }, lockfile: 'main.js/package-lock.json', expect: null,
    expectOutput: /\[bundle-lockfile\] WARNING: rspack: could not write/ },
  // no oracle: it names packages by their package.json too, and finds none for naked
  { name: 'strict: a bundled package that cannot be listed fails the build (rspack 2.2.8)', fixture: 'rspack2.2-npm', env: { RSPACK_NAKED: '1' }, cmd: NAKED,
    expectError: /bundle-lockfile: the lockfile would be missing or incomplete[\s\S]*no package\.json with name and version in \S*node_modules\/naked - its bundled files are not listed/ },
  { name: 'STRICT=0: a bundled package that cannot be listed is a warning (rspack 2.2.8)', fixture: 'rspack2.2-npm', env: { RSPACK_NAKED: '1', BUNDLE_LOCKFILE_STRICT: '0' },
    cmd: NAKED, expect: W5, expectOutput: /\[bundle-lockfile\] WARNING: no package\.json with name and version in \S*node_modules\/naked - its bundled files are not listed/,
    oracle: false },
  // OHIF's shape: rspack 2 builds, the config's copy plugin is rspack 1's: one lockfile, with the copy (the oracle builds
  // with the command line's rspack)
  { name: 'rspack 1.7.12 and 2.2.8 in one process (OHIF: the config\'s CopyRspackPlugin from rspack 1, built by @rspack/cli 2)', fixture: 'rspack-copies',
    cmd: 'npm run -s build', expect: W5_COPY, oracleArgs: '--from node_modules/@rspack/cli' },
  // Rsbuild: its rspack compiler, the file copied by output.copy
  ...[['1.1.10', 'rsbuild1.1-npm', 'npm run -s build'], ['1.2.19', 'rsbuild1.2-npm', 'npm run -s build'], ['1.7.6', 'rsbuild1.7-npm', 'npm run -s build'],
    ['2.2.12', 'rsbuild2.2-npm', 'npm run -s build'], ['2.2.12, bun', 'rsbuild2.2-bun', 'bun run build'],
    ['2.2.12, yarn 4.18.1 Plug\'n\'Play', 'rsbuild2.2-yarn4-pnp', 'yarn build']].map(([what, fixture, cmd]) => (
    { name: `Rsbuild ${what}`, fixture, cmd, expect: W5_COPY })),
  // Next 16 builds with Turbopack by default, which bundle-lockfile does not hook: recognized, it fails (strict);
  // STRICT=0: no bundle lockfile, but the server's runtime packages (from Turbopack's traces)
  { name: 'Next.js 16.4.0 Turbopack (unsupported: fails)', fixture: 'next16', cmd: './node_modules/.bin/next build', outDir: '.next', env: NEXT_ENV,
    expectError: /Next\.js built with Turbopack, which bundle-lockfile does not hook: no lockfile/ },
  { name: 'Next.js 16.4.0 Turbopack, BUNDLE_LOCKFILE_STRICT=0 (unsupported: only the runtime packages)', fixture: 'next16', cmd: './node_modules/.bin/next build',
    outDir: '.next', env: { ...NEXT_ENV, BUNDLE_LOCKFILE_STRICT: '0' }, expectIn: { runtime: 'oracle' } },
  // frameworks and plugins on rspack
  // Next.js with next-rspack: the same compilers, built by rspack, the same lockfiles as with webpack (exact lists: the
  // oracle's of the webpack cases above). The oracle's stats plugin works on rspack's compilers too
  { name: 'Next.js 15.5.27 with next-rspack (rspack 1.4)', ...nextCase('next15-rspack', '15.5.27', '19.3.0'), env: NEXT_RSPACK_ENV,
    expectIn: NEXT_PAGES('15.5.27', '0.5.15') },
  { name: 'Next.js 16.4.0 with next-rspack (rspack 2.0)', ...nextCase('next16-rspack', '16.4.0', '19.3.0'), env: NEXT_RSPACK_ENV,
    expectIn: NEXT_PAGES('16.4.0', '0.5.23') },
  { name: 'Next.js 16.4.0 with next-rspack (rspack 2.0) App Router, edge route handler, middleware', ...nextCase('next16-app-rspack', '16.4.0', '19.3.0'),
    env: NEXT_RSPACK_ENV, expectIn: NEXT_APP('16.4.0', '0.5.23') },
  // module federation: rspack's ModuleFederationPlugin and @module-federation/enhanced's
  { name: 'rspack 2.2.8: module federation (a host, a remote, a shared package)', fixture: 'rspack-federation2.2', cmd: 'npm run -s build',
    expectIn: FEDERATION('2.9.2') },
  { name: 'rspack 2.2.8: module federation, @module-federation/enhanced', fixture: 'rspack-federation2.2', cmd: 'npm run -s build', env: { RSPACK_MF: 'enhanced' },
    expectIn: FEDERATION('2.9.2') },
  { name: 'rspack 2.2.8: module federation, tree shaking of the shared package (compilers rspack creates)', fixture: 'rspack-federation2.2', cmd: 'npm run -s build',
    env: { RSPACK_MF_TS: '1' }, expectIn: { ...FEDERATION('2.9.2'), ...FEDERATION_TS }, oracleMissingIn: FEDERATION_TS },
  { name: 'rspack 2.2.8: module federation, @module-federation/enhanced, tree shaking of the shared package', fixture: 'rspack-federation2.2',
    cmd: 'npm run -s build', env: { RSPACK_MF: 'enhanced', RSPACK_MF_TS: '1' }, expectIn: { ...FEDERATION('2.9.2'), ...FEDERATION_TS }, oracleMissingIn: FEDERATION_TS },
  { name: 'rspack 1.7.12: module federation (a host, a remote, a shared package)', fixture: 'rspack-federation1.7', cmd: 'npm run -s build',
    expectIn: FEDERATION('0.22.0') },
  // child compilations: the oracle reads them from the stats' children
  ...[['2.2.8', '2.2'], ['1.2.8', '1.2']].map(([v, line]) => (
    { name: `rspack ${v}: Monaco with monaco-editor-webpack-plugin (workers in child compilations)`, fixture: `rspack-monaco${line}`, cmd: 'npm run -s build',
      expect: MONACO })),
  // Rsbuild's environments: one compiler each, web into dist/, node into dist/server/
  ...[['1.7.6', 'rsbuild1.7-npm'], ['2.2.12', 'rsbuild2.2-npm']].map(([v, fixture]) => (
    { name: `Rsbuild ${v}: environments web (dist/) and node (dist/server/)`, fixture, cmd: 'npm run -s build', env: { RSBUILD_ENVS: '1' },
      expectIn: { '': W5_COPY, server: W5_COPY } })),
  // Grafana's shape: webpack into dist/ (sw, webpack.config.js), rspack into dist/rspack/ (app, cleaning its directory);
  // each run again: each its own lockfile
  { name: 'rspack 2.2.8: webpack into dist/, rspack into dist/rspack/ (Grafana), each of them again', fixture: 'rspack2.2-npm', env: { RSPACK_NESTED: '1' },
    cmd: `${WEBPACK_BIN} && ${RSPACK_BIN} build && ${WEBPACK_BIN} && ${RSPACK_BIN} build`, expectIn: { '': ['debug@2.6.9', 'ms@2.0.0'], rspack: ['ms@2.1.3'] },
    oracleScript: 'mixed', oracleArgs: 'rspack.cjs webpack.cjs' },
  // dev servers build into memory: the lockfile is served, nothing is written to dist/ (test/lib/dev-server.cjs). No
  // oracle: it builds the config alone, without the dev server's entries and lazy compilation (see DEV_W5)
  ...[['2.2.8', 'rspack2.2-npm', DEV_RSPACK2], ['1.7.12', 'rspack1.7-npm', DEV_RSPACK1]].map(([v, fixture, expect]) => (
    { name: `rspack ${v}: rspack serve serves the lockfile, writes nothing to disk`, fixture, cmd: `${DEV_SERVER} ${RSPACK_BIN} serve`,
      env: { RSPACK_MODE: 'development' }, expect, oracle: false })),
  // with writeToDisk the dev build writes its lockfile to dist/, as watch mode does
  { name: 'rspack 2.2.8: rspack serve with writeToDisk writes the lockfile to dist/', fixture: 'rspack2.2-npm', cmd: `${DEV_SERVER} --on-disk ${RSPACK_BIN} serve`,
    env: { RSPACK_MODE: 'development', RSPACK_WRITE_TO_DISK: '1' }, expect: DEV_RSPACK2, oracle: false },
  { name: 'Rsbuild 2.2.12: rsbuild dev serves the lockfile, writes nothing to disk', fixture: 'rsbuild2.2-npm', cmd: `${DEV_SERVER} ./node_modules/.bin/rsbuild dev`,
    expect: DEV_RSBUILD, oracle: false },
  // Rstest bundles the tests with Rsbuild: no lockfile in the project, and the run passes (strict mode)
  { name: 'Rstest 0.12.3 (Rsbuild 2.2.12): no lockfile in the project, the run passes', fixture: 'rsbuild2.2-npm', cmd: RSTEST, expect: null },
  // more outputs: HtmlRspackPlugin's child compilation adds no packages and no lockfile
  ...[['2.2.8', 'rspack2.2-npm'], ['1.7.12', 'rspack1.7-npm']].map(([v, fixture]) => (
    { name: `rspack ${v}: HtmlRspackPlugin`, fixture, cmd: 'npm run -s build', env: { RSPACK_HTML: '1' }, expect: W5 })),
  // ... its favicon from a package, which it reads in Rust and emits as an asset: the package is listed; so is Rsbuild's
  // html.favicon, which Rsbuild reads and emits itself
  ...[['2.2.8', 'rspack2.2-npm'], ['1.7.12', 'rspack1.7-npm']].map(([v, fixture]) => (
    { name: `rspack ${v}: HtmlRspackPlugin favicon from a package`, fixture, cmd: 'npm run -s build', env: { RSPACK_FAVICON: FAVICON },
      expect: [...W5, 'uuid@9.0.1'].sort(), oracleMissing: ['uuid@9.0.1'] })),
  ...[['1.7.6', 'rsbuild1.7-npm'], ['2.2.12', 'rsbuild2.2-npm']].map(([v, fixture]) => (
    { name: `Rsbuild ${v}: html.favicon from a package`, fixture, cmd: 'npm run -s build', env: { RSBUILD_FAVICON: FAVICON },
      expect: [...W5_COPY, 'uuid@9.0.1'].sort(), oracleMissing: ['uuid@9.0.1'] })),
  { name: 'rspack 2.2.8: two compilers, two output dirs', fixture: 'rspack2.2-npm', cmd: 'npm run -s build', env: { RSPACK_SHARED: 'apart' },
    expectIn: { a: ['ms@2.1.3'], b: ['debug@2.6.9', 'ms@2.0.0'] } },
  // output.path 'dist/[fullhash]': each compiler's own directory. No oracle: it builds without minimizing, which changes
  // the hashes, so its directories have other names; RSPACK_FULLHASH checks which compiler's file each lockfile is next to
  // and that lockfile's exact packages (expectIncludes: their union, as the directory names are not known)
  { name: 'rspack 2.2.8: two compilers, output.path with [fullhash]', fixture: 'rspack2.2-npm', cmd: RSPACK_FULLHASH, env: { RSPACK_SHARED: 'fullhash' },
    expectIncludes: SHARED, oracle: false },
  // the first compiler's asset names carry a query string ([name].js?[contenthash]): its files are still there
  { name: 'rspack 2.2.8: two compilers, one output dir, file names with a query string', fixture: 'rspack2.2-npm', cmd: 'npm run -s build',
    env: { RSPACK_SHARED: 'query' }, expect: SHARED },
  // nested: rspack's lockfile has the island's packages, found by the island's output hash in its lockfile
  { name: 'nested: Vite 8 island bundled by rspack 2.2.8', fixture: 'nested-island-rspack', cmd: 'npm run -s build', oracleArgs: 'rspack', expect: NESTED_EXPECT },
  ...[['', {}], [', resolve.symlinks=false', { EDGE_RESOLVE_SYMLINKS: 'false' }]].map(([what, env]) => (
    { name: `rspack 2.2.8: npm workspace package${what}`, fixture: 'rspack-workspace2.2', cmd: 'npm run -s build', env, expect: ['ms@2.1.3'] })),
  // Rslib: an ES module and a CommonJS build into dist/ (one lockfile); dependencies stay external (autoExternal)
  { name: 'Rslib 1.0.3: ES module and CommonJS into dist/, the bundled devDependency only', fixture: 'rslib1.0-npm', cmd: 'npm run -s build',
    expect: ['lodash-es@4.18.1'] },
  { name: 'rspack 2.2.8, yarn 4.18.1 pnpm linker', fixture: 'rspack2.2-yarn4-pnpm', cmd: 'yarn build', expect: W5 },
  { name: 'rspack 2.2.8 in a directory with "#" in its name', fixture: 'rspack2.2-c#', cmd: 'npm run -s build', expect: W5 },
  // package.json files inside packages that are no packages of their own: their files (expectSources, by the oracle)
  // are listed as the package that has them - never as preact-hooks or preact-compat (private, with versions); a
  // duet-loader or an engine.io-client without a version could not be listed at all (every key must lead to a
  // package.json with its name and version). The packages' own dependencies (debug, socket.io-parser, ...) drift: the
  // oracle gives the exact list
  ...[['webpack 5.111.1', 'edge-manifests-wp5'], ['Vite 8.3.3', 'edge-manifests-vite8'], ['rollup 4.64.2', 'edge-manifests-rollup']].map(([what, fixture]) => (
    { name: `edge: package.json files inside packages, ${what}`, fixture, cmd: 'npm run -s build',
      expectIncludes: Object.entries(MANIFESTS).map(([n, v]) => `${n}@${v}`), expectExcludes: ['preact-hooks@0.1.0', 'preact-compat@4.0.0'],
      expectSources: ['node_modules/preact/hooks/', 'node_modules/preact/compat/', 'node_modules/@duetds/date-picker/dist/loader/',
        'node_modules/socket.io-client/build/esm/', 'node_modules/engine.io-client/build/esm/'] })),
  // canaries: every marker in the output is listed (run.cjs), and every listed canary's marker is in the output: both
  // versions of bl-canary-dup, not the unused bl-canary-unused
  // canaries in files inlined into a module, no modules themselves: bl-canary-glsl's shader include (a loader's file
  // dependency, a plugin's watch file), and in style sheets bl-canary-import (@imported) and bl-canary-icon (an image
  // inlined as a data: URL) - modules of their own in webpack's and rspack's CSS, inlined by Vite's
  ...[['webpack 5.111.1', 'canary-wp5'], ['rspack 2.2.8', 'canary-rspack2.2'], ['Vite 8.3.3', 'canary-vite8'], ['Vite 7.3.7', 'canary-vite7.3.7'],
    ['rollup 4.64.2', 'canary-rollup']].map(([what, fixture]) => (
    { name: `canaries: ${what}`, fixture, cmd: 'npm run -s build',
      expect: [...CANARY_JS, ...CANARY_INLINED[fixture === 'canary-rollup' ? 'js' : 'all'], ...(fixture === 'canary-rollup' ? [] : [CANARY_URL])].sort(),
      // no bundler reports a file inlined into a module; Vite writes no source maps for CSS, and none of the image it
      // inlines: its oracle does not see the style sheets' and the image's packages (here their markers do)
      oracleMissing: fixture.startsWith('canary-vite') ? [...CANARY_INLINED.all, CANARY_URL] : CANARY_INLINED.js })),
  // esbuild: the shader include comes from an esbuild plugin's onLoad (its watchFiles); the image a style sheet inlines
  // (dataurl loader) is only among the style sheet's imports in the metafile; the oracle's source maps have no source
  // for either (their markers here show them); new URL() is left as it is
  { name: 'canaries: esbuild 0.28.2', fixture: 'canary-esbuild', cmd: 'npm run -s build', oracleArgs: '--script esbuild.mjs',
    expect: [...CANARY_JS, ...CANARY_INLINED.all].sort(), oracleMissing: ['bl-canary-glsl@1.0.0', 'bl-canary-icon@1.0.0'] },
  // Rolldown's build() and watch() (also vite build --watch on Vite 8) have no build object with the watch files, nor
  // has a plugin from the config the build rolldown() returns: the files plugins inlined, from the plugin contexts
  ...['1.2.13', '1.0.0'].flatMap(v => ['rolldown', 'build', 'watch'].map(mode => (
    { name: `canaries: Rolldown ${v} ${mode}()`, fixture: `canary-rolldown${v}`, cmd: `node rolldown.mjs ${mode}`, expect: CANARY_ROLLDOWN, oracleMissing: CANARY_INLINED.js,
      ...(mode === 'watch' && { watchBuilds: [CANARY_ROLLDOWN, CANARY_JS, CANARY_ROLLDOWN] }) }))),
  // tsdown builds with Rolldown and adds Rolldown's importGlobPlugin, named builtin:vite-import-glob: no Vite build (a
  // Vite build would list a vite package, here none is installed); the bundler is the Rolldown tsdown depends on
  { name: 'canaries: tsdown 0.22.2 (Rolldown with builtin:vite-import-glob): no Vite build', fixture: 'canary-tsdown', cmd: 'npm run -s build',
    expect: CANARY_ROLLDOWN, oracleMissing: CANARY_INLINED.js, oracleBundler: 'rolldown' },
  ...[['Vite 8.3.3', 'canary-vite8'], ['rolldown-vite 7.3.1', 'canary-rolldown-vite7'], ['Vite 7.3.7', 'canary-vite7.3.7']].map(([what, fixture]) => (
    { name: `canaries: ${what} vite build --watch`, fixture, cmd: VITE_WATCH_CANARY, expect: CANARY_VITE, oracleMissing: [...CANARY_INLINED.all, CANARY_URL],
      watchBuilds: [CANARY_VITE, CANARY_VITE.filter(p => p !== 'bl-canary-glsl@1.0.0'), CANARY_VITE] })),
  // Rolldown's plugin contexts of a shape bundle-lockfile does not know, in a build with style sheets and no build
  // object (vite build --watch): fails; STRICT=0: a warning, and the files Vite's CSS plugin inlined are not listed
  { name: 'strict: Rolldown plugin contexts of an unknown shape fail a build with style sheets (Vite 8.3.3 vite build --watch)', fixture: 'canary-vite8',
    cmd: VITE_WATCH_CANARY, nodeOptions: ROLLDOWN_SHAPE, expectError: /bundle-lockfile: the lockfile would be missing or incomplete[\s\S]*vite: Rolldown 1\.2\.\d+: could not read the files its plugins inlined \(injected fault/ },
  { name: 'STRICT=0: Rolldown plugin contexts of an unknown shape (Vite 8.3.3 vite build --watch)', fixture: 'canary-vite8', cmd: VITE_WATCH_CANARY,
    nodeOptions: ROLLDOWN_SHAPE, env: { BUNDLE_LOCKFILE_STRICT: '0' }, expectOutput: /\[bundle-lockfile\] WARNING: vite: Rolldown 1\.2\.\d+: could not read the files its plugins inlined/,
    expect: CANARY_VITE.filter(p => !UNRECORDED_WITHOUT_CONTEXTS.includes(p)), canaryUnlisted: UNRECORDED_WITHOUT_CONTEXTS,
    watchBuilds: [1, 2, 3].map(i => CANARY_VITE.filter(p => !UNRECORDED_WITHOUT_CONTEXTS.includes(p) && (i !== 2 || p !== 'bl-canary-glsl@1.0.0'))),
    oracleMissing: [...CANARY_INLINED.all, CANARY_URL].filter(p => !UNRECORDED_WITHOUT_CONTEXTS.includes(p)) },
  { name: 'canaries: rolldown-vite 7.3.1', fixture: 'canary-rolldown-vite7', cmd: 'npm run -s build', expect: CANARY_VITE, oracleMissing: [...CANARY_INLINED.all, CANARY_URL] },
  { name: 'canaries: Vite 8.3.3, plugin in the config (no NODE_OPTIONS)', fixture: 'canary-vite8', cmd: 'npm run -s build', inject: false,
    env: { VITE_PLUGIN: path.join(__dirname, '../src/adapters/rollup.cjs') }, expect: CANARY_VITE, oracleMissing: [...CANARY_INLINED.all, CANARY_URL] },
  // Parcel (parcel.html: its own style sheet, see src/parcel.js): the @imported style sheet, the images (a style sheet's
  // url(), new URL()) are assets of their own; @parcel/transformer-glsl leaves the shader's #include line as it is, so
  // nothing of bl-canary-glsl is shipped (no marker, not listed); the oracle's source maps have no source for the
  // images. Parcel's runtime resolves new URL()'s asset at run time: @parcel/runtime-js. The Sass partial and the Less
  // file its style sheets inline are no assets: their asset requests' invalidations in Parcel's request graph name them
  { name: 'canaries: Parcel 2.16.4', fixture: 'canary-parcel', cmd: 'npm run -s build', oracleArgs: 'parcel.html',
    expect: [...CANARY_JS, ...CANARY_INLINED.all.filter(p => p !== 'bl-canary-glsl@1.0.0'), CANARY_URL, '@parcel/runtime-js@2.16.4', ...CANARY_PARCEL_STYLE].sort(),
    oracleMissing: ['bl-canary-icon@1.0.0', CANARY_URL], expectVia: { asset: ['bl-canary-icon@1.0.0', CANARY_URL], style: CANARY_PARCEL_STYLE } },
  // a cached build transforms no style sheet again: the partials come from the request graph Parcel read from its cache
  { name: 'canaries: Parcel 2.16.4, a build with a cache from a build without bundle-lockfile', fixture: 'canary-parcel',
    cmd: 'NODE_OPTIONS= npm run -s build && rm -rf dist && npm run -s build', oracleArgs: 'parcel.html',
    expect: [...CANARY_JS, ...CANARY_INLINED.all.filter(p => p !== 'bl-canary-glsl@1.0.0'), CANARY_URL, '@parcel/runtime-js@2.16.4', ...CANARY_PARCEL_STYLE].sort(),
    oracleMissing: ['bl-canary-icon@1.0.0', CANARY_URL], expectVia: { style: CANARY_PARCEL_STYLE } },
  // Vite records the images a style sheet inlines as data: URLs from 6.1 on (vitejs/vite#18979), those JavaScript
  // inlines with new URL() from 7 on: before, nothing the build records names their files - their markers are in the
  // output, their packages not listed
  ...[['6.1.6', [CANARY_URL]], ['6.0.11', ['bl-canary-icon@1.0.0', CANARY_URL]], ['5.4.21', ['bl-canary-icon@1.0.0', CANARY_URL]]].map(([v, unlisted]) => (
    { name: `canaries: Vite ${v}, images inlined as data: URLs ${unlisted.length > 1 ? 'are' : 'from JavaScript are'} not recorded`, fixture: `canary-vite${v}`,
      cmd: 'npm run -s build', expect: [...CANARY_JS, ...CANARY_INLINED.all].filter(p => !unlisted.includes(p)).sort(), canaryUnlisted: unlisted,
      oracleMissing: CANARY_INLINED.all.filter(p => !unlisted.includes(p)) })),
];

// Node.js warnings any build may print ({ match: RegExp of the text after "(node:<pid>) ", why }), each one explained:
// a warning no build tool explains may come from bundle-lockfile (run.cjs checkWarnings)
const warnings = [
];

module.exports = { fixtures, cases, warnings };
