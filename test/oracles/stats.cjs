'use strict';
// Shared by the webpack-based oracles: derives name@version from a webpack stats JSON. Independent of the
// adapter, which reads the chunk graph and asset objects directly. What counts as emitted:
// - modules that sit in a chunk (including modules nested in concatenated modules). A module named by its
//   issuer's resource (CSS extracted from it) counts as the file the issuer is named by (its match resource)
// - modules in chunks of child compilations (stats "children") whose files are among the parent's assets, or
//   are among the child's own assets while its entry module (depth 0) is a shipped module of its parent
//   (inlined into it, e.g. worker-loader's inline: 'no-fallback')
// - assets whose info.sourceFilename (relative to the context) is a file in a package (copy-webpack-plugin)
// - copied: more files in the output, found by the caller (copy-webpack-plugin 5, whose assets name no file)
const fs = require('fs');
const path = require('path');

const STATS_OPTIONS = { modules: true, nestedModules: true, chunks: true, chunkModules: false, assets: true, children: true, depth: true, source: false };

function packagesFromStats(json, context, copied = []) {
  const files = new Set(copied);
  // file of a module: nameForCondition = resource path; identifiers can carry prefixes like "javascript/esm|/abs/path"
  const resourceOf = (m) => ((m.identifier || '').split('!').pop().split('|').find(s => path.isAbsolute(s)) || '').split('?')[0];
  const fileOf = (m, byId) => {
    const own = (m.nameForCondition || resourceOf(m)).split('?')[0];
    const issuer = m.issuer && byId.get(m.issuer);
    return issuer && issuer.nameForCondition && resourceOf(issuer) === own ? issuer.nameForCondition.split('?')[0] : own;
  };
  // files of these modules of one compilation's stats
  const filesOf = (stats, modules) => {
    const byId = new Map((stats.modules || []).map(m => [m.identifier, m]));
    const out = new Set();
    const add = (m) => {
      const id = fileOf(m, byId);
      if (path.isAbsolute(id)) out.add(id);
      (m.modules || []).forEach(add);
    };
    modules.forEach(add);
    return out;
  };
  const inChunks = (stats, ids) => (stats.modules || []).filter(m => (m.chunks || []).some(id => ids(id)));
  const top = filesOf(json, inChunks(json, () => true));
  top.forEach(f => files.add(f));

  const assetNames = new Set((json.assets || []).map(a => a.name));
  (function children(stats, parentShipped) {
    for (const child of stats.children || []) {
      const own = new Set((child.assets || []).map(a => a.name));
      const shipped = new Set((child.chunks || []).filter((c) => {
        const out = c.files || [];
        if (out.some(f => assetNames.has(f))) return true;
        if (!out.some(f => own.has(f))) return false;
        const entries = (child.modules || []).filter(m => m.depth === 0 && (m.chunks || []).includes(c.id));
        return [...filesOf(child, entries)].some(f => parentShipped.has(f));
      }).map(c => c.id));
      const childFiles = filesOf(child, inChunks(child, id => shipped.has(id)));
      childFiles.forEach(f => files.add(f));
      children(child, childFiles);
    }
  })(json, top);

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
    try { p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { continue; } // BOM: valid, JSON.parse rejects it
    if (p && typeof p.name === 'string' && p.name && typeof p.version === 'string' && p.version) pkgs.add(`${p.name}@${p.version}`);
  }
  return [...pkgs].sort();
}

module.exports = { STATS_OPTIONS, packagesFromStats };
