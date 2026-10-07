'use strict';
// Entry point. Activate in a build with:
//   NODE_OPTIONS="--require /path/to/bundle-lockfile/src/register.cjs"
// Every supported bundler that runs in that process (or its child processes, which inherit NODE_OPTIONS)
// then writes <output dir>/bundle-lockfile/package-lock.json listing the npm packages in its output.
const config = require('./core/config.cjs');

const ADAPTERS = ['./adapters/webpack.cjs'];

if (!config.isDisabled('all')) {
  const hooks = require('./hooks.cjs');
  for (const file of ADAPTERS) {
    const adapter = require(file);
    if (config.isDisabled(adapter.name)) { config.debug('adapter disabled:', adapter.name); continue; }
    hooks.register(adapter);
  }
  hooks.install();
}
