'use strict';
// The files Rolldown's plugins inlined into a module (packages.inlinedFile), per build and per module. Plugins record
// them with this.addWatchFile (Vite's CSS plugin: the style sheets a style sheet @imports, the images it inlines as
// data: URLs), but Rolldown gives them back only on the build object rolldown() returns (RolldownBuild.watchFiles):
// its build() and watch() - also `vite build --watch` on Vite 8 - have none, nor has its plugin context
// (getWatchFiles, rolldown#819). So the plugin contexts' addWatchFile is wrapped: Rolldown's PluginContextImpl and its
// subclasses for the load and transform hooks (TransformPluginContextImpl, LoadPluginContextImpl from 1.0) are
// JavaScript classes, one set per copy of Rolldown, each with an addWatchFile of its own. bundle-lockfile's plugin
// meets an instance of each in its own hooks (buildStart, load, transform) and wraps the method of the prototype that
// has it, once. Every call is recorded for the build whose `data` the context has (one PluginContextData per build,
// shared by the contexts of all plugins of the build), with the module it was made for: the transform context's
// moduleId, the load context's currentLoadingModule (none in 1.0 betas: the load hook's context is a PluginContextImpl),
// or none (a call from another hook: the whole build's). A module's records are dropped when it is loaded again (watch
// mode: its new ones replace them). The contexts are Rolldown's internals: unknown, each field checked.
const { isObject } = require('../core/values.cjs');
const { getOr } = require('../core/maps.cjs');

const WRAPPED = Symbol.for('bundle-lockfile.rolldown.addWatchFile'); // on the prototype whose addWatchFile is wrapped
/** @typedef {{ byModule: Map<string, Set<string>>, none: Set<string> }} Records */
/** @type {WeakMap<object, Records>} */
const builds = new WeakMap(); // data -> { byModule: Map(module id -> Set(file)), none: Set(file) }

// the build data of a plugin context, if it has one
/** @type {(ctx: unknown) => Record<PropertyKey, unknown> | null} */
const dataOf = (ctx) => (isObject(ctx) && isObject(ctx.data) ? ctx.data : null);
/** @type {(ctx: unknown) => Records | undefined} */
const recordsOf = (ctx) => { const data = dataOf(ctx); return data ? builds.get(data) : undefined; };

/** @param {unknown} ctx @param {unknown} file */
function record(ctx, file) {
  const b = recordsOf(ctx);
  if (!b || typeof file !== 'string' || !isObject(ctx)) return; // a build without bundle-lockfile's plugin
  const id = typeof ctx.moduleId === 'string' ? ctx.moduleId : typeof ctx.currentLoadingModule === 'string' ? ctx.currentLoadingModule : null;
  if (id === null) { b.none.add(file); return; }
  getOr(b.byModule, id, () => new Set()).add(file);
}

// Wraps the addWatchFile of the prototype ctx has it from. Returns null, or what is wrong with ctx's shape (a version
// of Rolldown whose records bundle-lockfile cannot read).
/** @param {unknown} ctx @returns {string | null} */
function wrap(ctx) {
  /** @type {(o: object) => Record<PropertyKey, unknown> | null} */
  const protoOf = (o) => /** @type {Record<PropertyKey, unknown> | null} */ (Object.getPrototypeOf(o));
  let proto = isObject(ctx) ? protoOf(ctx) : null;
  while (proto && !Object.hasOwn(proto, 'addWatchFile')) proto = protoOf(proto);
  if (!proto || typeof proto.addWatchFile !== 'function') return 'its plugin context has no addWatchFile';
  if (!dataOf(ctx)) return 'its plugin context has no build data';
  if (Object.hasOwn(proto, WRAPPED)) return null;
  const addWatchFile = /** @type {(this: unknown, ...args: unknown[]) => unknown} */ (proto.addWatchFile);
  /** @type {(this: unknown, ...args: unknown[]) => unknown} */
  proto.addWatchFile = function (...args) {
    const r = addWatchFile.apply(this, args);
    try { record(this, args[0]); } catch { /* the record is best effort per call: the build goes on */ }
    return r;
  };
  Object.defineProperty(proto, WRAPPED, { value: true });
  return null;
}

// The build of ctx (buildStart's context): its records, kept as long as its data (one build, or one watcher's rebuilds).
/** @param {unknown} ctx @returns {string | null} */
function start(ctx) {
  const problem = wrap(ctx);
  if (problem) return problem;
  const data = dataOf(ctx);
  if (data && !builds.has(data)) builds.set(data, { byModule: new Map(), none: new Set() });
  return null;
}

// module id is loaded (again): its records start over
/** @param {unknown} ctx @param {string} id */
function loading(ctx, id) {
  const b = recordsOf(ctx);
  if (b) b.byModule.delete(id);
}

// The files recorded for the build of ctx, for the modules ids (module ids of the build's chunks), and those recorded
// for no module. null: none are known (the build's start was not seen, or its context is of another shape).
/** @param {unknown} ctx @param {Iterable<string>} ids @returns {string[] | null} */
function filesOf(ctx, ids) {
  const b = recordsOf(ctx);
  if (!b) return null;
  const out = new Set(b.none);
  for (const id of ids) for (const f of b.byModule.get(id) || []) out.add(f);
  return [...out];
}

module.exports = { start, wrap, loading, filesOf, WRAPPED };
