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

- **Hooked through:** CommonJS bundlers are hooked in every process. ES modules need Node.js's ESM hook, which on
  older Node.js versions only some processes get ([which processes](#which-processes-are-hooked)).
- **Watch mode** (webpack, rspack, Rollup, Rolldown, `vite build --watch`, esbuild's `watch()`) writes the lockfile
  after every rebuild.
  The dev servers of rspack (`rspack serve`, `rsbuild dev`) serve it from memory (webpack's dev server goes the same
  way, through its in-memory output file system, but is not tested).
- **Node.js:** 20.18 or later, the oldest that is tested (Vite 7 and 8, Rolldown, rspack 2 and Rsbuild 2 need
  20.19). Builds are tested on 24 and 26, and on 22 for the bundlers hooked as ES modules (Vite, Rollup, Rolldown,
  SvelteKit, rspack 2, Rsbuild 2, Rslib, next-rspack 16) and for webpack 5 and rspack 1.7 under Yarn Plug'n'Play; a
  few on 20. The unit tests and a few builds per kind of hook also run on the releases at which the hooks behave
  differently, from 20.18.2 to 26.4.0 ([which](../test/node-versions.json)). Node.js 25 and Linux distributions other than Wolfi are not tested.
  Next.js 12 does not build on Node.js 25 and later.
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

Real builds of seven Chainguard packages with rspack and Rsbuild are compared with rspack's own stats in
[test/README.md](../test/README.md#rspack-on-real-projects).

Recognized, not hooked — the build fails (`BUNDLE_LOCKFILE_STRICT=0`: a warning, and no lockfile): Turbopack (Next.js
16's default build; known when `next build` ends), Parcel (its `run()`, not `parcel watch` or `serve`), the `rolldown`
command line, `@vercel/ncc` (when it loads: it runs a webpack of its own), webpack < 4 and rspack 0.x (when a compiler
compiles).

Not hooked — no lockfile, and no failure: the `esbuild` command line and Go API (a binary, not Node.js), Angular's
esbuild builder (it builds with `write: false` and writes the files itself), Bun's own runtime (`bun --bun`,
`Bun.build`, and `bun run` where Node.js is not installed).

## Which processes are hooked

The CommonJS bundlers — webpack (also Next.js' copy), rspack 1, Rollup's CommonJS build (`require('rollup')`, the
`rollup` command line), esbuild's API (also through `import`) — are hooked in every process that preloads
bundle-lockfile. The ES-module bundlers — Vite,
which imports Rollup and Rolldown as ES modules, Rolldown, rspack 2, Rollup through `import` — need a Node.js ESM
hook:
- Node.js 24.12, 25.2 and later: hooked in every process.
- Older versions: hooked only in processes (their main thread and worker threads)
  - whose main script belongs to a package that is or depends on `vite`, `rollup`, `rolldown`, `rolldown-vite`,
    `@rspack/core`, `@rspack/cli` or `@rsbuild/core` (the `vite` command, a build script of a project using Vite), or
  - whose project has one of them installed (in `node_modules` of the working directory or above: `nuxi`, `storybook`,
    which load Vite through a dependency), or
  - that have another loader hook (e.g. Yarn Plug'n'Play's).

  A programmatic build from elsewhere needs `BUNDLE_LOCKFILE_ESM_HOOKS=async` (without, it fails the build). A `require('@rspack/core')` anywhere in the process (a CommonJS config) hooks rspack 2 anyway. The loader
  thread these versions use costs time: redpanda-console's Rsbuild 2 build took 8.7 % longer on Node.js 22; each worker
  thread of such a process starts one more (60 – 300 ms for a Vite build in a worker).

Every process logs how ES modules are hooked with `BUNDLE_LOCKFILE_DEBUG=1`, e.g. `ESM hooks: sync (Node 24.21.0)`.
The details are in [internals.md](internals.md#vite-rollup-rolldown).

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
  output too) after every build. A failed build changes nothing.
- It lists the packages of the input files of every output file esbuild writes (its metafile, which bundle-lockfile
  turns on, and takes out of the result again unless the build asked for it): modules, CSS `@import`ed from packages
  and files the `file` and `copy` loaders put into the output. Modules that only re-export count; tree-shaken modules,
  externals and modules a browser field maps to `false` do not. Modules of plugins (a namespace) count if their path is
  a file.
- Several builds into one directory (other entry points) share one lockfile.
- `write: false` and builds without `outdir` or `outfile` write nothing themselves: no lockfile, and no failure. Their packages are listed where their output's bytes end up in another hooked build's output, or in a file
  written into an output after the build ([coverage](coverage.md#also-listed)). Angular's esbuild builder builds that
  way and writes the files itself: it gets no lockfile.
- Vite 5 – 7's own esbuild builds (dependency pre-bundling, the dependency scan, bundling `vite.config.*`) and outputs
  below `node_modules` are left alone.
- A problem fails the build: `build()` and `rebuild()` reject with it (as an error of bundle-lockfile's plugin),
  `buildSync()` throws it, `watch()` prints it and goes on watching. esbuild 0.16 and older (no `context()`) fail a
  build that writes an output.
- Style sheets that a plugin inlines (esbuild-sass-plugin's Sass partials) are not in the metafile: not listed.

## Next.js

Next runs several compilers, so a build writes one lockfile per compiler output, below `distDir` (`.next` by default):

| Lockfile directory | Output |
|---|---|
| `.next/bundle-lockfile/` | client |
| `.next/server/chunks/bundle-lockfile/` | server |
| `.next/server/bundle-lockfile/` | edge server: middleware and routes with `runtime = 'edge'` (without packages if there are none) |

- Next.js 16 builds with Turbopack by default, which is not hooked: the build fails when it ends (strict mode). Use
  `next build --webpack` (or next-rspack).
- With next-rspack, rspack builds the same compilers: the same lockfiles.
- With the App Router, the server output uses Next's vendored React (`next/dist/compiled/react`), which is listed as
  `next`; the client output lists `react` and `react-dom`.
- Next does not bundle many server dependencies (Pages Router dependencies, `serverExternalPackages`): the server
  loads them from `node_modules` at runtime, and Next records them in `.next/server/**/*.nft.json`. They are in no
  bundle-lockfile. Ship `node_modules` with the server: image scans read its installed `package.json` files
  ([which scans](../README.md#sbom-tools)).
- A static export (`output: 'export'`) copies the pages and `.next/static` into `out/`, but not the lockfiles. Ship
  `.next/bundle-lockfile/package-lock.json` with it, or use an [export
  directory](../README.md#outputs-that-do-not-ship-as-files). In this mode a custom `distDir` names the export
  destination; the lockfiles are in `.next` anyway.
- The standalone output (`output: 'standalone'`) leaves the lockfiles out: use an export directory.
- Each process that inherits `NODE_OPTIONS` and loads webpack logs its own `patched Compiler` line with
  `BUNDLE_LOCKFILE_DEBUG=1` (Next.js's build workers do).
- **Next.js 15.0 – 16.3: use a single `--require`.** These versions merge repeated flags when they rewrite
  `NODE_OPTIONS` for their build workers: `--require a.cjs --require b.cjs` reaches them as the single path `"a.cjs
  b.cjs"` and the build fails; with `--require=a.cjs --require=b.cjs` only the last one reaches them
  ([vercel/next.js#96582](https://github.com/vercel/next.js/issues/96582), fixed in 16.4.0 by
  [#96651](https://github.com/vercel/next.js/pull/96651), not backported to 15). Next 12–14 do not parse the flags. If
  you need several preloads, require the others from one file.

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
