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

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  try {
    return transform(url, result, entries, cjsFiles);
  } catch {
    return result; // never break the build
  }
}
