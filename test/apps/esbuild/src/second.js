import ms from 'ms'; // the second build of the "two" mode (build.mjs): its own entry, into the same directory
import isNumber from 'is-number'; // only in this build
console.log(ms('2h'), isNumber(1));
