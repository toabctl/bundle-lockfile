# Tests

See [bundlers.md](../docs/bundlers.md#supported) for what is supported, and [internals.md](../docs/internals.md) for
how it works.

The type check and the linter need the development tools (`package.json`; bundle-lockfile itself has no
dependencies):

```sh
npm ci --ignore-scripts
npm run check   # tsc over src/ (JSDoc types, strict), then ESLint, then oxlint (.oxlintrc.json: the rules that need
                # the types - no promise left unhandled, no any)
```

The unit tests run anywhere, in a few seconds (CI: on Node.js 20, 22, 24 and 26). One file per area (core,
lockfile, outputs, config, strict, hooks, and one per adapter), each in a process of its own, in parallel; what they
share is in `test/unit/helpers.cjs`:

```sh
node --test test/unit/*.test.cjs
node --test test/unit/webpack.test.cjs                      # one area
node --test --test-name-pattern='^strict:' test/unit/*.test.cjs   # tests by name
```

The contract tests check the [format](../docs/format.md#fields) against syft and Trivy (both on `PATH`; CI: Wolfi's):

```sh
node --test test/contract.cjs
```

Besides the core, the unit tests cover in separate processes what timing decides in a real build:
- a webpack process that writes its output after another one has written the shared lockfile;
- processes writing one lockfile at once;
- the node shim behind wrappers, version-manager shims and symlinked install directories;
- a CommonJS bundler whose source another loader-thread hook provides (as Yarn Plug'n'Play's does), which Node.js
  loads without its CommonJS module handlers (`Module._extensions`).

## Matrix

The matrix builds real apps (`apps/`) with real installers and bundlers in a Wolfi container (see
`.github/workflows/test.yaml`):

```sh
node test/gen.cjs /tmp/fixtures      # installs fixtures (network)
node test/run.cjs /tmp/fixtures      # runs all cases (offline); optional 2nd arg: case-name regex
```

CI splits the matrix into shards that run as parallel jobs. Both scripts take:
- `--shard=<i>/<n>`: the fixtures of shard `i` of `n` and their cases ([`lib/shard.cjs`](lib/shard.cjs));
- `--fixtures=<regex>`: only the fixtures whose names match, and their cases. The Node.js 22 job uses it for the Vite,
  Rollup, Rolldown, nested, SvelteKit, peer-dependency and mixed-output fixtures, rspack 2, Rsbuild 2 and Rslib (ES
  modules, hooked through the loader thread there; also module federation, Monaco and Next.js 16 with next-rspack on
  rspack 2), the two copies of rspack, and webpack 5 and rspack 1.7 under Yarn Plug'n'Play.

### Environments

- Node.js 24 and 26 (Wolfi's `nodejs-24`, `nodejs-26`); Node.js 22 for the fixtures above; Node.js 20 for a few
  (webpack 5, Vite 8, the Rollup and Rolldown APIs, rspack 2.2). Next.js 12 itself does not build on Node.js 25 and
  later, which removed the `SlowBuffer` its compiled `jsonwebtoken` uses.
- The versions at which the hooks behave differently ([`node-versions.json`](node-versions.json), each with the
  reason): the unit tests and a few fixtures per hook path (CommonJS, Yarn Plug'n'Play, tsx, the Rollup and Rolldown
  APIs, Vite 7 and 8, rspack 2; on Node.js 20.18 those that support it) on each. Wolfi keeps the older builds of each
  line (`apk add 'nodejs-24~24.12.0'`). Pull requests run those marked `pr` (`.github/workflows/test.yaml`);
  `.github/workflows/node-versions.yaml` runs all of them weekly and on changes to the hooks.
- webpack: npm 8/9/10/11 and the npm on `PATH` (Wolfi's `npm`), npx, `turbo run` (turbo passes `NODE_OPTIONS` to its
  tasks, also in its strict env mode), direct `node_modules/.bin` calls, yarn 1, yarn 3 (Plug'n'Play), yarn 4
  (Plug'n'Play, also with the global cache, node-modules and pnpm linker), pnpm 8/9/10/11/12 (10 also with its global
  virtual store) and bun.
- Vite: npm, npx, pnpm 9/10/11 (10 also with its global virtual store), yarn 1, yarn 4 (Plug'n'Play, also with the
  global cache, node-modules and pnpm linker), bun and npm workspaces (an app built in its own directory).
- rspack: npm, npx, pnpm 10/11 (10 also with its global virtual store), yarn 1, yarn 4 (Plug'n'Play, node-modules and
  pnpm linker) and bun; Rsbuild: npm, bun, yarn 4 (Plug'n'Play); Rslib, Next.js with next-rspack: npm.
- esbuild: npm, pnpm 10, yarn 4 (Plug'n'Play).
- Parcel: npm, pnpm 10, yarn 4 (Plug'n'Play).
- yarn 2 is not tested: it calls `util.isDate`, which Node.js 23 removed, when it sets the times of zip entries from
  dates (e.g. for `file:` dependencies).

### What the cases check

A case that expects a lockfile checks every lockfile the build writes:
- it is valid for syft and Trivy: `lockfileVersion` 3, a root entry without a name, every package with a name and a
  version, every key in `node_modules/`, no Yarn virtual path as a key, every license one string;
- in the output directory (not for export-only cases): its `self` and `context` lead back to it, and every key (or its
  `locations` entry) leads to a `package.json` with that name and version (except `outside` and `unknown` keys; in
  Yarn Plug'n'Play's cache, only that the zip is there);
- with an export directory: the exported lockfiles are byte for byte the inline ones (or the inline ones are absent
  when only exported), and their records lead back to the output directory;
- no package is outside the project or of unknown location (`outside` and `unknown` in the record) unless the case
  says why (a global store or cache, copies of outputs);
- no other `package-lock.json` below the output directory (e.g. from a child compiler);
- it lists the expected packages (exactly, or including / excluding given ones);
- it lists the bundler whose code is in it (webpack, `@rspack/core`, Rollup, Rolldown, Vite, esbuild, Parcel's
  `@parcel/packager-js`; `lib/bundlers.cjs`): each a package installed in the fixture (or Next.js' webpack, at its
  version). Which one exactly, and whether one, the oracle says: each oracle adds the bundler package of its own build,
  from the fixture's installed `package.json` files (a case without an oracle needs one where its writers wrote
  JavaScript). The expected lists above leave the bundlers out, whose versions the fixtures do not all pin (Vite's
  Rollup, workbox-build's);
- it agrees exactly with an oracle (`oracles/`): an independent build per bundler that derives the packages from the
  bundler's own reporting (webpack's stats, Vite's and Rollup's source maps) and shares no code with the adapters. A
  case names the packages its oracle cannot see (CSS-only packages, fonts loaded by `url()`, copied files and service
  workers without source maps), or says why it has none;
- where a case is about particular files (a `package.json` nested in a package, Babel's ES-module helpers), the oracle's
  build has source files below them (`expectSources`): a case whose files are not bundled at all would test nothing;
- every canary in the output's bytes (gzip and brotli copies unpacked, `data:` URLs decoded) is listed, and every listed
  canary is there: the packages of the canary app (`apps/canary`, built by webpack 5, rspack 2, Vite 5.4 – 8,
  rolldown-vite, Rollup, Rolldown's API, esbuild and Parcel, also in watch mode) carry a `BLCANARY:<name>@<version>`
  string in their code, CSS and images, which shows what is shipped without the bundler's own reporting, which the
  oracles read (a package at two versions, one inside another; an unused import; CSS, which Vite's oracle does not see;
  files inlined into a module, which no bundler reports: a style sheet `@import`ed, images inlined as `data:` URLs from
  CSS and from JavaScript, a shader's `#include`). A case may name the canaries a bundler version cannot list
  (`canaryUnlisted`, e.g. Vite before 6.1 records no inlined images): exactly those must be unlisted, so the limit is
  pinned;
- if `syft` and `trivy` are on `PATH` (as in CI, which sets `BLTEST_REQUIRE_SBOM=1`: without them the run fails): each
  reads exactly those packages, each with a license and a `pkg:npm` purl (syft: from its `javascript-lock-cataloger`);
- the build printed no Node.js warning (`(node:<pid>) ...Warning: ...`) that the matrix does not expect: each expected
  one is listed with its cause (`warnings` in `matrix.cjs`, or a case's `allowWarnings`). With
  `BUNDLE_LOCKFILE_ESM_HOOKS=async` on Node.js 26 and later, `module.register()`'s deprecation (DEP0205) is required,
  elsewhere it fails the case. Nor a warning of bundle-lockfile's own (`[bundle-lockfile] WARNING: ...`) the case does
  not expect (by its `expectOutput`, or `allowOwnWarnings` with the reason): such a warning says that something is not
  listed, or not as it should be, which the lockfile alone may not show. `BLTEST_WARNINGS=collect` records every
  warning of both kinds in `<fixtures>/.warnings.jsonl` instead of checking them, to take a census;
- the ES-module entries the adapters wrap (Rollup's, Rolldown's, rspack 2's), every copy installed in the fixture, agree
  with their wrappers when Node.js loads both without bundle-lockfile
  ([`oracles/esm-entries.cjs`](oracles/esm-entries.cjs), once per fixture): the wrapper links (a `default` the module
  does not have, or one it misses, would be a SyntaxError), and has every export of the module, with the same value.

Cases can also require exact keys, the notes and warnings in the build output, and the packages after each watch
rebuild.

The other cases check that no lockfile is written, or that the build fails with a given error: bundle-lockfile's
(strict mode, below) or Next's (Next.js 15 with a second preload).

**Strict mode.** Each of these cases fails the build with bundle-lockfile's reason (the default), and with
`BUNDLE_LOCKFILE_STRICT=0` the build succeeds with a warning instead:
- a failing adapter: webpack 5, Vite 7 and 8, the `rollup` command line, the Rollup and Rolldown APIs, esbuild's
  `build()`, `context()` and `buildSync()`;
- a lockfile that cannot be written: webpack 5, Vite 8, the `rollup` command line;
- an export directory that cannot be written;
- `BUNDLE_LOCKFILE_INLINE=0` without an export directory: webpack 5, Vite 8;
- a bundled package without a `package.json` (the unit tests: also one whose `package.json` cannot be parsed).

All other cases run in strict mode, so a problem there would fail them. The unit tests cover the remaining paths:
- a lock that cannot be taken, a stale one that cannot be removed, one that is a link to nothing, one that cannot be
  made, a live one seen with a clock ahead (each in a child process with a time limit: never a busy loop);
- a lockfile that cannot be read, a copy of one that cannot be re-anchored, a `package-lock.json` another tool wrote
  (never replaced), two lockfiles at one export path;
- a compiler the plugin cannot be applied to;
- an ESM entry that cannot be wrapped, in the thread and in the loader thread (its import fails), and one of a version
  the adapter does not know;
- a bundler an adapter cannot patch (webpack, rspack, Rollup) or does not know (a compiler of another shape, Rollup
  before 2.78): its `require()` fails;
- a Node.js without ESM hooks (20.0 - 20.5) in a bundler process;
- ESM hooks that cannot be installed, in a bundler process and elsewhere;
- the exit code of a process with problems no build took.

### Cases

Besides the cases below, the matrix covers how bundle-lockfile is activated (nothing without `NODE_OPTIONS`,
`BUNDLE_LOCKFILE_DISABLE=webpack`, existing `NODE_OPTIONS` such as a heap limit kept, a default-if-unset
`NODE_OPTIONS` script), vendored copies (outside `node_modules`, inside packages, with `BUNDLE_LOCKFILE_FIRST_PARTY`
set to `<fixture>/lib/**` and to `/**`, with the notes and warnings expected), copies of outputs made with `cp` (a
Vite build into a copy of another output, a copied island bundled by webpack 5), and builds that read another
process's `locations` (a second build, then the first one again).

**webpack**, besides installers and versions (also webpack 4 with pnpm):
- a build script in TypeScript run by tsx (`tsx build.ts`, `node --import tsx build.ts`: tsx compiles webpack's
  modules itself), a project directory with `#` in its name (also rspack)
- a `webpack.config.ts` through ts-node, @swc/register and esbuild-register (an enum: Node.js' type stripping cannot
  load it, webpack-cli falls back to the register hook) and through type stripping (22.18+); rspack's `rspack.config.ts`
  through ts-node
- tracing agents next to bundle-lockfile (also Vite 8 and rspack 2): OpenTelemetry's loader (`hook.mjs`, before and
  after the `--require`) and dd-trace (`--import initialize.mjs`, `--import register.js`, `--require init` before and
  after); yarn 4's package maps (also Vite 8; Node.js 24.20+ / 26.4+)
- a development build; watch-mode rebuilds (as in every watch case but the failing rebuild: one without an import,
  whose packages must leave the lockfile, then one with it again); warm builds from webpack's persistent cache (also
  with child compilers)
- `BUNDLE_LOCKFILE_FILE`, a failing adapter, the export directory with and without the inline lockfile (export only
  also for Next.js 16), build scripts that overwrite `NODE_OPTIONS` (inline and with `cross-env`) with the node shim
  under npm, pnpm, yarn 1, yarn 4 and bun
- npm aliases and one version at several paths, Yarn's global cache, packages with peer dependencies (Yarn
  Plug'n'Play's virtual paths, pnpm's peer-suffixed directories; also with Vite), workspace packages (also with
  `resolve.symlinks: false`), project directories as dependencies (`file:` with npm, pnpm and yarn 4, `link:` with
  pnpm and yarn 4, `portal:`), subpath manifests, externals and a `context` below the project root
- `package.json` files inside real packages that are no packages of their own (preact's private `hooks/` and
  `compat/`, `@duetds/date-picker`'s `dist/loader/` without a version, socket.io-client's and engine.io-client's
  `build/esm/`), built by webpack 5, Vite 8 and Rollup
- Babel-injected helpers, CSS and asset modules from packages (also webpack 5's native CSS and `asset/inline`, and a
  JavaScript module from a `data:` URL), style
  sheets loaders inline from packages (Sass, Less, Tailwind via PostCSS; webpack 4 and 5, also from the persistent
  cache), vanilla-extract's virtual CSS modules
- module federation (a host, a remote, a shared package), a DLL, nested and inlined worker-loader workers (webpack 4
  and 5), a workbox service worker (InjectManifest, and GenerateSW's generated one), Sass from a package in a Vue
  single-file component's style block, a package image inlined as a `data:` URL into extracted CSS, a package file
  copied into the output with fs in `afterEmit`, html-webpack-plugin 4 and 5 templates, a package file and a package directory copied
  by copy-webpack-plugin (5, 6.0 and 6.4 on webpack 4, 6.2 and 14 on webpack 5)
- two compilers sharing an output directory (also with query strings in file names, configs that differ only in
  `resolve.alias`, and a failing watch rebuild); two compilers whose `output.path` with `[fullhash]` resolves to
  different directories; compression-webpack-plugin deleting the original assets (webpack 4 and 5, also of two
  compilers sharing an output directory, one of them run again by another process)
- two webpack processes writing to one directory: in parallel, with one rebuilt, one after the other with the second
  cleaning the first's files (also keeping them with `clean.keep`), and with the plugin in the config instead of
  `NODE_OPTIONS`; a webpack and a Vite process writing to one directory
- an in-memory output file system (memfs, as webpack-dev-middleware uses; also with compression-webpack-plugin 6
  deleting the lockfile asset on webpack 4)
- the devDependencies case with npm also runs, when syft is on `PATH` (as in CI), a functional SBOM check: it stages
  the build output like a package would install it (`usr/share/app/dist/`), runs `syft scan dir:` with SPDX JSON
  output, and requires exactly the expected npm packages with name, version, purl, declared license and source file —
  once with only the build output, and once with the project's own `package-lock.json` shipped alongside

**Vite**:
- Vite 8 with npm, npx, pnpm 9, 10 (also its global virtual store) and 11, yarn 1, yarn 4 (Plug'n'Play, also with the
  global cache, and node-modules linker), bun and an app of an npm workspaces monorepo; Vite 7 with npm and yarn 4
  Plug'n'Play; Vite 6 and 5 with npm (also their watch mode and vite-plugin-singlefile); rolldown-vite 7 (also its
  watch mode)
- the loader-thread hooks also on Node.js 24 and 26 (`BUNDLE_LOCKFILE_ESM_HOOKS=async`); a programmatic build from a
  package without a dependency on Vite, in a project that has it installed (hooked on every version)
- `vite dev` (dependency pre-bundling, also into a `cacheDir` outside `node_modules`), `vite preview` and Vitest write
  no lockfile ([`lib/vite-servers.cjs`](lib/vite-servers.cjs))
- `vite build --watch`, `BUNDLE_LOCKFILE_DISABLE=vite` (and `rollup,rolldown`, which leaves Vite hooked; with
  SvelteKit and adapter-node, whose own Rollup build stays hooked), `BUNDLE_LOCKFILE_FILE`, a failing adapter (also in
  Rollup and Rolldown builds), the export directory, a build script overwriting `NODE_OPTIONS` (without and with the
  node shim), the plugin in the config (also with workers, `@import`s and `NODE_OPTIONS`)
- vite-plugin-singlefile, `build.write: false`, library mode with two formats, SSR builds (dependencies external, and
  bundled with `ssr.noExternal`), `vite build --app` (Vite 6 and 8), two `vite build` processes writing one output
  directory
- nested bundles: a Vite-built island bundled by webpack 4 and 5 (also changed after its build; webpack 5 also an
  island built by Vite 7 and one built by Rolldown's API), by Vite 8 (an island built by Vite 8) and by Vite 7 (an
  island built by `rollup -c`); the island as a workspace package bundled by webpack 5 (also with `resolve.symlinks:
  false`) and Vite 8 (with `resolve.preserveSymlinks`); the island's lockfile only in the export directory; an island
  of several chunks and a style sheet bundled whole by Vite 8, and in parts by Vite 8 (only its style sheet, only its
  JavaScript) and webpack 5 (only its JavaScript)
- an app with a worker, an inlined worker, a CSS `@import`, a Sass partial and a Less `@import` from packages,
  @vitejs/plugin-legacy, vite-plugin-pwa (generateSW; injectManifest on Vite 7 and 8) and vite-plugin-static-copy
  (Vite 6, 7 and 8), Tailwind CSS 4 with @tailwindcss/vite, and a Vite root that is not the working directory, with a
  font from a package loaded by `url()` (Vite 7 and 8)

**Rollup and Rolldown**:
- the `rollup` command line (also `rollup -c -w`, a TypeScript config, and two configs of one input each with its own
  `output.file` in one directory); `BUNDLE_LOCKFILE_FILE=package-lock.json` with an output in the project's directory
  (its own lockfile is not replaced, the build fails)
- builds through Rollup's and Rolldown's JavaScript APIs: `rollup()`, `rolldown()` (also its `write()` without `dir`
  or `file`; two `write()`s of one build, with a file copied into the first output before `close()`), Rolldown's
  `build()`, `watch()` of both; two outputs of one build written into one directory at the same
  time; a project directory with `#` in its name; two builds with the plugin in their options (no `NODE_OPTIONS`) into
  one directory; `BUNDLE_LOCKFILE_DISABLE=rollup` / `rolldown`, each leaving the other hooked
- Rollup 4.0.2, Rolldown 1.0.0 and `@rollup/wasm-node` (its API and its command line)
- no lockfile from the `rolldown` command line (not supported yet), and webpack and Vite builds in Bun's own runtime
  (`bun --bun`; the builds are not affected)

**esbuild** (`apps/esbuild`, compared with an oracle that builds again with esbuild's source maps,
`oracles/esbuild.cjs`; the font, an asset, has none):
- `build()`, `context()` with `rebuild()`, `watch()` (a rebuild without an import, whose packages must leave the
  lockfile, then one with it again), `outfile`, `buildSync()`, two builds into one directory, `write: false` (no
  lockfile), the export directory only, `BUNDLE_LOCKFILE_DISABLE=esbuild`; a Sass partial from bulma that
  esbuild-sass-plugin inlines, and a package file another plugin copies into the output in its `onEnd`; the command
  line (no lockfile) and its metafile read by `bin/bundle-lockfile-from-metafile`
- esbuild 0.17.0 (the oldest supported), 0.19.12, 0.28.2, esbuild-wasm; esbuild 0.16 fails the build (a warning with
  `BUNDLE_LOCKFILE_STRICT=0`); SvelteKit 2's adapter-netlify edge function, which esbuild bundles
- Vite 5 – 7, which build with esbuild themselves (dependency pre-bundling, the config file), are unchanged

**Parcel** (`apps/parcel`, compared with an oracle that builds again with Parcel's source maps, `oracles/parcel.cjs`;
the font has none):
- `parcel build`, the JavaScript API's `run()` (also two Parcels one after the other into one directory) and `watch()`
  (a rebuild without an import, then with it again), a build
  with a cache from a build without bundle-lockfile, the export directory only, `BUNDLE_LOCKFILE_DISABLE=parcel`, a
  failing adapter
- Parcel 2.8.3 (before 2.13, which fails a build with a reporter's error: the process fails at its exit; the older
  shape of Parcel's request graph) and 2.16.4, npm, pnpm, yarn 4 Plug'n'Play; the canary app
**Angular** (`apps/angular`, an application builder app with three lazy chunks, which turn on Angular's chunk
optimizer, and an asset glob from `node_modules`; compared with an oracle that builds again with source maps of the
sources, not the packages' own, and without the chunk optimizer, whose maps name no sources, `oracles/angular.cjs`):
- `ng build` of Angular 20.3, 21.2, 22.2; without the chunk optimizer; the export directory only;
  `BUNDLE_LOCKFILE_DISABLE=angular`

**rspack** (the `rspack` app is webpack 5's, with `rspack.config.js`) and **Rsbuild**, compared with an oracle that
builds again through rspack's or Rsbuild's API without bundle-lockfile, without minimizing (so that copies keep their
bytes) and without inlining exports (so that the modules of packages whose constants rspack inlines stay in chunks),
and reads the stats:
- rspack 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 2.0, 2.1 and 2.2 with npm; 1.7 and 2.2 also with pnpm 10, yarn 1, yarn 4
  (Plug'n'Play and node-modules linker) and bun; 2.2 also with pnpm 11 and pnpm 10's global virtual store; rspack 1.0
  fails the build (with `BUNDLE_LOCKFILE_STRICT=0`: a warning, no lockfile)
- `npx rspack`, `node_modules/.bin/rspack`, `rspack()` from a CommonJS and from an ES module script, and from a package
  that does not depend on rspack, in a project that has it installed (hooked on every version)
- activation (`BUNDLE_LOCKFILE_DISABLE=rspack`, `=webpack` leaving rspack hooked, existing `NODE_OPTIONS`,
  `BUNDLE_LOCKFILE_FILE`), a failing adapter, a development build, watch-mode rebuilds, warm builds from the persistent
  cache, externals
- native CSS and extracted CSS from packages (with a Sass partial and a Less `@import`: per module from rspack 1.3.14,
  from the file dependencies before), an asset from a package, a worker, `CopyRspackPlugin` copying a package file, a
  package directory, a glob in a package, a package file it transforms (the oracle, which matches copies by bytes,
  does not see it), a package style sheet its CSS minimizer changes after the copy, and first-party files, packages
  whose constants rspack inlines (1.7 and 2.x)
- `HtmlRspackPlugin` (1.7, 2.2); two compilers into two directories, into `dist/[fullhash]` (the oracle's hashes
  differ: the case checks which compiler's file each lockfile is next to), into one directory (also with a query
  string in file names); two processes into one directory (in parallel, then one again, the second cleaning it, also
  keeping the other's file); the plugin in the config; an rspack and a webpack process into one directory; an
  in-memory output file system; the export directory with and without the inline lockfile; build scripts overwriting
  `NODE_OPTIONS` with the node shim (npm, pnpm, yarn 1, yarn 4, bun; also `cross-env`); a lockfile that cannot be
  written and a package that cannot be listed (strict mode)
- two copies of `@rspack/core` in one process (OHIF's shape: rspack 1 for the config's plugins, rspack 2 for the
  compiler)
- Rsbuild 1.1, 1.2, 1.6, 1.7 and 2.2 (npm; 2.2 also with bun and yarn 4 Plug'n'Play), with `output.copy`; environments
  web and node (into `dist/` and `dist/server/`; 1.7 and 2.2)
- module federation (rspack's plugin on 1.7 and 2.2, `@module-federation/enhanced`'s on 2.2): a host, a remote, a
  shared package, the federation runtime; tree shaking of the shared package, which rspack builds again in compilers
  of its own (their lockfiles are not compared with the oracle, which builds the config's compilers)
- Monaco with monaco-editor-webpack-plugin (1.2 and 2.2): its workers built in child compilations (one with a package
  only there), Monaco's editor worker and a worker of the app's own started with `new Worker(new URL(...))`
- webpack into `dist/` and rspack into `dist/rspack/`, cleaning its directory (Grafana's build), each run again
- a Vite-built island bundled by rspack 2.2; an npm workspace package (also with `resolve.symlinks: false`)
- `rspack serve` (1.7, 2.2) and `rsbuild dev`: the lockfile they serve from memory, nothing written to `dist/`
  ([`lib/dev-server.cjs`](lib/dev-server.cjs); the dev server's client listed, lazily compiled imports not, no oracle);
  `rspack serve` with `writeToDisk`: the lockfile in `dist/`; Rstest (0.12) leaves no lockfile in the project; Rslib
  1.0 (an ES module and a CommonJS build into one directory, compared with an oracle that builds through Rslib's API)

**SvelteKit** 2 and 3, each with adapter-static, adapter-node and adapter-netlify (serverless and edge functions), are
compared with an oracle that builds again with source maps into other directories and follows the maps of the files
the adapters bundle again — except SvelteKit 2's edge function (built by esbuild, no lockfile) and adapter-node with
`BUNDLE_LOCKFILE_DISABLE=vite`. A server dependency must not be listed, except in an edge function, which bundles it.

**Next.js** 12–16 are compared per compiler output with webpack's stats, and the server's runtime packages
(`.next/runtime/`) with the packages of the oracle build's own `.nft.json` traces (`oracles/next.cjs`, mapped by
`oracles/owner.cjs`):
- a Pages Router app on each
- on 15 and 16: an App Router app with server and client components, an edge route handler and middleware
- with next-rspack (15.5: rspack 1.4; 16.4: rspack 2.0): the Pages Router app on both, the App Router app on 16, with
  exactly the lockfiles of the webpack builds
- on 16: a static export (`output: 'export'`), a standalone output (`output: 'standalone'`: the runtime packages and
  copies of the bundles' lockfiles), a warm build from `.next/cache`, a Turbopack build (fails in strict mode)
- on 15 and 16, `apps/next-runtime`: canaries the server requires at request time (one only through a deep `.cjs`
  require, of which Next copies no `package.json` into `.next/standalone`), one it bundles; in the standalone output
  also with Turbopack (`BUNDLE_LOCKFILE_STRICT=0`: the runtime packages only). The standalone server is started with
  `oracles/runtime-tracer.cjs` and every route requested (`runtimeTrace`): each package it loads from `node_modules`
  must be listed - a lower bound that does not rely on Next's traces
- another `--require` preload next to bundle-lockfile's (Next 15 fails, see
  [bundlers.md](../docs/bundlers.md#nextjs); 16.4 builds)

## rspack on real projects

`test/compare/rspack-stats.cjs` (a preload that loads bundle-lockfile) records, for every rspack compiler
bundle-lockfile attaches to, the packages of rspack's own stats: the oracles' code (`oracles/stats.cjs`, `owner.cjs`),
which shares nothing with the adapter's collection. `test/compare/report-rspack.cjs` compares them with the lockfiles,
per output directory:

```sh
NODE_OPTIONS="--require <repo>/test/compare/rspack-stats.cjs" BLTEST_TRUTH_DIR=/tmp/truth <build command>
node <repo>/test/compare/report-rspack.cjs /tmp/truth [<export dir> <export base>]
```

Run on the seven Chainguard packages that build with rspack (2026-10-12; recipe versions and steps, Wolfi, strict
mode). Every build passed; no lockfile missed a package of the stats; syft and Trivy read exactly the lockfiles'
packages; the build output was byte-identical with and without bundle-lockfile:

| Project | rspack / Rsbuild | Node.js, package manager | Lockfile = stats | Only in the lockfile | Build time |
|---|---|---|---|---|---|
| redpanda-console 3.12 | 2.2.1 / 2.2.1 | 22, bun (node shim, export directory) | 307 of 309 | tailwindcss, tw-animate-css (inlined by @tailwindcss/postcss) | +8.7 % (Node.js 22's loader thread) |
| redpanda-console 2.8 | 1.2.8 / 1.2.19 | 22, bun (node shim, export directory) | 398 of 400 | the same (tw-animate-css 1.2.4 emits nothing: one too many) | +1.6 % |
| calico-whisker (calico 3.32) | 1.1.8 / 1.1.10 | 24, yarn 1 | 94 of 95 | tailwindcss (inlined) | +0.7 % |
| calico-whisker (calico 3.30) | 1.7.8 / 1.7.3 | 24, yarn 1 | 71 of 71 | – | +0.1 % |
| kiali 2.33 | 2.2.7 / 2.2.9 | 26, yarn 4 (export directory) | 271 of 271 | – | rsbuild +4.5 %, the build command +0.3 % |
| perses 0.54 | 2.0.1 | 26, npm, turbo (`--env-mode=loose` or the settings file; export directory) | 155 of 155 | – | about +3 % |
| ohif-viewer 3.13 | 2.0.3 (and 1.7.11: three copies of `@rspack/core`) | 26, pnpm (node shim: cross-env) | 269 of 269 | – | +1.9 % |
| opensearch-dashboards 3.8 | 2.0.8 (31 optimizer workers, 61 bundles) | 22, yarn 1 | 1,201 of 1,250 in 63 outputs | the OUI theme's and @elastic/charts' Sass partials, css-loader's runtime (shipped; rspack's stats call it an orphan) | none measurable |
| metabase 0.63 | 2.0.3 (two compilers, a second process) | 22, bun, Clojure (node shim and the settings file: the build replaces the environment) | 413 of 413, 4 of 4 | – | none measurable |

What they found, fixed since: a package's `require('punycode')` warned with the preload (OpenSearch Dashboards
exits on any warning), a first-party copy named like a package file was attributed to that package, matching copies
by name cost seconds on OHIF, and an output directory another plugin removed after the build was recreated for its
lockfile (Metabase). Not found by any tool: third-party code committed into a project's own directories without a
`package.json` (OHIF's `public/es6-shim.min.js`).

## Real projects before and after the 2026-10-13 changes

Four Chainguard projects (recipe versions, Wolfi, Node.js 22, strict mode), each built three times: without
bundle-lockfile, with d2d8d4a (before PRs #39 – #72) and with b6cfed4 (after them). The lockfiles of the two were
compared per output; every difference is explained (2026-10-14):

| Project | Bundler | Lockfiles before → after | Packages before → after | Differences | Build time: none / before / after |
|---|---|---|---|---|---|
| Superset 6.1.0 | webpack 5.105.4 | 1 → 1 | 545 → 546 | `webpack` (its runtime is in all 244 chunks) | 60.3 / 56.6 / 54.5 s |
| Headlamp 0.45.0 | Vite 6.4.3 (Rollup 4.60.1) | 1 → 1 | 236 → 238 | `vite` (its preload runtime is in the output) and `rollup` | 37.1 / 37.9 / 36.9 s |
| calico-whisker (calico 3.32.2) | Rsbuild 1.1.10, rspack 1.1.8 | 1 → 1 | 95 → 96 | `@rspack/core` | 10.9 / 11.2 / 11.0 s |
| mailpit 1.31.4 | esbuild 0.28.2 | 0 → 1 | 0 → 22 | esbuild was not hooked before; the 21 packages other than `esbuild` are exactly those of the build's own metafile | 2.1 / 1.9 / 2.0 s |

The differences are the bundler packages whose code is in the output (PR #69) and the newly hooked esbuild (#46,
#57): no package was dropped, none was added otherwise. The build times are within the noise of the shared machine.
LibreChat 0.8.8 was not compared: its recipe's install steps did not reproduce outside its build environment (its
Vite build fails without bundle-lockfile too).

## Comparison with other tools

`test/compare/` runs other tools that list a build's packages next to bundle-lockfile, without config changes, and
reports per output the packages only one side lists - each explained from data the tools do not share with
bundle-lockfile. Not a test: it never writes expectations, and runs by hand, not in CI:

| bundler | tools | attached by |
|---|---|---|
| webpack 5, Next.js | [`@cyclonedx/webpack-plugin`](https://github.com/CycloneDX/cyclonedx-webpack-plugin) 5.3.3, [license-webpack-plugin](https://github.com/xz64/license-webpack-plugin) 4.0.2, [webpack-license-plugin](https://github.com/codepunkt/webpack-license-plugin) 4.5.1 | `inject-webpack-tools.cjs`: bundle-lockfile's own compiler hook, so all see the same compilers |
| Vite, Rollup | [rollup-plugin-license](https://github.com/mjeanroy/rollup-plugin-license) 3.7.1, [rollup-plugin-sbom](https://github.com/janbiasi/rollup-plugin-sbom) 4.0.1, Vite 8's `build.license` | `vite.compare.mjs`, `rollup.compare.mjs`: the fixture's config plus the tools |

```sh
sh test/compare/fixtures.sh /tmp/fixtures [fixture-regex]   # the fixtures it lists (31); exit 1: a difference is unexplained
node test/compare/manifest-survey.cjs <dir>...               # every package.json inside an installed package, and what the rule makes of it
```

The explanations come from the bundler's own data and the files on disk, never from bundle-lockfile's code: webpack's
stats through the oracles' code (`oracles/stats.cjs`, `owner.cjs`), the modules each build parsed and put into chunks
(`diag-rollup.cjs`), the files each license plugin reads from webpack's chunk graph, the package.json files a
nearest-manifest tool sees (`manifests.cjs`), the `@import`s of style sheets, the Vite/Rollup oracle's build, and files
of a package that are in the output byte for byte. A build one of the tools breaks is built again without it, and the
tool is named. In the last run (2026-10-13, 31 fixtures) every difference was explained:

| tool | outputs | in both | only bundle-lockfile | only the tool |
|---|---|---|---|---|
| @cyclonedx/webpack-plugin | 26 | 73 | 11 | 12 |
| license-webpack-plugin | 18 | 31 | 27 | 10 |
| webpack-license-plugin | 23 | 74 | 5 | 7 |
| rollup-plugin-license | 9 | 28 | 20 | 0 |
| rollup-plugin-sbom | 9 | 35 | 13 | 4 |
| Vite's `build.license` | 5 | 18 | 13 | 0 |

- **The tools list packages that are not shipped:** tree-shaken ones (`uuid`) and build-time ones (`css-loader`,
  vanilla-extract's plugin; CycloneDX takes every module webpack processed), packages of child compilations that run at
  build time (html-webpack-plugin's template: both license plugins), first-party workspace packages, and package.json
  files inside packages as packages: `preact-hooks@0.1.0`, `preact-compat@4.0.0` (CycloneDX, both license plugins,
  rollup-plugin-sbom), `duet-loader` without a version (license-webpack-plugin).
- **The tools miss shipped packages:**
  - license-webpack-plugin: every package whose files are only inner modules of concatenated ES modules (`lodash-es`,
    `yallist` 5, socket.io's packages, the canaries): it reads them by their stats identifiers, `javascript/esm|<path>`
    ([#116](https://github.com/xz64/license-webpack-plugin/issues/116)); and a second version of a package (one per
    name, [#135](https://github.com/xz64/license-webpack-plugin/issues/135); also rollup-plugin-license by default)
  - webpack-license-plugin: a package whose files are only leaf modules of a concatenation (worker-loader's inline
    runtime): it reads a concatenation's root module and where its imports come from
  - rollup-plugin-license: modules that render no bytes of their own (`normalize.css` imported from JavaScript)
  - all Vite/Rollup tools: style sheets `@import`ed from packages (`sanitize.css`, `bulma`, `normalize.less`), builds
    that write nothing themselves (workers, plugin-legacy's polyfills, vite-plugin-pwa's service worker), files copied
    into the output (vite-plugin-static-copy) and a worker's font the main build emits again
  - CycloneDX, the license plugins: with two compilers writing to one directory, the last one's list wins; workers,
    workbox's service worker and copy-webpack-plugin's copies (CycloneDX)
- **The tools fail builds:** license-webpack-plugin with `ENOENT: scandir ''` in `processAssets` on a DLL build and on
  Next.js 15 and 16; webpack-license-plugin with "Could not find license info" for a first-party package without a
  license (an npm workspace, the project itself through webpack's `context`, unplugin's virtual module).

The manifest survey of the matrix fixtures (3,223 package.json files inside packages, ~100 fixtures): every one the
rule takes as a vendored copy is one (`next/dist/compiled/*`, `@rspack/core/compiled/*`), except `needle`'s
`examples/stream-multiple` (`express-needle@1.0.0`), which no build bundles. The other shapes - no name, a name
without a version, private, a name with a slash - are the ones `test/unit/core.test.cjs` tests.

`test/bigproject/superset.sh` runs the same comparison on Apache Superset's frontend, measures the build cost and
compares syft's counts on the output with those on the project's lockfile.
