// prerendered with adapter-static; with adapter-node and adapter-netlify the server renders the page
export const prerender = !['node', 'netlify'].includes(process.env.SVELTEKIT_ADAPTER);
