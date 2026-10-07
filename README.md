# bundle-lockfile

Records which npm packages actually end up in a JavaScript bundle and writes them as a
`package-lock.json` next to the build output — without changing the project's build config.

Lockfiles shipped with an application list everything that was *installed* for the build
(dev tools, tree-shaken and unused packages included). `bundle-lockfile` lists only the packages
whose code is in the emitted bundle, so SBOM tools such as [syft](https://github.com/anchore/syft)
report what is really shipped.

"In the bundle" is decided at build time, the way the bundler decides it: starting from the entry
points it follows static `import` / `require()` / `import()` statements, drops modules that
tree-shaking proves unused, and writes the rest into output chunks. A package is listed if any of
its files ends up in the output:

- in an emitted chunk
- in a chunk of a child compiler whose files are emitted too: workers built by `worker-loader`,
  workbox's `InjectManifest` service worker. Child compilers that only run at build time
  (html-webpack-plugin's template, mini-css-extract-plugin's loader) are not counted
- copied verbatim into the output, e.g. by `copy-webpack-plugin`

That is *shipped* code, not necessarily *executed* code:
lazy-loaded chunks that are never opened, branches that never run, or a package of which only one
function is used are all listed. Packages the bundler leaves out (externals, CDN scripts,
unresolvable dynamic `require(variable)`) are not. Neither are files that other build steps put into
the output without going through the bundler (e.g. a `cp node_modules/x/dist/x.js dist/` in a script).

What gets shipped depends on the import graph, not on whether a package is declared under
`dependencies` or `devDependencies`. With this project (from the tests):

```json
"dependencies":    { "lodash-es": "4.18.1", "is-number": "7.0.0" },
"devDependencies": { "webpack": "5.111.1", "webpack-cli": "7.2.3", "classnames": "2.5.1", "left-pad": "1.3.0" }
```

where the source code imports only `lodash-es` and `classnames`:

| | reports |
|---|---|
| syft on the project's `package-lock.json` | `lodash-es`, `is-number` (not shipped) — but not `classnames` (shipped; skipped as a devDependency) |
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
one reaches the workers ([vercel/next.js#96571](https://github.com/vercel/next.js/issues/96571),
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

(A second `patched Compiler` line can come from worker threads, e.g. terser's; they inherit
`NODE_OPTIONS` but never compile, so nothing is written for them.)

### In a melange package build

```yaml
environment:
  contents:
    packages:
      - bundle-lockfile          # installs src/ to /usr/lib/bundle-lockfile/
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
packages from both.

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

## Output

Each top-level compiler writes `<output dir>/bundle-lockfile/package-lock.json`:

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
- a package whose real location is outside `node_modules` — a workspace package, `file:` / `link:`
  dependencies — is first-party and not listed, also with `resolve.symlinks: false`
- `name`, `version` and `license` come from each package's own `package.json` (legacy `license: {type}`
  and `licenses: [...]` forms included)
- entries are sorted by name, version and path in code-unit order, so the same build writes the same
  bytes on every machine, whatever its locale
- the root entry has no name, so syft does not report the application itself as a package
- syft's `javascript-lock-cataloger` reads it (directory scans by default)

## Settings

| Variable | Default | |
|---|---|---|
| `BUNDLE_LOCKFILE_FILE` | `bundle-lockfile/package-lock.json` | output path, relative to the bundler's output directory. Keep the file name `package-lock.json` — syft only reads files with exactly that name |
| `BUNDLE_LOCKFILE_DEBUG` | unset | log what gets patched and applied to stderr |
| `BUNDLE_LOCKFILE_DISABLE` | unset | comma-separated adapter names to skip, or `all` |

## Supported

| Bundler | Versions | Notes |
|---|---|---|
| webpack | 4, 5 | webpack < 4 is ignored |
| Next.js (its vendored webpack) | 12, 13, 14, 15, 16 | Next 16 only with `next build --webpack`; its default Turbopack build is not supported |

Tested with npm 8/9/10/11/12, npx, direct `node_modules/.bin` calls, yarn 1, yarn 3/4 (Plug'n'Play
and node-modules linker), pnpm 8/9/10/11/12 and bun — see [`test/matrix.cjs`](test/matrix.cjs).
yarn 2 is not tested: it does not run on Node.js >= 23 (it calls the removed `util.isDate`).

Not yet: rspack, Vite / Rollup / Rolldown, esbuild, Turbopack.

### Next.js

Next runs several compilers, so a build writes one lockfile per compiler output:
`.next/bundle-lockfile/` (client), `.next/server/chunks/bundle-lockfile/` (server) and
`.next/server/bundle-lockfile/` (edge-server; empty if there are no edge routes).

Next does not bundle many packages into the **server** output; the server loads them from
`node_modules` at runtime. Next records those runtime files in `.next/server/**/*.nft.json`
(in the tests: `ms` is only in the client lockfile, and `index.js.nft.json` lists `ms`, `uuid`,
`react`, `react-dom`, … from `node_modules`). Such packages are not in any bundle-lockfile; if
`node_modules` is shipped with the server, they are covered by the installed `package.json` files there.

## Design

```
src/register.cjs     NODE_OPTIONS entry point: registers the adapters and installs the hooks
src/hooks.cjs        module-load hooks shared by all adapters
src/core/            bundler-agnostic: source files -> packages -> package-lock.json
src/adapters/        one per bundler: answers "which source files are in the emitted output?"
test/unit.cjs        unit tests of the core and the adapter's detection logic (no network, no fixtures)
test/matrix.cjs      fixtures (app x bundler x installer) and cases, as data
test/oracles/        per bundler, an independent build that derives the expected packages
                     from the bundler's own reporting (e.g. webpack stats), sharing no code with the adapter
```

Adapters must never break a build: failures are reported on stderr and the build continues.

To add a bundler: write `src/adapters/<name>.cjs` (an `onCjsLoad(exports, request, resolve)` that
recognizes and patches it), add it to `src/register.cjs`, add an app under `test/apps/`, an oracle
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

Every case checks the lockfile is valid for syft and lists exactly the expected packages, that
it agrees with the oracle, and — if `syft` is on `PATH` — that syft reads exactly those packages.
Besides installers and bundler versions, the cases cover watch-mode rebuilds, warm builds from webpack's
persistent cache, `BUNDLE_LOCKFILE_FILE`, a failing adapter, and edge cases: npm aliases, Babel-injected
helpers, CSS and asset modules from packages, a DLL, workspace packages (also with `resolve.symlinks:
false`), subpath manifests, nested worker-loader workers (webpack 4 and 5), a workbox service worker,
files copied by copy-webpack-plugin and a `context` below the project root.

The devDependencies case also runs a functional SBOM check: it stages the build output like a package
would install it (`usr/share/app/dist/`), runs `syft scan dir:` with SPDX JSON output, and requires
exactly the expected npm packages with name, version, purl, declared license and source file — once
with only the build output, and once with the project's own `package-lock.json` shipped alongside.

The matrix runs on Node.js 24 (Wolfi `nodejs-24`); other Node.js versions are not tested yet.

### Comparison with the CycloneDX webpack plugin

`test/compare/` attaches [`@cyclonedx/webpack-plugin`](https://github.com/CycloneDX/cyclonedx-webpack-plugin)
to any webpack 5 build the same way (no config changes) and reports, per compiler output, the packages
only one of the two lists — each explained by what webpack processed vs. what is in the emitted chunks:

```sh
sh test/compare/fixtures.sh /tmp/fixtures     # all webpack 5 / Next.js fixtures
```

On the fixtures, every difference is a package CycloneDX lists but that is in no emitted chunk
(tree-shaken `uuid`; `css-loader`, which only runs at build time), plus workspace packages, which
bundle-lockfile leaves out as first-party, and copies vendored inside another package
(`next/dist/compiled/@edge-runtime/cookies`), which bundle-lockfile lists as the containing package
(`next`). `test/bigproject/superset.sh` runs the same comparison,
build cost and syft checks on Apache Superset's frontend.

## License

Apache-2.0, see [LICENSE](LICENSE).
