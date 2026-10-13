'use strict';
// Comparison tooling: a Rollup / Rolldown / Vite plugin that writes, per output, what the build saw - for
// report.cjs to explain why the other tools list other packages. Shares no code with bundle-lockfile (the packages
// come from test/oracles/owner.cjs, the package.json files from manifests.cjs):
//   processed   every module the build parsed (this.getModuleIds()), also those tree-shaking dropped
//   chunk       the modules of the output's chunks
//   zeroOnly    packages whose modules in the chunks all render no bytes (re-exports; CSS imported from JavaScript)
//   assets      package files emitted as assets (originalFileNames: fonts, images)
//   style       style sheets @imported from packages: Rollup's watch files; Rolldown has none in the plugin
//               context, so also the @import / @use / @forward of the processed style sheets, followed by this file
//   nested, unlicensed, firstParty   as in inject-webpack-tools.cjs
// usage (in a config): require('<repo>/test/compare/diag-rollup.cjs')({ outDir }) -> plugin
const fs = require('fs');
const path = require('path');
const owner = require('../oracles/owner.cjs');
const { nearest } = require('./manifests.cjs');

const STYLE = /\.(css|scss|sass|less|styl|stylus|pcss|postcss|sss)$/i;
const plain = (id) => id.split('?')[0];
const isFile = (id) => !id.startsWith('\0') && path.isAbsolute(plain(id));

// The package files a style sheet's @import / @use / @forward reach (bare specifiers, also ~pkg and url(...)),
// following relative imports - only to find packages, so a bare specifier counts once its package is found
function styleImports(files) {
  const seen = new Set(), found = new Set();
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const candidates = (base) => {
    const dir = path.dirname(base), name = path.basename(base);
    const exts = path.extname(name) ? [''] : ['.css', '.scss', '.sass', '.less', '.styl'];
    return [...exts.map(e => path.join(dir, name + e)), ...exts.map(e => path.join(dir, `_${name}${e}`)),
      ...exts.filter(Boolean).map(e => path.join(base, `index${e}`)), ...exts.filter(Boolean).map(e => path.join(base, `_index${e}`))];
  };
  const packageDir = (from, spec) => {
    const parts = spec.replace(/^~/, '').split('/');
    const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    for (let d = path.dirname(from); ; d = path.dirname(d)) {
      const p = path.join(d, 'node_modules', name);
      if (fs.existsSync(path.join(p, 'package.json'))) return { dir: p, rest: parts.slice(name.split('/').length).join('/') };
      if (path.dirname(d) === d) return null;
    }
  };
  const visit = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = read(f);
    if (src === null) return;
    for (const m of src.matchAll(/@(?:import|use|forward)\s+(?:url\(\s*)?["']([^"']+)["']/g)) {
      const spec = m[1];
      if (/^(https?:|data:|\/\/)/.test(spec)) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const target = candidates(path.resolve(path.dirname(f), spec)).find(c => fs.existsSync(c) && fs.statSync(c).isFile());
        if (target) { if (target.split(path.sep).includes('node_modules')) found.add(target); visit(target); }
        continue;
      }
      const pkg = packageDir(f, spec);
      if (!pkg) continue;
      const target = pkg.rest ? candidates(path.join(pkg.dir, pkg.rest)).find(c => fs.existsSync(c) && fs.statSync(c).isFile()) : null;
      found.add(target || path.join(pkg.dir, 'package.json'));
      if (target) visit(target);
    }
  };
  for (const f of files) if (STYLE.test(f)) visit(f);
  return [...found];
}

let n = 0;
module.exports = ({ outDir }) => ({
  name: 'bundle-lockfile-compare',
  generateBundle(_, bundle) {
    try {
      const context = process.cwd();
      const processed = [...this.getModuleIds()].filter(isFile).map(plain);
      const chunk = [], zero = [], nonzero = [], assets = [];
      for (const f of Object.values(bundle)) {
        if (f.type === 'chunk') {
          for (const [id, m] of Object.entries(f.modules || {})) {
            if (!isFile(id)) continue;
            chunk.push(plain(id));
            (m && m.renderedLength ? nonzero : zero).push(plain(id));
          }
        } else for (const o of f.originalFileNames || (f.originalFileName ? [f.originalFileName] : [])) assets.push(path.resolve(context, o));
      }
      const watch = typeof this.getWatchFiles === 'function' ? this.getWatchFiles().filter(f => STYLE.test(plain(f))).map(plain) : [];
      const style = [...new Set([...watch, ...styleImports([...processed, ...watch])])];
      const pkgs = (files) => owner.packagesOf(files, { context });
      const zeroOnly = pkgs(zero).filter(p => !pkgs(nonzero).includes(p));
      const { nested, unlicensed } = nearest([...processed, ...style]);
      const file = path.join(path.resolve(outDir), 'bundle-lockfile-compare', `diag-${++n}-${process.pid}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ compiler: `build ${n}`, processed: pkgs(processed), chunk: pkgs(chunk), zeroOnly,
        assets: pkgs(assets), style: pkgs(style), nested, unlicensed, firstParty: [] }, null, 2));
    } catch (e) { console.error('[diag-rollup] could not write the diagnostics:', e); }
  },
});
