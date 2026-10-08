import { chunk } from 'lodash-es';  // ../../node_modules/lodash-es
import debug from 'debug';          // debug@2.6.9 with its nested ms@2.0.0
console.log(chunk([1, 2, 3, 4], 2), debug('x'));
