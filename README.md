# bundle-lockfile

Records which npm packages end up in a JavaScript bundle and writes them as a `package-lock.json` next to the build
output, without changing the project's build config. Supports webpack 4 and 5 (also the copy inside Next.js), rspack
1.1+ and 2 (also inside Rsbuild), Vite, Rollup and Rolldown (also inside SvelteKit), and esbuild's JavaScript API.

It is for whoever builds and ships a bundled JavaScript application and needs its SBOM to list what is shipped:
distribution packagers and image builders (it is developed for [melange](https://github.com/chainguard-dev/melange)
package builds), or a project that publishes an SBOM with its releases. It is not:
- a dependency graph: the lockfile is an inventory of the shipped packages, without who depends on whom
  ([format](docs/format.md#fields));
- a replacement for the project's own lockfile, which still pins what is installed;
- a scan of what a server loads from `node_modules` at runtime (externals, Next.js' and SvelteKit's server
  dependencies): ship that `node_modules`, and image scans report its packages ([which scans](#sbom-tools)).

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
A plugin such as [`@cyclonedx/webpack-plugin`](https://github.com/CycloneDX/cyclonedx-webpack-plugin) lists what
webpack processed, which includes tree-shaken packages and build-time loaders, and needs a config change
([comparison](test/README.md#comparison-with-other-tools)).

## How it works

1. `register.cjs`, preloaded with `NODE_OPTIONS="--require ..."`, hooks Node.js's module loading. When the build
   loads webpack, rspack, Rollup, Rolldown or esbuild, it patches the bundler so that every build gets
   bundle-lockfile's plugin. The project's config and dependencies stay as they are.
2. After the bundler has decided what goes into the output, the plugin takes the source files of the modules in the
   chunks the build writes, and the package files that reach the output otherwise: shipped workers, copied files,
   style sheets `@import`ed from packages ([what is listed](docs/coverage.md)).
3. It maps each file to the npm package it belongs to ([rules](docs/format.md#which-package-a-file-belongs-to)) and
   writes those packages to `<output dir>/bundle-lockfile/package-lock.json`.
4. syft and Trivy read that file like any npm lockfile: it is npm's own format, in the part of it both tools read
   ([format and an example](docs/format.md)).

If bundle-lockfile cannot write a correct lockfile for a build it is attached to, that build fails with the reason
([troubleshooting](#troubleshooting)): an SBOM that silently misses packages is worse than a failed build.

The details are in [docs/internals.md](docs/internals.md).

## Quick start

Requirements:
- Node.js 20.18 or later, the oldest that is tested (builds are tested on Linux with Node.js 20, 22, 24 and 26;
  [details](docs/bundlers.md#supported));
- a [supported bundler](#supported), started by Node.js.

There is no npm or Wolfi package yet: use a git checkout. Nothing is installed into the project.

```sh
git clone --depth 1 https://github.com/toabctl/bundle-lockfile /opt/bundle-lockfile
export NODE_OPTIONS="--require /opt/bundle-lockfile/src/register.cjs"

npm run build                    # or however the build is started: yarn build, pnpm run build, npx vite build,
                                 # ./node_modules/.bin/webpack, npx next build --webpack (Next.js 16), ...

test -f dist/bundle-lockfile/package-lock.json   # a bundler it does not hook writes none, and does not fail
syft scan dir:dist -q            # or: trivy fs --format cyclonedx --output sbom.cdx.json dist
```

Every supported bundler in that process, or in a process it starts (which inherits `NODE_OPTIONS`), is hooked. On
Node.js before 24.12 (25.2 on 25), Vite, Rollup, Rolldown and rspack 2 are hooked only in some processes ([which
ones](docs/bundlers.md#which-processes-are-hooked)).

The test app `test/apps/webpack5` uses `lodash-es`, `debug` 2.6.9 (with its own `ms` 2.0.0), `ms` 2.1.3, `yallist`
and, in a lazily loaded chunk, `nanoid`; it imports `uuid` without using it. Built with webpack 5, syft reports:

```console
NAME       VERSION  TYPE
debug      2.6.9    npm
lodash-es  4.18.1   npm
ms         2.0.0    npm
ms         2.1.3    npm
nanoid     3.3.20   npm
yallist    5.0.0    npm
```

## Usage

### Keep existing `NODE_OPTIONS`

Append to `NODE_OPTIONS` instead of replacing it, e.g. when the build already raises the heap limit:

```sh
export NODE_OPTIONS="--max-old-space-size=16384 --require /opt/bundle-lockfile/src/register.cjs"
```

Next.js 15.0 – 16.3 break with more than one `--require` in `NODE_OPTIONS` ([details](docs/bundlers.md#nextjs)).

### Build scripts that overwrite `NODE_OPTIONS`

A script that sets `NODE_OPTIONS` itself keeps the `--require` only if it passes the old value on.
`NODE_OPTIONS="${NODE_OPTIONS:=--max-old-space-size=10240}" webpack` does; `NODE_OPTIONS=--max-old-space-size=10240
webpack` and `cross-env NODE_OPTIONS=... webpack` drop it. For such projects, also put the node shim first in `PATH`:

```sh
export PATH="/opt/bundle-lockfile/bin:$PATH"
```

`bin/node` puts the `--require` back into `NODE_OPTIONS` and runs the real `node`, so every `node` started through
`PATH` — by npm, pnpm, yarn, bun, `cross-env` or a shell — loads bundle-lockfile. A `node` started by its absolute
path, or by a version manager that puts the real `node` first in `PATH` (nodenv, asdf), is not covered. It needs a
POSIX `sh` with `readlink -f` and `head -c`. How it finds `register.cjs` and the real `node` is in
[docs/configuration.md](docs/configuration.md#the-node-shim).

### Outputs that do not ship as files

When the output does not ship as the files the bundler wrote — embedded into a Go binary (`go:embed`), packed into a
jar, gzipped, or copied away without its `bundle-lockfile/` directory (Next.js' static export and standalone output) —
also write the lockfiles to an export directory, and ship that:

```sh
export BUNDLE_LOCKFILE_EXPORT_DIR=/home/build/export   # every lockfile is also written below it
export BUNDLE_LOCKFILE_EXPORT_BASE=/home/build         # ... at its path relative to /home/build
export BUNDLE_LOCKFILE_INLINE=0                        # and only there, not into the output
make build                                             # e.g. webpack into ui/dist, then go build embedding it
# /home/build/export/ui/dist/bundle-lockfile/package-lock.json
```

`BUNDLE_LOCKFILE_INLINE=0` also keeps the lockfile out of an output that is served: otherwise it is publicly readable
with the rest of it (e.g. from `public/assets`). Where lockfiles outside the export base go is in
[docs/configuration.md](docs/configuration.md#the-export-directory).

### Build tools that drop the variables

turbo's strict env mode (its default) passes `NODE_OPTIONS` and `PATH` to its tasks, but not `BUNDLE_LOCKFILE_*`;
other builds start with an environment of their own (Metabase's passes only `PATH` and `HOME`, so only the node shim
gets the preload back). Put the settings into a settings file instead: `config.json` next to `register.cjs` (`src/` in
a checkout), which the preload finds next to itself:

```sh
cat > /opt/bundle-lockfile/src/config.json <<'EOF'
{ "BUNDLE_LOCKFILE_EXPORT_DIR": "/home/build/export", "BUNDLE_LOCKFILE_EXPORT_BASE": "/home/build",
  "BUNDLE_LOCKFILE_INLINE": "0" }
EOF
```

With turbo, `turbo run build --env-mode=loose` passes every variable on and needs no settings file. With bun as the
package manager, `bun run` starts the bundlers' command lines with `node` (their `#!/usr/bin/env node`), so keep
Node.js installed; `bun --bun` is not supported.

### In a melange package build

This assumes a `bundle-lockfile` package that installs `src/` to `/usr/lib/bundle-lockfile/` and the node shim to
`/usr/lib/bundle-lockfile/bin/node`. There is none in Wolfi yet: with a checkout elsewhere, use its
`src/register.cjs`.

```yaml
environment:
  contents:
    packages:
      - bundle-lockfile
  environment:
    NODE_OPTIONS: "--max-old-space-size=16384 --require /usr/lib/bundle-lockfile/register.cjs"

pipeline:
  - runs: |
      yarn install --frozen-lockfile
      yarn build
      test -f dist/bundle-lockfile/package-lock.json
      # ship the output - the lockfile is inside it
      mkdir -p ${{targets.contextdir}}/usr/share/myapp
      cp -r dist ${{targets.contextdir}}/usr/share/myapp/
```

`syft scan dir:` on the package then finds the bundled packages in
`usr/share/myapp/dist/bundle-lockfile/package-lock.json`. If the package also ships the project's own lockfile
(`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`), syft reports the packages of both. For image scans, see [SBOM
tools](#sbom-tools). Real builds that do all this, with their numbers, are in
[test/README.md](test/README.md#rspack-on-real-projects).

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
- the settings are not checked.

## Configuration

Settings are environment variables, or the same names in a [settings file](#build-tools-that-drop-the-variables); a
variable that is set wins. The defaults need no configuration.

| Setup | Settings |
|---|---|
| ship the output with its lockfile | none |
| output embedded, packed or moved | `BUNDLE_LOCKFILE_EXPORT_DIR`, `BUNDLE_LOCKFILE_EXPORT_BASE`, `BUNDLE_LOCKFILE_INLINE=0` ([above](#outputs-that-do-not-ship-as-files)) |
| a build script overwrites `NODE_OPTIONS` | the node shim in `PATH` ([above](#build-scripts-that-overwrite-node_options)) |
| local experiments, dev servers | `BUNDLE_LOCKFILE_STRICT=0`: warn instead of failing |
| see what is hooked and written | `BUNDLE_LOCKFILE_DEBUG=1` |

| Variable | Default | |
|---|---|---|
| `BUNDLE_LOCKFILE_FILE` | `bundle-lockfile/package-lock.json` | the lockfile's path below each output directory; must be named `package-lock.json` |
| `BUNDLE_LOCKFILE_EXPORT_DIR` | unset | an absolute path: also write every lockfile below it |
| `BUNDLE_LOCKFILE_EXPORT_BASE` | unset | an absolute path: lockfiles below it keep their path relative to it in the export directory |
| `BUNDLE_LOCKFILE_INLINE` | on | off: write the lockfiles only into the export directory |
| `BUNDLE_LOCKFILE_STRICT` | on | off: warn instead of failing a build whose lockfile would be missing or incomplete |
| `BUNDLE_LOCKFILE_DEBUG` | off | on: log what gets patched and written to stderr |
| `BUNDLE_LOCKFILE_FIRST_PARTY` | unset | comma-separated absolute globs of directories that are never listed as vendored copies |
| `BUNDLE_LOCKFILE_DISABLE` | unset | comma-separated bundlers to skip: `webpack`, `rspack`, `vite`, `rollup`, `rolldown`, or `all` |
| `BUNDLE_LOCKFILE_ESM_HOOKS` | `auto` | `sync`, `async` or `off`: how ES-module bundlers are hooked, instead of choosing by Node.js version |
| `BUNDLE_LOCKFILE_REGISTER` | found by the shim | an absolute path: the `register.cjs` the node shim preloads (environment only) |
| `BUNDLE_LOCKFILE_CONFIG` | `config.json` next to `register.cjs` | an absolute path: the settings file (environment only) |

On/off settings take `1`, `true`, `on` and `0`, `false`, `off`. A setting that bundle-lockfile does not recognize (a
misspelled `BUNDLE_LOCKFILE_EXPORTDIR`) or that cannot work (a relative export directory) fails the build: a build
must not go on without doing what was asked of it. Every setting in full, and what is invalid, is in
[docs/configuration.md](docs/configuration.md).

## Supported

| Bundler | Versions | Notes |
|---|---|---|
| webpack | 4, 5 | |
| Next.js | 12 – 16 | Next 16 only with `next build --webpack` or next-rspack ([details](docs/bundlers.md#nextjs)) |
| rspack | 1.1 – 1.7, 2 | also Rsbuild 1.1+ and 2, Rslib 1; rspack 1.0 fails the build ([details](docs/bundlers.md#rspack-rsbuild)) |
| Vite | 5 – 8, rolldown-vite 7 | `vite dev`, `vite preview` and Vitest write no lockfile ([details](docs/bundlers.md#vite-rollup-rolldown)) |
| SvelteKit | 2, 3 | adapter-static, adapter-node, adapter-netlify ([details](docs/bundlers.md#sveltekit)) |
| Nuxt | 4 | `.output/public` and `.output/server` ([details](docs/bundlers.md#nuxt)) |
| Rollup | 4 | also `@rollup/wasm-node` |
| Rolldown | 1 | not the `rolldown` command line |
| esbuild | 0.17 and later | its JavaScript API: `build()`, `context()`, `buildSync()`, also esbuild-wasm; not the `esbuild` command line ([details](docs/bundlers.md#esbuild)) |

Watch mode writes the lockfile after every rebuild; rspack's dev servers serve it from memory. The tested versions,
Node.js versions and package managers (npm, pnpm, yarn 1–4 with Plug'n'Play, bun, turbo, workspaces) are in
[docs/bundlers.md](docs/bundlers.md#supported).

## Limitations

- **Recognized, not hooked** — the build fails (`BUNDLE_LOCKFILE_STRICT=0`: a warning, and no lockfile): Turbopack
  (Next.js 16's default build: use `next build --webpack`), Parcel, the `rolldown` command line, `@vercel/ncc`,
  webpack < 4, rspack 0.x.
- **Not hooked** — no lockfile, and no failure: the `esbuild` command line and Go API (their metafile gives one:
  [bundle-lockfile-from-metafile](docs/bundlers.md#esbuild)), Angular's esbuild builder (it writes the files itself),
  Bun's own runtime (`bun --bun`, `Bun.build`, and `bun run` where Node.js is not installed), and a bundler in a
  process that `NODE_OPTIONS` (or the node shim) does not reach. Check in CI that every lockfile the package should
  ship exists.
- **Older Node.js:** before 24.12 (25.2 on 25), ES-module bundlers (Vite, Rolldown, rspack 2, Rollup through
  `import`) are hooked only in some processes, and through a loader thread that costs time (8.7 % on one Rsbuild
  build; [which processes](docs/bundlers.md#which-processes-are-hooked)).
- **Not in the lockfile:** packages a server loads from `node_modules` at runtime, files put into the output without
  the bundler (a shell `cp`, another process), vendored code without a `package.json`, and in webpack 5.108+ a
  package of which only inlined constants are used ([what is listed](docs/coverage.md)).
- **Shipped, not executed:** a lazily loaded chunk that is never opened, and a package of which one function is used,
  are listed.
- **Dev servers** list what they compiled so far: not the packages of lazily compiled dynamic imports.
- **Outputs that move:** an output whose files the build process copies elsewhere with fs (Nitro's `.output/public`)
  gets a copy of its lockfile there. Next.js' static export and standalone output, and copies made otherwise (`cp`,
  another process), leave the lockfiles behind: use an [export directory](#outputs-that-do-not-ship-as-files).

## SBOM tools

| | syft | Trivy |
|---|---|---|
| directory or file scans (`syft scan dir:` / `file:`, `trivy fs`, `trivy repo`) | yes | yes |
| image scans (and `trivy rootfs`) | only with `--select-catalogers +javascript-lock-cataloger` | no: `trivy image` and `trivy rootfs` read no lockfiles (an APK's SBOM, which they read, lists npm packages only if it was made by scanning the package's files: melange's own SBOM generator lists none) |
| a lockfile below `node_modules`, or not named `package-lock.json` | no | no |

A `node_modules` shipped with a server, whose packages are in no lockfile, is read the other way round: from its
`package.json` files, by image scans (also `trivy rootfs`), not by directory scans (`trivy fs`; `syft scan dir:` only
with `--select-catalogers +javascript-package-cataloger`).

Grype finds vulnerabilities in the packages of a lockfile as syft reads them, Trivy as `trivy fs`. osv-scanner (2.7)
reads the lockfile but matches no vulnerabilities to its packages: it counts an entry without a registry `resolved`
URL as a local package, and bundle-lockfile writes none ([format](docs/format.md#fields)).

The format, keys, licenses and bundle-lockfile's own record are described in [docs/format.md](docs/format.md).

## Troubleshooting

- **The build fails with `[bundle-lockfile] ERROR`:** its lockfile would be missing or incomplete, and the message
  says why. The messages, their causes and what to do are in [docs/troubleshooting.md](docs/troubleshooting.md).
  `BUNDLE_LOCKFILE_STRICT=0` turns them into warnings; leave strict mode on where the SBOM matters.
- **No lockfile:** run the build with `BUNDLE_LOCKFILE_DEBUG=1`, which logs each bundler it patches and each lockfile
  it writes. If nothing is logged, `NODE_OPTIONS` does not reach the bundler (a script that overwrites it needs the
  [node shim](#build-scripts-that-overwrite-node_options)), or the bundler is not hooked
  ([limitations](#limitations)). More causes are in [docs/troubleshooting.md](docs/troubleshooting.md#no-lockfile).

## More

- [docs/coverage.md](docs/coverage.md): what a lockfile lists, and what it does not
- [docs/configuration.md](docs/configuration.md): every setting, the export directory, the node shim
- [docs/bundlers.md](docs/bundlers.md): tested versions, which processes are hooked, notes per bundler
- [docs/troubleshooting.md](docs/troubleshooting.md): error messages, missing lockfiles, debug output
- [docs/format.md](docs/format.md): the lockfile, keys, vendored copies, several writers, nested bundles
- [docs/internals.md](docs/internals.md): how it hooks the bundlers, source files, adding a bundler
- [test/README.md](test/README.md): unit, contract and matrix tests, the comparison with the CycloneDX webpack plugin

## License

Apache-2.0, see [LICENSE](LICENSE).
