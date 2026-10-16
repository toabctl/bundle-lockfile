// The shapes the modules hand each other, for the type check only (tsconfig.json, `npm run typecheck`): the .cjs
// files refer to them with JSDoc (`@import { Package } from '../types'`). Nothing loads this file at run time.

/** What every package has: what its package.json says. */
interface PackageBase {
  name: string;
  version: string;
  /** "license", or the legacy "licenses" (core/manifest.cjs licenseOf) */
  license?: string | string[];
}

/** A package at a directory this process knows (a real path): read from its package.json, or from a record. */
export interface LocatedPackage extends PackageBase {
  path: string;
  outside?: undefined;
  unknown?: undefined;
}

/** A package outside the project that another writer's record listed: only its key is known (core/lockfile.cjs readMeta). */
export interface OutsidePackage extends PackageBase {
  /** an id of its own, never a real path that could be another package */
  path: `\0outside:${string}`;
  /** its key in that record */
  outside: string;
  unknown?: undefined;
}

/**
 * A package whose location is not known: read from a copy, or no longer where a record said (core/outputs.cjs
 * stillThere). The same package as any other one with its name and version (core/lockfile.cjs toPackageLock).
 */
export interface UnknownPackage extends PackageBase {
  path: `\0unknown:${string}`;
  unknown: true;
  outside?: undefined;
}

/**
 * A package as a lockfile lists it: what its package.json says, and where it is. `path` identifies it everywhere (maps,
 * a writer's contents and via); only a LocatedPackage's is a directory (core/lockfile.cjs located).
 */
export type Package = LocatedPackage | OutsidePackage | UnknownPackage;

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

/**
 * What a lockfile records of a writer's build, with absolute paths: one build of this process (Build), one another
 * process recorded (RecordedWriter), and what core/outputs.cjs render() merges of both.
 */
export interface WriterRecord {
  pkgs: Package[];
  /** absolute paths of the files the writer emits into the output (a record: at most core/lockfile.cjs MAX_FILES) */
  files: string[];
  /** how many files the writer has, if `files` is only some of them (a record of another process) */
  count?: number;
  /** absolute path -> "sha256-<hex>" of its JavaScript and CSS output files */
  outputs: Record<string, string>;
  /** how many such output files the writer has, if `outputs` is only some of them */
  outputCount?: number;
  /** absolute path -> the paths of the packages (in pkgs) in that output file */
  contents: Record<string, string[]>;
  bundler?: BundlerId | null;
  via: Via | null;
}

/** One build of a writer, as core/outputs.cjs keeps it (building, landed). */
export interface Build extends WriterRecord {
  /** the directory package locations are relative to */
  context: string;
}

/** A writer as toPackageLock (core/lockfile.cjs) writes it: its packages by their paths, the packages themselves given apart. */
export interface MetaWriter extends Omit<WriterRecord, 'pkgs' | 'via' | 'outputs' | 'contents'> {
  id: string;
  paths: Iterable<string>;
  outputs?: Record<string, string>;
  contents?: Record<string, string[]>;
  via?: Via | null;
}

/** A writer of a lockfile in this process (core/outputs.cjs): one compiler or build, across its rebuilds. */
export interface Writer {
  /** the id recorded in the lockfile, the same in every process and on every machine */
  id: string;
  building: Build | null;
  landed: Build | null;
  /** its earlier landed builds that later ones replaced, while files of theirs are left in the output (core/outputs.cjs) */
  remnants: Build[];
  /** the compiler or build that records its builds (outputs.record's opts.run), the same across its watch rebuilds */
  run: object | undefined;
  /** the lockfile was written with it: the record of its id there is this process's */
  wrote: boolean;
  /** how many of its builds have landed in this process */
  landings: number;
}

/** A writer as a lockfile on disk records it (core/lockfile.cjs readMeta). */
export interface RecordedWriter extends WriterRecord {
  id: string;
  via: Via;
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
