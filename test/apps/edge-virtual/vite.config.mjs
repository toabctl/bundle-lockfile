// the unplugin plugin's virtual module in a Vite build (src/vite.js)
import { createRequire } from 'node:module';
const unplugin = createRequire(import.meta.url)('./unplugin-virtual.cjs');
export default { build: { rollupOptions: { input: 'src/vite.js' } }, plugins: [unplugin.vite()] };
