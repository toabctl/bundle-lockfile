# bundle-lockfile

Records which npm packages actually end up in a JavaScript bundle and writes them as a
`package-lock.json` next to the build output — without changing the project's build config.

Lockfiles shipped with an application list everything that was *installed* for the build
(dev tools, tree-shaken and unused packages included). `bundle-lockfile` lists only the packages
whose code is in the emitted bundle, so SBOM tools such as [syft](https://github.com/anchore/syft)
report what is really shipped.

"In the bundle" is decided at build time, the way the bundler decides it: starting from the entry
points it follows static `import` / `require()` / `import()` statements, skips ES modules whose exports
are unused and that are free of side effects (`sideEffects` in `package.json`, or proven by webpack 5),
and writes the rest into output chunks. A package is listed if any of
its files ends up in the output:

- in an emitted chunk
- in a chunk of a child compiler whose output is shipped: emitted next to the bundle (workers built by
  `worker-loader`, workbox's `InjectManifest` service worker) or inlined into a bundled module
  (`worker-loader`'s `inline: 'no-fallback'`). Child compilers that only run at build time
  (html-webpack-plugin's template, mini-css-extract-plugin's loader, vanilla-extract's compiler) are not counted
- copied verbatim into the output, e.g. by `copy-webpack-plugin`

A module counts as the file webpack itself names it by (its `nameForCondition`: the path `module.rules`
match it against, also used by `splitChunks` cache-group tests): its resource, or the match resource of a `<name>!=!<loaders>!<file>`
request. Loaders that generate a module from a placeholder file name it that way: vanilla-extract's CSS
reads a placeholder in `@vanilla-extract/webpack-plugin`, which is therefore not listed. A package file
pulled in under a first-party match resource is not listed either.

That is *shipped* code, not necessarily *executed* code:
lazy-loaded chunks that are never opened, branches that never run, or a package of which only one
function is used are all listed. Packages the bundler leaves out (externals, CDN scripts,
unresolvable dynamic `require(variable)`) are not. Neither are files that other build steps put into
the output without going through the bundler (e.g. a `cp node_modules/x/dist/x.js dist/` in a script),
nor a package whose only use is an ES module constant that webpack (>= 5.108, `optimization.inlineExports`)
inlined at the use site, leaving its side-effect-free module in no chunk.

What gets shipped depends on the import graph, not on whether a package is declared under
`dependencies` or `devDependencies`. With this project (from the tests):

```json
"dependencies":    { "lodash-es": "4.18.1", "is-number": "7.0.0" },
"devDependencies": { "webpack": "5.111.1", "webpack-cli": "7.2.3", "classnames": "2.5.1", "left-pad": "1.3.0" }
```

where the source code imports only `lodash-es` and `classnames`:

| | reports |
|---|---|
| syft on the project's `package-lock.json` | `lodash-es`, `is-number` (not shipped) and the project itself — but not `classnames` (shipped; skipped as a devDependency) |
| syft on `bundle-lockfile`'s output | `lodash-es`, `classnames` |

## Usage

Preload it into the build via `NODE_OPTIONS`; every supported bundler running in that process
(or its child processes) is patched automatically. No config changes, no dependencies to install:

```sh
git clone https://github.com/toabctl/bundle-lockfile /opt/bundle-lockfile
export NODE_OPTIONS="--require /opt/bundle-lockfile/src/register.cjs"

npm run build                    # or any other way the build is started:
yarn build                       # yarn 1, yarn 3/4 (incl. Plug'n'Play)
pnpm run build
npx webpack
./node_modules/.bin/webpack
npx next build --webpack         # Next.js 16 (12-15 use webpack by default)
```

### Keep existing `NODE_OPTIONS`

Append instead of replacing, e.g. when the build already raises the heap limit:

```sh
export NODE_OPTIONS="--max-old-space-size=16384 --require /opt/bundle-lockfile/src/register.cjs"
```

Scripts that set `NODE_OPTIONS` themselves keep it only if they pass it on — a default-if-unset
script like `NODE_OPTIONS="${NODE_OPTIONS:=--max-old-space-size=10240}" webpack` does, a plain
`NODE_OPTIONS=--max-old-space-size=10240 webpack` (or `cross-env NODE_OPTIONS=... webpack`) drops
the `--require`. For such projects, run the bundler directly with the script's settings instead.

**Next.js 15.0 – 16.3: use a single `--require`.** These versions rewrite `NODE_OPTIONS` for their
build workers and merge repeated flags: `--require a.cjs --require b.cjs` reaches the workers as the
single path `"a.cjs b.cjs"` and the build fails; with `--require=a.cjs --require=b.cjs` only the last
one reaches the workers ([vercel/next.js#96582](https://github.com/vercel/next.js/issues/96582),
fixed in 16.4.0 by [#96651](https://github.com/vercel/next.js/pull/96651), not backported to 15).
Next 12–14 are not affected. If you need several preloads, require the others from one file.

### Check the result with syft

```console
$ syft scan dir:dist -q
NAME       VERSION  TYPE
debug      2.6.9    npm
lodash-es  4.18.1   npm
ms         2.0.0    npm
ms         2.1.3    npm
nanoid     3.3.20   npm
yallist    5.0.0    npm
```

### See what it does

```console
$ BUNDLE_LOCKFILE_DEBUG=1 npm run build
[bundle-lockfile] webpack: patched Compiler from /app/node_modules/webpack/lib/Compiler.js
[bundle-lockfile] webpack: applying to compiler (unnamed) output /app/dist via /app/node_modules/webpack/lib/Compiler.js
...
asset bundle-lockfile/package-lock.json 754 bytes [emitted]
```

(More `patched Compiler` lines come from other processes that inherit `NODE_OPTIONS` and load webpack,
e.g. Next.js's build workers; a process that loads webpack but never compiles writes nothing.)

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
      mkdir -p ${{targets.destdir}}/usr/share/myapp
      cp -r dist ${{targets.destdir}}/usr/share/myapp/
```

An SBOM tool scanning the package contents (e.g. `syft scan dir:`) then finds the bundled npm
packages in `usr/share/myapp/dist/bundle-lockfile/package-lock.json`. If the package also ships the
project's own full lockfile (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`), it reports the
packages from both. syft does not read lockfiles in image scans by default: scanning the resulting
container image needs `--select-catalogers +javascript-lock-cataloger`.

Note that the lockfile is part of the build output: if that output is served by a web server
(e.g. a `public/assets` directory), the lockfile is publicly readable too.

### Without NODE_OPTIONS

The webpack plugin can also be added to a config directly:

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

A compiler that has the plugin in its config does not get it a second time when `NODE_OPTIONS` is set too.

## Output

Each top-level compiler writes `<output dir>/bundle-lockfile/package-lock.json`. Compilers that share
an output directory (e.g. a config array whose app and service worker both go to `dist/`) share that
lockfile: it lists the packages of all of them, also when they build in parallel or rebuild in watch
mode. A new compiler for the same config (same name, entry, target and file names, e.g. a build restarted
in the same process) replaces the previous one's packages.
When a compiler's `output.clean` deletes what the others have already written (on its first build, except
paths matching `clean.keep`), their packages are dropped from the lockfile too: after each compiler's emit,
compilers whose emitted files are all gone are left out. If some of a compiler's files are left, all its
packages stay.
This works for compilers in the same process; separate processes writing to one directory (e.g. two
`webpack` commands run by `concurrently`) overwrite each other's lockfile.

```json
{
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {},
    "node_modules/debug/node_modules/ms": { "name": "ms", "version": "2.0.0", "license": "MIT" },
    "node_modules/ms": { "name": "ms", "version": "2.1.3", "license": "MIT" }
  }
}
```

- keys are the packages' real locations (symlinks resolved) relative to webpack's `context`, so nested
  duplicate versions and pnpm / Yarn Plug'n'Play layouts stay distinct. With a `context` below the
  project root they start with `../node_modules/`
- a package outside the project — outside the `context` and not in an ancestor directory's
  `node_modules`, e.g. in Yarn's global cache (Yarn 4's default) or a shared store — is keyed
  `node_modules/<name>` (`node_modules/<name>@<version>` if that is taken), because its real path differs
  between machines
- a package whose real location is outside `node_modules` — a workspace package, a `link:` or `portal:`
  dependency, a `file:` directory dependency installed by npm as a symlink — is first-party and not
  listed, also with `resolve.symlinks: false`. Its dependencies are listed. Yarn 2+ (packs it into its
  cache) and pnpm (hard-links it into `node_modules/.pnpm`) put a `file:` directory dependency inside
  `node_modules` instead, which makes it a listed package
- `name`, `version` and `license` come from each package's own `package.json` (legacy `license: {type}`
  and `licenses: [...]` forms included). A directory in `node_modules` whose `package.json` has no name
  or version cannot be listed; a warning names it (only a debug message for directories starting with a
  dot, such as `node_modules/.cache`, where tools generate files)
- entries are sorted by name, version and path in code-unit order, so the same build writes the same
  bytes on every machine, whatever its locale
- the root entry has no name, so syft does not report the application itself as a package
- syft's `javascript-lock-cataloger` reads it (by default in directory and file scans, not in image scans),
  unless its path is below a `node_modules` directory, which syft skips

## Settings

| Variable | Default | |
|---|---|---|
| `BUNDLE_LOCKFILE_FILE` | `bundle-lockfile/package-lock.json` | output path, relative to the bundler's output directory. Keep the file name `package-lock.json` — syft only reads files with exactly that name |
| `BUNDLE_LOCKFILE_DEBUG` | unset | log what gets patched and applied to stderr (`0` and `false` also mean off) |
| `BUNDLE_LOCKFILE_DISABLE` | unset | comma-separated adapter names to skip, or `all` (case-insensitive) |

## Supported

| Bundler | Versions | Notes |
|---|---|---|
| webpack | 4, 5 | webpack < 4 is ignored |
| Next.js (its vendored webpack) | 12, 13, 14, 15, 16 | Next 16 only with `next build --webpack`; its default Turbopack build is not supported |

Tested with npm 8/9/10/11 and the npm on `PATH` (Wolfi's, currently 12), npx, direct `node_modules/.bin`
calls, yarn 1, yarn 3 (Plug'n'Play), yarn 4 (Plug'n'Play, also with the global cache, and node-modules
linker), pnpm 8/9/10/11/12 and bun — see [`test/matrix.cjs`](test/matrix.cjs).
yarn 2 is not tested: when it writes zip archives it calls `util.isDate`, which Node.js 23 removed.

Not yet: rspack, Vite / Rollup / Rolldown, esbuild, Turbopack.

### Next.js

Next runs several compilers, so a build writes one lockfile per compiler output (below `distDir`,
`.next` by default): `.next/bundle-lockfile/` (client), `.next/server/chunks/bundle-lockfile/` (server) and
`.next/server/bundle-lockfile/` (edge-server; empty if there are no edge routes).

Next does not bundle many packages into the **server** output (Pages Router dependencies, packages in
`serverExternalPackages`); the server loads them from
`node_modules` at runtime. Next records those runtime files in `.next/server/**/*.nft.json`
(in the tests: `ms` is only in the client lockfile, and `index.js.nft.json` lists `ms`, `uuid`,
`react`, `react-dom`, … from `node_modules`). Such packages are not in any bundle-lockfile; if
`node_modules` is shipped with the server, they are covered by the installed `package.json` files there.

## Design

```
src/register.cjs     NODE_OPTIONS entry point: registers the adapters and installs the hooks
src/hooks.cjs        module-load hooks shared by all adapters
src/core/            bundler-agnostic: source files -> packages -> package-lock.json, merged for
                     compilers that write the same lockfile (outputs.cjs)
src/adapters/        one per bundler: answers "which source files are in the emitted output?"
test/unit.cjs        unit tests of the core and the adapter's detection logic (no network, no fixtures)
test/matrix.cjs      fixtures (app x bundler x installer) and cases, as data
test/oracles/        per bundler, an independent build that derives the expected packages
                     from the bundler's own reporting (e.g. webpack stats), sharing no code with the adapter
```

Adapters must never break a build: failures are reported on stderr and the build continues.

To add a bundler: write `src/adapters/<name>.cjs` (a `name` and an `onCjsLoad(exports, request, resolve)`
that recognizes and patches it; emit through `core/outputs.cjs` so shared output directories work), add it to `src/register.cjs`, add an app under `test/apps/`, an oracle
under `test/oracles/` and rows to `test/matrix.cjs`.

## Tests

The unit tests run anywhere, in about a second:

```sh
node --test test/unit.cjs
```

The matrix runs in a Wolfi container (see `.github/workflows/test.yaml`):

```sh
node test/gen.cjs /tmp/fixtures      # installs fixtures (network)
node test/run.cjs /tmp/fixtures      # runs all cases (offline); optional 2nd arg: case-name regex
```

CI splits the matrix into shards that run as parallel jobs: `--shard=<i>/<n>` (for both scripts) selects
the fixtures of shard `i` of `n` and their cases ([`test/lib/shard.cjs`](test/lib/shard.cjs)).

Every case that expects a lockfile checks that it is valid for syft and lists the expected packages
(exactly, or including / excluding given ones), that it agrees exactly with the
oracle, and — if `syft` is on `PATH` — that syft reads exactly those packages. The other cases check that
no lockfile is written.
Besides installers and bundler versions, the cases cover watch-mode rebuilds, warm builds from webpack's
persistent cache (also with child compilers), `BUNDLE_LOCKFILE_FILE`, a failing adapter, and edge cases:
npm aliases and one version at several paths, Yarn's global cache, Babel-injected helpers, CSS and asset
modules from packages, a DLL, two compilers sharing an output directory, workspace packages (also with
`resolve.symlinks: false`), subpath manifests, nested and inlined worker-loader workers (webpack 4 and 5),
a workbox service worker, html-webpack-plugin 4 and 5 templates, files copied by copy-webpack-plugin
(webpack 4 and 5), vanilla-extract's virtual CSS modules, externals and a `context` below the project root.

The devDependencies case also runs a functional SBOM check: it stages the build output like a package
would install it (`usr/share/app/dist/`), runs `syft scan dir:` with SPDX JSON output, and requires
exactly the expected npm packages with name, version, purl, declared license and source file — once
with only the build output, and once with the project's own `package-lock.json` shipped alongside.

The matrix runs on Node.js 24 (Wolfi `nodejs-24`); other Node.js versions are not tested yet.

### Comparison with the CycloneDX webpack plugin

`test/compare/` attaches [`@cyclonedx/webpack-plugin`](https://github.com/CycloneDX/cyclonedx-webpack-plugin)
to every webpack 5 compiler bundle-lockfile attaches to (no config changes) and reports, per compiler
output, the packages only one of the two lists — each explained by what webpack processed vs. what is in
the emitted output (the same files bundle-lockfile counts):

```sh
sh test/compare/fixtures.sh /tmp/fixtures     # all webpack 5 / Next.js fixtures
```

On the fixtures, every difference is explained:
- CycloneDX lists packages that are not in the emitted output: tree-shaken `uuid`; `css-loader` and
  vanilla-extract's plugin, which only run at build time
- CycloneDX lists workspace packages, which bundle-lockfile leaves out as first-party, and manifests
  nested inside a package (`preact/hooks` as `preact-hooks`, `next/dist/compiled/@edge-runtime/cookies`),
  which bundle-lockfile lists as the containing package
- bundle-lockfile lists packages the main compilation never processed but that are shipped: those in
  workers (worker-loader, workbox's service worker) and files copied by copy-webpack-plugin
- with two compilers writing to one directory, CycloneDX's `bom.json` holds only the last one's packages

`test/bigproject/superset.sh` runs the same comparison,
build cost and syft checks on Apache Superset's frontend.

## License

Apache-2.0, see [LICENSE](LICENSE).
