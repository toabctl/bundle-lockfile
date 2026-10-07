import { chunk } from 'lodash-es';  // bundled into main
const debug = require('debug');     // delegated to the vendor DLL
console.log(chunk([1, 2, 3, 4], 2), debug('x'));
