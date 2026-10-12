# bundle-lockfile

Records which npm packages end up in a JavaScript bundle and writes them as a `package-lock.json` next to the build
output, without changing the project's build config. Supports webpack 4 and 5 (also the copy inside Next.js), rspack
1.1+ and 2 (also inside Rsbuild), and Vite, Rollup and Rolldown (also inside SvelteKit).

## The problem

A lockfile shipped with an application lists everything that was *installed* for the build: build tools, unused and
tree-shaken packages included. An SBOM made from it is wrong both ways: it lists packages that are not shipped, and
it misses shipped ones, because what is shipped depends on the import graph, not on `dependencies` vs.
`devDependencies`. A project from the tests declares:

```json
"dependencies":    { "lodash-es": "4.18.1", "is-number": "7.0.0" },
"devDependencies": { "webpack": "5.111.1", "webpack-cli": "7.2.3", "classnames": "2.5.1", "left-pad": "1.3.0" }
```

Its source code imports only `lodash-es` and `classnames`:

| | reports |
|---|---|
| syft on the project's `package-lock.json` | `lodash-es`, `is-number` (not shipped) and the project itself — but not `classnames` (shipped; skipped as a devDependency) |
| syft on bundle-lockfile's output | `lodash-es`, `classnames` |

bundle-lockfile lists only the packages whose files the bundler put into the output, so SBOM tools such as
[syft](https://github.com/anchore/syft) and [Trivy](https://github.com/aquasecurity/trivy) report what is shipped.

## How it works

1. `register.cjs`, preloaded with `NODE_OPTIONS="--require ..."`, hooks Node.js's module loading. When the build
   loads webpack, rspack, Rollup or Rolldown, it patches the bundler so that every build gets bundle-lockfile's plugin. The
   project's config and dependencies stay as they are.
2. After the bundler has decided what goes into the output, the plugin takes the source files of the modules in the
   chunks the build writes, and the package files that reach the output otherwise: shipped workers, copied files,
   style sheets `@import`ed from packages ([what is listed](#what-is-listed)).
3. It maps each file to the npm package it belongs to ([rules](docs/format.md#which-package-a-file-belongs-to)) and
   writes those packages to `<output dir>/bundle-lockfile/package-lock.json`.
4. syft and Trivy read that file like any npm lockfile: it is npm's own format, in the part of it both tools read
   ([format](docs/format.md)).

The details are in [docs/internals.md](docs/internals.md).

## Quick start

Preload it into the build with `NODE_OPTIONS`. Every supported bundler in that process, or in a process it starts
(which inherits `NODE_OPTIONS`), is hooked (on Node.js before 24.12, 25.2 on 25, see [Vite, Rollup,
Rolldown](#vite-rollup-rolldown)). Nothing is installed into the project.

```sh
git clone --depth 1 --branch v0.2.0 https://github.com/toabctl/bundle-lockfile /opt/bundle-lockfile
export NODE_OPTIONS="--require /opt/bundle-lockfile/src/register.cjs"

npm run build                    # or however the build is started: yarn build, pnpm run build, npx vite build,
                                 # ./node_modules/.bin/webpack, npx next build --webpack (Next.js 16), ...

syft scan dir:dist -q            # reads dist/bundle-lockfile/package-lock.json
```

For an app that bundles `debug`, `lodash-es`, `nanoid` and `yallist`:

```console
NAME       VERSION  TYPE
debug      2.6.9    npm
lodash-es  4.18.1   npm
ms         2.0.0    npm
ms         2.1.3    npm
nanoid     3.3.20   npm
yallist    5.0.0    npm
```

It is a git checkout: there is no npm package, and no Wolfi package yet. Pin a
[release](https://github.com/toabctl/bundle-lockfile/releases): the build runs this code. Trivy reads the
lockfile too: `trivy fs --format cyclonedx --output sbom.cdx.json dist`. If bundle-lockfile cannot write a correct
lockfile for a build it is attached to, that build fails with the reason (see [Troubleshooting](#troubleshooting-the-build-fails-with-bundle-lockfile-error)).
A bundler it does not hook writes no lockfile and does not fail, so still check in CI that the lockfile was written
(e.g. `test -f dist/bundle-lockfile/package-lock.json`).

Requirements: Node.js 20 or later (builds are tested on Linux with Node.js 22, 24 and 26, the unit tests also on 20;
see [Supported](#supported)), nothing else for the preload. The node shim needs a POSIX `sh` with `readlink -f` and
`head -c` (GNU coreutils, BusyBox and macOS have them).

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
| Rollup | 4 (also `@rollup/wasm-node`) | 4.0, 4.64 | CommonJS (`require`, the `rollup` command line); ESM hook (`import`) | |
| Rolldown | 1 | 1.0, 1.2 | ESM hook | `rolldown()`, `build()`, `watch()`; not the `rolldown` command line |

- **Hooked through:** CommonJS bundlers are hooked in every process. ES modules need Node.js's ESM hook: on Node.js
  24.12, 25.2 and later in every process; before, only in processes that build with them (see [Vite, Rollup,
  Rolldown](#vite-rollup-rolldown)).
- **Watch mode** (webpack, rspack, Rollup, Rolldown, `vite build --watch`) writes the lockfile after every rebuild.
  The dev servers of rspack (`rspack serve`, `rsbuild dev`) serve it from memory (webpack's dev server goes the same
  way, through its in-memory output file system, but is not tested).
- **Node.js:** builds are tested on 24 and 26, and on 22 for the bundlers hooked as ES modules (Vite, Rollup,
  Rolldown, SvelteKit, rspack 2, Rsbuild 2, Rslib, next-rspack 16) and for webpack 5 and rspack 1.7 under Yarn
  Plug'n'Play; the unit tests also run on 20. Node.js 25 and Linux distributions other than Wolfi are not tested.
  Next.js 12 does not build on Node.js 25 and later.
- **SBOM tools:** every lockfile of the matrix is read by syft and Trivy (Wolfi's current versions; [which
  scans](#sbom-tools)).

Package managers tested ([details](test/README.md#environments)):

| | |
|---|---|
| webpack | npm 8 – 12, npx, pnpm 8 – 12, yarn 1, yarn 3 (Plug'n'Play), yarn 4 (Plug'n'Play, node-modules), bun, `turbo run`, npm workspaces |
| rspack | npm, npx, pnpm 10 – 11, yarn 1, yarn 4 (Plug'n'Play, node-modules), bun, npm workspaces |
| Rsbuild | npm, bun, yarn 4 (Plug'n'Play) |
| Vite | npm, npx, pnpm 9 – 11, yarn 1, yarn 4 (Plug'n'Play, node-modules), bun, npm workspaces |
| Next.js, SvelteKit, Rollup, Rolldown, Rslib | npm (the `rollup` command line also yarn 4 Plug'n'Play) |

Real builds of seven Chainguard packages with rspack and Rsbuild are compared with rspack's own stats in
[test/README.md](test/README.md#rspack-on-real-projects).

### Known limitations

- **Not hooked** — no lockfile, and no failure: esbuild, Parcel, Turbopack (Next.js 16's default build), the
  `rolldown` command line, Bun's own runtime (`bun --bun`, `Bun.build`, and `bun run` where Node.js is not
  installed), webpack < 4, rspack 0.x, a bundler in a process that `NODE_OPTIONS` (or the [node
  shim](#build-scripts-that-overwrite-node_options)) does not reach. Check in CI that every lockfile the package
  should ship exists.
- **Not in the lockfile** ([what is listed](#what-is-listed)): packages a server loads from `node_modules` at runtime
  (externals, Next.js' and SvelteKit's server dependencies), files put into the output without the bundler (a shell
  `cp`, another process), vendored code without a `package.json`, and in webpack 5.108+ a package of which only
  inlined constants are used.
- **Node.js before 24.12 (25.2 on 25):** ES-module bundlers (Vite, Rolldown, rspack 2, Rollup through `import`) are
  hooked only in processes whose main script's package is or depends on one of them, or that have another loader
  hook (e.g. Yarn Plug'n'Play's), or with `BUNDLE_LOCKFILE_ESM_HOOKS=async`, and not in worker threads. Their loader
  thread costs time: redpanda-console's Rsbuild 2 build took 8.7 % longer on Node.js 22.
- **Rolldown's `build()` and `watch()`** (also `vite build --watch` on Vite 8) list no style sheets `@import`ed from
  packages.
- **Dev servers** list what they compiled so far: not the packages of lazily compiled dynamic imports.
- **Outputs that move:** Next.js' static export and standalone output, and any step that copies only some files,
  leave the lockfiles behind: use an [export directory](#in-a-melange-package-build).
- **Next.js 15.0 – 16.3** break with a second `--require` in `NODE_OPTIONS` ([details](#nextjs)).
- **Two copies of bundle-lockfile** preloaded into one process: the first one does all the work.

## What is listed

The bundler decides what is in the bundle. From the entry points it follows `import`, `require()` and `import()`,
drops ES modules whose exports are unused and that have no side effects (declared with `sideEffects` in
`package.json`; webpack 5, Rollup and Rolldown also analyze the code), and writes the rest into chunks.
bundle-lockfile takes the modules of the chunks the build writes, maps each module's file to its npm package, and
lists those packages.

That is *shipped* code, not necessarily *executed* code. Lazily loaded chunks that are never opened, branches that
never run, and a package of which only one function is used are all listed. A module in a chunk counts even if none of
its code remains: `d3`, which only re-exports `d3-*`, was listed for GitLab (webpack 4) and LibreChat (Vite) although
the source maps show none of its code.

Also listed:
- **webpack and rspack child compilations whose output is shipped**: workers (`worker-loader`, also inlined;
  monaco-editor-webpack-plugin's) and workbox's `InjectManifest` service worker. Child compilations that only run at build time (html-webpack-plugin's template,
  mini-css-extract-plugin's loader, vanilla-extract's compiler) are not.
- **files copied verbatim into a webpack output**, e.g. by copy-webpack-plugin, whose assets record their source from
  6.3 on. Copies that record none (copy-webpack-plugin 5 and 6.0 – 6.2) count if they have the bytes of a package file
  the compilation depends on: a file dependency, or a file in a copied directory.
- **output of builds that write nothing themselves**: Vite's workers, @vitejs/plugin-legacy's polyfills,
  workbox-build's service worker (vite-plugin-pwa), and any `generate()` or `build.write: false` build. Their packages
  are listed where their bytes end up in a written output, or where a module imports their entry with
  `?worker&inline`.
- **style sheets `@import`ed from packages**, which are inlined and so are no modules: CSS, Sass, Less and Stylus in
  Vite, Rollup and Rolldown; Sass, Less, postcss-import and Tailwind through their webpack loaders. Not in Rolldown's
  `build()` and `watch()` (which `vite build --watch` on Vite 8 calls), nor with a plugin from the config in a
  Rolldown or Vite 8 build without the preload.
- **files other plugins write into a Vite, Rollup or Rolldown output after the build**, e.g. vite-plugin-pwa's `sw.js`
  and vite-plugin-static-copy's copies (see [limits](docs/internals.md#files-written-after-the-build)).
- **files copied out of packages** with fs's copy functions (`copyFile`, `cp`, also through fs-extra and graceful-fs)
  in the same process as the build, in every bundler, as long as the copy has the bytes of its source.
- **vendored copies**: a package copied into another package or outside `node_modules`, with its own `package.json`
  ([rules](docs/format.md#which-package-a-file-belongs-to)).
- **nested bundles**: a bundled file that another Vite, Rollup or Rolldown build wrote brings that build's packages
  ([details](docs/format.md#nested-bundles)).

Not listed:
- packages the bundler leaves out: externals, CDN scripts, an unresolvable `require(variable)`;
- packages a server loads from `node_modules` at runtime (see [Next.js](#nextjs), [SvelteKit](#sveltekit));
- files put into the output without the bundler, e.g. `cp node_modules/x/dist/x.js dist/` in a script; files copied
  out of a package by reading and writing them, or in another process (except files written into a Vite, Rollup or
  Rolldown output after the build whose path there contains `node_modules/<package>/`), e.g. `public/` files taken
  from a package once, by hand;
- a package file webpack pulls in under a first-party match resource (`<name>!=!<loaders>!<file>`), e.g.
  vanilla-extract's placeholder in `@vanilla-extract/webpack-plugin`;
- a package whose only use is a small constant that webpack 5.108+ inlined (`optimization.inlineExports`, on by
  default in production), leaving its module in no chunk (rspack builds list such packages, see
  [rspack](#rspack-rsbuild));
- vendored code without a `package.json`: inside a package it counts as that package (a `node_modules/<name>`
  directory without one: as the package around it, with a warning), outside `node_modules` (a copied
  `jquery.min.js`) as first-party;
- workspace packages and other linked first-party packages (their dependencies are listed);
- the bundler's runtime code (webpack 5's runtime modules, Vite's preload helper and modulepreload polyfill,
  Rolldown's runtime, @rollup/plugin-commonjs's helpers), which is generated, not a package's file. webpack 4's
  `webpack/buildin/*` are files of webpack, so webpack 4 builds list `webpack`.

Listed although not shipped: the package of a Sass partial with only variables that a style sheet `@import`s (it adds
no bytes), and the packages of the style sheets a Vite SSR build imports, although it emits no CSS (plugins such as
vite-plugin-css-injected-by-js put CSS into JavaScript, so style modules count without a CSS file).

## Usage

### Keep existing `NODE_OPTIONS`

Append to `NODE_OPTIONS` instead of replacing it, e.g. when the build already raises the heap limit:

```sh
export NODE_OPTIONS="--max-old-space-size=16384 --require /opt/bundle-lockfile/src/register.cjs"
```

### Build scripts that overwrite `NODE_OPTIONS`

A script that sets `NODE_OPTIONS` itself keeps the `--require` only if it passes the old value on.
`NODE_OPTIONS="${NODE_OPTIONS:=--max-old-space-size=10240}" webpack` does; `NODE_OPTIONS=--max-old-space-size=10240
webpack` and `cross-env NODE_OPTIONS=... webpack` drop it. For such projects, also put the node shim first in `PATH`:

```sh
export PATH="/opt/bundle-lockfile/bin:$PATH"
```

`bin/node` puts the `--require` back into `NODE_OPTIONS`, keeping everything else, and runs the real `node`. So every
`node` started through `PATH` — by npm, pnpm, yarn, bun, `cross-env` or a shell — loads bundle-lockfile.
- It adds nothing if `NODE_OPTIONS` already preloads bundle-lockfile: the same file through another path (e.g. a
  symlinked install directory, also quoted with spaces), or another copy of it. One preload is enough.
- The real `node` is the first one in `PATH` that is neither the shim (nor a copy of it) nor a wrapper script it has
  already passed through. Yarn's temporary `node` wrapper and asdf's and nodenv's shims are such scripts.
- Not covered: a `node` started by its absolute path, or through a `PATH` that a version manager put the real `node`'s
  directory in front of (nodenv and asdf do, for what they start). Those keep the `NODE_OPTIONS` they get.
- `BUNDLE_LOCKFILE_REGISTER` names the `register.cjs` to preload; by default the shim looks for `../src/register.cjs`
  (a checkout, as in `/opt/bundle-lockfile` here) and `../register.cjs` (a package, `/usr/lib/bundle-lockfile/bin/node`
  next to its `register.cjs`), from its own directory with symlinks resolved. Set it in the environment: the shim is a
  shell script, which does not read the [settings file](#settings) (a shim started by a preloaded process sees the
  file's settings as variables; the first one, which starts the build, does not). Without a `register.cjs` (none
  found, or `BUNDLE_LOCKFILE_REGISTER` names no file), the shim fails without running `node`, as bundle-lockfile fails
  a build it cannot write a lockfile for; with `BUNDLE_LOCKFILE_STRICT=0` in the environment it warns and runs `node`
  without the preload, with `BUNDLE_LOCKFILE_DISABLE=all` it just runs `node`.

Tested with npm, pnpm, yarn 1, yarn 4 (node-modules linker), bun and `cross-env` (webpack and rspack 2), npm (Vite),
and a build that starts with an environment of its own (`env -i`) with a settings file.

### In a melange package build

```yaml
environment:
  contents:
    packages:
      - bundle-lockfile          # a package that installs src/ to /usr/lib/bundle-lockfile/ and the node shim to
                                 # /usr/lib/bundle-lockfile/bin/node (not in Wolfi yet)
  environment:
    NODE_OPTIONS: "--max-old-space-size=16384 --require /usr/lib/bundle-lockfile/register.cjs"

pipeline:
  - runs: |
      yarn install --frozen-lockfile
      yarn build
      # ship the output - the lockfile is inside it
      mkdir -p ${{targets.contextdir}}/usr/share/myapp
      cp -r dist ${{targets.contextdir}}/usr/share/myapp/
```

`syft scan dir:` on the package then finds the bundled packages in
`usr/share/myapp/dist/bundle-lockfile/package-lock.json`. If the package also ships the project's own lockfile
(`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`), syft reports the packages of both. For image scans, see [SBOM
tools](#sbom-tools).

When the output does not ship as files — embedded into a Go binary (`go:embed`), packed into a jar, gzipped, or copied
away without the `bundle-lockfile/` directory (e.g. Next.js' standalone output) — write the lockfiles to an export
directory too, and install that directory. `BUNDLE_LOCKFILE_INLINE=0` writes them only there, which also keeps them
out of served directories:

```yaml
  environment:
    NODE_OPTIONS: "--require /usr/lib/bundle-lockfile/register.cjs"
    BUNDLE_LOCKFILE_EXPORT_DIR: /home/build/bundle-lockfile-export
    BUNDLE_LOCKFILE_EXPORT_BASE: /home/build
    BUNDLE_LOCKFILE_INLINE: "0"

pipeline:
  - runs: |
      make build                 # e.g. webpack into ui/dist, then go build embedding it
      mkdir -p ${{targets.contextdir}}/usr/share/myapp/bundle-lockfile
      cp -r /home/build/bundle-lockfile-export/. ${{targets.contextdir}}/usr/share/myapp/bundle-lockfile/
```

Each lockfile lands at `<export dir>/<its path>`: relative to `BUNDLE_LOCKFILE_EXPORT_BASE` when it is below it, else
its absolute path without the leading `/`. Here `/home/build/ui/dist/bundle-lockfile/package-lock.json` becomes
`usr/share/myapp/bundle-lockfile/ui/dist/bundle-lockfile/package-lock.json` in the package.

Some build tools do not pass these variables on: turbo's strict env mode (its default) passes `NODE_OPTIONS` and
`PATH` to its tasks, but not `BUNDLE_LOCKFILE_*`; others start the build with an environment of their own (Metabase's
build passes `PATH` and `HOME` only, so only the [node shim](#build-scripts-that-overwrite-node_options) gets the
preload back). Put the settings into a settings file instead: `config.json` next to `register.cjs` (in the package's
directory; `src/` in a checkout), which the preload finds next to itself:

```yaml
pipeline:
  - runs: |
      cat > /usr/lib/bundle-lockfile/config.json <<'EOF'
      { "BUNDLE_LOCKFILE_EXPORT_DIR": "/home/build/bundle-lockfile-export", "BUNDLE_LOCKFILE_EXPORT_BASE": "/home/build",
        "BUNDLE_LOCKFILE_INLINE": "0" }
      EOF
      npm run build              # turbo run build, a build that clears the environment, ...
```

With turbo, `turbo run build --env-mode=loose` passes every variable on, and needs no settings file. With bun as the
package manager, `bun run` starts the bundlers' command lines with `node` (their `#!/usr/bin/env node`), so keep
`nodejs` in the build environment; `bun --bun` is not supported. Since a bundler bundle-lockfile does not hook stays
silent, end the build with a check for every lockfile the package should ship (`test -f .../package-lock.json`).
Real builds that do all this, with their numbers, are in [test/README.md](test/README.md#rspack-on-real-projects).

### Served outputs

The lockfile is part of the build output. If that output is served (e.g. from `public/assets`), the lockfile is
publicly readable too; `BUNDLE_LOCKFILE_INLINE=0` with an export directory keeps it out. Steps that process every file
of the output process it too (SvelteKit's adapter-static with `precompress` writes `package-lock.json.gz` and `.br`).

### The plugin in the config

The plugins can also be added to a config by hand, without `NODE_OPTIONS`. webpack (rspack: the same plugin, from
`src/adapters/rspack.cjs`):

```js
const path = require('path');
const { BundleLockfilePlugin } = require('/opt/bundle-lockfile/src/adapters/webpack.cjs');

module.exports = {
  mode: 'production',
  entry: './src/index.js',
  output: { path: path.join(__dirname, 'dist') },
  plugins: [new BundleLockfilePlugin('bundle-lockfile/package-lock.json')],
};
```

Vite (also Rollup and Rolldown, with `'rollup'` / `'rolldown'`):

```js
import { createRequire } from 'node:module';
const { bundleLockfile } = createRequire(import.meta.url)('/opt/bundle-lockfile/src/adapters/rollup.cjs');

export default { plugins: [bundleLockfile('vite')] };
```

With `NODE_OPTIONS` set too, such a build does not get the plugin a second time. The plugin from the Vite config adds
itself to `worker.plugins`, so Vite's workers count. Without the preload:
- files copied out of packages with fs are not recorded;
- builds with plugins of their own (workbox-build's service worker, and on Vite 8 @vitejs/plugin-legacy's polyfills)
  and processes the build starts do not get the plugin;
- in Rolldown builds (also Vite 8), style sheets `@import`ed from packages are not listed: Rolldown provides them only
  to the caller of `rolldown()`, which the preload wraps.

### Debug output and warnings

```console
$ BUNDLE_LOCKFILE_DEBUG=1 npm run build
[bundle-lockfile] webpack: patched Compiler from /app/node_modules/webpack/lib/Compiler.js
[bundle-lockfile] webpack: applying to compiler (unnamed) output /app/dist via /app/node_modules/webpack/lib/Compiler.js
...
[bundle-lockfile] webpack: wrote /app/dist/bundle-lockfile/package-lock.json
```

Each process that inherits `NODE_OPTIONS` and loads webpack logs its own `patched Compiler` line (e.g. Next.js's build
workers); a process that never compiles writes nothing. Every process logs how ES modules are hooked (Vite, Rollup,
Rolldown, rspack 2), e.g. `ESM hooks: sync (Node 24.21.0)`. A Vite 8 build logs `vite: adding the plugin to a
rolldown() call` (Vite 7: `rollup()`).

Errors, warnings and notes are always printed:
- Errors fail the build (see [Troubleshooting](#troubleshooting-the-build-fails-with-bundle-lockfile-error)):
  - a lockfile, its export copy or a copy of it (e.g. SvelteKit's in `build/`) that could not be written, or locked;
  - `BUNDLE_LOCKFILE_INLINE=0` without an export directory;
  - bundled code from a `node_modules` directory without a `package.json` with name and version, and no package around
    it;
  - an adapter that failed to collect the packages or to hook a bundler;
  - rspack 1.0;
  - a settings file that cannot be read;
  - a node shim that finds no `register.cjs` (it exits with 1 before `node` runs).
- In watch mode of Vite, Rollup and Rolldown, an error after the output is written is printed, and the watcher goes
  on.
- With `BUNDLE_LOCKFILE_STRICT=0` these are warnings instead, and the build goes on.
- Always warnings or notes, once per process: such bundled code that is listed as the package around it, a vendored
  copy that is listed, an adapter that failed while inspecting a module that is no bundler, and ESM hooks that could
  not be installed in a process whose main script's package depends on no ES-module bundler.

## Settings

Environment variables, or the same names in a settings file (a JSON object), for builds whose tools do not pass the
variables on: `config.json` next to `register.cjs` (`src/config.json` in a checkout), or the file
`BUNDLE_LOCKFILE_CONFIG` names. Only `BUNDLE_LOCKFILE_*` keys with string, number or boolean values count. A variable
that is set, also to an empty value, wins over the file; the processes the build starts get the file's settings as
variables. A settings file that cannot be read, or a file `BUNDLE_LOCKFILE_CONFIG` names that does not exist, fails
every process that preloads bundle-lockfile: its first build, or else the process itself at exit, also `npm ci`
(with `BUNDLE_LOCKFILE_STRICT=0`: a warning). A missing `config.json` is no error. Paths are resolved against each
process's working directory: use absolute ones.

| Variable | Default | |
|---|---|---|
| `BUNDLE_LOCKFILE_FILE` | `bundle-lockfile/package-lock.json` | output path, relative to the bundler's output directory. Keep the file name `package-lock.json`, outside `node_modules`: syft and Trivy read only files named `package-lock.json`, and none below `node_modules` |
| `BUNDLE_LOCKFILE_EXPORT_DIR` | unset | also write every lockfile below this directory, at `<dir>/<its path>` (see [melange](#in-a-melange-package-build)) |
| `BUNDLE_LOCKFILE_EXPORT_BASE` | unset | lockfiles below this directory are placed relative to it in the export directory (default: their absolute path) |
| `BUNDLE_LOCKFILE_INLINE` | on | `0`, `false` or `off` (any case): write lockfiles only into the export directory (without `BUNDLE_LOCKFILE_EXPORT_DIR` nothing is written, and the build fails, or warns with `BUNDLE_LOCKFILE_STRICT=0`) |
| `BUNDLE_LOCKFILE_STRICT` | on | a build whose lockfile cannot be written or would be incomplete fails (see [Troubleshooting](#troubleshooting-the-build-fails-with-bundle-lockfile-error)); `0`, `false` or `off` (any case): only warn, and let the build go on (e.g. for local experiments or dev servers) |
| `BUNDLE_LOCKFILE_DEBUG` | unset | log what gets patched and applied to stderr (empty, `0`, `false` and `off`, any case, mean off) |
| `BUNDLE_LOCKFILE_FIRST_PARTY` | unset | comma-separated globs of directories, relative to the working directory (or absolute), that are first-party: never listed as [vendored copies](docs/format.md#which-package-a-file-belongs-to). A glob names directories, not what is below them: `lib/**` for `lib/` and everything in it; `**`: no vendored copies outside `node_modules` |
| `BUNDLE_LOCKFILE_DISABLE` | unset | comma-separated names to skip, case-insensitive: `webpack` (also Next.js); `rspack` (also Rsbuild, Rslib, next-rspack); `vite` (builds with Vite's plugins, also SvelteKit), `rollup`, `rolldown` (other `rollup()` / `rolldown()` builds, the `rollup` command line); or `all`. Other names are ignored, and plugins added to a config by hand still run |
| `BUNDLE_LOCKFILE_ESM_HOOKS` | `auto` | how Vite, Rollup, Rolldown and rspack 2 are hooked (and webpack and rspack 1 when a loader hook such as Yarn Plug'n'Play's provides their code): `sync`, `async` or `off` instead of choosing by Node.js version (see [below](#vite-rollup-rolldown)); other values mean `auto`. `sync` without `module.registerHooks` is `off`; `async` hooks the main thread only, not worker threads. `async` uses `module.register`, which Node.js 24.15 / 25.9 deprecate and Node.js 26 warns about |
| `BUNDLE_LOCKFILE_REGISTER` | `../src/register.cjs` or `../register.cjs` from the shim | the `register.cjs` the node shim preloads (only from the environment) |
| `BUNDLE_LOCKFILE_CONFIG` | `config.json` next to `register.cjs` | the settings file (only from the environment) |

`BUNDLE_LOCKFILE_NODE_SHIM` and `BUNDLE_LOCKFILE_NODE_SEEN` are set by the node shim for the processes it starts; do
not set them.

## Bundler notes

### Vite, Rollup, Rolldown

Rollup's CommonJS build (`require('rollup')`, the `rollup` command line) is hooked in every process. Vite imports
Rollup and Rolldown as ES modules, which needs a Node.js ESM hook:
- Node.js 24.12, 25.2 and later: hooked in every process.
- Older versions: hooked only in the main thread of processes whose main script belongs to a package that is or
  depends on `vite`, `rollup`, `rolldown`, `rolldown-vite`, `@rspack/core`, `@rspack/cli` or `@rsbuild/core` (the
  `vite` command, a build script of a project using Vite), or that have another loader hook (e.g. Yarn Plug'n'Play's).
  A programmatic build from elsewhere needs `BUNDLE_LOCKFILE_ESM_HOOKS=async`; a build in a worker thread is not
  hooked.

The details are in [docs/internals.md](docs/internals.md#vite-rollup-rolldown).

### rspack, Rsbuild

rspack implements webpack's plugin API, and its builds get the same plugin as webpack's: every top-level compiler
writes a lockfile into its output directory, also when the same output directory is shared or when the build runs in
watch mode. Every copy of `@rspack/core` a process loads is hooked: the `rspack` command line, `rsbuild build`, and
other tools that create their compilers with `@rspack/core` (tested: the command line, `rspack()` from a script,
Rsbuild, Rslib, Next.js with next-rspack).

- rspack 1 is a CommonJS module and is hooked in every process. rspack 2 is an ES module, which needs the ESM hook,
  as Vite does ([above](#vite-rollup-rolldown)): on Node.js before 24.12 (25.2 on 25), only in processes whose main
  script belongs to a package that is or depends on `@rspack/core`, `@rspack/cli`, `@rsbuild/core` or one of Vite's
  packages, or that have another loader hook (or with `BUNDLE_LOCKFILE_ESM_HOOKS=async`). A `require('@rspack/core')`
  anywhere in the process (a CommonJS config) hooks it anyway.
- Files `CopyRspackPlugin` copies out of packages are listed, by name and bytes among the files the build depends on.
- Style sheets loaders inline from packages (Sass partials, Less `@import`s, PostCSS) are listed; before rspack
  1.3.14, rspack does not record them per module, and all such style sheets the build read are listed.
- rspack 2 inlines small constants in production (`optimization.inlineExports`; rspack 1.7 with
  `experiments.inlineConst`): a module whose used exports are all inlined is in no chunk. Its package is listed
  anyway — its values are in the bundle.
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
- rspack 1.0 lacks what the plugin needs (the modules inside concatenated modules): its builds fail (with
  `BUNDLE_LOCKFILE_STRICT=0`: a warning and no lockfile).
- `bun run` starts the `rspack` and `rsbuild` commands with Node.js (their `#!/usr/bin/env node`) only if Node.js is
  installed: without it, Bun runs them itself and nothing is hooked.

### Next.js

Next runs several compilers, so a build writes one lockfile per compiler output, below `distDir` (`.next` by default):

| Lockfile directory | Output |
|---|---|
| `.next/bundle-lockfile/` | client |
| `.next/server/chunks/bundle-lockfile/` | server |
| `.next/server/bundle-lockfile/` | edge server: middleware and routes with `runtime = 'edge'` (without packages if there are none) |

- With next-rspack, rspack builds the same compilers: the same lockfiles.
- With the App Router, the server output uses Next's vendored React (`next/dist/compiled/react`), which is listed as
  `next`; the client output lists `react` and `react-dom`.
- Next does not bundle many server dependencies (Pages Router dependencies, `serverExternalPackages`): the server
  loads them from `node_modules` at runtime, and Next records them in `.next/server/**/*.nft.json`. They are in no
  bundle-lockfile. Ship `node_modules` with the server, and its installed `package.json` files cover them.
- A static export (`output: 'export'`) copies the pages and `.next/static` into `out/`, but not the lockfiles. Ship
  `.next/bundle-lockfile/package-lock.json` with it, or use an export directory (`BUNDLE_LOCKFILE_EXPORT_DIR`). In
  this mode a custom `distDir` names the export destination; the lockfiles are in `.next` anyway.
- The standalone output (`output: 'standalone'`) leaves the lockfiles out: use an export directory.
- **Next.js 15.0 – 16.3: use a single `--require`.** These versions merge repeated flags when they rewrite
  `NODE_OPTIONS` for their build workers: `--require a.cjs --require b.cjs` reaches them as the single path `"a.cjs
  b.cjs"` and the build fails; with `--require=a.cjs --require=b.cjs` only the last one reaches them
  ([vercel/next.js#96582](https://github.com/vercel/next.js/issues/96582), fixed in 16.4.0 by
  [#96651](https://github.com/vercel/next.js/pull/96651), not backported to 15). Next 12–14 do not parse the flags. If
  you need several preloads, require the others from one file.

### SvelteKit

`vite build` runs SvelteKit's client and server builds, and builds the service worker with a nested Vite build. Each
writes its lockfile below `.svelte-kit/output/`: `client/` (the page code, the runtime and the service worker's
packages) and `server/` (what the server bundles). The adapter then fills its output:

| Adapter | Client | Server |
|---|---|---|
| adapter-static | copied to `build/`, with its lockfile | — |
| adapter-node 6 (SvelteKit 3) | copied to `build/client/` | copied to `build/server/`, with its lockfile (which lists adapter-node, bundled into the server build) |
| adapter-node 5 (SvelteKit 2) | copied to `build/client/` | bundled again with Rollup into `build/`; its lockfile lists the server output's packages ([nested bundle](docs/format.md#nested-bundles)) and adapter-node's own files, which it copies to `.svelte-kit/adapter-node/` first |
| adapter-netlify 7 (SvelteKit 3) | copied to `build/` | serverless: copied to `.netlify/v1/server/`, with its lockfile; edge function: bundled with all its dependencies by Rolldown, lockfile in `.netlify/v1/edge-functions/` (also lists adapter-netlify's own files) |
| adapter-netlify 5 (SvelteKit 2; 6 is not tested) | copied to `build/` | serverless: copied to `.netlify/server/`, with its lockfile; edge function: bundled by esbuild, no lockfile |

Dependencies the server imports are not bundled by default (Vite's SSR build and adapter-node keep the project's
`dependencies` external): the server loads them from `node_modules` at runtime, so they are in no bundle-lockfile.
Ship that `node_modules` (with its `package.json` files, or a `package-lock.json`), as with Next.js.

## SBOM tools

| | syft | Trivy |
|---|---|---|
| directory or file scans (`syft scan dir:` / `file:`, `trivy fs`, `trivy repo`) | yes | yes |
| image scans (and `trivy rootfs`) | only with `--select-catalogers +javascript-lock-cataloger` | no: `trivy image` and `trivy rootfs` read no lockfiles (melange's APK SBOMs, which they read, carry no npm packages) |
| a lockfile below `node_modules`, or not named `package-lock.json` | no | no |

The format, keys, licenses and bundle-lockfile's own record are described in [docs/format.md](docs/format.md).

## Troubleshooting: the build fails with `[bundle-lockfile] ERROR`

The build failed because its lockfile would be missing or incomplete; the message says why. webpack reports it as a
compilation error (`bundle-lockfile: the lockfile would be missing or incomplete …`), Vite and Rollup as an error of
the `bundle-lockfile` plugin. A problem outside any build (a bundler that could not be hooked, a settings file that
cannot be read) makes the process exit with code 1 after printing `[bundle-lockfile] ERROR: …` and `the process fails
because a lockfile would be missing or incomplete`. In the watch mode of Vite, Rollup and Rolldown, an error after the
output is written is printed and the watcher goes on. On Node.js before 24.12 (25.2 on 25), a bundler that cannot be
wrapped fails its own import with `bundle-lockfile: could not wrap <file URL>: …` (with `BUNDLE_LOCKFILE_STRICT=0` it
loads unchanged, without a warning).

| Message | Cause | What to do |
|---|---|---|
| `could not write <lockfile>` | the output directory or the export directory is not writable, or a file is where the `bundle-lockfile/` directory must go | fix the permissions or the paths (`BUNDLE_LOCKFILE_FILE`, `BUNDLE_LOCKFILE_EXPORT_DIR`) |
| `could not lock <lockfile> - writing it without the lock …` | another process held the lock for more than 30 s; the lockfile is written, but may miss that process's packages | look for a hanging build writing the same output directory |
| `could not write the copy <copy> of <lockfile>` | a copy of a lockfile made with fs (e.g. SvelteKit's adapters' in `build/`) could not be rewritten for its place | fix the permissions of the copy |
| `could not read the settings file <file>` | `config.json` next to `register.cjs`, or the file `BUNDLE_LOCKFILE_CONFIG` names, is no JSON object, cannot be read, or (named) does not exist | fix the file or `BUNDLE_LOCKFILE_CONFIG` ([settings](#settings)) |
| `rspack <version> is not supported (it needs 1.1 or later)` | rspack 1.0 | upgrade rspack |
| `node shim: no register.cjs next to …`, `node shim: BUNDLE_LOCKFILE_REGISTER names no file: …` | the [node shim](#build-scripts-that-overwrite-node_options) was copied without bundle-lockfile's `src/`, or `BUNDLE_LOCKFILE_REGISTER` is wrong | install `bin/` and `src/` together, or set `BUNDLE_LOCKFILE_REGISTER` to the absolute path of `register.cjs` |
| `BUNDLE_LOCKFILE_INLINE is off and BUNDLE_LOCKFILE_EXPORT_DIR is not set` | nowhere to write | set `BUNDLE_LOCKFILE_EXPORT_DIR`, or leave the inline lockfile on |
| `no package.json with name and version in <dir> - its bundled files are not listed` | bundled code in `node_modules` that belongs to no package (a package without `version`, files a tool put there) | install the package properly; a directory whose name starts with a dot (`node_modules/.cache`) is skipped |
| `<adapter>: could not collect …`, `could not patch …`, `could not attach to the compiler …`, `could not check the files copied …`, `could not add the files written … after the build`, `could not wrap …`, `<adapter> adapter failed to wrap …`, `could not install the ESM hooks` | a bug or an unexpected bundler version | report it with `BUNDLE_LOCKFILE_DEBUG=1` output |

`BUNDLE_LOCKFILE_STRICT=0` turns these into warnings and lets the build go on without a correct lockfile. Leave strict
mode on where the SBOM matters (package builds).

## Troubleshooting: no lockfile

- Look for `[bundle-lockfile] WARNING:` on stderr (with `BUNDLE_LOCKFILE_STRICT=0`: a lockfile that could not be
  written or locked, a failing adapter).
- Check that `NODE_OPTIONS` reaches the bundler: `BUNDLE_LOCKFILE_DEBUG=1` logs each bundler it patches and each
  lockfile it writes. A script that overwrites `NODE_OPTIONS` needs the [node
  shim](#build-scripts-that-overwrite-node_options). `BUNDLE_LOCKFILE_DISABLE` may be set. A process that preloads
  another copy of bundle-lockfile first uses that copy.
- The bundler is not supported: Turbopack (Next.js 16's default; use `next build --webpack`), esbuild, the `rolldown`
  command line.
- A programmatic build that imports Vite, Rollup, Rolldown or rspack 2 as ES modules, on Node.js before 24.12 (25.2 on
  25), from a package that does not depend on them, needs `BUNDLE_LOCKFILE_ESM_HOOKS=async`.
- `bun run` without Node.js installed runs the build in Bun's own runtime, which nothing hooks.
- Vite, Rollup and Rolldown outputs below `node_modules`, builds that write nothing themselves, `vite dev`, `vite
  preview`, Vitest, and a webpack build that failed and emitted nothing get no lockfile. (webpack and rspack outputs
  below `node_modules` get one, which syft and Trivy do not read.)
- Another plugin removed a webpack or rspack output directory after the build: only the export copy is written.
- `BUNDLE_LOCKFILE_INLINE=0` without `BUNDLE_LOCKFILE_EXPORT_DIR` writes nothing (and fails the build unless
  `BUNDLE_LOCKFILE_STRICT=0`).
- A step after the build dropped it: Next.js' static export and standalone output, a copy of only some files. Use an
  export directory.

## More

- [docs/format.md](docs/format.md): the lockfile, keys, vendored copies, several writers, nested bundles
- [docs/internals.md](docs/internals.md): how it hooks the bundlers, source files, adding a bundler
- [test/README.md](test/README.md): unit, contract and matrix tests, the comparison with the CycloneDX webpack plugin

## License

Apache-2.0, see [LICENSE](LICENSE).
