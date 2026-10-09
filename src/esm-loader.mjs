// Loader-thread hooks (module.register), for Node versions where the in-thread module.registerHooks is not safe
// next to other loaders (see hooks.cjs). Same wrapping as there, via esm-wrap.cjs.
import { createRequire } from 'node:module';

const { match, source, cjsSource } = createRequire(import.meta.url)('./esm-wrap.cjs');
let entries = [];
let cjsFiles = [];

export function initialize(data) {
  entries = (data && data.entries) || [];
  cjsFiles = (data && data.cjsFiles) || [];
}

export async function load(url, context, nextLoad) {
  const entry = match(url, entries);
  const result = await nextLoad(url, context);
  try {
    if (!entry) {
      const cjs = cjsSource(url, result, cjsFiles); // CommonJS whose source another hook provided (see esm-wrap.cjs)
      return cjs ? { ...result, source: cjs } : result;
    }
    const src = source(url, String(result.source == null ? '' : Buffer.from(result.source)), entry);
    return src ? { format: 'module', source: src, shortCircuit: true } : result;
  } catch {
    return result; // never break the build
  }
}
