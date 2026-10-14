'use strict';
// Added to Next.js's webpack config by the fixture's next.config.js, only during oracle builds.
// For every compiler (client, server, edge-server) it writes <outDir>/<name>.json with the compiler's
// output path relative to Next's distDir and the packages derived from its stats.
const fs = require('fs');
const path = require('path');
const { STATS_OPTIONS, packagesFromStats, bundlerOf, compilerBundler } = require('./stats.cjs');

class NextStatsOraclePlugin {
  constructor(outDir, distDir) { this.outDir = outDir; this.distDir = distDir; }
  apply(compiler) {
    compiler.hooks.done.tap('NextStatsOraclePlugin', (stats) => {
      const rel = path.relative(path.resolve(compiler.context, this.distDir), compiler.outputPath).split(path.sep).join('/');
      fs.mkdirSync(this.outDir, { recursive: true });
      fs.writeFileSync(path.join(this.outDir, `${compiler.name || 'unnamed'}.json`),
        JSON.stringify({ output: rel, packages: (() => { const json = stats.toJson(STATS_OPTIONS); return [...packagesFromStats(json, compiler.context), ...bundlerOf(json, compilerBundler(compiler))]; })() }));
    });
  }
}

module.exports = NextStatsOraclePlugin;
