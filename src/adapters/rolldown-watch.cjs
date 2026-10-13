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
// mode: its new ones replace them).
const WRAPPED = Symbol.for('bundle-lockfile.rolldown.addWatchFile'); // on the prototype whose addWatchFile is wrapped
const builds = new WeakMap(); // data -> { byModule: Map(module id -> Set(file)), none: Set(file) }

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function record(ctx, file) {
  const b = ctx && ctx.data && typeof ctx.data === 'object' ? builds.get(ctx.data) : undefined;
  if (!b || typeof file !== 'string') return; // a build without bundle-lockfile's plugin
  const id = typeof ctx.moduleId === 'string' ? ctx.moduleId : typeof ctx.currentLoadingModule === 'string' ? ctx.currentLoadingModule : null;
  if (id === null) { b.none.add(file); return; }
  if (!b.byModule.has(id)) b.byModule.set(id, new Set());
  b.byModule.get(id).add(file);
}

// Wraps the addWatchFile of the prototype ctx has it from. Returns null, or what is wrong with ctx's shape (a version
// of Rolldown whose records bundle-lockfile cannot read).
function wrap(ctx) {
  let proto = ctx && Object.getPrototypeOf(ctx);
  while (proto && !own(proto, 'addWatchFile')) proto = Object.getPrototypeOf(proto);
  if (!proto || typeof proto.addWatchFile !== 'function') return 'its plugin context has no addWatchFile';
  if (!ctx.data || typeof ctx.data !== 'object') return 'its plugin context has no build data';
  if (own(proto, WRAPPED)) return null;
  const addWatchFile = proto.addWatchFile;
  proto.addWatchFile = function (file) {
    const r = addWatchFile.apply(this, arguments);
    try { record(this, file); } catch { /* the record is best effort per call: the build goes on */ }
    return r;
  };
  Object.defineProperty(proto, WRAPPED, { value: true });
  return null;
}

// The build of ctx (buildStart's context): its records, kept as long as its data (one build, or one watcher's rebuilds).
function start(ctx) {
  const problem = wrap(ctx);
  if (problem) return problem;
  if (!builds.has(ctx.data)) builds.set(ctx.data, { byModule: new Map(), none: new Set() });
  return null;
}

// module id is loaded (again): its records start over
function loading(ctx, id) {
  const b = ctx && ctx.data && typeof ctx.data === 'object' ? builds.get(ctx.data) : undefined;
  if (b) b.byModule.delete(id);
}

// The files recorded for the build of ctx, for the modules ids (module ids of the build's chunks), and those recorded
// for no module. null: none are known (the build's start was not seen, or its context is of another shape).
function filesOf(ctx, ids) {
  const b = ctx && ctx.data && typeof ctx.data === 'object' ? builds.get(ctx.data) : undefined;
  if (!b) return null;
  const out = new Set(b.none);
  for (const id of ids) for (const f of b.byModule.get(id) || []) out.add(f);
  return [...out];
}

module.exports = { start, wrap, loading, filesOf, WRAPPED };
