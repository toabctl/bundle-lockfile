// Loader-thread hooks (module.register), for Node versions where the in-thread module.registerHooks is not safe
// next to other loaders (see hooks.cjs). Same wrapping as there, via esm-wrap.cjs.
import { createRequire } from 'node:module';

const { transform } = createRequire(import.meta.url)('./esm-wrap.cjs');
let entries = [];
let cjsFiles = [];

export function initialize(data) {
  entries = (data && data.entries) || [];
  cjsFiles = (data && data.cjsFiles) || [];
}

// An entry module that cannot be wrapped would build without bundle-lockfile's plugin, and this thread cannot fail the
// build: in strict mode the module throws when it is evaluated, in the bundler's thread, which fails its import with the
// reason (BUNDLE_LOCKFILE_STRICT=0: the module as it is).
const strict = (v) => v === undefined || v.trim() === '' || !/^(0|false|off)$/i.test(v.trim());
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  try {
    return transform(url, result, entries, cjsFiles);
  } catch (e) {
    if (!strict(process.env.BUNDLE_LOCKFILE_STRICT)) return result;
    const msg = `bundle-lockfile: could not wrap ${url}: ${e && e.message} (BUNDLE_LOCKFILE_STRICT=0 makes this a warning)`;
    return { format: 'module', source: `throw new Error(${JSON.stringify(msg)});\n`, shortCircuit: true };
  }
}
