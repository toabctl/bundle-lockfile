'use strict';
// Creates the fixtures from matrix.cjs (needs network). Afterwards run.cjs works offline.
// usage: node test/gen.cjs <fixtures-dir> [fixture-name-regex] [--shard=<i>/<n>] [--fixtures=<fixture-name-regex>]
//   (see lib/shard.cjs; --fixtures: the same as the regex, as run.cjs takes it)
// Needs node, npm, yarn (1.x), bun on PATH; yarn berry and pnpm releases are vendored into <dir>/.tools.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { fixtures } = require('./matrix.cjs');
const { parseArgs, fixturesOf } = require('./lib/shard.cjs');

const { shard, fixtures: only, rest: [out, filter] } = parseArgs(process.argv.slice(2));
// BLTEST_LATEST=1: the newest releases instead of the pinned ones (the weekly run, .github/workflows/latest.yaml): every
// exact version of a fixture's dependencies a caret range, no pins
const LATEST = process.env.BLTEST_LATEST === '1';
if (!out) { console.error('usage: node test/gen.cjs <fixtures-dir> [fixture-name-regex] [--shard=<i>/<n>]'); process.exit(2); }
const inShard = fixturesOf(shard, only);
const OUT = path.resolve(out);
const TOOLS = path.join(OUT, '.tools');
// Fixtures are created from scratch, so lockfiles must be writable even when CI=true
// (yarn >= 2 and pnpm switch to immutable / frozen lockfiles in CI).
const ENV = { ...process.env, YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' };
// A download that the network broke (CI runners see ECONNRESET from the registry now and then) is tried again, up to
// 3 times; any other failure fails at once. Installs are repeatable: a second run completes the first.
const NETWORK = /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|EPIPE|socket hang up)\b/;
const sh = (cmd, cwd) => {
  for (let attempt = 1; ; attempt++) {
    try {
      execSync(cmd, { cwd, env: ENV, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
      return;
    } catch (e) {
      const output = `${String(e.stdout || '')}${e.stderr || ''}`;
      if (attempt < 3 && NETWORK.test(output)) {
        process.stderr.write(`${cmd} in ${cwd}: network error (${output.match(NETWORK)[1]}), attempt ${attempt + 1} of 3\n`);
        execSync(`sleep ${5 * attempt}`);
        continue;
      }
      process.stderr.write(`${cmd} failed in ${cwd}:\n${String(e.stdout || '').split('\n').slice(-30).join('\n')}${e.stderr || ''}\n`);
      throw e;
    }
  }
};

// vendored tool release: npm tarball unpacked into .tools/<dir>
// (unpacked next to it and renamed when complete: a failed download must not leave a directory that a later
// run takes for the tool)
function tool(spec, dir) {
  const d = path.join(TOOLS, dir);
  if (!fs.existsSync(d)) {
    const tmp = `${d}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    sh(`npm pack -q ${spec} && tar xzf *.tgz --strip-components=1 && rm -f *.tgz`, tmp);
    fs.renameSync(tmp, d);
  }
  return d;
}

const pnpmBin = (version) => {
  const d = tool(`pnpm@${version}`, `pnpm-${version}`);
  return ['bin/pnpm.cjs', 'bin/pnpm.mjs'].map(b => path.join(d, b)).find(fs.existsSync); // pnpm 12 ships pnpm.mjs
};

const npmBin = (version) => path.join(tool(`npm@${version}`, `npm-${version}`), 'bin/npm-cli.js');

const installers = {
  // without a version: the npm on PATH; with one: a vendored release
  npm: (dir, { version }) => sh(`${version ? `node ${npmBin(version)}` : 'npm'} install -q --no-audit --no-fund`, dir),
  yarn1: (dir) => sh('yarn install -s --non-interactive --no-progress', dir),
  bun: (dir) => sh('bun install --silent', dir),
  // packageMap: yarn's nodeExperimentalPackageMap (4.17+: node_modules/.package-map.json, --experimental-package-map in
  // NODE_OPTIONS of what yarn runs)
  'yarn-berry': (dir, { version, linker, globalCache = false, packageMap = false }) => {
    const rel = `.yarn/releases/yarn-${version}.cjs`;
    fs.mkdirSync(path.join(dir, '.yarn/releases'), { recursive: true });
    fs.copyFileSync(path.join(tool(`@yarnpkg/cli-dist@${version}`, `yarn-${version}`), 'bin/yarn.js'), path.join(dir, rel));
    // a cache that stays, so installs work offline later: project-local, or - like yarn 4's default - the
    // global cache, kept in <dir>/.tools; yarn 1 on PATH delegates to yarnPath
    // (the pnpm linker hard-links the files of its store from the global folder's index: on the fixtures' file system)
    const cache = globalCache ? `enableGlobalCache: true\nglobalFolder: ${path.join(TOOLS, 'yarn-global')}`
      : `enableGlobalCache: false${linker === 'pnpm' ? `\nglobalFolder: ${path.join(TOOLS, 'yarn-global')}` : ''}`;
    fs.writeFileSync(path.join(dir, '.yarnrc.yml'), `yarnPath: ${rel}\nnodeLinker: ${linker}\n${cache}\nenableTelemetry: false\n${packageMap ? 'nodeExperimentalPackageMap: true\n' : ''}`);
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    sh(`node ${rel} install`, dir);
  },
  // globalVirtualStore: packages in pnpm's global virtual store (enable-global-virtual-store), outside the project; the
  // store is kept in <dir>/.tools, so installs work offline later. pnpm turns the global virtual store off in CI (its
  // `ci` setting, from CI=true): ci=false. The install must have put the packages outside the project
  pnpm: (dir, { version, globalVirtualStore = false }) => {
    if (globalVirtualStore) fs.writeFileSync(path.join(dir, '.npmrc'), `enable-global-virtual-store=true\nci=false\nstore-dir=${path.join(TOOLS, 'pnpm-store')}\n`);
    sh(`node ${pnpmBin(version)} install --no-frozen-lockfile --config.confirmModulesPurge=false`, dir);
    if (globalVirtualStore) {
      const dep = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies)[0];
      const real = fs.realpathSync(path.join(dir, 'node_modules', dep));
      if (!path.relative(dir, real).startsWith('..')) throw new Error(`${dir}: pnpm installed ${dep} at ${real}, not in its global virtual store`);
    }
  },
};

// LATEST: an exact version (1.2.3) as the newest of its major (^1.2.3; 0.x: of its minor); anything else as it is
/** @type {(deps: Record<string, string> | undefined) => Record<string, string> | undefined} */
const widen = (deps) => (!LATEST || !deps ? deps : Object.fromEntries(Object.entries(deps).map(([n, v]) => [n, /^\d+\.\d+\.\d+$/.test(v) ? `^${v}` : v])));

// pins: { name: version } - exact versions of packages a fixture does not depend on itself (those its dependencies
// bring, whose versions a case names or whose newer releases break the build), as the installer's overrides: npm and
// bun `overrides`, yarn `resolutions`, pnpm 8 / 9 `pnpm.overrides` in package.json, pnpm 10 and later `overrides` in
// pnpm-workspace.yaml (pnpm 11 no longer reads package.json's pnpm field).
// { parent: { name: version } }: only the parent's copy (npm's nested overrides; npm only).
function pinFields(fx) {
  const pins = fx.pins;
  if (LATEST || !pins) return {};
  const t = fx.installer.type;
  if (t !== 'npm' && Object.values(pins).some(v => typeof v !== 'string')) throw new Error(`pins: a parent's own pins need npm, not ${t}`);
  if (t === 'npm' || t === 'bun') return { overrides: pins };
  if (t === 'yarn1' || t === 'yarn-berry') return { resolutions: pins };
  if (t === 'pnpm') return Number(fx.installer.version.split('.')[0]) >= 10 ? {} : { pnpm: { overrides: pins } };
  throw new Error(`pins: installer ${t} not known`);
}
// pnpm 10 and later: the pins in pnpm-workspace.yaml (with the fixture's own, if its app has one)
function pinWorkspace(dir, fx) {
  if (LATEST || !fx.pins || fx.installer.type !== 'pnpm' || Number(fx.installer.version.split('.')[0]) < 10) return;
  const file = path.join(dir, 'pnpm-workspace.yaml');
  const own = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/^overrides:/m.test(own)) throw new Error(`${file}: has overrides of its own, and the fixture pins`);
  const lines = Object.entries(fx.pins).map(([n, v]) => `  ${JSON.stringify(n)}: ${JSON.stringify(v)}`); // (strings: see pinFields)
  fs.writeFileSync(file, `${own}${own && !own.endsWith('\n') ? '\n' : ''}overrides:\n${lines.join('\n')}\n`);
}
// The versions of package `name` the installer's lockfile resolves (package-lock.json, pnpm-lock.yaml, yarn.lock of
// yarn 1 and berry, bun.lock); null: no lockfile it knows
function resolved(dir, name) {
  const at = (f) => path.join(dir, f);
  const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  if (fs.existsSync(at('package-lock.json'))) {
    const lock = JSON.parse(fs.readFileSync(at('package-lock.json'), 'utf8'));
    return Object.entries(lock.packages || {}).filter(([k]) => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`)).map(([, p]) => p.version);
  }
  if (fs.existsSync(at('pnpm-lock.yaml'))) { // ('  name@1.2.3:', '  /name@1.2.3:' in pnpm 8's, with a peer suffix (...))
    return [...fs.readFileSync(at('pnpm-lock.yaml'), 'utf8').matchAll(new RegExp(`^\\s+'?/?${esc}@(\\d[^:'(\\s]*)`, 'gm'))].map(m => m[1]);
  }
  if (fs.existsSync(at('yarn.lock'))) { // entries: a line of specs (name@range, "name@npm:range"), then `version "x"` / `version: x`
    return fs.readFileSync(at('yarn.lock'), 'utf8').split(/\n(?=\S)/).filter(e => e.split('\n')[0].split(/,\s*/).some(spec => spec.replace(/^"/, '').startsWith(`${name}@`)))
      .map(e => (e.match(/^\s+version:?\s+"?([^"\s]+)"?$/m) || [])[1]).filter(Boolean);
  }
  if (fs.existsSync(at('bun.lock'))) return [...fs.readFileSync(at('bun.lock'), 'utf8').matchAll(new RegExp(`"${esc}": \\["${esc}@([^"]+)"`, 'g'))].map(m => m[1]);
  return null;
}
// After the install: each pin is what the lockfile resolves, and only that (an installer that ignored it would test
// another version than the case says); a parent's own pin: its copy (npm's package-lock.json)
function checkPins(dir, fx) {
  if (LATEST || !fx.pins) return;
  for (const [n, v] of Object.entries(fx.pins)) {
    if (typeof v !== 'string') {
      const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8')).packages || {};
      for (const [dep, want] of Object.entries(v)) {
        // the copy the parent resolves: below it, else the nearest one above it (node_modules/<parent>/node_modules/<dep>)
        const parent = Object.keys(lock).find(k => k === `node_modules/${n}` || k.endsWith(`/node_modules/${n}`));
        if (!parent) throw new Error(`${dir}: pinned ${dep}@${want} below ${n}, which is not installed`);
        let at = null;
        for (let base = parent; base !== null && !at; base = base.includes('/node_modules/') ? base.slice(0, base.lastIndexOf('/node_modules/')) : base === '' ? null : '') {
          const k = `${base ? `${base}/` : ''}node_modules/${dep}`;
          if (lock[k]) at = lock[k];
        }
        if (!at || at.version !== want) throw new Error(`${dir}: pinned ${dep}@${want} below ${n}, the install resolved ${at ? at.version : 'none'}`);
      }
      continue;
    }
    const got = resolved(dir, n);
    if (got === null) throw new Error(`${dir}: no lockfile to check the pin ${n}@${v} in`);
    if (!got.length || got.some(g => g !== v)) throw new Error(`${dir}: pinned ${n}@${v}, the install resolved ${[...new Set(got)].join(', ') || 'none'}`);
  }
}

for (const [name, fx] of Object.entries(fixtures)) {
  if (!inShard.has(name) || (filter && !new RegExp(filter).test(name))) continue;
  const dir = path.join(OUT, name);
  console.log(`== ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(__dirname, 'apps', fx.app), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: `fixture-${name}`, version: '1.0.0', private: true,
    scripts: {
      build: 'webpack --config webpack.config.js',
      // default-if-unset pattern: keep NODE_OPTIONS if set, else default it
      'webpack-prod': 'NODE_OPTIONS="${NODE_OPTIONS:=--max-old-space-size=10240}" NODE_ENV=production webpack --config webpack.config.js',
      // overwrites NODE_OPTIONS (drops the --require), as e.g. argo-cd's recipe does: needs the node shim
      'build-reset': 'NODE_OPTIONS=--max-old-space-size=3072 webpack --config webpack.config.js',
    },
    dependencies: widen(fx.deps),
    ...(fx.devDeps && { devDependencies: widen(fx.devDeps) }),
    ...pinFields(fx),
    ...fx.packageJson, // extra fields, e.g. workspaces
  }, null, 2) + '\n');
  pinWorkspace(dir, fx);
  installers[fx.installer.type](dir, fx.installer);
  checkPins(dir, fx);
  if (fx.postInstall) sh(fx.postInstall, dir);
  if (fx.installer.type === 'pnpm') fs.writeFileSync(path.join(dir, '.pnpm-bin'), path.relative(dir, pnpmBin(fx.installer.version)) + '\n');
  if (fx.installer.type === 'npm' && fx.installer.version) fs.writeFileSync(path.join(dir, '.npm-bin'), path.relative(dir, npmBin(fx.installer.version)) + '\n');
}
