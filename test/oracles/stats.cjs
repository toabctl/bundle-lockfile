'use strict';
// Shared by the webpack-based oracles: derives name@version from a webpack stats JSON, using only
// modules that sit in a chunk (including modules nested in concatenated modules). Independent of the
// adapter, which reads the chunk graph directly.
const fs = require('fs');
const path = require('path');

const STATS_OPTIONS = { modules: true, nestedModules: true, chunks: false, assets: false, source: false };

function packagesFromStats(json) {
  const files = new Set();
  const add = (m) => {
    // nameForCondition = resource path; identifiers can carry prefixes like "javascript/esm|/abs/path"
    const id = (m.nameForCondition || (m.identifier || '').split('!').pop().split('|').find(s => path.isAbsolute(s)) || '').split('?')[0];
    if (path.isAbsolute(id)) files.add(id);
    (m.modules || []).forEach(add);
  };
  (json.modules || []).filter(m => (m.chunks || []).length > 0).forEach(add);
  // package = directory directly below the last node_modules segment (npm's layout rule); written
  // out here rather than imported, so the oracle shares no code with the tool
  const pkgs = new Set();
  for (const f of files) {
    const parts = f.split(path.sep);
    const i = parts.lastIndexOf('node_modules');
    if (i < 0) continue;
    const root = parts.slice(0, i + 1 + (parts[i + 1] && parts[i + 1].startsWith('@') ? 2 : 1)).join(path.sep);
    let p;
    try { p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { continue; }
    if (p.name && p.version) pkgs.add(`${p.name}@${p.version}`);
  }
  return [...pkgs].sort();
}

module.exports = { STATS_OPTIONS, packagesFromStats };
