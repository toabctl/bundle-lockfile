// The fixture's webpack.config.js as a TypeScript config that Node.js' type stripping cannot load (an enum): webpack-cli
// then loads it through interpret/rechoir, with the register hook the fixture has installed (ts-node/register,
// @swc/register, esbuild-register), which compiles .ts files when they are require()d
enum Mode { Production = 'production' }
const config = require('./webpack.config.js');
module.exports = { ...config, mode: Mode.Production };
