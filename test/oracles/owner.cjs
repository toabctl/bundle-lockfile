'use strict';
// The packages of bundled source files, for the oracles: written out here, sharing no code with the tool, and found
// another way - the first-party directories are enumerated (workspace globs expanded with fs.globSync, the symbolic
// links in node_modules listed, Yarn PnP's locators read) instead of tested directory by directory.
//   - in node_modules: the directory below the last node_modules, at its real location; one without a package.json
//     with name and version is the package around it; inside it, a vendored copy (below) of another name, for its files
//   - elsewhere: the innermost directory up from the file with a vendored copy's package.json, unless a first-party
//     directory or a private package.json comes first
// A vendored copy's package.json: a name npm and Trivy accept, a version, not private, not a VS Code extension's
// (publisher with engines.vscode), and no package.json further out (up to where the search stops) has its name.
const fs = require('fs');
const path = require('path');

const json = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const listable = (j) => !!j && typeof j.name === 'string' && !!j.name && typeof j.version === 'string' && !!j.version;
const vendorable = (j) => listable(j) && j.name.length <= 214 && /^(@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/.test(j.name)
  && j.private !== true && !(j.publisher && j.engines && j.engines.vscode);
const up = (d) => { const all = []; for (let x = d; ; x = path.dirname(x)) { all.push(x); if (path.dirname(x) === x) return all; } };

// the first-party directories of a build whose context is `context` (real path)
function firstParty(context) {
  const dirs = new Set(up(context));
  const glob = (root, pattern) => {
    try { return fs.globSync(pattern.replace(/^\.\//, '').replace(/\/$/, ''), { cwd: root }).map(p => path.join(root, p)); } catch { return []; }
  };
  for (const root of up(context)) {
    const pj = json(path.join(root, 'package.json'));
    const patterns = [];
    const ws = pj && (Array.isArray(pj.workspaces) ? pj.workspaces : pj.workspaces && pj.workspaces.packages);
    if (Array.isArray(ws)) patterns.push(...ws);
    let yaml = '';
    try { yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'); } catch { /* none */ }
    let inPackages = false;
    for (const line of yaml.split('\n')) {
      if (/^packages:/.test(line)) { inPackages = true; continue; }
      if (inPackages && /^\S/.test(line)) inPackages = false;
      const item = inPackages && line.match(/^\s+-\s+['"]?([^'"#]+?)['"]?\s*(#.*)?$/);
      if (item) patterns.push(item[1]);
    }
    const lerna = json(path.join(root, 'lerna.json'));
    if (lerna) patterns.push(...(Array.isArray(lerna.packages) && lerna.packages.length ? lerna.packages : ['packages/*']));
    const excluded = new Set(patterns.filter(p => p.startsWith('!')).flatMap(p => glob(root, p.slice(1))));
    for (const p of patterns.filter(q => !q.startsWith('!'))) for (const d of glob(root, p)) if (!excluded.has(d)) dirs.add(realOr(d));
    let rush = null;
    try { rush = JSON.parse(fs.readFileSync(path.join(root, 'rush.json'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')); } catch { /* none */ }
    for (const p of (rush && rush.projects) || []) if (p && p.projectFolder) dirs.add(realOr(path.join(root, p.projectFolder)));
    if (fs.existsSync(path.join(root, 'nx.json'))) {
      for (const f of glob(root, '**/project.json')) if (!f.split(path.sep).includes('node_modules')) dirs.add(realOr(path.dirname(f)));
    }
    // what is linked into this directory's node_modules
    const nm = path.join(root, 'node_modules');
    let names = [];
    try { names = fs.readdirSync(nm); } catch { /* none */ }
    for (const n of names) {
      const entries = n.startsWith('@') ? (() => { try { return fs.readdirSync(path.join(nm, n)).map(s => `${n}/${s}`); } catch { return []; } })() : [n];
      for (const e of entries) {
        try { if (fs.lstatSync(path.join(nm, e)).isSymbolicLink()) dirs.add(fs.realpathSync(path.join(nm, e))); } catch { /* broken */ }
      }
    }
  }
  // Yarn PnP: workspaces, portals and links of the project
  try {
    const pnp = require('module').findPnpApi(path.join(context, 'x'));
    for (const loc of pnp ? pnp.getAllLocators() : []) {
      if (/^(workspace|portal|link):/.test(loc.reference)) dirs.add(realOr(pnp.getPackageInformation(loc).packageLocation.replace(/\/$/, '')));
    }
  } catch { /* no PnP */ }
  for (const p of (process.env.BUNDLE_LOCKFILE_FIRST_PARTY || '').split(',').map(s => s.trim()).filter(Boolean)) {
    for (const d of p === '**' ? [] : glob(process.cwd(), p)) dirs.add(realOr(d));
  }
  return { dirs, all: (process.env.BUNDLE_LOCKFILE_FIRST_PARTY || '').split(',').map(s => s.trim()).includes('**') };
}

// name@version of each package the files (absolute paths) belong to, sorted; build: { context }
function packagesOf(files, { context = process.cwd() } = {}) {
  const fp = firstParty(realOr(context));
  const pkgs = new Set();
  for (const f of files) {
    const file = realOr(f.split('?')[0]);
    const parts = file.split(path.sep);
    const i = parts.lastIndexOf('node_modules');
    if (i >= 0 && i + 2 < parts.length) {
      let rootParts = parts.slice(0, i + 1 + (parts[i + 1].startsWith('@') ? 2 : 1));
      let root = rootParts.join(path.sep);
      let j = json(path.join(root, 'package.json'));
      // without one: the package around it
      for (let k = rootParts.slice(0, -1).lastIndexOf('node_modules'); !listable(j) && k >= 0; ) {
        const outer = parts.slice(0, k).lastIndexOf('node_modules');
        if (outer < 0) break;
        rootParts = parts.slice(0, outer + 1 + (parts[outer + 1].startsWith('@') ? 2 : 1));
        root = rootParts.join(path.sep);
        j = json(path.join(root, 'package.json'));
        k = outer;
      }
      if (!listable(j)) continue;
      // the package.json files between the file and the package root, inner first, then the root's
      const around = [];
      for (let k = parts.length - 1; k > rootParts.length; k--) {
        const n = json(path.join(parts.slice(0, k).join(path.sep), 'package.json'));
        if (n) around.push({ n, ok: vendorable(n) });
      }
      around.push({ n: j, ok: false });
      const pick = around.findIndex((a, i) => a.ok && around.slice(i + 1).every(o => o.n.name !== a.n.name));
      pkgs.add(pick >= 0 ? `${around[pick].n.name}@${around[pick].n.version}` : `${j.name}@${j.version}`);
      continue;
    }
    if (fp.all) continue;
    // the package.json files from the file up to a first-party directory or a private one, that one included
    const around = [];
    for (const d of up(path.dirname(file))) {
      const n = json(path.join(d, 'package.json'));
      const stop = fp.dirs.has(d) || (!!n && n.private === true);
      if (n) around.push({ n, ok: !stop && vendorable(n) });
      if (stop) break;
    }
    const pick = around.findIndex((a, i) => a.ok && around.slice(i + 1).every(o => o.n.name !== a.n.name));
    if (pick >= 0) pkgs.add(`${around[pick].n.name}@${around[pick].n.version}`);
  }
  return [...pkgs].sort();
}

module.exports = { packagesOf };
