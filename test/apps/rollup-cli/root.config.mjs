// output.file in the project's own directory: with BUNDLE_LOCKFILE_FILE=package-lock.json the lockfile would be the
// project's package-lock.json, which bundle-lockfile must never replace
import { nodeResolve } from '@rollup/plugin-node-resolve';

export default { input: 'src/main.js', output: { file: 'bundle.js', format: 'es' }, plugins: [nodeResolve({ browser: true })] };
