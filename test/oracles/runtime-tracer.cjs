'use strict';
// Preloaded (--require) into a server under test: records every file below a node_modules directory that the process
// loads - CommonJS and ES modules, through module.registerHooks (Node.js 22.15 and later) - and writes them, one per
// line, to $BLTEST_RUNTIME_TRACE when the process exits. The oracle of the runtime lockfile (test/oracles/runtime.cjs):
// what a running server actually loaded, independent of Next.js' traces and of bundle-lockfile.
const fs = require('fs');
const { fileURLToPath } = require('url');
const Module = require('module');
const out = process.env.BLTEST_RUNTIME_TRACE;
const seen = new Set();
const note = (f) => { if (typeof f === 'string' && f.includes(`${require('path').sep}node_modules${require('path').sep}`)) seen.add(f); };
if (out && typeof Module.registerHooks === 'function') {
  Module.registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith('file:')) { try { note(fileURLToPath(url)); } catch { /* not a path */ } }
      return nextLoad(url, context);
    },
  });
  const write = () => { try { fs.writeFileSync(out, [...seen].sort().join('\n') + '\n'); } catch { /* best effort */ } };
  process.on('exit', write);
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { write(); process.exit(0); });
}
