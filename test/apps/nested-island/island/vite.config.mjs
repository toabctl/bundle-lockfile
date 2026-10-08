// GitLab's island shape: library mode, one iife file main.js, dynamic imports inlined
import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
export default {
  root,
  build: {
    target: 'es2017', // webpack 4's parser (acorn 6) cannot read newer syntax
    outDir: path.join(root, 'dist'),
    lib: { entry: path.join(root, 'src/main.js'), formats: ['iife'], name: 'Island', fileName: () => 'main.js' },
    rolldownOptions: { output: { inlineDynamicImports: true } },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
};
