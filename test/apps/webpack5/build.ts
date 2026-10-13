// The build through webpack's API from a TypeScript build script run by tsx (`tsx build.ts`, `node --import tsx
// build.ts`): tsx compiles every .js file itself, without Node.js' handler for .js files (see src/hooks.cjs)
const webpack = require('webpack');
const config = require('./webpack.config.js');

webpack(config, (err: Error | null, stats: { hasErrors(): boolean; toString(): string }) => {
  if (err || stats.hasErrors()) { console.error(err || stats.toString()); process.exit(1); }
});
