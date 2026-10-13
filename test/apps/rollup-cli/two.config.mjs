// Two configs of one input, each with its own output.file in dist/: a library's bundle with its dependencies, and its
// build with them external - separate builds (the rollup command line runs one per config), writers of their own
import { nodeResolve } from '@rollup/plugin-node-resolve';

export default [
  { input: 'src/main.js', output: { file: 'dist/lib.bundle.js', format: 'es' }, plugins: [nodeResolve({ browser: true })] },
  { input: 'src/main.js', external: [/^lodash-es/, /^nanoid/], output: { file: 'dist/lib.esm.js', format: 'es' } },
];
