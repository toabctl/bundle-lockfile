# Tests

See the [README](../README.md#supported) for what is supported, and [internals.md](../docs/internals.md) for how it
works.

The unit tests run anywhere, in a few seconds (CI: on Node.js 22, 24 and 26):

```sh
node --test test/unit.cjs
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
  loads without `Module._load`.

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

- Node.js 24 and 26 (Wolfi's `nodejs-24`, `nodejs-26`); Node.js 22 for the fixtures above. Next.js 12 itself does not
  build on Node.js 25 and later, which removed the `SlowBuffer` its compiled `jsonwebtoken` uses.
- webpack: npm 8/9/10/11 and the npm on `PATH` (Wolfi's `npm`), npx, `turbo run` (turbo passes `NODE_OPTIONS` to its
  tasks, also in its strict env mode), direct `node_modules/.bin` calls, yarn 1, yarn 3 (Plug'n'Play), yarn 4
  (Plug'n'Play, also with the global cache, and node-modules linker), pnpm 8/9/10/11/12 (10 also with its global
  virtual store) and bun.
- Vite: npm, npx, pnpm 9/10/11 (10 also with its global virtual store), yarn 1, yarn 4 (Plug'n'Play, also with the
  global cache, and node-modules linker), bun and npm workspaces (an app built in its own directory).
- rspack: npm, npx, pnpm 10/11 (10 also with its global virtual store), yarn 1, yarn 4 (Plug'n'Play and node-modules
  linker) and bun; Rsbuild: npm, bun, yarn 4 (Plug'n'Play); Rslib, Next.js with next-rspack: npm.
- yarn 2 is not tested: it calls `util.isDate`, which Node.js 23 removed, when it sets the times of zip entries from
  dates (e.g. for `file:` dependencies).

### What the cases check

A case that expects a lockfile checks every lockfile the build writes:
- it is valid for syft and Trivy: `lockfileVersion` 3, a root entry without a name, every package with a name and a
  version, every key in `node_modules/`, no Yarn virtual path as a key, every license one string;
- in the output directory (not for export-only cases): its `self` and `context` lead back to it, and every key (or its
  `locations` entry) leads to a `package.json` with that name and version (except `outside` and `unknown` keys; in
  Yarn Plug'n'Play's cache, only that the zip is there);
- with an export directory: the inline lockfiles equal the exported ones, or are absent when only exported;
- no other `package-lock.json` below the output directory (e.g. from a child compiler);
- it lists the expected packages (exactly, or including / excluding given ones);
- it agrees exactly with an oracle (`oracles/`): an independent build per bundler that derives the packages from the
  bundler's own reporting (webpack's stats, Vite's and Rollup's source maps) and shares no code with the adapters. A
  case names the packages its oracle cannot see (CSS-only packages, fonts loaded by `url()`, copied files and service
  workers without source maps), or says why it has none;
- if `syft` and `trivy` are on `PATH` (as in CI): each reads exactly those packages, each with a license and a
  `pkg:npm` purl (syft: from its `javascript-lock-cataloger`).

Cases can also require exact keys, the notes and warnings in the build output, and the packages after each watch
rebuild.

The other cases check that no lockfile is written, or that the build fails with a given error: bundle-lockfile's
(strict mode, below) or Next's (Next.js 15 with a second preload).

**Strict mode.** Each of these cases fails the build with bundle-lockfile's reason (the default), and with
`BUNDLE_LOCKFILE_STRICT=0` the build succeeds with a warning instead:
- a failing adapter: webpack 5, Vite 7 and 8, the `rollup` command line, the Rollup and Rolldown APIs;
- a lockfile that cannot be written: webpack 5, Vite 8, the `rollup` command line;
- an export directory that cannot be written;
- `BUNDLE_LOCKFILE_INLINE=0` without an export directory: webpack 5, Vite 8;
- a bundled package without a `package.json`.

All other cases run in strict mode, so a problem there would fail them. The unit tests cover the remaining paths:
- a lock that cannot be taken;
- a compiler the plugin cannot be applied to;
- an ESM entry that cannot be wrapped, in the thread and in the loader thread;
- ESM hooks that cannot be installed, in a bundler process and elsewhere;
- the exit code of a process with problems no build took.

### Cases

Besides the cases below, the matrix covers how bundle-lockfile is activated (nothing without `NODE_OPTIONS`,
`BUNDLE_LOCKFILE_DISABLE=webpack`, existing `NODE_OPTIONS` such as a heap limit kept, a default-if-unset
`NODE_OPTIONS` script), vendored copies (outside `node_modules`, inside packages, with `BUNDLE_LOCKFILE_FIRST_PARTY`
set to `lib/**` and to `**`, with the notes and warnings expected), copies of outputs made with `cp` (a Vite build
into a copy of another output, a copied island bundled by webpack 5), and builds that read another process's
`locations` (a second build, then the first one again).

**webpack**, besides installers and versions (also webpack 4 with pnpm):
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
- Babel-injected helpers, CSS and asset modules from packages (also webpack 5's native CSS and `asset/inline`), style
  sheets loaders inline from packages (Sass, Less, Tailwind via PostCSS; webpack 4 and 5, also from the persistent
  cache), vanilla-extract's virtual CSS modules
- module federation (a host, a remote, a shared package), a DLL, nested and inlined worker-loader workers (webpack 4
  and 5), a workbox service worker, html-webpack-plugin 4 and 5 templates, a package file and a package directory copied
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
  package without a dependency on Vite (hooked on Node.js 24 and 26, on 22 only with
  `BUNDLE_LOCKFILE_ESM_HOOKS=async`)
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
- the `rollup` command line (also `rollup -c -w` and a TypeScript config)
- builds through Rollup's and Rolldown's JavaScript APIs: `rollup()`, `rolldown()` (also its `write()` without `dir`
  or `file`), Rolldown's `build()`, `watch()` of both; two outputs of one build written into one directory at the same
  time; a project directory with `#` in its name; two builds with the plugin in their options (no `NODE_OPTIONS`) into
  one directory; `BUNDLE_LOCKFILE_DISABLE=rollup` / `rolldown`, each leaving the other hooked
- Rollup 4.0.2, Rolldown 1.0.0 and `@rollup/wasm-node` (its API and its command line)
- no lockfile from the `rolldown` command line (not supported yet), and webpack and Vite builds in Bun's own runtime
  (`bun --bun`; the builds are not affected)

**rspack** (the `rspack` app is webpack 5's, with `rspack.config.js`) and **Rsbuild**, compared with an oracle that
builds again through rspack's or Rsbuild's API without bundle-lockfile, without minimizing (so that copies keep their
bytes) and without inlining exports (so that the modules of packages whose constants rspack inlines stay in chunks),
and reads the stats:
- rspack 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 2.0, 2.1 and 2.2 with npm; 1.7 and 2.2 also with pnpm 10, yarn 1, yarn 4
  (Plug'n'Play and node-modules linker) and bun; 2.2 also with pnpm 11 and pnpm 10's global virtual store; rspack 1.0
  fails the build (with `BUNDLE_LOCKFILE_STRICT=0`: a warning, no lockfile)
- `npx rspack`, `node_modules/.bin/rspack`, `rspack()` from a CommonJS and from an ES module script, and from a package
  that does not depend on rspack (hooked on Node.js 24.12+, on 22 only with `BUNDLE_LOCKFILE_ESM_HOOKS=async`)
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
- Rsbuild 1.1, 1.2, 1.7 and 2.2 (npm; 2.2 also with bun and yarn 4 Plug'n'Play), with `output.copy`; environments
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

**Next.js** 12–16 are compared per compiler output with webpack's stats:
- a Pages Router app on each
- on 15 and 16: an App Router app with server and client components, an edge route handler and middleware
- with next-rspack (15.5: rspack 1.4; 16.4: rspack 2.0): the Pages Router app on both, the App Router app on 16, with
  exactly the lockfiles of the webpack builds
- on 16: a static export (`output: 'export'`), a standalone output (`output: 'standalone'`, no lockfile), a warm build
  from `.next/cache`, a Turbopack build (no lockfile)
- another `--require` preload next to bundle-lockfile's (Next 15 fails, see the [README](../README.md#nextjs); 16.4
  builds)

## Comparison with the CycloneDX webpack plugin

`test/compare/` attaches [`@cyclonedx/webpack-plugin`](https://github.com/CycloneDX/cyclonedx-webpack-plugin) (5.3.3)
to every webpack 5 compiler bundle-lockfile attaches to (no config changes) and reports, per compiler output, the
packages only one of the two lists — each explained by what webpack processed vs. what is in the emitted output (the
same files bundle-lockfile counts):

```sh
sh test/compare/fixtures.sh /tmp/fixtures     # the webpack 5 / Next.js fixtures it lists (19)
```

On the fixtures, every difference was explained in the last run (results are not kept in the repository):
- CycloneDX lists packages that are not in the emitted output: tree-shaken `uuid`; `css-loader` and vanilla-extract's
  plugin, which only run at build time
- CycloneDX lists workspace packages, which bundle-lockfile leaves out as first-party, and manifests nested inside a
  package that are no vendored copy (preact 10's private `preact/hooks` as `preact-hooks`), which bundle-lockfile
  lists as the containing package
- bundle-lockfile lists packages the main compilation never processed but that are shipped: those in workers
  (worker-loader, workbox's service worker) and files copied by copy-webpack-plugin
- with two compilers writing to one directory, CycloneDX's `bom.json` holds only the last one's packages

`test/bigproject/superset.sh` runs the same comparison on Apache Superset's frontend, measures the build cost and
compares syft's counts on the output with those on the project's lockfile.
