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
  const pkgs = new Set();
  for (const f of files) {
    if (!f.split(path.sep).includes('node_modules')) continue;
    for (let d = path.dirname(f); d !== path.dirname(d); d = path.dirname(d)) {
      let p;
      try { p = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')); } catch { continue; }
      if (p.name && p.version) { pkgs.add(`${p.name}@${p.version}`); break; }
    }
  }
  return [...pkgs].sort();
}

module.exports = { STATS_OPTIONS, packagesFromStats };
