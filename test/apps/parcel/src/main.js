import { chunk } from 'lodash-es'; // tree-shaken: only chunk and what it needs
import { v4 } from 'uuid';         // imported but unused (sideEffects: false): not shipped, not listed
import debug from 'debug';         // CommonJS, with its own ms@2.0.0
import ms from 'ms';               // ms@2.1.3
console.log(chunk([1, 2, 3, 4], 2), debug('x'), ms('1h'));
import('nanoid').then(m => console.log(m.nanoid())); // a lazily loaded bundle
import isNumber from 'is-number'; console.log(isNumber(1)); // left out by the watch mode's 2nd build
