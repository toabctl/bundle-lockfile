// A programmatic Vite build started from a package that does not use Vite (a tools/ package of the repository): on
// Node.js < 24.12 bundle-lockfile installs its loader-thread hooks only in processes of a package that does, unless
// BUNDLE_LOCKFILE_ESM_HOOKS=async
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { build } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
await build({ root, logLevel: 'warn' });
