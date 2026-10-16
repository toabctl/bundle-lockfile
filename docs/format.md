# The lockfile

What bundle-lockfile writes, how it keys and names packages, and how several builds share one lockfile. Usage is in
the [README](../README.md); the implementation in [internals.md](internals.md).

## Where it is written

Each output gets `<output dir>/bundle-lockfile/package-lock.json` (`BUNDLE_LOCKFILE_FILE` changes the path below the
output directory):
- webpack (also Next.js' copy) and rspack (also Rsbuild, Rslib, Next.js with next-rspack), which get the same
  plugin: one per top-level compiler, in its `output.path` (placeholders such as `[fullhash]` resolved). None in an
  output directory that another plugin removed after the build (only the export copy). Below, "webpack" stands for
  both.
- Next.js: also one for its server's runtime packages, in `<distDir>/runtime/` (and with `output: 'standalone'` in
  `<distDir>/standalone/`), whose writer's files are the trace files it was made from ([Next.js](bundlers.md#nextjs)).
- Vite, Rollup, Rolldown: one per output of a build that writes, in its `dir`, or the directory of its `file`
  (Rolldown without either: `dist/`). None for builds that write nothing themselves, and none for outputs below
  `node_modules` (e.g. Vite's dependency pre-bundling) - except below `node_modules/.cache/`, where tools build what
  they ship (Nuxt's build directory for `nuxi build`). SvelteKit and Nuxt: see [SvelteKit](bundlers.md#sveltekit) and
  [Nuxt](bundlers.md#nuxt).
- esbuild: one per output directory, `outdir` or the directory of `outfile`; none for `write: false` builds
  ([esbuild](bundlers.md#esbuild)).
- Parcel: one in each target's `distDir` ([Parcel](bundlers.md#parcel)).
- Angular: `<outputPath>/browser/`, with SSR also `<outputPath>/server/`, with i18n in each locale's directory
  ([Angular](bundlers.md#angular)).
- A copy of an output's files elsewhere, made with fs in the build's process: see [copies of
  outputs](#copies-of-outputs).

With `BUNDLE_LOCKFILE_EXPORT_DIR`, every lockfile is also written below the export directory
([layout](configuration.md#the-export-directory)). A `package-lock.json` in a lockfile's place that bundle-lockfile
did not write (it has no `bundle-lockfile` record: the project's own, with `BUNDLE_LOCKFILE_FILE=package-lock.json`
and an output directory that is the project) is never replaced: the build fails.

## Example

A webpack build that bundles `debug` 2.6.9 (with its own `ms` 2.0.0) and `ms` 2.1.3, and lists webpack, whose runtime is
in the bundle:

```json
{
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {},
    "node_modules/debug": { "name": "debug", "version": "2.6.9", "license": "MIT" },
    "node_modules/debug/node_modules/ms": { "name": "ms", "version": "2.0.0", "license": "MIT" },
    "node_modules/ms": { "name": "ms", "version": "2.1.3", "license": "MIT" },
    "node_modules/webpack": { "name": "webpack", "version": "5.111.1", "license": "MIT" }
  },
  "bundle-lockfile": {
    "v": 2,
    "context": "../..",
    "self": "dist/bundle-lockfile",
    "writers": [
      { "id": "4c1d0e7a9b2f3c55", "count": 1, "files": ["../main.js"],
        "packages": ["node_modules/debug", "node_modules/debug/node_modules/ms", "node_modules/ms", "node_modules/webpack"],
        "bundler": { "name": "webpack", "version": "5.111.1" }, "via": { "chunk": [0, 1, 2], "runtime": [3] } }
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

Not written: `resolved` and `integrity` (an SBOM gets no download location or hash of a package; osv-scanner, which
counts an entry without a registry `resolved` URL as a local package, therefore matches no vulnerabilities),
`dependencies`, `peerDependencies` and `optionalDependencies`, and the install-time fields (`dev`, `optional`, `link`,
`bin`, `engines`, …). The lockfile is an inventory of what is shipped, not a dependency graph: SBOM tools report the
packages without relationships between them (Trivy calls every one `indirect`, as for any lockfile whose root entry
declares no dependencies).

syft (`javascript-lock-cataloger`; tested with Wolfi's current version, last 1.54.1) and Trivy (npm analyzer; last
0.75.0, also 0.70.0) read it; the README's [SBOM tools](../README.md#sbom-tools) says in which scans. Both read only
files named `package-lock.json`, and none below a `node_modules` directory.

[`test/contract.cjs`](../test/contract.cjs) writes a lockfile with every kind of key and license and requires both
tools to report exactly its packages and licenses. Every matrix case that expects a lockfile checks it with both when
they are on `PATH`, as in CI (see [test/README.md](../test/README.md)).

Changes to the format are listed in the release notes. A record of another version, from an older bundle-lockfile,
is not read: a build writing into its directory replaces it ([the record](#the-record)).

## Keys

Every key starts with `node_modules/`, as in npm's lockfiles; Trivy skips any other key.
- A key is the package's real location (symlinks resolved), relative to webpack's `context` or, for Vite, Rollup and
  Rolldown, the working directory. Nested duplicate versions and pnpm's layout stay distinct.
- With a context below the project root (e.g. GitLab's), the leading `../` is dropped: `../node_modules/debug` is
  keyed `node_modules/debug`.
- A package elsewhere is keyed `node_modules/<name>`, or `node_modules/<name>@<version>` (then `-2`, `-3`, …) if that
  is taken. That is a package in Yarn Plug'n'Play's `.yarn/cache/<zip>/node_modules/`, in a workspace's own
  `packages/<ws>/node_modules/`, a [vendored copy](#which-package-a-file-belongs-to) outside `node_modules` (e.g.
  `vendor/…`), or at a location whose key without `../` another package has.
- A vendored copy inside a package keeps its location as key, which does not end in its name:
  `node_modules/next/dist/compiled/@edge-runtime/cookies` is `@edge-runtime/cookies`. Read a package's name from
  `name`, not from the key (syft and Trivy do).
- The record's `locations` gives the real location of each package whose key is not its location.

## Which package a file belongs to

**In `node_modules`**, a file belongs to the directory directly below the last `node_modules` in its path
(`node_modules/<name>` or `node_modules/@scope/<name>`; with Yarn's pnpm linker `node_modules/.store/<slug>/package`,
its key too), at its real location. Two exceptions:
- A **vendored copy** inside that package holds the file: the file belongs to the copy, and to the package too. That
  is a directory whose `package.json`:
  - has a valid package name (as Trivy reads names) and a version;
  - is not private;
  - is no VS Code extension's (`publisher` with `engines.vscode`, which VS Code requires of every extension);
  - has a name that no `package.json` further out has.

  So Next.js' `next/dist/compiled/@edge-runtime/cookies` is listed as `@edge-runtime/cookies`, and as `next`. The
  package is listed with its copies because only its own `package.json` says what it is: one inside it can name any
  package (`node_modules/evil/lib/package.json` saying `left-pad`), which must not hide the package that ships it.
  Other `package.json`
  files inside a package are not packages: `dist/esm/package.json`, the private `preact/hooks/package.json`, or
  socket.io-client's `build/esm/package.json` with its own name.
- The package directory has no `package.json` with name and version (VS Code's stripped `node_modules` inside
  `@gitlab/web-ide`, a library build's `dist/esm/node_modules/rxjs`): its files count as the package around it, with a
  warning once per process. Without a package around it, it cannot be listed: the build fails naming it (with
  `BUNDLE_LOCKFILE_STRICT=0`: a warning). Directories whose name starts with a dot, such as `node_modules/.cache`,
  where tools generate files, are no packages: their files are not listed, with only a debug message.

**Outside `node_modules`**, a file is first-party (not listed) unless it is in a vendored copy. The same
`package.json` rule applies: the innermost such directory around the file counts — GitLab's
`vendor/assets/javascripts/vue-virtual-scroller` (imported through an alias), a `third_party/` module directory —
unless a first-party directory comes first:
- the build's context (webpack) or working directory (Vite, Rollup, Rolldown), and every directory above it;
- the package of an entry module;
- the members of the monorepo: package manager workspaces, `pnpm-workspace.yaml`, `lerna.json`, `rush.json`, Nx's
  `project.json`;
- a directory linked into `node_modules` under its own `package.json` name (also Yarn Plug'n'Play's workspaces,
  portals and links);
- a private `package.json` - unless a vendored copy further out has it inside (`vendor/preact/hooks/package.json` in
  a copy of preact is a helper of that copy, as inside `node_modules`);
- a directory `BUNDLE_LOCKFILE_FIRST_PARTY` names.

A note names each vendored copy outside `node_modules` once per process (one inside a package: a debug message).
Listing a package too many is preferred over missing one: an in-repo library that is not private, has a version and is
none of the above is listed; `BUNDLE_LOCKFILE_FIRST_PARTY=/src/app/lib/**` (the project in `/src/app`) leaves it
out. Files another build produced are that build's output, not vendored copies (see [Nested
bundles](#nested-bundles)). Vendored code without a `package.json` (a copied `jquery.min.js`, Grafana's Jaeger UI
components) is not found — not here, nor by syft, Trivy or the CycloneDX plugin.

**Linked packages**: a package whose real location is outside `node_modules` — a workspace package, a `link:` or
`portal:` dependency, a `file:` directory dependency that npm installs as a symlink — is first-party and not listed,
also with webpack's `resolve.symlinks: false`. Its dependencies are listed. Only `node_modules/<name>` itself as a
symbolic link makes a package linked: with a `node_modules` that is a symbolic link (to `deps/`), every package in it
is outside `node_modules` by its real path and listed as a vendored copy. With npm, pnpm or Yarn's node-modules
linker, one linked under another name (an alias, `"x": "link:../lib"`) whose `package.json` has a name and a version,
is not private and is no workspace member is listed as a vendored copy (Yarn Plug'n'Play's links and portals are
always first-party); `BUNDLE_LOCKFILE_FIRST_PARTY` leaves it out. Yarn 2+ (which packs it into its cache)
and pnpm (which hard-links it into `node_modules/.pnpm`) put a `file:` directory dependency inside `node_modules`,
which makes it a listed package. So does pnpm with injected workspace packages (`dependenciesMeta.injected`,
`injectWorkspacePackages`): a workspace member hard-linked into `node_modules/.pnpm` is listed under its own name and
version, although it is first-party (one package too many rather than one missing).

**Packages outside the project** — outside the context and not in an ancestor directory's `node_modules`, e.g. in
Yarn's global cache (Yarn 4's default), pnpm's global virtual store or a shared store — are listed and keyed like a
package elsewhere (`node_modules/<name>`, else `@<version>`), with no location recorded, since their real path differs
between machines; the record lists them in `outside`.

## Licenses

`name`, `version` and `license` come from each package's own `package.json`, also the legacy `license: {type}` and
`licenses: [...]` forms. `license` is always one string, because syft reads no `{type}` objects and Trivy no arrays of
strings (Trivy 0.70 reads no package at all from a lockfile that has one). Several licenses become an SPDX expression:
`licenses: [{type: "MIT"}, {type: "Apache-2.0"}]` is `"(MIT OR Apache-2.0)"`; a repeated one appears once, and one
with spaces is parenthesized (`(MIT OR (Apache-2.0 AND BSD-3-Clause))`). `license` wins over `licenses`, also when it
is no string or `{type}` object (an array in `license`: no license).

## The record

The `"bundle-lockfile"` field is bundle-lockfile's own record. Tools that read `package-lock.json` (syft, Trivy, npm)
ignore it. It has no machine-specific paths: paths are relative to the lockfile or the context, ids are hashes of the
configuration.
- `v`: the record's version, `2`. A record without it, or of another version (version 1: bundle-lockfile before
  `bundler` and `via`), is not read: a build writing into its directory replaces it without keeping its writers'
  packages, and a build bundling a file of its output fails ([nested bundles](#nested-bundles)) until that output is
  built again.
- `context`: the directory the keys are relative to, relative to the lockfile's directory (both as configured, so a
  context reached through a symlink stays `../..`).
- `self`: the lockfile's directory relative to the context. A copy of the lockfile somewhere else — at another depth
  (SvelteKit's adapters copy Vite's output from `.svelte-kit/output/` to `build/`), in another directory, or vendored
  into another project — has a `context` that is not the project; `self` from there does not lead back to the copy, so
  a reader knows it is one.
- `contextId` and `selfId`, instead of `context` and `self`, for a lockfile outside the context's project (the
  outermost directory with a `package.json` among the context and those above it), e.g. of an absolute `outDir`
  elsewhere: there the relative paths would spell out the directories of the machine on the way
  (`../../home/builder/out`). Both are the first 16 hex digits of a SHA-256: `contextId` of `context\0<secret>`,
  `selfId` of `self\0<secret>\0<the lockfile's directory relative to the context>`, where the secret is the SHA-256
  of `bundle-lockfile\0<the context's real path>\0<its device number>\0<its inode number>` - so a guessed path
  cannot be checked against them. A process whose context has that id reads the record as written where it is (if
  `selfId` matches the lockfile's place too), and keeps its writers' packages at their locations; any other reader -
  another project's build, a copy, the same directory recreated - reads it as a copy's: the packages by name and
  version (`unknown`).
- `locations` (only if there are any): the location, relative to the context, of each package whose key is not its
  location (`"node_modules/debug": "../node_modules/debug"`), so that another process finds the same package.
- `writers`: per writer (a webpack compiler, a Vite/Rollup/Rolldown output):
  - `id`;
  - `packages` (keys);
  - up to 20 of its output `files`, and the `count` of all of them;
  - for Vite, Rollup, Rolldown, esbuild and Parcel: `outputs`, the SHA-256 of up to 500 of its JavaScript and CSS files
    (with more: their number, `outputCount`), and `contents`, the packages in each of them (indices into its
    `packages`), for [nested bundles](#nested-bundles);
  - `bundler`: the bundler that ran, `{ "name", "version" }` as it reports itself (`webpack`, `rspack`, `rollup`,
    `rolldown`, `vite`, `esbuild`, `parcel`, `angular`; Vite's version where Vite gives it to plugins), or `next` for
    the runtime packages of Next.js' server (the version of that copy of Next). It is the bundler that wrote the
    output, not a package of it;
  - `via`: how it found each package, `{ "<class>": [indices into its packages] }`. A package found in several ways is
    listed under each class:

    | Class | The package's files reached the output as |
    |---|---|
    | `chunk` | modules of the chunks the build writes |
    | `child` | modules of a shipped webpack or rspack child compilation (a worker, a service worker) |
    | `asset` | files a Vite, Rollup or Rolldown asset was emitted from (a font, an image) |
    | `copy-source` | files copied into the output by a plugin that names their source (copy-webpack-plugin) |
    | `copy-bytes` | files copied into the output without a name of their source, matched by their bytes |
    | `style` | style sheets a loader or plugin inlined into a module (`@import`, Sass partials) |
    | `inlined` | other files a loader or plugin inlined (an image as a `data:` URL, a shader's `#include`, JSON) |
    | `inlined-exports` | modules in no chunk whose exports rspack inlined where they are used |
    | `generated` | the output of a build that writes nothing itself, found by its bytes or its entry (a Vite worker, workbox's service worker) |
    | `late` | files another plugin wrote into the output after the build |
    | `fs-copy` | files copied out of the package with fs, in the build's process |
    | `nested` | files another build wrote, whose lockfile lists the package ([nested bundles](#nested-bundles)) |
    | `vendored` | a [vendored copy](#which-package-a-file-belongs-to) |
    | `traced` | files Next.js traced for its server, which loads them from `node_modules` at runtime |
    | `runtime` | the bundler itself: its runtime, chunk wrappers and helpers are in the JavaScript it writes ([what is listed](coverage.md#also-listed)) |
    | `helpers` | a transpiler (`@babel/helpers`, `@swc/core`, `typescript`) whose helpers it inlined into a shipped module ([what is listed](coverage.md#also-listed)) |
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

### Copies of outputs

When such a process copies a file of an output (one its builds wrote) or a directory of it elsewhere, and the
lockfile is not copied with it, the place of the copy gets a copy of the lockfile, written and followed the same way:
where the copy's output directory is (as many directories up from the copy as the file is below the output
directory), e.g. `.output/public/bundle-lockfile/package-lock.json` for Nitro's copies of
`.nuxt/dist/client/_nuxt/*` into `.output/public/_nuxt/`. A copy of some of the output's files lists all of its
packages. Not with `BUNDLE_LOCKFILE_INLINE=0`, not where a lockfile is already, not into an output or a directory
holding one, and not below `node_modules`.

## The package.json tree

Image scans read no lockfiles (see the README's [SBOM tools](../README.md#sbom-tools)); they read the `package.json`
files of installed packages. With `BUNDLE_LOCKFILE_TREE=on`, every lockfile (and its export copy, and its copies) has a
tree next to it with one `package.json` per entry: `bundle-lockfile/packages/<id>/node_modules/<name>/package.json`,
with the entry's `name`, `version` and `license` only (`<id>`: the first 16 hex digits of the SHA-256 of the entry's
key). Each is a package root by Trivy's rules (the directory below the last `node_modules`), so syft's image catalogers
and `trivy rootfs` (also `trivy image`) report every package once, with its license; directory scans (`syft scan dir:`,
`trivy fs`) read no `package.json` files and report the lockfile's packages, also once. Node.js and the bundlers never
resolve into it: no output file is below it.

The tree is written with the lockfile, under its lock, built aside and renamed into place: a rewrite with fewer packages
leaves none of the others' stubs, and one with the same packages leaves the tree as it is. bundle-lockfile's own checks
of the output (files written after the build, copies made with fs) leave the tree out. A package whose `package.json`
names it with something that is no path below `node_modules` (`..`, a further `/`) gets no stub: the tree is not
written, which fails the build (`BUNDLE_LOCKFILE_STRICT=0`: a warning) - its stub would land outside the tree. A tool
that reads both a shipped tree and the lockfile lists each package twice: syft with both its lock and package catalogers
(a melange SBOM generator that adds `javascript-lock-cataloger` to the image catalogers), so leave the setting off where
the lockfile is read already. With `BUNDLE_LOCKFILE_TREE=only` there is no `package-lock.json`: the lockfile, record and
all, is `record.json` next to the tree, for outputs that are scanned only as images. syft reports a stub as found by its
`javascript-package-cataloger` ("installed node module manifest file"): bundled packages look installed.

## Several writers, one lockfile

Builds that write to the same directory share its lockfile: it lists the packages of all of them.
- In one process (e.g. a webpack config array whose app and service worker both go to `dist/`, or plugin-legacy's two
  outputs) they build in parallel or rebuild in watch mode.
- Separate processes (e.g. two `webpack` or `vite build` commands run by `concurrently` or `run-p`) find each other's
  writers in the lockfile on disk, and keep their packages as long as one of the files recorded for them (up to 20,
  the first by path) is still there and was not written again by a build of this process. A writer recorded without
  files has nothing in the output and is not kept. An earlier run of the same build (its writer has the same id) keeps
  the files it left that the new run did not write again (other hashes in their names, no clean): as a writer of its
  own.

Each read-merge-write runs under a lock and replaces the file atomically, so no process reads a partly written one. The
lock is `package-lock.json.lock` (with `BUNDLE_LOCKFILE_TREE=only`: `record.json.lock`) next to the lockfile (next to
the export copy with `BUNDLE_LOCKFILE_INLINE=0`, or when the output directory was removed). A lock older than a minute -
by this machine's clock and by the file system's (a network file system has the server's time) - is taken over; one that
cannot be removed (another user's directory, a read-only file system) is waited for. After 30 s of waiting the write
goes ahead without it, and the build fails (another process's packages may be missing; with `BUNDLE_LOCKFILE_STRICT=0`:
a warning). So does a lock that cannot be created at all, and a lockfile that is there but cannot be read.

- A writer's packages count once its output is written: a rebuild that fails and is not emitted (webpack's default in
  production) leaves the packages of its previous output in the lockfile - also when the build that failed is the
  writer's first in a new process (the record its earlier process left stays).
- A webpack or rspack compiler is recognized by its configuration: name, entry, target and file name templates, per
  output directory. A new compiler for the same configuration (e.g. a build restarted in the same process, or run again)
  replaces the previous one's packages. In the same process that happens once the previous one is closed (webpack <
  5.17, without a shutdown hook: no longer running); until then both are listed.
- A Vite/Rollup/Rolldown output is recognized by the kind of build (Vite, Rollup, Rolldown), its input, its format,
  its position among the build's outputs, its entry file name template (if it is a string) and its `output.file`, if
  it has one (separate builds of one input, such as the configs of `rollup -c`, each with its own file in one
  directory). Paths in these ids are relative to the context or working directory, those in a package from its last
  `node_modules` (Yarn's global cache, a global store), so that the ids are the same on every machine.
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

A bundled file that another build wrote brings the packages that build put into it. E.g. GitLab's webpack build
bundles the Vite-built "island" `ee/frontend_islands/apps/duo_next/dist/main.js`, with Vue inlined, as part of its own
code.

Every Vite, Rollup and Rolldown lockfile records the SHA-256 of its JavaScript and CSS files (`outputs`) and the
packages in each (`contents`):
- a chunk: its modules' packages (not those of style sheets Vite took out of it into a CSS file), and those of the
  files the build's plugins inlined that are no style sheets (which module inlined which is not known);
- a CSS file: those of the style sheets that went into it (of all the build's extracted style sheets if no chunk
  imports it), of the files it was emitted from, and of every file the build's plugins inlined, such as the style
  sheets it `@import`s from packages (which style sheet inlined which is not known);
- a JavaScript asset (Vite's worker chunks): the packages of the build that produced it.

webpack, rspack and Angular lockfiles record no `outputs`: a JavaScript or CSS file among a writer's `files` brings all
of that writer's packages (a library built by webpack and bundled by the app, a DLL bundle), as does any such file of
a writer whose `files` are only some of them (`count`).

Of an output with more than 500 such files, only the first 500 by path are recorded, and `outputCount` gives the
number of all of them. A JavaScript or CSS file in that output which is none of the 500 may be one of the others: it
brings all of the writer's packages (one package too many rather than the packages inlined into it missing).

For every bundled file outside `node_modules`, bundle-lockfile looks for `<dir>/bundle-lockfile/package-lock.json`
(`BUNDLE_LOCKFILE_FILE`, or its copy in the export directory), and for `record.json` next to it (the island built with
`BUNDLE_LOCKFILE_TREE=only`), in the file's directory and each directory above it - whatever this build's own setting;
of both, the more recently written one. In
the first lockfile that records the file, a matching hash adds the packages in that file to this build's (all of the
writer's packages if the lockfile records none per file). This works in webpack, rspack, Vite, Rollup and
Rolldown builds.
- It also covers a first-party package linked into `node_modules` (e.g. a workspace package built by Vite), at its
  real location, whether the bundler resolved the link or kept it (webpack's `resolve.symlinks: false`, Vite's
  `resolve.preserveSymlinks`).
- A build that bundles only an island's style sheet gets the packages in it, not those of the island's JavaScript.
- A file at a path the record has that changed after its build (post-processed, minified again) still brings that
  build's packages, with a warning: the record says by path that the build wrote it.
- That build's lockfile is a problem if it cannot be read, is not JSON, or has a record of another version or shape:
  the packages of its files would be missing (a `package-lock.json` without a record, another tool's, is left alone).
- The record travels with the output, so this works across processes, separate commands and machines.
- webpack and rspack lockfiles record no hashes: a bundle they built that another build bundles is not attributed.
