# What a lockfile lists

Which packages a lockfile lists, and which it does not. Usage is in the [README](../README.md); which package a file
belongs to in [format.md](format.md#which-package-a-file-belongs-to); how the files are found in
[internals.md](internals.md#beyond-the-chunks-modules).

## Shipped, not executed

The bundler decides what is in the bundle. From the entry points it follows `import`, `require()` and `import()`,
drops ES modules whose exports are unused and that have no side effects (declared with `sideEffects` in
`package.json`; webpack 5, Rollup and Rolldown also analyze the code), and writes the rest into chunks.
bundle-lockfile takes the modules of the chunks the build writes, maps each module's file to its npm package, and
lists those packages.

That is *shipped* code, not necessarily *executed* code. Lazily loaded chunks that are never opened, branches that
never run, and a package of which only one function is used are all listed. A module in a chunk counts even if none of
its code remains: `d3`, which only re-exports `d3-*`, was listed for GitLab (webpack 4) and LibreChat (Vite) although
the source maps show none of its code.

## Also listed

- **the runtime packages of a Next.js server**: what Next traces for its server (`.nft.json`), in a lockfile of their
  own ([Next.js](bundlers.md#nextjs)).
- **webpack and rspack child compilations whose output is shipped**: workers (`worker-loader`, also inlined;
  monaco-editor-webpack-plugin's) and workbox's `InjectManifest` service worker. Child compilations that only run at
  build time (html-webpack-plugin's template, mini-css-extract-plugin's loader, vanilla-extract's compiler) are not.
- **files copied verbatim into a webpack output**, e.g. by copy-webpack-plugin, whose assets record their source from
  6.3 on. Copies that record none (copy-webpack-plugin 5 and 6.0 – 6.2) count if they have the bytes of a package file
  the compilation depends on: a file dependency, or a file in a copied directory.
- **output of builds that write nothing themselves**: Vite's workers (also the package files they emit, e.g. a font),
  @vitejs/plugin-legacy's polyfills, workbox-build's service worker (vite-plugin-pwa, workbox-webpack-plugin's
  `GenerateSW`), and any `generate()` or `build.write: false` build. Their packages are listed where their bytes end up
  in a written output, or where a module imports their entry with `?worker&inline`.
- **files a loader or plugin inlines into a module**, which are no modules of their own, as the build records them (a
  loader's `this.addDependency`, a plugin's `this.addWatchFile`):
  - style sheets `@import`ed from packages: CSS, Sass, Less and Stylus in Vite, Rollup and Rolldown; Sass, Less,
    postcss-import and Tailwind through their webpack loaders, also in a Vue single-file component's `<style>` block
    and an Angular component's styles;
  - images and fonts from packages that a style sheet inlines as `data:` URLs: in webpack and rspack builds (also
    those mini-css-extract-plugin builds at build time, in no chunk), in esbuild builds (the `dataurl`, `base64`,
    `text` and `binary` loaders), and in Vite builds from 6.1 on (an image that JavaScript inlines with
    `new URL(..., import.meta.url)`: from Vite 7 on);
  - other files: a shader's `#include`s (glslify-loader), JSON a loader or plugin merges into a module.
- **files other plugins write into the output after the build**, e.g. vite-plugin-pwa's `sw.js`,
  vite-plugin-static-copy's copies, a copy in webpack's `afterEmit` hook (filemanager-webpack-plugin's) (see
  [limits](internals.md#files-written-after-the-build)).
- **files copied out of packages** with fs's copy functions (`copyFile`, `cp`, also through fs-extra and graceful-fs)
  in the same process as the build, into what it bundles or into its output, as long as the copy has the bytes of its
  source.
- **vendored copies**: a package copied into another package or outside `node_modules`, with its own `package.json`
  ([rules](format.md#which-package-a-file-belongs-to)).
- **nested bundles**: a bundled file that another Vite, Rollup or Rolldown build wrote brings that build's packages
  ([details](format.md#nested-bundles)).

## Not listed

- packages the bundler leaves out: externals, CDN scripts, an unresolvable `require(variable)`;
- modules that exist only in the bundler's input file system (webpack-virtual-modules, unplugin's virtual modules): in a
  package directory that is not on disk, no package's (a warning); inside an installed package, listed as that package;
- packages a server loads from `node_modules` at runtime (see [SvelteKit](bundlers.md#sveltekit)), except Next.js'
  (below): image scans of a shipped `node_modules` read them from its `package.json` files, directory scans do not
  ([which scans](../README.md#sbom-tools));
- files put into the output without the bundler, e.g. `cp node_modules/x/dist/x.js dist/` in a script; files copied
  out of a package by reading and writing them, or in another process (except files written into an output after the
  build whose path there contains `node_modules/<package>/`), e.g. `public/` files taken from a package once, by hand;
- files a plugin inlines without recording them: vite-plugin-glsl's `#include`s in a production build, the icons
  unplugin-icons inlines from `@iconify-json/*` packages (from a virtual module);
- in Vite 5 and 6.0: a package's image or font that a style sheet's `url()` inlines as a `data:` URL (Vite's
  `build.assetsInlineLimit`, 4 KiB by default), and before Vite 7 one that JavaScript inlines with `new URL()`: no
  module, asset or file the build records names it;
- files of packages that configure the build, which loaders and plugins read: `package.json` files, `tsconfig.json`
  and the bases it extends (`@tsconfig/*`), type declarations (`@types/*`), Babel, browserslist, PostCSS, SWC and
  ESLint settings;
- a package file webpack pulls in under a first-party match resource (`<name>!=!<loaders>!<file>`), e.g.
  vanilla-extract's placeholder in `@vanilla-extract/webpack-plugin`;
- a package whose only use is a small constant that webpack 5.108+ inlined (`optimization.inlineExports`, on by
  default in production), leaving its module in no chunk (rspack builds list such packages, see
  [rspack](bundlers.md#rspack-rsbuild));
- vendored code without a `package.json`: inside a package it counts as that package (a `node_modules/<name>`
  directory without one: as the package around it, with a warning), outside `node_modules` (a copied
  `jquery.min.js`) as first-party;
- workspace packages and other linked first-party packages (their dependencies are listed);
- the bundler's runtime code (webpack 5's runtime modules, Vite's preload helper and modulepreload polyfill,
  Rolldown's runtime, @rollup/plugin-commonjs's helpers), which is generated, not a package's file. webpack 4's
  `webpack/buildin/*` are files of webpack, so webpack 4 builds list `webpack`; Parcel generates its runtime as a file
  of `@parcel/runtime-js`, which is listed;
- Sass and Less partials that Parcel's transformers inline (no assets).

## Listed although not shipped

- the package of a file a loader or plugin records but inlines nothing from (one that is no code and no build tool's
  settings by its name);
- the package of a Sass partial with only variables that a style sheet `@import`s (it adds
  no bytes);
- the packages of the style sheets a Vite SSR build imports, although it emits no CSS (plugins such as
  vite-plugin-css-injected-by-js put CSS into JavaScript, so style modules count without a CSS file).
