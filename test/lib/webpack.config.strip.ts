// The fixture's webpack.config.js as a TypeScript config that Node.js loads itself (type stripping: 22.18 and later)
const config: { mode?: string } = require('./webpack.config.js');
module.exports = config;
