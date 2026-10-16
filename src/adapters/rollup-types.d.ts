// What the Rollup adapter (rollup.cjs, rollup-collect.cjs, rolldown-watch.cjs) reads of Rollup's, Rolldown's and Vite's
// objects, for the type check only: as far as every supported version has it (Rollup 2.78 and later, Rolldown 1, Vite
// 5 - 8); what the code checks (typeof, isObject) is unknown. Nothing loads this file at run time.

/** A chunk of a bundle (generateBundle's): Rollup 3 and later and Rolldown have moduleIds, Rollup 2 only modules */
export interface OutputChunk {
  type: 'chunk';
  fileName: string;
  code: string;
  isEntry: boolean;
  facadeModuleId: string | null;
  moduleIds?: string[];
  modules?: Record<string, unknown>;
  /** Vite's: the CSS files the chunk imports */
  viteMetadata?: { importedCss?: Set<string> };
}

/** An asset of a bundle: originalFileName from Rollup 4.20 (Vite passes it from 5.4), originalFileNames from Rollup 4.36 and Rolldown */
export interface OutputAsset {
  type: 'asset';
  fileName: string;
  source: string | Uint8Array;
  originalFileName?: string | null;
  originalFileNames?: string[];
}

export type OutputFile = OutputChunk | OutputAsset;
/** file name -> file */
export type OutputBundle = Record<string, OutputFile>;

/** An output's options, as the output hooks get them (Rollup and Rolldown check them before) */
export interface OutputOptions {
  dir?: string;
  file?: string;
  format?: string;
  /** a pattern, or a function */
  entryFileNames?: unknown;
}

/** this.meta of a plugin hook: the versions (viteVersion from Vite 7 on), watchMode */
export interface PluginMeta {
  rollupVersion?: unknown;
  rolldownVersion?: unknown;
  viteVersion?: unknown;
  watchMode?: unknown;
}

/** The plugin context of a hook (`this`) */
export interface PluginContext {
  meta: PluginMeta;
  getModuleIds(): Iterable<string>;
  getModuleInfo(id: string): unknown;
  /** Rollup's; Rolldown has none (rolldown#819) */
  getWatchFiles?: () => unknown[];
  /** throws the build's error */
  error(err: unknown): never;
}
