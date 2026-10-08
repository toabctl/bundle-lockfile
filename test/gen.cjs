'use strict';
// Creates the fixtures from matrix.cjs (needs network). Afterwards run.cjs works offline.
// usage: node test/gen.cjs <fixtures-dir> [fixture-name-regex] [--shard=<i>/<n>]   (see lib/shard.cjs)
// Needs node, npm, yarn (1.x), bun on PATH; yarn berry and pnpm releases are vendored into <dir>/.tools.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { fixtures } = require('./matrix.cjs');
const { parseArgs, fixturesOf } = require('./lib/shard.cjs');

const { shard, rest: [out, filter] } = parseArgs(process.argv.slice(2));
if (!out) { console.error('usage: node test/gen.cjs <fixtures-dir> [fixture-name-regex] [--shard=<i>/<n>]'); process.exit(2); }
const inShard = fixturesOf(shard);
const OUT = path.resolve(out);
const TOOLS = path.join(OUT, '.tools');
// Fixtures are created from scratch, so lockfiles must be writable even when CI=true
// (yarn >= 2 and pnpm switch to immutable / frozen lockfiles in CI).
const ENV = { ...process.env, YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' };
const sh = (cmd, cwd) => {
  try {
    execSync(cmd, { cwd, env: ENV, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
  } catch (e) {
    process.stderr.write(`${cmd} failed in ${cwd}:\n${String(e.stdout || '').split('\n').slice(-30).join('\n')}${e.stderr || ''}\n`);
    throw e;
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
  'yarn-berry': (dir, { version, linker, globalCache = false }) => {
    const rel = `.yarn/releases/yarn-${version}.cjs`;
    fs.mkdirSync(path.join(dir, '.yarn/releases'), { recursive: true });
    fs.copyFileSync(path.join(tool(`@yarnpkg/cli-dist@${version}`, `yarn-${version}`), 'bin/yarn.js'), path.join(dir, rel));
    // a cache that stays, so installs work offline later: project-local, or - like yarn 4's default - the
    // global cache, kept in <dir>/.tools; yarn 1 on PATH delegates to yarnPath
    const cache = globalCache ? `enableGlobalCache: true\nglobalFolder: ${path.join(TOOLS, 'yarn-global')}` : 'enableGlobalCache: false';
    fs.writeFileSync(path.join(dir, '.yarnrc.yml'), `yarnPath: ${rel}\nnodeLinker: ${linker}\n${cache}\nenableTelemetry: false\n`);
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    sh(`node ${rel} install`, dir);
  },
  // globalVirtualStore: packages in pnpm's global virtual store (enable-global-virtual-store), outside the project; the
  // store is kept in <dir>/.tools, so installs work offline later
  pnpm: (dir, { version, globalVirtualStore = false }) => {
    if (globalVirtualStore) fs.writeFileSync(path.join(dir, '.npmrc'), `enable-global-virtual-store=true\nstore-dir=${path.join(TOOLS, 'pnpm-store')}\n`);
    sh(`node ${pnpmBin(version)} install --no-frozen-lockfile --config.confirmModulesPurge=false`, dir);
  },
};

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
    dependencies: fx.deps,
    ...(fx.devDeps && { devDependencies: fx.devDeps }),
    ...fx.packageJson, // extra fields, e.g. workspaces
  }, null, 2) + '\n');
  installers[fx.installer.type](dir, fx.installer);
  if (fx.installer.type === 'pnpm') fs.writeFileSync(path.join(dir, '.pnpm-bin'), path.relative(dir, pnpmBin(fx.installer.version)) + '\n');
  if (fx.installer.type === 'npm' && fx.installer.version) fs.writeFileSync(path.join(dir, '.npm-bin'), path.relative(dir, npmBin(fx.installer.version)) + '\n');
}
