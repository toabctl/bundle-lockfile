'use strict';
// Oracle for Angular fixtures: builds again WITHOUT bundle-lockfile, with source maps (the fixture's "oracle"
// configuration: no packages' own source maps, vendor: false), into dist-oracle, and derives the packages from the
// maps' sources (Angular writes them relative to the workspace root; else relative to the map's directory). Shares no code with the adapter, which reads Angular's stats metafile. Source maps leave out what has no
// mappings (an asset Angular copies): a case names those.
// usage (cwd = fixture): node oracles/angular.cjs [--browser-as-root] [--configuration <name>]
// prints {"browser": [name@version, ...]} (the browser output, relative to the output path dist/; and "server" when
// the build wrote one: SSR), or with --browser-as-root {"": [...]} (a case whose output directory is dist/browser).
// --configuration: one more of angular.json's configurations (outputMode static: no server written)
// --locales <a,b>: a localized build (i18n): each side's output is a copy per locale, "<side>/<locale>" each, and the
// files written once in the side's own directory (the server's entry with server-side rendering) "<side>"
const fs = require('fs');
const path = require('path');
const owner = require('./owner.cjs');
const { spawnSync } = require('child_process');

const out = path.resolve('dist-oracle');
fs.rmSync(out, { recursive: true, force: true });
const ng = require('module').createRequire(path.resolve('package.json')).resolve('@angular/cli/bin/ng.js');
// without the chunk optimizer: the maps of the chunks it re-bundles (with Rolldown) no longer name the source files.
// Its view is esbuild's before the optimizer, which does not add packages, and may leave some out (a case says so).
const extra = process.argv.includes('--configuration') ? `,${process.argv[process.argv.indexOf('--configuration') + 1]}` : '';
const r = spawnSync(process.execPath, [ng, 'build', '--configuration', `production${extra},oracle`, '--output-path', out],
  { encoding: 'utf8', env: { ...process.env, NG_CLI_ANALYTICS: 'false', NG_BUILD_OPTIMIZE_CHUNKS: '0' } });
if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }

let files = new Set();
const walk = (d, deep = true) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (deep) walk(p); }
    else if (e.name.endsWith('.map')) {
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const s of m.sources || []) {
        const rel = s.split('?')[0], own = path.resolve(rel), local = path.resolve(path.dirname(p), m.sourceRoot || '', rel);
        if (fs.existsSync(own)) files.add(own); else if (fs.existsSync(local)) files.add(local);
      }
    }
  }
};
// and the esbuild Angular's builder ran, whose runtime helpers are in the JavaScript (test/lib/bundlers.cjs): in each
// output that has JavaScript
const bl = require('../lib/bundlers.cjs');
const builder = ['@angular/build', '@angular-devkit/build-angular'].map(n => { try { return path.dirname(require('module').createRequire(path.resolve('package.json')).resolve(`${n}/package.json`)); } catch { return null; } }).find(Boolean);
const result = {};
const locales = process.argv.includes('--locales') ? process.argv[process.argv.indexOf('--locales') + 1].split(',') : [''];
for (const side of ['browser', 'server']) {
  // with i18n, the files Angular writes once, in the side's own directory (the server's entry with server-side
  // rendering): their own lockfile, "<side>"
  if (locales[0] && fs.existsSync(path.join(out, side))) {
    files = new Set();
    walk(path.join(out, side), false);
    const top = fs.readdirSync(path.join(out, side)).filter(f => /\.[cm]?js$/.test(f));
    if (top.length) {
      const esbuild = builder ? [bl.resolved('esbuild', builder)].filter(Boolean) : [];
      result[side] = [...new Set([...owner.packagesOf(files), ...esbuild])].sort();
    }
  }
  for (const locale of locales) {
    const dir = path.join(out, side, locale);
    if (!fs.existsSync(dir)) continue;
    files = new Set();
    walk(dir);
    const esbuild = bl.hasJs(dir) && builder ? [bl.resolved('esbuild', builder)].filter(Boolean) : [];
    const key = side === 'browser' && process.argv.includes('--browser-as-root') ? '' : side;
    result[locale ? path.posix.join(key, locale) : key] = [...new Set([...owner.packagesOf(files), ...esbuild])].sort();
  }
}
console.log(JSON.stringify(result));
