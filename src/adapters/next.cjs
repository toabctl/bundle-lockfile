'use strict';
// Next.js' server runtime packages: what a Next.js server loads from node_modules at runtime instead of from a bundle
// (Pages Router dependencies, serverExternalPackages, Next's own server) - in no bundle's lockfile. Next traces those
// files into .nft.json files (core/traces.cjs), with webpack and with Turbopack. This adapter wraps next build's build
// function (next/dist/build/index.js, the default export) and, once a build has run, writes the packages of the traced
// files to <distDir>/runtime/<BUNDLE_LOCKFILE_FILE> - and, with output: 'standalone', to
// <distDir>/standalone/<BUNDLE_LOCKFILE_FILE>, next to the node_modules Next copies the traced files into.
// The build's distDir comes from Next's build context (next/dist/build/build-context.js, NextBuildContext: distDir from
// Next.js 15, dir and config before); Next.js 12 has none: there, from the config its build loads
// (next/dist/server/config.js, whose default export is a plain property).
const fs = require('fs');
const path = require('path');
const config = require('../core/config.cjs');
const outputs = require('../core/outputs.cjs');
const packages = require('../core/packages.cjs');
const problems = require('../core/problems.cjs');
const traces = require('../core/traces.cjs');
const via = require('../core/via.cjs');
const { readPackage } = require('../core/manifest.cjs');

const BUILD = /[\\/]next[\\/]dist[\\/]build[\\/]index\.js$/;
const CONFIG = /[\\/]next[\\/]dist[\\/]server[\\/]config\.js$/;
const PHASE_PRODUCTION_BUILD = 'phase-production-build';
const loaded = new Map(); // project directory -> the config its production build loaded (Next.js 12)
const WRAPPED = Symbol.for('bundle-lockfile.next.wrapped');
const WRITER = JSON.stringify(['next', 'runtime']);

const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

// { distDir, dir, root } of the build that has just run, from Next's build context, or null (Next.js 12)
function placeOf(buildFile, dir) {
  const ctxFile = path.join(path.dirname(buildFile), 'build-context.js');
  const ctx = fs.existsSync(ctxFile) ? require(ctxFile).NextBuildContext : null;
  const conf = (ctx && ctx.config) || loaded.get(path.resolve(dir || '.')) || {};
  const projectDir = (ctx && ctx.dir) || path.resolve(dir || '.');
  const distDir = (ctx && ctx.distDir) || (projectDir && conf.distDir && path.join(projectDir, conf.distDir));
  if (!distDir) throw new Error(`no distDir: neither Next.js' build context (${ctxFile}) nor the config its build loaded has one`);
  // the directory .next/standalone mirrors (outputFileTracingRoot, experimental. before Next.js 15)
  const root = conf.outputFileTracingRoot || (conf.experimental && conf.experimental.outputFileTracingRoot) || projectDir;
  return { distDir, dir: projectDir, root, standalone: conf.output === 'standalone' };
}

// write one lockfile: target, its packages, the record's context and files, the copy of Next that built (bundler);
// resolves when it has landed
function write(target, pkgs, context, files, bundler) {
  const found = via.collector();
  found.add('traced', pkgs);
  outputs.record(target, WRITER, pkgs, context, files, { disk: true, bundler, via: found });
  return outputs.land(target, WRITER, 'Next.js', { prune: false }); // (its only writer)
}

// The build has run: the packages of its traces, written where its server finds them
async function runtime(buildFile, dir) {
  const { distDir, ...place } = placeOf(buildFile, dir);
  const files = traces.traceFiles(distDir);
  if (!files.length) { config.debug('Next.js: no traces in', distDir, '(no server output): no runtime lockfile'); return; }
  const traced = new Set();
  for (const f of files) {
    try { for (const t of traces.filesOf(f)) traced.add(t); } catch (e) { problems.problem(`Next.js: ${e.message}: the server's runtime packages are unknown`); return; }
  }
  const projectDir = real(place.dir);
  const pkgs = packages.packagesForFiles([...traced], { context: projectDir });
  // the copy of Next whose build ran: the package root of its next/dist/build/index.js
  const own = readPackage(path.join(path.dirname(buildFile), '..', '..'));
  const bundler = { name: 'next', ...(own && own.name === 'next' ? { version: own.version } : {}) };
  config.debug(`Next.js: ${traced.size} traced files in ${files.length} traces, ${pkgs.length} runtime packages`);
  await write(path.join(distDir, 'runtime', config.file), pkgs, projectDir, files, bundler);
  // standalone: Next copied the traced files below .next/standalone, at their path relative to the tracing root. Its
  // lockfile is keyed relative to the tracing root (node_modules/<name> is .next/standalone/node_modules/<name>), with
  // the packages where they are installed: Next copies only traced files, often without a package's package.json
  const standalone = path.join(distDir, 'standalone');
  if (place.standalone && fs.existsSync(standalone)) {
    const root = real(place.root);
    const inStandalone = (p) => {
      const rel = path.relative(root, p);
      return rel.startsWith('..') || path.isAbsolute(rel) ? null : path.join(standalone, rel);
    };
    const server = path.join(inStandalone(projectDir) || standalone, 'server.js');
    await write(path.join(standalone, config.file), pkgs, root, fs.existsSync(server) ? [server] : [], bundler);
    copyLockfiles(distDir, inStandalone);
  }
}

// The lockfiles of the build's bundles (client, server, edge server) go along into .next/standalone, where Next copied
// their outputs' traced files: each to the same place there, if its output directory is there. Copied with fs, so the
// copy's record is rewritten for where it is (core/outputs.cjs copied, through core/copies.cjs).
function copyLockfiles(distDir, inStandalone) {
  const depth = config.file.split('/').length;
  const lockfiles = [];
  const walk = (d, top) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!(top && ['cache', 'standalone', 'runtime', 'static', 'node_modules', 'diagnostics'].includes(e.name))) walk(p, false); }
      else if (e.isFile() && p.endsWith(path.join(...config.file.split('/')))) lockfiles.push(p);
    }
  };
  walk(distDir, true);
  for (const f of lockfiles) {
    const outDir = path.join(f, ...Array(depth).fill('..'));
    const there = inStandalone(real(outDir));
    if (!there || !fs.existsSync(there)) continue;
    const dest = path.join(there, config.file);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
      config.debug('Next.js: copied', f, 'to', dest);
    } catch (e) { problems.problem(`Next.js: could not copy ${f} into the standalone output`, e); }
  }
}

function wrap(build, buildFile) {
  const owner = {}; // the builds of this copy of Next.js (core/problems.cjs within)
  return /** @this {unknown} */ function (dir, ...rest) {
    return problems.within(owner, () => nextBuild.call(this, dir, ...rest));
  };
  /** @this {unknown} */
  async function nextBuild(dir, ...rest) {
    const result = await build.call(this, dir, ...rest);
    try { await runtime(buildFile, dir); } catch (e) { problems.problem("Next.js: could not collect the server's runtime packages", e); }
    problems.failIfAny((err) => { throw err; });
    return result;
  }
}

// Next.js 12: remembers the config each production build loads (loadConfig(phase, dir, customConfig))
function patchConfig(exp) {
  const desc = Object.getOwnPropertyDescriptor(exp, 'default');
  if (!desc || !desc.writable || typeof desc.value !== 'function' || exp[WRAPPED]) return; // a getter: Next.js 13 and later
  const loadConfig = desc.value;
  exp.default = async function (phase, dir, ...rest) {
    const conf = await loadConfig.call(this, phase, dir, ...rest);
    if (phase === PHASE_PRODUCTION_BUILD && typeof dir === 'string') loaded.set(path.resolve(dir), conf);
    return conf;
  };
  Object.defineProperty(exp, WRAPPED, { value: true });
}

module.exports = {
  name: 'next',
  cjsFiles: [BUILD, CONFIG],
  cjsPackages: ['next'], // processes that build with it (see hooks.cjs installCjs)
  onCjsLoad(exp, request, resolve) {
    if (request.endsWith('config.js') && CONFIG.test(request) && exp && typeof exp === 'object') { patchConfig(exp); return undefined; }
    if (!request.endsWith('index.js') || !BUILD.test(request) || !exp || typeof exp !== 'object' || exp[WRAPPED]) return undefined;
    if (typeof exp.default !== 'function') {
      problems.problem(`Next.js: ${resolve()} exports no build function bundle-lockfile knows: the server's runtime packages would be missing`);
      return undefined;
    }
    // a copy: every export as it is now (Next's are getters, which cannot be replaced), the build function wrapped
    const file = resolve();
    const copy = {};
    for (const k of Object.keys(exp)) copy[k] = exp[k];
    copy.default = wrap(exp.default, file);
    Object.defineProperty(copy, '__esModule', { value: true });
    Object.defineProperty(copy, WRAPPED, { value: true });
    config.debug('Next.js: wrapped the build function of', file);
    return { exports: copy };
  },
  // for tests
  placeOf,
  runtime,
};
