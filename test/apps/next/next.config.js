// Plain config for normal builds. Only oracle builds (test/oracles/next.cjs) add a webpack hook - a
// webpack() key is not added otherwise, because Next 16 refuses a webpack config when building with Turbopack.
const oraclePlugin = process.env.BUNDLE_LOCKFILE_ORACLE_PLUGIN;
const distDir = oraclePlugin ? '.next-oracle' : '.next';

module.exports = {
  distDir,
  ...(oraclePlugin && {
    webpack(config) {
      const Plugin = require(oraclePlugin);
      config.plugins.push(new Plugin(process.env.BUNDLE_LOCKFILE_ORACLE_OUT, distDir));
      return config;
    },
  }),
};
