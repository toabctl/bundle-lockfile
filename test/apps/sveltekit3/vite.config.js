// SvelteKit 3 takes its configuration here. SVELTEKIT_ADAPTER=node: @sveltejs/adapter-node, else adapter-static;
// SVELTEKIT_OUT, SVELTEKIT_DIR: the output and SvelteKit's directory, elsewhere for the oracle (oracles/sveltekit.cjs);
// ORACLE_SOURCEMAP=1: source maps for the oracle
import { sveltekit } from '@sveltejs/kit/vite';
import adapterStatic from '@sveltejs/adapter-static';
import adapterNode from '@sveltejs/adapter-node';

const out = process.env.SVELTEKIT_OUT || 'build';
export default {
  plugins: [sveltekit({
    adapter: process.env.SVELTEKIT_ADAPTER === 'node' ? adapterNode({ out }) : adapterStatic({ pages: out, assets: out, fallback: 'index.html' }),
    outDir: process.env.SVELTEKIT_DIR || '.svelte-kit',
  })],
  build: { sourcemap: !!process.env.ORACLE_SOURCEMAP },
};
