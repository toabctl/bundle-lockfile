// Loader-thread hooks (module.register), for Node versions where the in-thread module.registerHooks is not safe
// next to other loaders (see hooks.cjs). Same wrapping as there, via esm-wrap.cjs.
import { createRequire } from 'node:module';

const { transform, unwrappable } = createRequire(import.meta.url)('./esm-wrap.cjs');
let entries = [];
let cjsFiles = [];
let strict = true;

// data: what hooks.cjs passes - the entries, the CommonJS files, and whether strict mode is on (as core/config.cjs read it)
export function initialize(data) {
  entries = (data && data.entries) || [];
  cjsFiles = (data && data.cjsFiles) || [];
  strict = !(data && data.strict === false);
}

// An entry module that cannot be wrapped would build without bundle-lockfile's plugin, and this thread cannot fail the
// build: in strict mode the module throws when it is evaluated, in the bundler's thread, which fails its import with the
// reason (BUNDLE_LOCKFILE_STRICT=0: the module as it is).
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  try {
    return transform(url, result, entries, cjsFiles);
  } catch (e) {
    return strict ? unwrappable(url, e) : result;
  }
}
