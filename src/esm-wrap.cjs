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
// wrapper that re-exports a default the module does not have fails to link, and the build with it. Strings, template
// literals (also the code in their ${} and the literals in it) and regular expression literals are kept as they are:
// a // or /* in them starts no comment, nor does a quote in a regular expression start a string. Whether a / starts a
// regular expression or divides is told by what comes before it, as scanners without a full parser do: after a name,
// a number, a literal, ) or ] (also x++ and x--) it divides; after any other punctuator, a keyword such as return or
// typeof, or at the start, it starts one.
// literals: also each literal (string, template, regular expression) replaced by a space, for exportedNames: a bundle
// that generates code may have "export default" in a string. The code in a ${} goes with its template literal.
// The text between comments is copied in runs (slice), not character by character: rspack 2's entry is one 700 KB
// bundle, which every process that imports it scans.
const REGEX_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const isWordChar = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95 || c > 127;
const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029;
// the end (index after it) of the regular expression literal at i, or -1 if there is none (a line ends first)
function regexEnd(src, i) {
  let j = i + 1, inClass = false;
  while (j < src.length) {
    const c = src.charCodeAt(j);
    if (c === 92) { j += 2; continue; } // \
    if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) return -1;
    if (inClass) { if (c === 93) inClass = false; } // ]
    else if (c === 91) inClass = true; // [
    else if (c === 47) { j++; while (j < src.length && isWordChar(src.charCodeAt(j))) j++; return j; } // / and its flags
    j++;
  }
  return -1;
}
function withoutComments(src, literals = false) {
  let out = '', i = 0, start = 0, from = 0; // from: where the template literal that ends at the top level began
  let last = -1, literal = false; // the last character of code (not space, not in a comment), and whether it ends a literal
  const braces = []; // for each template literal's ${} the code is in: the depth of the braces opened in it
  // src[a, b) replaced by a space - not in the code of a ${} with literals: the whole template literal goes
  const cut = (a, b) => { if (!(literals && braces.length)) { out += `${src.slice(start, a)} `; start = b; } };
  const regexHere = () => {
    if (last < 0) return true;
    if (literal) return false;
    const p = src.charCodeAt(last);
    if (p === 41 || p === 93) return false; // ) ]
    if (isWordChar(p)) {
      let s = last;
      while (s > 0 && isWordChar(src.charCodeAt(s - 1))) s--;
      return src.charCodeAt(s - 1) !== 46 && REGEX_AFTER.has(src.slice(s, last + 1)); // not a property (x.in)
    }
    return !((p === 43 || p === 45) && src.charCodeAt(last - 1) === p); // x++ / y, x-- / y
  };
  // the rest of a template literal from j (after its ` or the } of a ${}): its end, or the code of a ${} in it
  const template = (j) => {
    while (j < src.length) {
      const c = src.charCodeAt(j);
      if (c === 92) { j += 2; continue; }
      if (c === 96) { last = j; literal = true; return j + 1; } // `
      if (c === 36 && src.charCodeAt(j + 1) === 123) { braces.push(0); last = j + 1; literal = false; return j + 2; } // ${
      j++;
    }
    return j;
  };
  // a template literal, and the rest of one after the } of a ${} in it: ended at the top level if no ${} is open
  const after = (j) => { i = template(j); if (literals && !braces.length) cut(from, i); };
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === 47) { // /
      const n = src.charCodeAt(i + 1);
      if (n === 47) { // //
        const a = i;
        while (i < src.length && src[i] !== '\n') i++;
        cut(a, i); continue;
      }
      if (n === 42) { // /*
        const a = i, end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2;
        cut(a, i); continue;
      }
      const end = regexHere() ? regexEnd(src, i) : -1;
      if (end > 0) { if (literals) cut(i, end); last = end - 1; literal = true; i = end; continue; }
      last = i; literal = false; i++; continue;
    }
    if (c === 34 || c === 39) { // " '
      const q = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1;
      if (literals) cut(i, Math.min(j + 1, src.length));
      last = j; literal = true; i = j + 1; continue;
    }
    if (c === 96) { if (!braces.length) from = i; after(i + 1); continue; } // `
    if (braces.length && c === 123) braces[braces.length - 1]++; // { in a ${}
    if (braces.length && c === 125) { // } in a ${}: the end of it, or of a block in it
      if (braces[braces.length - 1] === 0) { braces.pop(); after(i + 1); continue; }
      braces[braces.length - 1]--;
    }
    if (!isSpace(c)) { last = i; literal = false; }
    i++;
  }
  return out + src.slice(start);
}

// Names a module exports, from `export { a, b as c }` (also `... from '...'`) and `export function|class|const x`.
function exportedNames(source) {
  const names = new Set();
  const src = withoutComments(source, true);
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
