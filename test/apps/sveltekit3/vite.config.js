// SvelteKit 3 takes its configuration here. SVELTEKIT_ADAPTER=node: @sveltejs/adapter-node, netlify:
// @sveltejs/adapter-netlify (copies the server output; NETLIFY_EDGE=1: bundles it into an edge function with Rolldown),
// else adapter-static;
// SVELTEKIT_OUT, SVELTEKIT_DIR: the output and SvelteKit's directory, elsewhere for the oracle (oracles/sveltekit.cjs);
// ORACLE_SOURCEMAP=1: source maps for the oracle
import { sveltekit } from '@sveltejs/kit/vite';
import adapterStatic from '@sveltejs/adapter-static';
import adapterNode from '@sveltejs/adapter-node';
import adapterNetlify from '@sveltejs/adapter-netlify';

const out = process.env.SVELTEKIT_OUT || 'build';
const adapters = {
  node: () => adapterNode({ out }),
  netlify: () => adapterNetlify({ edge: !!process.env.NETLIFY_EDGE }),
  static: () => adapterStatic({ pages: out, assets: out, fallback: 'index.html' }),
};
export default {
  plugins: [sveltekit({
    adapter: adapters[process.env.SVELTEKIT_ADAPTER || 'static'](),
    outDir: process.env.SVELTEKIT_DIR || '.svelte-kit',
  })],
  build: { sourcemap: !!process.env.ORACLE_SOURCEMAP },
};
