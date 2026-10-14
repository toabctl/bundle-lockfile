// The shapes the modules hand each other, for the type check only (tsconfig.json, `npm run typecheck`): the .cjs
// files refer to them with JSDoc (`@import { Package } from '../types'`). Nothing loads this file at run time.

/** A package as a lockfile lists it: what its package.json says, and where it is. */
export interface Package {
  name: string;
  version: string;
  /**
   * Its directory (a real path). A package whose location is not known has `\0unknown:<name>@<version>`, one outside
   * the project that another writer's record listed `\0outside:<key>` (see core/lockfile.cjs readMeta).
   */
  path: string;
  /** "license", or the legacy "licenses" (core/manifest.cjs licenseOf) */
  license?: string | string[];
  /** the key of a package outside the project, read from another writer's record */
  outside?: string;
  /** its location is not known: read from a copy, or no longer where a record said (core/outputs.cjs stillThere) */
  unknown?: boolean;
}

/** Anything with a package path: what a via collector records. */
export interface HasPath { path: string }

/** How each package was found: package path -> its classes (core/via.cjs CLASSES). */
export type Via = Map<string, Set<string>>;

/** core/via.cjs collector() */
export interface ViaCollector {
  add(cls: string, pkgs: Iterable<HasPath> | null | undefined): void;
  merge(other: ViaCollector | Iterable<[string, Iterable<string>]> | null | undefined): void;
  byPath: Via;
}

/** The bundler that ran, as it reports itself (a writer's "bundler"). */
export interface BundlerId { name: string; version?: string }

/** A package.json's content, as read (core/manifest.cjs readManifest): anything JSON can be. */
export type Manifest = { [key: string]: any };

/** Where a build is, for vendored copies outside node_modules (core/vendored.cjs scope). */
export interface BuildScope { context: string; /** entry modules' files; scope() skips what is no absolute path */ entries?: Iterable<unknown> }

/** core/vendored.cjs scope(): the vendored copy a file outside node_modules is in. */
export interface VendorScope {
  ownerOf(file: string): Package | null;
  manifest(dir: string): Manifest | null;
}

/** core/packages.cjs packagesOfFiles() */
export interface FilePackages {
  /** each package once */
  all: Package[];
  /** file (as given) -> its packages, also those inside a file another build wrote */
  byFile: Map<string, Package[]>;
  /** file -> the packages the file belongs to itself */
  ownByFile: Map<string, Package[]>;
  via: ViaCollector;
}

/** One build of a writer, as core/outputs.cjs keeps it (building, landed). */
export interface Build {
  pkgs: Package[];
  /** the directory package locations are relative to */
  context: string;
  /** absolute paths of the files the writer emits into the output */
  files: string[];
  /** absolute path -> "sha256-<hex>" of its JavaScript and CSS output files */
  outputs: Record<string, string>;
  /** absolute path -> the package paths in that output file */
  contents: Record<string, string[]>;
  bundler: BundlerId | null;
  via: Via | null;
}

/** A writer of a lockfile in this process (core/outputs.cjs): one compiler or build, across its rebuilds. */
export interface Writer {
  /** the id recorded in the lockfile, the same in every process and on every machine */
  id: string;
  building: Build | null;
  landed: Build | null;
}

/** A writer as a lockfile on disk records it (core/lockfile.cjs readMeta). */
export interface RecordedWriter {
  id: string;
  bundler: BundlerId | undefined;
  via: Via;
  files: string[];
  count: number | undefined;
  outputs: Record<string, string>;
  outputCount: number | undefined;
  contents: Record<string, Package[]>;
  pkgs: Package[];
}

/** The "bundle-lockfile" record of a lockfile, with absolute paths (core/lockfile.cjs readMeta). */
export interface LockRecord {
  context: string | null;
  /** written where it is read (true), a copy of one written elsewhere (false), no "self" (null) */
  anchored: boolean | null;
  writers: RecordedWriter[];
}

/** An ES module an adapter replaces by a wrapper (esm-wrap.cjs). */
export interface EsmEntry {
  /** the bundler, for messages and esmWrap */
  id: string;
  /** the module whose path ends with one of these */
  suffixes: string[];
  /** the exported functions (or classes) that go through esmWrap */
  wrap: string[];
}

/** A CommonJS file an ES-module bundler loads: the safety net of a thread without ESM hooks (hooks.cjs companion). */
export interface EsmCompanion { id: string; names: string[]; file: RegExp }

/** What an adapter (src/adapters/*.cjs) gives hooks.cjs; see the top of hooks.cjs. */
export interface Adapter {
  name: string;
  /** several bundlers, for BUNDLE_LOCKFILE_DISABLE */
  names?: string[];
  onCjsLoad?(exports: any, request: string, resolve: () => string): void | { exports: any } | undefined;
  cjsFiles?: RegExp[];
  cjsPackages?: string[];
  esmEntries?: EsmEntry[];
  esmPackages?: string[];
  esmWrap?(id: string, name: string, fn: any, url: string): any;
  esmCompanions?: EsmCompanion[];
}

/** A file written into an output after its build, and its packages (core/late.cjs). */
export interface LateFile { file: string; pkgs: Package[] }
