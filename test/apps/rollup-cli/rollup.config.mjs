// Built with the rollup command line, which loads Rollup's CommonJS build
import { nodeResolve } from '@rollup/plugin-node-resolve';

export default { input: 'src/main.js', output: { dir: 'dist', format: 'es' }, plugins: [nodeResolve({ browser: true })] };
