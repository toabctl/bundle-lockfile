'use strict';
// Entry point. Activate in a build with:
//   NODE_OPTIONS="--require /path/to/bundle-lockfile/src/register.cjs"
// Every supported bundler that runs in that process (or its child processes, which inherit NODE_OPTIONS)
// then writes <output dir>/bundle-lockfile/package-lock.json listing the npm packages in its output.
const fs = require('fs');
const config = require('./core/config.cjs');

const ADAPTERS = ['./adapters/webpack.cjs', './adapters/rollup.cjs'];
// yarn's own entry point: yarn 1 (bin/yarn.js), yarn 2+ releases (.yarn/releases/yarn-4.x.cjs), corepack's copies
const YARN = /[\\/]yarn(pkg)?(\.c?js)?$|[\\/]yarn-[^\\/]*\.c?js$|[\\/]yarn[\\/]bin[\\/]yarn(\.c?js)?$/;

// the scripts the node shim passed through to start this process (see bin/node): processes this one starts look anew
delete process.env.BUNDLE_LOCKFILE_NODE_SEEN;

if (!config.isDisabled('all')) {
  // With the node shim (bin/node), yarn still runs scripts with a temporary `node` first in PATH that runs yarn's
  // own process.execPath, bypassing the shim. In yarn's process, and only there (others derive paths from it, e.g.
  // node-gyp's headers), process.execPath is the shim, which runs the real node.
  const shim = process.env.BUNDLE_LOCKFILE_NODE_SHIM;
  if (shim && YARN.test(process.argv[1] || '')) {
    try { if (fs.statSync(shim).isFile()) { process.execPath = shim; config.debug('yarn: process.execPath is the node shim', shim); } } catch { /* no shim */ }
  }

  const hooks = require('./hooks.cjs');
  let enabled = 0;
  for (const file of ADAPTERS) {
    const adapter = require(file);
    // an adapter for several bundlers (rollup: rollup, rolldown, vite) is skipped only if all of them are disabled
    if ((adapter.names || [adapter.name]).every(n => config.isDisabled(n))) { config.debug('adapter disabled:', adapter.name); continue; }
    hooks.register(adapter);
    enabled++;
  }
  if (enabled) {
    hooks.install(); // nothing to do: leave Module._load alone
    require('./core/copies.cjs').install(); // fs copies out of packages, see there
  }
}
