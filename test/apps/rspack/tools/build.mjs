// A programmatic rspack 2 build started from a package that does not use rspack (a tools/ package of the repository):
// it imports rspack as an ES module only (rspack.config.js does not load it). On Node.js < 24.12 bundle-lockfile
// installs its loader-thread hooks only in processes of a package that does, unless BUNDLE_LOCKFILE_ESM_HOOKS=async
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import config from '../rspack.config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root); // the config's paths are relative to the project, also when this starts elsewhere
const { rspack } = await import(pathToFileURL(path.join(root, 'node_modules/@rspack/core/dist/index.js')).href);
const compiler = rspack(config);
compiler.run((err, stats) => {
  if (err || stats.hasErrors()) { console.error(err || stats.toString('errors-only')); process.exitCode = 1; }
  compiler.close(() => {});
});
