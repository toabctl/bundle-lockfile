// SVELTEKIT_ADAPTER=node: @sveltejs/adapter-node (bundles the server again with Rollup), else adapter-static;
// SVELTEKIT_OUT, SVELTEKIT_DIR: the output and SvelteKit's directory, elsewhere for the oracle (oracles/sveltekit.cjs)
import adapterStatic from '@sveltejs/adapter-static';
import adapterNode from '@sveltejs/adapter-node';

const out = process.env.SVELTEKIT_OUT || 'build';
export default {
  kit: {
    adapter: process.env.SVELTEKIT_ADAPTER === 'node' ? adapterNode({ out }) : adapterStatic({ pages: out, assets: out, fallback: 'index.html' }),
    outDir: process.env.SVELTEKIT_DIR || '.svelte-kit',
  },
};
