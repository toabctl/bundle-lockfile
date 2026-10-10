# The lockfile

What bundle-lockfile writes, how it keys and names packages, and how several builds share one lockfile. Usage is in
the [README](../README.md); the implementation in [internals.md](internals.md).

## Where it is written

Each output gets `<output dir>/bundle-lockfile/package-lock.json` (`BUNDLE_LOCKFILE_FILE` changes the path below the
output directory):
- webpack: one per top-level compiler, in its `output.path` (placeholders such as `[fullhash]` resolved).
- Vite, Rollup, Rolldown: one per output of a build that writes, in its `dir`, or the directory of its `file`
  (Rolldown without either: `dist/`).
- None for builds that write nothing themselves, and none for outputs below `node_modules` (e.g. Vite's dependency
  pre-bundling).

With `BUNDLE_LOCKFILE_EXPORT_DIR`, every lockfile is also written to `<export dir>/<its path>`: relative to
`BUNDLE_LOCKFILE_EXPORT_BASE` when it is below it, else its absolute path without the leading `/`.

## Example

A webpack build that bundles `debug` 2.6.9 (with its own `ms` 2.0.0) and `ms` 2.1.3:

```json
{
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {},
    "node_modules/debug": { "name": "debug", "version": "2.6.9", "license": "MIT" },
    "node_modules/debug/node_modules/ms": { "name": "ms", "version": "2.0.0", "license": "MIT" },
    "node_modules/ms": { "name": "ms", "version": "2.1.3", "license": "MIT" }
  },
  "bundle-lockfile": {
    "v": 1,
    "context": "../..",
    "self": "dist/bundle-lockfile",
    "writers": [
      { "id": "4c1d0e7a9b2f3c55", "count": 1, "files": ["../main.js"],
        "packages": ["node_modules/debug", "node_modules/debug/node_modules/ms", "node_modules/ms"] }
    ]
  }
}
```

## Fields

The lockfile is npm's `package-lock.json` with `lockfileVersion: 3` ([npm's
documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json); npm writes it in [arborist's
`shrinkwrap.js`](https://github.com/npm/cli/blob/latest/workspaces/arborist/lib/shrinkwrap.js)). It has only the
fields syft and Trivy read, in the forms both read the same way:

| Field | Written | |
|---|---|---|
| `lockfileVersion` | `3` | npm 9 and later write it; syft reads 1–3 (not npm 12's `4`, for patched packages) |
| `requires` | `true` | as npm writes it |
| `packages[""]` | `{}` | npm puts the project's name and version here; without a name syft does not report the application as a package |
| `packages[<key>]` | every package | the key starts with `node_modules/` (see [Keys](#keys)) |
| `.name` | always | npm writes it only where the key does not end in the name (aliases); syft and Trivy prefer it over the key |
| `.version` | always | |
| `.license` | if the package declares one | one string, an SPDX expression for several (see [Licenses](#licenses)) |
| `bundle-lockfile` | with every write | bundle-lockfile's record (see [The record](#the-record)), which syft, Trivy and npm ignore |

Entries are sorted by name, version and key in code-unit order, so the same build writes the same bytes on every
machine, whatever its locale.

Not written: `resolved` and `integrity` (an SBOM gets no download location or hash of a package), `dependencies`,
`peerDependencies` and `optionalDependencies`, and the install-time fields (`dev`, `optional`, `link`, `bin`,
`engines`, …). The lockfile is an inventory of what is shipped, not a dependency graph: SBOM tools report the packages
without relationships between them (Trivy calls every one `indirect`, as for any lockfile whose root entry declares no
dependencies).

syft (`javascript-lock-cataloger`; tested with Wolfi's current version, last 1.54.1) and Trivy (npm analyzer; last
0.75.0, also 0.70.0) read it; the README's [SBOM tools](../README.md#sbom-tools) says in which scans. Both read only
files named `package-lock.json`, and none below a `node_modules` directory.

[`test/contract.cjs`](../test/contract.cjs) writes a lockfile with every kind of key and license and requires both
tools to report exactly its packages and licenses. Every matrix case that expects a lockfile checks it with both when
they are on `PATH`, as in CI (see [test/README.md](../test/README.md)).

Changes to the format are listed in the release notes. Before v0.1.0, keys were the locations (also
`../node_modules/…` and `.yarn/cache/…`), and there was no `locations`. bundle-lockfile still reads such a record. A
v0.0.3 or older writing into the same directory reads every key as a location: it keeps every package, some possibly
at a second key.

## Keys

Every key starts with `node_modules/`, as in npm's lockfiles; Trivy skips any other key.
- A key is the package's real location (symlinks resolved), relative to webpack's `context` or, for Vite, Rollup and
  Rolldown, the working directory. Nested duplicate versions and pnpm's layout stay distinct.
- With a context below the project root (e.g. GitLab's), the leading `../` is dropped: `../node_modules/debug` is
  keyed `node_modules/debug`.
- A package elsewhere is keyed `node_modules/<name>`, or `node_modules/<name>@<version>` (then `-2`, `-3`, …) if that
  is taken. That is a package in Yarn Plug'n'Play's `.yarn/cache/<zip>/node_modules/`, in a workspace's own
  `packages/<ws>/node_modules/`, or at a location whose key without `../` another package has.
- The record's `locations` gives the real location of each package whose key is not its location.

## Which package a file belongs to

**In `node_modules`**, a file belongs to the directory directly below the last `node_modules` in its path
(`node_modules/<name>` or `node_modules/@scope/<name>`), at its real location. Two exceptions:
- A **vendored copy** inside that package holds the file. That is a directory whose `package.json`:
  - has a valid package name (as Trivy reads names) and a version;
  - is not private;
  - is no VS Code extension's (`publisher` with `engines.vscode`, which VS Code requires of every extension);
  - has a name that no `package.json` further out has.

  So Next.js' `next/dist/compiled/@edge-runtime/cookies` is listed as `@edge-runtime/cookies`. Other `package.json`
  files inside a package are not packages: `dist/esm/package.json`, the private `preact/hooks/package.json`, or
  socket.io-client's `build/esm/package.json` with its own name.
- The package directory has no `package.json` with name and version (VS Code's stripped `node_modules` inside
  `@gitlab/web-ide`, a library build's `dist/esm/node_modules/rxjs`): its files count as the package around it, with a
  warning once per process. Without a package around it, it cannot be listed; a warning names it (only a debug message
  for directories starting with a dot, such as `node_modules/.cache`, where tools generate files).

**Outside `node_modules`**, a file is first-party (not listed) unless it is in a vendored copy. The same
`package.json` rule applies: the innermost such directory around the file counts — GitLab's
`vendor/assets/javascripts/vue-virtual-scroller` (imported through an alias), a `third_party/` module directory —
unless a first-party directory comes first:
- the build's context (webpack) or working directory (Vite, Rollup, Rolldown), and every directory above it;
- the package of an entry module;
- the members of the monorepo: package manager workspaces, `pnpm-workspace.yaml`, `lerna.json`, `rush.json`, Nx's
  `project.json`;
- a directory linked into `node_modules` (also Yarn Plug'n'Play's workspaces, portals and links);
- a private `package.json`;
- a directory `BUNDLE_LOCKFILE_FIRST_PARTY` names.

A note names each vendored copy once per process. Listing a package too many is preferred over missing one: an in-repo
library that is not private, has a version and is none of the above is listed; `BUNDLE_LOCKFILE_FIRST_PARTY=lib/**`
leaves it out. Files another build produced are that build's output, not vendored copies (see [Nested
bundles](#nested-bundles)). Vendored code without a `package.json` (a copied `jquery.min.js`, Grafana's Jaeger UI
components) is not found — not here, nor by syft, Trivy or the CycloneDX plugin.

**Linked packages**: a package whose real location is outside `node_modules` — a workspace package, a `link:` or
`portal:` dependency, a `file:` directory dependency that npm installs as a symlink — is first-party and not listed,
also with webpack's `resolve.symlinks: false`. Its dependencies are listed. Yarn 2+ (which packs it into its cache)
and pnpm (which hard-links it into `node_modules/.pnpm`) put a `file:` directory dependency inside `node_modules`,
which makes it a listed package.

**Packages outside the project** — outside the context and not in an ancestor directory's `node_modules`, e.g. in
Yarn's global cache (Yarn 4's default), pnpm's global virtual store or a shared store — are listed and keyed like a
package elsewhere (`node_modules/<name>`, else `@<version>`), with no location recorded, since their real path differs
between machines; the record lists them in `outside`.

## Licenses

`name`, `version` and `license` come from each package's own `package.json`, also the legacy `license: {type}` and
`licenses: [...]` forms. `license` is always one string, because syft reads no `{type}` objects and Trivy no arrays of
strings (Trivy 0.70 reads no package at all from a lockfile that has one). Several licenses become an SPDX expression:
`licenses: [{type: "MIT"}, {type: "Apache-2.0"}]` is `"(MIT OR Apache-2.0)"`.

## The record

The `"bundle-lockfile"` field is bundle-lockfile's own record. Tools that read `package-lock.json` (syft, Trivy, npm)
ignore it. It has no machine-specific paths: paths are relative to the lockfile or the context, ids are hashes of the
configuration.
- `context`: the directory the keys are relative to, relative to the lockfile's directory (both as configured, so a
  context reached through a symlink stays `../..`).
- `self`: the lockfile's directory relative to the context. A copy of the lockfile somewhere else — at another depth
  (SvelteKit's adapters copy Vite's output from `.svelte-kit/output/` to `build/`), in another directory, or vendored
  into another project — has a `context` that is not the project; `self` from there does not lead back to the copy, so
  a reader knows it is one.
- `locations` (only if there are any): the location, relative to the context, of each package whose key is not its
  location (`"node_modules/debug": "../node_modules/debug"`), so that another process finds the same package.
- `writers`: per writer (a webpack compiler, a Vite/Rollup/Rolldown output):
  - `id`;
  - `packages` (keys);
  - up to 20 of its output `files`, and the `count` of all of them;
  - for Vite, Rollup and Rolldown: `outputs`, the SHA-256 of up to 500 of its JavaScript and CSS files, and
    `contents`, the packages in each of them (indices into its `packages`), for [nested bundles](#nested-bundles).
- `outside` (only if there are any): the keys of packages outside the project, so that another process listing the
  same package does not list it a second time.
- `unknown` (only if there are any): the keys of packages whose location is not known — read from a copy's record, or
  no longer where a record said (upgraded in place, reinstalled elsewhere, removed). Such a package is the one with
  its name and version that has another key, if there is one; else it has a key of its own, `node_modules/<name>` (or
  `@<version>`), as long as a writer of it is listed.

A package recorded at a path counts as that package only while the `package.json` there still has the recorded name
and version; this applies to writers of this process too.

### Copies of a lockfile

A copy is read like this whenever bundle-lockfile reads a record: a build writing into a directory that holds one, and
a build bundling a file of a copied output (nested bundles, whose hashes are paths in the output and work in a copy of
it). The lockfile's `context` is never a copy's.

When a process with bundle-lockfile loaded copies a lockfile with fs (`copyFile`, `cp`, and their sync and promise
versions; a single file, or a directory holding a lockfile this process wrote), the copy is rewritten for its new
place, and rewritten again whenever the original is, as long as the copy is unchanged. SvelteKit's adapters copy that
way, so their copies are right where they are, also when files written after the build added packages after the copy.
A copy made otherwise (`cp`, rsync, an image build) keeps its bytes, which syft and Trivy read as before.

## Several writers, one lockfile

Builds that write to the same directory share its lockfile: it lists the packages of all of them.
- In one process (e.g. a webpack config array whose app and service worker both go to `dist/`, or plugin-legacy's two
  outputs) they build in parallel or rebuild in watch mode.
- Separate processes (e.g. two `webpack` or `vite build` commands run by `concurrently` or `run-p`) find each other's
  writers in the lockfile on disk, and keep their packages as long as one of the files recorded for them is still
  there.

Each read-merge-write runs under a lock and replaces the file atomically, so no process reads a partly written one.
The lock is `package-lock.json.lock` next to the lockfile (next to the export copy with `BUNDLE_LOCKFILE_INLINE=0`). A
lock older than a minute is taken over; after 30 s of waiting the write goes ahead without it, with a warning.

- A writer's packages count once its output is written: a rebuild that fails and is not emitted (webpack's default in
  production) leaves the packages of its previous output in the lockfile.
- A webpack compiler is recognized by its configuration: name, entry, target and file name templates, per output
  directory. A new compiler for the same configuration (e.g. a build restarted in the same process, or run again)
  replaces the previous one's packages. In the same process that happens once the previous one is closed (webpack <
  5.17, without a shutdown hook: no longer running); until then both are listed.
- A Vite/Rollup/Rolldown output is recognized by the kind of build (Vite, Rollup, Rolldown), its input, its format,
  its position among the build's outputs and its entry file name template (if it is a string).
- Writers whose files are all gone are left out, e.g. when a webpack compiler's `output.clean` deleted what the others
  had written (on its first build, except paths matching `clean.keep`). If one of its files is left, all its packages
  stay. So after a configuration change, a build into a directory that is not cleaned keeps the previous build's
  packages as long as one of its recorded files is still there — also when this build wrote a file of the same name.
  Listing a package too many is safer than missing one.
- Where the output is written to the real disk, the lockfile is not a webpack asset. It is written once webpack has
  written the compiler's output (`afterEmit`), so webpack's stats do not list it and plugins that process or upload
  the assets (compression-webpack-plugin, deploy plugins) do not get it.
- With an in-memory output file system (e.g. webpack-dev-middleware's) it is an asset, added after webpack 5's
  `processAssets` stages (webpack 4: `afterOptimizeAssets`). If a plugin deletes it later
  (compression-webpack-plugin's `deleteOriginalAssets` on webpack 4, which runs in the `emit` hook), it is emitted
  again. In-memory outputs are not shared across processes.

## Nested bundles

A bundled file that another Vite, Rollup or Rolldown build wrote brings the packages that build put into it. E.g.
GitLab's webpack build bundles the Vite-built "island" `ee/frontend_islands/apps/duo_next/dist/main.js`, with Vue
inlined, as part of its own code.

Every Vite, Rollup and Rolldown lockfile records the SHA-256 of its JavaScript and CSS files (`outputs`) and the
packages in each (`contents`):
- a chunk: its modules' packages (not those of style sheets Vite took out of it into a CSS file);
- a CSS file: those of the style sheets that went into it, and of every style sheet the build `@import`s from packages
  (which style sheet imports which is not known).

For every bundled file outside `node_modules`, bundle-lockfile looks for `<dir>/bundle-lockfile/package-lock.json`
(`BUNDLE_LOCKFILE_FILE`, or its copy in the export directory) in the file's directory and each directory above it. In
the first lockfile that records the file, a matching hash adds the packages in that file to this build's (all of the
writer's packages if the lockfile records none per file). This works in webpack, Vite, Rollup and Rolldown builds.
- It also covers a first-party package linked into `node_modules` (e.g. a workspace package built by Vite), at its
  real location, whether the bundler resolved the link or kept it (webpack's `resolve.symlinks: false`, Vite's
  `resolve.preserveSymlinks`).
- A build that bundles only an island's style sheet gets the packages in it, not those of the island's JavaScript.
- A file changed after its build is not attributed.
- The record travels with the output, so this works across processes, separate commands and machines.
- webpack lockfiles record no hashes: a webpack-built bundle that another build bundles is not attributed.
