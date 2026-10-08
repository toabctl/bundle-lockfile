// Loader-thread hooks (module.register), for Node versions where the in-thread module.registerHooks is not safe
// next to other loaders (see hooks.cjs). Same wrapping as there, via esm-wrap.cjs.
import { createRequire } from 'node:module';

const { match, source } = createRequire(import.meta.url)('./esm-wrap.cjs');
let entries = [];

export function initialize(data) { entries = (data && data.entries) || []; }

export async function load(url, context, nextLoad) {
  const entry = match(url, entries);
  if (!entry) return nextLoad(url, context);
  const result = await nextLoad(url, context);
  try {
    const src = source(url, String(result.source == null ? '' : Buffer.from(result.source)), entry);
    return src ? { format: 'module', source: src, shortCircuit: true } : result;
  } catch {
    return result; // never break the build
  }
}
