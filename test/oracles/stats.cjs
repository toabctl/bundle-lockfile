'use strict';
// Shared by the webpack-based oracles: derives name@version from a webpack stats JSON. Independent of the
// adapter, which reads the chunk graph and asset objects directly. What counts as emitted:
// - modules that sit in a chunk (including modules nested in concatenated modules). A module named by its
//   issuer's resource (CSS extracted from it) counts as the file the issuer is named by (its match resource)
// - modules in chunks of child compilations (stats "children") whose files are among the parent's assets, or
//   are among the child's own assets while its entry module (depth 0) is a shipped module of its parent
//   (inlined into it, e.g. worker-loader's inline: 'no-fallback')
// - assets whose info.sourceFilename (relative to the context) is a file in a package (copy-webpack-plugin)
// - copied: more files in the output, found by the caller (copy-webpack-plugin 5, whose assets name no file; rspack's
//   copies, see rspackCopies)
const fs = require('fs');
const path = require('path');
const owner = require('./owner.cjs');

const STATS_OPTIONS = { modules: true, nestedModules: true, chunks: true, chunkModules: false, assets: true, children: true, depth: true, source: false };

// The source files of everything emitted, see above.
function filesFromStats(json, context, copied = []) {
  const files = new Set(copied);
  // file of a module: nameForCondition = resource path; identifiers can carry prefixes like "javascript/esm|/abs/path"
  const resourceOf = (m) => ((m.identifier || '').split('!').pop().split('|').find(s => path.isAbsolute(s)) || '').split('?')[0];
  // (the stats keep the resolver's escape of a "#" in a path: "\0#" in webpack, "\u200b#" in rspack)
  const plain = (f) => f.replace(/\0#/g, '#').replace(/\u200b#/g, '#');
  const fileOf = (m, byId) => {
    const own = (m.nameForCondition || resourceOf(m)).split('?')[0];
    const issuer = m.issuer && byId.get(m.issuer);
    return plain(issuer && issuer.nameForCondition && resourceOf(issuer) === own ? issuer.nameForCondition.split('?')[0] : own);
  };
  // files of these modules of one compilation's stats
  const filesOf = (stats, modules) => {
    const byId = new Map((stats.modules || []).map(m => [m.identifier, m]));
    const out = new Set();
    const add = (m) => {
      const id = fileOf(m, byId);
      if (path.isAbsolute(id)) out.add(id);
      (m.modules || []).forEach(add);
    };
    modules.forEach(add);
    return out;
  };
  const inChunks = (stats, ids) => (stats.modules || []).filter(m => (m.chunks || []).some(id => ids(id)));
  const top = filesOf(json, inChunks(json, () => true));
  top.forEach(f => files.add(f));

  const assetNames = new Set((json.assets || []).map(a => a.name));
  (function children(stats, parentShipped) {
    for (const child of stats.children || []) {
      const own = new Set((child.assets || []).map(a => a.name));
      const shipped = new Set((child.chunks || []).filter((c) => {
        const out = c.files || [];
        if (out.some(f => assetNames.has(f))) return true;
        if (!out.some(f => own.has(f))) return false;
        const entries = (child.modules || []).filter(m => m.depth === 0 && (m.chunks || []).includes(c.id));
        return [...filesOf(child, entries)].some(f => parentShipped.has(f));
      }).map(c => c.id));
      const childFiles = filesOf(child, inChunks(child, id => shipped.has(id)));
      childFiles.forEach(f => files.add(f));
      children(child, childFiles);
    }
  })(json, top);

  for (const a of json.assets || []) {
    if (a.info && typeof a.info.sourceFilename === 'string') files.add(path.resolve(context, a.info.sourceFilename.split('?')[0]));
  }

  return files;
}

function packagesFromStats(json, context, copied = []) {
  const files = filesFromStats(json, context, copied);
  return owner.packagesOf(files, { context }); // see owner.cjs
}

// Files copied without naming their source (copy-webpack-plugin 5, 6.0 - 6.2): assets in no chunk and without
// info.sourceFilename whose bytes are those of a non-empty file in node_modules that the compilation depends on: a file
// dependency, or a file below a context dependency (a copied directory).
function copiedFiles(compilation, json, outputPath) {
  const candidates = (json.assets || []).filter(a => !(a.chunks || []).length && !(a.info && a.info.sourceFilename))
    .map(a => { try { return fs.readFileSync(path.join(outputPath, a.name.split('?')[0])); } catch { return null; } })
    .filter(bytes => bytes && bytes.length);
  if (!candidates.length) return [];
  const inPackages = (f) => f.split(path.sep).includes('node_modules');
  const below = (dir) => fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter(e => e.isFile()).map(e => path.join(e.parentPath || e.path, e.name));
  const deps = [...compilation.fileDependencies].filter(inPackages)
    .concat([...(compilation.contextDependencies || [])].filter(inPackages).flatMap(d => { try { return below(d); } catch { return []; } }));
  const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return -1; } };
  return candidates.map(bytes => deps.find(f => sizeOf(f) === bytes.length && fs.readFileSync(f).equals(bytes))).filter(Boolean);
}

// rspack: the package files copied into the output (assets with info.copied: CopyRspackPlugin, Rsbuild's output.copy),
// for packagesFromStats' copied - those in packages the compilation depends on whose bytes are the copy's (built with
// optimization.minimize off). A copy's sourceFilename is relative to its copy pattern, not to the context: removed from
// the stats JSON
function rspackCopies(compilation, json, outputPath) {
  const inPackages = (f) => path.isAbsolute(f) && f.split(path.sep).includes('node_modules');
  const deps = [...new Set(compilation.fileDependencies)].filter(inPackages);
  const sizeOf = (f) => { try { const s = fs.statSync(f); return s.isFile() ? s.size : -1; } catch { return -1; } };
  return (json.assets || []).filter(a => a.info && a.info.copied).flatMap((a) => {
    delete a.info.sourceFilename;
    const bytes = fs.readFileSync(path.join(outputPath, a.name));
    return bytes.length ? deps.filter(f => sizeOf(f) === bytes.length && fs.readFileSync(f).equals(bytes)) : [];
  });
}

// rspack's stats (also a MultiCompiler's) of a build into oracleDist: {"<compiler output dir relative to oracleDist>":
// [name@version, ...]}; compilers sharing an output dir share its lockfile, so their packages are merged. sources: a Set
// that gets the absolute path of every emitted source file (for oracles/nested.cjs)
function rspackResult(stats, oracleDist, sources = new Set()) {
  const result = {};
  for (const s of stats.stats || [stats]) {
    const outputPath = s.compilation.getPath(s.compilation.outputOptions.path, {});
    const rel = path.relative(oracleDist, outputPath).split(path.sep).join('/');
    const json = s.toJson(STATS_OPTIONS);
    const copied = rspackCopies(s.compilation, json, outputPath);
    // and rspack, whose runtime is in the JavaScript chunks
    const pkgs = [...packagesFromStats(json, s.compilation.compiler.context, copied), ...bundlerOf(json, compilerBundler(s.compilation.compiler))];
    result[rel] = [...new Set([...(result[rel] || []), ...pkgs])].sort();
    for (const f of filesFromStats(json, s.compilation.compiler.context, copied)) sources.add(f);
  }
  return result;
}

// The bundler whose code is in the output (test/lib/bundlers.cjs): `id` (name@version, of the compiler the oracle ran)
// if a chunk of the compilation is a JavaScript file
const JS_FILE = (f) => typeof f === 'string' && /\.[cm]?js$/.test(f.split('?')[0]);
const bundlerOf = (json, id) => ((json.chunks || []).some(c => (c.files || []).some(JS_FILE))
  || (json.assets || []).some(a => JS_FILE(a.name) && (a.chunks || []).length) ? [id] : []);
// name@version of a compiler's bundler: rspack's @rspack/core, or webpack (also Next.js' copy) at the version it says
const compilerBundler = (compiler, fallback) => (compiler.webpack && compiler.webpack.rspackVersion ? `@rspack/core@${compiler.webpack.rspackVersion}`
  : compiler.webpack && compiler.webpack.version ? `webpack@${compiler.webpack.version}` : fallback);

// The rspack config c with what the oracles change (see oracles/rspack.cjs): minimize off, and no exports inlined -
// optimization.inlineExports from rspack 1.7; in 1.4 - 1.6 experiments.inlineConst and inlineEnum, and the parser
// option, which fails without the experiment (Rsbuild 1.5 and 1.6 set both in production)
function oracleRspackConfig(c, rspackVersion) {
  const [major, minor] = rspackVersion.split('.').map(Number);
  c.optimization = { ...c.optimization, minimize: false, ...((major > 1 || minor >= 7) && { inlineExports: false }) };
  if (major === 1 && minor >= 4 && minor <= 6) {
    c.experiments = { ...c.experiments, inlineConst: false, inlineEnum: false };
    const parser = (c.module && c.module.parser) || {};
    c.module = { ...c.module, parser: { ...parser, javascript: { ...parser.javascript, inlineConst: false } } };
  }
  return c;
}

module.exports = { bundlerOf, compilerBundler, STATS_OPTIONS, filesFromStats, packagesFromStats, copiedFiles, rspackCopies, rspackResult, oracleRspackConfig };
