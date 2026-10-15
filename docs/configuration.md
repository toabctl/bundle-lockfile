# Configuration

Every setting in full: where settings come from, what each one takes, which are invalid, where the export directory
puts the lockfiles, and how the node shim works. The overview and the common setups are in the
[README](../README.md#configuration).

## Where settings come from

1. **Environment variables** `BUNDLE_LOCKFILE_*`.
2. **A settings file**, for builds whose tools do not pass the variables on (turbo's strict env mode, a build that
   starts with an environment of its own): a JSON object with the same names as keys, e.g.
   `{ "BUNDLE_LOCKFILE_EXPORT_DIR": "/home/build/export", "BUNDLE_LOCKFILE_INLINE": "0" }`. It is
   `config.json` next to `register.cjs` (`src/config.json` in a checkout), or the file `BUNDLE_LOCKFILE_CONFIG` names.
   A missing `config.json` is no error. The project cannot provide one: a package build's lockfiles must not be
   redirected by the project it builds.

A variable that is set, also to an empty value, wins over the file. The file's settings are put into the
environment of the process, so that the processes the build starts get them as variables.

## Settings

| Variable | Default | |
|---|---|---|
| `BUNDLE_LOCKFILE_FILE` | `bundle-lockfile/package-lock.json` | output path, relative to the bundler's output directory and inside it, named `package-lock.json` and not below a `node_modules` directory: syft and Trivy read only files named `package-lock.json`, and none below `node_modules` (spaces around it are ignored; only on Windows is a backslash a separator). A `package-lock.json` there that bundle-lockfile did not write (the project's own, with `package-lock.json` and an output directory that is the project) is never replaced: the build fails |
| `BUNDLE_LOCKFILE_EXPORT_DIR` | unset | an absolute path: also write every lockfile below this directory ([layout](#the-export-directory)) |
| `BUNDLE_LOCKFILE_EXPORT_BASE` | unset | an absolute path, with `BUNDLE_LOCKFILE_EXPORT_DIR`: lockfiles below this directory are placed relative to it in the export directory, the others at their absolute path below `_outside_base/` (default: all at their absolute path) |
| `BUNDLE_LOCKFILE_INLINE` | on | off: write lockfiles only into the export directory (without `BUNDLE_LOCKFILE_EXPORT_DIR` nothing is written, and the build fails, or warns with `BUNDLE_LOCKFILE_STRICT=0`) |
| `BUNDLE_LOCKFILE_STRICT` | on | a build whose lockfile cannot be written or would be incomplete fails (see [troubleshooting](troubleshooting.md)); off: only warn, and let the build go on (e.g. for local experiments or dev servers) |
| `BUNDLE_LOCKFILE_DEBUG` | off | on: log what gets patched and applied to stderr |
| `BUNDLE_LOCKFILE_FIRST_PARTY` | unset | comma-separated absolute globs of directories that are first-party: never listed as [vendored copies](format.md#which-package-a-file-belongs-to). A glob names directories, not what is below them: `/src/app/lib/**` for `/src/app/lib/` and everything in it; `/**`: no vendored copies outside `node_modules`. A glob through a symbolic link also names the directories at their real paths |
| `BUNDLE_LOCKFILE_DISABLE` | unset | comma-separated names to skip, case-insensitive: `webpack` (also Next.js, and the failure of builds bundle-lockfile cannot hook in its place: Next.js with Turbopack, `@vercel/ncc`); `rspack` (also Rsbuild, Rslib, next-rspack); `vite` (builds with Vite's plugins, also SvelteKit), `rollup`, `rolldown` (other `rollup()` / `rolldown()` builds, the `rollup` command line; `rolldown` also the failure of the `rolldown` command line, which is not hooked); `esbuild` (its JavaScript API); `parcel`; `angular` (its application builder); `next` (the runtime packages of Next.js' server, `.next/runtime/`); or `all`. Plugins added to a config by hand still run |
| `BUNDLE_LOCKFILE_ESM_HOOKS` | `auto` | how Vite, Rollup, Rolldown and rspack 2 are hooked (and webpack and rspack 1 when a loader hook such as Yarn Plug'n'Play's provides their code): `sync`, `async` or `off` instead of choosing by Node.js version ([which processes](bundlers.md#which-processes-are-hooked)). `sync` without `module.registerHooks` (Node.js before 22.15) is invalid; `async` hooks the main thread and worker threads. `async` uses `module.register`, which Node.js 24.15 / 25.9 deprecate and Node.js 26 warns about |
| `BUNDLE_LOCKFILE_TREE` | `off` | `on`: also a `package.json` per package next to each lockfile, which image scans read ([the tree](format.md#the-packagejson-tree)); `only`: the tree instead of a `package-lock.json` - for an output scanned only as an image; the lockfile, record and all, is then `record.json` next to it (in `BUNDLE_LOCKFILE_FILE`'s directory), which no SBOM tool reads. Not for a webpack or rspack dev server's in-memory output |
| `BUNDLE_LOCKFILE_REGISTER` | `../src/register.cjs` or `../register.cjs` from the shim | an absolute path: the `register.cjs` the [node shim](#the-node-shim) preloads (only from the environment) |
| `BUNDLE_LOCKFILE_CONFIG` | `config.json` next to `register.cjs` | an absolute path: the settings file (only from the environment) |

On/off settings take `1`, `true` or `on` and `0`, `false` or `off`, in any case; empty means the default.
`BUNDLE_LOCKFILE_NODE_SHIM` and `BUNDLE_LOCKFILE_NODE_SEEN` are set by the node shim for the processes it starts; do
not set them.

## Invalid settings fail the build

A setting that bundle-lockfile does not recognize, or that cannot work, fails every process that preloads
bundle-lockfile: its first build, or else the process itself at exit, also `npm ci` (with `BUNDLE_LOCKFILE_STRICT=0`: a
warning). A build must not go on without doing what was asked of it. That is:
- a `BUNDLE_LOCKFILE_*` variable that is not in the table (e.g. a misspelled `BUNDLE_LOCKFILE_EXPORTDIR`), and in the
  settings file any other key, a key only the environment can set, or a value that is not a string, number or
  boolean;
- a value the setting does not take: an on/off setting set to anything else, a name `BUNDLE_LOCKFILE_DISABLE` or
  `BUNDLE_LOCKFILE_ESM_HOOKS` does not take;
- a relative `BUNDLE_LOCKFILE_EXPORT_DIR`, `BUNDLE_LOCKFILE_EXPORT_BASE`, `BUNDLE_LOCKFILE_CONFIG` or
  `BUNDLE_LOCKFILE_REGISTER`, or a relative glob in `BUNDLE_LOCKFILE_FIRST_PARTY` (each process would resolve it in
  its own working directory), and
  `BUNDLE_LOCKFILE_EXPORT_BASE` without an export directory;
- a `BUNDLE_LOCKFILE_FILE` that syft and Trivy would not read;
- a settings file that cannot be read, or a file `BUNDLE_LOCKFILE_CONFIG` names that does not exist;
- another copy of bundle-lockfile preloaded into the same process (only the first one would run).

With `BUNDLE_LOCKFILE_DISABLE=all` nothing is checked. A plugin added to a config by hand, without the preload, does
not check the settings.

## The export directory

With `BUNDLE_LOCKFILE_EXPORT_DIR`, every lockfile is also written below that directory, at a path made from its own:
- below `BUNDLE_LOCKFILE_EXPORT_BASE`: its path relative to the base (also through symbolic links: both are compared
  by their real paths too);
- elsewhere, with an export base: its absolute path without the leading `/`, below `_outside_base/`, so that it never
  lands where one below the base does;
- without an export base: its absolute path without the leading `/`.

With `BUNDLE_LOCKFILE_EXPORT_DIR=/home/build/export` and `BUNDLE_LOCKFILE_EXPORT_BASE=/home/build`:

```
/home/build/ui/dist/bundle-lockfile/package-lock.json   ->  /home/build/export/ui/dist/bundle-lockfile/package-lock.json
/tmp/x/dist/bundle-lockfile/package-lock.json           ->  /home/build/export/_outside_base/tmp/x/dist/bundle-lockfile/package-lock.json
```

Two lockfiles of one process that map to one export path (a directory named `_outside_base` below the base) fail the
build. Copying the export directory into a package keeps these paths: syft reports each lockfile's packages there.

## The node shim

`bin/node`, first in `PATH`, puts the `--require` back into `NODE_OPTIONS`, keeping everything else, and runs the
real `node`. So every `node` started through `PATH` — by npm, pnpm, yarn, bun, `cross-env` or a shell — loads
bundle-lockfile, also when a build script overwrites `NODE_OPTIONS`.
- It adds nothing if `NODE_OPTIONS` already preloads bundle-lockfile: the same file through another path (e.g. a
  symlinked install directory, also quoted with spaces), or another copy of it. One preload is enough.
- The real `node` is the first one in `PATH` that is neither the shim (nor a copy of it) nor a wrapper script it has
  already passed through. Yarn's temporary `node` wrapper and asdf's and nodenv's shims are such scripts.
- Not covered: a `node` started by its absolute path, or through a `PATH` that a version manager put the real `node`'s
  directory in front of (nodenv and asdf do, for what they start). Those keep the `NODE_OPTIONS` they get - except
  where a preloaded process starts them itself (`child_process`, `worker_threads`) with an environment that drops the
  `--require`: with the shim in use, bundle-lockfile puts it back (without the shim: a warning).
- It preloads the `register.cjs` that `BUNDLE_LOCKFILE_REGISTER` names. By default it looks for `../src/register.cjs`
  (a checkout, as in `/opt/bundle-lockfile`) and `../register.cjs` (a package, `/usr/lib/bundle-lockfile/bin/node`
  next to its `register.cjs`), from its own directory with symlinks resolved.
- `BUNDLE_LOCKFILE_REGISTER` must be set in the environment, as an absolute path (`node` would take a relative one
  for a package name, in every directory it runs in). The shim is a shell script and does not read the settings file:
  a shim started by a preloaded process sees the file's settings as variables, but the first one, which starts the
  build, does not.
- Without a `register.cjs` (none found, or `BUNDLE_LOCKFILE_REGISTER` names no file or a relative path), the shim
  fails without running `node`, as bundle-lockfile fails a build it cannot write a lockfile for. With
  `BUNDLE_LOCKFILE_STRICT=0` in the environment it warns and runs `node` without the preload; with
  `BUNDLE_LOCKFILE_DISABLE=all` it just runs `node`.
- It needs a POSIX `sh` with `readlink -f` and `head -c` (GNU coreutils, BusyBox and macOS have them).

Tested with npm, pnpm, yarn 1, yarn 4 (node-modules linker), bun and `cross-env` (webpack and rspack 2), npm (Vite),
and a build that starts with an environment of its own (`env -i`) with a settings file.
