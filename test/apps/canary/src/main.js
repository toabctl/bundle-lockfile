// The JavaScript of the canary app (the Rollup build's entry: Rollup bundles no CSS without a plugin)
import { used } from 'bl-canary-used';
import { dup } from 'bl-canary-dup'; // 2.0.0, while bl-canary-used bundles its own 1.0.0
import { unused } from 'bl-canary-unused'; // imported but unused (sideEffects: false): not shipped, not listed
console.log(used(), dup());
