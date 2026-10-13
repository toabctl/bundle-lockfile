// VITE_PLUGIN=<path of src/adapters/rollup.cjs>: bundle-lockfile's plugin in the config, as without NODE_OPTIONS
import { createRequire } from 'node:module';
import include from './include-plugin.mjs';

export default {
  plugins: [include(), ...(process.env.VITE_PLUGIN ? [createRequire(import.meta.url)(process.env.VITE_PLUGIN).bundleLockfile('vite')] : [])],
};
