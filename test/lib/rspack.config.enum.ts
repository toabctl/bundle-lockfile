// The fixture's rspack.config.js as a TypeScript config that Node.js' type stripping cannot load (an enum): rspack's
// command line then loads it with the register hook the fixture has installed (ts-node/register)
enum Mode { Production = 'production' }
const config = require('./rspack.config.js');
module.exports = Array.isArray(config) ? config : { ...config, mode: Mode.Production };
