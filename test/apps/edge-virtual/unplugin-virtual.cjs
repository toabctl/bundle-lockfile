// An unplugin plugin with a virtual module: unplugin writes it for webpack below <context>/_virtual_/, Vite gives it a
// \0 id (neither is a package's file)
const { createUnplugin } = require('unplugin');
module.exports = createUnplugin(() => ({
  name: 'edge-virtual',
  resolveId(id) { return id === 'virtual-unplugin' ? '\0virtual-unplugin' : null; },
  loadInclude(id) { return id.includes('virtual-unplugin'); },
  load(id) { return id.includes('virtual-unplugin') ? 'export default "from unplugin";' : null; },
}));
