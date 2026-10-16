// What the webpack adapter (webpack-family.cjs, webpack-collect.cjs, webpack-compat.cjs, webpack.cjs, rspack.cjs) reads
// of webpack's and rspack's objects, for the type check only: webpack 4 and 5 (also Next.js' copy), rspack 1 and 2. A
// member every one of them has is typed as it is; one some lack, or that the code checks before it uses it, is optional
// or unknown. Not webpack's or rspack's own types: they are no development dependencies, and each describes one version.
// The adapter's own marks on these objects (symbol keys) are typed where they are set.

/** A tapable hook, as the plugin taps it */
export interface Hook<A extends unknown[] = unknown[]> {
  tap(options: string | { name: string; stage?: number }, fn: (...args: A) => void): void;
  tapAsync(options: string | { name: string; stage?: number }, fn: (...args: [...A, (err?: unknown) => void]) => void): void;
}

/** An asset's content (webpack-sources' Source, or the plain object webpack-compat.cjs sourceOf makes) */
export interface Source {
  source(): string | Buffer;
  size(): number;
}

/** webpack-sources' RawSource */
export type RawSourceClass = new (text: string) => Source;

/** An asset (webpack >= 4.40 and rspack: getAsset(); before, made of compilation.assets) */
export interface Asset {
  name: string;
  source: Source;
  /** sourceFilename: a copied file's, an asset module's; copied: CopyRspackPlugin's and copy-webpack-plugin's copies */
  info?: { sourceFilename?: unknown; copied?: unknown };
}

/** A module: a NormalModule, a ConcatenatedModule (modules), mini-css-extract's CssModule, an external, ... */
export interface Module {
  identifier(): string;
  resource?: string;
  matchResource?: unknown;
  nameForCondition?: () => string | null;
  /** webpack 4 (webpack 5 and rspack: the module graph) */
  issuer?: Module | null;
  /** the inner modules of a ConcatenatedModule */
  modules?: Iterable<Module>;
  buildInfo?: {
    fileDependencies?: Iterable<unknown>;
    snapshot?: {
      getFileIterable?: () => Iterable<unknown>;
      fileTimestamps?: Map<unknown, unknown>;
      fileHashes?: Map<unknown, unknown>;
      fileTshs?: Map<unknown, unknown>;
      managedFiles?: Set<unknown>;
    };
    /** webpack 4: a module's emitFile assets */
    assets?: object;
  };
  /** a NormalModule's (core/helpers.cjs) */
  loaders?: unknown;
  originalSource?: () => ({ source?: () => unknown } | null);
}

export interface Chunk {
  /** an array (webpack 4) or a Set */
  files: Iterable<string>;
  /** webpack 5: source maps, the assets of its modules */
  auxiliaryFiles?: Iterable<string>;
  /** webpack 4 (webpack 5 and rspack: the chunk graph) */
  entryModule?: Module;
  modulesIterable?: Iterable<Module>;
}

/** An output file system: webpack's (graceful-fs, webpack 4's NodeOutputFileSystem), Node's fs, or an in-memory one */
export interface OutputFileSystem {
  writeFile(file: string, content: string, callback: (err: unknown) => void): void;
  readFile?: (file: string, callback: (err: unknown, content: Buffer) => void) => void;
  lstat?: (file: string, callback: (err: unknown) => void) => void;
  stat?: (file: string, callback: (err: unknown) => void) => void;
  /** graceful-fs */
  gracefulify?: unknown;
}

export interface InputFileSystem {
  readFile?: (this: unknown, file: unknown, ...rest: unknown[]) => unknown;
}

/** compiler.webpack: the bundler's exports (webpack >= 5.1, rspack) */
export interface BundlerExports {
  version?: unknown;
  rspackVersion?: unknown;
  WebpackError?: new (message: string) => Error & { hideStack?: boolean };
  Compilation?: { PROCESS_ASSETS_STAGE_OPTIMIZE?: unknown };
  sources?: { RawSource?: RawSourceClass };
}

export interface Compiler {
  name?: string;
  context: string;
  outputPath: string;
  options?: {
    entry?: unknown;
    target?: unknown;
    output?: { filename?: unknown; chunkFilename?: unknown };
    plugins?: unknown[];
    optimization?: { usedExports?: unknown; inlineExports?: unknown };
    experiments?: { inlineConst?: unknown; inlineEnum?: unknown };
  };
  /** the others (shutdown, ...): webpack-compat.cjs hook() */
  hooks: { thisCompilation: Hook<[Compilation]>; emit: Hook<[Compilation]>; afterEmit: Hook<[Compilation]> };
  webpack?: BundlerExports;
  outputFileSystem?: OutputFileSystem | null;
  inputFileSystem?: InputFileSystem | null;
  running?: unknown;
  isChild(): boolean;
}

export interface ModuleGraph {
  getIssuer(module: Module): Module | null | undefined;
  getExportsInfo(module: Module): { isModuleUsed(runtime: undefined): unknown };
}

export interface Compilation {
  compiler: Compiler;
  /** an array (webpack 4) or a Set */
  chunks: Iterable<Chunk>;
  /** webpack 5, rspack */
  chunkGraph?: {
    getChunkModulesIterable(chunk: Chunk): Iterable<Module>;
    getChunkEntryModulesIterable(chunk: Chunk): Iterable<Module>;
  };
  /** webpack 5, rspack */
  moduleGraph?: ModuleGraph;
  modules?: Iterable<Module>;
  children?: Compilation[];
  fileDependencies?: Iterable<unknown>;
  contextDependencies?: Iterable<unknown>;
  assets: Record<string, Source>;
  /** webpack >= 4.40, rspack */
  getAsset?: (name: string) => Asset | undefined;
  getAssets?: () => Asset[];
  emitAsset?: (name: string, source: Source) => void;
  getPath?: (path: string, data: object) => string;
  errors: unknown[];
  /** read through webpack-compat.cjs hook() */
  hooks: object;
}
