// The JavaScript of the canary app (the Rollup build's entry: Rollup bundles no CSS without a plugin)
import { used } from 'bl-canary-used';
import { dup } from 'bl-canary-dup'; // 2.0.0, while bl-canary-used bundles its own 1.0.0
import { unused } from 'bl-canary-unused'; // imported but unused (sideEffects: false): not shipped, not listed
import shader from './shader.glsl'; // bl-canary-glsl's noise.glsl inlined into it (include-loader.cjs, include-plugin.mjs)
// a package's image, a module (webpack, rspack) or inlined as a data: URL (Vite); Rollup leaves the URL as it is
const logo = new URL('../node_modules/bl-canary-url/logo.svg', import.meta.url);
console.log(used(), dup(), shader, logo.href);
