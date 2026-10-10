# bundle-lockfile

Records which npm packages end up in a JavaScript bundle and writes them as a `package-lock.json` next to the build
output, without changing the project's build config. Supports webpack 4 and 5 (also the copy inside Next.js), and
Vite, Rollup and Rolldown (also inside SvelteKit).

A lockfile shipped with an application lists everything that was *installed* for the build: build tools, unused and
tree-shaken packages included. bundle-lockfile lists only the packages whose files the bundler put into the output, so
SBOM tools such as [syft](https://github.com/anchore/syft) and [Trivy](https://github.com/aquasecurity/trivy) report
what is shipped. The file is npm's own lockfile format, in the part of it both tools read ([format](docs/format.md)).

What is shipped depends on the import graph, not on `dependencies` vs. `devDependencies`. A project from the tests
declares:

```json
"dependencies":    { "lodash-es": "4.18.1", "is-number": "7.0.0" },
"devDependencies": { "webpack": "5.111.1", "webpack-cli": "7.2.3", "classnames": "2.5.1", "left-pad": "1.3.0" }
```

Its source code imports only `lodash-es` and `classnames`:

| | reports |
|---|---|
| syft on the project's `package-lock.json` | `lodash-es`, `is-number` (not shipped) and the project itself — but not `classnames` (shipped; skipped as a devDependency) |
| syft on bundle-lockfile's output | `lodash-es`, `classnames` |

## Quick start

Preload it into the build with `NODE_OPTIONS`. Every supported bundler in that process, or in a process it starts
(which inherits `NODE_OPTIONS`), is hooked (on Node.js before 24.12, see [Vite, Rollup,
Rolldown](#vite-rollup-rolldown)). Nothing is installed into the project.

```sh
git clone --depth 1 --branch v0.1.1 https://github.com/toabctl/bundle-lockfile /opt/bundle-lockfile
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

Pin a [release](https://github.com/toabctl/bundle-lockfile/releases): the build runs this code. Trivy reads the
lockfile too: `trivy fs --format cyclonedx --output sbom.cdx.json dist`. bundle-lockfile's own failures are warnings
that never fail the build, so check in CI that the lockfile was written (e.g. `test -f
dist/bundle-lockfile/package-lock.json`).

Tested on Linux (Wolfi) with Node.js 24 and 26, and with Node.js 22 for Vite, Rollup, Rolldown, SvelteKit, nested
bundles and webpack 5 under Yarn Plug'n'Play. Other versions and systems are untested. The node shim needs a POSIX
`sh`.

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
- **webpack child compilations whose output is shipped**: workers (`worker-loader`, also inlined) and workbox's
  `InjectManifest` service worker. Child compilations that only run at build time (html-webpack-plugin's template,
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
  `build()` and `watch()` (which `vite build --watch` on Vite 8 calls), nor with a hand-configured plugin in a
  Rolldown or Vite 8 build.
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
  default in production), leaving its module in no chunk;
- vendored code without a `package.json`: inside a package it counts as that package (with a warning), outside
  `node_modules` (a copied `jquery.min.js`) as first-party;
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
  and `../register.cjs` next to itself.

Tested with npm, pnpm, yarn 1, yarn 4 (node-modules linker), bun and `cross-env` (webpack), and npm (Vite).

### In a melange package build

```yaml
environment:
  contents:
    packages:
      - bundle-lockfile          # a package that installs src/ to /usr/lib/bundle-lockfile/ (not in Wolfi yet)
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

### Served outputs

The lockfile is part of the build output. If that output is served (e.g. from `public/assets`), the lockfile is
publicly readable too; `BUNDLE_LOCKFILE_INLINE=0` with an export directory keeps it out. Steps that process every file
of the output process it too (SvelteKit's adapter-static with `precompress` writes `package-lock.json.gz` and `.br`).

### The plugin in the config

The plugins can also be added to a config by hand, without `NODE_OPTIONS`. webpack:

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

With `NODE_OPTIONS` set too, such a build does not get the plugin a second time. Without the preload, files copied out
of packages with fs are not recorded, and other builds — Vite's worker bundles, workbox-build's Rollup build,
processes the build starts — do not get the plugin. In Rolldown builds (also Vite 8) a plugin from the config does not
list style sheets `@import`ed from packages, even with `NODE_OPTIONS` set: Rolldown provides them only to the caller
of `rolldown()`, and the preload adds no second plugin.

### Debug output and warnings

```console
$ BUNDLE_LOCKFILE_DEBUG=1 npm run build
[bundle-lockfile] webpack: patched Compiler from /app/node_modules/webpack/lib/Compiler.js
[bundle-lockfile] webpack: applying to compiler (unnamed) output /app/dist via /app/node_modules/webpack/lib/Compiler.js
...
[bundle-lockfile] webpack: wrote /app/dist/bundle-lockfile/package-lock.json
```

Each process that inherits `NODE_OPTIONS` and loads webpack logs its own `patched Compiler` line (e.g. Next.js's build
workers); a process that never compiles writes nothing. Every process logs how Vite, Rollup and Rolldown are hooked,
e.g. `ESM hooks: sync (Node 24.21.0)`. A Vite 8 build logs `vite: adding the plugin to a rolldown() call` (Vite 7:
`rollup()`).

Warnings and notes are always printed: bundled code from a `node_modules` directory without a `package.json` with name
and version and a vendored copy that is listed (each once per process), a lockfile that could not be written or
locked, `BUNDLE_LOCKFILE_INLINE=0` without an export directory, and a failing adapter (which never fails the build).

## Settings

| Variable | Default | |
|---|---|---|
| `BUNDLE_LOCKFILE_FILE` | `bundle-lockfile/package-lock.json` | output path, relative to the bundler's output directory. Keep the file name `package-lock.json`, outside `node_modules`: syft and Trivy read only files named `package-lock.json`, and none below `node_modules` |
| `BUNDLE_LOCKFILE_EXPORT_DIR` | unset | also write every lockfile below this directory, at `<dir>/<its path>` (see [melange](#in-a-melange-package-build)) |
| `BUNDLE_LOCKFILE_EXPORT_BASE` | unset | lockfiles below this directory are placed relative to it in the export directory (default: their absolute path) |
| `BUNDLE_LOCKFILE_INLINE` | on | `0`, `false` or `off` (any case): write lockfiles only into the export directory (without `BUNDLE_LOCKFILE_EXPORT_DIR`, nothing is written; a warning says so) |
| `BUNDLE_LOCKFILE_DEBUG` | unset | log what gets patched and applied to stderr (empty, `0`, `false` and `off` mean off) |
| `BUNDLE_LOCKFILE_FIRST_PARTY` | unset | comma-separated globs of directories, relative to the working directory, that are first-party: never listed as [vendored copies](docs/format.md#which-package-a-file-belongs-to); `**`: no vendored copies outside `node_modules` |
| `BUNDLE_LOCKFILE_DISABLE` | unset | comma-separated names to skip, case-insensitive: `webpack`; `vite` (builds with Vite's plugins), `rollup`, `rolldown` (other `rollup()` / `rolldown()` builds, the `rollup` command line); or `all` |
| `BUNDLE_LOCKFILE_ESM_HOOKS` | `auto` | how Vite, Rollup and Rolldown are hooked: `sync`, `async` or `off` instead of choosing by Node.js version (see [below](#vite-rollup-rolldown)). `sync` without `module.registerHooks` is `off`; `async` hooks the main thread only, not worker threads. `async` uses `module.register`, which Node.js 24.15 / 25.9 deprecate and Node.js 26 warns about |
| `BUNDLE_LOCKFILE_REGISTER` | next to the shim | the `register.cjs` the node shim preloads |

## Supported

| Bundler | Versions | Notes |
|---|---|---|
| webpack | 4, 5 | webpack < 4 is ignored |
| Next.js (its vendored webpack) | 12, 13, 14, 15, 16 | Next 16 only with `next build --webpack`; its default Turbopack build is not supported |
| Vite | 5, 6, 7 (Rollup 4), 8 (Rolldown; 1.0 release candidates before 8.0.12) | also rolldown-vite (Vite 7 on Rolldown) |
| SvelteKit | 2 (Vite 7), 3 (Vite 8) | adapter-static, adapter-node, adapter-netlify (edge functions only with adapter-netlify 7) |
| Rollup, Rolldown | Rollup 4 (from 4.0, also `@rollup/wasm-node`), Rolldown 1 (from 1.0) | their JavaScript API (`rollup()`, `rolldown()`, Rolldown's `build()`, `watch()`) and the `rollup` command line |

Tested with npm, npx, yarn 1/3/4 (also Plug'n'Play), pnpm 8–12, bun, `turbo run` and npm workspaces, in combinations
per bundler — see [test/README.md](test/README.md#environments).

Not supported yet: rspack, esbuild, Parcel, Turbopack, the `rolldown` command line, Bun's own runtime (`bun --bun`)
and `Bun.build`. `vite dev`, `vite preview` and Vitest write no lockfile.

### Vite, Rollup, Rolldown

Rollup's CommonJS build (`require('rollup')`, the `rollup` command line) is hooked in every process. Vite imports
Rollup and Rolldown as ES modules, which needs a Node.js ESM hook:
- Node.js 24.12, 25.2 and later: hooked in every process.
- Older versions: hooked only in processes whose main script belongs to a package that is or depends on `vite`,
  `rollup`, `rolldown` or `rolldown-vite` (the `vite` command, a build script of a project using Vite), or that have
  another loader hook (e.g. Yarn Plug'n'Play's). A programmatic build from elsewhere needs
  `BUNDLE_LOCKFILE_ESM_HOOKS=async`.

The details are in [docs/internals.md](docs/internals.md#vite-rollup-rolldown).

### Next.js

Next runs several compilers, so a build writes one lockfile per compiler output, below `distDir` (`.next` by default):

| Lockfile directory | Output |
|---|---|
| `.next/bundle-lockfile/` | client |
| `.next/server/chunks/bundle-lockfile/` | server |
| `.next/server/bundle-lockfile/` | edge server: middleware and routes with `runtime = 'edge'` (without packages if there are none) |

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
| adapter-netlify 5, 6 (SvelteKit 2) | copied to `build/` | serverless: copied to `.netlify/server/`, with its lockfile; edge function: bundled by esbuild, no lockfile |

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

## Troubleshooting: no lockfile

- Look for `[bundle-lockfile] WARNING:` on stderr: a lockfile that could not be written or locked, a failing adapter.
- Check that `NODE_OPTIONS` reaches the bundler: `BUNDLE_LOCKFILE_DEBUG=1` logs each bundler it patches and each
  lockfile it writes. A script that overwrites `NODE_OPTIONS` needs the [node
  shim](#build-scripts-that-overwrite-node_options). `BUNDLE_LOCKFILE_DISABLE` may be set.
- The bundler is not supported: Turbopack (Next.js 16's default; use `next build --webpack`), esbuild, the `rolldown`
  command line, rspack.
- A programmatic build that imports Vite, Rollup or Rolldown as ES modules, on Node.js before 24.12 (25.2 on 25), from
  a package that does not depend on them, needs `BUNDLE_LOCKFILE_ESM_HOOKS=async`.
- Outputs below `node_modules`, builds that write nothing themselves, `vite dev`, `vite preview`, Vitest, and a
  webpack build that failed and emitted nothing get no lockfile.
- `BUNDLE_LOCKFILE_INLINE=0` without `BUNDLE_LOCKFILE_EXPORT_DIR` writes nothing.
- A step after the build dropped it: Next.js' static export and standalone output, a copy of only some files. Use an
  export directory.

## More

- [docs/format.md](docs/format.md): the lockfile, keys, vendored copies, several writers, nested bundles
- [docs/internals.md](docs/internals.md): how it hooks the bundlers, source files, adding a bundler
- [test/README.md](test/README.md): unit, contract and matrix tests, the comparison with the CycloneDX webpack plugin

## License

Apache-2.0, see [LICENSE](LICENSE).
