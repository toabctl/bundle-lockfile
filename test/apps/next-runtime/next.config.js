// The runtime packages of a Next.js server (test/matrix.cjs, next-runtime): packages the server loads from
// node_modules at runtime, which Next traces into .nft.json files and no bundle contains.
// - bl-canary-rt: required by a Pages Router page at request time (Pages Router dependencies are not bundled)
// - bl-canary-legacy: no exports and no main, a deep require of a .cjs file, external by serverExternalPackages: Next
//   copies no package.json of it into .next/standalone
// - bl-canary-ext: external by serverExternalPackages, imported by an App Router route
// - bl-canary-bundled: imported by the same App Router route, bundled into the server output: no runtime package
// Oracle builds (test/oracles/next.cjs) build into .next-oracle with a webpack hook, as test/apps/next - not with
// Turbopack (Next sets TURBOPACK before it loads the config), which refuses a webpack config.
const oraclePlugin = process.env.BLTEST_ORACLE_PLUGIN;
const distDir = oraclePlugin ? '.next-oracle' : '.next';

module.exports = {
  distDir,
  ...(process.env.NEXT_STANDALONE && { output: 'standalone' }),
  serverExternalPackages: ['bl-canary-legacy', 'bl-canary-ext'],
  ...(oraclePlugin && !process.env.TURBOPACK && {
    webpack(config) {
      const Plugin = require(oraclePlugin);
      config.plugins.push(new Plugin(process.env.BLTEST_ORACLE_OUT, distDir));
      return config;
    },
  }),
};
