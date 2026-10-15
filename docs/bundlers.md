# Bundlers

What is supported and tested, which processes are hooked, and what is particular to each bundler. Usage is in the
[README](../README.md); what a lockfile lists in [coverage.md](coverage.md).

## Supported

| Bundler | Versions | Tested (matrix) | Hooked through | Notes |
|---|---|---|---|---|
| webpack | 4, 5 | 4.0, 4.47, 5.0, 5.60, 5.111 | CommonJS: webpack's `Compiler` | webpack < 4 is not hooked |
| Next.js | 12 – 16 | 12.3, 13.5, 14.2, 15.5, 16.4 (App Router: 15.5, 16.4) | CommonJS: its vendored webpack | Next 16 only with `next build --webpack`; [details](#nextjs) |
| Next.js with next-rspack | 15, 16 | 15.5 (rspack 1.4), 16.4 (rspack 2.0) | as rspack | the same lockfiles as with webpack |
| rspack | 1.1 – 1.7, 2 | 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 2.0, 2.1, 2.2 | rspack 1: CommonJS; rspack 2: ESM hook | rspack 1.0 fails the build, 0.x is not hooked; [details](#rspack-rsbuild) |
| Rsbuild, Rslib | Rsbuild 1.1 – 1.7, 2; Rslib 1 | Rsbuild 1.1, 1.2, 1.7, 2.2; Rslib 1.0 | as rspack | `rsbuild dev` serves the lockfile from memory |
| Vite | 5, 6, 7 (Rollup 4), 8 (Rolldown); rolldown-vite 7 | 5.4, 6.4, 7.3, 8.3; rolldown-vite 7.3 | ESM hook | `vite dev`, `vite preview` and Vitest write no lockfile; [details](#vite-rollup-rolldown) |
| SvelteKit | 2 (Vite 7), 3 (Vite 8) | 2.70, 3.0 | as Vite | adapter-static, adapter-node, adapter-netlify; [details](#sveltekit) |
| Nuxt | 4 (Vite 8, Nitro 2) | 4.6 | as Vite | `nuxt build`, `nuxi build`; [details](#nuxt) |
| Rollup | 4 (also `@rollup/wasm-node`) | 4.0, 4.64 | CommonJS (`require`, the `rollup` command line); ESM hook (`import`) | |
| Rolldown | 1 | 1.0, 1.2 | ESM hook | `rolldown()`, `build()`, `watch()`; not the `rolldown` command line |
| esbuild | 0.17 and later (also esbuild-wasm) | 0.17, 0.19, 0.28 | CommonJS: its API (`lib/main.js`) | `build()`, `context()` (rebuilds, `watch()`), `buildSync()`; not the `esbuild` command line; 0.16 and older fail the build; [details](#esbuild) |
| Parcel | 2 | 2.0 (with the 2.16 plugins its ranges install), 2.16 | CommonJS: `@parcel/core`'s `Parcel` | `parcel build`, `parcel watch`, its JavaScript API; [details](#parcel) |
| Angular | 20 – 22 (application builder) | 20.3, 21.2, 22.2 | CommonJS: its `executeBuild()` | `ng build`; the lockfile in `<outputPath>/browser/` (SSR: also `server/`; i18n: each locale's directory); `ng serve` writes none; [details](#angular) |

- **Hooked through:** CommonJS bundlers are hooked in every process. ES modules need Node.js's ESM hook, which on
  older Node.js versions only some processes get ([which processes](#which-processes-are-hooked)).
- **Watch mode** (webpack, rspack, Rollup, Rolldown, `vite build --watch`, esbuild's `watch()`) writes the lockfile
  after every rebuild.
  The dev servers of rspack (`rspack serve`, `rsbuild dev`) serve it from memory (webpack's dev server goes the same
  way, through its in-memory output file system, but is not tested).
- **Node.js:** 20.18 or later, the oldest that is tested (Vite 7 and 8, Rolldown, rspack 2 and Rsbuild 2 need 20.19).
  Builds are tested on 24 and 26, and on 22 for the bundlers hooked as ES modules (Vite, Rollup, Rolldown, SvelteKit,
  rspack 2, Rsbuild 2, Rslib, next-rspack 16) and for webpack 5 and rspack 1.7 under Yarn Plug'n'Play; a few on 20. The
  unit tests and a few builds per kind of hook also run on the releases at which the hooks behave differently, from
  20.18.2 to 26.4.0 ([which](../test/node-versions.json)). Node.js 25 and Linux distributions other than Wolfi are not
  tested. Next.js 12 does not build on Node.js 25 and later.
- **SBOM tools:** every lockfile of the matrix is read by syft and Trivy (Wolfi's current versions; [which
  scans](../README.md#sbom-tools)).

Package managers tested ([details](../test/README.md#environments)):

| | |
|---|---|
| webpack | npm 8 – 12, npx, pnpm 8 – 12, yarn 1, yarn 3 (Plug'n'Play), yarn 4 (Plug'n'Play, node-modules, pnpm), bun, `turbo run`, npm workspaces |
| rspack | npm, npx, pnpm 10 – 11, yarn 1, yarn 4 (Plug'n'Play, node-modules, pnpm), bun, npm workspaces |
| Rsbuild | npm, bun, yarn 4 (Plug'n'Play) |
| Vite | npm, npx, pnpm 9 – 11, yarn 1, yarn 4 (Plug'n'Play, node-modules, pnpm), bun, npm workspaces |
| Next.js, SvelteKit, Rollup, Rolldown, Rslib | npm (the `rollup` command line also yarn 4 Plug'n'Play and pnpm) |
| esbuild | npm, pnpm 10, yarn 4 (Plug'n'Play) |
| Nuxt | pnpm 10 |
| Parcel | npm, pnpm 10, yarn 4 (Plug'n'Play) |
| Angular | npm, pnpm 10, yarn 4 (Plug'n'Play) |
| Angular | npm |

Real builds of seven Chainguard packages with rspack and Rsbuild are compared with rspack's own stats in
[test/README.md](../test/README.md#rspack-on-real-projects).

Recognized, not hooked — the build fails (`BUNDLE_LOCKFILE_STRICT=0`: a warning, and no lockfile of the bundle; a
Turbopack build still gets [Next.js' runtime lockfile](#nextjs)): Turbopack (Next.js 16's default build; known when
`next build` ends), the `rolldown` command line, `@vercel/ncc` (when it loads: it runs a webpack of its own), webpack
< 4 and rspack 0.x (when a compiler compiles).

Not hooked — no lockfile, and no failure: the `esbuild` command line and Go API (a binary, not Node.js), Bun's own
runtime (`bun --bun`, `Bun.build`, and `bun run` where Node.js is not installed).

## Which processes are hooked

The CommonJS bundlers — webpack (also Next.js' copy), rspack 1, Rollup's CommonJS build (`require('rollup')`, the
`rollup` command line), esbuild's API (also through `import`), Parcel's `@parcel/core` — are hooked in every process
that preloads bundle-lockfile. The ES-module bundlers — Vite,
which imports Rollup and Rolldown as ES modules, Rolldown, rspack 2, Rollup through `import` — need a Node.js ESM
hook:
- Node.js 22.22.3, 24.11.1, 25.1 and later: hooked in every process.
- Older versions: hooked only in processes (their main thread and worker threads)
  - whose main script belongs to a package that is or depends on `vite`, `rollup`, `rolldown`, `rolldown-vite`,
    `@rspack/core`, `@rspack/cli` or `@rsbuild/core` (the `vite` command, a build script of a project using Vite), or
  - whose project has one of them installed (in `node_modules` of the working directory or above: `nuxi`, `storybook`,
    which load Vite through a dependency), or
  - that have another loader hook (e.g. Yarn Plug'n'Play's).

  A programmatic build from elsewhere needs `BUNDLE_LOCKFILE_ESM_HOOKS=async` (without, it fails the build). A
  `require('@rspack/core')` anywhere in the process (a CommonJS config) hooks rspack 2 anyway. The loader thread these
  versions use costs time: redpanda-console's Rsbuild 2 build took 8.7 % longer on Node.js 22; each worker thread of
  such a process starts one more (60 – 300 ms for a Vite build in a worker).

Every process logs how ES modules are hooked with `BUNDLE_LOCKFILE_DEBUG=1`, e.g. `ESM hooks: sync (Node 24.21.0)`.
The details are in [internals.md](internals.md#vite-rollup-rolldown).

## Every bundler

Each output with a JavaScript file lists the bundler whose own code is in it, at the copy that ran
([what is listed](coverage.md#also-listed)): webpack (Next.js' copy as `node_modules/next/dist/compiled/webpack`),
`@rspack/core`, Rollup or Rolldown, and for a Vite build also `vite` (or `rolldown-vite`), esbuild (for Angular, the
esbuild its builder runs), Parcel's `@parcel/packager-js`. Its version is its `package.json`'s; a copy without one
(Next.js') has the version the bundler reports. A bundler bundle-lockfile cannot place fails the build (strict mode).

## Vite, Rollup, Rolldown

- Vite 8's dependency pre-bundling (`vite dev`) is never hooked, wherever its cache directory (`cacheDir`) is.
- `vite dev`, `vite preview` and Vitest ship nothing and write no lockfile.
- The files Vite's and other plugins inline into a module (style sheets `@import`ed from packages, images inlined as
  `data:` URLs): Rollup's watch files (Vite 5 - 7), and in Rolldown builds (Vite 8, rolldown-vite) the plugins'
  `this.addWatchFile` calls, recorded per build and module - also in Rolldown's `build()` and `watch()` (`vite build
  --watch` on Vite 8), which provide no watch files. A Rolldown whose plugin contexts are of another shape fails a
  build with style sheets ([troubleshooting](troubleshooting.md)).
- A Vite 8 build logs `vite: adding the plugin to a rolldown() call` with `BUNDLE_LOCKFILE_DEBUG=1` (Vite 7:
  `rollup()`).

## rspack, Rsbuild

rspack implements webpack's plugin API, and its builds get the same plugin as webpack's: every top-level compiler
writes a lockfile into its output directory, also when the same output directory is shared or when the build runs in
watch mode. Every copy of `@rspack/core` a process loads is hooked: the `rspack` command line, `rsbuild build`, and
other tools that create their compilers with `@rspack/core` (tested: the command line, `rspack()` from a script,
Rsbuild, Rslib, Next.js with next-rspack).

- rspack 1 is a CommonJS module and is hooked in every process. rspack 2 is an ES module, which needs the ESM hook
  ([which processes](#which-processes-are-hooked)).
- Files `CopyRspackPlugin` copies out of packages are listed, by name and bytes among the files the build depends on.
- Style sheets loaders inline from packages (Sass partials, Less `@import`s, PostCSS) are listed; before rspack
  1.3.14, rspack does not record them per module, and all such style sheets the build read are listed.
- rspack 2 inlines small constants in production (`optimization.inlineExports`; rspack 1.7 too, through
  `experiments.inlineConst`, on by default there): a module whose used exports are all inlined is in no chunk. Its
  package is listed anyway — its values are in the bundle.
- Child compilations count for their parent, as webpack's: the workers monaco-editor-webpack-plugin builds are in
  its lockfile.
- rspack's `ModuleFederationPlugin` (also `@module-federation/enhanced`'s) bundles the federation runtime, which
  webpack 5's does not: the `@module-federation/*` runtime packages are listed for the host and for every remote. A
  shared package with `treeShaking` is built again by rspack, in a compiler of its own, into
  `<output>/independent-packages/<name>/` (`lodash_es` for lodash-es), with its own lockfile (tested on rspack 2.2).
- `rspack serve` and `rsbuild dev` write to memory: the lockfile is served below the public path, at
  `/bundle-lockfile/package-lock.json` by default (`BUNDLE_LOCKFILE_FILE`), and not written to disk (with
  `writeToDisk`, it is). It lists what the dev build bundled: the dev server's client (and @rspack/core's HMR
  runtime), but not the packages of dynamic imports the page has not loaded yet, which are compiled lazily. Rstest,
  which bundles the tests with Rsbuild, leaves no lockfile in the project.
- rspack 1.0 lacks what the plugin needs (the modules inside concatenated modules): its builds fail, also with the
  plugin in the config (with `BUNDLE_LOCKFILE_STRICT=0`: a warning and no lockfile).
- `bun run` starts the `rspack` and `rsbuild` commands with Node.js (their `#!/usr/bin/env node`) only if Node.js is
  installed: without it, Bun runs them itself and nothing is hooked.

## esbuild

esbuild's JavaScript API is hooked: `build()`, `context()` (with `rebuild()` and `watch()`) and `buildSync()`, also of
esbuild-wasm and of Node.js builds that tools such as SvelteKit's adapter-netlify 5 run. Not the `esbuild` command
line, nor its Go API: both are esbuild's binary, which Node.js does not run.

- The lockfile goes into the output directory: `outdir`, or the directory of `outfile`. It is written once esbuild has
  written the output, after every other plugin's `onEnd`; with `watch()`, `rebuild()` and `serve()` (which writes the
  output too) after every build. A failed build changes nothing; an error another plugin's `onEnd` returns (a type
  check) comes after esbuild wrote the output: the lockfile is written. An output that another plugin's `onEnd` moved
  away is a problem (no lockfile lists it).
- It lists the packages of the input files of every output file esbuild writes (its metafile, which bundle-lockfile
  turns on, and takes out of the result again unless the build asked for it): modules, CSS `@import`ed from packages
  and files the `file` and `copy` loaders put into the output. Modules that only re-export count; tree-shaken modules,
  externals and modules a browser field maps to `false` do not. Modules of plugins (a namespace) count if their path is
  a file.
- Several builds into one directory (other entry points) share one lockfile.
- `write: false` and builds without `outdir` or `outfile` write nothing themselves: no lockfile. Their packages are
  listed where their output's bytes end up in another hooked build's output, or in a file written into an output after
  the build ([coverage](coverage.md#also-listed)). Angular's builder builds that way and writes the files itself: its
  lockfile comes from its own adapter ([Angular](#angular)). An output file of such a build that is on disk with its
  bytes when the process ends and in no lockfile of the process (tsup and other tools write esbuild's `outputFiles`
  themselves) is a problem: it ships without a lockfile (`bundle-lockfile-from-metafile` writes one).
- Vite 5 – 7's own esbuild builds (dependency pre-bundling, the dependency scan, bundling `vite.config.*`) and outputs
  below `node_modules` are left alone - except below `node_modules/.cache/`, as for Vite (tools build what ships there).
- A problem fails the build: `build()` and `rebuild()` reject with it (as an error of bundle-lockfile's plugin),
  `buildSync()` throws it, `watch()` prints it and goes on watching. esbuild 0.16 and older (no `context()`) fail a
  build that writes an output.
- Files that a plugin inlines into a module it loads (esbuild-sass-plugin's Sass partials) are not in the metafile:
  they count when the plugin reports them as that module's `watchFiles` (not code, not a build tool's settings), and
  the module reaches an output.
- Files that other plugins write into the output in their `onEnd` (authentik's `fs.cp` of assets out of packages) are
  listed, as files written after a Vite build are ([coverage](coverage.md#also-listed)).
- The command line and the Go API are not hooked; their metafile (`--metafile=meta.json`) gives the lockfile:
  `node /opt/bundle-lockfile/bin/bundle-lockfile-from-metafile meta.json` writes it into the directory of the outputs
  (`--out <dir>`: elsewhere; `--working-dir <dir>`: the build's, if it was not the current one). It sees no
  `watchFiles` and no files copied with fs; it reads the settings and fails as a build would. It lists the esbuild the
  working directory resolves, as the bundler of the JavaScript outputs; `--bundler <package dir>` names another
  (Angular's builder's esbuild), `--bundler none` none (a metafile Bun wrote: Bun is no npm package).

## Parcel

Every Parcel gets bundle-lockfile's reporter — `parcel build`, `parcel watch` and `new Parcel()` of its JavaScript
API — the way Parcel's own command line adds its reporters (`additionalReporters`), without a
`.parcelrc`. Reporters are no part of `.parcel-cache`: a build with a cache that a build without bundle-lockfile left
writes the lockfile too.

- The lockfile goes into each target's `distDir`, once Parcel wrote the bundles (`buildSuccess`); in watch mode after
  every rebuild. A failed build changes nothing.
- It lists the packages of the assets of every bundle (also of bundles inlined into others), except those the
  scope-hoisting packager leaves out (no side effects, no used symbol, not referenced). CSS `@import`s and files a
  style sheet's `url()` loads (fonts) are assets. So is Parcel's runtime, which loads lazy bundles: Parcel generates it
  as a file of `@parcel/runtime-js`, which is listed. The prelude and module wrappers around the JavaScript bundles'
  assets are written by Parcel's JavaScript packager: `@parcel/packager-js`, as the project resolves it, is listed for
  every output with a JavaScript bundle.
- Sass and Less partials (`@use`, `@import`) are inlined by Parcel's transformers and no assets: they are listed from
  Parcel's request graph, where the transformers record them as files the style sheet's asset depends on (also in a
  build from `.parcel-cache`, which transforms nothing again). A build with style sheets whose request graph cannot be
  read fails (strict).
- A problem fails the build: the reporter throws, Parcel reports the build as failed.
## Angular

Angular's application builder (`@angular/build`, `ng build`) bundles with esbuild into memory and writes the files
itself, after its own steps: its chunk optimizer re-bundles lazy chunks with Rolldown, i18n makes a copy per locale.
bundle-lockfile wraps the function that runs one build (`executeBuild()`) and takes Angular's final metafile — the
one its `stats` option writes, turned on for the build and taken out of its output again unless asked for.

- The lockfile is one of the build's output files: `<outputPath>/browser/bundle-lockfile/package-lock.json`, which
  Angular writes with the others, after it cleaned the output path.
- With server-side rendering (`outputMode: 'server'`) the server gets its own,
  `<outputPath>/server/bundle-lockfile/package-lock.json`: the packages bundled into the server (`@angular/ssr`,
  `@angular/platform-server`, the server entry's own dependencies, what the rendered components use). `outputMode:
  'static'` only prerenders: Angular writes no server, so there is no server lockfile.
- With i18n (`localize`) Angular writes a copy of each side's output per locale, translations inlined, in
  `<subPath>/` (the locale by default): each copy gets the lockfile, `<outputPath>/browser/<locale>/bundle-lockfile/`
  (and the server's in `<outputPath>/server/<locale>/`), with the same packages. With SSR, the server's entry
  (`server.mjs`) and its chunks are written once, in `<outputPath>/server/`: their packages are in a lockfile there,
  those of the locales' copies in each locale's.
- `ng build --watch` writes the lockfile again with every rebuild that changes it. `ng serve` writes none: the dev
  server serves its builds from memory (bundle-lockfile tells them by the `partialSSRBuild` option the dev server
  sets; with `NG_BUILD_PARTIAL_SSR` set, `ng build` sets it too, and every build counts as one that writes).
- It lists the packages of the inputs of every output (Angular's own packages, rxjs, the app's), and of the assets
  Angular copies from `node_modules` (an `assets` glob there).
- A problem is an error of the build. `BUNDLE_LOCKFILE_DISABLE=angular` leaves Angular alone (its esbuild builds then
  write nothing: no lockfile).
- Tested: Angular 20, 21, 22 with npm: browser builds, SSR (`outputMode` server and static); on 20 and 22 also i18n
  (two locales), SSR with i18n, `ng build --watch`, `ng serve`; Angular 22 also with pnpm 10 and yarn 4 Plug'n'Play
  (where an asset glob from `node_modules/`, as in angular.json's `assets`, copies nothing: there is no
  `node_modules`).

## Next.js

Next runs several compilers, so a build writes one lockfile per compiler output, below `distDir` (`.next` by default):

| Lockfile directory | Output |
|---|---|
| `.next/bundle-lockfile/` | client |
| `.next/server/chunks/bundle-lockfile/` | server |
| `.next/server/bundle-lockfile/` | edge server: middleware and routes with `runtime = 'edge'` (without packages if there are none) |
| `.next/runtime/bundle-lockfile/` | the server's runtime packages: what it loads from `node_modules`, from Next's traces (below) |
| `.next/standalone/bundle-lockfile/` | with `output: 'standalone'`: the runtime packages, keyed where Next copied them (`.next/standalone/node_modules`); the client's, server's and edge server's lockfiles are copied to their places in `.next/standalone` too |

- Next.js 16 builds with Turbopack by default, which is not hooked: the build fails when it ends (strict mode). Use
  `next build --webpack` (or next-rspack). Turbopack has no plugin API, and the module lists `next build --analyze`
  writes (16.4) do not describe the written client chunks (it builds them again with other source map settings, so
  their names and bytes differ), leave out modules merged into others, and leave out middleware.
- With next-rspack, rspack builds the same compilers: the same lockfiles.
- With the App Router, the server output uses Next's vendored React (`next/dist/compiled/react`), which is listed as
  `next`; the client output lists `react` and `react-dom`.
- Next does not bundle many server dependencies (Pages Router dependencies, `serverExternalPackages`, its own server's):
  the server loads them from `node_modules` at runtime, and Next traces the files it needs into `.nft.json` files
  (`.next/server/**/*.nft.json`, `.next/next-server.js.nft.json`). Once `next build` has run, bundle-lockfile lists the
  packages of those files in `.next/runtime/bundle-lockfile/package-lock.json` (Next.js 12 – 16, with webpack, rspack
  and Turbopack; `BUNDLE_LOCKFILE_DISABLE=next` turns it off). They are what Next copies into the standalone output,
  also packages of which Next copies no `package.json` (a deep `require()` of a `.cjs` file of a package without
  `exports`), which an image scan of `.next/standalone` therefore cannot name. A trace that cannot be read, or a traced
  package without a `package.json` with name and version, fails the build. A file Next does not trace (e.g. a
  `require()` of a computed path) is not listed: Next would not copy it into the standalone output either.
- A static export (`output: 'export'`) copies the pages and `.next/static` into `out/`, but not the lockfiles. Ship
  `.next/bundle-lockfile/package-lock.json` with it, or use an [export
  directory](../README.md#outputs-that-do-not-ship-as-files). In this mode a custom `distDir` names the export
  destination; the lockfiles are in `.next` anyway.
- The standalone output (`output: 'standalone'`) gets the runtime packages' lockfile, and copies of the bundles'
  lockfiles where Next copied their outputs (`.next/standalone/.next/server/chunks/` etc.; the client's in
  `.next/standalone/.next/`, for the `.next/static` that is copied there by hand). With Turbopack (not hooked, so with
  `BUNDLE_LOCKFILE_STRICT=0` only) it has the runtime packages only.
- Each process that inherits `NODE_OPTIONS` and loads webpack logs its own `patched Compiler` line with
  `BUNDLE_LOCKFILE_DEBUG=1` (Next.js's build workers do).
- **Next.js 15.0 – 16.3: use a single `--require`.** These versions merge repeated flags when they rewrite
  `NODE_OPTIONS` for their build workers: `--require a.cjs --require b.cjs` reaches them as the single path `"a.cjs
  b.cjs"` and the build fails; with `--require=a.cjs --require=b.cjs` only the last one reaches them
  ([vercel/next.js#96582](https://github.com/vercel/next.js/issues/96582), fixed in 16.4.0 by
  [#96651](https://github.com/vercel/next.js/pull/96651), not backported to 15) - bundle-lockfile then puts its own
  back into the workers' `NODE_OPTIONS`, but another preload before it stays lost. Next 12–14 do not parse the flags.
  If you need several preloads, require the others from one file.

## SvelteKit

`vite build` runs SvelteKit's client and server builds, and builds the service worker with a nested Vite build. Each
writes its lockfile below `.svelte-kit/output/`: `client/` (the page code, the runtime and the service worker's
packages) and `server/` (what the server bundles). The adapter then fills its output:

| Adapter | Client | Server |
|---|---|---|
| adapter-static | copied to `build/`, with its lockfile | — |
| adapter-node 6 (SvelteKit 3) | copied to `build/client/` | copied to `build/server/`, with its lockfile (which lists adapter-node, bundled into the server build) |
| adapter-node 5 (SvelteKit 2) | copied to `build/client/` | bundled again with Rollup into `build/`; its lockfile lists the server output's packages ([nested bundle](format.md#nested-bundles)) and adapter-node's own files, which it copies to `.svelte-kit/adapter-node/` first |
| adapter-netlify 7 (SvelteKit 3) | copied to `build/` | serverless: copied to `.netlify/v1/server/`, with its lockfile; edge function: bundled with all its dependencies by Rolldown, lockfile in `.netlify/v1/edge-functions/` (also lists adapter-netlify's own files) |
| adapter-netlify 5 (SvelteKit 2; 6 is not tested) | copied to `build/` | serverless: copied to `.netlify/server/`, with its lockfile; edge function: bundled with all its dependencies by esbuild, lockfile in `.netlify/edge-functions/` |

Dependencies the server imports are not bundled by default (Vite's SSR build and adapter-node keep the project's
`dependencies` external): the server loads them from `node_modules` at runtime, so they are in no bundle-lockfile.
Ship that `node_modules`, as with Next.js: image scans read its `package.json` files ([which
scans](../README.md#sbom-tools)); the project's `package-lock.json` lists what was installed, not what the server
loads.

adapter-static with `precompress` processes every file of the output, the lockfile too: it writes
`package-lock.json.gz` and `.br` next to it.

## Nuxt

`nuxt build` (and `nuxi build`) builds the client and the server with Vite into `.nuxt/dist/` - into
`node_modules/.cache/nuxt/.nuxt/dist/` when `.nuxt` is there already (after `nuxt prepare`, a postinstall step) - and
then Nitro bundles the server again with Rollup into `.output/server/` and copies the client's `_nuxt/` files into
`.output/public/`. Shipped is `.output/`:

| Output | Lockfile |
|---|---|
| `.output/public/` | a copy of the client's (Nitro copies its files with fs: [copies of outputs](format.md#copies-of-outputs)) |
| `.output/server/` | Nitro's server build, with what it bundled; the server loads the packages in `.output/server/node_modules/` at runtime ([which scans read those](../README.md#sbom-tools)) |
