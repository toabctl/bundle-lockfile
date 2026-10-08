// The island built by the rollup command line instead of Vite (fixture nested-island-rollup): one iife file main.js
import path from 'node:path';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
const root = path.dirname(new URL(import.meta.url).pathname);
export default {
  input: path.join(root, 'src/main.js'),
  output: { file: path.join(root, 'dist/main.js'), format: 'iife', name: 'Island', inlineDynamicImports: true },
  plugins: [nodeResolve({ browser: true }), commonjs()],
};
