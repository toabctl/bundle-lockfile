// Plain config for normal builds; NEXT_RSPACK_APP=1 wraps it with next-rspack, which builds with rspack instead of
// webpack (fixtures next15-rspack, next16-rspack). Only oracle builds (test/oracles/next.cjs) add a webpack hook - a
// webpack() key is not added otherwise, because Next 16 refuses a webpack config when building with Turbopack.
const oraclePlugin = process.env.BUNDLE_LOCKFILE_ORACLE_PLUGIN;
// With output: 'export' (NEXT_EXPORT=1) a custom distDir is where Next exports to, it builds into .next anyway
// (next/dist/export/utils.js getBuildDistDir): the oracle builds there too, after the case's lockfiles have been read
const distDir = oraclePlugin && !process.env.NEXT_EXPORT ? '.next-oracle' : '.next';

const config = {
  distDir,
  // NEXT_EXPORT=1: a static export into out/; NEXT_STANDALONE=1: a standalone server in .next/standalone
  ...(process.env.NEXT_EXPORT && { output: 'export' }),
  ...(process.env.NEXT_STANDALONE && { output: 'standalone' }),
  ...(oraclePlugin && {
    webpack(config) {
      const Plugin = require(oraclePlugin);
      config.plugins.push(new Plugin(process.env.BUNDLE_LOCKFILE_ORACLE_OUT, distDir));
      return config;
    },
  }),
};
module.exports = process.env.NEXT_RSPACK_APP ? require('next-rspack')(config) : config;
