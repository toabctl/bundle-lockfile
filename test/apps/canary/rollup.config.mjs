import { nodeResolve } from '@rollup/plugin-node-resolve';
import include from './include-plugin.mjs';

export default { input: 'src/main.js', output: { dir: 'dist', format: 'es' }, plugins: [nodeResolve(), include()] };
