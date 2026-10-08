// The island built by Rolldown's JavaScript API instead of Vite (fixture nested-island-rolldown): one iife file main.js.
// ISLAND_OUT: another output directory, ISLAND_SOURCEMAP=1: with a source map (both for the oracle, oracles/nested.cjs)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.env.ISLAND_OUT || path.join(root, 'dist'));
await build({
  input: path.join(root, 'src/main.js'), platform: 'browser',
  output: { file: path.join(out, 'main.js'), format: 'iife', name: 'Island', sourcemap: !!process.env.ISLAND_SOURCEMAP },
});
