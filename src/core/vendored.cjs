'use strict';
// Vendored packages: third-party code bundled from somewhere other than the package root below the last node_modules
// - a copy outside node_modules (GitLab's vendor/assets/javascripts/vue-virtual-scroller, imported by an alias), or a
// copy inside another package (next/dist/compiled/@edge-runtime/cookies) - and package roots without a usable
// package.json (VS Code's stripped node_modules inside @gitlab/web-ide, a library build's dist/esm/node_modules/rxjs).
//
// A vendored copy is told by its package.json, as syft, Trivy and the bundlers themselves tell packages: one with a
// name npm accepts and a version, not private (npm never publishes a private package, so none is a copy of one, and
// subpath helpers such as preact/hooks/package.json mark themselves private), and no VS Code extension manifest
// (publisher and engines.vscode, which VS Code requires of every extension: those of @gitlab/web-ide's built-in
// extensions are named yaml, diff, go... @1.0.0, which are other packages on npm).
//
// Outside node_modules, a file belongs to the innermost such directory around it, unless a first-party boundary comes
// first: the build's context and the directories above it, the package of an entry module, the members of the
// monorepo (package manager workspaces, pnpm-workspace.yaml, lerna.json, rush.json, Nx's project.json), a directory
// linked into node_modules (file:, link:, portal:, workspaces; Yarn Plug'n'Play's own locators), one that
// BUNDLE_LOCKFILE_FIRST_PARTY names, or a private package.json. Inside node_modules, the package root still counts;
// a vendored copy nested in it counts for its files, unless it has the package's own name (socket.io-client's
// build/esm/package.json is socket.io-client).
const fs = require('fs');
const path = require('path');
const config = require('./config.cjs');
const { ancestors, posix, packageRoot } = require('./paths.cjs');
const { readManifest, packageOf } = require('./manifest.cjs');

const NAME = /^(@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/; // as Trivy reads names, plus npm's ~
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

// package.json content that says it is an npm package another one could be a copy of
function isVendorable(j) {
  return !!j && typeof j.name === 'string' && j.name.length <= 214 && NAME.test(j.name) && typeof j.version === 'string' && !!j.version
    && !j.private && !(j.publisher && j.engines && j.engines.vscode);
}
// A workspace pattern as a test of a directory relative to its root ("/" separators): *, **, ?, {a,b}; "./" and a
// trailing "/" are dropped. Patterns name directories (npm, yarn, pnpm, bun, lerna).
function globTest(pattern) {
  const expand = (p) => {
    const m = p.match(/\{([^{}]*)\}/);
    return m ? m[1].split(',').flatMap(alt => expand(p.slice(0, m.index) + alt + p.slice(m.index + m[0].length))) : [p];
  };
  const res = expand(pattern.replace(/^\.\//, '').replace(/\/+$/, '').replace(/\/package\.json$/, '')).map(p => new RegExp(`^${p.split('/').map(seg =>
    (seg === '**' ? '\0' : seg.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))).join('/')
    .replace(/\0\//g, '(?:.*/)?').replace(/\/\0$/, '(?:/.*)?').replace(/^\0$/, '.*')}$`));
  return (rel) => res.some(re => re.test(rel));
}

// pnpm-workspace.yaml "packages": a block list or a flow list, quoted or not, with comments
function pnpmPackages(text) {
  const out = [];
  const flow = text.match(/^packages:\s*\[([^\]]*)\]/m);
  if (flow) return flow[1].split(',').map(s => s.replace(/#.*/, '').trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const block = text.match(/^packages:[ \t]*(?:#.*)?\n((?:[ \t]*(?:-.*|#.*)?\n?)*)/m);
  if (block) for (const line of block[1].split('\n')) {
    const m = line.match(/^\s*-\s*(.*?)\s*(?:#.*)?$/);
    if (m && m[1]) out.push(m[1].replace(/^['"]|['"]$/g, ''));
  }
  return out;
}

// JSON with // and /* */ comments (rush.json), strings left alone
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { const end = text.slice(i).match(/^"(?:[^"\\]|\\.)*"/); if (end) { out += end[0]; i += end[0].length - 1; continue; } }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 1; continue; }
    out += c;
  }
  try { return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')); } catch { return null; }
}

// The monorepo definitions in directory d: tests of member directories relative to d
function membersOf(d) {
  const tests = [], excludes = [];
  const add = (patterns) => { for (const p of patterns || []) if (typeof p === 'string') (p.startsWith('!') ? excludes : tests).push(globTest(p.replace(/^!/, ''))); };
  const pj = readManifest(d);
  const ws = pj && pj.workspaces;
  add(Array.isArray(ws) ? ws : ws && ws.packages);
  try { add(pnpmPackages(fs.readFileSync(path.join(d, 'pnpm-workspace.yaml'), 'utf8'))); } catch { /* none */ }
  const lerna = readJson(path.join(d, 'lerna.json'));
  if (lerna) add(Array.isArray(lerna.packages) && lerna.packages.length ? lerna.packages : ['packages/*']); // Nx's reading of a lerna.json without them
  let rush = null;
  try { rush = parseJsonc(fs.readFileSync(path.join(d, 'rush.json'), 'utf8')); } catch { /* none */ }
  const folders = new Set(rush && Array.isArray(rush.projects) ? rush.projects.map(p => p && typeof p.projectFolder === 'string' && posix(path.normalize(p.projectFolder))).filter(Boolean) : []);
  const nx = fs.existsSync(path.join(d, 'nx.json'));
  if (!tests.length && !folders.size && !nx) return null;
  return (dir) => {
    const rel = posix(path.relative(d, dir));
    if (!rel || rel.startsWith('..')) return false;
    if (folders.has(rel)) return true;
    if (nx && fs.existsSync(path.join(dir, 'project.json'))) return true; // every project.json is an Nx project
    return tests.some(t => t(rel)) && !excludes.some(t => t(rel));
  };
}

// Yarn Plug'n'Play: the directory is a workspace, portal or link of the project (its locator says so)
function pnpFirstParty(dir) {
  let api;
  try { const m = require('module'); api = typeof m.findPnpApi === 'function' && m.findPnpApi(path.join(dir, 'x')); } catch { return false; }
  if (!api) return false;
  try {
    const loc = api.findPackageLocator(dir + path.sep);
    return !!loc && /^(workspace|portal|link):/.test(loc.reference) && real(api.getPackageInformation(loc).packageLocation) === real(dir + path.sep);
  } catch { return false; }
}

// The vendored copy among the package.json files around a file, innermost first (chain: [{ dir, j }], ending with the
// one where the walk stopped: a first-party package, a private one, the package root): the innermost vendorable one
// whose name none further out has - build/esm/package.json with its package's name is that package - or null.
function innermost(chain) {
  for (let i = 0; i < chain.length; i++) {
    const { dir, j } = chain[i];
    if (isVendorable(j) && !chain.slice(i + 1).some(o => o.j && o.j.name === j.name)) return packageOf(j, dir);
  }
  return null;
}

const noted = new Set();
function note(p) {
  if (noted.has(p.path)) return;
  noted.add(p.path);
  config.note(`${p.path} is a vendored copy of ${p.name}@${p.version}, listed (BUNDLE_LOCKFILE_FIRST_PARTY: directories that are not)`);
}

// The packages of one build: { context: its context (webpack) or working directory (Rollup, Vite), entries: its entry
// modules' files }. Cached for the build (manifests and boundaries do not change during it).
function scope({ context = process.cwd(), entries = [] } = {}) {
  const ctx = real(context);
  const manifests = new Map(); // dir -> package.json content | null
  const manifest = (d) => { if (!manifests.has(d)) manifests.set(d, readManifest(d)); return manifests.get(d); };
  const boundary = new Set(ancestors(ctx));
  // the package of each entry module (also a build started from another directory)
  for (const e of entries) {
    if (typeof e !== 'string' || !path.isAbsolute(e) || packageRoot(e)) continue;
    const own = ancestors(path.dirname(real(e))).find(d => manifest(d));
    if (own) for (const d of ancestors(own)) boundary.add(d);
  }
  const monorepos = [...boundary].map(membersOf).filter(Boolean);
  const firstParty = config.firstParty.map(p => globTest(posix(path.isAbsolute(p) ? path.relative(process.cwd(), p) : p)));
  const states = new Map(); // dir -> first-party?
  const isFirstParty = (dir) => {
    if (states.has(dir)) return states.get(dir);
    const j = manifest(dir);
    const rel = posix(path.relative(process.cwd(), dir));
    const yes = boundary.has(dir) || monorepos.some(m => m(dir)) || firstParty.some(t => t(rel))
      || (!!j && typeof j.name === 'string' && [...boundary].some(a => real(path.join(a, 'node_modules', j.name)) === dir))
      || (!!j && pnpFirstParty(dir));
    states.set(dir, yes);
    return yes;
  };
  const owners = new Map(); // dir -> package | null, outside node_modules
  // The vendored package a file outside node_modules (real path) belongs to, or null (first-party): the package.json
  // files up to a first-party directory or a private package (a first-party package), that one included
  function ownerOf(file) {
    const dir = path.dirname(file);
    if (owners.has(dir)) return owners.get(dir);
    const chain = [];
    for (const d of ancestors(dir)) {
      const j = manifest(d), stop = isFirstParty(d) || (!!j && j.private === true);
      if (j) chain.push({ dir: d, j: stop ? { name: j.name } : j });
      if (stop) break;
    }
    const found = innermost(chain);
    if (found) note(found);
    owners.set(dir, found);
    return found;
  }
  return { ownerOf, manifest };
}

// The vendored copy nested in package `pkg` (at root) that file (real path, inside root) belongs to, or null: a
// private package.json inside it is a helper of the package (preact/hooks), not a boundary.
function nestedIn(pkg, root, file, manifest) {
  const chain = [];
  for (const d of ancestors(path.dirname(file))) {
    if (d === root || !d.startsWith(root + path.sep)) break;
    const j = manifest(d);
    if (j) chain.push({ dir: d, j });
  }
  chain.push({ dir: root, j: { name: pkg.name } });
  const found = innermost(chain);
  if (found) config.debug('a vendored copy inside', pkg.name, ':', found.path);
  return found;
}

// The package around a package root without a usable package.json: the one below the node_modules before its last.
function containerOf(root) {
  const parts = root.split(path.sep);
  const i = parts.lastIndexOf('node_modules');
  return i > 0 ? packageRoot(path.join(parts.slice(0, i).join(path.sep), 'x')) : null;
}

module.exports = { scope, nestedIn, containerOf, isVendorable, globTest, pnpmPackages, parseJsonc };
