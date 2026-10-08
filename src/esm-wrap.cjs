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

module.exports = { MARK, match, exportedNames, source };
