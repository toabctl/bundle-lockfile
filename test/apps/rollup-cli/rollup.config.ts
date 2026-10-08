// The same build as rollup.config.mjs, as a TypeScript config: `rollup -c rollup.config.ts --configPlugin typescript`
// bundles it first (a build that only generates) and then runs it
import type { RollupOptions } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';

const config: RollupOptions = { input: 'src/main.js', output: { dir: 'dist', format: 'es' }, plugins: [nodeResolve({ browser: true })] };
export default config;
