# Troubleshooting

The [README](../README.md#troubleshooting) has the short version.

## The build fails with `[bundle-lockfile] ERROR`

The build failed because its lockfile would be missing or incomplete; the message says why. webpack reports it as a
compilation error (`bundle-lockfile: the lockfile would be missing or incomplete …`), Vite and Rollup as an error of
the `bundle-lockfile` plugin. A problem outside any build (a bundler that could not be hooked, a settings file that
cannot be read) makes the process exit with code 1 after printing `[bundle-lockfile] ERROR: …` and `the process fails
because a lockfile would be missing or incomplete`. In the watch mode of Vite, Rollup and Rolldown, an error after the
output is written is printed and the watcher goes on. A bundler that cannot be hooked fails its own `require()` or
`import` (in whatever process or thread loads it), e.g. with `bundle-lockfile: could not wrap <file URL>: …` (with
`BUNDLE_LOCKFILE_STRICT=0` it loads unchanged, with a warning).

| Message | Cause | What to do |
|---|---|---|
| `could not write <lockfile>` | the output directory or the export directory is not writable, or a file is where the `bundle-lockfile/` directory must go | fix the permissions or the paths (`BUNDLE_LOCKFILE_FILE`, `BUNDLE_LOCKFILE_EXPORT_DIR`) |
| `could not lock <lockfile> - writing it without the lock …` | another process held the lock for more than 30 s; the lockfile is written, but may miss that process's packages | look for a hanging build writing the same output directory |
| `could not write the copy <copy> of <lockfile>` | a copy of a lockfile made with fs (e.g. SvelteKit's adapters' in `build/`) could not be rewritten for its place | fix the permissions of the copy |
| `could not read <lockfile>: the packages other processes recorded there may be missing` | the lockfile is there but cannot be read (permissions, too many open files) | fix the permissions; look for another user's build writing the same output directory |
| `<lockfile> is there and was not written by bundle-lockfile (e.g. npm's own lockfile): it is not replaced` | `BUNDLE_LOCKFILE_FILE` names a file another tool wrote, e.g. `package-lock.json` with an output directory that is the project | use another `BUNDLE_LOCKFILE_FILE` (the default) or output directory |
| `its export copy <file> is also the export copy of <lockfile>` | two lockfiles of one process map to one export path (a directory `_outside_base` below `BUNDLE_LOCKFILE_EXPORT_BASE`) | rename the directory, or change the export base |
| `… exports none of …: a version of … bundle-lockfile does not know`, `… has no Compiler bundle-lockfile knows`, `the Compiler of rspack … is not one bundle-lockfile knows`, `… is no Rollup bundle-lockfile can hook` | a bundler version bundle-lockfile cannot hook (newer, or Rollup before 2.78): its builds would write no lockfile | use a supported version ([Supported](../README.md#supported)), or report it |
| `Node.js … has no ESM hooks (module.register: 20.6 and later)` | Node.js 20.0 – 20.5 in a process that builds with Vite, Rollup, Rolldown or rspack 2 | use Node.js 20.6 or later |
| `<file URL> is wrapped, but bundle-lockfile is not loaded in this thread` | an ES-module bundler's entry was replaced by bundle-lockfile's wrapper in a thread where its preload did not run | please report it, with the Node.js version and how the build starts its threads |
| `could not read <lockfile>: the packages of the build that wrote <dir> would be missing …`, `<lockfile> is not JSON: …`, `<lockfile> has a record of version …` | a bundled file is below the output of another build whose lockfile cannot be read ([nested bundles](format.md#nested-bundles)): permissions, an edited file, a lockfile of another bundle-lockfile version | fix the permissions, or rebuild that output with this bundle-lockfile |
| `could not read the settings file <file>` | `config.json` next to `register.cjs`, or the file `BUNDLE_LOCKFILE_CONFIG` names, is not a JSON object, cannot be read, or (named) does not exist | fix the file or `BUNDLE_LOCKFILE_CONFIG` ([settings](configuration.md#invalid-settings-fail-the-build)) |
| `rspack <version> is not supported (it needs 1.1 or later)` | rspack 1.0 or 0.x | upgrade rspack |
| `Next.js built with Turbopack, which bundle-lockfile does not hook …` | `next build` with Turbopack (Next.js 16's default, `--turbopack` before) | `next build --webpack`, or next-rspack |
| `Parcel is not hooked …`, `the rolldown command line is not hooked …`, `@vercel/ncc builds with a webpack of its own …`, `webpack before 4 is not supported …` | a bundler bundle-lockfile recognizes but does not hook: its build would ship without a lockfile | build with a [supported bundler](../README.md#supported) (Rolldown: its JavaScript API or Vite), or `BUNDLE_LOCKFILE_STRICT=0` where no lockfile is needed |
| `BUNDLE_LOCKFILE_… is set, but is no setting of bundle-lockfile`, `… is not recognized`, `… is none of …`, `… is not an absolute path`, `… without BUNDLE_LOCKFILE_EXPORT_DIR`, `… needs module.registerHooks …`, `the settings file … sets …` | a setting bundle-lockfile does not recognize, or that cannot work ([settings](configuration.md#invalid-settings-fail-the-build)) | fix the name or the value |
| `another copy of bundle-lockfile is preloaded too: <register.cjs>` | two `--require`s of bundle-lockfile (e.g. one in the environment, one added by the recipe) | preload one |
| `node shim: no register.cjs next to …`, `node shim: BUNDLE_LOCKFILE_REGISTER names no file: …`, `… is not an absolute path: …` | the [node shim](configuration.md#the-node-shim) was copied without bundle-lockfile's `src/`, or `BUNDLE_LOCKFILE_REGISTER` is wrong | install `bin/` and `src/` together, or set `BUNDLE_LOCKFILE_REGISTER` to the absolute path of `register.cjs` |
| `BUNDLE_LOCKFILE_INLINE is off and BUNDLE_LOCKFILE_EXPORT_DIR is not set` | nowhere to write | set `BUNDLE_LOCKFILE_EXPORT_DIR`, or leave the inline lockfile on |
| `no package.json with name and version in <dir> - its bundled files are not listed` | bundled code in `node_modules` that belongs to no package (a package without `version`, files a tool put there) | install the package properly; a directory whose name starts with a dot (`node_modules/.cache`) is skipped |
| `<adapter>: could not collect …`, `could not patch …`, `could not attach to the compiler …`, `could not check the files copied …`, `could not add the files written … after the build`, `could not check the files written into … after the build`, `could not wrap …`, `<adapter> adapter failed to wrap …`, `could not install the ESM hooks` | a bug or an unexpected bundler version | report it with `BUNDLE_LOCKFILE_DEBUG=1` output |

`BUNDLE_LOCKFILE_STRICT=0` turns these into warnings and lets the build go on without a correct lockfile. Leave strict
mode on where the SBOM matters (package builds).

## Warnings and notes

They do not fail the build:
- `[bundle-lockfile] WARNING:` — with `BUNDLE_LOCKFILE_STRICT=0`, everything that would fail it. Always, once per
  process: bundled code from a `node_modules` directory without a `package.json`, listed as the package around it; an
  adapter that failed while inspecting a module that is not a bundler; ESM hooks that could not be installed in a
  process whose main script's package depends on no ES-module bundler; a limit that was reached, so that some files
  were not compared or checked (too many files below a directory, a file too large); a bundled file that another build
  wrote and that changed since, listed with that build's packages ([nested bundles](format.md#nested-bundles)).
- `[bundle-lockfile] note:` — always, once per process: a vendored copy that is listed (`BUNDLE_LOCKFILE_FIRST_PARTY`
  names directories that are not).

## No lockfile

- Look for `[bundle-lockfile] WARNING:` on stderr (with `BUNDLE_LOCKFILE_STRICT=0`: a lockfile that could not be
  written or locked, a failing adapter).
- Check that `NODE_OPTIONS` reaches the bundler: `BUNDLE_LOCKFILE_DEBUG=1` logs each bundler it patches and each
  lockfile it writes. A script that overwrites `NODE_OPTIONS` needs the [node
  shim](configuration.md#the-node-shim). `BUNDLE_LOCKFILE_DISABLE` may be set.
- The bundler is not supported: the `esbuild` command line (build with its JavaScript API instead), Angular's esbuild
  builder, Bun's own runtime (with `BUNDLE_LOCKFILE_STRICT=0` also those that fail in strict mode: Turbopack, Parcel,
  the `rolldown` command line, ncc, webpack < 4, rspack 0.x).
- On Node.js before 24.12 (25.2 on 25), Vite, Rollup, Rolldown and rspack 2 are hooked only in some processes: a
  programmatic build may need `BUNDLE_LOCKFILE_ESM_HOOKS=async` ([which
  processes](bundlers.md#which-processes-are-hooked)).
- `bun run` without Node.js installed runs the build in Bun's own runtime, which nothing hooks.
- Vite, Rollup and Rolldown outputs below `node_modules`, builds that write nothing themselves, `vite dev`, `vite
  preview`, Vitest, and a webpack build that failed and emitted nothing get no lockfile. (webpack and rspack outputs
  below `node_modules` get one, which syft and Trivy do not read.)
- Another plugin removed a webpack or rspack output directory after the build: only the export copy is written.
- `BUNDLE_LOCKFILE_INLINE=0` without `BUNDLE_LOCKFILE_EXPORT_DIR` writes nothing (and fails the build unless
  `BUNDLE_LOCKFILE_STRICT=0`).
- A step after the build dropped it: Next.js' static export and standalone output, a copy of only some files. Use an
  export directory.

## Debug output

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
