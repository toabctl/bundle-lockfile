'use strict';
// Shared by the webpack-based oracles: derives name@version from a webpack stats JSON. Independent of the
// adapter, which reads the chunk graph and asset objects directly. What counts as emitted:
// - modules that sit in a chunk (including modules nested in concatenated modules)
// - modules in chunks of child compilations (stats "children") whose files are among the parent's assets
// - assets whose info.sourceFilename (relative to the context) is a file in a package (copy-webpack-plugin)
const fs = require('fs');
const path = require('path');

const STATS_OPTIONS = { modules: true, nestedModules: true, chunks: true, chunkModules: false, assets: true, children: true, source: false };

function packagesFromStats(json, context) {
  const files = new Set();
  const add = (m) => {
    // nameForCondition = resource path; identifiers can carry prefixes like "javascript/esm|/abs/path"
    const id = (m.nameForCondition || (m.identifier || '').split('!').pop().split('|').find(s => path.isAbsolute(s)) || '').split('?')[0];
    if (path.isAbsolute(id)) files.add(id);
    (m.modules || []).forEach(add);
  };
  (json.modules || []).filter(m => (m.chunks || []).length > 0).forEach(add);

  const assetNames = new Set((json.assets || []).map(a => a.name));
  (function children(stats) {
    for (const child of stats.children || []) {
      const shipped = new Set((child.chunks || []).filter(c => (c.files || []).some(f => assetNames.has(f))).map(c => c.id));
      (child.modules || []).filter(m => (m.chunks || []).some(id => shipped.has(id))).forEach(add);
      children(child);
    }
  })(json);

  for (const a of json.assets || []) {
    if (a.info && typeof a.info.sourceFilename === 'string') files.add(path.resolve(context, a.info.sourceFilename.split('?')[0]));
  }

  // package = directory directly below the last node_modules segment (npm's layout rule), at its real
  // location; one that resolves out of node_modules (a symlinked workspace package) is first-party.
  // Written out here rather than imported, so the oracle shares no code with the tool.
  const pkgs = new Set();
  for (const f of files) {
    const parts = f.split(path.sep);
    const i = parts.lastIndexOf('node_modules');
    if (i < 0) continue;
    let root = parts.slice(0, i + 1 + (parts[i + 1] && parts[i + 1].startsWith('@') ? 2 : 1)).join(path.sep);
    try { root = fs.realpathSync(root); } catch { /* e.g. a PnP zip path */ }
    const parent = path.basename(path.dirname(root));
    const inNodeModules = parent === 'node_modules' || (parent.startsWith('@') && path.basename(path.dirname(path.dirname(root))) === 'node_modules');
    if (!inNodeModules) continue;
    let p;
    try { p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { continue; }
    if (p.name && p.version) pkgs.add(`${p.name}@${p.version}`);
  }
  return [...pkgs].sort();
}

module.exports = { STATS_OPTIONS, packagesFromStats };
