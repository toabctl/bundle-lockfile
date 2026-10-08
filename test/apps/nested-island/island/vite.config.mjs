// GitLab's island shape: library mode, one iife file main.js, dynamic imports inlined.
// NESTED_SPLIT=1: an ES module library from src/split.js instead: main.js, a lazily imported chunk lazy.js and a style
// sheet style.css (from a package), each file another build can bundle on its own
import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
const output = process.env.NESTED_SPLIT ? { chunkFileNames: '[name].js' } : { inlineDynamicImports: true };
export default {
  root,
  build: {
    target: 'es2017', // webpack 4's parser (acorn 6) cannot read newer syntax
    outDir: path.join(root, 'dist'),
    lib: process.env.NESTED_SPLIT
      ? { entry: path.join(root, 'src/split.js'), formats: ['es'], fileName: () => 'main.js', cssFileName: 'style' }
      : { entry: path.join(root, 'src/main.js'), formats: ['iife'], name: 'Island', fileName: () => 'main.js' },
    rolldownOptions: { output },
    rollupOptions: { output },
  },
};
