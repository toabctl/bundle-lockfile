'use strict';
// ESM entry modules that adapters wrap (see hooks.cjs): an adapter declares entries { id, suffixes, wrap } - the module
// whose file: URL ends with one of the suffixes is replaced by a generated module that re-exports everything of the
// real one, except the functions named in `wrap`, which go through globalThis[Symbol.for('bundle-lockfile.esm')].
// Used by the in-thread hooks (module.registerHooks) and the loader thread (esm-loader.mjs) alike.
const path = require('path');
const { fileURLToPath } = require('url');
const { logical } = require('./core/layout.cjs');

const MARK = 'bundle-lockfile-real'; // query on the URL of the real module, which is loaded as is

// The path of a file: URL as adapters recognize bundler files by ("/" separators; a package in Yarn's store as
// node_modules/<name>, see core/layout.cjs), or null
function pathOf(url) {
  try { return logical(fileURLToPath(url.split(/[?#]/)[0])).split(path.sep).join('/'); } catch { return null; }
}

function match(url, entries) {
  if (typeof url !== 'string' || !url.startsWith('file:') || url.includes(MARK)) return null;
  const p = pathOf(url);
  return (p && entries.find(e => e.suffixes.some(s => p.endsWith(s)))) || null;
}

// The source without its comments (each replaced by a space), so that an export in a comment does not count: a
// wrapper that re-exports a default the module does not have fails to link, and the build with it. Strings and
// template literals are skipped over; regular expression literals are not parsed (the entry modules adapters wrap
// re-export from other files, or are bundles without regular expressions that look like comments).
// The text between comments is copied in runs (slice), not character by character: rspack 2's entry is one 700 KB
// bundle, which every process that imports it scans.
function withoutComments(src) {
  let out = '', i = 0, start = 0;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === 47 && src.charCodeAt(i + 1) === 47) { // //
      out += `${src.slice(start, i)} `;
      while (i < src.length && src[i] !== '\n') i++;
      start = i; continue;
    }
    if (c === 47 && src.charCodeAt(i + 1) === 42) { // /*
      out += `${src.slice(start, i)} `;
      const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2;
      start = i; continue;
    }
    if (c === 34 || c === 39 || c === 96) { // " ' `
      const q = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1;
      i = j + 1; continue;
    }
    i++;
  }
  return out + src.slice(start);
}

// Names a module exports, from `export { a, b as c }` (also `... from '...'`) and `export function|class|const x`.
function exportedNames(source) {
  const names = new Set();
  const src = withoutComments(source);
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

// The wrapper's source. Every function in entry.wrap is exported as the wrapped one, whether the module exports it or
// not (the namespace has it also from an `export *`; one it does not have is undefined, and stays so); the wrapper tells
// the hooks whether the module had any of them - an entry with none is a version the adapter does not know, whose
// builds would write no lockfile (hooks.cjs found). Only the default export is read from the source. Without the
// hooks' API in its thread (bundle-lockfile not loaded there) the bundler is not hooked: in strict mode the wrapper
// throws when it is evaluated, which fails its import; otherwise it warns, and the module is as it is.
function source(url, realSrc, entry, strict = true) {
  const names = exportedNames(realSrc);
  const real = JSON.stringify(`${url}${url.includes('?') ? '&' : '?'}${MARK}`);
  const id = JSON.stringify(entry.id);
  const unhooked = `${url} is wrapped, but bundle-lockfile is not loaded in this thread: its builds would write no lockfile`;
  const noApi = strict
    ? `throw new Error(${JSON.stringify(`bundle-lockfile: ${unhooked} (BUNDLE_LOCKFILE_STRICT=0 makes this a warning)`)});`
    : `process.stderr.write(${JSON.stringify(`[bundle-lockfile] WARNING: ${unhooked}\n`)});`;
  return [
    `import * as real from ${real};`,
    `export * from ${real};`,
    names.has('default') ? `export { default } from ${real};` : '',
    `const api = globalThis[Symbol.for('bundle-lockfile.esm')];`,
    `if (!api) ${noApi}`,
    `if (api && api.found) api.found(${id}, ${JSON.stringify(url)}, ${JSON.stringify(entry.wrap)}, ${JSON.stringify(entry.wrap)}.some(n => typeof real[n] === 'function'));`,
    ...entry.wrap.map(n => `export const ${n} = api ? api.wrap(${id}, ${JSON.stringify(n)}, real.${n}) : real.${n};`),
  ].filter(Boolean).join('\n') + '\n';
}

// What a load hook returns for an entry module it cannot wrap, in strict mode: a module that throws when it is
// evaluated, which fails its import - the build - with the reason (in the bundler's thread also when the loader thread
// found it).
function unwrappable(url, e) {
  const msg = `bundle-lockfile: could not wrap ${url}: ${e && e.message} (BUNDLE_LOCKFILE_STRICT=0 makes this a warning)`;
  return { format: 'module', source: `throw new Error(${JSON.stringify(msg)});\n`, shortCircuit: true };
}

// CommonJS modules whose source a loader hook provides (Yarn Plug'n'Play's for files in its zip cache, on Node versions
// whose fstat fails on their file descriptors) do not go through Module._extensions' handlers: Node evaluates them with a require()
// of its own, also every module they require - the CommonJS hook (hooks.cjs) never sees them. For the files the adapters
// patch when they load (cjsFiles), a line appended to that source reports the module to the hook once it has run, as
// the CommonJS hook (hooks.cjs) would. Only when a hook provided the source. On Node.js 24.12+ the in-thread hook also gets the source of
// a CommonJS file an ES module imports (Rsbuild 1 importing rspack 1), which Node then also loads through Module._extensions:
// such a module is reported twice, and the adapters patch it once.
const CJS_LOADED = "\n;{ const f = globalThis[Symbol.for('bundle-lockfile.cjs-loaded')]; if (typeof f === 'function') f(module, __filename); }\n";
function cjsSource(url, result, files) {
  if (!result || result.format !== 'commonjs' || result.source == null || typeof url !== 'string' || !url.startsWith('file:')) return null;
  const p = pathOf(url);
  if (!p || !files.some(re => re.test(p))) return null;
  const src = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  return src.endsWith(CJS_LOADED) ? null : src + CJS_LOADED;
}

// What the load hooks (in-thread in hooks.cjs, in the loader thread in esm-loader.mjs) return for `url`, given the
// result of the next hook: the wrapper of an entry module, a cjsFiles module's source with the line appended, or the
// result as it is.
function transform(url, result, entries, cjsFiles, strict = true) {
  // only ES modules are wrapped: rspack 1's CommonJS dist/index.js has the path of rspack 2's entry, and must go on to
  // cjsSource (under Yarn Plug'n'Play Node.js evaluates it without the CommonJS hook)
  const entry = result && result.format === 'module' ? match(url, entries) : null;
  if (!entry) {
    const cjs = cjsSource(url, result, cjsFiles);
    return cjs ? { ...result, source: cjs } : result;
  }
  return { format: 'module', source: source(url, String(result.source == null ? '' : Buffer.from(result.source)), entry, strict), shortCircuit: true };
}

module.exports = { MARK, match, withoutComments, exportedNames, source, cjsSource, CJS_LOADED, transform, unwrappable };
