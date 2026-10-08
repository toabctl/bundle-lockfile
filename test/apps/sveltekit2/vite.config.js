// ORACLE_SOURCEMAP=1: source maps for the oracle (test/oracles/sveltekit.cjs)
import { sveltekit } from '@sveltejs/kit/vite';

export default { plugins: [sveltekit()], build: { sourcemap: !!process.env.ORACLE_SOURCEMAP } };
