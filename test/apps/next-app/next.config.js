// App Router app (fixtures next15-app, next16-app). Plain config for normal builds; NEXT_RSPACK_APP=1 wraps it with
// next-rspack, which builds with rspack instead of webpack (fixture next16-app-rspack). Only oracle builds
// (test/oracles/next.cjs) add a webpack hook - a webpack() key is not added otherwise, because Next 16 refuses a
// webpack config when building with Turbopack.
const oraclePlugin = process.env.BUNDLE_LOCKFILE_ORACLE_PLUGIN;
const distDir = oraclePlugin ? '.next-oracle' : '.next';

const config = {
  distDir,
  ...(oraclePlugin && {
    webpack(config) {
      const Plugin = require(oraclePlugin);
      config.plugins.push(new Plugin(process.env.BUNDLE_LOCKFILE_ORACLE_OUT, distDir));
      return config;
    },
  }),
};
module.exports = process.env.NEXT_RSPACK_APP ? require('next-rspack')(config) : config;
