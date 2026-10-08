'use strict';
// Oracle for SvelteKit fixtures: builds again WITHOUT bundle-lockfile, with source maps (ORACLE_SOURCEMAP=1, see the
// apps' configs), into build-oracle/ and .svelte-kit-oracle/ (the build under test stays as it is), and derives the
// packages from the maps' sources. A source that is itself a built JavaScript file with a map (adapter-node 5 bundles
// SvelteKit's server output) is followed into that map. Shares no code with the adapter.
// usage (cwd = fixture): node oracles/sveltekit.cjs [<dir>,...] [--dir <output dir>]
//   <dir>: subdirectories of the output that another build wrote (adapter-node: client, and with SvelteKit 3 server,
//   a copy of SvelteKit's server output; adapter-node 5 bundles its own server into the rest)
//   --dir: the output is this directory, which the adapter writes wherever it does (adapter-netlify's edge functions),
//   instead of build/
// prints {"<output dir relative to build/>": [name@version, ...]}
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dirArg = process.argv.indexOf('--dir');
const ownDir = dirArg >= 0 ? path.resolve(process.argv.splice(dirArg, 2)[1]) : null;
const outputs = (process.argv[2] || '').split(',').filter(Boolean);
const out = path.resolve('build-oracle');
const kitDir = path.resolve('.svelte-kit-oracle');
for (const d of [out, kitDir]) fs.rmSync(d, { recursive: true, force: true });
const vite = path.resolve('node_modules/vite/bin/vite.js');
const r = spawnSync(process.execPath, [vite, 'build'], { encoding: 'utf8',
  env: { ...process.env, NODE_OPTIONS: '', ORACLE_SOURCEMAP: '1', SVELTEKIT_OUT: out, SVELTEKIT_DIR: kitDir } });
if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }

// The adapters copy SvelteKit's output (.svelte-kit/output/client, .../server), maps included, into build/ at another
// depth: a relative source is also tried from the map's original place there; the first that exists is the source.
const OUTPUT = path.join(kitDir, 'output');
const resolveSource = (map, root, s) => {
  const rel = path.relative(out, map).split(path.sep);
  const inner = (rel[0] === 'client' || rel[0] === 'server' ? rel.slice(1) : rel).join(path.sep);
  const dirs = [path.dirname(map)];
  if (!path.relative(out, map).startsWith('..')) dirs.push(path.dirname(path.join(OUTPUT, 'client', inner)), path.dirname(path.join(OUTPUT, 'server', inner)));
  // a copy of the server output in --dir (adapter-netlify's .netlify/server)
  else if (ownDir && !path.relative(ownDir, map).startsWith('..')) dirs.push(path.dirname(path.join(OUTPUT, 'server', path.relative(ownDir, map))));
  const candidates = dirs.map(d => path.resolve(d, root, s));
  return candidates.find(f => fs.existsSync(f)) || candidates[0];
};
// @sveltejs/adapter-node 5 copies its own files/ there and bundles the copy (no map leads back to the package), and so
// does @sveltejs/adapter-netlify 7 for its edge function (files/edge.js into netlify-tmp/): a source there with the
// bytes of the package's file is that file.
const COPIES = [[path.join(kitDir, 'adapter-node/entries'), path.resolve('node_modules/@sveltejs/adapter-node/files')],
  [path.join(kitDir, 'netlify-tmp'), path.resolve('node_modules/@sveltejs/adapter-netlify/files')]];
const uncopy = (f) => {
  for (const [dir, src] of COPIES) {
    const rel = path.relative(dir, f);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const orig = path.join(src, rel);
    try { if (fs.readFileSync(orig).equals(fs.readFileSync(f))) return orig; } catch { /* not a copy */ }
  }
  return f;
};

// the files a map's sources resolve to, following maps of built files (cycle-safe)
const sourcesOf = (map, seen = new Set()) => {
  if (seen.has(map)) return [];
  seen.add(map);
  let m;
  try { m = JSON.parse(fs.readFileSync(map, 'utf8')); } catch { return []; }
  const files = [];
  for (const s of m.sources || []) {
    const f = uncopy(resolveSource(map, m.sourceRoot || '', s.split('?')[0]));
    if (!f.split(path.sep).includes('node_modules') && fs.existsSync(`${f}.map`)) files.push(...sourcesOf(`${f}.map`, seen));
    else files.push(f);
  }
  return files;
};

const byOutput = {};
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.map')) {
      const top = path.relative(out, p).split(path.sep)[0];
      const key = !ownDir && outputs.includes(top) ? top : '';
      (byOutput[key] = byOutput[key] || new Set());
      for (const f of sourcesOf(p)) byOutput[key].add(f);
    }
  }
};
walk(ownDir || out);

// package = directory directly below the last node_modules segment, at its real location, which must be in a
// node_modules directory (written out here, not imported from the tool)
const result = {};
for (const [key, files] of Object.entries(byOutput)) {
  const pkgs = new Set();
  for (const f of files) {
    const parts = f.split(path.sep);
    const i = parts.lastIndexOf('node_modules');
    if (i < 0) continue;
    let root = parts.slice(0, i + 1 + (parts[i + 1] && parts[i + 1].startsWith('@') ? 2 : 1)).join(path.sep);
    try { root = fs.realpathSync(root); } catch { /* keep */ }
    // a package that really is elsewhere (a workspace package linked into node_modules) is first-party
    const parent = path.basename(path.dirname(root));
    if (parent !== 'node_modules' && !(parent.startsWith('@') && path.basename(path.dirname(path.dirname(root))) === 'node_modules')) continue;
    let p;
    try { p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { continue; }
    if (p && p.name && p.version) pkgs.add(`${p.name}@${p.version}`);
  }
  result[key] = [...pkgs].sort();
}
console.log(JSON.stringify(result));
