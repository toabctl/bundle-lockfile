// The same build as build.mjs's rollup modes, for the oracle (rollup -c with source maps)
import { nodeResolve } from '@rollup/plugin-node-resolve';

export default { input: 'src/main.js', output: { dir: 'dist', format: 'es' }, plugins: [nodeResolve({ browser: true })] };
