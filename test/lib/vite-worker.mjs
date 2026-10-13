// `vite build` in a worker_threads Worker (tools that build in a worker thread), run from the fixture (cwd = fixture):
// the worker runs bundle-lockfile's preload again and must install its own ESM hooks - the main thread's loader-thread
// hooks do not reach it. Exits with the worker's exit code, 1 if the build fails.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const vite = pathToFileURL(path.resolve('node_modules/vite/dist/node/index.js')).href;
const code = `import(${JSON.stringify(vite)}).then(({ build }) => build({ logLevel: 'warn' }))
  .catch((e) => { console.error(e && (e.stack || e.message)); process.exitCode = 1; });`;
const w = new Worker(code, { eval: true });
w.on('error', (e) => { console.error(e); process.exitCode = 1; });
w.on('exit', (c) => { if (c) process.exitCode = c; });
