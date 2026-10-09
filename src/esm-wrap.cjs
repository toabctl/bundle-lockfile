'use strict';
// ESM entry modules that adapters wrap (see hooks.cjs): an adapter declares entries { id, suffixes, wrap } - the module
// whose file: URL ends with one of the suffixes is replaced by a generated module that re-exports everything of the
// real one, except the functions named in `wrap`, which go through globalThis[Symbol.for('bundle-lockfile.esm')].
// Used by the in-thread hooks (module.registerHooks) and the loader thread (esm-loader.mjs) alike.
const MARK = 'bundle-lockfile-real'; // query on the URL of the real module, which is loaded as is

function match(url, entries) {
  if (typeof url !== 'string' || !url.startsWith('file:') || url.includes(MARK)) return null;
  const p = url.split(/[?#]/)[0];
  return entries.find(e => e.suffixes.some(s => p.endsWith(s))) || null;
}

// Names a module exports, from `export { a, b as c }` (also `... from '...'`) and `export function|class|const x`.
function exportedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[\w$]+$/.test(n)) names.add(n);
    }
  }
  for (const m of src.matchAll(/\bexport\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+)/g)) names.add(m[1]);
  if (/\bexport\s+default\b/.test(src)) names.add('default');
  return names;
}

// The wrapper's source, or null if the module does not export any of the functions to wrap (an unknown version:
// leave it alone).
function source(url, realSrc, entry) {
  const names = exportedNames(realSrc);
  const wrap = entry.wrap.filter(n => names.has(n));
  if (!wrap.length) return null;
  const real = JSON.stringify(`${url}${url.includes('?') ? '&' : '?'}${MARK}`);
  return [
    `import * as real from ${real};`,
    `export * from ${real};`,
    names.has('default') ? `export { default } from ${real};` : '',
    `const api = globalThis[Symbol.for('bundle-lockfile.esm')];`,
    ...wrap.map(n => `export const ${n} = api ? api.wrap(${JSON.stringify(entry.id)}, ${JSON.stringify(n)}, real.${n}) : real.${n};`),
  ].filter(Boolean).join('\n') + '\n';
}

// CommonJS modules whose source a loader hook provides (Yarn Plug'n'Play's for files in its zip cache, on Node versions
// whose fstat fails on their file descriptors) are not loaded through Module._load: Node evaluates them with a require()
// of its own, also every module they require - the CommonJS hook (hooks.cjs) never sees them. For the files the adapters
// patch when they load (cjsFiles), a line appended to that source reports the module to the hook once it has run, as
// Module._load would. Only when a hook provided the source: else Node loads it through Module._load.
const CJS_LOADED = "\n;{ const f = globalThis[Symbol.for('bundle-lockfile.cjs-loaded')]; if (typeof f === 'function') f(module, __filename); }\n";
function cjsSource(url, result, files) {
  if (!result || result.format !== 'commonjs' || result.source == null || typeof url !== 'string' || !url.startsWith('file:')) return null;
  const p = decodeURIComponent(url.split(/[?#]/)[0]);
  if (!files.some(re => re.test(p))) return null;
  const src = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  return src.endsWith(CJS_LOADED) ? null : src + CJS_LOADED;
}

// What the load hooks (in-thread in hooks.cjs, in the loader thread in esm-loader.mjs) return for `url`, given the
// result of the next hook: the wrapper of an entry module, a cjsFiles module's source with the line appended, or the
// result as it is.
function transform(url, result, entries, cjsFiles) {
  const entry = match(url, entries);
  if (!entry) {
    const cjs = cjsSource(url, result, cjsFiles);
    return cjs ? { ...result, source: cjs } : result;
  }
  const src = source(url, String(result.source == null ? '' : Buffer.from(result.source)), entry);
  return src ? { format: 'module', source: src, shortCircuit: true } : result;
}

module.exports = { MARK, match, exportedNames, source, cjsSource, CJS_LOADED, transform };
